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
const MIN_ESTIMATE_MS = 5 * MINUTE;
/** Workloop's longest wait; past it the agent reports and the countdown starts over. */
const MAX_ESTIMATE_MS = 30 * MINUTE;
/**
 * Measured on live roles: a 300-person wave took 4–10 minutes, ultra waves about 20, and 500
 * contact lookups 25 minutes. Rounded up so a countdown rarely runs out before the work does.
 */
const MS_PER_PERSON: Record<WorkEstimateKind, number> = { search: 2_000, emails: 3_000 };

export function estimateWorkMs(kind: WorkEstimateKind, people: number): number | null {
  if (!Number.isFinite(people) || people < WORK_COUNTDOWN_MIN_PEOPLE) return null;
  const ms = Math.min(MAX_ESTIMATE_MS, Math.max(MIN_ESTIMATE_MS, people * MS_PER_PERSON[kind]));
  return Math.ceil(ms / MINUTE) * MINUTE;
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

/**
 * The people count a search request names ("find 500 more", "1,200"), else the default target.
 * Years and small numbers inside a brief ("2024", "10+ years") are not counts.
 */
export function peopleNamedIn(text: unknown): number {
  if (typeof text !== "string") return WORK_DEFAULT_PEOPLE;
  let most = 0;
  for (const match of text.matchAll(/\b\d{1,3}(?:,\d{3})+\b|\b\d{2,5}\b/g)) {
    const value = Number(match[0].replaceAll(",", ""));
    if (value >= 1900 && value <= 2100 && !match[0].includes(",")) continue;
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\+?\s*(?:years?|yrs?|年)/i.test(after)) continue;
    most = Math.max(most, value);
  }
  return most >= 10 ? most : WORK_DEFAULT_PEOPLE;
}
