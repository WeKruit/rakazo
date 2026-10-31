import type { Bot, ProductEvent } from "@rakazo/contracts";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  shouldNotifyBrowser,
} from "../../lib/browser-notifications";
import { rpc } from "../../lib/rpc";

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
};

export function useShellNotifications({
  active,
  botsRef,
  setBots,
  manuallyUnread,
}: {
  active: Bot | undefined;
  botsRef: RefObject<Bot[]>;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  manuallyUnread: RefObject<Set<string>>;
}) {
  const notifiedBrowserEvents = useRef(new Set<string>());
  const browserNotificationShownAt = useRef(new Map<string, number>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
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
  const deliveringBrowserEvents = useRef(new Set<string>());
  const deliverBrowserNotification = useCallback(
    async (pending: PendingBrowserNotification): Promise<boolean> => {
      const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
      if (!currentBot || typeof Notification === "undefined") return true;
      if (Notification.permission === "default") return false;
      if (
        Notification.permission === "denied" ||
        !(pending.groupNotification || currentBot.notifyOnFinish)
      )
        return true;
      if (document.visibilityState === "visible" && document.hasFocus()) return true;
      if (deliveringBrowserEvents.current.has(pending.event.id)) return true;
      deliveringBrowserEvents.current.add(pending.event.id);
      try {
        // The server reservation survives reconnects and is shared with other tabs and phones.
        const { allowed } = await rpc.notifications.claimBrowser({
          threadId: pending.event.threadId,
          eventId: pending.event.id,
        });
        if (!allowed) return true;
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
            shownAt: browserNotificationShownAt.current,
          },
        );
        return result !== "pending";
      } catch {
        return false;
      } finally {
        deliveringBrowserEvents.current.delete(pending.event.id);
      }
    },
    [],
  );
  const flushPendingBrowserNotifications = useCallback(async () => {
    for (const [threadId, pending] of pendingBrowserNotifications.current) {
      if (
        (await deliverBrowserNotification(pending)) &&
        pendingBrowserNotifications.current.get(threadId) === pending
      ) {
        pendingBrowserNotifications.current.delete(threadId);
      }
    }
  }, [deliverBrowserNotification]);
  const notifyBrowserForEvent = useCallback(
    async (
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
      if (await deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(event.threadId);
      } else {
        pendingBrowserNotifications.current.set(event.threadId, pending);
      }
    },
    [deliverBrowserNotification],
  );

  useEffect(() => {
    // Mobile web must not suppress its own native phone notifications.
    if (
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    )
      return;
    const heartbeat = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void rpc.notifications.desktopActivity().catch(() => undefined);
      }
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 45_000);
    window.addEventListener("focus", heartbeat);
    document.addEventListener("visibilitychange", heartbeat);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", heartbeat);
      document.removeEventListener("visibilitychange", heartbeat);
    };
  }, []);

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

  return {
    markBotRead,
    markBotUnread,
    markBotReadIfVisible,
    flushPendingBrowserNotifications,
    notifyBrowserForEvent,
  };
}
