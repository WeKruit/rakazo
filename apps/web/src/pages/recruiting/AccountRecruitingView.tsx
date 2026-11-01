import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, RecruitingRoleCampaign } from "@rakazo/contracts";
import { hideVendorNames } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { isAccountRecruitingView } from "../../lib/recruiting-read-view";
import { rpc } from "../../lib/rpc";
import { AccountInbox } from "./AccountInbox";
import { AllContacts } from "./AllContacts";
import { InterviewCalendar } from "./InterviewCalendar";
import { RecruitingRoutines } from "./RecruitingRoutines";
import { RetryNotice } from "./RetryNotice";
import { formatDate, TabLoading } from "./shared";

// Each role reads its own CRM, mail and calendar records, so a page shows a few roles at a time.
const ROLES_PER_PAGE = 5;
// The all-roles pages read each role on its own and show it when it arrives, so one role with a
// large CRM never holds back the others. The roles on one page read together.
const PER_ROLE_VIEWS = new Set(["sequence", "inbox", "interview"]);

type AccountPage = Awaited<ReturnType<typeof rpc.recruiting.accountView>>;

/** One account-scoped server read; changing a role never opens its conversation. */
export function AccountRecruitingView({
  accountKey,
  spaceId,
  groups,
  bots,
  groupId,
  refreshSignal,
  onOpenNavigation,
  onOpenConnections,
  renderCorrespondence,
}: {
  accountKey: string;
  spaceId?: string;
  groups: readonly Group[];
  bots: readonly Bot[];
  groupId?: string;
  refreshSignal: number;
  onOpenNavigation: () => void;
  onOpenConnections: () => void;
  renderCorrespondence?: (item: AccountPage["items"][number]) => ReactNode;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("view");
  const view = isAccountRecruitingView(requested) ? requested : "shortlist";
  const role = params.get("role") ?? "all";
  const scopedGroupId = params.has("role") ? undefined : groupId;
  // Every role's people in one list, filtered and paged by the server.
  const globalInbox = view === "inbox" && !renderCorrespondence;
  const [mailQuery, setMailQuery] = useState("");
  const [mailSearch, setMailSearch] = useState("");
  const [mailUnread, setMailUnread] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMailSearch(mailQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [mailQuery]);
  const [indexedMail, setIndexedMail] = useState<{
    key: string;
    data: Awaited<ReturnType<typeof rpc.recruiting.globalInbox>>;
  }>();
  const allContacts = view === "contacts" && role === "all" && !scopedGroupId;
  const [read, setRead] = useState<{ key: string; data: AccountPage }>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<string>();
  const [taskError, setTaskError] = useState(false);
  const [reload, setReload] = useState(0);
  const pageKey = JSON.stringify([
    accountKey,
    view,
    role,
    scopedGroupId,
    globalInbox ? [mailSearch, mailUnread] : null,
  ]);
  const [pagination, setPagination] = useState<{ key: string; cursor: string }>();
  const cursor = pagination?.key === pageKey ? pagination.cursor : undefined;
  const readKey = JSON.stringify([pageKey, cursor, reload, refreshSignal]);
  const page = read?.key === readKey ? read.data : undefined;
  const [pendingRoles, setPendingRoles] = useState<{ key: string; ids: string[] }>();
  const pending = pendingRoles?.key === readKey ? pendingRoles.ids : [];
  useEffect(() => {
    if (view === "routines" || allContacts) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    if (globalInbox) {
      if (!spaceId) {
        setLoading(false);
        setFailed(true);
        return;
      }
      void rpc.recruiting
        .globalInbox({
          spaceId,
          ...(role !== "all" ? { roleId: role } : {}),
          ...(mailSearch ? { query: mailSearch } : {}),
          unreadOnly: mailUnread,
          cursor,
          limit: 30,
        })
        .then((data) => {
          if (cancelled) return;
          const items: AccountPage["items"] = [];
          for (const entry of data.items) {
            let item = items.find((item) => item.roleId === entry.roleId);
            if (!item) {
              item = {
                roleId: entry.roleId,
                correspondence: {
                  roleId: entry.roleId,
                  status: "ready",
                  checkedAt: data.coverage.checkedAt,
                  connectionChanged: false,
                  connections: [],
                  emails: [],
                  events: [],
                  contacts: [],
                  partial: true,
                  nextCursor: null,
                },
              };
              items.push(item);
            }
            item.correspondence!.emails.push(entry.email);
            if (entry.person) {
              item.candidates ??= {
                items: [],
                nextCursor: null,
                total: 0,
                counts: { shortlisted: 0, replied: 0 },
                crmStatus: "ok",
                crmCountsComplete: false,
              };
              if (!item.candidates.items.some((person) => person.key === entry.person!.key))
                item.candidates.items.push(entry.person);
              item.candidates.total = item.candidates.items.length;
            }
          }
          setIndexedMail({ key: readKey, data });
          setRead({
            key: readKey,
            data: { roles: data.roles, items, nextCursor: data.nextCursor },
          });
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (PER_ROLE_VIEWS.has(view) && role === "all" && !scopedGroupId) {
      const abort = new AbortController();
      void (async () => {
        const list = await rpc.recruiting.accountView(
          { view: "roles", cursor, limit: ROLES_PER_PAGE },
          { signal: abort.signal },
        );
        if (cancelled) return;
        const order = list.items.map((item) => item.roleId);
        setRead({ key: readKey, data: { ...list, items: [] } });
        setPendingRoles({ key: readKey, ids: order });
        setLoading(false);
        let next = 0;
        await Promise.all(
          Array.from({ length: order.length }, async () => {
            while (next < order.length && !cancelled) {
              const roleId = order[next++]!;
              const result = await rpc.recruiting.accountView(
                { view, roleId, limit: 1 },
                { signal: abort.signal },
              );
              if (cancelled) return;
              const item = result.items[0];
              setRead((current) =>
                current?.key !== readKey || !item
                  ? current
                  : {
                      key: readKey,
                      data: {
                        ...current.data,
                        items: [...current.data.items, item].sort(
                          (a, b) => order.indexOf(a.roleId) - order.indexOf(b.roleId),
                        ),
                      },
                    },
              );
              setPendingRoles((current) =>
                current?.key !== readKey
                  ? current
                  : { key: readKey, ids: current.ids.filter((id) => id !== roleId) },
              );
            }
          }),
        );
      })().catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
          setPendingRoles(undefined);
        }
      });
      return () => {
        cancelled = true;
        abort.abort();
      };
    }
    void rpc.recruiting
      .accountView({
        view,
        ...(scopedGroupId ? { groupId: scopedGroupId } : role !== "all" ? { roleId: role } : {}),
        cursor,
        limit: ROLES_PER_PAGE,
      })
      .then((result) => {
        if (!cancelled) setRead({ key: readKey, data: result });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey, view, role, scopedGroupId, cursor, reload, refreshSignal, readKey, allContacts]);
  const loadMore = async (roleId: string, itemCursor: string) => {
    if (!page || view === "routines" || loadingMore) return;
    setLoadingMore(roleId);
    try {
      const next = await rpc.recruiting.accountView({ view, roleId, itemCursor, limit: 20 });
      const update = next.items[0];
      if (update)
        setRead((current) =>
          current?.key !== readKey
            ? current
            : {
                key: readKey,
                data: {
                  ...current.data,
                  items: current.data.items.map((item) =>
                    item.roleId !== roleId
                      ? item
                      : {
                          ...item,
                          ...update,
                          ...(item.candidates && update.candidates
                            ? {
                                candidates: {
                                  ...update.candidates,
                                  items: [...item.candidates.items, ...update.candidates.items],
                                },
                              }
                            : {}),
                          ...(item.feedback && update.feedback
                            ? {
                                feedback: {
                                  ...update.feedback,
                                  feedback: [
                                    ...new Map(
                                      [...item.feedback.feedback, ...update.feedback.feedback].map(
                                        (feedback) => [feedback.id, feedback],
                                      ),
                                    ).values(),
                                  ],
                                },
                              }
                            : {}),
                          ...(item.correspondence && update.correspondence
                            ? {
                                correspondence: {
                                  ...update.correspondence,
                                  events: [
                                    ...new Map(
                                      [
                                        ...item.correspondence.events,
                                        ...update.correspondence.events,
                                      ].map((event) => [event.id, event]),
                                    ).values(),
                                  ],
                                  emails: [
                                    ...item.correspondence.emails,
                                    ...update.correspondence.emails,
                                  ],
                                  contacts: [
                                    ...item.correspondence.contacts,
                                    ...update.correspondence.contacts,
                                  ],
                                },
                              }
                            : {}),
                        },
                  ),
                },
              },
        );
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(undefined);
    }
  };
  const loadMoreLeads = async (roleId: string, campaign: RecruitingRoleCampaign) => {
    if (
      !page ||
      !campaign.campaign ||
      !campaign.serverId ||
      !campaign.nextLeadCursor ||
      loadingMore
    )
      return;
    setLoadingMore(roleId);
    try {
      const next = await rpc.recruiting.accountView({
        view: "sequence",
        roleId,
        campaignId: campaign.campaign.id,
        campaignServerId: campaign.serverId,
        campaignLeadCursor: campaign.nextLeadCursor,
        limit: 20,
      });
      const update = next.items[0]?.campaigns?.[0];
      if (update)
        setRead((current) =>
          current?.key !== readKey
            ? current
            : {
                key: readKey,
                data: {
                  ...current.data,
                  items: current.data.items.map((item) =>
                    item.roleId !== roleId
                      ? item
                      : {
                          ...item,
                          campaigns: (item.campaigns ?? (item.campaign ? [item.campaign] : [])).map(
                            (saved) =>
                              saved.serverId === update.serverId &&
                              saved.campaign?.id === update.campaign?.id
                                ? {
                                    ...update,
                                    leads: [
                                      ...new Map(
                                        [...saved.leads, ...update.leads].map((lead) => [
                                          lead.email.toLowerCase(),
                                          lead,
                                        ]),
                                      ).values(),
                                    ],
                                  }
                                : saved,
                          ),
                        },
                  ),
                },
              },
        );
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(undefined);
    }
  };
  const calendarRows = new Map<
    string,
    {
      event: NonNullable<AccountPage["items"][number]["correspondence"]>["events"][number];
      roles: Set<string>;
    }
  >();
  for (const item of page?.items ?? []) {
    const title = page?.roles.find((entry) => entry.id === item.roleId)?.title;
    for (const event of item.correspondence?.events ?? []) {
      const row = calendarRows.get(event.id) ?? { event, roles: new Set<string>() };
      if (title) row.roles.add(title);
      calendarRows.set(event.id, row);
    }
  }
  const events = [...calendarRows.values()].map(({ event, roles }) => ({
    ...event,
    title:
      role === "all" && !scopedGroupId
        ? `${[...roles].join(" / ")} · ${event.title ?? ""}`
        : event.title,
  }));
  const calendarFailed = page?.items.some((item) => {
    const correspondence = item.correspondence;
    const missing = correspondence?.connections.every(
      (connection) => connection.status === "needs_connection",
    );
    return (
      !missing &&
      (!["ready", "empty"].includes(correspondence?.status ?? "not_checked") ||
        (correspondence?.partial && !correspondence.nextCursor) ||
        correspondence?.connections.some(
          (connection) =>
            connection.checkIssue?.status === "failed" ||
            !["configured", "needs_connection"].includes(connection.status),
        ))
    );
  });
  // Name the calendars that could not be read, so the recruiter knows which one to fix.
  const failedCalendarList = [
    ...new Set(
      page?.items.flatMap(
        (item) =>
          item.correspondence?.connections
            .filter((connection) => connection.checkIssue?.status === "failed")
            .map((connection) => connection.name) ?? [],
      ) ?? [],
    ),
  ];
  const failedCalendars = failedCalendarList.join(", ");
  const calendarConnected = page?.items.some((item) =>
    item.correspondence?.connections.some((connection) => connection.status !== "needs_connection"),
  );
  const titles = {
    brief: t`Job Brief`,
    feedback: t`Client feedback`,
    shortlist: t`Shortlist`,
    contacts: t`Contacts`,
    sequence: t`Sequence`,
    inbox: t`Inbox`,
    interview: t`Interview`,
    tasks: t`Tasks`,
    routines: t`Routines`,
  };
  const workView = view === "tasks" || view === "routines";
  const globalChat = groups.find((group) => group.id.startsWith("recruiting-global-"));
  const candidateView = view === "contacts" || view === "shortlist";
  const viewLink = (nextView: string) => {
    const next = new URLSearchParams(params);
    next.set("view", nextView);
    return { search: `?${next}` };
  };
  const Page = renderCorrespondence ? "section" : "main";
  return (
    <Page
      className={`recruiting-workspace-main rk-scroll min-w-0 flex-1 overflow-y-auto p-4 md:p-8 ${view === "contacts" ? "hire-contacts-view" : ""}`}
      data-testid="account-recruiting-view"
    >
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t`Show navigation`}
          onClick={onOpenNavigation}
        >
          <PanelLeftOpen size={18} />
        </Button>
        <h1 className="flex-1 text-xl font-semibold">
          {candidateView ? <Trans>Candidates</Trans> : titles[view]}
        </h1>
        {view !== "routines" && !allContacts ? (
          <NativeSelect
            aria-label={t`Role`}
            value={
              scopedGroupId
                ? (page?.roles.find((item) => item.groupId === scopedGroupId)?.id ?? "all")
                : role
            }
            onChange={(event) => {
              const next = new URLSearchParams(params);
              next.set("role", event.target.value);
              setParams(next);
            }}
          >
            <NativeSelectOption value="all">{t`All roles`}</NativeSelectOption>
            {(page?.roles ?? []).map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
      </header>
      {candidateView || workView || role !== "all" || scopedGroupId ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {candidateView ? (
            <nav aria-label={t`Candidate views`} className="flex gap-1">
              <Button
                size="sm"
                variant={view === "contacts" ? "secondary" : "ghost"}
                nativeButton={false}
                role="link"
                render={
                  <Link
                    to={viewLink("contacts")}
                    aria-current={view === "contacts" ? "page" : undefined}
                  />
                }
              >
                <Trans>Contacts</Trans>
              </Button>
              <Button
                size="sm"
                variant={view === "shortlist" ? "secondary" : "ghost"}
                nativeButton={false}
                role="link"
                render={
                  <Link
                    to={viewLink("shortlist")}
                    aria-current={view === "shortlist" ? "page" : undefined}
                  />
                }
              >
                <Trans>Shortlist</Trans>
              </Button>
            </nav>
          ) : workView ? (
            <nav aria-label={t`Work`} className="flex gap-1">
              {globalChat ? (
                <Button
                  size="sm"
                  variant="ghost"
                  nativeButton={false}
                  role="link"
                  render={
                    <Link to={`/app/g/${encodeURIComponent(globalChat.id)}?view=conversation`} />
                  }
                >
                  <Trans>Chat</Trans>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={view === "tasks" ? "secondary" : "ghost"}
                nativeButton={false}
                role="link"
                render={
                  <Link
                    to={viewLink("tasks")}
                    aria-current={view === "tasks" ? "page" : undefined}
                  />
                }
              >
                <Trans>Tasks</Trans>
              </Button>
              <Button
                size="sm"
                variant={view === "routines" ? "secondary" : "ghost"}
                nativeButton={false}
                role="link"
                render={
                  <Link
                    to={viewLink("routines")}
                    aria-current={view === "routines" ? "page" : undefined}
                  />
                }
              >
                <Trans>Routines</Trans>
              </Button>
            </nav>
          ) : (
            <span />
          )}
          {role !== "all" || scopedGroupId ? (
            <nav aria-label={t`Role context`} className="flex gap-1">
              {!candidateView ? (
                <Button
                  size="sm"
                  variant="ghost"
                  nativeButton={false}
                  role="link"
                  render={<Link to={viewLink("contacts")} />}
                >
                  <Trans>Candidates</Trans>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                nativeButton={false}
                role="link"
                render={
                  <Link
                    to={viewLink("brief")}
                    aria-current={view === "brief" ? "page" : undefined}
                  />
                }
              >
                <Trans>Job brief</Trans>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                nativeButton={false}
                role="link"
                render={
                  <Link
                    to={viewLink("feedback")}
                    aria-current={view === "feedback" ? "page" : undefined}
                  />
                }
              >
                <Trans>Client feedback</Trans>
              </Button>
            </nav>
          ) : null}
        </div>
      ) : null}
      {view === "routines" ? (
        <RecruitingRoutines accountKey={accountKey} groups={groups} bots={bots} />
      ) : allContacts ? (
        <AllContacts spaceId={spaceId} groups={groups} refreshSignal={refreshSignal} />
      ) : (
        <>
          {loading ? <TabLoading /> : null}
          {taskError ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Could not save the reminder.</Trans>
            </p>
          ) : null}
          {failed ? (
            <RetryNotice onRetry={() => setReload((value) => value + 1)}>
              <Trans>Could not load recruiting records.</Trans>
            </RetryNotice>
          ) : null}
          {!globalInbox &&
          page?.items.length === 0 &&
          !pending.length &&
          !page.unassignedReminders?.items.some((reminder) => reminder.status === "open") ? (
            <p className="text-sm text-muted-foreground">
              {view === "tasks" ? <Trans>No open tasks.</Trans> : <Trans>No roles yet.</Trans>}
            </p>
          ) : null}
          {view === "interview" && page ? (
            <>
              {!calendarConnected && !calendarFailed && !pending.length ? (
                <Button className="mb-4" variant="outline" onClick={onOpenConnections}>
                  <Trans>Connect calendar</Trans>
                </Button>
              ) : null}
              {calendarFailed ? (
                <RetryNotice onRetry={() => setReload((value) => value + 1)}>
                  {failedCalendarList.length ? (
                    <Trans>Could not read {failedCalendars}.</Trans>
                  ) : (
                    <Trans>Could not load calendar records.</Trans>
                  )}
                </RetryNotice>
              ) : null}
              {/* One calendar failing still shows what the other calendars returned. */}
              {(calendarConnected || events.length > 0) &&
              (!calendarFailed || events.length > 0 || failedCalendarList.length > 0) ? (
                <InterviewCalendar events={events} />
              ) : null}
              {!renderCorrespondence
                ? page.items
                    .filter((item) => item.correspondence?.nextCursor)
                    .map((item) => (
                      <div key={item.roleId} className="mt-3 flex items-center gap-3 text-sm">
                        <span>{page.roles.find((entry) => entry.id === item.roleId)?.title}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(loadingMore)}
                          onClick={() =>
                            void loadMore(item.roleId, item.correspondence!.nextCursor!)
                          }
                        >
                          <Trans>Load more</Trans>
                        </Button>
                      </div>
                    ))
                : null}
            </>
          ) : null}
          {view === "tasks" &&
          page?.unassignedReminders?.items.some((reminder) => reminder.status === "open") ? (
            <section
              aria-label={t`Tasks`}
              className="mb-6 space-y-3 rounded-xl border border-border p-4"
            >
              <h2 className="font-semibold">
                <Trans>Tasks</Trans>
              </h2>
              {page.unassignedReminders.items
                .filter((reminder) => reminder.status === "open")
                .map((reminder) => (
                  <div
                    key={reminder.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span>
                      {reminder.title}
                      <time
                        className="block text-xs text-muted-foreground"
                        dateTime={reminder.dueAt}
                      >
                        {formatDate(reminder.dueAt)}
                      </time>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void rpc.recruiting.reminders
                          .update({ id: reminder.id, status: "done" })
                          .then(() => {
                            setTaskError(false);
                            setReload((value) => value + 1);
                          })
                          .catch(() => setTaskError(true))
                      }
                    >
                      <Trans>Done</Trans>
                    </Button>
                  </div>
                ))}
            </section>
          ) : null}
          <div className="space-y-6">
            {view === "inbox" && !renderCorrespondence ? (
              <>
                {indexedMail?.key === readKey ? (
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      <Trans>Saved mail · partial source coverage</Trans>
                    </span>
                    {!indexedMail.data.coverage.importsComplete ||
                    !indexedMail.data.coverage.crmComplete ? (
                      <span role="status">
                        <Trans>Saved mail is indexing in the background.</Trans>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {indexedMail?.key === readKey &&
                !indexedMail.data.items.length &&
                indexedMail.data.coverage.importsComplete &&
                indexedMail.data.coverage.crmComplete ? (
                  <p className="mb-3 text-sm text-muted-foreground">
                    <Trans>No indexed mail matches this view.</Trans>
                  </p>
                ) : null}
                <AccountInbox
                  key={pageKey}
                  roles={page?.roles ?? []}
                  items={page?.items ?? []}
                  spaceId={spaceId}
                  serverThreads={
                    globalInbox && indexedMail?.key === readKey
                      ? indexedMail.data.items.map((row) => ({
                          key: row.key,
                          person: row.person,
                          roleId: row.roleId,
                          emailId: row.email.id,
                          sourceId: row.email.sourceId,
                          organizationId: row.email.crm?.organizationId ?? null,
                          mailbox: row.email.eaccount ?? null,
                          latestIncomingAt: row.latestIncomingAt,
                        }))
                      : undefined
                  }
                  serverReadKey={readKey}
                  query={mailQuery}
                  onQueryChange={setMailQuery}
                  onFilterChange={(value) => setMailUnread(value === "unread")}
                  pending={pending}
                  loadingMore={loadingMore}
                  onRetry={() => setReload((value) => value + 1)}
                  onLoadMore={(roleId, cursor) => void loadMore(roleId, cursor)}
                  onOpenProfile={(roleId, person) => {
                    const role = page?.roles.find((entry) => entry.id === roleId);
                    if (role?.groupId)
                      navigate(
                        `/app/g/${encodeURIComponent(role.groupId)}?${new URLSearchParams({ view: "contacts", detail: `contact.${person.crm?.candidateId ?? person.autumn?.candidateKey ?? person.key}` })}`,
                      );
                  }}
                  onOpenRole={(roleId) => {
                    const role = page?.roles.find((entry) => entry.id === roleId);
                    if (role?.groupId)
                      navigate(`/app/g/${encodeURIComponent(role.groupId)}?view=inbox`);
                  }}
                />
              </>
            ) : null}
            {((view === "interview" || view === "inbox") && !renderCorrespondence
              ? []
              : (page?.items ?? [])
            ).map((item) => {
              const info = page?.roles.find((entry) => entry.id === item.roleId);
              return (
                <section
                  key={item.roleId}
                  className="space-y-3 rounded-xl border border-border p-4"
                  aria-label={info?.title}
                >
                  <h2 className="font-semibold">{info?.title}</h2>
                  {view === "brief" ? (
                    <dl className="space-y-2">
                      {item.workspace?.revision.brief?.fields.map((field) => (
                        <div key={field.key}>
                          <dt className="text-sm text-muted-foreground">
                            {
                              (
                                {
                                  salary_range: t`Salary range`,
                                  location: t`Location`,
                                  company_deck: t`Company deck`,
                                } as Record<string, string>
                              )[field.key]
                            }
                          </dt>
                          <dd className="whitespace-pre-wrap text-sm">{field.value ?? "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {view === "feedback" && !item.feedback?.feedback.length ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No feedback yet.</Trans>
                    </p>
                  ) : null}
                  {view === "brief" && !item.workspace?.revision.brief?.fields.length ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No job brief yet.</Trans>
                    </p>
                  ) : null}
                  {view === "tasks" &&
                  !item.reminders?.items.some((reminder) => reminder.status === "open") ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No open tasks.</Trans>
                    </p>
                  ) : null}
                  {view === "feedback" ? (
                    <ul className="space-y-2">
                      {item.feedback?.feedback.map((feedback) => (
                        <li key={feedback.id} className="whitespace-pre-wrap text-sm">
                          {"summary" in feedback.feedback
                            ? feedback.feedback.summary
                            : feedback.feedback.intent.quote}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {view === "shortlist" || view === "contacts" ? (
                    <>
                      {item.candidates?.crmStatus === "unavailable" ? (
                        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
                          <Trans>Could not load recruiting records.</Trans>
                        </RetryNotice>
                      ) : (
                        <p className="text-sm text-muted-foreground">{t`${item.candidates?.total ?? 0} people`}</p>
                      )}
                      <ul className="divide-y divide-border">
                        {item.candidates?.items.map((candidate) => (
                          <li
                            key={candidate.key}
                            className="flex flex-wrap justify-between gap-2 py-3 text-sm"
                          >
                            <span>
                              {info?.groupId ? (
                                <button
                                  type="button"
                                  className="block text-start font-semibold underline-offset-2 hover:underline"
                                  onClick={() =>
                                    navigate(
                                      `/app/g/${encodeURIComponent(info.groupId!)}?${new URLSearchParams({ view: "contacts", detail: `contact.${candidate.crm?.candidateId ?? candidate.autumn?.candidateKey ?? candidate.key}` })}`,
                                    )
                                  }
                                >
                                  {candidate.name}
                                </button>
                              ) : (
                                <strong className="block">{candidate.name}</strong>
                              )}
                              <span className="text-muted-foreground">{candidate.title}</span>
                            </span>
                            <span>{candidate.email}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {view === "sequence" ? (
                    <>
                      {(item.campaigns ?? (item.campaign?.campaign ? [item.campaign] : []))
                        .length ? (
                        (item.campaigns ?? [item.campaign!]).map((campaign) => (
                          <div key={campaign.campaign?.id} className="space-y-2">
                            <h3 className="text-sm font-medium">
                              {campaign.campaign?.name
                                ? hideVendorNames(campaign.campaign.name)
                                : null}
                            </h3>
                            {campaign.status === "unavailable" ? (
                              <RetryNotice onRetry={() => setReload((value) => value + 1)}>
                                <Trans>Could not read this campaign.</Trans>
                              </RetryNotice>
                            ) : null}
                            <dl className="flex flex-wrap gap-4 text-sm">
                              <div>
                                <dt className="text-muted-foreground">
                                  <Trans>Sent</Trans>
                                </dt>
                                <dd>{campaign.stats?.sent ?? "—"}</dd>
                              </div>
                              <div>
                                <dt className="text-muted-foreground">
                                  <Trans>Opened</Trans>
                                </dt>
                                <dd>{campaign.stats?.opened ?? "—"}</dd>
                              </div>
                              <div>
                                <dt className="text-muted-foreground">
                                  <Trans>Replied</Trans>
                                </dt>
                                <dd>{campaign.stats?.replied ?? "—"}</dd>
                              </div>
                            </dl>
                            <ul className="space-y-2 text-sm">
                              {campaign.leads.map((lead) => (
                                <li key={lead.email}>{lead.email}</li>
                              ))}
                            </ul>
                            {campaign.nextLeadCursor ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={Boolean(loadingMore)}
                                onClick={() => void loadMoreLeads(item.roleId, campaign)}
                              >
                                <Trans>Load more</Trans>
                              </Button>
                            ) : null}
                          </div>
                        ))
                      ) : item.campaign?.status === "unavailable" ? (
                        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
                          <Trans>Could not read this campaign.</Trans>
                        </RetryNotice>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          <Trans>No campaign yet.</Trans>
                        </p>
                      )}
                      {item.correspondence?.contacts.map((contact) => (
                        <p key={contact.candidateKey} className="text-sm">
                          {contact.emails.map((email) => email.address).join(", ")}
                        </p>
                      ))}
                    </>
                  ) : null}
                  {(view === "sequence" || view === "interview" || view === "inbox") &&
                  renderCorrespondence
                    ? renderCorrespondence(item)
                    : null}
                  {view === "feedback" && item.feedback?.nextCursor ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(loadingMore)}
                      onClick={() => void loadMore(item.roleId, item.feedback!.nextCursor!)}
                    >
                      <Trans>Load more</Trans>
                    </Button>
                  ) : null}
                  {(view === "shortlist" || view === "contacts") && item.candidates?.nextCursor ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(loadingMore)}
                      onClick={() => void loadMore(item.roleId, item.candidates!.nextCursor!)}
                    >
                      <Trans>Load more</Trans>
                    </Button>
                  ) : null}
                  {(view === "inbox" || view === "interview") && item.correspondence?.nextCursor ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(loadingMore)}
                      onClick={() => void loadMore(item.roleId, item.correspondence!.nextCursor!)}
                    >
                      <Trans>Load more</Trans>
                    </Button>
                  ) : null}
                  {view === "tasks" ? (
                    <ul className="divide-y divide-border">
                      {item.reminders?.items
                        .filter((reminder) => reminder.status === "open")
                        .map((reminder) => (
                          <li
                            key={reminder.id}
                            className="flex items-center justify-between gap-3 py-3 text-sm"
                          >
                            <span>
                              {reminder.title}
                              <time
                                className="block text-xs text-muted-foreground"
                                dateTime={reminder.dueAt}
                              >
                                {formatDate(reminder.dueAt)}
                              </time>
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void rpc.recruiting.reminders
                                  .update({ id: reminder.id, status: "done" })
                                  .then(() => {
                                    setTaskError(false);
                                    setReload((value) => value + 1);
                                  })
                                  .catch(() => setTaskError(true))
                              }
                            >
                              <Trans>Done</Trans>
                            </Button>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </section>
              );
            })}
            {view === "interview" && !renderCorrespondence && pending.length ? (
              // The calendar already shows the roles read so far; only the rest are loading.
              <div aria-busy="true">
                <TabLoading />
              </div>
            ) : null}
            {(view !== "interview" && view !== "inbox") || renderCorrespondence
              ? pending.map((roleId) => {
                  const title = page?.roles.find((entry) => entry.id === roleId)?.title;
                  return (
                    <section
                      key={roleId}
                      className="space-y-3 rounded-xl border border-border p-4"
                      aria-label={title}
                      aria-busy="true"
                    >
                      <h2 className="font-semibold">{title}</h2>
                      <TabLoading />
                    </section>
                  );
                })
              : null}
          </div>
          {page?.nextCursor ? (
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => setPagination({ key: pageKey, cursor: page.nextCursor! })}
            >
              <Trans>Next page</Trans>
            </Button>
          ) : null}
        </>
      )}
    </Page>
  );
}
