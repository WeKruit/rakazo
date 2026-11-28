import { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  nextBotMessageHop,
  recruitingBotKey,
  renderGroupMembersContext,
  waitingApprovalCards,
  waitingApprovalNote,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  questionClosedByChat,
  submitConversationInput,
  touchGroupUpdatedAt,
  waitingCardBlocks,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { readMailReplyOutcomeReport } from "./mail-reply.js";

export const NO_ROLE_HANDOFF =
  "Not handed off: this conversation has no role yet, so the sourcing teammate has nowhere to save the people it finds.";

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
              include: { bot: { select: { id: true, name: true, spawnKey: true } } },
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
        select: { blocks: true },
      });
      // This turn already handed the stage over; its input was submitted with that message.
      if (existing) {
        const recorded = (existing.blocks as MessageBlock[]).find(
          (block) => block.kind === "handoff",
        );
        if (recorded?.kind !== "handoff")
          return { error: "recorded handoff is incomplete" } as const;
        return { ok: true as const, botId: recorded.toBotId, replayed: true as const };
      }

      // Models sometimes pass a stale id or a name as bot_id; a member's exact name still counts.
      const byName = (value: string | undefined) => {
        const name = value?.trim().toLowerCase();
        return name
          ? group.members.find((member) => member.bot.name.toLowerCase() === name)
          : undefined;
      };
      const requestedId = input.bot_id?.trim();
      const targetId =
        group.members.find((member) => member.bot.id === requestedId)?.bot.id ??
        byName(input.confirm_name)?.bot.id ??
        byName(requestedId)?.bot.id ??
        requestedId;
      if (!targetId) return { error: "handoff target bot is required" } as const;
      if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
      const target = group.members.find((member) => member.bot.id === targetId);
      if (!target) return { error: "handoff target is not a group member" } as const;
      const targetKey = recruitingBotKey(target.bot);
      // A search stage saves people into the conversation's role; without one the sourcing
      // teammate has nowhere to put them, so the coordinator sets the role up first.
      const source = group.members.find((member) => member.bot.id === run.botId);
      if (source && recruitingBotKey(source.bot) === "main" && targetKey === "sourcer") {
        const thread = await tx.thread.findUnique({
          where: { id: run.threadId },
          select: { activeRecruitingRoleId: true },
        });
        if (!thread?.activeRecruitingRoleId) return { error: NO_ROLE_HANDOFF } as const;
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
            "Not handed off: this stage came from that teammate, and a stage is not handed back to its sender.",
        } as const;
      }
      const hop = nextBotMessageHop(sourceHandoff?.hop);
      if (botMessageHopExhausted(hop)) {
        return {
          error:
            "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
        } as const;
      }

      // The sender's words about a card are not its state: the next bot reads the cards' own record.
      const approvalNote = waitingApprovalNote(
        waitingApprovalCards(await waitingCardBlocks(tx, run.threadId)),
      );
      const text = approvalNote ? `${input.message}\n\n${approvalNote}` : input.message;
      const handoffBlock: MessageBlock = {
        kind: "handoff",
        fromBotId: run.botId,
        toBotId: targetId,
        text,
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
      const submitted = await submitConversationInput(
        tx,
        { spaceId: run.spaceId, userId: run.userId, threadId: run.threadId, botId: targetId },
        {
          kind: "message",
          trigger: "follow_up",
          messageId: message.id,
          payload: { text, internal: true },
        },
      );
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
          text: text,
        },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return {
        ok: true as const,
        botId: targetId,
        sessionId: submitted.sessionId,
        eventSeq: event.seq,
      };
    }),
  );
  if ("error" in committed) return committed;
  if (!("replayed" in committed)) {
    await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
      getLogger().error("group handoff realtime notification", error);
    });
    await deps.events.wakeSessions([committed.sessionId]);
  }
  return {
    ok: true,
    botId: committed.botId,
    note: input.report_back
      ? "Handoff recorded; the result comes back to you when that stage ends."
      : "Handoff recorded; the next bot owns the next stage.",
  };
}

