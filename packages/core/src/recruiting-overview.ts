/**
 * The recruiting Home numbers for every active role, in one read. Counts only what the existing
 * reads return; never re-scores, re-ranks or re-judges a candidate.
 */
import type {
  RecruitingCorrespondence,
  RecruitingOverviewEvent,
  RecruitingOverviewRole,
  RecruitingRoleCampaign,
  RecruitingRoleCandidatesOutput,
} from "@rakazo/contracts";

/** Roles read at once. Each role is a few database reads plus its CRM, campaign and calendar. */
const OVERVIEW_CONCURRENCY = 8;
/**
 * CRM, campaign and calendar reads in flight at once across all roles. They share connector
 * services with the rest of the app (the sidebar's CRM list), which must not be crowded out.
 */
const EXTERNAL_CONCURRENCY = 4;
/** A role's optional sources (CRM, campaign, calendar) that take longer are reported partial. */
export const OVERVIEW_SOURCE_MS = 8_000;

const INTERESTED = new Set([1, 2, 3, 4]);

/** Campaign membership/status is not a sent receipt. Interest uses explicit recorded values only. */
export function campaignStages(campaign: RecruitingRoleCampaign | null) {
  if (
    campaign?.status !== "ready" ||
    !campaign.campaign ||
    campaign.campaign.status === null ||
    campaign.leadsComplete !== true
  ) {
    return { contacted: null, interested: null, interestedPartial: false };
  }
  // Draft campaigns have sent nothing. Enrollment/status does not prove actual sends.
  return {
    contacted: campaign.campaign.status === 0 ? 0 : null,
    interested: campaign.leads.filter(
      (lead) => lead.interestStatus !== null && INTERESTED.has(lead.interestStatus),
    ).length,
    interestedPartial: false,
  };
}

/** An exact reply total requires both authorized CRM data and complete count coverage. */
export function crmReplied(candidates: RecruitingRoleCandidatesOutput | null) {
  return candidates?.crmStatus === "ok" && candidates.crmCountsComplete === true
    ? candidates.counts.replied
    : null;
}

export type OverviewGroup = { id: string; threadId: string };
/** One role's reads. Each is given a signal that ends with the request or the source budget. */
export type OverviewReads = {
  /** The conversation's bound role, or null when no role is bound. */
  roleId: (group: OverviewGroup, signal: AbortSignal) => Promise<string | null>;
  /** The role's shortlisted people: how many, and when each was shortlisted. */
  shortlist: (
    roleId: string,
    signal: AbortSignal,
  ) => Promise<{ total: number; dates: (string | null)[] }>;
  candidates: (
    group: OverviewGroup,
    signal: AbortSignal,
  ) => Promise<RecruitingRoleCandidatesOutput>;
  campaign: (group: OverviewGroup, signal: AbortSignal) => Promise<RecruitingRoleCampaign>;
  calendar: (group: OverviewGroup, signal: AbortSignal) => Promise<RecruitingCorrespondence>;
};

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** At most `limit` tasks run at once; the rest wait their turn. */
function limiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}
type Limit = ReturnType<typeof limiter>;

/** An optional source: its time budget starts once it has a turn, and running out means partial. */
async function optional<T>(
  external: Limit,
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T | undefined> {
  return external(() => withBudget(load, signal, ms));
}

async function withBudget<T>(
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  return Promise.race([
    load(budget),
    new Promise<undefined>((resolve) => budget.addEventListener("abort", () => resolve(undefined))),
  ]).catch(() => undefined);
}

/** A role's saved numbers, sent before its slower sources (CRM, campaign, calendar) answer. */
function savedRole(
  group: OverviewGroup,
  roleId: string,
  list: { total: number; dates: (string | null)[] },
): RecruitingOverviewRole {
  return {
    groupId: group.id,
    roleId,
    shortlisted: list.total,
    shortlistedDates: list.dates,
    replied: null,
    contacted: null,
    interested: null,
    interestedPartial: false,
    incomplete: true,
    bookings: [],
    bookingUnknown: true,
  };
}

async function sourceRole(
  base: RecruitingOverviewRole,
  group: OverviewGroup,
  reads: OverviewReads,
  signal: AbortSignal,
  now: number,
  sourceMs: number,
  external: Limit,
): Promise<RecruitingOverviewRole> {
  const [candidates, campaign, calendar] = await Promise.all([
    optional(external, (budget) => reads.candidates(group, budget), signal, sourceMs),
    optional(external, (budget) => reads.campaign(group, budget), signal, sourceMs),
    optional(external, (budget) => reads.calendar(group, budget), signal, sourceMs),
  ]);
  const calendarRead =
    calendar?.roleId === base.roleId && ["ready", "empty"].includes(calendar.status)
      ? calendar
      : undefined;
  return {
    ...base,
    replied: crmReplied(candidates ?? null),
    ...campaignStages(campaign ?? null),
    incomplete: !candidates || !campaign,
    bookings: (calendarRead?.events ?? []).filter(
      (event) =>
        event.kind === "event" &&
        (event.status === "confirmed" || event.status === "accepted") &&
        Date.parse(event.start) > now,
    ),
    bookingUnknown: !calendarRead || calendarRead.partial,
  };
}

/** Reads every role, at most a few at once, and yields each one as soon as it is read. */
export async function* streamRecruitingOverview(
  groups: readonly OverviewGroup[],
  reads: OverviewReads,
  signal: AbortSignal,
  { now = Date.now(), sourceMs = OVERVIEW_SOURCE_MS } = {},
): AsyncGenerator<RecruitingOverviewEvent> {
  const external = limiter(EXTERNAL_CONCURRENCY);
  const ready: RecruitingOverviewEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const push = (event: RecruitingOverviewEvent) => {
    ready.push(event);
    wake?.();
  };
  // Saved numbers (database only) go out for every role first; each role's CRM, campaign and
  // calendar read follows in the background and replaces that role's numbers when it answers.
  const sources: Promise<void>[] = [];
  const run = mapWithConcurrency(groups, OVERVIEW_CONCURRENCY, async (group) => {
    try {
      const roleId = await reads.roleId(group, signal);
      if (!roleId) return;
      const base = savedRole(group, roleId, await reads.shortlist(roleId, signal));
      push({ kind: "role", role: base });
      sources.push(
        sourceRole(base, group, reads, signal, now, sourceMs, external).then(
          (role) => push({ kind: "role", role }),
          () => undefined,
        ),
      );
    } catch {
      if (!signal.aborted) push({ kind: "failed", groupId: group.id });
    }
  })
    .then(() => Promise.all(sources))
    .finally(() => {
      finished = true;
      wake?.();
    });
  for (;;) {
    while (ready.length) yield ready.shift()!;
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
  await run;
  if (!signal.aborted) yield { kind: "done" };
}
