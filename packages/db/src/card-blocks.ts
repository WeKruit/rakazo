import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";

/** A bot message holding a live card (poll, canvas) that later actions rewrite in place. */
export type CardMessage = {
  id: string;
  threadId: string;
  botId: string | null;
  blocks: MessageBlock[];
  thread: { spaceId: string; userId: string; botId: string | null; groupId: string | null };
};

/**
 * Finds the message whose blocks contain `match` and locks its thread row, which serializes
 * every change to that conversation's cards.
 */
export async function lockedCardMessage(
  tx: Prisma.TransactionClient,
  where: { messageId?: string; threadId?: string; match: Record<string, string> },
): Promise<CardMessage | null> {
  const found = await tx.message.findFirst({
    where: {
      ...(where.messageId ? { id: where.messageId } : {}),
      ...(where.threadId ? { threadId: where.threadId } : {}),
      blocks: { array_contains: [where.match] },
    },
    select: { id: true, threadId: true },
  });
  if (!found) return null;
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${found.threadId} FOR UPDATE`;
  const message = await tx.message.findUnique({
    where: { id: found.id },
    select: {
      id: true,
      threadId: true,
      botId: true,
      blocks: true,
      thread: { select: { spaceId: true, userId: true, botId: true, groupId: true } },
    },
  });
  return message ? { ...message, blocks: message.blocks as MessageBlock[] } : null;
}

/** Saves the message's new blocks and tells every open client; returns the event seq. */
export async function rewriteCardMessage(
  tx: Prisma.TransactionClient,
  message: CardMessage,
  blocks: MessageBlock[],
): Promise<number> {
  const botId = message.botId ?? message.thread.botId;
  if (!botId) throw new Error("A live card always belongs to a bot message.");
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const event = await appendEventInTransaction(tx, {
    spaceId: message.thread.spaceId,
    threadId: message.threadId,
    botId,
    type: "thread.message.updated",
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return event.seq;
}
