import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import { botMessageHopExhausted, nextBotMessageHop, renderGroupMembersContext } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";
import { NO_RESPONSE } from "./silent-reply.js";
import { declinedRunId } from "./turn-end-guard.js";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: {
    /** The answer a resumed run continues from: each answered turn may hand off once more. */
    turnKey?: string;
    bot_id?: string;
    confirm_name?: string;
    message: string;
    report_back?: boolean;
  },
) {
  const deliveryKey = input.turnKey
    ? `group-handoff:${run.id}:${input.turnKey}`
    : `group-handoff:${run.id}`;
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      try {
        await lockOwnedGroup(tx, run, groupId);
      } catch (error) {
        if (error instanceof IsolationError)
          return { error: "group is no longer available" } as const;
        throw error;
      }
      const [group, activeSource] = await Promise.all([
        tx.chatGroup.findFirst({
          where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
          include: {
            members: {
              where: { bot: { archivedAt: null } },
              include: { bot: { select: { id: true, name: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: "running",
          },
          select: { id: true, sourceMessage: { select: { blocks: true } } },
        }),
      ]);
      if (!group || !activeSource) return { error: "source run is no longer active" } as const;
      if (!group.members.some((member) => member.bot.id === run.botId)) {
        return { error: "source bot is no longer a group member" } as const;
      }

      const existing = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
        select: {
          sourceRuns: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, botId: true },
          },
        },
      });
      if (existing) {
        const nextRun = existing.sourceRuns[0];
        const event = await tx.event.findFirst({
          where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
          orderBy: { seq: "desc" },
          select: { seq: true },
        });
        if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
        return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
      }

      let targetId = input.bot_id?.trim();
      if (!targetId && input.confirm_name?.trim()) {
        const name = input.confirm_name.trim().toLowerCase();
        targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
      }
      if (!targetId) return { error: "handoff target bot is required" } as const;
      if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
      if (!group.members.some((member) => member.bot.id === targetId)) {
        return { error: "handoff target is not a group member" } as const;
      }

      let sourceBlocks: MessageBlock[] = [];
      if (activeSource.sourceMessage) {
        const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
        if (!parsedSource.success) {
          return { error: "cannot verify the group handoff chain" } as const;
        }
        sourceBlocks = parsedSource.data;
      }
      const sourceHandoff = sourceBlocks.find(
        (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
      );
      // A returned stage may go back to its owner as a correction; anything else is a bounce.
      if (sourceHandoff?.fromBotId === targetId && !sourceHandoff.report) {
        return {
          error:
            "do not hand this stage back to its sender; post the result in the shared thread instead",
        } as const;
      }
      const hop = nextBotMessageHop(sourceHandoff?.hop);
      if (botMessageHopExhausted(hop)) {
        return {
          error:
            "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
        } as const;
      }

      const handoffBlock: MessageBlock = {
        kind: "handoff",
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
        hop,
        ...(input.report_back ? { reportBack: true } : {}),
      };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks: [handoffBlock],
        botId: run.botId,
        runId: run.id,
        clientNonce: deliveryKey,
      });
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: targetId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: input.message,
          status: "queued",
        },
      });
      const nextRun = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: targetId,
          threadId: run.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "follow_up",
          sourceMessageId: message.id,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "group.handoff",
        runId: run.id,
        payload: {
          messageId: message.id,
          fromBotId: run.botId,
          toBotId: targetId,
          text: input.message,
        },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return { ok: true, botId: targetId, runId: nextRun.id, eventSeq: event.seq } as const;
    }),
  );
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    note: input.report_back
      ? "Handoff recorded. End this turn without narrating it; the result comes back to you when that stage ends, so you can check it before the user relies on it."
      : "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

/**
 * Returns a stage handed over with report_back to the member that asked for it, once the stage
 * ends either way, so it can check the result against its brief. Idempotent per run; the result
 * itself is already in the shared thread, so the report only points at it. A `progress` report is
 * the one mid-stage check-in: it never follows the stage's final report.
 */
