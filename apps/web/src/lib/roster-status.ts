import { t } from "@lingui/core/macro";
import type { ThreadTailPhase } from "@rakazo/core";

export function rosterHasUndismissedRunError(
  runErrorId: string | null | undefined,
  dismissedRunErrorIds: ReadonlySet<string>,
): boolean {
  return Boolean(runErrorId && !dismissedRunErrorIds.has(runErrorId));
}

/** Short sidebar label while a bot is queued, starting, or running. Null keeps the message preview. */
export function rosterWorkStatusLabel(status: string): string | null {
  switch (status) {
    case "queued":
      return t`Waiting in line…`;
    case "leased":
      return t`Starting…`;
    case "running":
      return t`Working…`;
    default:
      return null;
  }
}

/** Compact rows keep actionable status visible in place of the message preview. */
export function compactRosterStatusLabel(status: string): string | null {
  const workStatus = rosterWorkStatusLabel(status);
  if (workStatus) return workStatus;
  switch (status) {
    case "waiting_input":
      return t`Needs an answer`;
    case "waiting_takeover":
      return t`Needs you`;
    case "failed":
      return t`Error`;
    default:
      return null;
  }
}

/** Phases that belong to a run doing work, where streamed reply text supersedes the label. */
export function isRunPhase(phase: ThreadTailPhase | null): boolean {
  return phase === "working" || phase === "starting" || phase === "queued";
}

/** The line at the end of a thread while the reply is not on screen yet. */
export function threadTailLabel(phase: ThreadTailPhase | null): string | null {
  switch (phase) {
    case "compacting":
      return t`Compacting…`;
    case "retrying":
      return t`Reconnecting…`;
    case "needs_input":
      return t`Needs an answer`;
    case "needs_takeover":
      return t`Needs you`;
    case "working":
      return t`Working…`;
    case "starting":
      return t`Starting…`;
    case "queued":
      return t`Waiting in line…`;
    case "background":
      return t`Working in background…`;
    default:
      return null;
  }
}
