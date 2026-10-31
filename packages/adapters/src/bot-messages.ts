import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest =
    (context.intent === "result" || context.intent === "status" || context.intent === "fyi") &&
    replyBlocks.some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === context.fromBotId &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    );
  return { ...context, repliesToRequest };
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
    /** Another conversation of this user that the target bot belongs to (a role team's chat). */
    thread_id?: string;
    /** Names shown for each side when they differ from the bots' own names. */
    sender_label?: string;
    target_label?: string;
  },
  options?: { allowTerminalSource?: boolean; forceUnread?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false as const,
      error: `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit`,
    };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true, name: true, title: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  // The same bot may work in another conversation (Kruit and a role team's coordinator).
  const crossThread = Boolean(input.thread_id && input.thread_id !== run.threadId);
  if (target.id === sender.id && !crossThread)
    return { ok: false as const, error: "a bot cannot message itself" };
  const targetName = input.target_label ?? target.name;
  const senderName = input.sender_label ?? sender.name;
  const addressedThread = input.thread_id
    ? await deps.prisma.thread.findFirst({
        where: {
          id: input.thread_id,
          spaceId: run.spaceId,
          userId: run.userId,
          group: { archivedAt: null, members: { some: { botId: target.id } } },
        },
        select: { id: true },
      })
    : target.thread;
  if (!addressedThread)
    return { ok: false as const, error: `${targetName} has no chat to deliver to` };
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const targetThreadId = addressedThread.id;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: targetName,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${targetName} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({
    from: { ...sender, name: senderName },
    text: message,
    intent,
  });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: targetName,
    text: message,
    intent,
  };

  let committed:
    | {
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
      };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const };
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: options?.allowTerminalSource
              ? { in: ["completed", "failed", "cancelled"] }
              : "running",
          },
          select: { id: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${targetName} is no longer available` };

        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          runId: run.id,
          markUnread: options?.forceUnread === true,
          allowCancelledRun: options?.allowTerminalSource === true,
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: senderName,
          text: message,
          hop,
          intent,
          returnToMessageId: outbound.id,
          ...(crossThread ? { returnThreadId: run.threadId } : {}),
        };
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          blocks: [inboundBlock],
          replyToMessageId:
            sourceContext?.fromBotId === target.id &&
            intent !== "fyi" &&
            // The echo being answered must live in the conversation receiving this reply.
            (!crossThread || sourceContext.returnThreadId === targetThreadId)
              ? sourceContext.returnToMessageId
              : undefined,
          clientNonce: deliveryKey,
          markUnread: options?.forceUnread === true,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: wakePrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            sourceMessageId: inbound.id,
          },
          select: { id: true },
        });
        await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun.id,
          payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          allowCancelledRun: options?.allowTerminalSource === true,
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return {
          ok: true as const,
          runId: nextRun.id,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
        };
      }),
    );
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("bot message enqueue", error);
  });
  return {
    ok: true as const,
    botId: target.id,
    name: targetName,
    delivered: message,
    note: `Sent to ${targetName}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  // Work delegated from another conversation returns once, when the team's whole chain is done.
  if (source.returnThreadId && intent === "result") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    await returnDelegatedTeamOutcome(deps, run);
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  // A request delegated from another conversation returns there, named after this one.
  const returnThread = source.returnThreadId
    ? await deps.prisma.thread.findFirst({
        where: { id: run.threadId, spaceId: run.spaceId, userId: run.userId },
        select: { group: { select: { name: true } } },
      })
    : null;
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(text),
      intent,
      ...(source.returnThreadId
        ? {
            thread_id: source.returnThreadId,
            target_label: source.fromBotName,
            ...(returnThread?.group ? { sender_label: `${returnThread.group.name} team` } : {}),
          }
        : {}),
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    {
      allowTerminalSource: true,
      forceUnread: options?.forceUnread,
    },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

/**
 * A role team's conversation went quiet after work another conversation delegated to it: send
 * the team's latest reply back there, exactly once per delegated request. Waits while a teammate
 * still has a turn queued, running or waiting on the recruiter, or the role's research is still
 * running, so a handoff to a specialist returns the specialist's result, not "it's on it".
 */
export async function returnDelegatedTeamOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
): Promise<void> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: run.threadId, spaceId: run.spaceId, userId: run.userId, groupId: { not: null } },
    select: { activeRecruitingRoleId: true, group: { select: { name: true } } },
  });
  if (!thread?.group) return;
  const since = new Date(Date.now() - DELEGATION_RETURN_WINDOW_MS);
  const delegated = await deps.prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      role: "user",
      createdAt: { gte: since },
      blocks: { array_contains: [{ kind: "bot_message_received" }] },
    },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true, blocks: true },
  });
  const root = botMessageContext(
    Array.isArray(delegated?.blocks) ? (delegated.blocks as MessageBlock[]) : [],
  );
  // Only a request answers back; a returned result never bounces to the team again.
  if (!delegated || !root?.returnThreadId) return;
  if (root.intent !== undefined && root.intent !== "request" && root.intent !== "question") return;
  const busy = await deps.prisma.run.findFirst({
    where: {
      threadId: run.threadId,
      id: { not: run.id },
      status: { in: ["queued", "running", "waiting_input"] },
    },
    select: { id: true },
  });
  if (busy) return;
  if (
    thread.activeRecruitingRoleId &&
    (await recruitingResearchInFlight(deps.prisma, thread.activeRecruitingRoleId))
  )
    return;
  // The team's replies since the request, up to the recruiter's next own message there.
  const later = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, seq: { gt: delegated.seq } },
    orderBy: { seq: "asc" },
    take: 200,
    select: { role: true, blocks: true },
  });
  let text = "";
  for (const message of later) {
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    if (message.role === "user" && !botMessageContext(blocks)) break;
    if (message.role !== "bot") continue;
    const reply = blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (reply) text = reply;
  }
  if (!text) return;
  const sent = await messageBot(
    deps,
    run,
    { id: run.botId, name: thread.group.name },
    {
      bot_id: root.fromBotId,
      thread_id: root.returnThreadId,
      sender_label: `${thread.group.name} team`,
      target_label: root.fromBotName,
      message: clampBotMessage(text),
      intent: "result",
      deliveryKey: `delegation-outcome:${delegated.id}`,
    },
    { allowTerminalSource: true },
  );
  if (!sent.ok)
    getLogger().warn("delegated team outcome not returned", { runId: run.id, error: sent.error });
}

/** Only a recent delegation is still waiting for its team's result. */
const DELEGATION_RETURN_WINDOW_MS = 24 * 60 * 60 * 1000;

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed", "cancelled"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
