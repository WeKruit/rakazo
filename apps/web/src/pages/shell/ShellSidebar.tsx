import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { nestRosterByParent } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  GroupAvatar,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import {
  Bell,
  ChevronDown,
  CircleAlert,
  FolderOpen,
  Gauge,
  LayoutGrid,
  Lock,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  Settings,
  SquareKanban,
} from "lucide-react";
import type { CSSProperties } from "react";
import { lazyPanel } from "../../components/ErrorBoundary";
import { PaneResizeHandle } from "../../components/PaneResizeHandle";
import { authClient } from "../../lib/auth";
import { desktopBridge } from "../../lib/desktop";
import {
  compactRosterStatusLabel,
  rosterHasUndismissedRunError,
  rosterWorkStatusLabel,
} from "../../lib/roster-status";
import { clearSpaceSelection, rpc } from "../../lib/rpc";
import { SpaceSearchResults } from "../SpaceSearch";
import { BotCreatePicker } from "../shell/bot-picker";
import { RecruitingNavigation } from "../shell/RecruitingNavigation";
import type { useShellController } from "../shell/useShellController";
import { WindowChrome } from "../WindowChrome";

const ActivityList = lazyPanel(() =>
  import("../ActivityList").then((module) => module.ActivityList),
);
const _VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;

