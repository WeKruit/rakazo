import type { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, blocksToAgentHistoryText } from "@rakazo/core";
import type { PrismaClient, SessionInputKind, SessionInputPayload, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  ensureConversationSession,
  submitSessionInput,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Error recorded on a run the upgrade ended; its unanswered input went to the agent's session. */
export const UPGRADED_RUN_ERROR = "upgraded";

type Pending = {
  seq: number;
  kind: SessionInputKind;
  trigger: string;
  messageId?: string;
  payload: SessionInputPayload;
};

/**
 * One-time release step (plan §4 "Cutover job"): every run still live on the run harness ends as
 * cancelled ("upgraded"), and what it had not answered (its unread steering, and its source
 * message when no reply followed it) becomes input of the agent's session, in message order.
 * Running it again finds no live run and adds nothing.
 */
export async function cutoverToSessions(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify" | "wakeSessions"> },
  options: { batchSize?: number } = {},
): Promise<{ runs: number; inputs: number }> {
  let runs = 0;
  let inputs = 0;
  for (;;) {
    const live = await deps.prisma.run.findMany({
      where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.batchSize ?? 500,
      select: { threadId: true, botId: true },
    });
    const lanes = [...new Map(live.map((run) => [`${run.threadId}:${run.botId}`, run])).values()];
    let converted = 0;
    for (const lane of lanes) {
      const done = await cutoverLane(deps.prisma, lane);
      if (!done) continue;
      converted += done.runs;
      inputs += done.inputs;
      await deps.events.notify(lane.threadId, done.eventSeq).catch((error) => {
        getLogger().error("session cutover notification", error);
      });
      await deps.events.wakeSessions([done.sessionId]);
    }
    runs += converted;
    if (converted === 0) break;
  }
  getLogger().info("session.cutover", { runs, inputs });
  return { runs, inputs };
}

async function cutoverLane(prisma: PrismaClient, lane: { threadId: string; botId: string }) {
  return prisma.$transaction(
    async (tx) => {
      // Same lock order as sends and stops: the thread row first.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${lane.threadId} FOR UPDATE`;
      const runs = await tx.run.findMany({
        where: { ...lane, status: { in: [...ACTIVE_RUN_STATUSES] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          taskId: true,
          spaceId: true,
          userId: true,
          status: true,
          trigger: true,
          routineId: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
          modelPinned: true,
          task: { select: { prompt: true } },
          sourceMessage: { select: { id: true, seq: true } },
        },
      });
      const first = runs[0];
      if (!first) return null;
      const pending: Pending[] = [];
      for (const run of runs) {
        const fact = {
          ...(run.trigger === "user" || run.trigger === "follow_up"
            ? {}
            : { internal: true as const }),
          ...(run.routineId ? { routineId: run.routineId } : {}),
          ...(run.modelPinned && run.modelProvider && run.modelId
            ? {
                modelPin: {
                  modelProvider: run.modelProvider,
                  modelId: run.modelId,
                  thinkingLevel: run.thinkingLevel,
                },
              }
            : {}),
        };
        if (run.sourceMessage) {
          const replied = await tx.message.findFirst({
            where: {
              threadId: lane.threadId,
              botId: lane.botId,
              role: "bot",
              seq: { gt: run.sourceMessage.seq },
            },
            select: { id: true },
          });
          if (!replied)
            pending.push({
              seq: run.sourceMessage.seq,
              kind: "message",
              trigger: run.trigger ?? "user",
              messageId: run.sourceMessage.id,
              payload: { text: run.task.prompt, ...fact },
            });
        } else if (run.status === "queued") {
          // Never started and has no message of its own (a routine, a search follow-up).
          pending.push({
            seq: Number.MAX_SAFE_INTEGER,
            kind: "message",
            trigger: run.trigger ?? "routine",
            payload: { text: run.task.prompt, ...fact },
          });
        }
      }
      const steering = await tx.steeringMessage.findMany({
        where: { botId: lane.botId, claimedAt: null, message: { threadId: lane.threadId } },
        select: {
          id: true,
          originTrigger: true,
          message: { select: { id: true, seq: true, blocks: true, role: true } },
        },
      });
      for (const row of steering)
        pending.push({
          seq: row.message.seq,
          kind: row.originTrigger === "follow_up" ? "followUp" : "message",
          trigger: row.originTrigger === "messaging" ? "messaging" : "user",
          messageId: row.message.id,
          payload: {
            text: blocksToAgentHistoryText(row.message.blocks as MessageBlock[]),
            ...(row.message.role === "user" ? {} : { internal: true as const }),
          },
        });
      const now = new Date();
      await cancelRunsInTransaction(tx, runs, now);
      await tx.run.updateMany({
        where: { id: { in: runs.map((run) => run.id) } },
        data: { error: UPGRADED_RUN_ERROR },
      });
      let eventSeq = 0;
      for (const run of runs) {
        const event = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: lane.threadId,
          botId: lane.botId,
          type: "run.cancelled",
          runId: run.id,
          payload: { reason: UPGRADED_RUN_ERROR },
        });
        eventSeq = event.seq;
      }
      const session = await ensureConversationSession(tx, {
        spaceId: first.spaceId,
        userId: first.userId,
        threadId: lane.threadId,
        botId: lane.botId,
      });
      const already = new Set(
        (
          await tx.sessionInput.findMany({
            where: { sessionId: session.id, messageId: { not: null } },
            select: { messageId: true },
          })
        ).map((row) => row.messageId),
      );
      let inputs = 0;
      for (const item of pending.sort((a, b) => a.seq - b.seq)) {
        if (item.messageId) {
          if (already.has(item.messageId)) continue;
          already.add(item.messageId);
        }
        await submitSessionInput(tx, {
          sessionId: session.id,
          kind: item.kind,
          trigger: item.trigger,
          messageId: item.messageId,
          payload: item.payload as never,
        });
        inputs += 1;
      }
      await tx.steeringMessage.deleteMany({ where: { id: { in: steering.map((row) => row.id) } } });
      return { runs: runs.length, inputs, eventSeq, sessionId: session.id };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
