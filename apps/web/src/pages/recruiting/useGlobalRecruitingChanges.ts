import type { Group } from "@rakazo/contracts";
import { runThreadSubscription } from "@rakazo/core";
import { useEffect } from "react";
import { createCoalescedRefresh } from "../../lib/coalesced-refresh";
import { rpc } from "../../lib/rpc";
import { eventChangesRecruitingPanel } from "../shell/useShellRecruitingRefresh";

/**
 * Account pages (/app?view=inbox and the other all-roles views) have no conversation of their own,
 * so the shell listens to the first bot's chat while saved mail and other account-wide changes are
 * announced on Kruit's main conversation. Listen there too, so an open page re-reads when they land
 * (gate 63c860bb, send-at-night: mail went out while the Inbox was open and never appeared).
 */
export function useGlobalRecruitingChanges(
  groups: readonly Group[],
  routeGroupId: string | undefined,
  onChange: () => void,
) {
  const globalId = groups.find((group) => group.id.startsWith("recruiting-global-"))?.id;
  // The shell already follows the main conversation when it is the open one.
  const listen = globalId && globalId !== routeGroupId ? globalId : undefined;
  useEffect(() => {
    if (!listen) return;
    const abort = new AbortController();
    let head: { threadId: string; cursor: number } | null = null;
    const queue = createCoalescedRefresh(onChange, { windowMs: 1_000 });
    const readHead = async () =>
      (head = await rpc.threads.head({ groupId: listen }, { signal: abort.signal }));
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: readHead,
      loadHead: readHead,
      currentSnapshot: () => head,
      // A reconnect may have missed a change; read the page again.
      refresh: async () => {
        queue.request();
        return readHead();
      },
      subscribe: (cursor) =>
        rpc.threads.subscribe({ groupId: listen, cursor }, { signal: abort.signal }),
      applyEvent: (event) => {
        if (head) head = { threadId: head.threadId, cursor: event.seq };
      },
      onEvent: (event) => {
        if (eventChangesRecruitingPanel(event)) queue.request();
      },
    }).catch(() => {});
    return () => {
      abort.abort();
      queue.dispose();
    };
  }, [listen]);
}
