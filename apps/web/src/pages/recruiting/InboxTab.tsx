import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import type { CrmReplyDraftContext } from "../RecruitingPanel";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  useCrmData,
  useRoleCrm,
} from "./shared";

type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
type Direction = MailPage["items"][number]["direction"];

/**
 * A selected stored email, shaped like the chat's CRM reply context (add the conversation's
 * `threadId` to pass it to `onDraftReply`). The body is included so chat can quote it.
 */
export type RecruitingInboxEmail = Omit<CrmReplyDraftContext, "threadId" | "email"> & {
  crmRoleId: string;
  email: CrmReplyDraftContext["email"] & {
    id: string;
    body: string;
    direction: Direction;
    partial: boolean;
  };
};

type InboxProps = RecruitingTabProps & {
  /** Called with the email the recruiter selects (undefined when none), so chat can carry it. */
  onSelectEmail?: (email: RecruitingInboxEmail | undefined) => void;
};

function mailItems(page: MailPage) {
  const seen = new Set<string>();
  const items: RecruitingInboxEmail["email"][] = [];
  // Native receipts carry the exact message the agent read or recorded; CRM mail fills the rest.
  for (const entry of page.nativeCorrespondence) {
    if (!entry.email || seen.has(entry.email.providerMessageId)) continue;
    seen.add(entry.email.providerMessageId);
    items.push({
      id: `native:${entry.email.id}`,
      sender: entry.email.sender,
      recipients: entry.email.recipients,
      subject: entry.email.subject,
      body: entry.email.body,
      date: entry.email.date,
      direction: entry.status === "sent_recorded" ? "sent" : null,
      partial: entry.email.snippet,
    });
  }
  for (const item of page.items) {
    if (seen.has(item.providerMessageId)) continue;
    seen.add(item.providerMessageId);
    items.push({
      id: `crm:${item.id}`,
      sender: item.sender,
      recipients: item.recipients,
      subject: item.subject,
      body: item.body ?? "",
      date: item.date,
      direction: item.direction,
      partial: item.partial,
    });
  }
  return items.sort((a, b) => Date.parse(b.date ?? "") - Date.parse(a.date ?? "") || 0);
}

/** Received after the latest sent message means the candidate replied. */
export function replyStatus(items: readonly { direction: Direction; date: string | null }[]) {
  const latest = (direction: Direction) =>
    Math.max(
      -Infinity,
      ...items
        .filter((item) => item.direction === direction)
        .map((item) => Date.parse(item.date ?? "") || 0),
    );
  const sent = latest("sent");
  const received = latest("received");
  if (received > -Infinity && received >= sent) return "replied" as const;
  if (sent > -Infinity) return "awaiting" as const;
  return null;
}

