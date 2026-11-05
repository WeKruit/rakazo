import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { pendingInputAttention } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const QUESTION_NUDGE_AFTER_MS = 10 * 60_000;

/**
 * Surface the original pending card once; never answer it or start another model run. With
 * account email configured, the recruiter also gets one email per card so work does not sit
 * waiting while they are away.
 */
export async function reconcileRecruitingQuestions(deps: {
  prisma: PrismaClient;
  events?: ThreadEvents;
  email?: TransactionalEmailProvider;
  webOrigin?: string;
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
      // Same lock as answering a card: an answer wins before the nudge or follows it. A thread
      // busy with other work is skipped until the next pass rather than held in this transaction.
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return null;
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
      const appended = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "thread.meta",
        payload: { questionNudgeCardId: card.id, unread: true },
      });
      return appended;
    });
    if (!event) continue;
    await deps.events?.notify(run.threadId, event.seq);
    if (deps.email) await emailWaitingQuestion(deps, run.threadId);
  }
  const last = runs.at(-1);
  return runs.length === deps.batchSize && last ? { at: last.updatedAt, id: last.id } : undefined;
}

/** One short email to the conversation owner; the card itself stays the only place to answer. */
async function emailWaitingQuestion(
  deps: { prisma: PrismaClient; email?: TransactionalEmailProvider; webOrigin?: string },
  threadId: string,
) {
  try {
    const thread = await deps.prisma.thread.findUnique({
      where: { id: threadId },
      select: {
        userId: true,
        group: { select: { id: true } },
        activeRecruitingRole: { select: { title: true } },
      },
    });
    if (!thread || !deps.email) return;
    const user = await deps.prisma.user.findUnique({
      where: { id: thread.userId },
      select: { email: true, emailVerified: true },
    });
    if (!user?.emailVerified || !user.email) return;
    const title = thread.activeRecruitingRole?.title?.trim() || "Your role";
    const link =
      deps.webOrigin && thread.group
        ? new URL(`/app/g/${thread.group.id}`, deps.webOrigin).href
        : "";
    await deps.email.send({
      to: user.email,
      subject: `${title}: your answer is needed`,
      text: ["Kruit has a question before it can continue.", link ? `Open it: ${link}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    });
  } catch (error) {
    getLogger().error("waiting question email", error);
  }
}
