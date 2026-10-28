import type { AskAnswer, MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { ClosedAskAnswer } from "@rakazo/core";
import { ACTIVE_RUN_STATUSES, closedAskAnswer, isOpenAskBlock } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

/**
 * Close every card a run is still waiting on, so web, mobile and the agent history all read the
 * card as no longer waiting. The caller holds the thread lock and has already ended the run.
 */
export async function closeRunAsksInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string },
): Promise<number> {
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, blocks: true },
  });
  let closed = 0;
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success || !parsed.data.some(isOpenAskBlock)) continue;
    const blocks = parsed.data.map((block) =>
      isOpenAskBlock(block) && block.kind === "ask"
        ? { ...block, status: "expired" as const }
        : block,
    );
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      runId: input.runId,
      allowCancelledRun: true,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    closed += 1;
  }
  return closed;
}

export interface ClosedAskInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answer: AskAnswer;
}

export type ClosedAskTarget = ClosedAskAnswer & { botId: string };

/**
 * The answer a person gave on a card whose run already ended (an expired or stopped wait).
 * Null while the run can still take the answer itself, or when the card is not one an
 * ordinary message can answer.
 */
export async function findClosedAskAnswer(
  prisma: Pick<PrismaClient, "run" | "message">,
  input: ClosedAskInput,
): Promise<ClosedAskTarget | null> {
  const run = await prisma.run.findFirst({
    where: { id: input.runId, spaceId: input.spaceId, threadId: input.threadId },
    select: { botId: true, status: true },
  });
  if (!run || (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return null;
  const card = await prisma.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      botId: run.botId,
      role: "bot",
    },
    select: { blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(card?.blocks);
  const ask = parsed.success ? closedCardAsk(parsed.data) : null;
  if (!ask) return null;
  const answer = closedAskAnswer(ask, input.answer);
  if (!answer) return null;
  // A newer card from the same agent is the one waiting; an old answer must not fill it in.
  const waiting = await prisma.run.findFirst({
    where: { threadId: input.threadId, botId: run.botId, status: "waiting_input" },
    select: { id: true },
  });
  return waiting ? null : { ...answer, botId: run.botId };
}

/** Record the answer on the closed card, as a live answer records it. Returns the event seq. */
export async function recordClosedAskAnswer(
  prisma: Pick<PrismaClient, "$transaction">,
  input: Omit<ClosedAskInput, "answer"> & { answer: ClosedAskAnswer },
): Promise<number | null> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const card = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId, runId: input.runId, role: "bot" },
      select: { id: true, botId: true, blocks: true },
    });
    const parsed = MessageBlockSchema.array().safeParse(card?.blocks);
    const ask = parsed.success ? closedCardAsk(parsed.data) : null;
    if (!card?.botId || !parsed.success || !ask) return null;
    const blocks: MessageBlock[] = parsed.data.map((block) =>
      block === ask
        ? {
            ...ask,
            status: "answered" as const,
            answer: input.answer.recorded,
            ...(input.answer.formResponse ? { formResponse: input.answer.formResponse } : {}),
          }
        : block,
    );
    await tx.message.update({ where: { id: card.id }, data: { blocks } });
    return appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: card.botId,
      type: "thread.message.updated",
      runId: input.runId,
      allowCancelledRun: true,
      payload: { messageId: card.id, role: "bot", blocks },
    });
  });
  return committed?.seq ?? null;
}

/** The card's unanswered ask, whether its wait expired or the run simply ended. */
function closedCardAsk(blocks: readonly MessageBlock[]) {
  const ask = blocks.find((block) => block.kind === "ask" && block.status !== "answered");
  return ask?.kind === "ask" ? ask : null;
}
