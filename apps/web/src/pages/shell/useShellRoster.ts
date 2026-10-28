import type {
  Bot,
  BotSection,
  Group,
  Me,
  ProductEvent,
  SearchHit,
  Space,
  SpaceMemoryConfig,
} from "@rakazo/contracts";
import { reorderBotTo } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NavigateFunction } from "react-router-dom";
import { takeInitialBootstrap } from "../../lib/bootstrap";
import {
  applyBotStatus,
  botStatusFromRunEvent,
  openBotStatusChannel,
} from "../../lib/bot-run-status";
import { markOnce } from "../../lib/performance";
import { retryTransientRead } from "../../lib/read-retry";
import { rpc, selectedSpaceId, selectSpace } from "../../lib/rpc";
import { getToolActivityEnabled, subscribeToolActivity } from "../../lib/tool-activity-preference";
import { sidebarGroupsForSpaces } from "../shell/space-sidebar";

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-sidebar-sections:${userId}`;
}

function collapsedRosterParentsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-roster-parents:${userId}`;
}

function readCollapsedIdSet(storageKey: string | null): Set<string> {
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function toggleCollapsedIdSet(
  previous: ReadonlySet<string>,
  id: string,
  storageKey: string | null,
): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (storageKey) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Keep the UI usable when storage is unavailable.
    }
  }
  return next;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedSidebarSectionsStorageKey(userId));
}

function readCollapsedRosterParents(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedRosterParentsStorageKey(userId));
}

