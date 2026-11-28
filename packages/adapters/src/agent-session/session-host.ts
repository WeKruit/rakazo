import type {
  AgentHarness as AgentHarnessInstance,
  AgentLane,
  AgentMessage,
  Context,
  HarnessEvent,
  HarnessEventType,
  Session,
} from "@earendil-works/pi-agent-core";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  HarnessClosed,
  HarnessFault,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { getLogger } from "@rakazo/logging";
import type { RakazoToolContext } from "./harness-tools.js";
import type { SessionConfig } from "./session-config.js";

/** The one lane each agent has in each conversation. */
export const SESSION_LANE = "main";

export const SESSION_HOST_TIMING = {
  /** Renewal of the 30 s session lease. */
  renewMs: 10_000,
  /** An idle lane with no pending input releases its lease after this long. */
  idleEvictMs: 10 * 60_000,
  /** Deploy drain: how long a live turn may take to finish before the lease is released. */
  quiesceMs: 45_000,
};

export type SessionInputKind = "message" | "followUp" | "stop" | "cardAnswer";

/** One row of the durable input outbox, as the session's owner reads it. */
export interface SessionInputRow {
  id: string;
  seq: number;
  kind: SessionInputKind;
  messageId?: string | null;
  /** `{ text }` for message, followUp and cardAnswer; unused for stop. */
  payload: unknown;
  trigger: string;
}

export interface SessionInputDelivery {
  piEntryId?: string;
  operationId?: string;
}

export interface SessionInputSource {
  /** Undelivered inputs in seq order. */
  pending(): Promise<SessionInputRow[]>;
  markDelivered(inputId: string, delivery: SessionInputDelivery): Promise<void>;
}

export interface SessionLeaseKeeper {
  /** False once another worker owns the session. */
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface SessionEventContext {
  lane: AgentLane;
  /** The input whose delivery started this event's run, when this owner started it. */
  input?: SessionInputRow;
}

export interface SessionHostDeps {
  /** Acquires the session lease; null when a live owner holds it. */
  acquireLease(): Promise<SessionLeaseKeeper | null>;
  inputs: SessionInputSource;
  /** Realtime notify for new input on this session. */
  subscribe(onNotify: () => void): () => void;
  /** Opens the Pi session over fenced storage for the lease just acquired. */
  openSession(): Promise<Session>;
  buildConfig(): Promise<SessionConfig>;
  /**
   * Projection of harness events. Pi awaits it before the next event, so it must never await a
   * lane command (that command would wait behind this delivery).
   */
  onEvent?(event: HarnessEvent, context: SessionEventContext): void | Promise<void>;
  timing?: Partial<typeof SESSION_HOST_TIMING>;
}

export type SessionHostOutcome = "released" | "not_owner" | "lease_lost";

/** A Pi user message that remembers which outbox input it came from. */
export type SessionInputMessage = UserMessage & { rakazoInputId: string; rakazoMessageId?: string };

const HARNESS_EVENT_TYPES: readonly HarnessEventType[] = [
  "run_start",
  "run_resume",
  "run_suspend",
  "operation_abort",
  "run_end",
  "fault",
  "handler_error",
  "turn_start",
  "turn_end",
  "retry_scheduled",
  "retry_start",
  "retry_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "entry_added",
  "queue_update",
  "value_update",
  "config_update",
  "compaction_start",
  "compaction_end",
  "navigation_start",
  "navigation_end",
  "lane_created",
  "usage",
];

/** Recent branch entries searched for inputs already handed to Pi before a crash. */
const DELIVERED_SCAN_ENTRIES = 50;

function inputText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const { text } = payload as { text: unknown };
    if (typeof text === "string") return text;
  }
  return "";
}

export function inputMessage(input: SessionInputRow): SessionInputMessage {
  return {
    role: "user",
    content: [{ type: "text", text: inputText(input.payload) }],
    timestamp: Date.now(),
    rakazoInputId: input.id,
    ...(input.messageId ? { rakazoMessageId: input.messageId } : {}),
  };
}

function inputIdOf(message: AgentMessage | undefined): string | undefined {
  const id = (message as { rakazoInputId?: unknown } | undefined)?.rakazoInputId;
  return typeof id === "string" ? id : undefined;
}

/** Input ids already in the lane's transcript tail or inbox. */
async function deliveredInputIds(lane: AgentLane, context: Context): Promise<Set<string>> {
  const ids = new Set<string>();
  const watch = await lane.watch(context);
  try {
    for (const item of watch.snapshot.queues) {
      const id = item.type === "message" ? inputIdOf(item.message) : undefined;
      if (id) ids.add(id);
    }
  } finally {
    watch.unsubscribe();
  }
  for (const entry of await lane.findEntries(
    { type: "message", limit: DELIVERED_SCAN_ENTRIES },
    context,
  )) {
    const id = entry.type === "message" ? inputIdOf(entry.message) : undefined;
    if (id) ids.add(id);
  }
  return ids;
}

