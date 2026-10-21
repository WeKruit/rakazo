import { Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
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
import type { ContextMenuPosition } from "../BotContextMenu";

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
}: {
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
  const visibleGroups = groups.filter((group) =>
    group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
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
          <span>WeKruit</span>
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
        <nav aria-label={t`Role conversations`} className="space-y-1">
          {visibleGroups.map((group) => (
            <div key={group.id} className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="hire-role-button h-auto min-h-[39px] min-w-0 flex-1 justify-start gap-3 rounded-[9px] px-2.5 py-2 text-start text-sm font-normal"
                aria-current={group.id === groupId && view === "results" ? "page" : undefined}
                onClick={() => onOpenRole(group.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onRoleMenu(group.id, event.currentTarget, { x: event.clientX, y: event.clientY });
                }}
              >
                <span className="size-2 shrink-0 rounded-full bg-link" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {group.name}
                </span>
                {group.unread ? (
                  <span
                    className="size-1.5 rounded-full bg-link"
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
