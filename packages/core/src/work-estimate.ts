/**
 * How long a big piece of background work should take, shown to the recruiter as a countdown.
 * Like Workloop's wait timeout: when the time is up the agent checks and reports progress, and
 * a fresh countdown of the same length starts if the work is still going. Small work has no
 * estimate and shows a clock counting up instead.
 */
export type WorkEstimateKind = "search" | "emails";

export type WorkEstimate = {
  kind: WorkEstimateKind;
  /** People asked for (a search) or still to look up (emails). */
  people: number;
  startedAt: string;
  /** Null for small work: the clock counts up. */
  estimateMs: number | null;
};

/** Below this many people the work counts up; the role default (100) already counts down. */
export const WORK_COUNTDOWN_MIN_PEOPLE = 100;
/** People to assume when a search names no count: the scale step's default target. */
export const WORK_DEFAULT_PEOPLE = 100;
const MINUTE = 60_000;
/** Countdown lengths, like Workloop's wait timeouts: the estimate rounds up to the next one. */
const STEPS_MIN = [2, 5, 10, 15, 20, 25, 30];
/**
 * Measured on live roles: 100 people arrived in about 2 minutes, a 300-person wave in 4–10, and
 * 500 contact lookups took 25 minutes.
 */
const MS_PER_PERSON: Record<WorkEstimateKind, number> = { search: 1_200, emails: 3_000 };

export function estimateWorkMs(kind: WorkEstimateKind, people: number): number | null {
  if (!Number.isFinite(people) || people < WORK_COUNTDOWN_MIN_PEOPLE) return null;
  const minutes = (people * MS_PER_PERSON[kind]) / MINUTE;
  const step = STEPS_MIN.find((value) => value >= minutes) ?? STEPS_MIN[STEPS_MIN.length - 1];
  return (step ?? 30) * MINUTE;
}

/** Whole countdowns that have run out since the work started. */
export function workCountdownsElapsed(
  estimate: Pick<WorkEstimate, "startedAt" | "estimateMs">,
  now: number,
): number {
  if (!estimate.estimateMs) return 0;
  const elapsed = now - Date.parse(estimate.startedAt);
  return elapsed > 0 ? Math.floor(elapsed / estimate.estimateMs) : 0;
}

/** Time left on the current countdown; a run-out countdown starts over at full length. */
export function workCountdownLeftMs(
  estimate: Pick<WorkEstimate, "startedAt" | "estimateMs">,
  now: number,
): number | null {
  if (!estimate.estimateMs) return null;
  const elapsed = Math.max(0, now - Date.parse(estimate.startedAt));
  return estimate.estimateMs - (elapsed % estimate.estimateMs);
}