export async function reportGroupHandoffOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId: string | null;
  },
  groupId: string,
  outcome: { status: "completed" | "failed" | "progress"; error?: string },
): Promise<{ runId: string } | undefined> {
  if (!run.sourceMessageId) return undefined;
  const finalKey = `group-report:${run.id}`;
  const deliveryKey = outcome.status === "progress" ? `group-checkin:${run.id}` : finalKey;
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      try {
        await lockOwnedGroup(tx, run, groupId);
      } catch (error) {
        if (error instanceof IsolationError) return undefined;
        throw error;
      }
      const source = await tx.message.findFirst({
        where: { id: run.sourceMessageId!, threadId: run.threadId },
        select: { blocks: true },
      });
      const parsed = MessageBlock.array().safeParse(source?.blocks ?? []);
      const asked = parsed.success
        ? parsed.data.find(
            (block): block is Extract<MessageBlock, { kind: "handoff" }> =>
              block.kind === "handoff" && block.toBotId === run.botId && block.reportBack === true,
          )
        : undefined;
      if (!asked || asked.fromBotId === run.botId) return undefined;
      for (const clientNonce of new Set([deliveryKey, finalKey])) {
        const existing = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: run.threadId, clientNonce } },
          select: { id: true },
        });
        if (existing) return undefined;
      }
      const member = await tx.chatGroupMember.findFirst({
        where: { groupId, botId: asked.fromBotId, bot: { archivedAt: null } },
        select: { botId: true },
      });
      if (!member) return undefined;
      const hop = nextBotMessageHop(asked.hop);
      if (botMessageHopExhausted(hop)) return undefined;
      const text =
        outcome.status === "completed"
          ? `Finished the stage you handed me; my result is my last message above, which the user already sees. If it does what you asked, reply exactly ${NO_RESPONSE}; otherwise hand me a correction, or tell the user only what it is missing. Never repeat it.`
          : outcome.status === "progress"
            ? `Check-in: the stage you handed me is still running, and the first results are saved above. If they drift from what you asked for, hand me a correction now. Tell the user only if something changed that they need to know or the work looks stuck; otherwise reply exactly ${NO_RESPONSE}. The final result comes back to you when the stage ends.`
            : `Could not finish the stage you handed me: ${(outcome.error ?? "the run failed").slice(0, 300)}. Decide the next step and tell the user what happened.`;
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks: [
          {
            kind: "handoff",
            fromBotId: run.botId,
            toBotId: asked.fromBotId,
            text,
            hop,
            report: outcome.status,
          },
        ],
        botId: run.botId,
        runId: run.id,
        clientNonce: deliveryKey,
      });
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: asked.fromBotId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: text,
          status: "queued",
        },
      });
      const nextRun = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: asked.fromBotId,
          threadId: run.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "follow_up",
          sourceMessageId: message.id,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "group.handoff",
        runId: run.id,
        payload: { messageId: message.id, fromBotId: run.botId, toBotId: asked.fromBotId, text },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return { runId: nextRun.id, eventSeq: event.seq };
    }),
  );
  if (!committed) return undefined;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group report realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    getLogger().error("group report enqueue", error);
  });
  return { runId: committed.runId };
}

type StageDeps = Pick<ExecutorDeps, "prisma" | "events" | "jobs">;
type WorkerTurn = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId: string | null;
  trigger: string;
  clientNonce?: string | null;
};

/** The worker's latest finished handed-in turn in this thread: the stage its research belongs to. */
async function handedStage(
  prisma: StageDeps["prisma"],
  worker: Pick<WorkerTurn, "spaceId" | "threadId" | "botId" | "userId">,
) {
  return prisma.run.findFirst({
    where: {
      spaceId: worker.spaceId,
      threadId: worker.threadId,
      botId: worker.botId,
      userId: worker.userId,
      trigger: "follow_up",
      status: "completed",
      sourceMessageId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      sourceMessageId: true,
    },
  });
}

/**
 * A retry of a declined handed-in turn finishes that turn's stage, so it reports as that turn;
 * the declined turn itself sent no report.
 */
