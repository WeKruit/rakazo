import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingAccountViewOutput, RecruitingRoleCandidate } from "@rakazo/contracts";
import { Badge, Button, Input } from "@rakazo/ui-web";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import type { EmailConversationItem } from "./EmailConversation";
import { EmailConversation } from "./EmailConversation";
import { ProfileImage } from "./ProfileImage";
import { initials, storedProfileFields } from "./profile";
import { RetryNotice } from "./RetryNotice";
import { formatDate, TabLoading } from "./shared";
import { emailThreadIdentity, useInboxReadState } from "./useInboxReadState";

type AccountItem = RecruitingAccountViewOutput["items"][number];
type Props = {
  roles: RecruitingAccountViewOutput["roles"];
  items: AccountItem[];
  spaceId?: string;
  pending: readonly string[];
  loadingMore?: string;
  onLoadMore: (roleId: string, cursor: string) => void;
  onRetry: () => void;
  onOpenRole: (roleId: string) => void;
  serverThreads?: readonly {
    person?: RecruitingRoleCandidate | null;
    key: string;
    roleId: string;
    emailId: string;
    sourceId: string;
    organizationId: string | null;
    mailbox: string | null;
    latestIncomingAt: string | null;
  }[];
  serverReadKey?: string;
  requestedThread?: string | null;
  query?: string;
  onQueryChange?: (value: string) => void;
  onFilterChange?: (value: string) => void;
  onOpenProfile?: (roleId: string, person: RecruitingRoleCandidate) => void;
};

