import { useShellAgentActions } from "./useShellAgentActions";
import { useShellRecruitingRefresh } from "./useShellRecruitingRefresh";

export { eventChangesRecruitingPanel } from "./useShellRecruitingRefresh";

import { useShellCreation } from "./useShellCreation";
import { useShellMessages } from "./useShellMessages";
import { useShellNotifications } from "./useShellNotifications";
import { useShellRecruiting } from "./useShellRecruiting";
import { useShellRoster } from "./useShellRoster";
import { useShellThreads } from "./useShellThreads";

export { firstThreadRoute } from "./useShellRoster";

import { Trans, useLingui } from "@lingui/react/macro";
import { LinkFaviconsContext } from "@rakazo/chat-ui/web-lazy";
import type {
  Bot,
  BotSection,
  Connection,
  ConnectionCatalogItem,
  Group,
  Routine,
  Space,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  UsageCosts,
} from "@rakazo/contracts";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import {
  answerableAskMessageIds,
  attachmentsForThread,
  buildComposerMentionOptions,
  isActive,
  runRecoveryAction,
  withLiveStreamingProgress,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { readActivityMode, writeActivityMode } from "../../lib/activity-mode";
import type { AuthSessionState } from "../../lib/auth";
import { authClient } from "../../lib/auth";
import {
  getBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "../../lib/bots-sidebar-density-pref";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../../lib/bots-sidebar-pref";
import { useCallSession } from "../../lib/call-session";
import {
  getComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../../lib/composer-enter-to-send-pref";
import { computersAreUnavailable } from "../../lib/computer-sandbox";
import { embeddableScreenUrl } from "../../lib/computer-screen";
import { clampWidth, usePaneWidth, useViewportWidth } from "../../lib/pane-width";
import { revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../../lib/performance";
import { setPreloadRecoveryActiveWork } from "../../lib/preload-recovery";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { clearRecruitingReads, createRecruitingReadCache } from "../../lib/recruiting-read-cache";
import {
  getResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "../../lib/response-streaming";
import type { Panel, RecruitingPanelState, RightPanelState } from "../../lib/right-panel-state";
import {
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "../../lib/right-panel-state";
import { rpc } from "../../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../../lib/run-error-storage";
import { useNewPeopleDuringRun } from "../../lib/run-people-progress";
import { sharedInflight } from "../../lib/shared-inflight";
import {
  activeThreadRuns,
  threadRunError,
  userHoldsComputerControl,
} from "../../lib/thread-events";
import { createThreadPrefetch } from "../../lib/thread-prefetch";
import { useWorkEstimate } from "../../lib/work-estimate";
import type { ContextMenuPosition } from "../BotContextMenu";
import type { RoutineDraftState } from "../routine-draft";
import { draftFromRoutine, emptyRoutineDraft } from "../routine-draft";
import type { SettingsSection } from "../SettingsOverlay";
import type { PendingAttachment } from "../shell/Composer";
import { isCommandPaletteHotkey } from "../shell/command-palette-hotkey";
import { FALLBACK_BOT_COLOR } from "../shell/constants";
import { memberName } from "../shell/group-members";
import { useShellComputer } from "./useShellComputer";

export function useShellController() {
  const { t } = useLingui();
  const linkFavicons = useContext(LinkFaviconsContext);
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const session: AuthSessionState = authClient.useSession();
  const userId = session.data?.user.id;
  // The placeholder name a new role's group carries until its title is saved.
  const newRoleNames = useRef<string[]>([]);
  newRoleNames.current = ["New role", t`New role`];
  const [recruitingTab, setRecruitingTab] = useState<{
    threadId: string;
    tab: RecruitingPanelState["tab"];
  } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [newRoleSourceId, setNewRoleSourceId] = useState<string | null>(null);
  const [newRoleDescription, setNewRoleDescription] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const botsSidebarDensity = useSyncExternalStore(
    subscribeBotsSidebarDensity,
    getBotsSidebarDensity,
    () => "comfortable",
  );
  const enterToSend = useSyncExternalStore(
    subscribeComposerEnterToSend,
    getComposerEnterToSend,
    () => false,
  );
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [exportingConversation, setExportingConversation] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanelState] = useState<Panel>(null);
  const [recruitingRefresh, setRecruitingRefresh] = useState(0);
  // The role chat starts open: answers and confirmation cards must be visible without a click.
  const [roleChatOpen, setRoleChatOpen] = useState(true);
  const [requeuedRunIds, setRequeuedRunIds] = useState<string[]>([]);
  const observeRunSignal = useCallback(
    (event: { type: string; runId?: string | null; threadId?: string | null }) => {
      if (event.type === "run.requeued" && event.runId) {
        const runId = event.runId;
        setRequeuedRunIds((current) =>
          current.includes(runId) ? current : [...current.slice(-9), runId],
        );
      }
    },
    [],
  );
  const roleChatId = useId();
  const roleChatTrigger = useRef<HTMLButtonElement>(null);
  const roleChatSection = useRef<HTMLElement>(null);
  const recruitingReadCache = useRef<RecruitingReadCache>(createRecruitingReadCache());
  const [restoredPanelKey, setRestoredPanelKey] = useState<string | null>(null);
  const panelStorageKeyRef = useRef<string | null>(null);
  const observedPanelKey = useRef<string | null>(null);
  const explicitPanelTarget = useRef<string | null>(null);
  const pendingPanelRestore = useRef<RightPanelState | null>(null);
  const pendingExplicitPanel = useRef(false);
  const panelSearch = useRef({ searchParams, setSearchParams });
  panelSearch.current = { searchParams, setSearchParams };
  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    // A user navigation wins over a saved routine still waiting for its list.
    pendingPanelRestore.current = null;
    pendingExplicitPanel.current = panelStorageKeyRef.current === null;
    setRestoredPanelKey(panelStorageKeyRef.current);
    setPanelState(next);
    const currentSearch = panelSearch.current;
    if (currentSearch.searchParams.has("routine")) {
      const params = new URLSearchParams(currentSearch.searchParams);
      params.delete("routine");
      currentSearch.setSearchParams(params, { replace: true });
    }
  }, []);
  const [peerConversation, setPeerConversation] = useState<{
    peerBotId: string;
    peerBotName: string;
  } | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [teachBusy, setTeachBusy] = useState(false);
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  // ponytail: keep at most 20 threads in this authenticated shell; switching
  // account/space reloads it. Native refresh/SSE remains authoritative.
  const threadSnapshotCache = useRef(new Map<string, ThreadSnapshot>());
  // Hover/focus reads for a conversation about to open; keyed by user and Space.
  const threadPrefetch = useRef(createThreadPrefetch<ThreadSnapshot>());
  const validatedThreadEpoch = useRef<number | null>(null);
  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());
  function commitSnapshot(next: ThreadSnapshot | null) {
    if (next) {
      const key = next.groupId ? `group:${next.groupId}` : `bot:${next.botId}`;
      const cache = threadSnapshotCache.current;
      cache.delete(key);
      cache.set(key, next);
      if (cache.size > 20) cache.delete(cache.keys().next().value!);
    }
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [messagingProviders, setMessagingProviders] = useState<string[]>([]);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    SpaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const shellRoster = useShellRoster({
    userId,
    botId,
    groupId,
    navigate,
    searchParamsRef,
    memoryProviderConfigRevision,
    setMemoryProviderConfig,
    setMobileSidebarOpen: (open) => setMobileSidebarOpen(open),
    onBootstrapThread: (bootstrap) => {
      if (!bootstrap.thread) return;
      bootstrappedThread.current = bootstrap.thread;
      commitSnapshot(bootstrap.thread);
      commitComputer(bootstrap.thread.computer ?? null);
      setRoutines(bootstrap.routines);
      setRoutinesBotId(bootstrap.thread.botId ?? null);
    },
  });
  const {
    groups,
    setGroups,
    groupsRef,
    bots,
    setBots,
    botsRef,
    spaces,
    archivedGroups,
    setQuery,
    setSearchHits,
    botsRefreshUser,
    initialBotsLoaded,
    bootstrapMe,
    showToolActivity,
    refreshBots,
    applyRunStatus,
  } = shellRoster;

  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSidebarSwipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);
  const botsSidebarEdgeDragRef = useRef<{ startX: number; mode: "expand" | "collapse" } | null>(
    null,
  );
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [pickerInfoTopic, setPickerInfoTopic] = useState<"group" | "space" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeMobileSidebar() {
      if (desktop.matches) setMobileSidebarOpen(false);
    }
    closeMobileSidebar();
    desktop.addEventListener("change", closeMobileSidebar);
    return () => desktop.removeEventListener("change", closeMobileSidebar);
  }, []);
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  const [botMenu, setBotMenu] = useState<{
    kind: "bot" | "group";
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  // The context menu anchors to the pointer, so return focus to the row that opened it.
  const botMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (botMenu || !botMenuAnchor.current) return;
    botMenuAnchor.current.focus();
    botMenuAnchor.current = null;
  }, [botMenu]);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(null);
  const [renameSpaceTarget, setRenameSpaceTarget] = useState<Space | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  const spaceMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (spaceMenu || !spaceMenuAnchor.current) return;
    spaceMenuAnchor.current.focus();
    spaceMenuAnchor.current = null;
  }, [spaceMenu]);
  const closeSpaceMenu = useCallback(() => setSpaceMenu(null), []);
  const spaceMenuTarget = spaceMenu
    ? (spaces.find((space) => space.id === spaceMenu.id) ?? null)
    : null;
  const [clearTarget, setClearTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [newSectionTarget, setNewSectionTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<{
    section: BotSection;
    spaceId: string;
  } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{
    section: BotSection;
    spaceId: string;
    position: ContextMenuPosition;
  } | null>(null);
  const sectionMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (sectionMenu || !sectionMenuAnchor.current) return;
    sectionMenuAnchor.current.focus();
    sectionMenuAnchor.current = null;
  }, [sectionMenu]);
  const closeSectionMenu = useCallback(() => setSectionMenu(null), []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    const cache = recruitingReadCache.current;
    // Saved reads belong to one account and Space; drop them on unmount or when either changes.
    const prefetched = threadPrefetch.current;
    return () => {
      clearRecruitingReads(cache);
      prefetched.clear();
    };
  }, [userId, bootstrapMe?.spaceId]);
  const call = useCallSession(userId, bootstrapMe?.spaceId);
  const viewportWidth = useViewportWidth();
  const [botsSidebarWidth, setBotsSidebarWidth] = usePaneWidth(
    "rakazo:bots-sidebar-width",
    showToolActivity ? 316 : 260,
  );
  const botsSidebarMaxWidth = Math.max(220, Math.min(480, viewportWidth - 640));
  const visibleSidebarWidth = botsSidebarCollapsed
    ? 0
    : clampWidth(botsSidebarWidth, 220, botsSidebarMaxWidth);
  const [roleChatWidth, setRoleChatWidth] = usePaneWidth(
    "rakazo:role-chat-width",
    clampWidth(viewportWidth * 0.34, 320, 420),
  );
  const roleChatMaxWidth = Math.max(320, Math.min(720, viewportWidth - visibleSidebarWidth - 320));
  useEffect(() => {
    if (!showToolActivity && panel && panel !== "recruiting" && panel !== "create-group") {
      setPanel(null);
    }
  }, [showToolActivity, panel]);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputerRecoveryHint =
    computersAreUnavailable(bootstrapMe?.sandboxProvider) || keepComputerRecovery;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);
  useEffect(() => {
    if (panel !== "computer") releaseComputerRecovery();
  }, [panel, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [routineWebhookSecret, setRoutineWebhookSecret] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
          setMessagingProviders(status.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.data?.user]);
  const [usage, setUsage] = useState<UsageCosts | null>(null);
  const refreshUsage = useCallback(() => {
    void rpc.usage
      .costs()
      .then(setUsage)
      .catch(() => undefined);
  }, []);
  const routineSavePending = useRef(false);
  const webhookSecretProvisionRef = useRef(new Map<string, Promise<string>>());
  const ensureWebhookSecret = (botId: string) =>
    sharedInflight(webhookSecretProvisionRef.current, botId, async () => {
      const result = await rpc.bots.rotateWebhookSecret({ botId });
      setRoutineWebhookSecret(result.secret);
      setBots((current) =>
        current.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
      );
      return result.secret;
    });
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  const clearScrollRequest = useCallback(() => setScrollRequest(null), []);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>(null);
  const manuallyUnread = useRef(new Set<string>());
  const readVisibleGroups = useRef(new Set<string>());

  const inGroup = Boolean(groupId);
  const active = inGroup ? undefined : (bots.find((b) => b.id === botId) ?? bots[0]);
  const activeGroup = groups.find((group) => group.id === groupId);
  const archivedRouteGroup = activeGroup
    ? undefined
    : archivedGroups.find((group) => group.id === groupId);
  const roleSourceGroup =
    panel === "create-group" && newRoleSourceId
      ? [...groups, ...archivedGroups].find((group) => group.id === newRoleSourceId)
      : activeGroup;
  function canCreateRoleFrom(id: string) {
    const group = [...groups, ...archivedGroups].find((group) => group.id === id);
    return Boolean(
      !creatingGroup &&
        group &&
        group.members.length >= GROUP_MEMBER_MIN &&
        group.members.length <= GROUP_MEMBER_MAX &&
        group.members.every((member) =>
          bots.some((bot) => bot.id === member.botId && !bot.archivedAt),
        ),
    );
  }
  // Reuse this role's ordered native crew; its first member already owns default sends.
  const roleCrewBots = (roleSourceGroup?.members ?? []).flatMap((member) => {
    const bot = bots.find((bot) => bot.id === member.botId && !bot.archivedAt);
    return bot ? [bot] : [];
  });
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const panelTarget = inGroup ? activeGroup?.id : active?.id;
  const panelStorageKey =
    userId && bootstrapMe?.spaceId && panelTarget
      ? rightPanelStorageKey(userId, bootstrapMe.spaceId, inGroup ? "group" : "bot", panelTarget)
      : null;
  panelStorageKeyRef.current = panelStorageKey;
  const activeTaughtSkills = taughtSkillsBotId === active?.id ? taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
  const shellComputer = useShellComputer({
    active,
    bots,
    botsRef,
    activeBotId,
    activeGroupId,
    panel,
    snapshot,
    refreshThread: (id) => refreshThread(id),
    refreshGroupThread: (id) => refreshGroupThreadRef.current(id),
  });
  const {
    computer,
    computerRef,
    computerCacheRef,
    cacheComputerFor,
    commitComputer,
    booting,
    screenUrl,
    setScreenUrl,
    computerOpen,
    setComputerOpen,
    computerBotIdRef,
    computerOpenRef,
    computerError,
    setComputerError,
    computerErrorFromScreen,
    setComputerErrorFromScreen,
    computerBot,
    screenRequest,
    refreshComputerScreen,
  } = shellComputer;

  const {
    recruitingOutage,
    reconnectNeedsRecruitingRead,
    refreshRecruitingReads,
    invalidateRecruiting,
  } = useShellRecruitingRefresh({
    userId,
    bootstrapMe,
    botsRefreshUser,
    snapshotRef,
    activeGroupId,
    activeBotId,
    recruitingReadCache,
    setRecruitingRefresh,
  });
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const shellNotifications = useShellNotifications({ active, botsRef, setBots, manuallyUnread });
  const { markBotReadIfVisible, flushPendingBrowserNotifications, notifyBrowserForEvent } =
    shellNotifications;
  const shellThreads = useShellThreads({
    messageScroll,
    bootstrapMe,
    userId,
    groupId,
    inGroup,
    active,
    threadPrefetch,
    threadSnapshotCache,
    validatedThreadEpoch,
    commitSnapshot,
    historyEpoch,
    groupRefreshEpoch,
    activeGroupId,
    snapshotRef,
    computerRef,
    expandedHistoryThread,
    computerOpenRef,
    commitComputer,
    setRoutines,
    setRoutinesBotId,
    threadRefreshEpoch,
    activeBotId,
    cacheComputerFor,
    refreshComputerScreen,
    setTaughtSkills,
    setTaughtSkillsBotId,
    snapshot,
    loadingOlder,
    pinnedAroundRef,
    setLoadingOlder,
    updateSnapshot,
    searchParamsRef,
    screenRequest,
    setComputerError,
    setComputerErrorFromScreen,
    computerCacheRef,
    setScreenUrl,
    bootstrappedThread,
    recruitingOutage,
    reconnectNeedsRecruitingRead,
    refreshRecruitingReads,
    terminalRunReceipts,
    observeRunSignal,
    applyRunStatus,
    invalidateRecruiting,
    botsRef,
    notifyBrowserForEvent,
    refreshBots,
    markBotReadIfVisible,
    activeGroup,
    manuallyUnread,
    readVisibleGroups,
    setGroups,
    computerBotIdRef,
    groupsRef,
    newRoleNames,
    setQuery,
    setSearchHits,
    navigate,
    jumpGeneration,
    initiallyScrolledThread,
    setScrollRequest,
  });
  const { refreshGroupThread, refreshThread, loadOlderMessages, jumpToMessage } = shellThreads;
  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
    setPanelState((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      void jumpToMessage({ groupId, messageId }).finally(() => {
        // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft(draftFromRoutine(routine));
        setRoutineWebhookSecret(null);
        setEditingRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      void jumpToMessage({ botId: active.id, messageId }).finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [active?.id, groupId, inGroup, routines, routinesBotId, searchParams, setSearchParams]);
  const shellRecruiting = useShellRecruiting({
    inGroup,
    snapshot,
    groupId,
    active,
    threadSnapshotCache,
    searchParams,
    showToolActivity,
    panel,
    groups,
    activeGroup,
    userId,
    bootstrapMe,
    recruitingRefresh,
    recruitingReadCache,
    botsRefreshUser,
    activeGroupId,
    roleChatOpen,
    roleChatSection,
    setSearchParams,
    setMobileSidebarOpen,
    setPanel,
    recruitingTab,
    setRecruitingTab,
    sendMessage: (...args) => sendMessage(...args),
    setRoleChatOpen,
    snapshotRef,
    setSendError,
    activeBotId,
    sendingRef,
    validatedThreadEpoch,
    historyEpoch,
    setSending,
    canCreateRoleFrom,
    setGroups,
    navigate,
    refreshBots,
    initialBotsLoaded,
    sending,
    pendingAttachments,
    setPendingAttachments,
    booting,
    bots,
    refreshGroupThread: (id) => refreshGroupThreadRef.current(id),
    refreshThread: (id) => refreshThreadRef.current(id),
  });
  const {
    activeSnapshot,
    knownThreadId,
    roleChatWorkspace,
    composerRef,
    currentCorrespondenceScope,
    selectedSchedulingPlan,
    selectedCorrespondence,
    currentRecruitingCacheScope,
    selectedContact,
    chatRoleTitle,
    discussionScope,
  } = shellRecruiting;
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  const currentRuns = activeThreadRuns(activeSnapshot);
  const currentAnswerableAskIds = answerableAskMessageIds(
    validatedThreadEpoch.current === historyEpoch.current &&
      (inGroup
        ? snapshotRef.current?.groupId === groupId
        : snapshotRef.current?.botId === active?.id)
      ? snapshotRef.current
      : null,
  );
  // A waiting question or confirmation reopens a collapsed role chat once per new card.
  const pendingAskKey = currentAnswerableAskIds.join(",");
  // Same cards keep the same list, so the transcript does not re-render for unrelated changes.
  const answerableAskIds = useMemo(() => currentAnswerableAskIds, [pendingAskKey]);
  useEffect(() => {
    if (pendingAskKey && roleChatWorkspace) setRoleChatOpen(true);
  }, [pendingAskKey, roleChatWorkspace]);
  const currentWorkingRuns = currentRuns.filter((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const workingRunsKey = currentWorkingRuns.map((run) => `${run.id}:${run.status}`).join(",");
  const workingRuns = useMemo(() => currentWorkingRuns, [workingRunsKey]);
  const transcriptRunning = workingRuns.length > 0;
  const peopleAdded = useNewPeopleDuringRun({
    groupId: inGroup && !showToolActivity ? (groupId ?? undefined) : undefined,
    threadId: knownThreadId ?? undefined,
    running: transcriptRunning,
    refreshSignal: recruitingRefresh,
  });
  const workEstimate = useWorkEstimate({
    target: groupId ? { groupId } : active?.id ? { botId: active.id } : undefined,
    refreshSignal: `${workingRunsKey}:${recruitingRefresh}`,
  });
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  useEffect(() => {
    setPreloadRecoveryActiveWork(composerRunning);
    return () => setPreloadRecoveryActiveWork(false);
  }, [composerRunning]);
  // A reply whose worker stopped is queued again and resumes on its own; say so until it does.
  const resuming = currentRuns.some(
    (run) => requeuedRunIds.includes(run.id) && ["queued", "waiting_takeover"].includes(run.status),
  );
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const runErrorNeedsReconnect = Boolean(
    runError && runRecoveryAction(runError) === "model_connection",
  );
  /** The agent whose computer would not start, offered a fresh computer instead of a retry. */
  const runErrorComputerBotId =
    runError && runRecoveryAction(runError) === "computer"
      ? (activeSnapshot?.run?.botId ?? null)
      : null;
  const displayedRunError =
    !sendError && runError
      ? showToolActivity
        ? runError
        : runErrorNeedsReconnect
          ? t`Reconnect your model to continue.`
          : runErrorComputerBotId
            ? t`The computer could not start. Reset it to continue.`
            : t`The reply stopped. Try again.`
      : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots = useMemo(
    () =>
      workingRuns.map((run): GroupAvatarMember => {
        const bot = resolveTranscriptBot(run.botId);
        return {
          botId: run.botId,
          color: bot?.color ?? FALLBACK_BOT_COLOR,
          name: bot?.name,
          status: run.status,
        };
      }),
    [workingRuns, resolveTranscriptBot],
  );
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? t`You`
      : showToolActivity
        ? (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
        : "WeKruit"
    : undefined;
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [bots, groupId, groups, inGroup, mentionConnectors, mentionRoutines],
  );
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;

  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const botsForMentionsRef = useRef(bots);
  botsForMentionsRef.current = bots;

  useEffect(() => {
    const bots = botsForMentionsRef.current;
    if (!initialBotsLoaded || bots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      bots.map((bot) =>
        rpc.routines
          .list({ botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc.connections.list().catch(() => [] as Connection[]),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBotsLoaded, mentionBotsKey]);

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  useLayoutEffect(() => {
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !activeSnapshot || activeSnapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === activeSnapshot.threadId) return;
      if (expandedHistoryThread.current === activeSnapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !activeSnapshot || activeSnapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === activeSnapshot.threadId) return;
      if (expandedHistoryThread.current === activeSnapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = activeSnapshot.threadId;
  }, [
    active,
    groupId,
    inGroup,
    activeSnapshot?.botId,
    activeSnapshot?.groupId,
    activeSnapshot?.threadId,
  ]);

  const shellMessages = useShellMessages({
    navigate,
    loadOlderMessagesRef,
    jumpGeneration,
    setScrollRequest,
    activeGroupId,
    jumpToMessageRef,
    activeBotId,
    snapshotRef,
    validatedThreadEpoch,
    historyEpoch,
    refreshGroupThreadRef,
    refreshThreadRef,
    setSendError,
    pendingAttachments,
    setPendingAttachments,
    setAttachmentNotice,
    fileInputRef,
    sending,
    composerRef,
    botsRefreshUser,
    selectedCorrespondence,
    chatRoleTitle,
    selectedContact,
    currentRecruitingCacheScope,
    selectedSchedulingPlan,
    knownThreadId,
    currentCorrespondenceScope,
    discussionScope,
    botsRef,
    flushPendingBrowserNotifications,
    sendingRef,
    setSending,
    updateSnapshot,
    activeReplyTarget,
    activeReplyQuote,
    focusPromptBotIdRef,
    cancelFocusPrompt,
    clearReply,
    bootstrapMe,
    showToolActivity,
    terminalRunReceipts,
    refreshBots,
  });
  const { attachmentUploads, sendMessage } = shellMessages;
  const shellAgentActions = useShellAgentActions({
    showToolActivity,
    active,
    snapshot,
    callBotId: call?.botId,
    sending,
    sendingRef,
    setSending,
    activeBotId,
    activeGroupId,
    setSendError,
    updateSnapshot,
    refreshThreadRef,
    refreshGroupThreadRef,
    computerRef,
    commitComputer,
    teachBusy,
    taughtSkills,
    taughtSkillsBotId,
    setTeachBusy,
    setComputerOpen,
    setTaughtSkills,
    setTaughtSkillsBotId,
    setRoutineDraft,
    setRoutineWebhookSecret,
    setEditingRoutine,
    setPanel,
  });
  const newRoleAttachmentKey = JSON.stringify([
    "new-role",
    userId,
    bootstrapMe?.spaceId,
    roleSourceGroup?.id,
  ]);
  const shellCreation = useShellCreation({
    showToolActivity,
    pendingAttachments,
    newRoleAttachmentKey,
    botsRefreshUser,
    bootstrapMe,
    activeGroupId,
    activeBotId,
    discussionScope,
    userId,
    setCreatingGroup,
    setGroups,
    attachmentUploads,
    navigate,
    setPanel,
    setNewRoleSourceId,
    setNewRoleDescription,
    refreshBots,
    canCreateRoleFrom,
    setMobileSidebarOpen,
    setSendError,
    botsRef,
    setBots,
    cancelFocusPrompt,
    focusPromptAbortRef,
    focusPromptBotIdRef,
    sendingRef,
  });
  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  function openSettings(section: SettingsSection = "general") {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== active?.id) {
      cancelFocusPrompt();
    }
  }, [active?.id]);

  useEffect(() => () => cancelFocusPrompt(), []);

  useEffect(() => {
    if (panel !== "routine") {
      routineSaveRequest.current += 1;
      setRoutineError(null);
    }
  }, [panel]);

  useEffect(() => {
    if (!panelStorageKey) return;
    if (observedPanelKey.current !== panelStorageKey) {
      observedPanelKey.current = panelStorageKey;
      if (pendingExplicitPanel.current || explicitPanelTarget.current === panelStorageKey) {
        pendingExplicitPanel.current = false;
        explicitPanelTarget.current = null;
        pendingPanelRestore.current = null;
        setRestoredPanelKey(panelStorageKey);
        return;
      }
      explicitPanelTarget.current = null;
      // Reload starts with panel=null so storage restores. In-session chat switches used to
      // keep computer/settings open; only routine was cleared (handled above). Carry is
      // session-only — do not write the carried panel onto the destination's saved prefs.
      if (panel === "computer" || panel === "settings" || panel === "group-settings") {
        const carried = panel === "computer" ? "computer" : inGroup ? "group-settings" : "settings";
        pendingPanelRestore.current = null;
        if (carried !== panel) setPanelState(carried);
        setRestoredPanelKey(null);
        return;
      }
      pendingPanelRestore.current = readRightPanelState(panelStorageKey);
    }
    const saved = pendingPanelRestore.current;
    if (!saved) return;
    // Explicit routine links take precedence over a local layout preference.
    if (searchParams.has("routine")) {
      pendingPanelRestore.current = null;
      return;
    }
    if (saved.panel === "routine" && saved.routineId && routinesBotId !== active?.id) return;
    let next = saved.panel;
    if (next === "routine") {
      const routine = saved.routineId
        ? routines.find((item) => item.id === saved.routineId)
        : undefined;
      if (saved.routineId && !routine) next = "computer";
      setEditingRoutine(routine ?? null);
      setRoutineDraft(routine ? draftFromRoutine(routine) : emptyRoutineDraft());
      setRoutineWebhookSecret(null);
    }
    pendingPanelRestore.current = null;
    setPanelState(next);
    setRestoredPanelKey(panelStorageKey);
  }, [panelStorageKey, active?.id, inGroup, panel, routinesBotId, routines, searchParams]);

  useEffect(() => {
    // Do not gate writes on ?routine= staying in the URL — a stuck/failed routine
    // list would freeze layout prefs. Deep-link handling uses setPanelState for the
    // bot-switch close so restoredPanelKey stays unset until an intentional setPanel.
    if (!panelStorageKey || restoredPanelKey !== panelStorageKey || pendingPanelRestore.current)
      return;
    writeRightPanelState(panelStorageKey, panel, editingRoutine?.id);
  }, [panelStorageKey, restoredPanelKey, panel, editingRoutine?.id]);

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, clearReply, groupId, inGroup]);

  useEffect(() => {
    if (!showToolActivity) {
      setCommandPaletteOpen(false);
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showToolActivity]);

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const computerScreenError =
    computerError && !hideScreenLoadError ? (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
        <p className="text-destructive">{computerError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => computerBot && void refreshComputerScreen(computerBot.id)}
        >
          <Trans>Retry screen</Trans>
        </Button>
      </div>
    ) : null;
  const computerPreviewScreen =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const showingRecoveryHint =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    !computerPreviewScreen &&
    !computerScreenError &&
    showComputerRecoveryHint;

  const userName = session.data?.user.name ?? t`You`;
  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const newRoleAttachments = attachmentsForThread(pendingAttachments, newRoleAttachmentKey);
  return {
    ...shellAgentActions,
    ...shellCreation,
    ...shellNotifications,
    ...shellRoster,
    ...shellComputer,
    ...shellThreads,
    ...shellRecruiting,
    ...shellMessages,
    t,
    linkFavicons,
    botId,
    groupId,
    navigate,
    searchParams,
    setSearchParams,
    session,
    userId,
    archivedOpen,
    setArchivedOpen,
    setNewRoleSourceId,
    newRoleDescription,
    setNewRoleDescription,
    snapshot,
    botsSidebarDensity,
    enterToSend,
    pendingAttachments,
    replyTarget,
    setReplyTarget,
    replyQuote,
    setReplyQuote,
    sending,
    sendError,
    setSendError,
    exportingConversation,
    setExportingConversation,
    attachmentNotice,
    setAttachmentNotice,
    fileInputRef,
    panel,
    setPanelState,
    recruitingRefresh,
    setRecruitingRefresh,
    roleChatOpen,
    setRoleChatOpen,
    roleChatId,
    roleChatTrigger,
    roleChatSection,
    recruitingReadCache,
    setRestoredPanelKey,
    explicitPanelTarget,
    pendingPanelRestore,
    setPanel,
    peerConversation,
    setPeerConversation,
    routines,
    teachBusy,
    updateSnapshot,
    pluginsOpen,
    setPluginsOpen,
    mcpOpen,
    setMcpOpen,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    messagingSettingsOpen,
    setMessagingSettingsOpen,
    messagingSurfaceEnabled,
    messagingProviders,
    memoryProviderConfig,
    setMemoryProviderConfig,
    memoryProviderConfigRevision,
    dismissedRunErrorIds,
    menuOpen,
    setMenuOpen,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileSidebarSwipeRef,
    draggedBotId,
    setDraggedBotId,
    createMenuOpen,
    setCreateMenuOpen,
    botsSidebarCollapsed,
    botsSidebarEdgeDragRef,
    newSpaceOpen,
    setNewSpaceOpen,
    pickerInfoTopic,
    setPickerInfoTopic,
    commandPaletteOpen,
    setCommandPaletteOpen,
    activityMode,
    toggleActivityMode,
    botMenu,
    setBotMenu,
    botMenuAnchor,
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    deleteSpaceTarget,
    setDeleteSpaceTarget,
    renameSpaceTarget,
    setRenameSpaceTarget,
    spaceMenu,
    setSpaceMenu,
    spaceMenuAnchor,
    closeSpaceMenu,
    spaceMenuTarget,
    clearTarget,
    setClearTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    sectionMenu,
    setSectionMenu,
    sectionMenuAnchor,
    closeSectionMenu,
    loadingOlder,
    call,
    viewportWidth,
    botsSidebarWidth,
    setBotsSidebarWidth,
    botsSidebarMaxWidth,
    visibleSidebarWidth,
    roleChatWidth,
    setRoleChatWidth,
    roleChatMaxWidth,
    showComputerRecoveryHint,
    releaseComputerRecovery,
    holdComputerRecovery,
    routineDraft,
    setRoutineDraft,
    routineWebhookSecret,
    setRoutineWebhookSecret,
    editingRoutine,
    setEditingRoutine,
    deleteRoutineTarget,
    setDeleteRoutineTarget,
    savingRoutine,
    setSavingRoutine,
    runningRoutine,
    setRunningRoutine,
    routineError,
    setRoutineError,
    usage,
    refreshUsage,
    routineSavePending,
    ensureWebhookSecret,
    routineSaveRequest,
    routineRunPending,
    expandedHistoryThread,
    historyEpoch,
    scrollRequest,
    clearScrollRequest,
    messageScroll,
    pinnedAroundRef,
    inGroup,
    active,
    activeGroup,
    archivedRouteGroup,
    roleSourceGroup,
    canCreateRoleFrom,
    roleCrewBots,
    activePendingAttachments,
    activeRoutines,
    panelTarget,
    recordingSkill,
    activeBotId,
    contextBot,
    contextGroup,
    contextChat,
    closeBotMenu,
    activeReplyTarget,
    activeReplyQuote,
    clearReply,
    currentRuns,
    answerableAskIds,
    workingRuns,
    transcriptRunning,
    peopleAdded,
    workEstimate,
    composerRunning,
    resuming,
    runError,
    displayedRunError,
    displayedRunErrorId,
    runErrorNeedsReconnect,
    runErrorComputerBotId,
    handleRunErrorPresented,
    resolveTranscriptBot,
    workingBots,
    resolveTranscriptMemberName,
    replyTargetName,
    composerMentionTargets,
    shellReady,
    setBotsSidebarCollapsedPref,
    openSettings,
    dismissComposerError,
    embeddedScreenUrl,
    hasControl,
    computerScreenError,
    showingRecoveryHint,
    userName,
    initials,
    newRoleAttachmentKey,
    newRoleAttachments,
  };
}
