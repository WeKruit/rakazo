import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput } from "@rakazo/contracts";
import { Badge, Button } from "@rakazo/ui-web";
import { useCallback, useEffect, useState } from "react";
import type { CrmReplyDraftContext } from "../RecruitingPanel";
import { useRecruitingChatContext } from "../shell/recruiting-chat-context";
import { useRecruitingDetail } from "./detail";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  LoadMore,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  useCrmData,
  useCrmPages,
  useRoleCrm,
} from "./shared";

type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
type RoleMailPage = Extract<RecruitingCrmDataOutput, { operation: "roleMail" }>;
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
  /** Shows only this candidate's thread (the detail panel), without the candidate list. */
  candidateId?: string;
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
function roleMailItems(page: RoleMailPage) {
  // The CRM returns the role's mail newest first; keep its order.
  return page.items.map((item) => ({
    id: `crm:${item.id}`,
    candidateId: item.candidateId,
    sender: item.sender,
    recipients: item.recipients,
    subject: item.subject,
    body: item.body ?? "",
    date: item.date,
    direction: item.direction,
    partial: item.partial,
  }));
}

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

/**
 * Stored email for the role: every candidate's mail in one read by default, or one candidate's
 * thread (with reply status) when selected. CRMs without the role-wide read fall back to per candidate.
 */
/**
 * Inbox with the reply-draft action, shared by the Inbox tab and the detail panel. The selected
 * email's candidate becomes the chat's selected contact, which the draft request is checked against.
 */
export function InboxWithReply({
  onDraftReply,
  ...props
}: Omit<InboxProps, "onSelectEmail"> & {
  onDraftReply?: (email: RecruitingInboxEmail) => void;
}) {
  const chatContext = useRecruitingChatContext();
  const [email, setEmail] = useState<RecruitingInboxEmail>();
  const select = useCallback(
    (next: RecruitingInboxEmail | undefined) => {
      setEmail(next);
      if (next)
        chatContext.setSelectedContact({
          name: next.candidateName ?? next.candidateEmail ?? "",
          reference: next.candidateId,
        });
    },
    [chatContext],
  );
  return (
    <>
      {onDraftReply && email ? (
        <Button variant="outline" className="mb-3" onClick={() => onDraftReply(email)}>
          <Trans>Draft reply</Trans>
        </Button>
      ) : null}
      <InboxTab {...props} onSelectEmail={select} />
    </>
  );
}

