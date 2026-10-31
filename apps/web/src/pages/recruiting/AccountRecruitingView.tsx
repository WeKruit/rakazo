import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, RecruitingRoleCampaign } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { isAccountRecruitingView } from "../../lib/recruiting-read-view";
import { rpc } from "../../lib/rpc";
import { InterviewCalendar } from "./InterviewCalendar";
import { RecruitingRoutines } from "./RecruitingRoutines";
import { RetryNotice } from "./RetryNotice";
import { formatDate, TabLoading } from "./shared";

type AccountPage = Awaited<ReturnType<typeof rpc.recruiting.accountView>>;

/** One account-scoped server read; changing a role never opens its conversation. */
export function AccountRecruitingView({
  accountKey,
  groups,
  bots,
  groupId,
  refreshSignal,
  onOpenNavigation,
  onOpenConnections,
  renderCorrespondence,
}: {
  accountKey: string;
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
  const role = params.get("role") || (groupId ? `group:${groupId}` : "all");
  const [read, setRead] = useState<{ key: string; data: AccountPage }>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<string>();
  const [taskError, setTaskError] = useState(false);
  const [reload, setReload] = useState(0);
  const pageKey = JSON.stringify([accountKey, view, role]);
  const [pagination, setPagination] = useState<{ key: string; cursor: string }>();
  const cursor = pagination?.key === pageKey ? pagination.cursor : undefined;
  const readKey = JSON.stringify([pageKey, cursor, reload, refreshSignal]);
  const page = read?.key === readKey ? read.data : undefined;
  useEffect(() => {
    if (view === "routines") return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void rpc.recruiting
      .accountView({
        view,
        ...(role.startsWith("group:")
          ? { groupId: role.slice(6) }
          : role !== "all"
            ? { roleId: role }
            : {}),
        cursor,
        limit: 20,
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
  }, [accountKey, view, role, cursor, reload, refreshSignal, readKey]);
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
                          ...(item.correspondence && update.correspondence
                            ? {
                                correspondence: {
                                  ...update.correspondence,
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
    title: role === "all" ? `${[...roles].join(" / ")} · ${event.title ?? ""}` : event.title,
  }));
  const calendarFailed = page?.items.some(
    (item) =>
      item.correspondence?.status === "failed" ||
      item.correspondence?.connections.some(
        (connection) => connection.checkIssue?.status === "failed",
      ),
  );
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
        <h1 className="flex-1 text-xl font-semibold">{titles[view]}</h1>
        {view !== "routines" ? (
          <NativeSelect
            aria-label={t`Role`}
            value={
              role.startsWith("group:")
                ? (page?.roles.find((item) => item.groupId === groupId)?.id ?? "all")
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
      {view === "routines" ? (
        <RecruitingRoutines accountKey={accountKey} groups={groups} bots={bots} groupId={groupId} />
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
          {page?.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No roles yet.</Trans>
            </p>
          ) : null}
          {view === "interview" && page ? (
            <>
              {!calendarConnected ? (
                <Button className="mb-4" variant="outline" onClick={onOpenConnections}>
                  <Trans>Connect calendar</Trans>
                </Button>
              ) : null}
              {calendarFailed ? (
                <RetryNotice onRetry={() => setReload((value) => value + 1)}>
                  <Trans>Could not load calendar records.</Trans>
                </RetryNotice>
              ) : null}
              <InterviewCalendar events={events} />
            </>
          ) : null}
          {view === "tasks" && page?.unassignedReminders?.items.length ? (
            <section
              aria-label={t`Tasks`}
              className="mb-6 space-y-3 rounded-xl border border-border p-4"
            >
              <h2 className="font-semibold">
                <Trans>Tasks</Trans>
              </h2>
              {page.unassignedReminders.items.map((reminder) => (
                <div key={reminder.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    {reminder.title}
                    <time className="block text-xs text-muted-foreground" dateTime={reminder.dueAt}>
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
            {(view === "interview" && !renderCorrespondence ? [] : (page?.items ?? [])).map(
              (item) => {
                const info = page?.roles.find((entry) => entry.id === item.roleId);
                const replies =
                  item.correspondence?.emails.filter(
                    (email) => (email.direction ?? email.crm?.direction) === "received",
                  ) ?? [];
                const repliesIncomplete = Boolean(
                  item.correspondence?.partial || item.correspondence?.nextCursor,
                );
                const repliesUnknown =
                  item.correspondence?.status === "failed" ||
                  (!replies.length &&
                    item.correspondence?.partial &&
                    !item.correspondence.nextCursor);
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
                    {view === "tasks" && !item.reminders?.items.length ? (
                      <p className="text-sm text-muted-foreground">
                        <Trans>No tasks yet.</Trans>
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
                        <p className="text-sm text-muted-foreground">{t`${item.candidates?.total ?? 0} people`}</p>
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
                              <h3 className="text-sm font-medium">{campaign.campaign?.name}</h3>
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
                    {view === "inbox" && !renderCorrespondence ? (
                      <>
                        {!repliesUnknown ? (
                          <p className="text-sm text-muted-foreground">{t`${repliesIncomplete ? `${replies.length}+` : replies.length} replies`}</p>
                        ) : null}
                        {repliesUnknown ? (
                          <RetryNotice onRetry={() => setReload((value) => value + 1)}>
                            <Trans>Could not load replies.</Trans>
                          </RetryNotice>
                        ) : !replies.length ? (
                          !repliesIncomplete ? (
                            <p className="text-sm text-muted-foreground">
                              <Trans>No replies yet.</Trans>
                            </p>
                          ) : null
                        ) : (
                          <ul className="divide-y divide-border">
                            {replies.map((email) => (
                              <li key={email.id} className="space-y-1 py-3 text-sm">
                                <strong>{email.subject}</strong>
                                <p>{email.sender}</p>
                                {email.date ? (
                                  <time dateTime={email.date}>{formatDate(email.date)}</time>
                                ) : null}
                                <p className="whitespace-pre-wrap">{email.body}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    ) : null}
                    {(view === "shortlist" || view === "contacts") &&
                    item.candidates?.nextCursor ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(loadingMore)}
                        onClick={() => void loadMore(item.roleId, item.candidates!.nextCursor!)}
                      >
                        <Trans>Load more</Trans>
                      </Button>
                    ) : null}
                    {view === "inbox" && item.correspondence?.nextCursor ? (
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
                        {item.reminders?.items.map((reminder) => (
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
              },
            )}
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
