/**
 * Pure aggregation for the recruiting Home dashboard. Counts only what existing reads return;
 * never re-scores, re-ranks or re-judges a candidate. `null` means no source reported the number.
 */
import type { Group, RecruitingOverviewRole, RecruitingReminder } from "@rakazo/contracts";

/** One role's numbers as the server's overview read reported them. */
export type RoleSummary = Pick<
  RecruitingOverviewRole,
  | "groupId"
  | "roleId"
  | "shortlisted"
  | "shortlistedDates"
  | "contacted"
  | "replied"
  | "interested"
  | "interestedPartial"
>;

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

/** The most recently active role conversations first. */
export function recentRoles(groups: readonly Group[], limit = 5): Group[] {
  return [...groups]
    .filter((group) => !group.archivedAt)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
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