export function InboxTab({ onSelectEmail, candidateId: lockedId, ...props }: InboxProps) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const crm = useRoleCrm(props);
  const ready = crm.status === "ready" ? crm.target : null;
  const [chosenId, setCandidateId] = useState<string>();
  const candidateId = lockedId ?? chosenId;
  const [emailId, setEmailId] = useState<string>();
  const people = useCrmPages(
    crm,
    "candidates",
    ready ? { crmRoleId: ready.crmRoleId } : null,
    props,
  );
  const roleMail = useCrmPages(
    crm,
    "roleMail",
    ready ? { crmRoleId: ready.crmRoleId } : null,
    props,
  );
  const roleWideSupported = roleMail.data?.supported !== false;
  const roleWide = roleWideSupported && candidateId === undefined;
  const findPerson = (id: string | undefined) =>
    id === undefined ? undefined : people.data?.items.find((item) => item.candidateId === id);
  const person = roleWide
    ? undefined
    : (findPerson(candidateId) ?? (roleWideSupported ? undefined : people.data?.items[0]));
  const personId = lockedId ?? person?.candidateId;
  const mail = useCrmData(
    crm,
    "mail",
    ready && personId ? { candidateId: personId, crmRoleId: ready.crmRoleId, limit: 50 } : null,
    props,
  );
  const read = roleWide ? roleMail : mail;
  const items: (RecruitingInboxEmail["email"] & { candidateId?: string })[] = roleWide
    ? roleMail.data?.supported
      ? roleMailItems(roleMail.data)
      : []
    : mail.data && mail.data.candidateId === personId
      ? mailItems(mail.data)
      : [];
  const selected = items.find((item) => item.id === emailId) ?? items[0];
  const selectedPerson = roleWide ? findPerson(selected?.candidateId) : person;
  const selectedCandidateId = roleWide ? selected?.candidateId : personId;
  const status = roleWide ? null : replyStatus(items);
  const nameOf = (id: string | undefined) => findPerson(id)?.name;
  useEffect(() => {
    if (!onSelectEmail) return;
    onSelectEmail(
      selected && selectedCandidateId && ready && crm.status === "ready"
        ? {
            candidateId: selectedCandidateId,
            candidateName: selectedPerson?.name,
            candidateEmail: selectedPerson?.email,
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
  }, [selected?.id, selectedCandidateId, selectedPerson?.name, ready?.crmRoleId]);
  useEffect(() => () => onSelectEmail?.(undefined), []);
  return (
    <section aria-label={t`Inbox`}>
      {lockedId ? null : <TabHeader title={<Trans>Inbox</Trans>} />}
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
        <div
          className={
            lockedId
              ? "grid grid-cols-1 gap-4"
              : "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.6fr)]"
          }
        >
          <ul
            hidden={Boolean(lockedId)}
            aria-label={t`Candidates`}
            className="divide-y divide-border rounded-lg border border-border"
          >
            {roleWideSupported ? (
              <li>
                <button
                  type="button"
                  aria-pressed={roleWide}
                  className="block w-full p-3 text-start text-sm hover:bg-muted aria-pressed:bg-muted"
                  onClick={() => {
                    setCandidateId(undefined);
                    setEmailId(undefined);
                  }}
                >
                  <strong className="block truncate">
                    <Trans>All candidates</Trans>
                  </strong>
                </button>
              </li>
            ) : null}
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
                  <strong className="block truncate" title={item.name}>
                    {item.name}
                  </strong>
                  <small className="block truncate text-muted-foreground">
                    {statusText(item.outreachStatus)}
                  </small>
                </button>
              </li>
            ))}
            {people.hasMore ? (
              <li className="px-3 pb-3">
                <LoadMore pages={people} />
              </li>
            ) : null}
          </ul>
          <section aria-label={t`Emails`} className="rounded-lg border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border p-3">
              <strong className="truncate text-sm" title={roleWide ? undefined : person?.name}>
                {roleWide ? <Trans>All candidates</Trans> : person?.name}
              </strong>
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
            {read.loading ? (
              <div className="px-3">
                <TabLoading />
              </div>
            ) : null}
            {read.failed ? (
              <div className="px-3">
                <TabNotice alert>
                  <Trans>Could not load CRM records. Try refreshing.</Trans>
                </TabNotice>
              </div>
            ) : null}
            {read.data && !items.length && !(roleWide && !roleMail.data?.supported) ? (
              <div className="px-3">
                <TabNotice>
                  {roleWide ? (
                    <Trans>No stored emails for this role.</Trans>
                  ) : (
                    <Trans>No stored emails for this candidate.</Trans>
                  )}
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
                  <strong className="truncate" title={item.sender ?? undefined}>
                    {item.sender ?? t`Sender unavailable`}
                  </strong>
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
                {roleWide && nameOf(item.candidateId) ? (
                  <span
                    className="block truncate text-muted-foreground"
                    title={nameOf(item.candidateId)}
                  >
                    {nameOf(item.candidateId)}
                  </span>
                ) : null}
                <span className="block truncate" title={item.subject || undefined}>
                  {item.subject || t`No subject`}
                </span>
                {item.date ? (
                  <time className="text-xs text-muted-foreground" dateTime={item.date}>
                    {formatDate(item.date)}
                  </time>
                ) : null}
              </button>
            ))}
            {roleWide && roleMail.hasMore ? (
              <div className="px-3 pb-3">
                <LoadMore pages={roleMail} />
              </div>
            ) : null}
          </section>
          <section aria-label={t`Email content`} className="rounded-lg border border-border p-4">
            {selected ? (
              <article className="space-y-3">
                {detail && selectedPerson && !lockedId ? (
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    onClick={() =>
                      detail.open({
                        view: "thread",
                        person: selectedPerson,
                        role: {
                          roleId: props.roleId,
                          spaceId: props.spaceId,
                          conversation: props.conversation,
                        },
                      })
                    }
                  >
                    {selectedPerson.name}
                  </Button>
                ) : null}
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
