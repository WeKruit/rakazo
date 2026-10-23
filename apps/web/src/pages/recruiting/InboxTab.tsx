import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput } from "@rakazo/contracts";
import { useCallback, useEffect, useState } from "react";
import type { CrmReplyDraftContext } from "../RecruitingPanel";
import { useRecruitingChatContext } from "../shell/recruiting-chat-context";
import { useRecruitingDetail } from "./detail";
import type { EmailConversationItem } from "./EmailConversation";
import { EmailConversation } from "./EmailConversation";
import { ProfileImage } from "./ProfileImage";
import { initials } from "./profile";
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
  onDraftReply?: (email: RecruitingInboxEmail) => void;
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
  const select = useCallback(
    (next: RecruitingInboxEmail | undefined) => {
      if (next)
        chatContext.setSelectedContact({
          name: next.candidateName ?? next.candidateEmail ?? "",
          reference: next.candidateId,
        });
    },
    [chatContext],
  );
  return <InboxTab {...props} onSelectEmail={select} onDraftReply={onDraftReply} />;
}

export function InboxTab({
  onSelectEmail,
  onDraftReply,
  candidateId: lockedId,
  ...props
}: InboxProps) {
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
    : (findPerson(candidateId) ??
      (!candidateId && !roleWideSupported ? people.data?.items[0] : undefined));
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
  const nameOf = (id: string | undefined) => findPerson(id)?.name;
  const contextFor = (item: EmailConversationItem): RecruitingInboxEmail | undefined => {
    const id = roleWide ? item.candidateId : personId;
    const contact = roleWide ? findPerson(id) : person;
    return id && ready && crm.status === "ready"
      ? {
          candidateId: id,
          candidateName: contact?.name,
          candidateEmail: contact?.email,
          source: {
            serverId: ready.mcpServerId,
            serverRevision: ready.serverRevision,
            organizationId: ready.organizationId,
          },
          crmRoleId: ready.crmRoleId,
          email: item,
        }
      : undefined;
  };
  const selectedContext = selected ? contextFor(selected) : undefined;
  // Refreshes can replace the body or source revision without changing the message ID.
  const selectionKey = JSON.stringify(selectedContext);
  useEffect(() => {
    onSelectEmail?.(selectedContext);
  }, [selectionKey, onSelectEmail]);
  useEffect(() => () => onSelectEmail?.(undefined), [onSelectEmail]);
  const conversationItems = roleWide
    ? items.filter((item) => item.candidateId === selectedCandidateId)
    : items;
  return (
    <section aria-label={t`Inbox`}>
      {lockedId ? null : <TabHeader title={<Trans>Inbox</Trans>} />}
      <CrmGate crm={crm} />
      {people.loading ? <TabLoading /> : null}
      {people.failed ? (
        <TabNotice alert>
          <Trans>Could not load candidate records. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      {people.data && !people.data.items.length ? (
        <TabNotice>
          <Trans>No contacts for this role yet.</Trans>
        </TabNotice>
      ) : null}
      {people.data?.items.length ? (
        <div
          className={
            lockedId
              ? "grid min-w-0 grid-cols-1 gap-4"
              : "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,2fr)]"
          }
        >
          {!lockedId ? (
            <div className="min-w-0 space-y-4">
              <ul
                aria-label={t`Candidates`}
                className="divide-y divide-border overflow-hidden rounded-xl border bg-card"
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
                      <strong>
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
                      className="flex w-full items-start gap-3 p-3 text-start text-sm hover:bg-muted aria-pressed:bg-muted"
                      onClick={() => {
                        setCandidateId(item.candidateId);
                        setEmailId(undefined);
                      }}
                    >
                      <ProfileImage
                        fallback={initials(item.name)}
                        photo
                        className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground"
                      />
                      <span className="min-w-0 space-y-1">
                        <strong className="block break-words">{item.name}</strong>
                        {item.title ? (
                          <span className="block break-words text-xs">{item.title}</span>
                        ) : null}
                        {item.outreachStatus ? (
                          <span className="block break-words text-xs text-muted-foreground">
                            {statusText(item.outreachStatus)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
                {people.hasMore ? (
                  <li className="px-3 pb-3">
                    <LoadMore pages={people} />
                  </li>
                ) : null}
              </ul>
              {roleWide && items.length ? (
                <section
                  aria-label={t`Emails`}
                  className="overflow-hidden rounded-xl border bg-card"
                >
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected?.id === item.id}
                      aria-label={item.subject || t`No subject`}
                      className="block w-full border-b p-3 text-start text-sm last:border-b-0 hover:bg-muted aria-pressed:bg-muted"
                      onClick={() => setEmailId(item.id)}
                    >
                      <strong className="block break-words">
                        {nameOf(item.candidateId) ?? item.sender ?? t`Sender unavailable`}
                      </strong>
                      <span className="block break-words">{item.subject || t`No subject`}</span>
                      {item.date && Number.isFinite(Date.parse(item.date)) ? (
                        <time className="text-xs text-muted-foreground" dateTime={item.date}>
                          {formatDate(item.date)}
                        </time>
                      ) : null}
                    </button>
                  ))}
                </section>
              ) : null}
              {roleWide && roleMail.hasMore ? <LoadMore pages={roleMail} /> : null}
            </div>
          ) : null}
          <div className="min-w-0 space-y-3">
            {read.loading ? <TabLoading /> : null}
            {read.failed ? (
              <TabNotice alert>
                <Trans>Could not load candidate records. Try refreshing.</Trans>
              </TabNotice>
            ) : null}
            {read.data && !items.length && !(roleWide && !roleMail.data?.supported) ? (
              <TabNotice>
                {roleWide ? (
                  <Trans>No stored emails for this role.</Trans>
                ) : (
                  <Trans>No stored emails for this candidate.</Trans>
                )}
              </TabNotice>
            ) : null}
            {selected ? (
              <EmailConversation
                key={selectedCandidateId}
                items={conversationItems}
                candidateId={selectedCandidateId}
                selectedId={selected.id}
                candidateName={selectedPerson?.name}
                candidateTitle={selectedPerson?.title}
                onSelect={(email) => setEmailId(email.id)}
                onOpenProfile={
                  detail && selectedPerson
                    ? () =>
                        detail.open({
                          view: "contact",
                          person: selectedPerson,
                          role: {
                            roleId: props.roleId,
                            spaceId: props.spaceId,
                            conversation: props.conversation,
                          },
                        })
                    : undefined
                }
                onDraftReply={
                  onDraftReply && selectedContext
                    ? (email) => {
                        const context = contextFor(email);
                        if (context) onDraftReply(context);
                      }
                    : undefined
                }
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
