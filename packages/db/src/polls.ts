import type { MessageBlock, PollBlock, PollVote } from "@rakazo/contracts";
import { applyPollVote, pollEveryoneVoted } from "@rakazo/core";
import type { CardMessage } from "./card-blocks.js";
import { lockedCardMessage, rewriteCardMessage } from "./card-blocks.js";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

function isPoll(block: MessageBlock, pollId: string): block is PollBlock {
  return block.kind === "poll" && block.pollId === pollId;
}

export function pollOf(blocks: MessageBlock[], pollId: string): PollBlock | undefined {
  return blocks.find((block): block is PollBlock => isPoll(block, pollId));
}

function lockedPollMessage(
  tx: Prisma.TransactionClient,
  where: { messageId?: string; threadId?: string; pollId: string },
): Promise<CardMessage | null> {
  return lockedCardMessage(tx, { ...where, match: { kind: "poll", pollId: where.pollId } });
}

/** The other assistants in the conversation a team poll also waits for. */
async function teamBotIds(tx: Prisma.TransactionClient, message: CardMessage): Promise<string[]> {
  if (!message.thread.groupId) return [];
  const members = await tx.chatGroupMember.findMany({
    where: { groupId: message.thread.groupId, bot: { archivedAt: null } },
    select: { botId: true },
  });
  return members.map((member) => member.botId).filter((id) => id !== message.botId);
}

function rewritePoll(
  tx: Prisma.TransactionClient,
  message: CardMessage,
  next: PollBlock,
): Promise<number> {
  return rewriteCardMessage(
    tx,
    message,
    message.blocks.map((block) => (isPoll(block, next.pollId) ? next : block)),
  );
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
