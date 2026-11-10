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
/** Pauses before each background retry of a failed save. */
export const FEEDBACK_RETRY_DELAYS_MS = [2_000, 6_000] as const;

/**
 * Feedback saved in the background: a round's direction and reviews of people. A round acceptance
 * starts the scale-out, hold/pass/resume are the recruiter's decisions on people, and preferences
 * edit a memory document at a revision, so those still return their own result.
 */
export function savesFeedbackInBackground(name: string, args: Record<string, unknown>): boolean {
  if (name !== "recruiting_feedback") return false;
  const operation = String(args.operation ?? "")
    .trim()
    .toLowerCase();
  if (args.target === "round") return operation !== "approve";
  if (args.target === "candidate") return !["hold", "pass", "resume"].includes(operation);
  return false;
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
  retry: (attempt: number) => Promise<unknown>;
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
      result = await attempt(input.retry(index + 1));
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
