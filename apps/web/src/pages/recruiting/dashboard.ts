/**
 * Pure aggregation for the recruiting Home dashboard. Counts only what existing reads return;
 * never re-scores, re-ranks or re-judges a candidate. `null` means no source reported the number.
 */
import type {
  Group,
  ListRecruitingCandidatesOutput,
  RecruitingReminder,
  RecruitingRoleCampaign,
  RecruitingRoleCandidatesOutput,
} from "@rakazo/contracts";

/** One role's numbers as its existing reads returned them. */
export type RoleSummary = {
  groupId: string;
  roleId: string;
  /** Autumn shortlist size for the role (`listCandidates({ shortlisted: true }).total`). */
  shortlisted: number;
  /** Recorded shortlist dates; unknown historic dates remain null. */
  shortlistedDates: readonly (string | null)[];
  /** Confirmed sent-contact count; campaign enrollment alone cannot establish it. */
  contacted: number | null;
  /** CRM contacts whose outreach status is `replied`; null without a readable CRM binding. */
  replied: number | null;
  /** Campaign leads marked interested or further (meeting booked/completed, won); null without a campaign. */
  interested: number | null;
  /** An explicitly partial observation must not be presented as a complete total. */
  interestedPartial?: boolean;
};

export type WeekBucket = { start: Date; count: number };
export type FunnelStageKey = "shortlisted" | "contacted" | "replied" | "interested";
export type DashboardRoleView =
  | "results"
  | "shortlist"
  | "contacts"
  | "sequence"
  | "inbox"
  | "interview";

/** Open the existing surface that owns this evidence; no unsupported cohort filter is invented. */
export function dashboardStageView(stage: FunnelStageKey): DashboardRoleView {
  return {
    shortlisted: "shortlist",
    contacted: "sequence",
    replied: "inbox",
    interested: "contacts",
  }[stage] as DashboardRoleView;
}

export type FunnelStage = {
  key: FunnelStageKey;
  count: number | null;
  /** The count is a lower bound from the available records, not a complete total. */
  partial: boolean;
};

/** Local midnight of the Monday that starts `date`'s week. */
export function weekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

/** `weeks` Monday-start buckets ending with the current week, oldest first. */
export function bucketByWeek(dates: Iterable<string | null>, now: Date, weeks = 5): WeekBucket[] {
  const current = weekStart(now);
  const buckets = Array.from({ length: weeks }, (_, index) => {
    const start = new Date(current);
    start.setDate(start.getDate() - 7 * (weeks - 1 - index));
    return { start, count: 0 };
  });
  for (const value of dates) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time) || time > now.getTime()) continue;
    const start = weekStart(new Date(time)).getTime();
    const bucket = buckets.find((item) => item.start.getTime() === start);
    if (bucket) bucket.count++;
  }
  return buckets;
}

const sumKnown = (values: (number | null)[]) =>
  values.length > 0 && values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;

/** Current stage counts across roles; unknown and partial reads remain distinct. */
export function outreachFunnel(roles: readonly RoleSummary[]): FunnelStage[] {
  const counts: Record<FunnelStageKey, number | null> = {
    shortlisted: sumKnown(roles.map((role) => role.shortlisted)),
    contacted: sumKnown(roles.map((role) => role.contacted)),
    replied: sumKnown(roles.map((role) => role.replied)),
    interested: sumKnown(roles.map((role) => role.interested)),
  };
  return (["shortlisted", "contacted", "replied", "interested"] as const).map((key) => {
    const count = counts[key];
    return {
      key,
      count,
      partial:
        count !== null &&
        roles.some(
          (role) => role[key] === null || (key === "interested" && role.interestedPartial),
        ),
    };
  });
}

/** Instantly lead interest values that mean interested or further along. */
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
    // Only a complete lead read supplies an exact interest count.
    interestedPartial: false,
  };
}

/** An exact reply total requires both authorized CRM data and complete count coverage. */
export function crmReplied(candidates: RecruitingRoleCandidatesOutput | null) {
  return candidates?.crmStatus === "ok" && candidates.crmCountsComplete === true
    ? candidates.counts.replied
    : null;
}

export function roleSummary(
  groupId: string,
  roleId: string,
  shortlist: Pick<ListRecruitingCandidatesOutput, "items" | "total">,
  candidates: RecruitingRoleCandidatesOutput | null,
  campaign: RecruitingRoleCampaign | null,
): RoleSummary {
  return {
    groupId,
    roleId,
    shortlisted: shortlist.total,
    shortlistedDates: shortlist.items
      .filter((item) => item.shortlisted)
      .map((item) => item.shortlistedAt),
    replied: crmReplied(candidates),
    ...campaignStages(campaign),
  };
}

/** The most recently active role conversations first. */
export function recentRoles(groups: readonly Group[], limit = 5): Group[] {
  return [...groups]
    .filter((group) => !group.archivedAt)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

/** Runs `task` over `items` with at most `limit` in flight, keeping input order. */
export async function mapWithConcurrency<T, R>(
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

/** First word of the account name for the greeting; empty when there is no name. */
export function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

/** Open reminders, earliest due first (so overdue ones lead), each marked overdue or not. */
export function openTasks(reminders: readonly RecruitingReminder[], now: Date) {
  return reminders
    .filter((reminder) => reminder.status === "open")
    .map((reminder) => ({ reminder, overdue: Date.parse(reminder.dueAt) < now.getTime() }))
    .sort(
      (left, right) =>
        Date.parse(left.reminder.dueAt) - Date.parse(right.reminder.dueAt) ||
        left.reminder.id.localeCompare(right.reminder.id),
    );
}

/** Read every shortlist page so older discoveries shortlisted recently count too. */
export async function readShortlistPages(
  load: (cursor?: string) => Promise<ListRecruitingCandidatesOutput>,
): Promise<Pick<ListRecruitingCandidatesOutput, "items" | "total">> {
  const items: ListRecruitingCandidatesOutput["items"] = [];
  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    total = page.total;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { items, total };
}
