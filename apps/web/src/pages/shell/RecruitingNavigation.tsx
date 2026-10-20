import { Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { BriefcaseBusiness, ChartNoAxesCombined, MessageSquare, Plus, Search } from "lucide-react";

/** The supplied WeKruit RecruiterShell chrome, over the existing native conversations. */
export function RecruitingNavigation({
  groups,
  groupId,
  query,
  dashboardOpen,
  canOpenDashboard,
  canCreateRole,
  onQueryChange,
  onConversation,
  onDashboard,
  onOpenRole,
  onNewRole,
}: {
  groups: Group[];
  groupId?: string;
  query: string;
  dashboardOpen: boolean;
  canOpenDashboard: boolean;
  canCreateRole: boolean;
  onQueryChange: (query: string) => void;
  onConversation: () => void;
  onDashboard: () => void;
  onOpenRole: (id: string) => void;
  onNewRole: () => void;
}) {
  const { t } = useLingui();
  const visibleGroups = groups.filter((group) =>
    group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4" data-testid="recruiting-navigation">
      <div className="flex items-center gap-3 px-1 pb-7 pt-2">
        <span className="recruiting-heading grid size-[34px] place-items-center rounded-[9px] bg-primary text-[21px] text-primary-foreground">
          W
        </span>
        <span className="flex flex-col leading-tight">
          <strong className="text-[15px] font-semibold">WeKruit</strong>
          <span className="text-xs text-muted-foreground">
            <Trans>Recruiter</Trans>
          </span>
        </span>
      </div>
      <nav aria-label={t`Recruiting workspace`} className="space-y-1">
        <Button
          variant={!dashboardOpen ? "default" : "ghost"}
          aria-current={!dashboardOpen ? "page" : undefined}
          className="w-full justify-start rounded-[10px]"
          onClick={onConversation}
        >
          <MessageSquare size={18} aria-hidden="true" />
          <Trans>Conversation</Trans>
        </Button>
        <Button
          variant={dashboardOpen ? "default" : "ghost"}
          aria-current={dashboardOpen ? "page" : undefined}
          disabled={!canOpenDashboard}
          className="w-full justify-start rounded-[10px]"
          onClick={onDashboard}
        >
          <ChartNoAxesCombined size={18} aria-hidden="true" />
          <Trans>Dashboard</Trans>
        </Button>
      </nav>
      <div className="mb-3 mt-7 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          <Trans>Open roles</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`New role`}
          disabled={!canCreateRole}
          onClick={onNewRole}
        >
          <Plus size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute start-3 top-2.5 text-muted-foreground"
          size={15}
          aria-hidden="true"
        />
        <Input
          aria-label={t`Search roles`}
          placeholder={t`Search roles`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="h-9 rounded-[10px] bg-card ps-9 text-[13px]"
        />
      </div>
      <nav
        aria-label={t`Role conversations`}
        className="rk-scroll min-h-0 flex-1 space-y-1 overflow-y-auto"
      >
        {visibleGroups.map((group) => (
          <Button
            key={group.id}
            variant={group.id === groupId && !dashboardOpen ? "secondary" : "ghost"}
            className="h-auto min-h-11 w-full justify-start rounded-[10px] px-3 py-3 text-start"
            aria-current={group.id === groupId ? "page" : undefined}
            onClick={() => onOpenRole(group.id)}
          >
            <BriefcaseBusiness size={17} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" dir="auto">
              {group.name}
            </span>
            {group.unread ? (
              <span
                className="size-1.5 rounded-full bg-primary"
                role="img"
                aria-label={t`Unread`}
              />
            ) : null}
          </Button>
        ))}
      </nav>
    </div>
  );
}
