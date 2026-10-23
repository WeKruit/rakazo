import type { RecruitingCorrespondence, RecruitingCrmDataOutput } from "@rakazo/contracts";

type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
type DetailsPage = Extract<RecruitingCrmDataOutput, { operation: "candidateDetails" }>;
type SavedEmail = RecruitingCorrespondence["emails"][number];
type Workflow = NonNullable<DetailsPage["roleTracking"][number]["workflowStatus"]>;
type ReviewResult = NonNullable<NonNullable<DetailsPage["review"]>["result"]>;

/** One stored event about a person, newest first in the timeline. `at` is null when undated. */
export type ActivityItem = { id: string; at: string | null } & (
  | { kind: "sent" | "received" | "email" | "scheduled"; subject: string | null }
  | { kind: "queued" | "failed"; preview: string }
  | { kind: "status"; status: Workflow }
  | { kind: "highSignal" }
  | { kind: "review"; result: ReviewResult | null; notes: string | null }
);

const mentions = (value: string | null | undefined, email: string) =>
  Boolean(value && email && value.toLowerCase().includes(email));

/**
 * Builds a person's timeline from what is already stored: CRM mail and native receipts, the CRM
 * outbox, this role's tracking status and review, and saved mailbox reads that name the person's
 * address. Nothing is inferred beyond what a record states; undated records sort last.
 */
export function buildActivity({
  email,
  mail,
  details,
  roleKey,
  crmRoleId,
  saved,
}: {
  email?: string | null;
  mail?: MailPage;
  details?: DetailsPage;
  /** The role's CRM tracking key; tracking rows for other roles are left out. */
  roleKey?: string | null;
  crmRoleId?: string | null;
  saved?: readonly SavedEmail[];
}): ActivityItem[] {
  const address = email?.trim().toLowerCase() ?? "";
  const items: ActivityItem[] = [];
  const messages = new Set<string>();
  const addEmail = (
    providerMessageId: string | null,
    item: Extract<ActivityItem, { subject: string | null }>,
  ) => {
    if (providerMessageId) {
      if (messages.has(providerMessageId)) return;
      messages.add(providerMessageId);
    }
    items.push(item);
  };
  const direction = (sender: string | null, recipients: readonly string[]) =>
    mentions(sender, address)
      ? ("received" as const)
      : recipients.some((recipient) => mentions(recipient, address))
        ? ("sent" as const)
        : ("email" as const);

  for (const entry of mail?.nativeCorrespondence ?? []) {
    if (!entry.email) continue;
    addEmail(entry.email.providerMessageId, {
      id: `native:${entry.id}`,
      at: entry.email.date,
      subject: entry.email.subject || null,
      kind:
        entry.status === "sent_recorded"
          ? "sent"
          : entry.status === "scheduled"
            ? "scheduled"
            : direction(entry.email.sender, entry.email.recipients),
    });
  }
  for (const item of mail?.items ?? [])
    addEmail(item.providerMessageId, {
      id: `crm:${item.id}`,
      at: item.date,
      subject: item.subject || null,
      kind:
        item.direction === "sent" ? "sent" : item.direction === "received" ? "received" : "email",
    });
  for (const item of saved ?? []) {
    const kind = direction(item.sender, item.recipients);
    // A saved mailbox read belongs to this person only when it names their address.
    if (kind === "email") continue;
    addEmail(item.providerMessageId, {
      id: `saved:${item.id}`,
      at: item.date,
      subject: item.subject || null,
      kind,
    });
  }
  for (const entry of details?.outbox ?? []) {
    const preview = (entry.polishedBody ?? entry.body).trim();
    if (entry.status === "sent")
      addEmail(entry.providerMessageId, {
        id: `outbox:${entry.id}`,
        at: entry.sentAt ?? entry.createdAt,
        subject: null,
        kind: "sent",
      });
    else
      items.push({
        id: `outbox:${entry.id}`,
        at: entry.createdAt,
        kind: entry.status === "failed" ? "failed" : "queued",
        preview,
      });
  }
  for (const tracking of details?.roleTracking ?? []) {
    if (roleKey && tracking.roleKey !== roleKey) continue;
    if (tracking.workflowStatus && tracking.statusChangedAt)
      items.push({
        id: `status:${tracking.roleKey}`,
        at: tracking.statusChangedAt,
        kind: "status",
        status: tracking.workflowStatus,
      });
    if (tracking.highSignal && tracking.highSignalAt)
      items.push({
        id: `signal:${tracking.roleKey}`,
        at: tracking.highSignalAt,
        kind: "highSignal",
      });
  }
  const review = details?.review;
  if (
    review &&
    (review.result || review.notes?.trim()) &&
    (!crmRoleId || !review.crmRoleId || review.crmRoleId === crmRoleId)
  )
    items.push({
      id: `review:${review.id}`,
      at: review.updatedAt,
      kind: "review",
      result: review.result,
      notes: review.notes?.trim() || null,
    });

  const time = (item: ActivityItem) => (item.at ? Date.parse(item.at) : Number.NaN);
  return items.sort((a, b) => {
    const left = time(a);
    const right = time(b);
    if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 days ago" in the active locale; "now" under a minute. */
export function relativeTime(at: string, locale: string, now = Date.now()) {
  const seconds = (Date.parse(at) - now) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "second");
}