/** Whether the run left the user anything to see: a message or card, not only steps or a handoff. */
async function postedResult(
  tx: Pick<PrismaClient, "message" | "run">,
  runId: string,
): Promise<boolean> {
  const posted = await tx.message.findMany({
    where: { runId, role: "bot" },
    select: { blocks: true },
    take: 50,
  });
  return posted.some((message) =>
    (Array.isArray(message.blocks) ? message.blocks : []).some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        !["handoff", "steps"].includes(String((block as { kind?: unknown }).kind)),
    ),
  );
}

/**
 * Returns a stage handed over with report_back to the member that asked for it, once, when the
 * stage ends either way: a child job's one end, as Workloop delivers "Job X ended (status)." with
 * the child's last text (PRD §1.6, deliver.go) and a Claude Code teammate notifies its lead once
 * when it goes idle. The text states facts only; the result itself is already in the shared thread.
 * Idempotent per run.
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
): Promise<{ sessionId: string } | undefined> {
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
      const mail = await readMailReplyOutcomeReport(tx, run);
      const posted = outcome.status === "completed" && !mail && (await postedResult(tx, run.id));
      // Facts from records: how the stage ended, the verified mail outcome, the cards still
      // waiting on the recruiter and a question the recruiter answered by typing instead.
      const ended =
        outcome.status === "failed"
          ? `Ended the stage you handed me: failed (${(outcome.error ?? "the run failed").slice(0, 300)}).`
          : mail
            ? "Ended the stage you handed me: completed."
            : posted
              ? "Ended the stage you handed me: completed; its result is my last message above."
              : "Ended the stage you handed me: completed, with no message and no card posted.";
      const cards = waitingApprovalNote(
        waitingApprovalCards(await waitingCardBlocks(tx, run.threadId)),
      );
      const reask = await questionClosedByChat(tx, {
        threadId: run.threadId,
        botId: asked.fromBotId,
      });
      const text = [
        ended,
        ...(mail ? [`Verified reply-card outcome:\n${mail.text}`] : []),
        ...(cards ? [cards] : []),
        ...(reask
          ? [
              `Your question "${reask.question}" was closed when the recruiter typed "${reask.reply.slice(0, 300)}" in the chat.`,
            ]
          : []),
      ].join("\n\n");
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
      const event = () =>
        appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "group.handoff",
          runId: run.id,
          payload: { messageId: message.id, fromBotId: run.botId, toBotId: asked.fromBotId, text },
        });
      // The report joins the sender's session: a live turn is steered, an idle one starts.
      const submitted = await submitConversationInput(
        tx,
        {
          spaceId: run.spaceId,
          userId: run.userId,
          threadId: run.threadId,
          botId: asked.fromBotId,
        },
        {
          kind: "message",
          trigger: "follow_up",
          messageId: message.id,
          payload: { text, internal: true },
        },
      );
      const created = await event();
      await touchGroupUpdatedAt(tx, groupId);
      return { sessionId: submitted.sessionId, eventSeq: created.seq };
    }),
  );
  if (!committed) return undefined;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group report realtime notification", error);
  });
  await deps.events.wakeSessions([committed.sessionId]);
  return { sessionId: committed.sessionId };
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
 * A worker's turn ended in a group: a turn woken to collect its search, or a retried turn,
 * delivers the stage's report to the teammate that handed it over.
 */
export async function reportGroupStageOutcome(
  deps: StageDeps,
  turn: WorkerTurn,
  groupId: string,
  outcome: { status: "completed" | "failed"; error?: string },
): Promise<{ sessionId: string } | undefined> {
  const wake = turn.trigger === "recruiting_research";
  if (!wake && turn.trigger !== "follow_up") return undefined;
  const stage = wake ? await handedStage(deps.prisma, turn) : turn;
  if (!stage) return undefined;
  return reportGroupHandoffOutcome(deps, stage, groupId, outcome);
}

/** A delegator's turn that reads a teammate's finished stage may end silently. */
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
          block.kind === "handoff" && block.toBotId === botId && block.report === "completed",
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
              spawnKey: true,
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
    group.members.map(({ bot: { mcpServers, spawnKey: _spawnKey, ...bot } }) => ({
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
