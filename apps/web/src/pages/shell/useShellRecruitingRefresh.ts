import type { Me, ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { isRunTerminalEvent } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import { createCoalescedRefresh } from "../../lib/coalesced-refresh";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { revalidateRecruitingReads } from "../../lib/recruiting-read-cache";
import { selectedSpaceId } from "../../lib/rpc";

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

export function useShellRecruitingRefresh({
  userId,
  bootstrapMe,
  botsRefreshUser,
  snapshotRef,
  activeGroupId,
  activeBotId,
  recruitingReadCache,
  setRecruitingRefresh,
}: {
  userId: string | undefined;
  bootstrapMe: Me | null | undefined;
  botsRefreshUser: RefObject<{ id: string | undefined }>;
  snapshotRef: RefObject<ThreadSnapshot | null>;
  activeGroupId: RefObject<string | undefined>;
  activeBotId: RefObject<string | undefined>;
  recruitingReadCache: RefObject<RecruitingReadCache>;
  setRecruitingRefresh: Dispatch<SetStateAction<number>>;
}) {
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

  return {
    recruitingOutage,
    reconnectNeedsRecruitingRead,
    refreshRecruitingReads,
    invalidateRecruiting,
  };
}
