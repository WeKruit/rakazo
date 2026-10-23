import { pendingInputAttention } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";

const QUESTION_NUDGE_AFTER_MS = 10 * 60_000;

/** Surface the original pending card once; never answer it or start another model run. */
export async function reconcileRecruitingQuestions(deps: {
  prisma: PrismaClient;
  events?: ThreadEvents;
  now: Date;
  batchSize: number;
  cursor?: { at: Date; id: string };
}) {
  const runs = await deps.prisma.run.findMany({
    where: {
      status: "waiting_input",
      updatedAt: { lte: new Date(deps.now.getTime() - QUESTION_NUDGE_AFTER_MS) },
      thread: { activeRecruitingRoleId: { not: null } },
      ...(deps.cursor
        ? {
            OR: [
              { updatedAt: { gt: deps.cursor.at } },
              { updatedAt: deps.cursor.at, id: { gt: deps.cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: deps.batchSize,
    select: { id: true, threadId: true, spaceId: true, botId: true, updatedAt: true },
  });
  for (const run of runs) {
    const event = await deps.prisma.$transaction(async (tx) => {
      // Same lock as answering a card: an answer wins before the nudge or follows it.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const waiting = await tx.run.findFirst({
        where: { id: run.id, status: "waiting_input", updatedAt: run.updatedAt },
        select: { id: true },
      });
      if (!waiting) return null;
      const card = await tx.message.findFirst({
        where: {
          runId: run.id,
          threadId: run.threadId,
          role: "bot",
          blocks: { array_contains: [{ kind: "ask", status: "pending" }] },
        },
        orderBy: { seq: "desc" },
        select: { id: true, blocks: true },
      });
      if (!card || pendingInputAttention(card.blocks) !== "question") return null;
      const previous = await tx.event.findFirst({
        where: {
          runId: run.id,
          type: "thread.meta",
          payload: { path: ["questionNudgeCardId"], equals: card.id },
        },
        select: { id: true },
      });
      if (previous) return null;
      await tx.thread.update({ where: { id: run.threadId }, data: { unread: true } });
      return appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "thread.meta",
        payload: { questionNudgeCardId: card.id, unread: true },
      });
    });
    if (event) await deps.events?.notify(run.threadId, event.seq);
  }
  const last = runs.at(-1);
  return runs.length === deps.batchSize && last ? { at: last.updatedAt, id: last.id } : undefined;
}
