import { Trans, useLingui } from "@lingui/react/macro";
import type { Group, RecruitingCrmDataOutput } from "@rakazo/contracts";
import { Badge, Button, cn, Input, Skeleton } from "@rakazo/ui-web";
import {
  Bookmark,
  CalendarDays,
  FolderOpen,
  Inbox,
  MoreHorizontal,
  PanelLeft,
  PlusCircle,
  Search,
  Send,
  Sparkles,
  Users,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { retryTransientRead } from "../../lib/read-retry";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import { rpc } from "../../lib/rpc";
import type { ContextMenuPosition } from "../BotContextMenu";
import type { CrmBrowseSelection } from "../RecruitingPanel";

export type RecruitingWorkspaceView =
  | "conversation"
  | "results"
  | "brief"
  | "feedback"
  | "shortlist"
  | "contacts"
  | "sequence"
  | "inbox"
  | "interview"
  | "workflow";

/** Whether two CRM role reads belong to the same user and Space (scope is [user, Space, thread]). */
function sameAccount(previousKey: string, nextKey: string) {
  const account = (key: string) => {
    try {
      const [scope] = JSON.parse(key) as [unknown];
      if (typeof scope !== "string") return undefined;
      const [userId, spaceId] = JSON.parse(scope) as unknown[];
      return typeof userId === "string" && typeof spaceId === "string"
        ? JSON.stringify([userId, spaceId])
        : undefined;
    } catch {
      return undefined;
    }
  };
  const previous = account(previousKey);
  return previous !== undefined && previous === account(nextKey);
}

/** The supplied WeKruit /hire navigation over native recruiting conversations. */
export function RecruitingNavigation({
  groups,
  archivedGroups,
  archivedOpen,
  groupId,
  query,
  canOpenDashboard,
  canCreateRole,
  onQueryChange,
  view,
  onView,
  onCollapse,
  onOpenRole,
  onNewRole,
  canCreateRoleFrom,
  onNewRoleFrom,
  onRoleMenu,
  onToggleArchived,
  onRestoreRole,
  crmContext,
  crmSelection,
  onOpenCrmRole,
  loading = false,
  onPrefetchRole,
}: {
  /** The role list has not arrived yet. */
  loading?: boolean;
  /** Hover or focus on a role: start reading its conversation before the click. */
  onPrefetchRole?: (id: string) => void;
  crmContext?: {
    target: ArtifactTarget;
    scope: string;
    cache: RecruitingReadCache;
    refreshSignal?: number;
  };
  crmSelection?: CrmBrowseSelection;
  onOpenCrmRole?: (selection: CrmBrowseSelection, groupId?: string) => void;
  groups: Group[];
  archivedGroups: Group[];
  archivedOpen: boolean;
  groupId?: string;
  query: string;
  canOpenDashboard: boolean;
  canCreateRole: boolean;
  onQueryChange: (query: string) => void;
  view: RecruitingWorkspaceView;
  onView: (view: RecruitingWorkspaceView) => void;
  onCollapse: () => void;
  onOpenRole: (id: string) => void;
  onNewRole: () => void;
  canCreateRoleFrom: (id: string) => boolean;
  onNewRoleFrom: (id: string) => void;
  onRoleMenu: (id: string, anchor: HTMLButtonElement, position: ContextMenuPosition) => void;
  onToggleArchived: () => void;
  onRestoreRole: (id: string) => void;
}) {
  const { t } = useLingui();
  const [crmRetry, setCrmRetry] = useState(0);
  type CrmRole = Extract<RecruitingCrmDataOutput, { operation: "roles" }>["items"][number] & {
    selection: CrmBrowseSelection;
    organizationName: string;
  };
  const crmKey = JSON.stringify([
    crmContext?.scope,
    crmContext?.target,
    crmContext?.refreshSignal,
    crmRetry,
  ]);
  const [crm, setCrm] = useState<{
    key: string;
    roles: CrmRole[];
    loading?: boolean;
    /** Another conversation's list for the same account, shown until this one returns. */
    stale?: boolean;
    failed?: boolean;
    unavailable?: boolean;
  }>();
  useEffect(() => {
    if (!crmContext) return;
    let cancelled = false;
    const abort = new AbortController();
    const { cache, scope, target } = crmContext;
    const epoch = cache.epoch;
    // A sibling read that invalidated this scope in flight leaves a retryable failure, not a spinner.
    const invalidated = () => {
      if (cache.epoch === epoch) return false;
      setCrm({ key: crmKey, roles: [], failed: true });
      return true;
    };
    const cacheKey = `${scope}:crm:roles`;
    const cached = cache.entries.get(cacheKey) as CrmRole[] | undefined;
    setCrm((previous) => {
      const keepPrevious =
        !cached && previous && !previous.failed && sameAccount(previous.key, crmKey);
      return {
        key: crmKey,
        roles: cached ?? (keepPrevious ? previous.roles : []),
        stale: !cached && Boolean(keepPrevious),
        loading: true,
      };
    });
    void retryTransientRead(
      () => rpc.recruiting.crmData({ ...target, operation: "memberships" }),
      abort.signal,
    )
      .then(async (result) => {
        if (cancelled || invalidated()) return;
        if (result.operation !== "memberships") throw new Error("Unexpected CRM response");
        const lists = await Promise.all(
          result.sources.flatMap((source) =>
            source.status === "ready"
              ? source.memberships.map(async (membership) => {
                  const selection = {
                    serverId: source.serverId,
                    serverRevision: source.serverRevision,
                    organizationId: membership.organizationId,
                  };
                  const roles = await retryTransientRead(
                    () => rpc.recruiting.crmData({ ...target, ...selection, operation: "roles" }),
                    abort.signal,
                  );
                  if (
                    roles.operation !== "roles" ||
                    roles.source.serverId !== source.serverId ||
                    roles.source.serverRevision !== source.serverRevision ||
                    roles.source.organizationId !== membership.organizationId
                  )
                    throw new Error("CRM scope changed");
                  return roles.items.map((role) => ({
                    ...role,
                    selection: { ...selection, crmRoleId: role.crmRoleId },
                    organizationName: membership.name ?? source.name,
                  }));
                })
              : [],
          ),
        );
        if (cancelled || invalidated()) return;
        const roles = lists.flat();
        rememberRecruitingRead(cache, cacheKey, roles, epoch);
        setCrm({
          key: crmKey,
          roles,
          unavailable: result.sources.some((source) => source.status === "unavailable"),
        });
      })
      .catch(() => {
        if (!cancelled) setCrm({ key: crmKey, roles: [], failed: true });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [crmKey]);
  const currentCrm = crm?.key === crmKey ? crm : undefined;
  // Routing uses only this conversation's own (or cached) roles, never a stale placeholder.
  const routableCrmRoles = currentCrm?.stale ? [] : (currentCrm?.roles ?? []);
  // Roles waiting on the recruiter come first; the rest keep their order.
  const visibleGroups = groups
    .filter((group) => group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(Boolean(b.needsInput)) - Number(Boolean(a.needsInput)));
  const destinations = [
    { view: "shortlist", label: t`Shortlist`, Icon: Bookmark },
    { view: "contacts", label: t`Contacts`, Icon: Users },
    { view: "sequence", label: t`Sequence`, Icon: Send },
    { view: "inbox", label: t`Inbox`, Icon: Inbox },
    { view: "interview", label: t`Interview`, Icon: CalendarDays },
  ] as const;
  return (
    <div
      className="hire-navigation flex min-h-0 flex-1 flex-col"
      data-testid="recruiting-navigation"
    >
      <div className="hire-brand-row">
        <button
          type="button"
          className="hire-brand"
          aria-label={t`WeKruit home`}
          onClick={() => onView("results")}
        >
          <img className="hire-brand-logo" src="/wekruit-logo.png" alt="" aria-hidden="true" />
          <span className="text-start">
            WeKruit<span className="block text-xs font-normal tracking-normal">Headhunter</span>
          </span>
        </button>
        <button
          type="button"
          className="hire-sidebar-collapse"
          aria-label={t`Collapse navigation`}
          onClick={onCollapse}
        >
          <PanelLeft size={17} aria-hidden="true" />
        </button>
      </div>
      <nav aria-label={t`Recruiting workspace`} className="hire-nav">
        <Button variant="ghost" disabled={!canCreateRole} onClick={onNewRole}>
          <PlusCircle size={18} aria-hidden="true" />
          <Trans>New Role</Trans>
        </Button>
        <Button
          variant="ghost"
          aria-current={view === "brief" ? "page" : undefined}
          disabled={!canOpenDashboard}
          onClick={() => onView("brief")}
        >
          <FolderOpen size={18} aria-hidden="true" />
          <Trans>Job Brief</Trans>
        </Button>
        <Button
          variant="ghost"
          aria-current={view === "feedback" ? "page" : undefined}
          disabled={!canOpenDashboard}
          onClick={() => onView("feedback")}
        >
          <Sparkles size={18} aria-hidden="true" />
          <Trans>Client feedback</Trans>
        </Button>
        {destinations.map(({ view: target, label, Icon }) => (
          <Button
            key={target}
            variant="ghost"
            disabled={!canOpenDashboard}
            aria-current={view === target ? "page" : undefined}
            onClick={() => onView(target)}
          >
            <Icon size={18} aria-hidden="true" />
            {label}
          </Button>
        ))}
      </nav>
      <div className="hire-role-heading">
        <Trans>All roles</Trans>
      </div>
      <div className="relative mx-1 mb-2">
        <Search
          className="pointer-events-none absolute start-3 top-2 text-muted-foreground"
          size={15}
          aria-hidden="true"
        />
        <Input
          aria-label={t`Search roles`}
          placeholder={t`Search roles`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="h-8 rounded-lg border-sidebar-border bg-transparent ps-9 text-xs"
        />
      </div>
      <div className="rk-scroll min-h-0 flex-1 space-y-1 overflow-y-auto">
        {loading ? (
          <div role="status" aria-label={t`Loading roles…`} className="space-y-1 px-2.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex min-h-[39px] items-center gap-3">
                <Skeleton className="size-2 rounded-full" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : currentCrm?.loading && currentCrm.roles.length === 0 ? (
          <p role="status" className="px-3 text-xs text-muted-foreground">
            <Trans>Loading roles…</Trans>
          </p>
        ) : null}
        {currentCrm?.failed || currentCrm?.unavailable ? (
          <p role="alert" className="px-3 text-xs">
            <Trans>Could not read a CRM connection.</Trans>{" "}
            <button
              type="button"
              className="underline"
              onClick={() => setCrmRetry((value) => value + 1)}
            >
              <Trans>Try again</Trans>
            </button>
          </p>
        ) : null}
        <nav aria-label={t`Role conversations`} className="space-y-1">
          {visibleGroups.map((group) => (
            <div key={group.id} className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="hire-role-button h-auto min-h-[39px] min-w-0 flex-1 justify-start gap-3 rounded-[9px] px-2.5 py-2 text-start text-sm font-normal"
                aria-current={group.id === groupId && view === "results" ? "page" : undefined}
                onMouseEnter={() => onPrefetchRole?.(group.id)}
                onFocus={() => onPrefetchRole?.(group.id)}
                onClick={() => {
                  const role = routableCrmRoles.find(
                    (role) =>
                      group.crmRoleReference?.sourceId === role.selection.serverId &&
                      group.crmRoleReference.organizationId === role.selection.organizationId &&
                      group.crmRoleReference.crmRoleId === role.crmRoleId,
                  );
                  if (role) onOpenCrmRole?.(role.selection, group.id);
                  else onOpenRole(group.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onRoleMenu(group.id, event.currentTarget, { x: event.clientX, y: event.clientY });
                }}
              >
                <span className="size-2 shrink-0 rounded-full bg-link" aria-hidden="true" />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    (group.needsInput || group.unread) && "font-semibold",
                  )}
                  dir="auto"
                >
                  {group.name}
                </span>
                {group.needsInput ? (
                  <Badge variant="secondary" className="shrink-0">
                    <Trans>Needs input</Trans>
                  </Badge>
                ) : group.unread ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-link"
                    role="img"
                    aria-label={t`Unread`}
                  />
                ) : null}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Actions for ${group.name}`}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onRoleMenu(group.id, event.currentTarget, { x: bounds.left, y: bounds.bottom });
                }}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </Button>
            </div>
          ))}
          {currentCrm?.roles
            .filter(
              (role) =>
                !groups.some(
                  (group) =>
                    group.crmRoleReference?.sourceId === role.selection.serverId &&
                    group.crmRoleReference.organizationId === role.selection.organizationId &&
                    group.crmRoleReference.crmRoleId === role.crmRoleId,
                ) &&
                `${role.roleLabel} ${role.clientLabel}`
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase()),
            )
            .map((role) => (
              <div key={JSON.stringify(role.selection)} className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  className="hire-role-button h-auto min-h-[39px] min-w-0 flex-1 justify-start gap-3 rounded-[9px] px-2.5 py-2 text-start text-sm font-normal"
                  disabled={currentCrm.loading}
                  aria-current={
                    crmSelection?.serverId === role.selection.serverId &&
                    crmSelection.organizationId === role.selection.organizationId &&
                    crmSelection.crmRoleId === role.crmRoleId
                      ? "page"
                      : undefined
                  }
                  onClick={() => onOpenCrmRole?.(role.selection)}
                >
                  <span className="size-2 shrink-0 rounded-full bg-link" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {role.roleLabel} · {role.clientLabel}
                  </span>
                </Button>
              </div>
            ))}
        </nav>
        {archivedGroups.length > 0 ? (
          <div className="mt-3 border-t border-border pt-2">
            <Button
              variant="ghost"
              className="w-full justify-between text-muted-foreground"
              aria-label={t`Archived`}
              aria-expanded={archivedOpen}
              onClick={onToggleArchived}
            >
              <Trans>Archived</Trans>
              <span>{archivedGroups.length}</span>
            </Button>
            {archivedOpen
              ? archivedGroups.map((group) => (
                  <fieldset
                    key={group.id}
                    aria-label={group.name}
                    className="space-y-1 rounded-lg px-3 py-2"
                  >
                    <span className="block truncate text-sm" dir="auto">
                      {group.name}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={!canCreateRoleFrom(group.id)}
                        onClick={() => onNewRoleFrom(group.id)}
                      >
                        <Trans>New role</Trans>
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => onRestoreRole(group.id)}>
                        <Trans>Restore</Trans>
                      </Button>
                    </div>
                  </fieldset>
                ))
              : null}
          </div>
        ) : null}
      </div>
      <div className="hire-sidebar-bottom">
        <Button
          variant="ghost"
          disabled={!canOpenDashboard}
          aria-current={view === "workflow" ? "page" : undefined}
          onClick={() => onView("workflow")}
        >
          <WandSparkles size={17} aria-hidden="true" />
          <Trans>Recruiting workflow</Trans>
        </Button>
      </div>
    </div>
  );
}
