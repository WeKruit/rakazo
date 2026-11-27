import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  endThreadWorkInTransaction,
  threadStopRunWhere,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

/**
 * The agent's stop, the way Claude Code's TaskStop and Pi's abort end a task and the work it
 * started: the model hears the person ask to stop and calls this; code never reads the words.
 * It ends this conversation's other turns and the searches still running for it, the same as
 * the stop button, and from the account-wide conversation also the work it handed to role teams
 * (branch play s151: "别搜了" was answered and the role's search kept reporting).
 */
export async function stopConversationWork(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: { id: string; spaceId: string; userId: string; threadId: string },
): Promise<{ stoppedTurns: number; conversations: number }> {
  // Role conversations this one handed work to that still have work running.
  const handed = await deps.prisma.thread.findMany({
    where: {
      id: { not: run.threadId },
      spaceId: run.spaceId,
      messages: {
        some: {
          role: "user",
          blocks: {
            array_contains: [{ kind: "bot_message_received", returnThreadId: run.threadId }],
          },
        },
      },
      OR: [
        { runs: { some: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
        {
          runs: {
            some: {
              userId: run.userId,
              effects: { some: { kind: "work_estimate", status: "running" } },
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  let stoppedTurns = 0;
  for (const threadId of [run.threadId, ...handed.map((thread) => thread.id)]) {
    const stopped = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      const cancelled = await tx.run.updateManyAndReturn({
        where: {
          ...threadStopRunWhere(threadId, undefined, "all"),
          id: { not: run.id },
        },
        data: { status: "cancelled", completedAt: new Date(), error: null },
        select: { id: true, botId: true, taskId: true },
      });
      await cancelRunsInTransaction(tx, cancelled, new Date());
      await endThreadWorkInTransaction(tx, {
        spaceId: run.spaceId,
        userId: run.userId,
        threadId,
        keepRunId: run.id,
        keepReminders: true,
      });
      let seq: number | null = null;
      for (const stoppedRun of cancelled)
        seq = (
          await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId,
            botId: stoppedRun.botId,
            type: "run.cancelled",
            runId: stoppedRun.id,
            payload: { stoppedByUserId: run.userId },
          })
        ).seq;
      if (cancelled.length)
        await tx.event.deleteMany({
          where: {
            type: "thread.progress",
            runId: { in: cancelled.map((item) => item.id) },
          },
        });
      return { count: cancelled.length, seq };
    });
    stoppedTurns += stopped.count;
    if (stopped.seq !== null)
      await deps.events.notify(threadId, stopped.seq).catch((error) => {
        getLogger().error("stop work realtime notification", error);
      });
  }
  return { stoppedTurns, conversations: 1 + handed.length };
}