export interface InputDelivery extends SessionInputDelivery {
  /** An operation this delivery admitted; the caller drives it. */
  started?: string;
  /** Stop aborted a live operation. */
  aborted?: boolean;
}

/**
 * Hands one input to the lane. A message starts a run when the lane is idle and is steered into
 * the live run otherwise; Stop aborts only a live operation, and the steers it pulls out of the
 * inbox are kept for the next run.
 */
export async function deliverInput(
  lane: AgentLane,
  input: SessionInputRow,
  context: Context,
  operationId: string = uuidv7(),
): Promise<InputDelivery> {
  switch (input.kind) {
    case "message":
    case "cardAnswer": {
      const message = inputMessage(input);
      const accepted = await lane.accept(
        { kind: "prompt", operationId, prompt: [message] },
        context,
      );
      if (accepted.ok) return { operationId, started: operationId };
      if (accepted.error._tag !== "LaneBusy") throw accepted.error;
      const busyOperation = accepted.error.operationId;
      const steered = await lane.steer(message, undefined, context);
      if (!steered.ok) throw steered.error;
      return { piEntryId: steered.value.entryId, operationId: busyOperation };
    }
    case "followUp": {
      const queued = await lane.followUp(inputMessage(input), undefined, context);
      if (!queued.ok) throw queued.error;
      return { piEntryId: queued.value.entryId };
    }
    case "stop": {
      const current = (await lane.inspectExecution(context)).current;
      if (!current) return {};
      const requested = await lane.requestAbort(current.id, context);
      if (!requested.ok) {
        if (requested.error._tag === "OperationMismatch") return {};
        throw requested.error;
      }
      for (const message of [...requested.value.steer, ...requested.value.followUp]) {
        const kept = await lane.nextRun(message, undefined, context);
        if (!kept.ok) throw kept.error;
      }
      return { operationId: current.id, aborted: true };
    }
  }
}

async function syncLaneConfiguration(lane: AgentLane, config: SessionConfig, context: Context) {
  const execution = await lane.inspectExecution(context);
  const configured = execution.configuredModel;
  if (configured.provider !== config.model.provider || configured.modelId !== config.model.id) {
    await lane.setModel({ provider: config.model.provider, modelId: config.model.id }, context);
  }
  const thinkingLevel = config.thinkingLevel ?? "off";
  if ((await lane.getThinkingLevel(context)) !== thinkingLevel) {
    await lane.setThinkingLevel(thinkingLevel, context);
  }
  const names = config.tools.map((tool) => tool.name);
  const active = await lane.getActiveTools(context);
  if (active.length !== names.length || active.some((name, index) => name !== names[index])) {
    await lane.setActiveTools(names, context);
  }
}

/**
 * Owns one conversation session while this worker holds its lease: restores the lane, resumes
 * open operations, turns outbox inputs into Pi accept/steer/followUp/abort, and releases on idle
 * or quiesce. Returns when ownership ends.
 */
export async function runSessionHost(
  deps: SessionHostDeps,
  signal: AbortSignal,
): Promise<SessionHostOutcome> {
  const lease = await deps.acquireLease();
  if (!lease) return "not_owner";
  const timing = { ...SESSION_HOST_TIMING, ...deps.timing };
  const context = BACKGROUND_CONTEXT;
  const logger = getLogger();

  let harness: AgentHarnessInstance<RakazoToolContext> | undefined;
  try {
    const session = await deps.openSession();
    const config = await deps.buildConfig();
    const created = await AgentHarness.create<RakazoToolContext>(
      {
        session,
        models: config.models,
        model: config.model,
        ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
        tools: config.tools,
        ...(config.toolContext === undefined ? {} : { toolContext: config.toolContext }),
        systemPrompt: config.systemPrompt,
        compaction: config.compaction,
        ...(config.retry === undefined ? {} : { retry: config.retry }),
        ...(config.streamOptions === undefined ? {} : { streamOptions: config.streamOptions }),
      },
      context,
    );
    harness = created.harness;
    const lane = await harness.lane(SESSION_LANE, context);
    await syncLaneConfiguration(lane, config, context);
    return await ownSession({
      deps,
      signal,
      lease,
      timing,
      harness,
      lane,
      config,
      resumeOpen: created.open.some((operation) => operation.lane === SESSION_LANE),
    });
  } catch (error) {
    logger.error("Session host failed to open its session", { error });
    await harness?.close(context).catch(() => undefined);
    await lease.release().catch(() => undefined);
    throw error;
  }
}

interface Ownership {
  deps: SessionHostDeps;
  signal: AbortSignal;
  lease: SessionLeaseKeeper;
  timing: typeof SESSION_HOST_TIMING;
  harness: AgentHarnessInstance<RakazoToolContext>;
  lane: AgentLane;
  config: SessionConfig;
  resumeOpen: boolean;
}

