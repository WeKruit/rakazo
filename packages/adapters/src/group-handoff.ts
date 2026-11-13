import { runContinueJob } from "@rakazo/adapter-kit";
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
  touchGroupUpdatedAt,
  waitingCardBlocks,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { COMPLETION_EMAIL_OFFER, completionEmailAnswered } from "./completion-email.js";
import type { ExecutorDeps } from "./executor.js";
import { readMailReplyOutcomeReport } from "./mail-reply.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";
import { blocksText } from "./reply-suggestion.js";
import { NO_RESPONSE } from "./silent-reply.js";
import { declinedRunId } from "./turn-end-guard.js";

export const NO_ROLE_HANDOFF =
  "Not handed off: this conversation has no role yet, so the sourcing teammate has nowhere to save the people it finds. Save the role now with recruiting_role, quoting the recruiter's own words, then hand off again with the same brief.";

/** Above the role teams, only role-free work goes to a teammate in the room itself. */
export const GLOBAL_HANDOFF_ROLE_WORK =
  "Not handed off: in this conversation only an email to an address the recruiter gave (Outreach) or an interview booking for a named person (Scheduling) goes to a teammate here. Role work goes to that role's team with delegate_to_role; a new role goes to start_role.";

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
      if (
        groupId.startsWith("recruiting-global-") &&
        targetKey !== "outreach" &&
        targetKey !== "scheduling"
      )
        return { error: GLOBAL_HANDOFF_ROLE_WORK } as const;
      // Work in a role the recruiter names (such as replying in that role's email thread) needs
      // that role's campaign and threads, which only its own team holds.
      if (groupId.startsWith("recruiting-global-")) {
        // A request steered into a running turn is not its source message; the brief quotes it.
        const asked =
          `${JSON.stringify(activeSource.sourceMessage?.blocks ?? [])}\n${input.message}`.toLowerCase();
        const roles = await tx.recruitingRole.findMany({
          where: { userId: run.userId, spaceId: run.spaceId, archivedAt: null },
          select: { id: true, title: true },
        });
        const named = roles.find(
          (role) => role.title.trim().length > 1 && asked.includes(role.title.trim().toLowerCase()),
        );
        if (named)
          return {
            error: `Not handed off: the recruiter named the role "${named.title}", whose email threads and campaign only its team holds. Hand this to that team with delegate_to_role, role_id "${named.id}".`,
          } as const;
      }
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
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: targetId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: text,
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
          text: text,
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
      ? "Handoff recorded. Do not narrate it or redo that work; the result comes back to you when that stage ends, so you can check it before the user relies on it."
      : "Handoff recorded. Do not narrate it or redo that work; the next bot owns the next stage.",
  };
}