export function firstThreadRoute(
  bots: readonly Pick<Bot, "id">[],
  groups: readonly Pick<Group, "id">[],
  recruiting = false,
): string {
  if (recruiting && groups[0]) return `/app/g/${groups[0].id}?view=home`;
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}
export function useShellRoster({
  userId,
  botId,
  groupId,
  navigate,
  searchParamsRef,
  memoryProviderConfigRevision,
  setMemoryProviderConfig,
  setMobileSidebarOpen,
  onBootstrapThread,
}: {
  userId: string | undefined;
  botId: string | undefined;
  groupId: string | undefined;
  navigate: NavigateFunction;
  searchParamsRef: RefObject<URLSearchParams>;
  memoryProviderConfigRevision: RefObject<number>;
  setMemoryProviderConfig: Dispatch<SetStateAction<SpaceMemoryConfig | null | undefined>>;
  setMobileSidebarOpen: (open: boolean) => void;
  onBootstrapThread: (bootstrap: Awaited<ReturnType<typeof takeInitialBootstrap>>) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const [bots, setBots] = useState<Bot[]>([]);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botOrderEpochRef = useRef(0);
  const pendingBotOrderRef = useRef<string[] | null>(null);
  const savingBotOrderRef = useRef(false);
  const [botSections, setBotSections] = useState<BotSection[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [archivedBots, setArchivedBots] = useState<Bot[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<Group[]>([]);
  const archivedGroupsRef = useRef(archivedGroups);
  archivedGroupsRef.current = archivedGroups;

  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  const [collapsedRosterParents, setCollapsedRosterParents] = useState(() => new Set<string>());

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
    setCollapsedRosterParents(readCollapsedRosterParents(userId));
  }, [userId]);

  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef<Promise<void> | null>(null);
  const pendingBotsRefresh = useRef<{
    user: { id: string | undefined };
    request: number;
    archivedRequest: number | null;
    includeArchived: boolean;
    replaceBotOrder: boolean;
  } | null>(null);
  const botsRefreshUser = useRef({ id: userId });
  if (botsRefreshUser.current.id !== userId) {
    botsRefreshUser.current = { id: userId };
    pendingBotsRefresh.current = null;
    botsRefreshEpoch.current++;
    archivedBotsRefreshEpoch.current++;
  }

  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();

  const showToolActivity = useSyncExternalStore(
    subscribeToolActivity,
    () => getToolActivityEnabled(bootstrapMe?.isDeploymentOwner === true),
    () => false,
  );

  const showToolActivityRef = useRef<boolean | null>(null);
  showToolActivityRef.current = bootstrapMe ? showToolActivity : null;

  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;

  const refreshBots = useCallback(
    (includeArchived = false, replaceBotOrder = false) => {
      const user = botsRefreshUser.current;
      if (!user.id) return Promise.resolve();
      const pending = pendingBotsRefresh.current;
      const request = ++botsRefreshEpoch.current;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      // ponytail: retain one pending refresh in this shell; merge triggers, never candidate data.
      pendingBotsRefresh.current = {
        user,
        request,
        archivedRequest:
          archivedRequest ?? (pending?.user === user ? pending.archivedRequest : null),
        includeArchived: includeArchived || (pending?.user === user && pending.includeArchived),
        replaceBotOrder: replaceBotOrder || (pending?.user === user && pending.replaceBotOrder),
      };
      if (botsRefreshInFlight.current) return botsRefreshInFlight.current;
      const refreshing = Promise.resolve().then(async () => {
        try {
          while (pendingBotsRefresh.current) {
            const { user, request, archivedRequest, includeArchived, replaceBotOrder } =
              pendingBotsRefresh.current;
            pendingBotsRefresh.current = null;
            if (user !== botsRefreshUser.current) continue;
            markOnce("rk:renderer:bots-request-start");
            const botOrderEpoch = botOrderEpochRef.current;
            const preserveBotOrder =
              savingBotOrderRef.current || pendingBotOrderRef.current !== null;
            const requests = [
              rpc.spaces.list(),
              includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
              includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
            ] as const;
            try {
              const [navigation, archived, archivedGroupList] = await Promise.all(requests);
              if (user !== botsRefreshUser.current) continue;
              const { bots: list, botSections: sections, groups: groupList } = navigation.current;
              markOnce("rk:renderer:bots-response");
              const botsFresh = request === botsRefreshEpoch.current;
              const archivedFresh =
                archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
              if (!botsFresh && replaceBotOrder && botOrderEpoch === botOrderEpochRef.current) {
                const pending =
                  pendingBotsRefresh.current as (typeof pendingBotsRefresh)["current"];
                if (pending?.user === user) pending.replaceBotOrder = true;
              }
              if (!botsFresh && !archivedFresh) continue;
              if (archivedFresh && archived) setArchivedBots(archived);
              if (archivedFresh && archivedGroupList) setArchivedGroups(archivedGroupList);
              if (!botsFresh) continue;
              if (
                botOrderEpoch === botOrderEpochRef.current &&
                (replaceBotOrder || (!preserveBotOrder && !savingBotOrderRef.current))
              ) {
                setBots(list);
              }
              setBotSections(sections);
              setGroups(groupList);
              setSpaces(navigation.spaces);
              setInitialBotsLoaded(true);
              botsRefreshApplied.current = request;
              if (
                includeArchived &&
                list.length === 0 &&
                archived?.length === 0 &&
                groupList.length === 0 &&
                archivedGroupList?.length === 0 &&
                !navigation.spaces.some((space) => space.hasContent)
              ) {
                navigate("/onboarding", { replace: true });
                continue;
              }
              const developerView = showToolActivityRef.current;
              if (developerView === null) continue;
              const currentGroupId = routeGroupId.current;
              if (currentGroupId) {
                if (
                  !groupList.some((group) => group.id === currentGroupId) &&
                  !(archivedGroupList ?? archivedGroupsRef.current).some(
                    (group) => group.id === currentGroupId,
                  )
                ) {
                  navigate(firstThreadRoute(list, groupList, !developerView), {
                    replace: true,
                  });
                }
                continue;
              }
              const currentBotId = routeBotId.current;
              if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
                navigate(firstThreadRoute(list, groupList, !developerView), {
                  replace: true,
                });
              }
            } catch (error) {
              await Promise.allSettled(requests);
              // Other callers can enqueue while this failed batch settles.
              const pending = pendingBotsRefresh.current as (typeof pendingBotsRefresh)["current"];
              if (!pending) throw error;
              if (pending.user === user) {
                pending.includeArchived ||= includeArchived;
                pending.replaceBotOrder ||= replaceBotOrder;
                pending.archivedRequest ??= archivedRequest;
              }
            }
          }
        } finally {
          botsRefreshInFlight.current = null;
        }
      });
      botsRefreshInFlight.current = refreshing;
      return refreshing;
    },
    [navigate],
  );
  // Run events update the sidebar in place and reach this user's other tabs at once.
  const botStatusChannel = useRef<ReturnType<typeof openBotStatusChannel> | null>(null);
  useEffect(() => {
    const spaceId = bootstrapMe?.spaceId;
    if (!userId || !spaceId) return;
    const channel = openBotStatusChannel({ userId, spaceId }, ({ botId, status }) => {
      setBots((current) => applyBotStatus(current, botId, status));
      // The finished run's preview and error badge come from the navigation read.
      if (status === "idle") void refreshBots().catch(() => undefined);
    });
    botStatusChannel.current = channel;
    return () => {
      channel.close();
      botStatusChannel.current = null;
    };
  }, [userId, bootstrapMe?.spaceId, refreshBots]);
  const applyRunStatus = useCallback((event: ProductEvent) => {
    const status = botStatusFromRunEvent(event);
    if (!status) return;
    setBots((current) => applyBotStatus(current, event.botId, status));
    botStatusChannel.current?.post({ botId: event.botId, status });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrapAbort = new AbortController();
    const user = { id: userId };
    botsRefreshUser.current = user;
    let bootstrapReady = false;
    let refreshTimer: number | undefined;
    const canRefresh = () =>
      !cancelled &&
      bootstrapReady &&
      botsRefreshUser.current === user &&
      document.visibilityState === "visible" &&
      document.hasFocus();
    const scheduleRefresh = (delay = 15_000) => {
      window.clearTimeout(refreshTimer);
      if (!canRefresh()) return;
      // ponytail: active-thread events miss other clients' roles; reconcile only while focused.
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (!canRefresh()) return;
        void (botsRefreshInFlight.current ?? refreshBots())
          .catch(() => undefined)
          .finally(() => scheduleRefresh());
      }, delay);
    };
    const refreshVisibleBots = () => scheduleRefresh(50);
    const providerConfigRevision = memoryProviderConfigRevision.current;
    void rpc.memory
      .providerConfig()
      .then((providerConfig) => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(providerConfig);
        }
      })
      .catch(() => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(null);
        }
      });
    const appliedAtStart = botsRefreshApplied.current;
    void takeInitialBootstrap(botId, groupId)
      .then((bootstrap) => {
        if (cancelled || botsRefreshUser.current !== user) return;
        const groupList = bootstrap.groups;
        const recruiting = !getToolActivityEnabled(bootstrap.me.isDeploymentOwner === true);
        showToolActivityRef.current = !recruiting;
        setBootstrapMe(bootstrap.me);
        // Skip list/route writes only if a later refreshBots() successfully
        // committed (failed refreshes bump epoch but not botsRefreshApplied).
        const applyBotLists = appliedAtStart === botsRefreshApplied.current;
        if (applyBotLists) {
          setBots(bootstrap.bots);
          setBotSections(bootstrap.botSections);
          setArchivedBots(bootstrap.archivedBots);
          setArchivedGroups(bootstrap.archivedGroups);
          setGroups(groupList);
          setSpaces(bootstrap.spaces);
          setInitialBotsLoaded(true);
        }
        const selectedThread =
          bootstrap.thread &&
          (groupId
            ? routeGroupId.current === groupId && bootstrap.thread.groupId === groupId
            : !routeGroupId.current &&
              routeBotId.current === botId &&
              bootstrap.thread.botId === botId);
        if (
          applyBotLists &&
          selectedThread &&
          bootstrap.thread &&
          !(groupId && searchParamsRef.current.get("m"))
        ) {
          onBootstrapThread(bootstrap);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        if (!applyBotLists) return;
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
        ) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (routeGroupId.current) {
          // An archived role's link shows that role as archived, never a different role.
          if (
            !groupList.some((group) => group.id === routeGroupId.current) &&
            !bootstrap.archivedGroups.some((group) => group.id === routeGroupId.current)
          ) {
            navigate(firstThreadRoute(bootstrap.bots, groupList, recruiting), { replace: true });
          }
          return;
        }
        if (!bootstrap.bots.some((bot) => bot.id === routeBotId.current)) {
          navigate(firstThreadRoute(bootstrap.bots, groupList, recruiting), { replace: true });
        }
      })
      .catch(() => {
        if (cancelled || botsRefreshUser.current !== user) return;
        setBootstrapMe(null);
        showToolActivityRef.current = null;
        const spaceId = selectedSpaceId();
        // A deploy can refuse requests for about a minute; keep trying until the account answers.
        return retryTransientRead(() => rpc.me(), bootstrapAbort.signal)
          .then((me) => {
            if (
              cancelled ||
              botsRefreshUser.current !== user ||
              me.userId !== user.id ||
              spaceId !== selectedSpaceId() ||
              (spaceId !== null && me.spaceId !== spaceId)
            )
              return;
            setBootstrapMe(me);
            showToolActivityRef.current = getToolActivityEnabled(me.isDeploymentOwner === true);
            return refreshBots(true);
          })
          .catch(() => undefined);
      })
      .finally(() => {
        bootstrapReady = true;
        scheduleRefresh();
      });
    window.addEventListener("focus", refreshVisibleBots);
    window.addEventListener("blur", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    return () => {
      cancelled = true;
      bootstrapAbort.abort();
      botsRefreshUser.current = { id: undefined };
      pendingBotsRefresh.current = null;
      botsRefreshEpoch.current++;
      archivedBotsRefreshEpoch.current++;
      window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", refreshVisibleBots);
      window.removeEventListener("blur", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);

  const sidebarGroups = useMemo(() => {
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canRename: false,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    return sidebarGroupsForSpaces(sidebarSpaces, query);
  }, [bootstrapMe, botSections, bots, groups, spaces, query]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      setMobileSidebarOpen(false);
      const previousSpaceId = selectedSpaceId();
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      const selectionStored = selectSpace(spaceId);
      if (!selectionStored) return;
      const previousEffective = previousSpaceId ?? bootstrapMe?.spaceId;
      const boundaryChanged = previousEffective !== spaceId;
      // Soft-navigate within the same space; reload only when the auth boundary changes
      // so bootstrapped bots/groups match the request header.
      if (boundaryChanged) {
        window.location.assign(path);
        return;
      }
      navigate(path);
    },
    [bootstrapMe?.spaceId, navigate],
  );
  const flushBotOrder = useCallback(async () => {
    if (savingBotOrderRef.current) return;
    savingBotOrderRef.current = true;
    try {
      while (pendingBotOrderRef.current) {
        const botIds = pendingBotOrderRef.current;
        pendingBotOrderRef.current = null;
        try {
          await rpc.bots.reorder({ botIds });
        } catch {
          // Keep a newer order queued during this failed save; only roll back
          // when nothing else is pending.
          if (pendingBotOrderRef.current === null) {
            await refreshBots(false, true).catch(() => undefined);
          }
        }
      }
    } finally {
      savingBotOrderRef.current = false;
      // A reorder may have arrived while saving=true and returned early.
      if (pendingBotOrderRef.current) {
        void flushBotOrder();
      }
    }
  }, [refreshBots]);
  const reorderRosterBot = useCallback(
    (sourceId: string, targetId: string, groupBotIds: string[]) => {
      if (!groupBotIds.includes(sourceId) || !groupBotIds.includes(targetId)) return;
      const current = botsRef.current;
      const reordered = reorderBotTo(current, sourceId, targetId);
      if (reordered === current) return;
      const next = [...reordered];
      botOrderEpochRef.current += 1;
      botsRef.current = next;
      setBots(next);
      pendingBotOrderRef.current = next.map((bot) => bot.id);
      void flushBotOrder();
    },
    [flushBotOrder],
  );
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) =>
        toggleCollapsedIdSet(previous, key, collapsedSidebarSectionsStorageKey(userId)),
      );
    },
    [userId],
  );
  const toggleRosterParent = useCallback(
    (botId: string) => {
      setCollapsedRosterParents((previous) =>
        toggleCollapsedIdSet(previous, botId, collapsedRosterParentsStorageKey(userId)),
      );
    },
    [userId],
  );
  const spaceQuery = query.trim();
  const showSpaceSearch = spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showSpaceSearch, spaceQuery]);

  return {
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
  };
}
