import { Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  NativeSelect,
  Skeleton,
} from "@rakazo/ui-web";
import { Check, ChevronRight, PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { retryTransientRead } from "../../lib/read-retry";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import { rpc } from "../../lib/rpc";
import type { FunnelStageKey, RoleSummary } from "./dashboard";
import {
  bucketByWeek,
  firstName,
  mapWithConcurrency,
  openTasks,
  outreachFunnel,
  readShortlistPages,
  recentRoles,
  roleSummary,
  weekStart,
} from "./dashboard";
import { RetryNotice } from "./RetryNotice";
import { useKeyedRead } from "./shared";

type Overview = { roles: RoleSummary[]; incompleteGroups: string[]; missingGroups: string[] };
type OverviewRead = { key: string; data?: Overview; failed?: boolean };

/** Every role's numbers, four roles at a time; cached in the Shell's display cache. */
function useOverview(
  groups: readonly Group[],
  cache: RecruitingReadCache | undefined,
  scope: string | undefined,
  refreshSignal: number,
) {
  const [retry, setRetry] = useState(0);
  const roles = groups.filter((group) => !group.archivedAt);
  const key = JSON.stringify([scope, roles.map((group) => group.id), refreshSignal, retry]);
  const slot = scope ? `${scope}:home` : undefined;
  const [read, setRead] = useState<OverviewRead>();
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const { signal } = abort;
    const epoch = cache?.epoch;
    setRead({ key });
    const optional = <T,>(load: () => Promise<T>) =>
      retryTransientRead(load, signal).catch(() => undefined);
    void mapWithConcurrency(roles, 4, async (group) => {
      try {
        const workspace = await retryTransientRead(
          () => rpc.recruiting.getWorkspace({ threadId: group.threadId }, { signal }),
          signal,
        );
        if (!workspace) return { groupId: group.id, summary: null, incomplete: false };
        const conversation = { groupId: group.id };
        const [shortlist, candidates, campaign] = await Promise.all([
          readShortlistPages((cursor) =>
            retryTransientRead(
              () =>
                rpc.recruiting.listCandidates(
                  {
                    roleId: workspace.role.id,
                    shortlisted: true,
                    sort: "recent",
                    limit: 200,
                    ...(cursor ? { cursor } : {}),
                  },
                  { signal },
                ),
              signal,
            ),
          ),
          optional(() =>
            rpc.recruiting.roleCandidates(
              { ...conversation, threadId: group.threadId, limit: 1 },
              { signal },
            ),
          ),
          optional(() => rpc.recruiting.roleCampaign(conversation, { signal })),
        ]);
        return {
          groupId: group.id,
          summary: roleSummary(
            group.id,
            workspace.role.id,
            shortlist,
            candidates ?? null,
            campaign ?? null,
          ),
          incomplete: !candidates || !campaign,
        };
      } catch {
        return { groupId: group.id, summary: null, incomplete: true, failed: true };
      }
    }).then((results) => {
      if (cancelled) return;
      if (cache && epoch !== cache.epoch) return setRead({ key, failed: true });
      if (results.length && results.every((result) => "failed" in result))
        return setRead({ key, failed: true });
      const data: Overview = {
        roles: results.flatMap((result) => (result.summary ? [result.summary] : [])),
        incompleteGroups: results
          .filter((result) => result.incomplete)
          .map((result) => result.groupId),
        missingGroups: results
          .filter((result) => "failed" in result)
          .map((result) => result.groupId),
      };
      rememberRecruitingRead(cache, slot, data, epoch);
      setRead({ key, data });
    });
    return () => {
      cancelled = true;
      abort.abort();
    };
    // The key is the read's identity.
  }, [key]);
  const current = read?.key === key ? read : undefined;
  const data =
    current?.data ??
    (!current?.failed && slot ? (cache?.entries.get(slot) as Overview | undefined) : undefined);
  return {
    data,
    loading: !data && !current?.failed,
    failed: Boolean(current?.failed),
    retry: () => setRetry((value) => value + 1),
  };
}

type DashboardDrilldown = {
  roleGroups: ReadonlyMap<string, Group>;
  onOpenRole: (groupId: string) => void;
};

function RoleBreakdown({
  items,
  roleGroups,
  onOpenRole,
}: DashboardDrilldown & {
  items: readonly { role: RoleSummary; count: number | null; partial?: boolean }[];
}) {
  const { t } = useLingui();
  return (
    <ul className="mt-3 space-y-1 border-t pt-2" aria-label={t`Projects`} aria-live="polite">
      {items.map(({ role, count, partial }) => {
        const group = roleGroups.get(role.roleId);
        return group ? (
          <li key={role.roleId}>
            <Button
              variant="ghost"
              className="h-auto w-full justify-between gap-3 px-2 py-2 text-start font-normal"
              onClick={() => onOpenRole(group.id)}
            >
              <span className="min-w-0 truncate">{group.name}</span>
              <span className="shrink-0 tabular-nums">
                {count === null ? "—" : `${partial ? "≥" : ""}${count}`}
              </span>
              <ChevronRight size={14} aria-hidden />
            </Button>
          </li>
        ) : null;
      })}
    </ul>
  );
}

