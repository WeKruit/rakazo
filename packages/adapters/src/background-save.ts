/**
 * Saving the recruiter's feedback is record keeping: it must never hold up or stop the work the
 * recruiter asked for. The agent gets the saved result when the save is quick, and otherwise a note
 * to carry on while the save finishes and retries in the background.
 */

/** What the agent sees while a feedback save finishes in the background. */
export const FEEDBACK_SAVING = {
  status: "saving",
  note: "Saving in the background; it retries by itself. Do not call it again, wait for it or mention it to the recruiter: carry on with their request now, including the next search or round.",
} as const;

/** How long the agent waits for a quick save before carrying on. */
export const FEEDBACK_SAVE_WAIT_MS = 1_500;
/**
 * How long the agent waits for a preference's first attempt. A refusal (the exact quote, a role
 * requirement) must reach the agent so it can fix and resend; only retries run in the background.
 */
export const PREFERENCE_SAVE_WAIT_MS = 15_000;
/** How long a call naming a role revision waits for this run's own role saves still running. */
export const ROLE_SAVE_WAIT_MS = 5_000;
/** Pauses before each background retry of a failed save. */
export const FEEDBACK_RETRY_DELAYS_MS = [2_000, 6_000] as const;

/**
 * Feedback saved in the background: a round's direction, reviews of people and reusable
 * preferences. A round acceptance starts the scale-out and hold/pass/resume are the recruiter's
 * decisions on people, so those still return their own result. A preference is one line added,
 * replaced or removed by its anchor, so a retry can apply it to the newest revision.
 */
export function savesFeedbackInBackground(name: string, args: Record<string, unknown>): boolean {
  if (name !== "recruiting_feedback") return false;
  const operation = String(args.operation ?? "")
    .trim()
    .toLowerCase();
  if (args.target === "round") return operation !== "approve";
  if (args.target === "candidate") return !["hold", "pass", "resume"].includes(operation);
  return args.target === "preference";
}

const TIMED_OUT = Symbol("timed out");

/**
 * Runs a feedback save without blocking the agent. `reply` is what the tool returns: the saved
 * result when the first attempt succeeds within `waitMs`, an input error the agent can fix (wrong
 * people), or FEEDBACK_SAVING. `settled` ends when the save succeeds or the retries run out; the turn
 * waits for it before it ends.
 */
export function saveInBackground(input: {
  first: Promise<unknown>;
  /** Gets the failed result before it, such as a conflict naming the current revision. */
  retry: (attempt: number, previous: unknown) => Promise<unknown>;
  failed: (result: unknown) => boolean;
  /** A failure only the agent can fix, such as naming people who are not saved on the role. */
  inputError: (result: unknown) => boolean;
  onGiveUp: (result: unknown) => void;
  waitMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): { reply: Promise<unknown>; settled: Promise<unknown> } {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const attempt = (promise: Promise<unknown>) =>
    promise.catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  const first = attempt(input.first);
  const settled = (async () => {
    let result = await first;
    const delays = input.retryDelaysMs ?? FEEDBACK_RETRY_DELAYS_MS;
    for (const [index, delay] of delays.entries()) {
      if (!input.failed(result) || input.inputError(result)) return result;
      await sleep(delay);
      result = await attempt(input.retry(index + 1, result));
    }
    if (input.failed(result) && !input.inputError(result)) input.onGiveUp(result);
    return result;
  })();
  const reply = Promise.race([
    first,
    sleep(input.waitMs ?? FEEDBACK_SAVE_WAIT_MS).then(() => TIMED_OUT),
  ]).then((result) =>
    result !== TIMED_OUT && (!input.failed(result) || input.inputError(result))
      ? result
      : FEEDBACK_SAVING,
  );
  return { reply, settled };
}

/**
 * A role save is record keeping too: an update to the brief or a requirement runs in the
 * background like feedback. Role creation and reads still return their own result.
 */
export function savesRoleInBackground(name: string, args: Record<string, unknown>): boolean {
  return name === "recruiting_role" && args.operation === "update";
}

/**
 * A preference retried after a revision conflict names the revision the conflict reported, so the
 * same line edit lands on the newest document instead of failing again.
 */
export function preferenceAtCurrentRevision(
  args: Record<string, unknown>,
  previous: unknown,
): Record<string, unknown> {
  const current = savedPayload(previous)?.currentRevision;
  return args.target === "preference" && Number.isSafeInteger(current) && (current as number) >= 0
    ? { ...args, expectedRevision: current }
    : args;
}

function savedPayload(result: unknown): { code?: unknown; currentRevision?: unknown } | null {
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  return payload && typeof payload === "object" ? payload : null;
}

/** A save that lost a revision race, which a retry at the newest revision fixes. */
export function revisionConflict(result: unknown): boolean {
  return savedPayload(result)?.code === "CONFLICT";
}

/** A failed save that a retry can fix: a revision race or a passing outage, not bad input. */
export function transientSaveError(error: unknown): boolean {
  return /conflict|revision|timed? ?out|temporar|unavailable|deadlock|serializ|ECONN|connection/i.test(
    typeof error === "string" ? error : JSON.stringify(error ?? ""),
  );
}

/**
 * The role revisions this run saved itself. A background save means the agent may still name the
 * revision it started from, so a later call naming an older revision this run produced acts on the
 * newest one it knows; a revision someone else saved still conflicts as before.
 */
export function ownRoleRevisions() {
  const roles = new Map<string, { seen: Set<number>; latest: number }>();
  return {
    saved(roleId: string, to: number) {
      const role = roles.get(roleId) ?? { seen: new Set<number>(), latest: to };
      role.seen.add(to - 1);
      role.seen.add(to);
      role.latest = Math.max(role.latest, to);
      roles.set(roleId, role);
    },
    current(roleId: string | undefined, expected: unknown): unknown {
      const role = roleId ? roles.get(roleId) : undefined;
      return role &&
        typeof expected === "number" &&
        role.seen.has(expected) &&
        expected < role.latest
        ? role.latest
        : expected;
    },
  };
}
