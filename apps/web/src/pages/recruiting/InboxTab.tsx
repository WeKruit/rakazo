import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput } from "@rakazo/contracts";
import { Badge, Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ArrowLeft, BriefcaseBusiness, MapPin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CrmReplyDraftContext } from "../RecruitingPanel";
import { useRecruitingChatContext } from "../shell/recruiting-chat-context";
import { useRecruitingDetail } from "./detail";
import type { EmailConversationItem } from "./EmailConversation";
import { EmailConversation } from "./EmailConversation";
import { ProfileImage } from "./ProfileImage";
import { initials, storedProfileFields } from "./profile";
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
    /** The provider email thread, distinct from the native chat thread. */
    threadId?: string | null;
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
  const crmThreads = new Map<string, Set<string>>();
  for (const item of page.items) {
    if (!item.threadId) continue;
    const ids = crmThreads.get(item.providerMessageId) ?? new Set<string>();
    ids.add(item.threadId);
    crmThreads.set(item.providerMessageId, ids);
  }
  // Native receipts carry the exact message the agent read or recorded; CRM mail fills the rest.
  for (const entry of page.nativeCorrespondence) {
    if (!entry.email || seen.has(entry.email.providerMessageId)) continue;
    seen.add(entry.email.providerMessageId);
    const threads = crmThreads.get(entry.email.providerMessageId);
    items.push({
      id: `native:${entry.email.id}`,
      // Exact provider-message identity may supply thread metadata missing from a native receipt.
      threadId: threads?.size === 1 ? [...threads][0] : undefined,
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
      threadId: item.threadId,
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
    threadId: item.threadId,
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
  const [query, setQuery] = useState("");
  const [outreachFilter, setOutreachFilter] = useState("all");
  const [mobileConversation, setMobileConversation] = useState(false);
  const railTrigger = useRef<HTMLButtonElement | null>(null);
  const backButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (mobileConversation) {
      if (backButton.current?.getClientRects().length) backButton.current.focus();
    } else railTrigger.current?.focus();
  }, [mobileConversation]);
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
  const roleItems = roleMail.data?.supported ? roleMailItems(roleMail.data) : [];
  const latestByCandidate = new Map<string, EmailConversationItem>();
  for (const item of roleItems) {
    if (!latestByCandidate.has(item.candidateId)) latestByCandidate.set(item.candidateId, item);
  }
  const rail = [
    ...new Set([
      ...roleItems.map((item) => item.candidateId),
      ...(people.data?.items.map((item) => item.candidateId) ?? []),
    ]),
  ].map((id) => {
    const contact = findPerson(id);
    const latest = !roleWide && id === personId ? items[0] : latestByCandidate.get(id);
    const experience = storedProfileFields(contact?.profile).find(
      (field) => field.label === "Experience",
    )?.value;
    return { id, contact, latest, experience };
  });
  const statuses = [...new Set(rail.flatMap((row) => row.contact?.outreachStatus || []))];
  const search = query.trim().toLocaleLowerCase();
  const visibleRail = rail.filter(({ contact, latest, experience }) => {
    if (outreachFilter !== "all" && contact?.outreachStatus !== outreachFilter.slice(7))
      return false;
    return (
      !search ||
      [
        contact?.name,
        contact?.title,
        contact?.company,
        contact?.location,
        experience,
        latest?.sender,
      ].some((value) => value?.toLocaleLowerCase().includes(search))
    );
  });
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
      {people.data && !people.data.items.length && !roleItems.length ? (
        <TabNotice>
          <Trans>No contacts for this role yet.</Trans>
        </TabNotice>
      ) : null}
      {rail.length || lockedId ? (
        <div
          className={
            lockedId
              ? "grid min-w-0 grid-cols-1 gap-4"
              : "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,2fr)]"
          }
        >
          {!lockedId ? (
            <section
              aria-label={t`Candidate conversations`}
              className={`${mobileConversation ? "hidden lg:block" : ""} min-w-0 overflow-hidden rounded-xl border bg-card`}
            >
              <div className="space-y-2 border-b p-3">
                <Input
                  aria-label={t`Search loaded candidates`}
                  placeholder={t`Search loaded candidates`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <NativeSelect
                  aria-label={t`Outreach status`}
                  value={outreachFilter}
                  onChange={(event) => setOutreachFilter(event.target.value)}
                  className="w-full"
                >
                  <NativeSelectOption value="all">
                    <Trans>All statuses</Trans>
                  </NativeSelectOption>
                  {statuses.map((status) => (
                    <NativeSelectOption key={status} value={`status:${status}`}>
                      {statusText(status)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <ul aria-label={t`Candidates`} className="divide-y divide-border">
                {visibleRail.map(({ id, contact, latest, experience }) => {
                  const name = contact?.name || contact?.email || t`Candidate details unavailable`;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-label={name}
                        aria-pressed={selectedCandidateId === id}
                        className="flex w-full items-start gap-3 p-4 text-start text-sm hover:bg-muted aria-pressed:bg-muted"
                        onClick={(event) => {
                          railTrigger.current = event.currentTarget;
                          const loaded = latestByCandidate.get(id);
                          setCandidateId(loaded ? undefined : id);
                          setEmailId(loaded?.id);
                          setMobileConversation(true);
                        }}
                      >
                        <ProfileImage
                          fallback={initials(contact?.name || "")}
                          photo
                          className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 space-y-2">
                          <span className="flex flex-wrap items-start justify-between gap-1.5">
                            <strong className="break-words">{name}</strong>
                            {contact?.outreachStatus ? (
                              <Badge
                                variant="outline"
                                className="max-w-full whitespace-normal break-words"
                              >
                                {statusText(contact.outreachStatus)}
                              </Badge>
                            ) : null}
                          </span>
                          {contact?.title || contact?.company ? (
                            <span className="block break-words text-sm">
                              {[contact.title, contact.company].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                          {contact?.location ? (
                            <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
                              <MapPin size={12} aria-hidden className="mt-0.5 shrink-0" />
                              <span className="min-w-0 break-words">{contact.location}</span>
                            </span>
                          ) : null}
                          {experience ? (
                            <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
                              <BriefcaseBusiness
                                size={12}
                                aria-hidden
                                className="mt-0.5 shrink-0"
                              />
                              <span className="line-clamp-2 min-w-0 break-words" title={experience}>
                                {experience}
                              </span>
                            </span>
                          ) : null}
                          {contact?.lastReplyAt &&
                          Number.isFinite(Date.parse(contact.lastReplyAt)) ? (
                            <span className="block text-xs text-muted-foreground">
                              <Trans>Last reply</Trans> ·{" "}
                              <time dateTime={contact.lastReplyAt}>
                                {formatDate(contact.lastReplyAt)}
                              </time>
                            </span>
                          ) : null}
                          {latest ? (
                            <span className="block border-t pt-2">
                              <span className="line-clamp-1 break-words text-xs">
                                {latest.subject || t`No subject`}
                              </span>
                              {latest.date && Number.isFinite(Date.parse(latest.date)) ? (
                                <time
                                  className="text-xs text-muted-foreground"
                                  dateTime={latest.date}
                                >
                                  {formatDate(latest.date)}
                                </time>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!visibleRail.length ? (
                <p className="p-4 text-sm text-muted-foreground">
                  <Trans>No loaded candidates match these filters.</Trans>
                </p>
              ) : null}
              {people.hasMore ? (
                <div className="border-t p-3">
                  <span className="text-xs text-muted-foreground">
                    <Trans>Candidates</Trans>
                  </span>
                  <LoadMore pages={people} />
                </div>
              ) : null}
              {roleMail.hasMore ? (
                <div className="border-t p-3">
                  <span className="text-xs text-muted-foreground">
                    <Trans>Emails</Trans>
                  </span>
                  <LoadMore pages={roleMail} />
                </div>
              ) : null}
            </section>
          ) : null}
          <div
            className={`${!lockedId && !mobileConversation ? "hidden lg:block" : ""} min-w-0 space-y-3`}
          >
            {!lockedId ? (
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden"
                ref={backButton}
                onClick={() => setMobileConversation(false)}
              >
                <ArrowLeft size={14} aria-hidden />
                <Trans>Back to inbox</Trans>
              </Button>
            ) : null}
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
