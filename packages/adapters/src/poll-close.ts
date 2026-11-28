import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import { pollWakePrompt } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { closePoll, submitConversationWakeOnce } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const POLL_WAKE_NONCE_PREFIX = "poll:";

/**
 * Closes a poll and wakes the bot that asked it in the same conversation. Not a scheduler of
 * its own: the wake is one input into that bot's session in the conversation.
 */
export async function closePollAndWake(
  deps: { prisma: PrismaClient; events: ThreadEvents },
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
  const sessionId = await deps.prisma.$transaction(async (tx) => {
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
    const submitted = await submitConversationWakeOnce(
      tx,
      { spaceId: closed.spaceId, userId: closed.userId, threadId: closed.threadId, botId },
      {
        kind: "message",
        trigger: "poll" satisfies RunTrigger,
        payload: { text: pollWakePrompt(closed.block), internal: true, wakeKey: clientNonce },
      },
    );
    return submitted?.sessionId ?? null;
  });
  if (!sessionId) return;
  // The input is durable; a lost wake is repaired by the session sweep.
  await deps.events.wakeSessions([sessionId]);
}
