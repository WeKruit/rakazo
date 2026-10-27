import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { FolderOpen, Gauge, LayoutGrid, LogOut, Settings, SquareKanban } from "lucide-react";
import type { CSSProperties } from "react";
import { DeferredPopover } from "../../components/DeferredPopover";
import { lazyPanel } from "../../components/ErrorBoundary";
import { PaneResizeHandle } from "../../components/PaneResizeHandle";
import { authClient } from "../../lib/auth";
import { desktopBridge } from "../../lib/desktop";
import { clearSpaceSelection } from "../../lib/rpc";

import { RecruitingNavigation } from "../shell/RecruitingNavigation";
import type { useShellController } from "../shell/useShellController";
import { WindowChrome } from "../WindowChrome";

const DeveloperSidebar = lazyPanel(() =>
  import("./DeveloperSidebar").then((m) => m.DeveloperSidebar),
);
export function ShellSidebar({ model }: { model: ReturnType<typeof useShellController> }) {
  const { t } = useLingui();
  const {
    groupId,
    navigate,
    groups,
    archivedGroups,
    archivedOpen,
    setArchivedOpen,
    query,
    setQuery,
    botsSidebarDensity,
    recruitingRefresh,
    recruitingReadCache,
    setPanel,
    setPluginsOpen,
    menuOpen,
    setMenuOpen,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    botsSidebarCollapsed,
    setBotMenu,
    botMenuAnchor,
    initialBotsLoaded,
    bootstrapMe,
    showToolActivity,
    setBotsSidebarWidth,
    botsSidebarMaxWidth,
    visibleSidebarWidth,
    activeGroup,
    canCreateRoleFrom,
    prefetchThread,
    activeSnapshot,
    recruitingWorkspaceView,
    recruitingCacheScope,
    effectiveCrmSelection,
    openRecruitingView,
    transcriptArtifactTarget,
    openCrmRole,
    startNewRole,
    restoreGroup,
    setBotsSidebarCollapsedPref,
    openSettings,
    userName,
    initials,
  } = model;
  return (
    <aside
      data-testid="bots-sidebar"
      data-bots-sidebar-density={botsSidebarDensity}
      data-collapsed={botsSidebarCollapsed ? "true" : "false"}
      inert={botsSidebarCollapsed && !mobileSidebarOpen ? true : undefined}
      style={{ "--bots-sidebar-width": `${visibleSidebarWidth}px` } as CSSProperties}
      className={`absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-[transform,width,opacity] md:relative md:z-auto md:translate-x-0 ${
        mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"
      } ${
        botsSidebarCollapsed
          ? "md:w-0 md:max-w-0 md:overflow-hidden md:border-e-0 md:opacity-0 md:pointer-events-none"
          : "md:w-(--bots-sidebar-width) md:max-w-none"
      }`}
    >
      {!showToolActivity ? (
        <>
          {desktopBridge() ? (
            <div className="app-drag px-5 pt-4">
              <WindowChrome />
            </div>
          ) : null}
          <RecruitingNavigation
            loading={!initialBotsLoaded}
            onPrefetchRole={(id) =>
              prefetchThread({ groupId: id }, groups.find((group) => group.id === id)?.spaceId)
            }
            crmContext={
              recruitingCacheScope
                ? {
                    target: transcriptArtifactTarget,
                    scope: recruitingCacheScope,
                    cache: recruitingReadCache.current,
                    refreshSignal: recruitingRefresh,
                  }
                : undefined
            }
            crmSelection={effectiveCrmSelection}
            onOpenCrmRole={(selection) => void openCrmRole(selection)}
            groups={groups}
            archivedGroups={archivedGroups}
            archivedOpen={archivedOpen}
            groupId={groupId}
            query={query}
            view={recruitingWorkspaceView}
            onView={openRecruitingView}
            onCollapse={() => setBotsSidebarCollapsedPref(true)}
            canOpenDashboard={Boolean(activeSnapshot?.threadId)}
            canCreateRole={
              Boolean(activeGroup && canCreateRoleFrom(activeGroup.id)) ||
              archivedGroups.some((group) => canCreateRoleFrom(group.id))
            }
            canCreateRoleFrom={canCreateRoleFrom}
            onQueryChange={setQuery}
            onOpenRole={(id) => {
              setPanel(null);
              setMobileSidebarOpen(false);
              navigate(`/app/g/${id}?view=results`);
            }}
            onNewRole={() => {
              if (activeGroup && canCreateRoleFrom(activeGroup.id)) startNewRole(activeGroup.id);
              else setArchivedOpen(true);
            }}
            onNewRoleFrom={startNewRole}
            onToggleArchived={() => setArchivedOpen((open) => !open)}
            onRestoreRole={(id) => void restoreGroup(id)}
            onRoleMenu={(id, anchor, position) => {
              if (groups.find((group) => group.id === id)?.spaceId !== bootstrapMe?.spaceId) return;
              botMenuAnchor.current = anchor;
              setBotMenu({ kind: "group", id, position });
            }}
          />
        </>
      ) : null}
      {showToolActivity ? <DeveloperSidebar model={model} /> : null}
      <button
        type="button"
        onClick={() => setPluginsOpen(true)}
        className="mx-3 mb-1 flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-sidebar-accent"
      >
        <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent text-foreground/80">
          <LayoutGrid size={15} strokeWidth={1.8} />
        </span>
        <span className="text-[14px] font-medium text-foreground/90">
          <Trans>Integrations</Trans>
        </span>
      </button>
      <DeferredPopover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[12px] text-foreground/75">
              {initials}
            </span>
            <span className="text-[14.5px] text-foreground/90">{userName}</span>
          </>
        }
        triggerProps={{
          "data-testid": "user-menu-trigger",
          className: "flex items-center gap-[11px] px-[18px] py-3.5",
        }}
        side="top"
        align="start"
        label={userName}
        className="w-[calc(316px-1.5rem)] max-w-[calc(100vw-3rem)] gap-0 p-1 data-closed:animate-none"
      >
        {showToolActivity && bootstrapMe?.ticketBoardEnabled ? (
          <Button
            variant="ghost"
            className="w-full justify-start font-normal"
            onClick={() => {
              setMenuOpen(false);
              setMobileSidebarOpen(false);
              navigate("/app/board");
            }}
          >
            <SquareKanban className="text-muted-foreground" strokeWidth={1.75} />
            <Trans>Board</Trans>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="w-full justify-start font-normal"
          onClick={() => {
            setMenuOpen(false);
            setMobileSidebarOpen(false);
            navigate("/app/artifacts");
          }}
        >
          <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
          {showToolActivity ? <Trans>Artifacts</Trans> : <Trans>Files</Trans>}
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start font-normal"
          aria-label={t`Settings`}
          onClick={() => {
            setMenuOpen(false);
            openSettings("general");
          }}
        >
          <Settings className="text-muted-foreground" strokeWidth={1.75} />
          <Trans>Settings</Trans>
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start font-normal"
          aria-label={t`Usage`}
          onClick={() => {
            setMenuOpen(false);
            openSettings("usage");
          }}
        >
          <Gauge className="text-muted-foreground" strokeWidth={1.75} />
          <Trans>Usage</Trans>
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start font-normal"
          onClick={() =>
            void authClient.signOut().then(() => {
              clearSpaceSelection();
              navigate("/");
            })
          }
        >
          <LogOut className="text-muted-foreground" strokeWidth={1.75} />
          <Trans>Log out</Trans>
        </Button>
      </DeferredPopover>
      {!botsSidebarCollapsed ? (
        <PaneResizeHandle
          label={t`Resize navigation`}
          edge="end"
          className="md:block"
          width={visibleSidebarWidth}
          min={220}
          max={botsSidebarMaxWidth}
          onResize={setBotsSidebarWidth}
          onReset={() => setBotsSidebarWidth(showToolActivity ? 316 : 260)}
        />
      ) : null}
    </aside>
  );
}
