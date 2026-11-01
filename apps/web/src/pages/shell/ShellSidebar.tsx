import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { FolderOpen, Gauge, LayoutGrid, LogOut, Settings, SquareKanban } from "lucide-react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { DeferredPopover } from "../../components/DeferredPopover";
import { lazyPanel } from "../../components/ErrorBoundary";
import { PaneResizeHandle } from "../../components/PaneResizeHandle";
import { authClient } from "../../lib/auth";
import { desktopBridge } from "../../lib/desktop";
import { withFeatureMessages } from "../../lib/i18n";
import { clearSpaceSelection, rpc } from "../../lib/rpc";
import { savedThreads } from "../../lib/saved-threads";
import { useKeyedRead } from "../recruiting/shared";

import { RecruitingNavigation } from "../shell/RecruitingNavigation";
import type { useShellController } from "../shell/useShellController";
import { WindowChrome } from "../WindowChrome";

const DeveloperSidebar = lazyPanel(() =>
  withFeatureMessages(() => import("./DeveloperSidebar")).then((m) => m.DeveloperSidebar),
);
export function ShellSidebar({ model }: { model: ReturnType<typeof useShellController> }) {
  const { t } = useLingui();
  const {
    groupId,
    navigate,
    groups,
    archivedGroups,
    archivedGroupTotal,
    archivedGroupPage,
    openArchivedGroupPage,
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
    recruitingViewHref,
    transcriptArtifactTarget,
    openCrmRole,
    startNewRole,
    restoreGroup,
    setBotsSidebarCollapsedPref,
    openSettings,
    userName,
    initials,
  } = model;
  const inboxScope = JSON.stringify([model.userId, bootstrapMe?.spaceId]);
  const inboxSummary = useKeyedRead(
    !showToolActivity && model.userId && bootstrapMe?.spaceId
      ? JSON.stringify([inboxScope, recruitingRefresh])
      : null,
    () => rpc.recruiting.globalInboxSummary({ spaceId: bootstrapMe!.spaceId }),
    { cache: recruitingReadCache.current, key: `global-inbox:${inboxScope}` },
  );
  const selectedRoleId = model.searchParams.get("role");
  const roleScope = useKeyedRead(
    selectedRoleId && selectedRoleId !== "all" && bootstrapMe?.spaceId
      ? JSON.stringify([model.userId, bootstrapMe.spaceId, "nav-role", selectedRoleId])
      : null,
    () => rpc.recruiting.accountView({ view: "roles", roleId: selectedRoleId!, limit: 1 }),
  );
  const selectedRole = roleScope.data?.roles.find((role) => role.id === selectedRoleId);
  const global = groups.find((group) => group.id.startsWith("recruiting-global-"));
  const roleGroup = selectedRoleId
    ? selectedRole?.groupId
    : groupId && !groupId.startsWith("recruiting-global-")
      ? groupId
      : undefined;
  const crmChatParams = new URLSearchParams(model.searchParams);
  crmChatParams.set("view", "conversation");
  crmChatParams.delete("detail");
  const kruitHref = model.searchParams.has("crmServer")
    ? `${groupId ? `/app/g/${groupId}` : model.active?.id ? `/app/${model.active.id}` : "/app"}?${crmChatParams}`
    : roleGroup
      ? `/app/g/${roleGroup}?view=conversation`
      : selectedRole?.botId
        ? `/app/${selectedRole.botId}?view=conversation`
        : global
          ? `/app/g/${global.id}?view=conversation`
          : "/app?view=home";
  const newRoleSource =
    activeGroup ?? groups.find((group) => group.id.startsWith("recruiting-global-"));
  const readCache = recruitingReadCache.current;
  const crmContext = useMemo(
    () =>
      recruitingCacheScope
        ? {
            target: transcriptArtifactTarget,
            scope: recruitingCacheScope,
            cache: readCache,
            refreshSignal: recruitingRefresh,
          }
        : undefined,
    [recruitingCacheScope, transcriptArtifactTarget, readCache, recruitingRefresh],
  );
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
            crmContext={crmContext}
            crmSelection={selectedRoleId === "all" ? undefined : effectiveCrmSelection}
            onOpenCrmRole={(selection) =>
              void openCrmRole(
                selection,
                ["contacts", "shortlist", "sequence", "inbox", "interview", "analytics"].includes(
                  recruitingWorkspaceView,
                )
                  ? recruitingWorkspaceView
                  : "results",
              )
            }
            groups={groups.filter((group) => !group.id.startsWith("recruiting-global-"))}
            archivedGroups={archivedGroups}
            archivedGroupTotal={archivedGroupTotal}
            archivedGroupPage={archivedGroupPage}
            onArchivedGroupPage={(page) => void openArchivedGroupPage(page).catch(() => undefined)}
            archivedOpen={archivedOpen}
            groupId={roleGroup ?? undefined}
            query={query}
            view={recruitingWorkspaceView}
            onView={openRecruitingView}
            viewHref={recruitingViewHref}
            kruitHref={kruitHref}
            inboxUnread={
              inboxSummary.failed
                ? { status: "failed" }
                : inboxSummary.data
                  ? {
                      status: "ready",
                      count: inboxSummary.data.unread.count,
                      partial:
                        !inboxSummary.data.coverage.providerComplete ||
                        inboxSummary.data.unread.unknownThreads > 0,
                    }
                  : { status: "loading" }
            }
            kruitDisabled={!!selectedRoleId && selectedRoleId !== "all" && !selectedRole}
            onAllRoles={() => {
              setPanel(null);
              setMobileSidebarOpen(false);
              navigate(
                `/app?${new URLSearchParams({ view: ["contacts", "shortlist", "sequence", "inbox", "interview", "analytics"].includes(recruitingWorkspaceView) ? recruitingWorkspaceView : "contacts", role: "all" })}`,
              );
            }}
            onGlobalChat={() => {
              setPanel(null);
              setMobileSidebarOpen(false);
              navigate(kruitHref);
            }}
            onCollapse={() => setBotsSidebarCollapsedPref(true)}
            canOpenDashboard={Boolean(activeSnapshot?.threadId)}
            canCreateRole={
              Boolean(newRoleSource && canCreateRoleFrom(newRoleSource.id)) ||
              archivedGroups.some((group) => canCreateRoleFrom(group.id))
            }
            canCreateRoleFrom={canCreateRoleFrom}
            onQueryChange={setQuery}
            onOpenRole={(id) => {
              setPanel(null);
              setMobileSidebarOpen(false);
              navigate(
                `/app/g/${id}?${new URLSearchParams({ view: ["contacts", "shortlist", "sequence", "inbox", "interview", "analytics"].includes(recruitingWorkspaceView) ? recruitingWorkspaceView : "results" })}`,
              );
            }}
            onNewRole={() => {
              if (newRoleSource && canCreateRoleFrom(newRoleSource.id))
                startNewRole(newRoleSource.id);
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
          onClick={() => {
            setMenuOpen(false);
            setPluginsOpen(true);
          }}
        >
          <LayoutGrid className="text-muted-foreground" strokeWidth={1.75} />
          <Trans>Integrations</Trans>
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
              void savedThreads.clear();
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
          onReset={() => setBotsSidebarWidth(showToolActivity ? 316 : 240)}
        />
      ) : null}
    </aside>
  );
}
