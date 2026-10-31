import type { MessageBlock, PollBlock, PollVote } from "@rakazo/contracts";
import { applyPollVote, pollEveryoneVoted } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { withTransactionRetry } from "./transaction-retry.js";

type PollMessage = {
  id: string;
  threadId: string;
  botId: string | null;
  blocks: MessageBlock[];
  thread: { spaceId: string; userId: string; botId: string | null; groupId: string | null };
};

function isPoll(block: MessageBlock, pollId: string): block is PollBlock {
  return block.kind === "poll" && block.pollId === pollId;
}

export function pollOf(blocks: MessageBlock[], pollId: string): PollBlock | undefined {
  return blocks.find((block): block is PollBlock => isPoll(block, pollId));
}

async function lockedPollMessage(
  tx: Prisma.TransactionClient,
  where: { messageId?: string; threadId?: string; pollId: string },
): Promise<PollMessage | null> {
  const found = await tx.message.findFirst({
    where: {
      ...(where.messageId ? { id: where.messageId } : {}),
      ...(where.threadId ? { threadId: where.threadId } : {}),
      blocks: { array_contains: [{ kind: "poll", pollId: where.pollId }] },
    },
    select: { id: true, threadId: true },
  });
  if (!found) return null;
  // The thread row serializes every vote and the close of one conversation's polls.
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

/** The other assistants in the conversation a team poll also waits for. */
async function teamBotIds(tx: Prisma.TransactionClient, message: PollMessage): Promise<string[]> {
  if (!message.thread.groupId) return [];
  const members = await tx.chatGroupMember.findMany({
    where: { groupId: message.thread.groupId, bot: { archivedAt: null } },
    select: { botId: true },
  });
  return members.map((member) => member.botId).filter((id) => id !== message.botId);
}

async function rewritePoll(
  tx: Prisma.TransactionClient,
  message: PollMessage,
  next: PollBlock,
): Promise<number> {
  const botId = message.botId ?? message.thread.botId;
  if (!botId) throw new Error("A poll card always belongs to a bot message.");
  const blocks = message.blocks.map((block) => (isPoll(block, next.pollId) ? next : block));
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

export type PollVoteResult =
  | {
      ok: true;
      block: PollBlock;
      messageId: string;
      threadId: string;
      eventSeq: number;
      /** Everyone the poll waits for has voted. */
      complete: boolean;
    }
  | { ok: false; error: string };

/**
 * Records a vote by the conversation's owner or one of its member bots. The caller has already
 * resolved the thread for this actor; the poll must live in that thread.
 */
export async function votePoll(
  prisma: PrismaClient,
  input: { threadId: string; pollId: string; vote: PollVote; now?: Date },
): Promise<PollVoteResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const message = await lockedPollMessage(tx, {
        threadId: input.threadId,
        pollId: input.pollId,
      });
      const poll = message && pollOf(message.blocks, input.pollId);
      if (!message || !poll) return { ok: false as const, error: "No such poll here." };
      if (input.vote.voter === "user" && input.vote.voterId !== message.thread.userId)
        return { ok: false as const, error: "No such poll here." };
      if (input.vote.voter === "bot" && input.vote.voterId === message.botId)
        return { ok: false as const, error: "You asked this poll; the others vote on it." };
      const applied = applyPollVote(poll, input.vote, input.now ?? new Date());
      if (!applied.ok) return applied;
      const eventSeq = await rewritePoll(tx, message, applied.block);
      const complete = pollEveryoneVoted(applied.block, {
        userId: message.thread.userId,
        botIds: await teamBotIds(tx, message),
      });
      return {
        ok: true as const,
        block: applied.block,
        messageId: message.id,
        threadId: message.threadId,
        eventSeq,
        complete,
      };
    }),
  );
}

export type ClosedPoll = {
  block: PollBlock;
  messageId: string;
  threadId: string;
  spaceId: string;
  userId: string;
  /** The bot that asked, woken with the result. */
  askerBotId: string | null;
  eventSeq: number;
};

/** Closes an open poll once; a second close returns null. */
export async function closePoll(
  prisma: PrismaClient,
  input: { messageId: string; pollId: string },
): Promise<ClosedPoll | null> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const message = await lockedPollMessage(tx, input);
      const poll = message && pollOf(message.blocks, input.pollId);
      if (!message || !poll || poll.status === "closed") return null;
      const block: PollBlock = { ...poll, status: "closed" };
      const eventSeq = await rewritePoll(tx, message, block);
      return {
        block,
        messageId: message.id,
        threadId: message.threadId,
        spaceId: message.thread.spaceId,
        userId: message.thread.userId,
        askerBotId: message.botId,
        eventSeq,
      };
    }),
  );
}
