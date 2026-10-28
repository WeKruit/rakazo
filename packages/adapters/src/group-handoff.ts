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
  input: { bot_id?: string; confirm_name?: string; message: string; report_back?: boolean },
) {
  const deliveryKey = `group-handoff:${run.id}`;
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
 * itself is already in the shared thread, so the report only points at it.
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
  outcome: { status: "completed" | "failed"; error?: string },
): Promise<{ runId: string } | undefined> {
  if (!run.sourceMessageId) return undefined;
  const deliveryKey = `group-report:${run.id}`;
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
      const existing = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (existing) return undefined;
      const member = await tx.chatGroupMember.findFirst({
        where: { groupId, botId: asked.fromBotId, bot: { archivedAt: null } },
        select: { botId: true },
      });
      if (!member) return undefined;
      const hop = nextBotMessageHop(asked.hop);
      if (botMessageHopExhausted(hop)) return undefined;
      const text =
        outcome.status === "completed"
          ? "Finished the stage you handed me; my result is my last message above. Check it against what you asked for, then give the user the outcome or hand me a correction."
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