/** CRM evidence must match its exact binding; native mail may match one explicit email. */
export function accountInboxPerson(
  item: AccountItem,
  email: NonNullable<AccountItem["correspondence"]>["emails"][number],
) {
  const people = item.candidates?.items ?? [];
  if (email.crm) {
    const target = item.workspace?.crmTarget?.target;
    if (
      !target ||
      target.mcpServerId !== email.sourceId ||
      target.organizationId !== email.crm.organizationId ||
      target.crmRoleId !== email.crm.crmRoleId ||
      target.serverRevision !== email.crm.serverRevision
    )
      return undefined;
    return people.find(
      (person) =>
        person.crm?.candidateId === email.crm?.candidateId &&
        person.crm?.serverId === email.sourceId &&
        person.crm?.organizationId === email.crm?.organizationId,
    );
  }
  if (email.candidateKey)
    return people.find((person) => person.autumn?.candidateKey === email.candidateKey);
  if (email.direction !== "received") return undefined;
  const address = (email.sender?.trim().match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? email.sender)
    ?.trim()
    .toLowerCase();
  const matches = address
    ? people.filter((person) => person.email?.trim().toLowerCase() === address)
    : [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** A list entry keeps its exact role/source/mailbox; missing provider threads stay single messages. */
export function accountInboxThreads(items: readonly AccountItem[]) {
  const rows = new Map<
    string,
    {
      key: string;
      roleId: string;
      emails: EmailConversationItem[];
      person?: RecruitingRoleCandidate;
      ambiguous?: boolean;
    }
  >();
  for (const item of items) {
    for (const email of item.correspondence?.emails ?? []) {
      const key = JSON.stringify([
        item.roleId,
        email.sourceId,
        email.crm?.organizationId,
        email.crm?.crmRoleId,
        email.crm?.candidateId,
        email.eaccount,
        email.campaignId,
        email.sourceId && email.eaccount && email.providerThreadId
          ? ["thread", email.providerThreadId]
          : ["message", email.id],
      ]);
      const row: NonNullable<ReturnType<typeof rows.get>> = rows.get(key) ?? {
        key,
        roleId: item.roleId,
        emails: [],
      };
      const person = accountInboxPerson(item, email);
      if (person && !row.ambiguous) {
        if (row.person && row.person.key !== person.key) {
          row.person = undefined;
          row.ambiguous = true;
        } else row.person = person;
      }
      const projected = {
        ...email,
        threadId: email.providerThreadId,
        organizationId: email.crm?.organizationId ?? null,
        crmRoleId: email.crm?.crmRoleId,
        candidateId: email.crm?.candidateId,
        direction: email.direction ?? email.crm?.direction ?? null,
        partial: email.snippet,
      };
      if (!row.emails.some((saved) => saved.id === projected.id)) row.emails.push(projected);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .filter((row) => row.emails.some((email) => email.direction !== "sent"))
    .map((row) => ({
      ...row,
      emails: row.emails.sort(
        (a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0),
      ),
    }))
    .sort(
      (a, b) =>
        (Date.parse(b.emails[0]?.date ?? "") || 0) - (Date.parse(a.emails[0]?.date ?? "") || 0),
    );
}

export function AccountInbox({
  roles,
  items,
  spaceId,
  pending,
  loadingMore,
  onLoadMore,
  onRetry,
  onOpenRole,
  onOpenProfile,
  serverThreads,
  serverReadKey,
  requestedThread,
  query,
  onQueryChange,
  onFilterChange,
}: Props) {
  const { t } = useLingui();
  const rows = accountInboxThreads(items);
  for (const row of rows) {
    const saved = serverThreads?.find(
      (thread) =>
        thread.roleId === row.roleId &&
        row.emails.some(
          (email) =>
            email.id === thread.emailId &&
            email.sourceId === thread.sourceId &&
            (email.organizationId ?? null) === thread.organizationId &&
            (email.eaccount ?? null) === thread.mailbox,
        ),
    );
    if (saved?.person) row.person = saved.person;
  }
  const [filter, setFilter] = useState("all");
  const [chosen, setChosen] = useState<string>();
  const [selectedEmail, setSelectedEmail] = useState<string>();
  const [mobileDetail, setMobileDetail] = useState(Boolean(requestedThread));
  const railTrigger = useRef<HTMLButtonElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  const requestedServerThread = serverThreads?.find((item) => item.key === requestedThread);
  const requestedRow =
    requestedServerThread &&
    rows.find(
      (item) =>
        item.roleId === requestedServerThread.roleId &&
        item.emails.some(
          (email) =>
            email.id === requestedServerThread.emailId &&
            email.sourceId === requestedServerThread.sourceId &&
            (email.organizationId ?? null) === requestedServerThread.organizationId &&
            (email.eaccount ?? null) === requestedServerThread.mailbox,
        ),
    );
  const selected = rows.find((row) => row.key === chosen) ?? requestedRow ?? rows[0];
  useEffect(() => {
    const row = requestedRow;
    if (row) {
      setChosen(row.key);
      setMobileDetail(true);
    }
  }, [requestedThread, requestedRow?.key]);
  useEffect(() => {
    if (selected && selected.key !== chosen) setChosen(selected.key);
  }, [selected?.key, chosen]);
  const serverThread = serverThreads?.find(
    (thread) =>
      thread.roleId === selected?.roleId &&
      selected?.emails.some(
        (email) =>
          email.id === thread.emailId &&
          email.sourceId === thread.sourceId &&
          (email.organizationId ?? null) === thread.organizationId &&
          (email.eaccount ?? null) === thread.mailbox,
      ),
  );
  const detailKey = JSON.stringify([
    spaceId,
    serverThread?.roleId,
    serverThread?.key,
    serverReadKey,
  ]);
  const activeDetail = useRef(detailKey);
  activeDetail.current = detailKey;
  const [detail, setDetail] = useState<{
    key: string;
    emails: EmailConversationItem[];
    nextCursor: string | null;
  }>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (serverThread && spaceId) {
      setDetailLoading(true);
      setDetailFailed(false);
      void rpc.recruiting
        .globalInbox({
          spaceId,
          thread: { roleId: serverThread.roleId, key: serverThread.key },
          limit: 50,
        })
        .then((page) => {
          if (active && activeDetail.current === detailKey)
            setDetail({
              key: detailKey,
              emails: page.items.map((row) => ({
                ...row.email,
                threadId: row.email.providerThreadId,
                organizationId: row.email.crm?.organizationId ?? null,
                crmRoleId: row.email.crm?.crmRoleId,
                direction: row.email.direction ?? row.email.crm?.direction ?? null,
                partial: row.email.snippet,
              })),
              nextCursor: page.nextCursor,
            });
        })
        .catch(() => {
          if (active) setDetailFailed(true);
        })
        .finally(() => {
          if (active) setDetailLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [detailKey]);
  const detailEmails = detail?.key === detailKey ? detail.emails : [];
  const conversationEmails = serverThreads ? detailEmails : (selected?.emails ?? []);
  const authoritativeThreads = serverThreads?.flatMap((thread) => {
    const email = rows
      .find(
        (row) =>
          row.roleId === thread.roleId &&
          row.emails.some(
            (email) =>
              email.id === thread.emailId &&
              email.sourceId === thread.sourceId &&
              (email.organizationId ?? null) === thread.organizationId &&
              (email.eaccount ?? null) === thread.mailbox,
          ),
      )
      ?.emails.find((email) => email.id === thread.emailId);
    const identity = email && emailThreadIdentity(email);
    return identity
      ? [
          {
            ...identity,
            latestIncomingAt:
              thread.latestIncomingAt && Date.parse(thread.latestIncomingAt) <= Date.now()
                ? thread.latestIncomingAt
                : null,
          },
        ]
      : [];
  });
  const readState = useInboxReadState(
    spaceId,
    [...rows.flatMap((row) => row.emails), ...detailEmails],
    authoritativeThreads,
  );
  const visible = rows.filter(
    (row) => filter === "all" || row.emails.some((email) => readState.unread(email) === true),
  );
  const email =
    conversationEmails.find((item) => item.id === selectedEmail) ??
    selected?.emails.find((item) => item.id === selectedEmail) ??
    conversationEmails.find((item) => item.id === selected?.emails[0]?.id) ??
    conversationEmails[0] ??
    selected?.emails[0];
  const roleTitle = (id: string) =>
    roles.find((role) => role.id === id)?.title ?? t`Role unavailable`;
  return (
    <div
      data-testid="account-inbox"
      className="grid min-w-0 grid-cols-1 overflow-hidden rounded-xl border bg-card lg:h-[calc(100dvh-11rem)] lg:grid-cols-[minmax(20rem,31.25rem)_minmax(0,1fr)]"
    >
      <section
        aria-label={t`Inbox conversations`}
        className={`${mobileDetail ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-col bg-muted/20 lg:border-r`}
      >
        <div className="flex h-16 shrink-0 items-center gap-1 border-b bg-card px-5">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={filter === "all"}
            onClick={() => {
              setFilter("all");
              onFilterChange?.("all");
            }}
          >
            <Trans>All</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={filter === "unread"}
            onClick={() => {
              setFilter("unread");
              onFilterChange?.("unread");
            }}
          >
            <Trans>Unread</Trans>
          </Button>
          {onQueryChange ? (
            <Input
              className="ml-2 min-w-0 flex-1"
              aria-label={t`Search saved mail`}
              placeholder={t`Search mail…`}
              value={query ?? ""}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          ) : null}
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <ul aria-label={t`Email threads`} className="space-y-2.5 p-5">
            {visible.map((row) => {
              const latest = row.emails[0]!;
              const incoming =
                row.emails.find((message) => message.direction === "received") ?? latest;
              const unread = row.emails.some((message) => readState.unread(message) === true);
              const person = row.person;
              const profile = person?.autumn?.savedProfile;
              const work =
                profile?.experience
                  .slice(0, 2)
                  .map((job) =>
                    [
                      job.title,
                      job.company_name,
                      [job.start_date, job.end_date].filter(Boolean).join(" – "),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ) ??
                storedProfileFields(person?.crm?.profile)
                  .find((field) => field.label === "Experience")
                  ?.timelineEntries?.slice(0, 2)
                  .map((job) =>
                    [job.primary, job.secondary, job.dateLabel].filter(Boolean).join(" · "),
                  ) ??
                [];
              const school = profile?.education[0];
              const ranking = person?.autumn?.ranking;
              const grade =
                ranking?.source === "reviewer" && ranking.state === "current"
                  ? ranking.group === "strong_match"
                    ? t`Strong Match`
                    : ranking.group === "worth_talking"
                      ? t`Worth Talking`
                      : ranking.grade
                  : null;
              const attachmentCount = row.emails.reduce(
                (count, message) => count + (message.attachments?.length ?? 0),
                0,
              );
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    aria-pressed={selected?.key === row.key}
                    aria-label={`${incoming.sender || t`Sender unavailable`} · ${roleTitle(row.roleId)} · ${latest.subject || t`No subject`}`}
                    className="flex w-full items-start gap-3 rounded-2xl border border-border bg-card p-4 text-start focus-visible:outline-2 focus-visible:outline-ring hover:border-primary/40 aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary"
                    onClick={(event) => {
                      railTrigger.current = event.currentTarget;
                      setChosen(row.key);
                      setSelectedEmail(latest.id);
                      setMobileDetail(true);
                      requestAnimationFrame(() => {
                        if (back.current?.getClientRects().length) back.current.focus();
                      });
                    }}
                  >
                    <ProfileImage
                      src={profile?.profileImageUrl}
                      fallback={initials(person?.name || incoming.sender || "")}
                      photo
                      className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <strong className="truncate text-sm" title={incoming.sender ?? undefined}>
                          {person?.name || incoming.sender || t`Sender unavailable`}
                        </strong>
                        {grade ? <Badge variant="outline">{grade}</Badge> : null}
                      </span>
                      {person?.title ? (
                        <span className="block truncate text-sm" title={person.title}>
                          {person.title}
                        </span>
                      ) : null}
                      {person?.location ? (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={person.location}
                        >
                          {person.location}
                        </span>
                      ) : null}
                      {work.length ? (
                        <span className="block space-y-1 border-l pl-2 text-xs text-muted-foreground">
                          {work.map((entry, index) => (
                            <span
                              key={`${index}:${entry}`}
                              className="line-clamp-1 block"
                              title={entry}
                            >
                              {entry}
                            </span>
                          ))}
                        </span>
                      ) : null}
                      {school?.school_name ? (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={[school.school_name, school.degree].filter(Boolean).join(" · ")}
                        >
                          {[school.school_name, school.degree].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={roleTitle(row.roleId)}
                      >
                        {roleTitle(row.roleId)}
                      </span>
                      <span
                        className="block truncate text-sm font-medium"
                        title={latest.subject ?? undefined}
                      >
                        {latest.subject || t`No subject`}
                      </span>
                      <span className="line-clamp-1 break-words text-xs text-muted-foreground">
                        {latest.body}
                      </span>
                      <span className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                        <span className="flex flex-wrap items-center gap-2">
                          {unread ? (
                            <Badge>
                              <Trans>Unread</Trans>
                            </Badge>
                          ) : incoming.direction === "received" ? (
                            <span>
                              <Trans>Received</Trans>
                            </span>
                          ) : null}
                          {latest.date && Number.isFinite(Date.parse(latest.date)) ? (
                            <time dateTime={latest.date}>{formatDate(latest.date)}</time>
                          ) : null}
                        </span>
                        {person?.crm?.resumeReceived || attachmentCount ? (
                          <span className="flex flex-wrap gap-1">
                            {person?.crm?.resumeReceived ? (
                              <Badge variant="secondary">
                                <Trans>Resume provided</Trans>
                              </Badge>
                            ) : null}
                            {attachmentCount ? (
                              <Badge variant="secondary">
                                <Trans>{attachmentCount} attachments</Trans>
                              </Badge>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                      {latest.eaccount ? (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={latest.eaccount}
                        >
                          {latest.eaccount}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!visible.length && rows.length ? (
            <p className="p-4 text-sm text-muted-foreground">
              <Trans>No unread conversations in loaded mail.</Trans>
            </p>
          ) : null}
          {!serverThreads &&
            items.map((item) => {
              const mail = item.correspondence;
              const replies =
                mail?.emails.filter(
                  (message) => (message.direction ?? message.crm?.direction) === "received",
                ) ?? [];
              const uncertain =
                !["ready", "empty"].includes(mail?.status ?? "not_checked") ||
                mail?.emails.some((message) => !(message.direction ?? message.crm?.direction));
              const unknown = !replies.length && (uncertain || (mail?.partial && !mail.nextCursor));
              const incomplete = uncertain || mail?.partial || mail?.nextCursor;
              return (
                <div
                  key={item.roleId}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-3 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 truncate" title={roleTitle(item.roleId)}>
                    {roleTitle(item.roleId)}
                  </span>
                  {unknown ? (
                    <RetryNotice onRetry={onRetry}>
                      <Trans>Could not load replies.</Trans>
                    </RetryNotice>
                  ) : (
                    <span>
                      {!replies.length && !incomplete ? (
                        <Trans>No replies yet.</Trans>
                      ) : (
                        t`${replies.length}${incomplete ? "+" : ""} replies`
                      )}
                    </span>
                  )}
                  {mail?.nextCursor ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!loadingMore}
                      onClick={() => onLoadMore(item.roleId, mail.nextCursor!)}
                    >
                      <Trans>Load more</Trans>
                    </Button>
                  ) : null}
                </div>
              );
            })}
          {pending.length ? (
            <div aria-busy="true" className="p-4">
              <TabLoading />
            </div>
          ) : null}
        </div>
      </section>
      <div
        className={`${mobileDetail ? "block" : "hidden lg:block"} min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-muted/20`}
      >
        <Button
          ref={back}
          size="sm"
          variant="ghost"
          className="m-3 lg:hidden"
          onClick={() => {
            setMobileDetail(false);
            requestAnimationFrame(() => railTrigger.current?.focus());
          }}
        >
          <ArrowLeft size={14} aria-hidden />
          <Trans>Back to inbox</Trans>
        </Button>
        {selected && email ? (
          <>
            <div className="flex min-h-16 flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-3 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">
                {roleTitle(selected.roleId)}
                {email.eaccount ? ` · ${email.eaccount}` : ""}
              </span>
              {roles.find((role) => role.id === selected.roleId)?.groupId ? (
                <Button size="sm" variant="ghost" onClick={() => onOpenRole(selected.roleId)}>
                  <Trans>Open role</Trans>
                  <ArrowUpRight size={14} aria-hidden />
                </Button>
              ) : null}
            </div>
            <div className="p-3 md:p-4">
              <h2 className="sr-only">
                <Trans>Selected conversation</Trans>
              </h2>
              {detailLoading ? <TabLoading /> : null}
              {detailFailed ? (
                <p role="alert" className="text-sm text-destructive">
                  <Trans>Could not load this conversation. Refresh to retry.</Trans>
                </p>
              ) : null}
              {(!serverThreads || conversationEmails.length > 0) && !detailFailed ? (
                <EmailConversation
                  key={selected.key}
                  artifactTarget={
                    roles.find((role) => role.id === selected.roleId)?.groupId
                      ? { groupId: roles.find((role) => role.id === selected.roleId)!.groupId! }
                      : undefined
                  }
                  items={conversationEmails}
                  selectedId={email.id}
                  candidateName={
                    selected.person?.name ||
                    (selected.emails.find((message) => message.direction === "received") ?? email)
                      .sender
                  }
                  candidateTitle={selected.person?.title}
                  candidatePhotoUrl={selected.person?.autumn?.savedProfile?.profileImageUrl}
                  onOpenProfile={
                    selected.person &&
                    onOpenProfile &&
                    roles.find((role) => role.id === selected.roleId)?.groupId
                      ? () => onOpenProfile(selected.roleId, selected.person!)
                      : undefined
                  }
                  onSelect={(message) => setSelectedEmail(message.id)}
                  readState={readState}
                />
              ) : null}
              {serverThread && detail?.key === detailKey && detail.nextCursor ? (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={detailLoading}
                  onClick={() => {
                    if (!spaceId) return;
                    setDetailLoading(true);
                    void rpc.recruiting
                      .globalInbox({
                        spaceId,
                        thread: { roleId: serverThread.roleId, key: serverThread.key },
                        cursor: detail.nextCursor!,
                        limit: 50,
                      })
                      .then((page) => {
                        if (activeDetail.current === detailKey)
                          setDetail((current) =>
                            current?.key === detailKey
                              ? {
                                  key: detailKey,
                                  emails: [
                                    ...current.emails,
                                    ...page.items.map((row) => ({
                                      ...row.email,
                                      threadId: row.email.providerThreadId,
                                      organizationId: row.email.crm?.organizationId ?? null,
                                      direction:
                                        row.email.direction ?? row.email.crm?.direction ?? null,
                                      partial: row.email.snippet,
                                    })),
                                  ],
                                  nextCursor: page.nextCursor,
                                }
                              : current,
                          );
                      })
                      .catch(() => {
                        if (activeDetail.current === detailKey) setDetailFailed(true);
                      })
                      .finally(() => {
                        if (activeDetail.current === detailKey) setDetailLoading(false);
                      });
                  }}
                >
                  <Trans>Load earlier messages</Trans>
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="p-8 text-sm text-muted-foreground">
            <Trans>Select a conversation.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}
