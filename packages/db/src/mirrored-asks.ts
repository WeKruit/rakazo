import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isOpenAskBlock, isSecretAskBlock } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

/** One copy per source card, however often the pause is replayed. */
export function mirroredAskClientNonce(sourceMessageId: string): string {
  return `delegated-ask:${sourceMessageId}`;
}

/**
 * Lock two conversations for one transaction: role (group) conversations first, then the
 * account-wide conversation or a direct chat, then by id.
 * Answering or closing a role team's card locks the role's row and then writes the card's copy in
 * the conversation that delegated the work, so a delivery between the two has to take the rows in
 * that same order, or the two transactions deadlock (Postgres: take row locks in one order).
 */
export async function lockConversationPair(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  threadIds: readonly [string, string],
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM threads WHERE id IN (${threadIds[0]}, ${threadIds[1]})
    ORDER BY ("groupId" IS NULL OR "groupId" LIKE 'recruiting-global-%'), id
    FOR UPDATE`;
}

/**
 * Copy the card a role team's run is waiting on into the conversation that delegated the work,
 * so the person sees and answers it where they are (as Workloop posts a child agent's approval in
 * the user's thread and routes the decision back to that child). Answering the copy answers the
 * source card. A sign-in card is copied too: the person's own sign-in connects the server the
 * team's bot was given. A secret card stays where it is, because a secret is never copied.
 * Returns the copy's event, or null when there is nothing to copy or it was copied already.
 */
export async function mirrorAskInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    sourceThreadId: string;
    sourceMessageId: string;
    runId: string;
    targetThreadId: string;
    botId: string;
  },
): Promise<{ threadId: string; seq: number } | null> {
  const source = await tx.message.findFirst({
    where: { id: input.sourceMessageId, threadId: input.sourceThreadId, runId: input.runId },
    select: { blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(source?.blocks);
  if (!parsed.success) return null;
  const answerTarget = {
    threadId: input.sourceThreadId,
    runId: input.runId,
    messageId: input.sourceMessageId,
  };
  const blocks: MessageBlock[] = parsed.data
    .filter(
      (block) =>
        block.kind === "ask" &&
        isOpenAskBlock(block) &&
        !isSecretAskBlock(block) &&
        !block.answerTarget,
    )
    .map((block) => ({ ...block, answerTarget }) as MessageBlock);
  if (!blocks.length) return null;
  // The copy leads back to the role's own conversation, opened beside this one at the card.
  const sourceChat = await tx.thread.findUnique({
    where: { id: input.sourceThreadId },
    select: { groupId: true, group: { select: { name: true } } },
  });
  if (sourceChat?.groupId && sourceChat.group)
    blocks.push({ kind: "role_link", groupId: sourceChat.groupId, title: sourceChat.group.name });
  const clientNonce = mirroredAskClientNonce(input.sourceMessageId);
  const already = await tx.message.findUnique({
    where: { threadId_clientNonce: { threadId: input.targetThreadId, clientNonce } },
    select: { id: true },
  });
  if (already) return null;
  const copy = await createThreadMessageInTransaction(tx, {
    threadId: input.targetThreadId,
    role: "bot",
    blocks,
    botId: input.botId,
    runId: input.runId,
    clientNonce,
    markUnread: true,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.targetThreadId,
    botId: input.botId,
    type: "thread.message.created",
    runId: input.runId,
    payload: { messageId: copy.id, role: "bot", blocks },
  });
  return { threadId: event.threadId, seq: event.seq };
}

/**
 * Bring the copy of a card in step with its source after the source was answered or closed.
 */
export async function syncMirroredAsksInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    sourceThreadId: string;
    sourceMessageId: string;
    runId: string;
    blocks: readonly MessageBlock[];
  },
): Promise<{ threadId: string; seq: number }[]> {
  const source = input.blocks.find((block) => block.kind === "ask");
  if (source?.kind !== "ask") return [];
  // One copy per card, in the conversation that delegated the work.
  const copy = await tx.message.findFirst({
    where: {
      runId: input.runId,
      role: "bot",
      clientNonce: mirroredAskClientNonce(input.sourceMessageId),
    },
    select: { id: true, threadId: true, botId: true, blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(copy?.blocks);
  if (!copy?.botId || copy.threadId === input.sourceThreadId || !parsed.success) return [];
  const blocks = parsed.data.map((block) =>
    block.kind === "ask" && block.answerTarget?.messageId === input.sourceMessageId
      ? ({ ...source, answerTarget: block.answerTarget } as MessageBlock)
      : block,
  );
  await tx.message.update({ where: { id: copy.id }, data: { blocks } });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: copy.threadId,
    botId: copy.botId,
    type: "thread.message.updated",
    runId: input.runId,
    allowCancelledRun: true,
    payload: { messageId: copy.id, role: "bot", blocks },
  });
  return [{ threadId: event.threadId, seq: event.seq }];
}

/**
 * The source card a press on a copy answers, or null when the pressed card is not a copy. The
 * source must be in the same person's own conversations.
 */
export async function mirroredAskSource(
  tx: Pick<Prisma.TransactionClient, "message" | "thread">,
  input: { spaceId: string; userId: string; threadId: string; messageId: string },
): Promise<{ threadId: string; runId: string; messageId: string } | null> {
  const copy = await tx.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId, role: "bot" },
    select: { blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(copy?.blocks);
  if (!parsed.success) return null;
  const ask = parsed.data.find((block) => block.kind === "ask" && block.answerTarget);
  const target = ask?.kind === "ask" ? ask.answerTarget : undefined;
  if (!target) return null;
  const source = await tx.thread.findFirst({
    where: { id: target.threadId, spaceId: input.spaceId, userId: input.userId },
    select: { id: true },
  });
  return source ? target : null;
}
