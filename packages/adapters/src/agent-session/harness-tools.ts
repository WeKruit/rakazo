import type { AgentHarnessTool, AgentTool } from "@earendil-works/pi-agent-core";
import { builtinAgentTools } from "../builtin-tools.js";

/** Per-turn tool context handed to every harness tool. Nothing is carried yet. */
export type RakazoToolContext = Record<string, never>;

export type ReplayPolicy = "never" | "safe";

/**
 * Tools whose call may run again after a crash: the read-only builtins. Every other tool is
 * `replay: "never"`, so an effect left pending by a dead worker comes back as Pi's interruption
 * result instead of running twice.
 */
export const SAFE_REPLAY_TOOLS: ReadonlySet<string> = new Set(
  builtinAgentTools.filter((tool) => tool.readOnly).map((tool) => tool.name),
);

export function replayPolicyFor(toolName: string): ReplayPolicy {
  return SAFE_REPLAY_TOOLS.has(toolName) ? "safe" : "never";
}

/**
 * Wraps a runtime tool for the harness. The tool's call id is Pi's invocation id: it is unique
 * in the session and unchanged when a safe call is replayed, so effects keyed by call id stay
 * idempotent across workers.
 */
export function toHarnessTool(
  tool: AgentTool,
  replay: ReplayPolicy = replayPolicyFor(tool.name),
  /** Waits until the operation's run setup can execute its tools. */
  beforeExecute?: (operationId: string) => Promise<void>,
): AgentHarnessTool<RakazoToolContext> {
  const { execute, ...definition } = tool;
  return {
    ...definition,
    replay,
    execute: async (_toolCallId, params, onUpdate, _toolContext, invocation, context) => {
      await beforeExecute?.(invocation.operationId);
      return execute(invocation.invocationId, params, context.abortSignal, (partial) =>
        onUpdate(partial),
      );
    },
  };
}
