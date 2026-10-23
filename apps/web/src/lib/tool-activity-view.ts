import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { humanizeToolName, isToolActivityBlock } from "@rakazo/core";

const publicActivities = [
  ["read_file", "files"],
  ["list_files", "files"],
  ["web_search", "search"],
  ["web_fetch", "page"],
  ["browser_snapshot", "page"],
  ["skill_read", "context"],
  ["read_memory", "context"],
  ["read_history", "context"],
  ["artifact_read", "context"],
  ["mcp_list_tools", "connections"],
  ["mcp_execute_tool", "connected_action"],
  ["connectors_execute_tool", "connected_action"],
  ["native_instantly_search_contact_emails", "emails"],
  ["native_instantly_list_mailbox_emails", "emails"],
] as const;
export type PublicToolActivity =
  | (typeof publicActivities)[number][1]
  | "emails"
  | "availability"
  | "working";

/** Only a live native tool marker supplies activity; its free text is never product copy. */
export function latestNativeToolActivity(
  messages: readonly Pick<ThreadMessage, "id" | "runId" | "seq" | "blocks">[],
  runningRunIds: readonly string[],
): PublicToolActivity | null {
  const latest = messages
    .filter(
      (message) =>
        message.id.startsWith("progress:") &&
        message.runId &&
        runningRunIds.includes(message.runId),
    )
    .reduce<(typeof messages)[number] | undefined>(
      (latest, message) => (!latest || message.seq > latest.seq ? message : latest),
      undefined,
    );
  const activity = latest?.blocks.at(-1);
  if (activity?.kind !== "progress" || activity.activity !== true) return null;
  const pending = activity.pendingToolNames?.at(-1);
  const steps = latest?.blocks.findLast((block) => block.kind === "steps");
  const name =
    pending ??
    (activity.text === "" && steps?.kind === "steps" ? steps.steps.at(-1)?.label : undefined);
  // Native names may already be humanized in persisted steps; ignore the server label.
  const operation = name?.includes("__")
    ? name
        ?.match(
          /^(?:mcp|instantly|cal)__.+__(get_email|list_emails|get_thread_history|search_contact_emails|list_mailbox_emails|get_availability)$/,
        )?.[1]
        ?.replaceAll("_", " ")
    : name
      ? humanizeToolName(name).match(
          /^(?:Mcp|Instantly|Cal) .+ (get email|list emails|get thread history|search contact emails|list mailbox emails|get availability)$/,
        )?.[1]
      : undefined;
  if (operation === "get availability") return "availability";
  if (operation) return "emails";
  return (
    publicActivities.find(([tool]) => name === tool || name === humanizeToolName(tool))?.[1] ??
    "working"
  );
}

/**
 * Compact human duration for a tool-activity card summary.
 * Returns null when there is no usable duration (missing, non-finite or negative),
 * so the caller can omit the segment entirely.
 */
export function formatToolActivityDuration(durationMs: number | null | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) {
    const seconds = Math.round(durationMs / 100) / 10;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Number of tool calls behind a steps block: the sum of each row's count. */
export function toolStepCount(steps: readonly { count: number }[]): number {
  return steps.reduce((total, step) => total + step.count, 0);
}

/**
 * Only a `steps` block becomes a card, and only when the preference is on.
 * A `progress` block marked `activity: true` never renders, in either mode.
 */
export function shouldRenderToolCard(block: MessageBlock, showToolActivity: boolean): boolean {
  return showToolActivity && block.kind === "steps";
}

/** Blocks that survive into a message render: everything except hidden tool activity. */
export function renderableMessageBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): MessageBlock[] {
  return blocks.filter(
    (block) =>
      (showToolActivity ||
        !["handoff", "bot_message_sent", "bot_message_received", "subagent", "child_bot"].includes(
          block.kind,
        )) &&
      (!isToolActivityBlock(block) || shouldRenderToolCard(block, showToolActivity)),
  );
}

/**
 * True when a bot message's only visible blocks are tool cards, such as a live run that
 * has called tools but not written anything yet. Such a message renders as slim lines
 * between messages instead of inside a chat bubble.
 */
export function isToolOnlyNarration(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  const visible = renderableMessageBlocks(blocks, showToolActivity);
  return visible.length > 0 && visible.every((block) => block.kind === "steps");
}

/** True when a message still has at least one block to show under the preference. */
export function messageHasVisibleBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  return renderableMessageBlocks(blocks, showToolActivity).length > 0;
}
