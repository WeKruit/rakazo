/** Saved-record tools finish in seconds; one still running after this is stuck. */
export const RECORD_TOOL_DEADLINE_MS = 90_000;
/** How long the turn waits for a save it started itself before going on without it. */
export const SAVE_WAIT_MS = 30_000;
/** Native tools that only read or write saved records, with no provider call or wait inside. */
export const RECORD_TOOLS: ReadonlySet<string> = new Set([
  "recruiting_role",
  "recruiting_candidates",
  "recruiting_shortlist",
  "recruiting_assess",
  "recruiting_feedback",
  "recruiting_notes",
  "recruiting_reminders",
  "recruiting_crm_target",
  "recruiting_request_approval",
  "read_memory",
  "remember",
  "save_shared_memory",
  "save_group_memory",
]);
export const RECORD_TOOL_LATE_TEXT =
  "This step did not finish in time and its outcome is unknown. Read the saved state before repeating it, answer any new message from the recruiter now, and keep going.";

/**
 * A stuck save must not hold the turn, because the recruiter's messages wait behind it. After
 * `ms` the caller gets `late()` and goes on; the call is left to finish or fail on its own, and a
 * write effect it started stays `executing`, which later attempts treat as uncertain.
 */
export function withinDeadline<T>(promise: Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(late()), ms);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
