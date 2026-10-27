import { ORPCError } from "@orpc/client";
import type {
  Bot,
  ComputerStatus,
  Group,
  Me,
  ProductEvent,
  Routine,
  SearchHit,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  isRunTerminalEvent,
  runThreadSubscription,
  searchHitThreadTarget,
  userVisibleMessages,
} from "@rakazo/core";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import { publishComputerCommand } from "../../lib/computer-workspace";
import { markOnce } from "../../lib/performance";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import {
  isComputerStatusEvent,
  isThreadSnapshotEvent,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
} from "../../lib/thread-events";
import { type createThreadPrefetch, threadPrefetchKey } from "../../lib/thread-prefetch";
import { transcriptCanSnapAfterFrame, transcriptIsNearEnd } from "../../lib/transcript-scroll";
import { observeThreadEvent } from "../../lib/turn-timing";

// Allow the API's transaction and pool waits when Postgres is remote.
const THREAD_SNAPSHOT_TIMEOUT_MS = 30_000;
function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

function applyThreadEvent(
  event: ProductEvent,
  commitSnapshot: (next: ThreadSnapshot | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: MutableRefObject<ThreadSnapshot | null>,
  computerRef: MutableRefObject<ComputerStatus | null>,
) {
  publishComputerCommand(event);
  if (isThreadSnapshotEvent(event)) {
    const next = reduceThreadSnapshot(snapshotRef.current, event);
    commitSnapshot(next);
  }
  if (isComputerStatusEvent(event)) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}

export function useShellThreads({
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
}: {
  messageScroll: RefObject<HTMLDivElement | null>;
  bootstrapMe: Me | null | undefined;
  userId: string | undefined;
  groupId: string | undefined;
  inGroup: boolean;
  active: Bot | undefined;
  threadPrefetch: RefObject<ReturnType<typeof createThreadPrefetch<ThreadSnapshot>>>;
  threadSnapshotCache: RefObject<Map<string, ThreadSnapshot>>;
  validatedThreadEpoch: RefObject<number | null>;
  commitSnapshot: (next: ThreadSnapshot | null) => void;
  historyEpoch: RefObject<number>;
  groupRefreshEpoch: RefObject<number>;
  activeGroupId: RefObject<string | undefined>;
  snapshotRef: RefObject<ThreadSnapshot | null>;
  computerRef: RefObject<ComputerStatus | null>;
  expandedHistoryThread: RefObject<string | null>;
  computerOpenRef: RefObject<boolean>;
  commitComputer: (next: ComputerStatus | null) => void;
  setRoutines: Dispatch<SetStateAction<Routine[]>>;
  setRoutinesBotId: Dispatch<SetStateAction<string | null>>;
  threadRefreshEpoch: RefObject<number>;
  activeBotId: RefObject<string | undefined>;
  cacheComputerFor: (
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) => void;
  refreshComputerScreen: (id: string) => Promise<string | null>;
  setTaughtSkills: Dispatch<SetStateAction<TaughtSkill[]>>;
  setTaughtSkillsBotId: Dispatch<SetStateAction<string | null>>;
  snapshot: ThreadSnapshot | null;
  loadingOlder: boolean;
  pinnedAroundRef: RefObject<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>;
  setLoadingOlder: Dispatch<SetStateAction<boolean>>;
  updateSnapshot: (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) => void;
  searchParamsRef: RefObject<URLSearchParams>;
  screenRequest: RefObject<number>;
  setComputerError: Dispatch<SetStateAction<string | null>>;
  setComputerErrorFromScreen: Dispatch<SetStateAction<boolean>>;
  computerCacheRef: RefObject<
    Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>
  >;
  setScreenUrl: Dispatch<SetStateAction<string | null>>;
  bootstrappedThread: RefObject<ThreadSnapshot | null>;
  recruitingOutage: RefObject<boolean>;
  reconnectNeedsRecruitingRead: (
    before: { threadId: string; cursor: number } | null | undefined,
    fresh: { threadId: string; cursor: number },
  ) => boolean;
  refreshRecruitingReads: (threadId: string, spaceId: string | undefined) => void;
  terminalRunReceipts: RefObject<Set<string>>;
  observeRunSignal: (event: {
    type: string;
    runId?: string | null;
    threadId?: string | null;
  }) => void;
  applyRunStatus: (event: ProductEvent) => void;
  invalidateRecruiting: (event: ProductEvent) => void;
  botsRef: RefObject<Bot[]>;
  notifyBrowserForEvent: (
    event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
    subscribedThreadId: string | undefined,
    initialCursor: number,
    streamReady: boolean,
    botName: string,
    enabled: boolean,
    groupNotification: boolean,
  ) => void;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  markBotReadIfVisible: (id: string) => void;
  activeGroup: Group | undefined;
  manuallyUnread: RefObject<Set<string>>;
  readVisibleGroups: RefObject<Set<string>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  computerBotIdRef: RefObject<string | undefined>;
  groupsRef: RefObject<Group[]>;
  newRoleNames: RefObject<string[]>;
  setQuery: Dispatch<SetStateAction<string>>;
  setSearchHits: Dispatch<SetStateAction<SearchHit[]>>;
  navigate: NavigateFunction;
  jumpGeneration: RefObject<number>;
  initiallyScrolledThread: RefObject<string | null>;
  setScrollRequest: Dispatch<SetStateAction<{ messageId: string; nonce: number } | null>>;
}) {
  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    window.requestAnimationFrame(() => {
      const element = messageScroll.current;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        queuedElement.scrollTop = queuedElement.scrollHeight;
      }
    });
  }

  function prefetchThread(target: { botId?: string; groupId?: string }, spaceId?: string) {
    const currentSpaceId = bootstrapMe?.spaceId;
    if (
      !userId ||
      !currentSpaceId ||
      spaceId !== currentSpaceId ||
      (selectedSpaceId() ?? currentSpaceId) !== currentSpaceId ||
      (target.groupId ? target.groupId === groupId : !inGroup && target.botId === active?.id)
    )
      return;
    threadPrefetch.current.prefetch(threadPrefetchKey(userId, currentSpaceId, target), () =>
      rpc.threads.get(target),
    );
  }

  function prefetchSidebarChat(item: { kind: string; chat: { id: string; spaceId: string } }) {
    prefetchThread(
      item.kind === "bot" ? { botId: item.chat.id } : { groupId: item.chat.id },
      item.chat.spaceId,
    );
  }

  async function readThreadSnapshot(
    target: { botId?: string; groupId?: string },
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
    opening = false,
  ) {
    try {
      const prefetched =
        opening && userId && bootstrapMe?.spaceId
          ? await threadPrefetch.current
              .take(threadPrefetchKey(userId, bootstrapMe.spaceId, target))
              ?.catch(() => undefined)
          : undefined;
      if (prefetched) return prefetched;
      return await rpc.threads.get(target, signal ? { signal } : undefined);
    } catch (error) {
      if (
        isCurrent() &&
        !signal?.aborted &&
        error instanceof ORPCError &&
        ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
      ) {
        threadSnapshotCache.current.delete(
          target.groupId ? `group:${target.groupId}` : `bot:${target.botId}`,
        );
        validatedThreadEpoch.current = null;
        commitSnapshot(null);
      }
      throw error;
    }
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal, opening = false) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++groupRefreshEpoch.current;
    const isCurrent = () =>
      activeGroupId.current === id &&
      epoch === historyEpoch.current &&
      request === groupRefreshEpoch.current;
    const snap = await readThreadSnapshot({ groupId: id }, signal, isCurrent, opening);
    markOnce("rk:renderer:thread-response");
    if (!isCurrent()) return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    validatedThreadEpoch.current = epoch;
    commitSnapshot(reconciled.snapshot);
    if (!computerOpenRef.current) commitComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(id: string, signal?: AbortSignal, opening = false) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const isCurrent = () =>
      activeBotId.current === id &&
      epoch === historyEpoch.current &&
      request === threadRefreshEpoch.current;
    const snap = await readThreadSnapshot({ botId: id }, signal, isCurrent, opening);
    markOnce("rk:renderer:thread-response");
    if (
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    validatedThreadEpoch.current = epoch;
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void Promise.all([
      rpc.routines.list({ botId: id }).catch(() => null),
      rpc.skills.list({ botId: id }).catch(() => null),
      refreshComputerScreen(id).catch(() => null),
    ]).then(([routines, skills]) => {
      if (
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (routines) {
        setRoutines(routines);
        setRoutinesBotId(id);
      }
      if (skills) {
        setTaughtSkills(skills);
        setTaughtSkillsBotId(id);
      }
    });
    return snap;
  }

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const before = snapshot.olderCursor;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        before,
      });
      if (
        epoch !== historyEpoch.current ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
      expandedHistoryThread.current = page.threadId;
      updateSnapshot((prev) => prependThreadMessagePage(prev, page));
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
    }
    screenRequest.current += 1;
    setComputerError(null);
    setComputerErrorFromScreen(false);
    const cached = computerCacheRef.current.get(active.id);
    if (cached) {
      // Paint the last-known computer instantly; refreshThread/refreshComputerScreen
      // below still run and reconcile with fresh data in the background.
      setScreenUrl(cached.screenUrl);
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
    expandedHistoryThread.current = null;
    const epoch = ++historyEpoch.current;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        if (primed?.botId === active.id) {
          validatedThreadEpoch.current = epoch;
          commitSnapshot({ ...primed });
          return primed;
        }
        return pendingJump
          ? readThreadSnapshot(
              { botId: active.id },
              threadSnapshotSignal(abort.signal),
              () => epoch === historyEpoch.current && activeBotId.current === active.id,
            )
          : refreshThread(active.id, threadSnapshotSignal(abort.signal), true);
      },
      loadHead: () =>
        rpc.threads.head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: async () => {
        const before = snapshotRef.current;
        const fresh = await refreshThread(active.id, threadSnapshotSignal(abort.signal)).catch(
          (error: unknown) => {
            if (!abort.signal.aborted) recruitingOutage.current = true;
            throw error;
          },
        );
        if (
          !abort.signal.aborted &&
          epoch === historyEpoch.current &&
          activeBotId.current === active.id
        )
          if (reconnectNeedsRecruitingRead(before, fresh))
            refreshRecruitingReads(fresh.threadId, bootstrapMe?.spaceId);
        return fresh;
      },
      currentSnapshot: () =>
        validatedThreadEpoch.current === historyEpoch.current ? snapshotRef.current : null,
      subscribe: (cursor) =>
        rpc.threads.subscribe({ botId: active.id, cursor }, { signal: abort.signal }),
      beforeEvent: (event) => {
        if (isRunTerminalEvent(event) && event.runId) {
          terminalRunReceipts.current.add(event.runId);
          if (terminalRunReceipts.current.size > 100) {
            const oldest = terminalRunReceipts.current.values().next().value;
            if (oldest !== undefined) terminalRunReceipts.current.delete(oldest);
          }
        }
      },
      applyEvent: (event) =>
        applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef),
      onEvent: (event, initial, sync) => {
        observeThreadEvent(event, initial.cursor);
        observeRunSignal(event);
        applyRunStatus(event);
        invalidateRecruiting(event);
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          currentBot?.name ?? active.name,
          currentBot?.notifyOnFinish ?? false,
          false,
        );
        if (event.type === "thread.cleared") {
          expandedHistoryThread.current = null;
          pinnedAroundRef.current = null;
          historyEpoch.current += 1;
        }
        if (event.type === "bot.archived") {
          void refreshBots(true).catch(() => undefined);
        } else if (
          event.type === "bot.spawned" ||
          event.type === "bot.deleted" ||
          event.type === "bot.updated" ||
          isRunTerminalEvent(event) ||
          event.type === "thread.cleared"
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (event.type === "thread.message.created") {
          const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
          if (blocks.some((block) => block.kind === "child_bot")) {
            void refreshBots().catch(() => undefined);
          }
          if (event.payload.role === "bot") markBotReadIfVisible(active.id);
        }
        if (sync?.snapshotStale || event.type === "skill.teaching.stopped") {
          // The event log already holds the run's final state unless something was not folded.
          void refreshThread(active.id).catch(() => undefined);
        } else if (isComputerStatusEvent(event)) {
          void refreshComputerScreen(active.id).catch(() => undefined);
        }
      },
    });
    return () => {
      abort.abort();
    };
  }, [
    active?.id,
    markBotReadIfVisible,
    notifyBrowserForEvent,
    invalidateRecruiting,
    refreshRecruitingReads,
  ]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      void rpc.threads
        .markRead({ groupId })
        .then(() => {
          setGroups((current) => {
            const group = current.find((candidate) => candidate.id === groupId);
            if (!group?.unread) return current;
            return current.map((candidate) =>
              candidate.id === groupId ? { ...candidate, unread: false } : candidate,
            );
          });
        })
        .catch(() => {
          readVisibleGroups.current.delete(groupId);
        });
    };
    markVisibleGroupRead();
    window.addEventListener("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
      expandedHistoryThread.current = null;
    }
    const epoch = ++historyEpoch.current;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        if (!pendingJump && primed?.groupId === groupId) {
          validatedThreadEpoch.current = epoch;
          commitSnapshot({ ...primed });
          return primed;
        }
        return pendingJump
          ? readThreadSnapshot(
              { groupId },
              threadSnapshotSignal(abort.signal),
              () => epoch === historyEpoch.current && activeGroupId.current === groupId,
            )
          : refreshGroupThread(groupId, threadSnapshotSignal(abort.signal), true);
      },
      loadHead: () => rpc.threads.head({ groupId }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: async () => {
        const before = snapshotRef.current;
        const fresh = await refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)).catch(
          (error: unknown) => {
            if (!abort.signal.aborted) recruitingOutage.current = true;
            throw error;
          },
        );
        if (
          !abort.signal.aborted &&
          epoch === historyEpoch.current &&
          activeGroupId.current === groupId
        )
          if (reconnectNeedsRecruitingRead(before, fresh))
            refreshRecruitingReads(fresh.threadId, bootstrapMe?.spaceId);
        return fresh;
      },
      currentSnapshot: () =>
        validatedThreadEpoch.current === historyEpoch.current ? snapshotRef.current : null,
      subscribe: (cursor) => rpc.threads.subscribe({ groupId, cursor }, { signal: abort.signal }),
      applyEvent: (event) =>
        applyThreadEvent(
          event,
          commitSnapshot,
          (next) => {
            if (isComputerStatusEvent(event) && event.botId !== computerBotIdRef.current) return;
            commitComputer(next);
          },
          snapshotRef,
          computerRef,
        ),
      onEvent: (event, initial, sync) => {
        observeThreadEvent(event, initial.cursor);
        observeRunSignal(event);
        applyRunStatus(event);
        invalidateRecruiting(event);
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          true,
        );
        if (event.type === "thread.message.created" && event.payload.role === "bot") {
          readVisibleGroups.current.delete(groupId);
          markVisibleGroupRead();
        }
        // A new role's group is renamed when its title is saved; show the title at once.
        const listed = groupsRef.current.find((group) => group.id === groupId);
        const placeholderName =
          event.type === "recruiting.changed" && newRoleNames.current.includes(listed?.name ?? "");
        // The sidebar marks a role that waits on the recruiter, and clears it once answered.
        const inputChanged =
          event.type === "run.waiting_input" ||
          (event.type === "run.started" && Boolean(listed?.needsInput));
        if (
          event.type === "bot.updated" ||
          isRunTerminalEvent(event) ||
          placeholderName ||
          inputChanged
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (sync?.snapshotStale) void refreshGroupThread(groupId).catch(() => undefined);
      },
    });
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [
    activeGroup?.id,
    groupId,
    notifyBrowserForEvent,
    invalidateRecruiting,
    refreshRecruitingReads,
  ]);

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  async function jumpToMessage(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = searchHitThreadTarget(target);
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      readThreadSnapshot(
        threadTarget,
        undefined,
        () =>
          epoch === historyEpoch.current &&
          jumpId === jumpGeneration.current &&
          (target.groupId
            ? activeGroupId.current === target.groupId
            : activeBotId.current === target.botId),
      ),
      rpc.threads.messages({ ...threadTarget, around: { messageId: target.messageId } }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = userVisibleMessages(page.messages, { includePeerReceipts: true }).some(
      (message) => message.id === target.messageId,
    );
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          messages: page.messages,
          olderCursor: page.olderCursor,
        }
      : null;
    if (targetInPage) initiallyScrolledThread.current = page.threadId;
    validatedThreadEpoch.current = epoch;
    commitSnapshot({
      ...snap,
      messages: targetInPage ? page.messages : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
    });
    if (threadTarget.botId) {
      commitComputer(snap.computer ?? null);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void rpc.routines
        .list({ botId: threadTarget.botId })
        .then((routines) => {
          if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
          if (activeBotId.current !== threadTarget.botId) return;
          setRoutines(routines);
          setRoutinesBotId(threadTarget.botId);
        })
        .catch(() => undefined);
    } else {
      commitComputer(null);
      setRoutines([]);
      setRoutinesBotId(null);
    }
    if (targetInPage) {
      // The transcript owns the scroll: it retries until the pinned row is
      // mounted and unfollows the tail, so live commits cannot cancel it.
      setScrollRequest({ messageId: target.messageId, nonce: jumpId });
    } else {
      window.requestAnimationFrame(() => {
        if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
      });
    }
  }

  return {
    prefetchThread,
    prefetchSidebarChat,
    refreshGroupThread,
    refreshThread,
    loadOlderMessages,
    jumpToSearchHit,
    jumpToMessage,
  };
}