async function retriedStage(prisma: StageDeps["prisma"], turn: WorkerTurn) {
  if (!turn.sourceMessageId) return turn;
  const source = await prisma.message.findFirst({
    where: { id: turn.sourceMessageId, threadId: turn.threadId },
    select: { clientNonce: true },
  });
  const declined = declinedRunId(source?.clientNonce);
  if (!declined) return turn;
  const original = await prisma.run.findFirst({
    where: { id: declined, threadId: turn.threadId, botId: turn.botId, userId: turn.userId },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      sourceMessageId: true,
    },
  });
  return original ?? turn;
}

/**
 * A worker's turn ended in a group. A handed-in turn that leaves its own research running at the
 * provider has not finished the stage, so its report waits. That research's wakes continue the
 * same stage: the first partial-results wake sends the one mid-stage check-in, and the turn that
 * ends with nothing of the worker's still running delivers the final report.
 */
export async function reportGroupStageOutcome(
  deps: StageDeps,
  turn: WorkerTurn,
  groupId: string,
  outcome: { status: "completed" | "failed"; error?: string },
): Promise<{ runId: string } | undefined> {
  const wake = turn.trigger === "recruiting_research";
  if (!wake && turn.trigger !== "follow_up") return undefined;
  const partial = wake && Boolean(turn.clientNonce?.includes(":rows:"));
  if (partial && outcome.status === "failed") return undefined;
  const stage = wake ? await handedStage(deps.prisma, turn) : await retriedStage(deps.prisma, turn);
  if (!stage) return undefined;
  if (outcome.status === "completed") {
    const thread = await deps.prisma.thread.findUnique({
      where: { id: turn.threadId },
      select: { activeRecruitingRoleId: true },
    });
    const running =
      thread?.activeRecruitingRoleId &&
      (await recruitingResearchInFlight(deps.prisma, thread.activeRecruitingRoleId, Date.now(), {
        botId: turn.botId,
        threadId: turn.threadId,
      }));
    if (running)
      return partial
        ? reportGroupHandoffOutcome(deps, stage, groupId, { status: "progress" })
        : undefined;
    if (partial) return undefined;
  }
  return reportGroupHandoffOutcome(deps, stage, groupId, outcome);
}

/** The worker's research stopped being followed before the provider finished it. */
export async function reportStalledGroupStage(
  deps: StageDeps,
  worker: Pick<WorkerTurn, "spaceId" | "threadId" | "botId" | "userId">,
): Promise<void> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: worker.threadId, spaceId: worker.spaceId },
    select: { groupId: true },
  });
  if (!thread?.groupId) return;
  const stage = await handedStage(deps.prisma, worker);
  if (!stage) return;
  await reportGroupHandoffOutcome(deps, stage, thread.groupId, {
    status: "failed",
    error: "the search is still not finished at the provider after two hours of checks",
  });
}

/** A delegator's turn that reads a teammate's check-in or finished stage may end silently. */
export function isQuietStageReport(
  trigger: string,
  blocks: readonly MessageBlock[] | undefined,
  botId: string,
): boolean {
  return (
    trigger === "follow_up" &&
    Boolean(
      blocks?.some(
        (block) =>
          block.kind === "handoff" &&
          block.toBotId === botId &&
          (block.report === "progress" || block.report === "completed"),
      ),
    )
  );
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: {
            select: {
              id: true,
              name: true,
              title: true,
              description: true,
              mcpServers: {
                where: { server: { enabled: true } },
                select: {
                  allowAllTools: true,
                  allowedTools: true,
                  server: { select: { name: true, description: true } },
                },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map(({ bot: { mcpServers, ...bot } }) => ({
      ...bot,
      // Read from the bot's real service assignments, so the roster never drifts from them.
      capabilities: mcpServers.map(({ server, allowAllTools, allowedTools }) => {
        const tools =
          !allowAllTools && Array.isArray(allowedTools)
            ? allowedTools.filter((tool): tool is string => typeof tool === "string")
            : [];
        const about = server.description
          .trim()
          .split(/(?<=\.)\s/)[0]
          ?.slice(0, 120);
        return `${server.name}${about ? ` (${about})` : ""}${tools.length ? `: ${tools.join(", ")}` : ""}`;
      }),
    })),
    self,
  );
}