function WeeklyShortlist({
  roles,
  ...drilldown
}: { roles: readonly RoleSummary[] } & DashboardDrilldown) {
  const { t } = useLingui();
  const [period, setPeriod] = useState(4);
  const [selected, setSelected] = useState<number>();
  const dates = roles.flatMap((role) => role.shortlistedDates);
  const weeks = bucketByWeek(dates, new Date(), period);
  const max = Math.max(1, ...weeks.map((week) => week.count));
  const recorded = weeks.reduce((sum, week) => sum + week.count, 0);
  const undated = dates.filter((date) => !date || !Number.isFinite(Date.parse(date))).length;
  const selectedWeek = weeks.find((week) => week.start.getTime() === selected);
  return (
    <section aria-label={t`Shortlisted profiles`} className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">
            <Trans>Shortlisted profiles</Trans>
          </h3>
          <p
            data-testid="weekly-shortlist-total"
            className="mt-1 text-3xl font-semibold tabular-nums"
          >
            {recorded}
          </p>
        </div>
        <NativeSelect
          aria-label={t`Shortlist period`}
          value={period}
          onChange={(event) => setPeriod(Number(event.target.value))}
        >
          {[4, 8, 12].map((count) => (
            <option key={count} value={count}>{t`Last ${count} weeks`}</option>
          ))}
        </NativeSelect>
      </div>
      <ol
        className="mt-4 grid h-44 items-end gap-2"
        style={{ gridTemplateColumns: `repeat(${period}, minmax(0, 1fr))` }}
      >
        {weeks.map((week, index) => {
          const label = week.start.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
          const showLabel = index % Math.ceil(period / 4) === 0 || index === weeks.length - 1;
          return (
            <li
              key={week.start.toISOString()}
              aria-label={t`Week of ${label}: ${week.count}`}
              className="flex h-full min-w-0 flex-col items-center justify-end gap-1"
            >
              <Button
                variant="ghost"
                className="flex h-full w-full flex-col items-center justify-end gap-1 rounded-md p-0 font-normal"
                aria-label={t`Inspect week of ${label}`}
                aria-pressed={selectedWeek === week}
                onClick={() =>
                  setSelected(selectedWeek === week ? undefined : week.start.getTime())
                }
              >
                <span className="text-xs tabular-nums">{week.count}</span>
                <span aria-hidden="true" className="flex h-32 w-full max-w-12 items-end">
                  <span
                    className="w-full rounded-t-md bg-primary"
                    style={{ height: `${(week.count / max) * 100}%`, minHeight: 2 }}
                  />
                </span>
                <span
                  title={label}
                  aria-hidden="true"
                  className={`w-max text-xs text-muted-foreground ${index === 0 ? "self-start" : index === weeks.length - 1 ? "self-end" : ""}`}
                >
                  {showLabel ? label : " "}
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
      {selectedWeek ? (
        <RoleBreakdown
          {...drilldown}
          items={roles.map((role) => ({
            role,
            count: role.shortlistedDates.filter((value) => {
              const time = value ? Date.parse(value) : Number.NaN;
              return (
                Number.isFinite(time) &&
                time <= Date.now() &&
                weekStart(new Date(time)).getTime() === selectedWeek.start.getTime()
              );
            }).length,
          }))}
        />
      ) : null}
      {undated ? (
        <p className="mt-3 text-xs text-muted-foreground">
          <Trans>{undated} without a recorded date</Trans>
        </p>
      ) : null}
    </section>
  );
}

function OutreachFunnel({
  roles,
  incomplete,
  ...drilldown
}: {
  roles: readonly RoleSummary[];
  incomplete: boolean;
} & DashboardDrilldown) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<FunnelStageKey>();
  const labels: Record<FunnelStageKey, string> = {
    shortlisted: t`Shortlisted`,
    contacted: t`Contacted`,
    replied: t`Replied`,
    interested: t`Interested`,
  };
  const stages = outreachFunnel(roles);
  const max = Math.max(1, ...stages.map((stage) => stage.count ?? 0));
  return (
    <section aria-label={t`Outreach funnel`} className="min-w-0">
      <h3 className="text-sm font-medium">
        <Trans>Outreach funnel</Trans>
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Current totals · all dates</Trans>
      </p>
      <ol className="mt-4 grid grid-cols-4 gap-2">
        {stages.map((stage) => {
          const partial = stage.count !== null && (stage.partial || incomplete);
          return (
            <li key={stage.key} className="flex min-w-0 flex-col gap-1">
              <Button
                variant="ghost"
                className="h-auto w-full flex-col items-stretch gap-1 rounded-md p-0 text-start whitespace-normal font-normal"
                aria-label={t`Inspect ${labels[stage.key]}`}
                aria-pressed={selected === stage.key}
                onClick={() => setSelected(selected === stage.key ? undefined : stage.key)}
              >
                <span className="break-words text-xs text-muted-foreground">
                  {labels[stage.key]}
                </span>
                <span className="text-lg font-semibold tabular-nums">
                  {stage.count === null ? "—" : `${partial ? "≥" : ""}${stage.count}`}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {stage.count === null ? (
                    <Trans>Unknown</Trans>
                  ) : partial ? (
                    <Trans>Partial data</Trans>
                  ) : (
                    " "
                  )}
                </span>
                <span aria-hidden="true" className="flex h-20 items-end rounded-md bg-muted">
                  <span
                    className="w-full rounded-md bg-primary"
                    style={{
                      height: `${((stage.count ?? 0) / max) * 100}%`,
                    }}
                  />
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
      {selected ? (
        <RoleBreakdown
          {...drilldown}
          items={roles.map((role) => ({
            role,
            count: role[selected],
            partial: selected === "interested" && role.interestedPartial,
          }))}
        />
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        <Trans>Send totals are not available from these records.</Trans>
      </p>
    </section>
  );
}

/** The signed-in recruiter's open reminders, with Done. */
function YourTasks({
  scope,
  refreshSignal,
  roleGroups,
  onOpenRole,
  project,
}: {
  scope: string | undefined;
  refreshSignal: number;
  /** Role id → its conversation and name, for reminders tied to a role. */
  roleGroups: ReadonlyMap<string, Group>;
  onOpenRole: (groupId: string) => void;
  project: string | null;
}) {
  const { t } = useLingui();
  const [reload, setReload] = useState(0);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState<string>();
  const [saveFailed, setSaveFailed] = useState(false);
  const read = useKeyedRead(JSON.stringify([scope, refreshSignal, reload]), () =>
    rpc.recruiting.reminders.list({ status: "open" }),
  );
  const tasks = openTasks(read.data?.items ?? [], new Date()).filter(
    ({ reminder }) =>
      !done.has(reminder.id) &&
      (!project || Boolean(reminder.roleId && roleGroups.get(reminder.roleId)?.id === project)),
  );
  async function complete(id: string) {
    setSaving(id);
    setSaveFailed(false);
    try {
      await rpc.recruiting.reminders.update({ id, status: "done" });
      setDone((current) => new Set(current).add(id));
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(undefined);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            <Trans>Your tasks</Trans>
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {read.failed ? (
          <div className="px-2">
            <RetryNotice onRetry={() => setReload((value) => value + 1)}>
              <Trans>Could not load your tasks.</Trans>
            </RetryNotice>
          </div>
        ) : read.loading ? (
          <div role="status" aria-label={t`Loading…`} className="space-y-2 px-2">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : tasks.length ? (
          <ul aria-label={t`Your tasks`}>
            {tasks.map(({ reminder, overdue }) => {
              const role = reminder.roleId ? roleGroups.get(reminder.roleId) : undefined;
              const due = new Date(reminder.dueAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              });
              return (
                <li key={reminder.id} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" dir="auto">
                      {reminder.title}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {overdue ? (
                        <Badge variant="destructive">
                          <Trans>Overdue</Trans>
                        </Badge>
                      ) : null}
                      <span>{due}</span>
                      {role ? (
                        <button
                          type="button"
                          className="truncate underline-offset-2 hover:underline"
                          dir="auto"
                          onClick={() => onOpenRole(role.id)}
                        >
                          {role.name}
                        </button>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving === reminder.id}
                    aria-label={t`Mark ${reminder.title} done`}
                    onClick={() => void complete(reminder.id)}
                  >
                    <Check size={15} aria-hidden="true" />
                    <Trans>Done</Trans>
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            <Trans>No open tasks.</Trans>
          </p>
        )}
        {saveFailed ? (
          <p role="alert" className="px-2 pt-2 text-xs text-destructive">
            <Trans>Could not update this task. Try again.</Trans>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OverviewSkeleton() {
  const { t } = useLingui();
  return (
    <div role="status" aria-label={t`Loading…`} className="grid gap-6 md:grid-cols-2">
      {[0, 1].map((item) => (
        <div key={item} className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-40 w-full" />
        </div>
      ))}
    </div>
  );
}

/** The recruiting Home: a greeting, shortlist and outreach numbers, and recent roles. */
export function HomeDashboard({
  userName,
  groups,
  readCache,
  readCacheScope,
  refreshSignal = 0,
  onOpenRole,
  onOpenNavigation,
  navigationCollapsed = false,
}: {
  userName?: string | null;
  groups: readonly Group[];
  readCache?: RecruitingReadCache;
  /** User and Space the cached overview belongs to. */
  readCacheScope?: string;
  refreshSignal?: number;
  onOpenRole: (groupId: string) => void;
  onOpenNavigation?: () => void;
  navigationCollapsed?: boolean;
}) {
  const { t } = useLingui();
  const overview = useOverview(groups, readCache, readCacheScope, refreshSignal);
  const [selection, setSelection] = useState<{ scope: string | undefined; id: string | null }>({
    scope: readCacheScope,
    id: null,
  });
  const activeGroups = groups.filter((group) => !group.archivedAt);
  const project =
    selection.scope === readCacheScope && activeGroups.some((group) => group.id === selection.id)
      ? selection.id
      : null;
  const selectedGroups = project
    ? activeGroups.filter((group) => group.id === project)
    : activeGroups;
  const selectedRoles = (overview.data?.roles ?? []).filter((role) =>
    selectedGroups.some((group) => group.id === role.groupId),
  );
  const incomplete =
    overview.data?.incompleteGroups.some((id) => !project || id === project) ?? false;
  const missing = overview.data?.missingGroups.some((id) => !project || id === project) ?? false;
  const recents = recentRoles(selectedGroups);
  const name = firstName(userName);
  const roleGroups = new Map(
    (overview.data?.roles ?? []).flatMap((role) => {
      const group = groups.find((item) => item.id === role.groupId);
      return group ? [[role.roleId, group] as const] : [];
    }),
  );
  return (
    <div className="rk-scroll min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
        <div className="flex flex-wrap items-center gap-2">
          {onOpenNavigation ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className={navigationCollapsed ? undefined : "md:hidden"}
              aria-label={t`Open navigation`}
              onClick={onOpenNavigation}
            >
              <PanelLeftOpen size={19} aria-hidden="true" />
            </Button>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight" dir="auto">
            {name ? <Trans>Hello, {name}</Trans> : <Trans>Hello</Trans>}
          </h1>
          <div className="ms-auto w-full min-w-0 sm:w-64">
            <NativeSelect
              aria-label={t`Project`}
              className="w-full"
              value={project ?? ""}
              onChange={(event) =>
                setSelection({ scope: readCacheScope, id: event.target.value || null })
              }
            >
              <option value="">
                <Trans>All projects</Trans>
              </option>
              {activeGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>
                <Trans>Overview</Trans>
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview.failed ? (
              <RetryNotice onRetry={overview.retry}>
                <Trans>Could not load your overview.</Trans>
              </RetryNotice>
            ) : !overview.data ? (
              <OverviewSkeleton />
            ) : selectedRoles.length === 0 ? (
              missing ? (
                <RetryNotice onRetry={overview.retry}>
                  <Trans>Could not load your overview.</Trans>
                </RetryNotice>
              ) : (
                <p className="py-6 text-sm text-muted-foreground">
                  <Trans>No saved overview for these projects.</Trans>
                </p>
              )
            ) : (
              <>
                <div className="grid gap-8 md:grid-cols-2">
                  <WeeklyShortlist
                    roles={selectedRoles}
                    roleGroups={roleGroups}
                    onOpenRole={onOpenRole}
                  />
                  <OutreachFunnel
                    roles={selectedRoles}
                    incomplete={missing}
                    roleGroups={roleGroups}
                    onOpenRole={onOpenRole}
                  />
                </div>
                {incomplete ? (
                  <RetryNotice onRetry={overview.retry}>
                    <Trans>Some roles could not be read.</Trans>
                  </RetryNotice>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  <Trans>Recents</Trans>
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-2">
              {recents.length ? (
                <ul aria-label={t`Recents`}>
                  {recents.map((group) => (
                    <li key={group.id}>
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-start gap-3 px-2 py-2 text-start font-normal"
                        onClick={() => onOpenRole(group.id)}
                      >
                        <span className="min-w-0 flex-1 truncate" dir="auto">
                          {group.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {new Date(group.updatedAt).toLocaleDateString()}
                        </span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 text-sm text-muted-foreground">
                  <Trans>No roles yet.</Trans>
                </p>
              )}
            </CardContent>
          </Card>
          <YourTasks
            key={readCacheScope}
            scope={readCacheScope}
            refreshSignal={refreshSignal}
            roleGroups={roleGroups}
            onOpenRole={onOpenRole}
            project={project}
          />
        </div>
      </div>
    </div>
  );
}