/** Whether the run left the user anything to see: a message or card, not only steps or a handoff. */
async function postedResult(tx: Pick<PrismaClient, "message">, runId: string): Promise<boolean> {
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

/** Whether the stage sent an email or reply the recruiter confirmed on its card. */
async function confirmedSend(
  tx: Pick<PrismaClient, "externalEffect">,
  runId: string,
): Promise<boolean> {
  const sent = await tx.externalEffect.findFirst({
    where: {
      runId,
      status: "completed",
      OR: [{ kind: { endsWith: "activate_campaign" } }, { kind: { endsWith: "reply_to_email" } }],
    },
    select: { id: true },
  });
  return sent !== null;
}

/** Whether the recruiter's latest message in the thread is a question. */
async function latestUserMessageAsks(
  tx: Pick<PrismaClient, "message">,
  threadId: string,
): Promise<boolean> {
  const latest = await tx.message.findFirst({
    where: { threadId, role: "user" },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });
  const parsed = MessageBlock.array().safeParse(latest?.blocks ?? []);
  if (!parsed.success) return false;
  return /[?？]\s*$/.test(blocksText(parsed.data).trim());
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
  outcome: {
    status: "completed" | "failed" | "progress";
    error?: string;
    /** A periodic check-in: its ten-minute slot and what the stage looks like now. */
    watch?: { slot: number; state: string };
  },
): Promise<{ runId: string } | undefined> {
  if (!run.sourceMessageId) return undefined;
  const finalKey = `group-report:${run.id}`;
  const deliveryKey =
    outcome.status !== "progress"
      ? finalKey
      : outcome.watch
        ? `group-checkin:${run.id}:${outcome.watch.slot}`
        : `group-checkin:${run.id}`;
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
      const mail = await readMailReplyOutcomeReport(tx, run);
      const posted = outcome.status === "completed" && !mail && (await postedResult(tx, run.id));
      // Staging 11-13: a teammate answered the recruiter's question, then the sender restated it
      // or handed it back for proof, so one question got two or three answers. An answered
      // question needs nothing more from the sender.
      if (posted && (await latestUserMessageAsks(tx, run.threadId))) return undefined;
      // Staging 11-13: after the recruiter confirmed a send and Outreach said it went out, the
      // report woke Main, which listed the account's roles unasked. A confirmed send is done.
      if (posted && (await confirmedSend(tx, run.id))) return undefined;
      const report = mail
        ? `Stage status: ${outcome.status}. Verified reply-card outcome:\n${mail.text}\nUse this recorded card outcome as the result, even when the last text above was only a progress update.`
        : outcome.status === "completed" && !posted
          ? `Ended the stage you handed me without posting any result: no message and no card. This is not done. Hand me a correction that restates what this request needs, at most twice; after that, tell the user it did not get done.`
          : outcome.status === "completed"
            ? `Finished the stage you handed me; my result is my last message above, which the user already sees. When it answers what the user asked or does what they asked (a send or booking whose card the recruiter confirmed is done), reply exactly ${NO_RESPONSE}: never ask me to prove it, re-check it or say it again in your words. Hand me a correction only when a concrete part of the request is still undone, naming that part, at most twice; after that, or when I said what blocks it, tell the user only what blocks the rest.`
            : outcome.watch
              ? `Check-in: ${outcome.watch.state} If this drifts from what you asked for or looks stuck, hand me a correction now. Tell the user only if something changed that they need to know; otherwise reply exactly ${NO_RESPONSE}. The final result comes back to you when the stage ends.`
              : outcome.status === "progress"
                ? `Check-in: the stage you handed me is still running, and the first results are saved above. If they drift from what you asked for, hand me a correction now. Tell the user only if something changed that they need to know or the work looks stuck; otherwise reply exactly ${NO_RESPONSE}. The final result comes back to you when the stage ends.`
                : `Could not finish the stage you handed me: ${(outcome.error ?? "the run failed").slice(0, 300)}. Decide the next step and tell the user what happened.`;
      const reask =
        outcome.status === "progress"
          ? undefined
          : await questionClosedByChat(tx, { threadId: run.threadId, botId: asked.fromBotId });
      const text = reask
        ? `${report}\n\nYour question "${reask.question}" was closed when the recruiter typed "${reask.reply.slice(0, 300)}" in the chat. When that message answers it, act on that answer and never ask it again. Only when it is plainly about something else is the question still open: then ask it again with ask_user now instead of replying ${NO_RESPONSE}.`
        : report;
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

/** How often an open handed stage checks in with the teammate that handed it over. */
export const STAGE_WATCH_MS = 10 * 60_000;
/** Stages older than this are left to the stuck-work and research-stall reports. */
const STAGE_WATCH_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The coordinator's watch over the stages it handed out, like a supervisor checking each open
 * job every ten minutes: every stage asked to report back that has not reported yet gets one
 * check-in per ten-minute slot, saying how it stands. A stage waiting on the user's answer is
 * skipped, and so is a slot while the coordinator is already busy in that conversation.
 */
export async function watchOpenStages(
  deps: StageDeps & { completionEmail?: boolean },
  now: Date,
  batchSize: number,
): Promise<number> {
  const runs = await deps.prisma.run.findMany({
    where: {
      trigger: "follow_up",
      status: { in: ["queued", "leased", "running", "completed"] },
      sourceMessageId: { not: null },
      createdAt: {
        gte: new Date(now.getTime() - STAGE_WATCH_WINDOW_MS),
        lte: new Date(now.getTime() - STAGE_WATCH_MS),
      },
      thread: { groupId: { not: null } },
    },
    orderBy: { createdAt: "desc" },
    take: batchSize,
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      status: true,
      createdAt: true,
      sourceMessageId: true,
      sourceMessage: { select: { blocks: true } },
      thread: { select: { groupId: true, activeRecruitingRoleId: true } },
    },
  });
  const stages = runs.flatMap((run) => {
    const parsed = MessageBlock.array().safeParse(run.sourceMessage?.blocks ?? []);
    const asked = parsed.success
      ? parsed.data.find(
          (block): block is Extract<MessageBlock, { kind: "handoff" }> =>
            block.kind === "handoff" && block.toBotId === run.botId && block.reportBack === true,
        )
      : undefined;
    return asked && run.thread.groupId ? [{ run, asked, groupId: run.thread.groupId }] : [];
  });
  if (!stages.length) return 0;
  const reported = new Set(
    (
      await deps.prisma.message.findMany({
        where: {
          threadId: { in: [...new Set(stages.map(({ run }) => run.threadId))] },
          clientNonce: { in: stages.map(({ run }) => `group-report:${run.id}`) },
        },
        select: { clientNonce: true },
      })
    ).map((message) => message.clientNonce),
  );
  // A stage that handed its work on has ended; the next member's stage carries it.
  for (const message of await deps.prisma.message.findMany({
    where: {
      runId: { in: stages.map(({ run }) => run.id) },
      clientNonce: { startsWith: "group-handoff:" },
    },
    select: { runId: true },
  }))
    if (message.runId) reported.add(`group-report:${message.runId}`);
  let sent = 0;
  for (const { run, asked, groupId } of stages) {
    if (reported.has(`group-report:${run.id}`)) continue;
    // A finished turn is an open stage only while its own research still runs at the provider.
    if (
      run.status === "completed" &&
      !(
        run.thread.activeRecruitingRoleId &&
        (await recruitingResearchInFlight(
          deps.prisma,
          run.thread.activeRecruitingRoleId,
          now.getTime(),
          { botId: run.botId, threadId: run.threadId },
        ))
      )
    )
      continue;
    const busy = await deps.prisma.run.count({
      where: {
        threadId: run.threadId,
        botId: asked.fromBotId,
        status: { in: ["queued", "leased", "running"] },
      },
    });
    if (busy) continue;
    const minutes = Math.floor((now.getTime() - run.createdAt.getTime()) / 60_000);
    const people = run.thread.activeRecruitingRoleId
      ? await deps.prisma.recruitingCandidate.count({
          where: { roleId: run.thread.activeRecruitingRoleId },
        })
      : undefined;
    const doing =
      run.status === "completed"
        ? "is waiting for its research results"
        : run.status === "queued"
          ? "has not started yet"
          : "is still running";
    const slot = Math.floor(minutes / (STAGE_WATCH_MS / 60_000));
    // The first check-in of a long stage is where the recruiter is offered an email at the end.
    const offerEmail =
      deps.completionEmail &&
      slot === 1 &&
      !(await completionEmailAnswered(deps.prisma, run).catch(() => true));
    const state = `the stage you handed me ${minutes} minutes ago ${doing}${
      people === undefined ? "." : `; the role's Results hold ${people} people.`
    }${offerEmail ? ` ${COMPLETION_EMAIL_OFFER}` : ""}`;
    const report = await reportGroupHandoffOutcome(deps, run, groupId, {
      status: "progress",
      watch: { slot, state },
    }).catch((error) => {
      getLogger().error("stage watch report", error);
      return undefined;
    });
    if (report) sent += 1;
  }
  return sent;
}
