import type {
  RecruitingCorrespondence,
  RecruitingCrmDataOutput,
  RecruitingProfileView,
} from "@rakazo/contracts";

type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
type DetailsPage = Extract<RecruitingCrmDataOutput, { operation: "candidateDetails" }>;
type SavedEmail = RecruitingCorrespondence["emails"][number];
type Workflow = NonNullable<DetailsPage["roleTracking"][number]["workflowStatus"]>;
type ReviewResult = NonNullable<NonNullable<DetailsPage["review"]>["result"]>;

/** One stored event about a person, newest first in the timeline. `at` is null when undated. */
export type ActivityItem = {
  id: string;
  at: string | null;
  actor: string | null;
  context?: string;
  source: "profile" | "correspondence" | "mailbox" | "outbox" | "status" | "review";
} & (
  | { kind: "viewed" }
  | { kind: "sent" | "received" | "email" | "scheduled"; subject: string | null }
  | { kind: "queued" | "failed"; preview: string }
  | { kind: "status"; status: Workflow }
  | { kind: "change"; label: string; before: string | null; after: string | null }
  | { kind: "highSignal" }
  | { kind: "review"; result: ReviewResult | null; notes: string | null }
);

// Match complete mailbox addresses, never substrings such as ada@example.test.evil.
const mentions = (value: string | null | undefined, email: string) => {
  if (!value || !email) return false;
  const addresses = value.match(/[^\s<>(),;:[\]"@]+@[^\s<>(),;:[\]"@]+/g) ?? [];
  return addresses.some((address) => address.toLowerCase() === email);
};
const date = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? value : null;

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
  views,
  candidateKey,
  history,
}: {
  email?: string | null;
  mail?: MailPage;
  details?: DetailsPage;
  /** The role's CRM tracking key; tracking rows for other roles are left out. */
  roleKey?: string | null;
  crmRoleId?: string | null;
  saved?: readonly SavedEmail[];
  views?: readonly RecruitingProfileView[];
  candidateKey?: string;
  history?: RecruitingCorrespondence["history"];
}): ActivityItem[] {
  const address = email?.trim().toLowerCase() ?? "";
  const items: ActivityItem[] = (views ?? []).map((view) => ({
    id: `view:${view.id}`,
    at: date(view.at),
    actor: view.actorName,
    context: view.roleTitle,
    source: "profile",
    kind: "viewed",
  }));
  const messages = new Set<string>();
  for (const change of history ?? []) {
    if (!candidateKey || change.candidateKey !== candidateKey) continue;
    items.push({
      id: `import:${change.id}`,
      at: change.at,
      actor: null,
      source: "status",
      kind: "change",
      label: change.label,
      before: change.before,
      after: change.after,
    });
  }
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
      // The retained message date/sender do not identify when or who scheduled it.
      at: entry.status === "scheduled" ? null : date(entry.email.date),
      actor: entry.status === "scheduled" ? null : entry.email.sender,
      source: "correspondence",
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
      at: date(item.date),
      actor: item.sender,
      source: "correspondence",
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
      at: date(item.date),
      actor: item.sender,
      source: "mailbox",
      subject: item.subject || null,
      kind,
    });
  }
  for (const entry of details?.outbox ?? []) {
    const preview = (entry.polishedBody ?? entry.body).trim();
    if (entry.status === "sent")
      addEmail(entry.providerMessageId, {
        id: `outbox:${entry.id}`,
        at: date(entry.sentAt),
        actor: null,
        source: "outbox",
        subject: null,
        kind: "sent",
      });
    else
      items.push({
        id: `outbox:${entry.id}`,
        at: entry.status === "failed" ? null : date(entry.createdAt),
        actor: null,
        source: "outbox",
        kind: entry.status === "failed" ? "failed" : "queued",
        preview,
      });
  }
  for (const tracking of details?.roleTracking ?? []) {
    if (!roleKey || tracking.roleKey !== roleKey) continue;
    if (tracking.workflowStatus && tracking.statusChangedAt)
      items.push({
        id: `status:${tracking.roleKey}`,
        at: date(tracking.statusChangedAt),
        actor: null,
        source: "status",
        kind: "status",
        status: tracking.workflowStatus,
      });
    if (tracking.highSignal && tracking.highSignalAt)
      items.push({
        id: `signal:${tracking.roleKey}`,
        at: date(tracking.highSignalAt),
        actor: null,
        source: "status",
        kind: "highSignal",
      });
  }
  const review = details?.review;
  if (
    review &&
    (review.result || review.notes?.trim()) &&
    crmRoleId &&
    review.crmRoleId === crmRoleId
  )
    items.push({
      id: `review:${review.id}`,
      at: date(review.updatedAt),
      actor: null,
      source: "review",
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
