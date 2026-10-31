import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import { pollWakePrompt } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { closePoll } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const POLL_WAKE_NONCE_PREFIX = "poll:";

/**
 * Closes a poll and wakes the bot that asked it in the same conversation. Not a scheduler of
 * its own: the wake is one ordinary queued run behind the conversation's other work.
 */
export async function closePollAndWake(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue">; events: ThreadEvents },
  payload: BackgroundJobPayloads["poll.close"],
): Promise<void> {
  const closed = await closePoll(deps.prisma, payload);
  if (!closed) return;
  await deps.events.notify(closed.threadId, closed.eventSeq).catch((error) => {
    getLogger().error("poll close realtime notification", error);
  });
  const botId = closed.askerBotId;
  if (!botId) return;
  const clientNonce = `${POLL_WAKE_NONCE_PREFIX}${closed.block.pollId}`;
  const runId = await deps.prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findUnique({
      where: { id: closed.threadId },
      select: { botId: true, groupId: true },
    });
    if (!thread) return null;
    const member = thread.groupId
      ? await tx.chatGroupMember.findFirst({
          where: { groupId: thread.groupId, botId, bot: { archivedAt: null } },
          select: { botId: true },
        })
      : thread.botId === botId;
    if (!member) return null;
    const earlier = await tx.run.findFirst({
      where: { spaceId: closed.spaceId, clientNonce },
      select: { id: true },
    });
    if (earlier) return null;
    const task = await tx.task.create({
      data: {
        spaceId: closed.spaceId,
        botId,
        threadId: closed.threadId,
        userId: closed.userId,
        prompt: pollWakePrompt(closed.block),
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: closed.spaceId,
        botId,
        threadId: closed.threadId,
        userId: closed.userId,
        taskId: task.id,
        status: "queued",
        trigger: "poll" satisfies RunTrigger,
        clientNonce,
      },
    });
    return run.id;
  });
  if (!runId) return;
  // The existing run reconciler recovers a queued run after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(runId)).catch(() => {
    getLogger().warn("poll wake deferred to reconciliation");
  });
}
