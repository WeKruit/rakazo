import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerReleaseReason, ComputerStatus, ThreadSnapshot } from "@rakazo/contracts";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadComputerScreen } from "../../lib/computer-screen";
import type { Panel } from "../../lib/right-panel-state";
import { rpc } from "../../lib/rpc";
import {
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerTakeoverBlocked,
  userHoldsComputerControl,
} from "../../lib/thread-events";
import { errorText } from "../../lib/user-error";

export function useShellComputer({
  active,
  bots,
  botsRef,
  activeBotId,
  activeGroupId,
  panel,
  snapshot,
  refreshThread,
  refreshGroupThread,
}: {
  active: Bot | undefined;
  bots: Bot[];
  botsRef: RefObject<Bot[]>;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  panel: Panel;
  snapshot: ThreadSnapshot | null;
  refreshThread: (botId: string) => Promise<ThreadSnapshot | null>;
  refreshGroupThread: (groupId: string) => Promise<unknown>;
}) {
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);

  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>(),
  );
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
  }

  const [booting, setBooting] = useState(false);

  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const computerBootEpoch = useRef(0);
  const openComputerRef = useRef<(botId?: string) => Promise<boolean>>(async () => false);
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);

  const autoBooted = useRef<string | null>(null);

  const computerVisible = useRef(false);
  computerVisible.current = panel === "computer" || computerOpen;

  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? active?.id;

  const screenRequest = useRef(0);
  async function refreshComputerScreen(id: string) {
    if (!computerVisible.current) return null;
    const request = ++screenRequest.current;
    return loadComputerScreen({
      load: () => rpc.computer.screenUrl({ botId: id }),
      isCurrent: () =>
        request === screenRequest.current &&
        (activeBotId.current === id || computerBotIdRef.current === id) &&
        computerVisible.current,
      commit: (screen) => {
        setScreenUrl(screen.url);
        setComputerError(screen.error);
        setComputerErrorFromScreen(Boolean(screen.error));
        cacheComputerFor(id, { screenUrl: screen.url });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
  }

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    overlay,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (overlay && needsBoot) setBooting(true);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) {
        const status = await rpc.computer.boot({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
        commitComputer(status);
        cacheComputerFor(targetBotId, { computer: status });
      }
      if (takeControl) {
        await rpc.computer.takeover({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      await refreshComputerFor(targetBotId);
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(errorText(error, t`Could not take control`));
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBooting(false);
    }
  }

  async function refreshComputerFor(targetBotId: string) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId);
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (cancelled || activeBotId.current !== botId) return;
      const action = computerPanelAutoBoot(state, screen);
      if (action === "wait") {
        if (state === "running") autoBooted.current = botId;
        return;
      }
      if (action === "boot" && autoBooted.current === botId) return;
      autoBooted.current = botId;
      if (!computerPanelAutoUsesBoot(action)) return;
      await bootComputer({
        botId,
        takeControl: false,
        overlay: action === "boot",
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if ((panel !== "computer" && !computerOpen) || !heartbeatBotId || computer?.state !== "running")
      return;
    const ping = () =>
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 60_000);
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, computerBot?.id, active?.id, computer?.state]);

  /** Open the computer view. Only an explicit Take control asks for the lease. */
  async function openComputer(botId?: string, takeControl = false) {
    const id = botId ?? active?.id;
    if (!id) return false;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return false;
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    setComputerOpen(true);
    computerVisible.current = true;
    const needsTakeover = takeControl && !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, snapshot?.run?.status);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        overlay: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
      return true;
    } catch {
      // computerError already set in bootComputer
      return false;
    }
  }
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  async function releaseComputer(reason?: ComputerReleaseReason) {
    const botId = computerBotIdRef.current ?? activeBotId.current;
    if (!botId) return;
    try {
      await rpc.computer.release({ botId, reason });
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      await refreshComputerFor(botId).catch(() => undefined);
      const groupId = activeGroupId.current;
      if (groupId) {
        await refreshGroupThread(groupId).catch(() => undefined);
      }
    } catch {
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      setComputerError(t`Could not continue`);
      setComputerErrorFromScreen(false);
    }
  }

  return {
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
  };
}