/** Stored email threads per role candidate, with full bodies and reply status. */
export function InboxTab({ onSelectEmail, ...props }: InboxProps) {
  const { t } = useLingui();
  const crm = useRoleCrm(props);
  const ready = crm.status === "ready" ? crm.target : null;
  const [candidateId, setCandidateId] = useState<string>();
  const [emailId, setEmailId] = useState<string>();
  const people = useCrmData(
    crm,
    "candidates",
    ready ? { crmRoleId: ready.crmRoleId, limit: 50 } : null,
    props,
  );
  const person =
    people.data?.items.find((item) => item.candidateId === candidateId) ?? people.data?.items[0];
  const mail = useCrmData(
    crm,
    "mail",
    ready && person
      ? { candidateId: person.candidateId, crmRoleId: ready.crmRoleId, limit: 50 }
      : null,
    props,
  );
  const items =
    mail.data && mail.data.candidateId === person?.candidateId ? mailItems(mail.data) : [];
  const selected = items.find((item) => item.id === emailId) ?? items[0];
  const status = replyStatus(items);
  useEffect(() => {
    if (!onSelectEmail) return;
    onSelectEmail(
      selected && person && ready && crm.status === "ready"
        ? {
            candidateId: person.candidateId,
            candidateName: person.name,
            candidateEmail: person.email,
            source: {
              serverId: ready.mcpServerId,
              serverRevision: ready.serverRevision,
              organizationId: ready.organizationId,
            },
            crmRoleId: ready.crmRoleId,
            email: selected,
          }
        : undefined,
    );
  }, [selected?.id, person?.candidateId, ready?.crmRoleId]);
  useEffect(() => () => onSelectEmail?.(undefined), []);
  return (
    <section aria-label={t`Inbox`}>
      <TabHeader title={<Trans>Inbox</Trans>} />
      <CrmGate crm={crm} />
      {people.loading ? <TabLoading /> : null}
      {people.failed ? (
        <TabNotice alert>
          <Trans>Could not load CRM records. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      {people.data && !people.data.items.length ? (
        <TabNotice>
          <Trans>No CRM contacts for this role yet.</Trans>
        </TabNotice>
      ) : null}
      {people.data?.items.length ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
          <ul
            aria-label={t`Candidates`}
            className="divide-y divide-border rounded-lg border border-border"
          >
            {people.data.items.map((item) => (
              <li key={item.candidateId}>
                <button
                  type="button"
                  aria-pressed={person?.candidateId === item.candidateId}
                  className="block w-full p-3 text-start text-sm hover:bg-muted aria-pressed:bg-muted"
                  onClick={() => {
                    setCandidateId(item.candidateId);
                    setEmailId(undefined);
                  }}
                >
                  <strong className="block truncate">{item.name}</strong>
                  <small className="block truncate text-muted-foreground">
                    {statusText(item.outreachStatus)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          <section aria-label={t`Emails`} className="rounded-lg border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border p-3">
              <strong className="truncate text-sm">{person?.name}</strong>
              {status === "replied" ? (
                <Badge>
                  <Trans>Replied</Trans>
                </Badge>
              ) : status === "awaiting" ? (
                <Badge variant="outline">
                  <Trans>Awaiting reply</Trans>
                </Badge>
              ) : null}
            </div>
            {mail.loading ? (
              <div className="px-3">
                <TabLoading />
              </div>
            ) : null}
            {mail.failed ? (
              <div className="px-3">
                <TabNotice alert>
                  <Trans>Could not load CRM records. Try refreshing.</Trans>
                </TabNotice>
              </div>
            ) : null}
            {mail.data && !items.length ? (
              <div className="px-3">
                <TabNotice>
                  <Trans>No stored emails for this candidate.</Trans>
                </TabNotice>
              </div>
            ) : null}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected?.id === item.id}
                aria-label={item.subject || t`No subject`}
                className="block w-full border-b border-border p-3 text-start text-sm last:border-b-0 hover:bg-muted aria-pressed:bg-muted"
                onClick={() => setEmailId(item.id)}
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="truncate">{item.sender ?? t`Sender unavailable`}</strong>
                  {item.direction === "received" ? (
                    <small className="shrink-0">
                      <Trans>Received</Trans>
                    </small>
                  ) : item.direction === "sent" ? (
                    <small className="shrink-0 text-muted-foreground">
                      <Trans>Sent</Trans>
                    </small>
                  ) : null}
                </span>
                <span className="block truncate">{item.subject || t`No subject`}</span>
                {item.date ? (
                  <time className="text-xs text-muted-foreground" dateTime={item.date}>
                    {formatDate(item.date)}
                  </time>
                ) : null}
              </button>
            ))}
          </section>
          <section aria-label={t`Email content`} className="rounded-lg border border-border p-4">
            {selected ? (
              <article className="space-y-3">
                <h3 className="font-semibold">{selected.subject || t`No subject`}</h3>
                <p className="break-words text-sm text-muted-foreground">
                  {selected.sender ?? t`Sender unavailable`}
                  {selected.recipients.length ? <> → {selected.recipients.join(", ")}</> : null}
                  {selected.date ? <> · {formatDate(selected.date)}</> : null}
                </p>
                {selected.partial ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>Preview only. Ask for the complete message to read the full body.</Trans>
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-sm">
                  {selected.body || t`Message body unavailable`}
                </p>
              </article>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