async function ownSession(own: Ownership): Promise<SessionHostOutcome> {
  const { deps, lease, timing, harness, lane } = own;
  const context = BACKGROUND_CONTEXT;
  const logger = getLogger();
  const runInputs = new Map<string, SessionInputRow>();
  const delivered = await deliveredInputIds(lane, context);
  const disposers: Array<() => void> = [];
  let lastActivity = Date.now();
  let finished = false;
  let quiescing = false;
  // After Stop, the steers it kept wait for the next input instead of starting a run.
  let parked = false;
  let resolveOutcome!: (outcome: SessionHostOutcome) => void;
  const outcome = new Promise<SessionHostOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const finish = async (result: SessionHostOutcome) => {
    if (finished) return;
    finished = true;
    for (const dispose of disposers.splice(0)) dispose();
    await harness.close(context).catch(() => undefined);
    if (result === "released") await lease.release().catch(() => undefined);
    resolveOutcome(result);
  };

  const failed = (error: unknown) => {
    if (finished || error instanceof HarnessClosed) return;
    if (error instanceof HarnessFault) {
      // A fenced commit lost to a newer owner, or storage broke: stop writing at once.
      void finish("lease_lost");
      return;
    }
    logger.error("Session host delivery failed", { error });
  };

  const drive = (operationId: string) => {
    void lane.drive({ operationId, waitForRetry: true }, context).then(() => {
      runInputs.delete(operationId);
      schedule();
    }, failed);
  };

  const deliverPending = async () => {
    for (const input of await deps.inputs.pending()) {
      if (finished || quiescing) return;
      lastActivity = Date.now();
      if (delivered.has(input.id)) {
        await deps.inputs.markDelivered(input.id, {});
        continue;
      }
      const operationId = uuidv7();
      runInputs.set(operationId, input);
      const result = await deliverInput(lane, input, context, operationId);
      if (result.started !== operationId) runInputs.delete(operationId);
      delivered.add(input.id);
      if (input.kind !== "stop") parked = false;
      if (result.aborted) parked = true;
      await deps.inputs.markDelivered(input.id, {
        ...(result.piEntryId === undefined ? {} : { piEntryId: result.piEntryId }),
        ...(result.operationId === undefined ? {} : { operationId: result.operationId }),
      });
      if (result.started) drive(result.started);
    }
  };

  // Input that reached Pi's inbox after its run's last boundary waits there; an idle lane takes it
  // into a new run (lane.js:420-430).
  const drainInbox = async () => {
    if (finished || quiescing || parked) return;
    const operationId = uuidv7();
    const accepted = await lane.accept({ kind: "prompt", operationId, prompt: [] }, context);
    if (accepted.ok) drive(operationId);
  };

  let wanted = false;
  let pumping: Promise<void> | undefined;
  const pump = async () => {
    while (wanted && !finished) {
      wanted = false;
      await deliverPending();
      await drainInbox();
    }
  };
  const schedule = () => {
    wanted = true;
    if (pumping || finished) return;
    pumping = pump()
      .catch(failed)
      .finally(() => {
        pumping = undefined;
        if (wanted && !finished) schedule();
      });
  };

  for (const type of HARNESS_EVENT_TYPES) {
    disposers.push(
      harness.events.on(type, async (event: HarnessEvent) => {
        lastActivity = Date.now();
        const runId = "runId" in event ? event.runId : undefined;
        const input = runId === undefined ? undefined : runInputs.get(runId);
        try {
          await deps.onEvent?.(event, { lane, ...(input ? { input } : {}) });
        } finally {
          if (event.type === "fault") void finish("lease_lost");
          if (event.type === "run_end" || event.type === "queue_update") schedule();
        }
      }),
    );
  }
  disposers.push(own.config.install?.(harness, lane) ?? (() => undefined));
  disposers.push(deps.subscribe(schedule));

  let renewing = false;
  const renewal = setInterval(async () => {
    if (renewing || finished) return;
    renewing = true;
    try {
      if (!(await lease.renew().catch(() => false))) {
        await finish("lease_lost");
        return;
      }
      // An input whose notify was lost is delivered within one renewal.
      schedule();
      if (
        !quiescing &&
        !pumping &&
        Date.now() - lastActivity >= timing.idleEvictMs &&
        (await lane.inspectExecution(context)).current === null &&
        (await deps.inputs.pending()).length === 0
      ) {
        await finish("released");
      }
    } catch (error) {
      failed(error);
    } finally {
      renewing = false;
    }
  }, timing.renewMs);
  disposers.push(() => clearInterval(renewal));

  const quiesce = async () => {
    if (finished) return;
    quiescing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      lane.waitForIdle(context).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timing.quiesceMs);
      }),
    ]);
    clearTimeout(timer);
    await finish("released");
  };
  if (own.signal.aborted) void quiesce();
  else own.signal.addEventListener("abort", () => void quiesce(), { once: true });

  if (own.resumeOpen) {
    void lane.resume(context).then(() => schedule(), failed);
  }
  schedule();
  return outcome;
}