export function ShellSidebar({ model }: { model: ReturnType<typeof useShellController> }) {
  const {
    t,
    groupId,
    navigate,
    groups,
    bots,
    botSections,
    spaces,
    archivedBots,
    archivedGroups,
    archivedOpen,
    setArchivedOpen,
    collapsedSidebarSections,
    collapsedRosterParents,
    query,
    setQuery,
    searchHits,
    searchLoading,
    botsSidebarDensity,
    recruitingRefresh,
    recruitingReadCache,
    setPanel,
    setPluginsOpen,
    dismissedRunErrorIds,
    menuOpen,
    setMenuOpen,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    draggedBotId,
    setDraggedBotId,
    createMenuOpen,
    setCreateMenuOpen,
    botsSidebarCollapsed,
    setNewSpaceOpen,
    setPickerInfoTopic,
    activityMode,
    toggleActivityMode,
    setBotMenu,
    botMenuAnchor,
    setDeleteTarget,
    setDeleteGroupTarget,
    setSpaceMenu,
    spaceMenuAnchor,
    setSectionMenu,
    sectionMenuAnchor,
    initialBotsLoaded,
    bootstrapMe,
    showToolActivity,
    setBotsSidebarWidth,
    botsSidebarMaxWidth,
    visibleSidebarWidth,
    inGroup,
    active,
    activeGroup,
    canCreateRoleFrom,
    refreshBots,
    prefetchThread,
    prefetchSidebarChat,
    sidebarGroups,
    openSpaceChat,
    reorderRosterBot,
    toggleSidebarSection,
    toggleRosterParent,
    showSpaceSearch,
    jumpToSearchHit,
    activeSnapshot,
    recruitingWorkspaceView,
    recruitingCacheScope,
    effectiveCrmSelection,
    openRecruitingView,
    displayedRunError,
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
      {showToolActivity && (
        <>
          <div className="app-drag flex items-center justify-between px-[18px] pb-3 pt-4">
            <WindowChrome />
            <div className="relative flex items-center gap-2.5">
              <button
                type="button"
                aria-label={t`Activity`}
                aria-pressed={activityMode}
                title={t`Activity`}
                data-activity-mode={activityMode ? "on" : "off"}
                onClick={toggleActivityMode}
                className={`app-no-drag flex h-7 w-7 items-center justify-center rounded-full ${
                  activityMode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground/70 hover:text-foreground/75"
                }`}
              >
                <Bell
                  size={15}
                  strokeWidth={1.8}
                  fill={activityMode ? "currentColor" : "none"}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="app-no-drag hidden h-7 w-7 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground/75 md:inline-flex"
                aria-label={t`Minimize bots`}
                title={t`Minimize bots`}
                data-testid="minimize-bots-sidebar"
                onClick={() => setBotsSidebarCollapsedPref(true)}
              >
                <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
                <PopoverTrigger
                  className="app-no-drag text-[21px] text-muted-foreground/70 hover:text-foreground/75"
                  title={t`Create`}
                  data-testid="create-menu-trigger"
                >
                  +
                </PopoverTrigger>
                {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
                {createMenuOpen ? (
                  <PopoverContent
                    align="end"
                    className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
                  >
                    <BotCreatePicker
                      bots={bots}
                      onCreateBot={() => {
                        setCreateMenuOpen(false);
                        setMobileSidebarOpen(false);
                        setPanel("create");
                      }}
                      onOpenBot={(id) => {
                        setCreateMenuOpen(false);
                        setMobileSidebarOpen(false);
                        navigate(`/app/${id}`);
                      }}
                      onCreateGroup={() => {
                        setCreateMenuOpen(false);
                        setMobileSidebarOpen(false);
                        setPanel("create-group");
                      }}
                      onCreateSpace={() => {
                        setCreateMenuOpen(false);
                        setMobileSidebarOpen(false);
                        setNewSpaceOpen(true);
                      }}
                      onShowGroupInfo={() => {
                        setCreateMenuOpen(false);
                        setMobileSidebarOpen(false);
                        setPickerInfoTopic("group");
                      }}
                      onShowSpaceInfo={() => {
                        setCreateMenuOpen(false);
                        setMobileSidebarOpen(false);
                        setPickerInfoTopic("space");
                      }}
                    />
                  </PopoverContent>
                ) : null}
              </Popover>
            </div>
          </div>
          <InputGroup
            data-testid="sidebar-search"
            className="mx-2.5 mb-3 w-auto rounded-xl bg-card dark:bg-input border border-border text-muted-foreground focus-within:border-ring"
          >
            <InputGroupAddon>
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t`Search`}
              autoComplete="off"
              name="sidebar-search"
            />
          </InputGroup>
          <div className="rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
            {showSpaceSearch ? (
              <SpaceSearchResults
                hits={searchHits}
                loading={searchLoading}
                onSelect={(hit) => void jumpToSearchHit(hit)}
              />
            ) : (
              <>
                {activityMode ? (
                  <ActivityList
                    onOpenRun={(run) => {
                      setMobileSidebarOpen(false);
                      if (run.groupId) navigate(`/app/g/${run.groupId}`);
                      else navigate(`/app/${run.botId}`);
                    }}
                  />
                ) : null}
                {sidebarGroups.map((group) => {
                  const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
                  const groupBotIds = group.bots.flatMap((item) =>
                    item.kind === "bot" ? [item.chat.id] : [],
                  );
                  const nestedRows = nestRosterByParent(group.bots, collapsedRosterParents);
                  const treeActive = nestedRows.some((row) => row.depth > 0 || row.hasChildren);
                  const rosterParent = new Map(
                    nestedRows.map((row) => [row.item.chat.id, row.parentId] as const),
                  );
                  // Reorder among visible siblings so keyboard and drag moves match the tree.
                  const siblingBotIds = (parentId: string | null) =>
                    nestedRows.flatMap((row) =>
                      row.item.kind === "bot" && row.parentId === parentId
                        ? [row.item.chat.id]
                        : [],
                    );
                  const hasSpaceActions = group.canRenameSpace || group.canDeleteSpace;
                  return (
                    <div key={group.key} data-sidebar-group={group.key}>
                      {group.title || hasSpaceActions ? (
                        <div
                          className={
                            group.title && hasSpaceActions
                              ? "grid pt-3 pb-0.5"
                              : `flex items-center pt-3 pb-0.5${group.title ? "" : " justify-end"}`
                          }
                        >
                          {group.title ? (
                            <button
                              type="button"
                              className={`flex min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-[11px] font-semibold tracking-wider uppercase text-muted-foreground/60 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${hasSpaceActions ? "col-start-1 row-start-1 w-full pe-8" : "flex-1"}`}
                              onClick={() => {
                                if (group.emptySpaceId) {
                                  openSpaceChat(group.emptySpaceId, "/onboarding");
                                  return;
                                }
                                toggleSidebarSection(group.key);
                              }}
                              onContextMenu={
                                group.sectionId
                                  ? (event) => {
                                      event.preventDefault();
                                      // Prefer section rename over the space menu when both apply;
                                      // the dedicated space-actions button still opens the space menu.
                                      const sections =
                                        group.spaceId === bootstrapMe?.spaceId
                                          ? botSections
                                          : (spaces.find((space) => space.id === group.spaceId)
                                              ?.botSections ?? []);
                                      const section = sections.find(
                                        (item) => item.id === group.sectionId,
                                      );
                                      if (!section) return;
                                      sectionMenuAnchor.current = event.currentTarget;
                                      setSectionMenu({
                                        section,
                                        spaceId: group.spaceId,
                                        position: { x: event.clientX, y: event.clientY },
                                      });
                                    }
                                  : hasSpaceActions
                                    ? (event) => {
                                        event.preventDefault();
                                        spaceMenuAnchor.current = event.currentTarget;
                                        setSpaceMenu({
                                          id: group.spaceId,
                                          position: { x: event.clientX, y: event.clientY },
                                        });
                                      }
                                    : undefined
                              }
                              aria-expanded={group.emptySpaceId ? undefined : !collapsed}
                              aria-label={
                                group.emptySpaceId
                                  ? t`Open ${group.title}`
                                  : collapsed
                                    ? t`Expand ${group.title}`
                                    : t`Collapse ${group.title}`
                              }
                            >
                              <span className="flex min-w-0 items-center gap-1.5 truncate">
                                {group.showLock ? (
                                  <Lock size={11} strokeWidth={2} aria-hidden="true" />
                                ) : null}
                                <span className="truncate">{group.title}</span>
                              </span>
                              {group.emptySpaceId ? null : (
                                <ChevronDown
                                  size={14}
                                  strokeWidth={1.8}
                                  className={
                                    collapsed
                                      ? "-rotate-90 transition-transform"
                                      : "transition-transform"
                                  }
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                          ) : null}
                          {hasSpaceActions ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className={
                                group.title
                                  ? "col-start-1 row-start-1 justify-self-end self-center"
                                  : undefined
                              }
                              aria-label={t`Actions for ${group.spaceName}`}
                              onClick={(event) => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                spaceMenuAnchor.current = event.currentTarget;
                                setSpaceMenu({
                                  id: group.spaceId,
                                  position: { x: rect.left, y: rect.bottom },
                                });
                              }}
                            >
                              <MoreHorizontal size={14} aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {!collapsed &&
                        nestedRows.map(({ item, depth, hasChildren, parentId }) => {
                          const parentCollapsed =
                            hasChildren && collapsedRosterParents.has(item.chat.id);
                          const selected =
                            (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                            (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                          const compact = botsSidebarDensity === "compact";
                          const workStatusLabel =
                            item.kind === "bot" ? rosterWorkStatusLabel(item.chat.status) : null;
                          const rowError =
                            item.kind === "bot" &&
                            (rosterHasUndismissedRunError(
                              item.chat.runErrorId,
                              dismissedRunErrorIds,
                            ) ||
                              (active?.id === item.chat.id && Boolean(displayedRunError)));
                          const compactStatusLabel =
                            compact && item.kind === "bot"
                              ? rowError
                                ? t`Error`
                                : compactRosterStatusLabel(item.chat.status)
                              : null;
                          const rosterLine = compact
                            ? compactStatusLabel
                            : (workStatusLabel ??
                              (item.kind === "bot"
                                ? item.chat.preview ||
                                  (item.chat.status !== "idle" ? item.chat.status : "")
                                : item.chat.preview ||
                                  item.chat.members.map((member) => member.name).join(", ")));
                          return (
                            <div
                              key={`${item.kind}:${item.chat.id}`}
                              className="group/row relative"
                              style={{
                                opacity:
                                  item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                              }}
                            >
                              {hasChildren ? (
                                <span
                                  className="absolute inset-y-0 z-10 flex w-3.5 items-center justify-center"
                                  style={{ insetInlineStart: `${10 + depth * 14}px` }}
                                >
                                  <button
                                    type="button"
                                    aria-expanded={!parentCollapsed}
                                    aria-label={
                                      parentCollapsed
                                        ? t`Expand ${item.chat.name}`
                                        : t`Collapse ${item.chat.name}`
                                    }
                                    className="inline-flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                                    onClick={() => toggleRosterParent(item.chat.id)}
                                  >
                                    <ChevronDown
                                      size={12}
                                      strokeWidth={2}
                                      className={`transition-transform ${
                                        parentCollapsed ? "-rotate-90" : ""
                                      }`}
                                      aria-hidden="true"
                                    />
                                  </button>
                                </span>
                              ) : null}
                              <button
                                type="button"
                                draggable={item.kind === "bot"}
                                data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                                data-roster-unread={item.chat.unread ? "true" : undefined}
                                data-roster-error={rowError && compact ? "true" : undefined}
                                data-roster-depth={
                                  item.kind === "bot" && treeActive ? depth : undefined
                                }
                                aria-current={selected ? "page" : undefined}
                                aria-keyshortcuts={
                                  item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                                }
                                onDragStart={(event) => {
                                  if (item.kind !== "bot") return;
                                  setDraggedBotId(item.chat.id);
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", item.chat.id);
                                }}
                                onDragOver={(event) => {
                                  if (
                                    item.kind === "bot" &&
                                    draggedBotId &&
                                    groupBotIds.includes(draggedBotId) &&
                                    rosterParent.get(draggedBotId) === parentId
                                  ) {
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                  }
                                }}
                                onDrop={(event) => {
                                  if (
                                    item.kind !== "bot" ||
                                    !draggedBotId ||
                                    rosterParent.get(draggedBotId) !== parentId
                                  )
                                    return;
                                  event.preventDefault();
                                  reorderRosterBot(draggedBotId, item.chat.id, groupBotIds);
                                  setDraggedBotId(null);
                                }}
                                onDragEnd={() => setDraggedBotId(null)}
                                onKeyDown={(event) => {
                                  if (
                                    item.kind !== "bot" ||
                                    !event.altKey ||
                                    (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                                  )
                                    return;
                                  const siblings = siblingBotIds(parentId);
                                  const index = siblings.indexOf(item.chat.id);
                                  const target =
                                    siblings[index + (event.key === "ArrowUp" ? -1 : 1)];
                                  if (!target) return;
                                  event.preventDefault();
                                  reorderRosterBot(item.chat.id, target, groupBotIds);
                                }}
                                onMouseEnter={() => prefetchSidebarChat(item)}
                                onFocus={() => prefetchSidebarChat(item)}
                                onClick={() => {
                                  openSpaceChat(
                                    item.chat.spaceId,
                                    item.kind === "bot"
                                      ? `/app/${item.chat.id}`
                                      : `/app/g/${item.chat.id}`,
                                  );
                                }}
                                onContextMenu={(event) => {
                                  if (item.chat.spaceId !== bootstrapMe?.spaceId) return;
                                  event.preventDefault();
                                  botMenuAnchor.current = event.currentTarget;
                                  setBotMenu({
                                    kind: item.kind,
                                    id: item.chat.id,
                                    position: { x: event.clientX, y: event.clientY },
                                  });
                                }}
                                className={`flex w-full items-center ${
                                  compact
                                    ? "min-h-11 gap-2 rounded-xl px-2.5 py-1.5"
                                    : "gap-3 rounded-xl px-2.5 py-[10px]"
                                } text-start ${
                                  item.kind === "bot" ? "cursor-grab active:cursor-grabbing" : ""
                                } ${
                                  selected
                                    ? "bg-sidebar-accent"
                                    : "group-hover/row:bg-sidebar-accent"
                                }`}
                                style={
                                  treeActive
                                    ? { paddingInlineStart: `${24 + depth * 14}px` }
                                    : undefined
                                }
                              >
                                {item.kind === "bot" ? (
                                  <BotAvatar
                                    color={item.chat.color}
                                    identity={item.chat.id}
                                    size={compact ? 28 : 38}
                                    status={item.chat.status}
                                  />
                                ) : (
                                  <GroupAvatar
                                    members={
                                      item.chat.id === activeSnapshot?.groupId
                                        ? (activeSnapshot.members ?? item.chat.members)
                                        : item.chat.members
                                    }
                                    size={compact ? 28 : 38}
                                  />
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center justify-between gap-1.5">
                                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                                      <span
                                        dir="auto"
                                        data-roster-bot-name={item.kind === "bot" ? "" : undefined}
                                        className={`min-w-0 truncate text-[14px] text-foreground ${
                                          item.chat.unread ? "font-semibold" : "font-medium"
                                        }`}
                                      >
                                        {item.chat.name}
                                      </span>
                                      {item.chat.unread ? (
                                        <span className="sr-only">
                                          <Trans> (unread)</Trans>
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                      {!compact ? (
                                        <span className="text-[11.5px] text-muted-foreground/60 tabular-nums">
                                          {formatRosterTime(item.chat.updatedAt)}
                                        </span>
                                      ) : null}
                                      {item.chat.unread ? (
                                        <span
                                          aria-hidden="true"
                                          className="inline-block h-2 w-2 rounded-full bg-foreground"
                                        />
                                      ) : null}
                                    </div>
                                  </div>
                                  {!compact && item.kind === "bot" && item.chat.title ? (
                                    <div className="mt-1 flex">
                                      <span className="max-w-full truncate rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                                        {item.chat.title}
                                      </span>
                                    </div>
                                  ) : null}
                                  {compact ? (
                                    compactStatusLabel ? (
                                      <div
                                        dir="auto"
                                        data-roster-status={
                                          rowError
                                            ? "error"
                                            : item.kind === "bot"
                                              ? item.chat.status
                                              : undefined
                                        }
                                        className={`mt-0.5 flex items-center gap-1 text-[11.5px] ${
                                          rowError
                                            ? "font-medium text-destructive"
                                            : workStatusLabel
                                              ? "font-semibold text-status-working"
                                              : "font-medium text-foreground/75"
                                        }`}
                                      >
                                        {rowError ? (
                                          <CircleAlert size={12} aria-hidden="true" />
                                        ) : null}
                                        <span>{compactStatusLabel}</span>
                                      </div>
                                    ) : null
                                  ) : (
                                    <div
                                      dir="auto"
                                      data-roster-preview={!workStatusLabel ? "true" : undefined}
                                      className={`mt-1 line-clamp-2 text-[12.5px] break-words whitespace-normal ${
                                        workStatusLabel
                                          ? "font-semibold text-status-working"
                                          : item.chat.unread
                                            ? "font-medium text-foreground/75"
                                            : "text-muted-foreground/60"
                                      }`}
                                    >
                                      {rosterLine}
                                    </div>
                                  )}
                                </div>
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
              </>
            )}
            {archivedBots.length + archivedGroups.length > 0 && !showSpaceSearch ? (
              <div className="mt-2 border-t border-border pt-2">
                <button
                  type="button"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13.5px] text-muted-foreground hover:bg-sidebar-accent"
                >
                  <span>
                    <Trans>Archived</Trans>
                  </span>
                  <span>{archivedBots.length + archivedGroups.length}</span>
                </button>
                {archivedOpen ? (
                  <>
                    {archivedBots.map((bot) => (
                      <div key={bot.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                        <BotAvatar
                          color={bot.color}
                          identity={bot.id}
                          size={28}
                          status={bot.status}
                        />
                        <span
                          className="min-w-0 flex-1 truncate text-[14px] text-foreground/75"
                          dir="auto"
                        >
                          {bot.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            void rpc.bots.restore({ botId: bot.id }).then(() => refreshBots(true))
                          }
                        >
                          <Trans>Restore</Trans>
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-destructive hover:text-destructive"
                          aria-label={t`Delete ${bot.name}`}
                          onClick={() => setDeleteTarget(bot)}
                        >
                          <Trans>Delete</Trans>
                        </Button>
                      </div>
                    ))}
                    {archivedGroups.map((group) => (
                      <div
                        key={group.id}
                        className="flex items-center gap-2 rounded-lg px-2.5 py-2"
                      >
                        <GroupAvatar members={group.members} size={28} />
                        <span
                          className="min-w-0 flex-1 truncate text-[14px] text-foreground/75"
                          dir="auto"
                        >
                          {group.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void restoreGroup(group.id)}
                        >
                          <Trans>Restore</Trans>
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-destructive hover:text-destructive"
                          aria-label={t`Delete ${group.name}`}
                          onClick={() => setDeleteGroupTarget(group)}
                        >
                          <Trans>Delete</Trans>
                        </Button>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}
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
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          className="flex items-center gap-[11px] px-[18px] py-3.5"
        >
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[12px] text-foreground/75">
            {initials}
          </span>
          <span className="text-[14.5px] text-foreground/90">{userName}</span>
        </PopoverTrigger>
        {menuOpen ? (
          <PopoverContent
            side="top"
            align="start"
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
          </PopoverContent>
        ) : null}
      </Popover>
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
function formatRosterTime(isoDate?: string | null): string {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return "";
    const locale = i18n.locale || "en";
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) {
      return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();
    if (isYesterday) return t`Yesterday`;
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return d.toLocaleDateString(locale, { weekday: "short" });
    }
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
