import type { AgentHarness, AgentLane, JsonValue } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { RunBudgetLimit } from "@rakazo/core";
import { RUN_COST_LIMIT_USD, RUN_WALL_CLOCK_LIMIT_MS, runBudgetExceeded } from "@rakazo/core";
import type { RakazoToolContext } from "./harness-tools.js";

export interface ToolCallFacts {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, JsonValue>;
}

/** A refused call. `reason` becomes the tool result the model reads, so it states facts only. */
export interface ToolBlock {
  reason: string;
}

export interface RunLimitFact {
  runId: string;
  limit: RunBudgetLimit;
  costUsd: number;
  elapsedMs: number;
}

export interface GuardrailDeps {
  /** Send confirmation and approvals, paid-spend limits and the unattended memory guard. */
  checkTool?(call: ToolCallFacts): ToolBlock | undefined | Promise<ToolBlock | undefined>;
  /** Ask and approval cards: a successful call ends the run; the answer arrives as a new input. */
  cardTools?: ReadonlySet<string>;
  runLimits?: { costUsd: number; wallClockMs: number };
  /** Called once when a run crosses a limit and its abort is requested. */
  onRunLimit?(fact: RunLimitFact): void;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  costUsd: number;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Registers the product guardrails as Pi hooks on one lane. Event listeners never await a lane
 * command: Pi delivers events in order and a command waits for its own delivery.
 */
export function installGuardrails(
  harness: AgentHarness<RakazoToolContext>,
  lane: AgentLane,
  deps: GuardrailDeps,
): () => void {
  const limits = deps.runLimits ?? {
    costUsd: RUN_COST_LIMIT_USD,
    wallClockMs: RUN_WALL_CLOCK_LIMIT_MS,
  };
  let active: ActiveRun | undefined;

  const stop = (run: ActiveRun) => {
    const elapsedMs = Date.now() - run.startedAt;
    const limit = runBudgetExceeded({ costUsd: run.costUsd, elapsedMs }, limits);
    if (!limit || run.stopped) return;
    run.stopped = true;
    deps.onRunLimit?.({ runId: run.runId, limit, costUsd: run.costUsd, elapsedMs });
    void lane.requestAbort(run.runId, BACKGROUND_CONTEXT).catch(() => undefined);
  };

  const track = (runId: string, startedAt: number) => {
    if (active) clearTimeout(active.timer);
    const run: ActiveRun = {
      runId,
      startedAt,
      costUsd: 0,
      stopped: false,
      timer: setTimeout(() => stop(run), Math.max(0, startedAt + limits.wallClockMs - Date.now())),
    };
    active = run;
  };

  const disposers = [
    harness.hooks.on("before_tool", async (event) => {
      const block = await deps.checkTool?.({
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return block ? { block: { reason: block.reason } } : undefined;
    }),
    harness.hooks.on("after_tool", (event) =>
      !event.isError && deps.cardTools?.has(event.toolName) ? { terminate: true } : undefined,
    ),
    harness.events.on("run_start", (event) => {
      if (event.lane === lane.name) track(event.runId, event.startedAt);
    }),
    // A run recovered by a new owner has no run_start here; it is limited from its first turn.
    harness.events.on("turn_start", (event) => {
      if (event.lane === lane.name && active?.runId !== event.runId) track(event.runId, Date.now());
    }),
    harness.events.on("run_end", (event) => {
      if (active?.runId !== event.runId) return;
      clearTimeout(active.timer);
      active = undefined;
    }),
    harness.events.on("usage", (event) => {
      if (event.lane !== lane.name || !active) return;
      active.costUsd += event.row.usage.cost.total;
      stop(active);
    }),
  ];
  return () => {
    if (active) clearTimeout(active.timer);
    for (const dispose of disposers) dispose();
  };
}
