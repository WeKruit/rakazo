import { attachmentUploadKey, useShellMessages } from "./useShellMessages";
import { useShellRecruiting } from "./useShellRecruiting";
import { useShellRoster } from "./useShellRoster";
import { useShellThreads } from "./useShellThreads";

export { firstThreadRoute } from "./useShellRoster";

import { Trans, useLingui } from "@lingui/react/macro";
import { LinkFaviconsContext } from "@rakazo/chat-ui/web-lazy";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  ComputerMode,
  Connection,
  ConnectionCatalogItem,
  Group,
  ProductEvent,
  Routine,
  Space,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  UsageCosts,
  VoiceStatus,
} from "@rakazo/contracts";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import {
  answerableAskMessageIds,
  attachmentsForThread,
  buildComposerMentionOptions,
  isActive,
  isRunTerminalEvent,
  speechFromBlocks,
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
import { computersAreUnavailable } from "../../components/ComputersUnavailableHint";
import { readActivityMode, writeActivityMode } from "../../lib/activity-mode";
import { authClient } from "../../lib/auth";
import {
  getBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "../../lib/bots-sidebar-density-pref";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../../lib/bots-sidebar-pref";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  shouldNotifyBrowser,
} from "../../lib/browser-notifications";
import { useCallSession } from "../../lib/call-session";
import { createCoalescedRefresh } from "../../lib/coalesced-refresh";
import {
  getComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../../lib/composer-enter-to-send-pref";
import { embeddableScreenUrl } from "../../lib/computer-screen";
import { scheduleFocusPrompt } from "../../lib/focus-prompt";
import { clampWidth, usePaneWidth, useViewportWidth } from "../../lib/pane-width";
import { revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../../lib/performance";
import { setPreloadRecoveryActiveWork } from "../../lib/preload-recovery";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { clearRecruitingReads, revalidateRecruitingReads } from "../../lib/recruiting-read-cache";
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
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../../lib/run-error-storage";
import { sharedInflight } from "../../lib/shared-inflight";
import {
  activeThreadRuns,
  clearActiveThreadRuns,
  threadRunError,
  userHoldsComputerControl,
} from "../../lib/thread-events";
import { createThreadPrefetch } from "../../lib/thread-prefetch";
import { speaker } from "../../lib/tts";
import { errorText } from "../../lib/user-error";
import type { ContextMenuPosition } from "../BotContextMenu";
import type { RoutineDraftState } from "../RoutineList";
import { draftFromRoutine, emptyRoutineDraft } from "../RoutineList";
import type { SettingsSection } from "../SettingsOverlay";
import type { PendingAttachment } from "../shell/Composer";
import { isCommandPaletteHotkey } from "../shell/command-palette-hotkey";
import { FALLBACK_BOT_COLOR } from "../shell/constants";
import { memberName } from "../shell/group-members";
import { useShellComputer } from "./useShellComputer";

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
};

const RECONNECT_RECRUITING_RETRY_MS = 30_000;

export function eventChangesRecruitingPanel(
  event: Pick<ProductEvent, "type" | "payload">,
): boolean {
  if (event.type === "thread.message.created" && event.payload.role === "user")
    return (
      Array.isArray(event.payload.blocks) &&
      event.payload.blocks.some(
        (block) =>
          block && typeof block === "object" && block.kind === "text" && block.recruitingFeedback,
      )
    );
  if (event.type === "effect.recorded") {
    const result = event.payload.result;
    // A calibration round was recorded or accepted, or a people search was saved.
    if (
      (event.payload.tool === "recruiting_research" &&
        ("round" in event.payload || event.payload.status === "saved")) ||
      (event.payload.tool === "recruiting_feedback" &&
        result &&
        typeof result === "object" &&
        "round" in result)
    )
      return true;
    if (
      event.payload.tool === "recruiting_feedback" &&
      result &&
      typeof result === "object" &&
      "status" in result &&
      result.status === "recorded" &&
      "feedback" in result
    ) {
      const feedback = result.feedback;
      return (
        feedback !== null &&
        typeof feedback === "object" &&
        "target" in feedback &&
        feedback.target === "candidate" &&
        "operation" in feedback &&
        ["hold", "pass", "resume"].includes(String(feedback.operation))
      );
    }
    return (
      (event.payload.tool === "recruiting_role" &&
        event.payload.status === "saved" &&
        event.payload.changed === true) ||
      (event.payload.tool === "recruiting_crm_target" && event.payload.status === "connected") ||
      (event.payload.tool === "recruiting_shortlist" &&
        result !== null &&
        typeof result === "object" &&
        "kind" in result &&
        result.kind === "saved")
    );
  }
  // Connector reads refresh at run termination; the executor marks successful writes.
  if (event.type === "agent.tool.completed")
    return (
      event.payload.name === "recruiting_crm_import" ||
      event.payload.name === "recruiting_reply" ||
      (event.payload.wrote === true && event.payload.outcome === "succeeded")
    );
  return (
    (event.type.startsWith("recruiting.") &&
      event.type !== "recruiting.context.adopted" &&
      event.type !== "recruiting.material.read" &&
      event.type !== "recruiting.searches.planned" &&
      !(event.type === "recruiting.read" && event.payload.phase === "bound")) ||
    event.type === "memory.revised" ||
    event.type === "thread.cleared" ||
    isRunTerminalEvent(event)
  );
}

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
  const session = authClient.useSession();
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
  // A message sent during a reply interjects; it is queued until the reply takes it in.
  const [steer, setSteer] = useState<{ threadId: string; state: "queued" | "applied" } | null>(
    null,
  );
  const [requeuedRunIds, setRequeuedRunIds] = useState<string[]>([]);
  const observeRunSignal = useCallback(
    (event: { type: string; runId?: string | null; threadId?: string | null }) => {
      if (event.type === "run.steering.claimed")
        setSteer((current) =>
          current && current.threadId === event.threadId && current.state === "queued"
            ? { ...current, state: "applied" }
            : current,
        );
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
  const recruitingReadCache = useRef<RecruitingReadCache>({ entries: new Map(), epoch: 0 });
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
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
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
  const {
    groups,
    setGroups,
    groupsRef,
    bots,
    setBots,
    botsRef,
    botSections,
    spaces,
    setSpaces,
    archivedBots,
    archivedGroups,
    collapsedSidebarSections,
    collapsedRosterParents,
    query,
    setQuery,
    searchHits,
    setSearchHits,
    searchLoading,
    botsRefreshUser,
    initialBotsLoaded,
    bootstrapMe,
    setBootstrapMe,
    showToolActivity,
    refreshBots,
    applyRunStatus,
    sidebarGroups,
    openSpaceChat,
    reorderRosterBot,
    toggleSidebarSection,
    toggleRosterParent,
    showSpaceSearch,
  } = useShellRoster({
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

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
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
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

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
  const {
    computer,
    setComputer,
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
    computerViewport,
    computerError,
    setComputerError,
    computerErrorFromScreen,
    setComputerErrorFromScreen,
    computerBot,
    screenRequest,
    refreshComputerFor,
    refreshComputerScreen,
    openComputer,
    onOpenComputer,
    releaseComputer,
  } = useShellComputer({
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

  // Agent events arrive in bursts and reconnects repeat; re-read the workbench at most once a
  // second, and not at all while the page is hidden.
  const recruitingRefreshQueue = useRef<ReturnType<typeof createCoalescedRefresh>>(undefined);
  const lastRecruitingRefreshAt = useRef(0);
  /** Set when a resync could not reach the backend, whose workbench reads may have failed too. */
  const recruitingOutage = useRef(false);
  /** A reconnect re-reads the workbench only if it missed events, or to retry after a while. */
  const reconnectNeedsRecruitingRead = (
    before: { threadId: string; cursor: number } | null | undefined,
    fresh: { threadId: string; cursor: number },
  ) =>
    recruitingOutage.current ||
    before?.threadId !== fresh.threadId ||
    before.cursor !== fresh.cursor ||
    Date.now() - lastRecruitingRefreshAt.current >= RECONNECT_RECRUITING_RETRY_MS;
  useEffect(() => {
    const queue = createCoalescedRefresh(
      () => {
        lastRecruitingRefreshAt.current = Date.now();
        recruitingOutage.current = false;
        revalidateRecruitingReads(recruitingReadCache.current);
        setRecruitingRefresh((value) => value + 1);
      },
      { windowMs: 1_000 },
    );
    recruitingRefreshQueue.current = queue;
    return () => {
      queue.dispose();
      recruitingRefreshQueue.current = undefined;
    };
  }, []);
  const refreshRecruitingReads = useCallback(
    (threadId: string, spaceId: string | undefined) => {
      const current = snapshotRef.current;
      if (
        !userId ||
        !bootstrapMe?.spaceId ||
        botsRefreshUser.current.id !== userId ||
        (selectedSpaceId() ?? bootstrapMe.spaceId) !== bootstrapMe.spaceId ||
        spaceId !== bootstrapMe.spaceId ||
        threadId !== current?.threadId ||
        (activeGroupId.current
          ? current?.groupId !== activeGroupId.current
          : current?.botId !== activeBotId.current)
      )
        return;
      recruitingRefreshQueue.current?.request();
    },
    [bootstrapMe?.spaceId, userId],
  );
  const invalidateRecruiting = useCallback(
    (event: ProductEvent) => {
      if (eventChangesRecruitingPanel(event)) refreshRecruitingReads(event.threadId, event.spaceId);
    },
    [refreshRecruitingReads],
  );

  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const updateBotUnread = useCallback((id: string, unread: boolean) => {
    setBots((current) => {
      const bot = current.find((candidate) => candidate.id === id);
      if (!bot || bot.unread === unread) return current;
      return current.map((candidate) =>
        candidate.id === id ? { ...candidate, unread } : candidate,
      );
    });
  }, []);
  const markBotRead = useCallback(
    async (id: string) => {
      await rpc.threads.markRead({ botId: id });
      manuallyUnread.current.delete(id);
      updateBotUnread(id, false);
    },
    [updateBotUnread],
  );
  const markBotUnread = useCallback(
    async (id: string) => {
      manuallyUnread.current.add(id);
      try {
        await rpc.threads.markUnread({ botId: id });
      } catch (err) {
        manuallyUnread.current.delete(id);
        throw err;
      }
      updateBotUnread(id, true);
    },
    [updateBotUnread],
  );
  // A bot the user marked unread by hand stays unread until they open it again,
  // otherwise the auto-read below would undo the action on the next window focus.
  const markBotReadIfVisible = useCallback(
    (id: string) => {
      if (manuallyUnread.current.has(id)) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void markBotRead(id).catch(() => undefined);
      }
    },
    [markBotRead],
  );
  const deliverBrowserNotification = useCallback((pending: PendingBrowserNotification): boolean => {
    const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
    if (!currentBot || typeof Notification === "undefined") return true;
    const result = deliverNativeBrowserNotification(
      pending.event,
      currentBot.name || pending.botName,
      {
        enabled: pending.groupNotification || currentBot.notifyOnFinish,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: Notification.permission,
        notifiedEventIds: notifiedBrowserEvents.current,
        show: (title, body, tag) => new Notification(title, { body, tag }),
      },
    );
    return result !== "pending";
  }, []);
  const flushPendingBrowserNotifications = useCallback(() => {
    for (const [threadId, pending] of pendingBrowserNotifications.current) {
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(threadId);
      }
    }
  }, [deliverBrowserNotification]);
  const notifyBrowserForEvent = useCallback(
    (
      event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      enabled: boolean,
      groupNotification: boolean,
    ) => {
      const botId = event.botId;
      if (typeof botId !== "string") return;
      const eligible = shouldNotifyBrowser(event, {
        subscribedThreadId: subscribedThreadId ?? "",
        initialCursor,
        streamReady,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: "granted",
        notifiedEventIds: notifiedBrowserEvents.current,
      });
      if (!eligible || !enabled) return;
      const pending = {
        event,
        botId,
        botName,
        groupNotification,
      } satisfies PendingBrowserNotification;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(event.threadId, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(event.threadId);
      } else {
        pendingBrowserNotifications.current.set(event.threadId, pending);
      }
    },
    [deliverBrowserNotification],
  );

  const {
    prefetchThread,
    prefetchSidebarChat,
    refreshGroupThread,
    refreshThread,
    loadOlderMessages,
    jumpToSearchHit,
    jumpToMessage,
  } = useShellThreads({
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
  useEffect(() => {
    if (!showToolActivity) return;
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [showToolActivity]);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void rpc.voice
      .status()
      .then(setVoiceStatus)
      .catch(() => undefined);
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (call?.botId === active.id || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    void speaker.speak(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    call?.botId,
  ]);

  useEffect(() => {
    if (!active) return;
    // Opening a bot clears the manual unread flag so it can auto-read again.
    manuallyUnread.current.delete(active.id);
    const markVisibleBotRead = () => {
      markBotReadIfVisible(active.id);
    };
    markVisibleBotRead();
    window.addEventListener("focus", markVisibleBotRead);
    document.addEventListener("visibilitychange", markVisibleBotRead);
    return () => {
      window.removeEventListener("focus", markVisibleBotRead);
      document.removeEventListener("visibilitychange", markVisibleBotRead);
    };
  }, [active?.id, markBotReadIfVisible]);

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
  const {
    activeSnapshot,
    recruitingWorkspaceView,
    workspaceNewRole,
    crmMode,
    homeView,
    crmSelection,
    knownThreadId,
    recruitingCacheScope,
    boundRoleView,
    currentBindingRead,
    emptyCrmChat,
    composerDraftKey,
    boundRoleCrmMode,
    effectiveCrmSelection,
    workspaceCandidates,
    workspaceCorrespondence,
    workspaceFull,
    roleChatWorkspace,
    roleChatHidden,
    workspaceBrief,
    openRecruitingView,
    activeRecruitingTab,
    changeRecruitingTab,
    composerRef,
    correspondenceScope,
    currentCorrespondenceScope,
    selectedSchedulingPlan,
    setSelectedSchedulingPlan,
    selectedCorrespondence,
    selectCorrespondence,
    currentRecruitingCacheScope,
    selectedContact,
    chatContextApi,
    recruitingDetail,
    chatRoleTitle,
    sendFromComposer,
    openRoleChat,
    candidateFeedbackRecipients,
    discussionScope,
    draftCrmReply,
    discussCandidate,
    feedbackCandidate,
    sendRoleText,
    connectionMemberIds,
    recruitingConnectionBot,
    transcriptMessages,
    transcriptArtifactTarget,
    saveSequenceDraft,
    openingCrmRole,
    openCrmRole,
  } = useShellRecruiting({
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
  const answerableAskIds = answerableAskMessageIds(
    validatedThreadEpoch.current === historyEpoch.current &&
      (inGroup
        ? snapshotRef.current?.groupId === groupId
        : snapshotRef.current?.botId === active?.id)
      ? snapshotRef.current
      : null,
  );
  // A waiting question or confirmation reopens a collapsed role chat once per new card.
  const pendingAskKey = answerableAskIds.join(",");
  useEffect(() => {
    if (pendingAskKey && roleChatWorkspace) setRoleChatOpen(true);
  }, [pendingAskKey, roleChatWorkspace]);
  const workingRuns = currentRuns.filter((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  useEffect(() => {
    setPreloadRecoveryActiveWork(composerRunning);
    return () => setPreloadRecoveryActiveWork(false);
  }, [composerRunning]);
  // Only a reply that is still working takes an interjection; one waiting on a card does not.
  const composerRunningRef = useRef(transcriptRunning);
  composerRunningRef.current = transcriptRunning;
  const runningThreadId = transcriptRunning ? activeSnapshot?.threadId : undefined;
  const shownSteer = steer && steer.threadId === runningThreadId ? steer.state : null;
  // A reply whose worker stopped is queued again and resumes on its own; say so until it does.
  const resuming = currentRuns.some(
    (run) => requeuedRunIds.includes(run.id) && ["queued", "waiting_takeover"].includes(run.status),
  );
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError =
    !sendError && runError
      ? showToolActivity
        ? runError
        : t`Something went wrong. Try again.`
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
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      name: bot?.name,
      status: run.status,
    };
  });
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

  const {
    openBot,
    loadOlder,
    jumpToReplyMessage,
    answerMessage,
    reactToMessage,
    attachmentUploads,
    onAttachmentPick,
    removeAttachment,
    sendMessage,
  } = useShellMessages({
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
    composerRunningRef,
    showToolActivity,
    terminalRunReceipts,
    setSteer,
    refreshBots,
  });
  const stopRun = useCallback(
    async (runId?: string) => {
      if (sending) return;
      sendingRef.current = true;
      setSending(true);
      try {
        const botTarget = activeBotId.current;
        const groupTarget = activeGroupId.current;
        if (groupTarget) {
          setSendError(null);
          try {
            await rpc.threads.stop({
              groupId: groupTarget,
              ...(runId !== undefined ? { runId } : {}),
            });
          } catch (error) {
            if (activeGroupId.current === groupTarget) {
              setSendError(errorText(error, t`Failed to stop`));
            }
            return;
          }
          // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
          if (activeGroupId.current === groupTarget) {
            updateSnapshot((prev) =>
              prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev, runId) : prev,
            );
          }
          await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
          return;
        }
        if (!botTarget) return;
        setSendError(null);
        try {
          await rpc.threads.stop({ botId: botTarget, ...(runId !== undefined ? { runId } : {}) });
        } catch (error) {
          if (activeBotId.current === botTarget) {
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear local run/busy immediately rather than waiting for run.cancelled so a
        // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
        // blocked while the API is already idle.
        if (activeBotId.current === botTarget) {
          updateSnapshot((prev) =>
            !prev || (prev.botId !== botTarget && prev.botId)
              ? prev
              : clearActiveThreadRuns(prev, runId),
          );
          const currentComputer = computerRef.current;
          if (runId === undefined && currentComputer?.busyBotName) {
            commitComputer({ ...currentComputer, busyBotName: null });
          }
        }
        await refreshThreadRef.current(botTarget).catch(() => undefined);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [sending, t],
  );
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
  }, []);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setPanel("routine");
  }, []);
  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) void speaker.speak(text, { botId: id, messageId: message.id });
  }, []);

  const pendingRoleCreation = useRef<{
    key: string;
    group: Group;
    clientNonce: string;
    uploads: Map<string, { clientNonce: string; artifactId?: string }>;
  } | null>(null);
  async function createGroup(input: { name: string; botIds: string[]; description?: string }) {
    const attachments = showToolActivity
      ? []
      : attachmentsForThread(pendingAttachments, newRoleAttachmentKey);
    if (attachments.length && !input.description)
      input = {
        ...input,
        description: t`Use the attached files to define this role and start the search.`,
      };
    const submittedUser = botsRefreshUser.current;
    const submittedSpace = bootstrapMe?.spaceId;
    const submittedTarget = activeGroupId.current ?? activeBotId.current;
    const stillCurrent = () =>
      discussionScope.current.active &&
      discussionScope.current.panel === "create-group" &&
      submittedUser.id === userId &&
      botsRefreshUser.current === submittedUser &&
      (activeGroupId.current ?? activeBotId.current) === submittedTarget &&
      (selectedSpaceId() ?? submittedSpace) === submittedSpace;

    setCreatingGroup(true);
    try {
      const key = JSON.stringify([
        userId,
        bootstrapMe?.spaceId,
        input,
        attachments.map((item) => item.id),
      ]);
      let attempt =
        input.description && pendingRoleCreation.current?.key === key
          ? pendingRoleCreation.current
          : null;
      const group =
        attempt?.group ?? (await rpc.groups.create({ name: input.name, botIds: input.botIds }));
      if (input.description && !attempt) {
        attempt = {
          key,
          group,
          clientNonce: crypto.randomUUID(),
          uploads: new Map(
            attachments.map((pending) => [
              attachmentUploadKey(pending),
              { clientNonce: crypto.randomUUID() },
            ]),
          ),
        };
        pendingRoleCreation.current = attempt;
      }
      if (!stillCurrent()) throw new Error(t`The workspace changed. Open the role again.`);
      setGroups((current) =>
        current.some((item) => item.id === group.id) ? current : [group, ...current],
      );
      if (input.description && attempt) {
        const currentAttempt = attempt;
        const settled = await Promise.allSettled(
          attachments.map(async (pending) => {
            const id = attachmentUploadKey(pending);
            const upload = currentAttempt.uploads.get(id);
            if (!upload) throw new Error(t`The workspace changed. Open the role again.`);
            if (upload.artifactId) return;
            upload.artifactId = await attachmentUploads.current.resolveOne(
              { id, file: pending.file },
              { groupId: group.id },
              { clientNonce: upload.clientNonce },
            );
            attachmentUploads.current.discard(id);
          }),
        );
        const failed = settled.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
        const artifactIds = attachments.map((pending) => {
          const artifactId = currentAttempt.uploads.get(attachmentUploadKey(pending))?.artifactId;
          if (!artifactId) throw new Error(t`Could not upload file`);
          return artifactId;
        });
        if (!stillCurrent()) throw new Error(t`The workspace changed. Open the role again.`);
        await rpc.threads.followUp({
          groupId: group.id,
          text: input.description,
          ...(artifactIds.length ? { artifactIds } : {}),
          mentions: [input.botIds[0]!],
          clientNonce: currentAttempt.clientNonce,
        });
        pendingRoleCreation.current = null;
      }
      if (!stillCurrent()) return;
      navigate(`/app/g/${group.id}${input.description ? "?view=brief" : ""}`);
      setPanel(null);
      setNewRoleSourceId(null);
      setNewRoleDescription("");
      await refreshBots().catch(() => undefined);
    } finally {
      setCreatingGroup(false);
    }
  }

  function startNewRole(sourceId: string, description = "") {
    if (!canCreateRoleFrom(sourceId)) return;
    setNewRoleSourceId(sourceId);
    setNewRoleDescription(description);
    setPanel("create-group");
    setMobileSidebarOpen(false);
  }

  function restoreGroup(groupId: string) {
    return rpc.groups
      .restore({ groupId })
      .then(() => refreshBots(true))
      .catch((error) => setSendError(errorText(error, t`Could not continue`)));
  }

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

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const { normalizeCreateBotProfile } = await import("./shell-action-validation");
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      shouldSkip: () => sendingRef.current,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
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

  const newRoleAttachmentKey = JSON.stringify([
    "new-role",
    userId,
    bootstrapMe?.spaceId,
    roleSourceGroup?.id,
  ]);
  const newRoleAttachments = attachmentsForThread(pendingAttachments, newRoleAttachmentKey);
  return {
    t,
    linkFavicons,
    botId,
    groupId,
    navigate,
    searchParams,
    setSearchParams,
    session,
    userId,
    groups,
    setGroups,
    bots,
    setBots,
    botSections,
    spaces,
    setSpaces,
    archivedBots,
    archivedGroups,
    archivedOpen,
    setArchivedOpen,
    setNewRoleSourceId,
    newRoleDescription,
    setNewRoleDescription,
    collapsedSidebarSections,
    collapsedRosterParents,
    query,
    setQuery,
    searchHits,
    searchLoading,
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
    agentSkills,
    setAgentSkills,
    teachBusy,
    computer,
    setComputer,
    botsRefreshUser,
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
    voiceStatus,
    setVoiceStatus,
    speakingMessageId,
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
    booting,
    loadingOlder,
    initialBotsLoaded,
    bootstrapMe,
    setBootstrapMe,
    call,
    showToolActivity,
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
    computerOpen,
    setComputerOpen,
    computerViewport,
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
    computerBot,
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
    markBotRead,
    markBotUnread,
    refreshBots,
    prefetchThread,
    prefetchSidebarChat,
    refreshGroupThread,
    refreshThread,
    refreshAgentSkills,
    sidebarGroups,
    openSpaceChat,
    reorderRosterBot,
    toggleSidebarSection,
    toggleRosterParent,
    showSpaceSearch,
    jumpToSearchHit,
    activeSnapshot,
    recruitingWorkspaceView,
    workspaceNewRole,
    crmMode,
    homeView,
    crmSelection,
    knownThreadId,
    recruitingCacheScope,
    boundRoleView,
    currentBindingRead,
    emptyCrmChat,
    composerDraftKey,
    boundRoleCrmMode,
    effectiveCrmSelection,
    workspaceCandidates,
    workspaceCorrespondence,
    workspaceFull,
    roleChatWorkspace,
    roleChatHidden,
    workspaceBrief,
    openRecruitingView,
    activeRecruitingTab,
    changeRecruitingTab,
    composerRef,
    correspondenceScope,
    setSelectedSchedulingPlan,
    selectedCorrespondence,
    selectCorrespondence,
    chatContextApi,
    recruitingDetail,
    sendFromComposer,
    openRoleChat,
    candidateFeedbackRecipients,
    discussionScope,
    draftCrmReply,
    discussCandidate,
    feedbackCandidate,
    sendRoleText,
    activeReplyTarget,
    activeReplyQuote,
    clearReply,
    connectionMemberIds,
    recruitingConnectionBot,
    currentRuns,
    answerableAskIds,
    workingRuns,
    transcriptRunning,
    composerRunning,
    shownSteer,
    resuming,
    runError,
    displayedRunError,
    displayedRunErrorId,
    handleRunErrorPresented,
    transcriptMessages,
    transcriptArtifactTarget,
    saveSequenceDraft,
    resolveTranscriptBot,
    workingBots,
    resolveTranscriptMemberName,
    replyTargetName,
    composerMentionTargets,
    shellReady,
    openBot,
    loadOlder,
    jumpToReplyMessage,
    answerMessage,
    reactToMessage,
    onAttachmentPick,
    removeAttachment,
    openingCrmRole,
    openCrmRole,
    stopRun,
    stopTeaching,
    refreshActiveThread,
    refreshActiveTeaching,
    addSkillRoutine,
    speakMessage,
    createGroup,
    startNewRole,
    restoreGroup,
    setBotsSidebarCollapsedPref,
    openSettings,
    createBot,
    refreshComputerFor,
    openComputer,
    onOpenComputer,
    releaseComputer,
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
