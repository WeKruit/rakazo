import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
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
  cancelRunsInTransaction,
  countRecruitingPeopleFoundSince,
  createThreadMessageInTransaction,
  lockConversationPair,
  mirrorAskInTransaction,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sleep } from "./background-wait.js";
import type { ExecutorDeps } from "./executor.js";
import { readMailReplyOutcomeReport } from "./mail-reply.js";
import { roundListedNotRecorded } from "./recruiting-round-check.js";
import { ROLE_START_NONCE } from "./working-state.js";

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
    /** The recruiter's own words the message hands over, kept apart from the brief. */
    recruiter_words?: string;
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
      error: "bot-to-bot message limit reached for this chain; nothing was sent",
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
        working: boolean;
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
        await lockConversationPair(tx, [run.threadId, targetThreadId]);
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
          ...(input.recruiter_words?.trim()
            ? { recruiterWords: input.recruiter_words.trim() }
            : {}),
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
        // Staging 11-14: Kruit passed each "where is it?" on as its own request while the team
        // worked, and they ran one after another behind it, each redoing the round. A newer
        // request from the same conversation replaces one not yet started; that turn still sees
        // the older request in the conversation.
        const superseded =
          crossThread && (intent === "request" || intent === "question")
            ? await tx.run.findMany({
                where: {
                  threadId: targetThreadId,
                  botId: target.id,
                  trigger: "bot_message",
                  status: "queued",
                  leaseFence: 0,
                  sourceMessage: {
                    is: {
                      blocks: {
                        array_contains: [
                          { kind: "bot_message_received", returnThreadId: run.threadId },
                        ],
                      },
                    },
                  },
                },
                select: { id: true, taskId: true },
              })
            : [];
        if (superseded.length) {
          await cancelRunsInTransaction(tx, superseded, new Date());
          for (const stale of superseded)
            await appendEventInTransaction(tx, {
              spaceId: run.spaceId,
              threadId: targetThreadId,
              botId: target.id,
              type: "run.cancelled",
              runId: stale.id,
              payload: { reason: "superseded" },
            });
        }
        // Staging 11-14: asked "where are they?" while the team was still searching, Kruit read
        // the role's status, saw no new round and told the recruiter the search had not started.
        const working =
          crossThread && (intent === "request" || intent === "question")
            ? await teamWorkingFor(tx, { threadId: targetThreadId, returnThreadId: run.threadId })
            : null;
        // Staging 11-15: "where are the new ones?" queued behind the round it asked about, then
        // ran a second paid search after that round was shown. A request from the same
        // conversation is steered into the team's running turn instead, like a person's message.
        let targetRunId: string;
        if (working) {
          await tx.steeringMessage.create({
            data: {
              messageId: inbound.id,
              botId: working.botId,
              userId: run.userId,
              runId: working.id,
            },
          });
          targetRunId = working.id;
        } else {
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
          targetRunId = nextRun.id;
        }
        await tx.message.update({ where: { id: inbound.id }, data: { runId: targetRunId } });
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: working?.botId ?? target.id,
          type: "thread.message.created",
          runId: targetRunId,
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
          runId: targetRunId,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
          working: Boolean(working),
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
  // A request steered into the team's running turn has no turn of its own to start.
  if (!committed.working)
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      // The queued run is durable; the job reconciler repairs a missed wake.
      getLogger().error("bot message enqueue", error);
    });
  const progress = committed.working
    ? await teamProgress(deps.prisma, {
        threadId: targetThreadId,
        returnThreadId: run.threadId,
      }).catch(() => null)
    : null;
  return {
    ok: true as const,
    botId: target.id,
    name: targetName,
    delivered: message,
    note: progress
      ? `${progress.note} This message reaches that work now and is answered there.`
      : `Sent to ${targetName}; a reply arrives later as a new message.`,
  };
}

/** The role team's turn still working on a request sent from the given conversation, if any. */
export function teamWorkingFor(
  prisma: Pick<PrismaClient, "run">,
  input: {
    threadId: string;
    returnThreadId: string;
    /** A turn requeued after a follow-up was steered into it is still on the request. */
    queued?: boolean;
  },
): Promise<{
  id: string;
  botId: string;
  createdAt: Date;
  startedAt: Date | null;
  bot: { name: string };
} | null> {
  return prisma.run.findFirst({
    where: {
      threadId: input.threadId,
      status: { in: input.queued ? ["queued", "leased", "running"] : ["leased", "running"] },
      OR: [
        {
          trigger: "bot_message",
          sourceMessage: {
            is: {
              blocks: {
                array_contains: [
                  { kind: "bot_message_received", returnThreadId: input.returnThreadId },
                ],
              },
            },
          },
        },
        // The teammate the work was handed to: with one lane per agent, a request that missed it
        // would start a second turn beside it instead of steering the one doing the work.
        { trigger: "follow_up" },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      botId: true,
      createdAt: true,
      startedAt: true,
      bot: { select: { name: true } },
    },
  });
}

/**
 * What the role team is doing on a request from the given conversation, with live numbers, so a
 * "where are they?" is answered with progress instead of "still in progress".
 */
export async function teamProgress(
  prisma: PrismaClient,
  input: { threadId: string; returnThreadId: string; roleId?: string },
): Promise<{ name: string; minutes: number; peopleFound: number; note: string } | null> {
  // Staging 11-15: a follow-up requeued the team's turn for 50 s, and in between Kruit listed
  // three pages of unchecked people from Results.
  const working = await teamWorkingFor(prisma, { ...input, queued: true });
  if (!working) {
    // fosp 11-22 (352978a2): the team's turn had ended while its people were still being checked,
    // so Kruit read the record, saw nothing new and said "0 new" three times. A finished turn
    // whose answer has not come back yet is still the team working on the request.
    const pending = await prisma.run.findFirst({
      where: {
        threadId: input.threadId,
        trigger: "bot_message",
        status: "completed",
        botOutcomeReturnedAt: null,
        sourceMessage: {
          is: {
            blocks: {
              array_contains: [
                { kind: "bot_message_received", returnThreadId: input.returnThreadId },
              ],
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, bot: { select: { name: true } } },
    });
    if (!pending) return null;
    const minutes = Math.max(0, Math.round((Date.now() - pending.createdAt.getTime()) / 60_000));
    return {
      name: pending.bot.name,
      minutes,
      peopleFound: 0,
      note: `The team has searched for the recruiter's request (${minutes < 1 ? "under a minute" : `${minutes} min`} ago) and the people it found are being checked against the requirements; the result shows in the role's conversation.`,
    };
  }
  const since = working.startedAt ?? working.createdAt;
  const roleId =
    input.roleId ??
    (
      await prisma.thread.findUnique({
        where: { id: input.threadId },
        select: { activeRecruitingRoleId: true },
      })
    )?.activeRecruitingRoleId;
  const [peopleFound, recorded] = roleId
    ? await Promise.all([
        countRecruitingPeopleFoundSince(prisma, { roleId, since }),
        // Staging 11-15: the team kept working after recording round 2, and Kruit said the new
        // ten were not finalized a minute after they were shown.
        Promise.resolve()
          .then(() =>
            prisma.recruitingCalibrationRound.findFirst({
              where: { roleId, createdAt: { gte: since } },
              orderBy: { round: "desc" },
              select: { round: true },
            }),
          )
          .catch(() => null),
      ])
    : [0, null];
  // Staging 11-15: listed in the role's chat 23 s before its record was written, the new round
  // read as "not ready" in between.
  const listed =
    roleId && !recorded
      ? await Promise.resolve()
          .then(() => roundListedNotRecorded(prisma, { roleId, after: since.toISOString() }))
          .catch(() => false)
      : false;
  const minutes = Math.max(0, Math.round((Date.now() - since.getTime()) / 60_000));
  const started = minutes < 1 ? "under a minute" : `${minutes} min`;
  // fr/fosp 11-20: "found 35 so far, with 43 saved overall" was stale a minute later and read as
  // people the recruiter would get ("我只要20个"), so the note gives only time.
  return {
    name: working.bot.name,
    minutes,
    peopleFound,
    // Staging 11-15: asked twice to "just show me the new ten" mid-round, Kruit only repeated the
    // count; the people found so far can be listed, marked as not yet reviewed.
    note: listed
      ? `The next round is being posted in the role's conversation right now.`
      : recorded
        ? `Round ${recorded.round} is recorded and shown in the role's conversation; ${working.bot.name} is still working on the rest of the recruiter's request (${started}).`
        : `${working.bot.name} has been working on the recruiter's request for ${started}; its rounds show in the role's conversation.`,
  };
}

/**
 * The result of work another conversation delegated to this run, once the role's conversation is
 * idle: "working" while any run there is still active (up to the delegation window, Workloop's
 * deadlock bound), "later" when a later request from the same conversation, with a live turn of its
 * own, carries the result, else the newest reply since the request.
 */
async function settledTeamResult(
  prisma: PrismaClient,
  run: { id: string; threadId: string; sourceMessageId?: string | null },
  returnThreadId: string,
): Promise<"working" | "later" | { text: string }> {
  const request = run.sourceMessageId
    ? await prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: { seq: true, createdAt: true },
      })
    : null;
  if (!request) return { text: "" };
  const active = await prisma.run.count({
    where: {
      threadId: run.threadId,
      id: { not: run.id },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
  });
  if (active && Date.now() - request.createdAt.getTime() < DELEGATION_RETURN_WINDOW_MS)
    return "working";
  const later = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      seq: { gt: request.seq },
      OR: (["request", "question"] as const).map((intent) => ({
        blocks: { array_contains: [{ kind: "bot_message_received", returnThreadId, intent }] },
      })),
      sourceRuns: { some: { trigger: "bot_message", status: { notIn: ["cancelled", "failed"] } } },
    },
    select: { id: true },
  });
  if (later) return "later";
  const reply = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      role: "bot",
      seq: { gt: request.seq },
      blocks: { array_contains: [{ kind: "text" }] },
    },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });
  const blocks = Array.isArray(reply?.blocks) ? (reply.blocks as MessageBlock[]) : [];
  return {
    text: blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n\n")
      .trim(),
  };
}

/**
 * When a run in a role's conversation ends, return any delegated request there whose result is
 * still owed: the run that took the request may have ended earlier, at a hand-off to a teammate or
 * with work continuing in another run.
 */
export async function returnSettledDelegations(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  threadId: string,
): Promise<void> {
  const owed = await deps.prisma.run.findMany({
    where: {
      threadId,
      trigger: "bot_message",
      status: "completed",
      botOutcomeReturnedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      sourceMessageId: true,
      bot: { select: { name: true } },
    },
  });
  for (const run of owed)
    await returnBotMessageOutcome(deps, run, { id: run.botId, name: run.bot.name }, "", "status");
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
  runText: string,
  runIntent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  let text = runText;
  let intent = runIntent;
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
  // Work delegated from another conversation returns there once, when the whole job is done: the
  // role's conversation is idle (no run or search of any teammate still going, as Workloop's IsIdle),
  // and its newest reply is the result, the way a Claude Code subagent's final message returns to
  // its parent. Progress never goes back (send-at-night 11-16: each one woke Kruit, which posted
  // again and asked the team a second time); a failure goes back at once.
  if (source.returnThreadId && !options?.forceUnread) {
    const settled = await settledTeamResult(deps.prisma, run, source.returnThreadId);
    if (settled === "working") return false;
    if (settled === "later") {
      await markBotOutcomeReturned(deps.prisma, run.id);
      return true;
    }
    text =
      settled.text || text.trim() || "The role's conversation finished without a written reply.";
    intent = "result";
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
  const mail = intent === "result" ? await readMailReplyOutcomeReport(deps.prisma, run) : undefined;
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(
        mail
          ? `${mail.text}\n\nAdditional child output (may include earlier progress; the mail status above is authoritative):\n${text}`
          : text,
      ),
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
 * Whether the recruiter's newest own message since the request was written in the role's chat:
 * they are there, so its card and result are already in front of them and need no copy in the chat
 * that asked. Branch sends 11-20: with Kruit docked beside the role's chat, the send card and its
 * result showed in both, read as "the same result posted twice". Workloop posts a child's card in
 * the user's thread only because the user is not in the child's.
 */
async function recruiterInRoleChat(
  prisma: PrismaClient,
  input: { roleThreadId: string; returnThreadId: string; since: Date },
): Promise<boolean> {
  const recent = await prisma.message.findMany({
    where: {
      threadId: { in: [input.roleThreadId, input.returnThreadId] },
      role: "user",
      createdAt: { gt: input.since },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      threadId: true,
      clientNonce: true,
      botId: true,
      externalTranscriptFor: { select: { id: true } },
      blocks: true,
    },
  });
  // The recruiter's own words: not a teammate's hand-in, a pushed-on turn, a role's opening copy of
  // the request or a mail transcript.
  const latest = recent.find(
    (message) =>
      message.botId === null &&
      !message.externalTranscriptFor &&
      !message.clientNonce?.startsWith("autocontinue:") &&
      !message.clientNonce?.startsWith(ROLE_START_NONCE) &&
      Array.isArray(message.blocks) &&
      message.blocks.length > 0 &&
      (message.blocks as MessageBlock[]).every((block) =>
        ["text", "file", "image"].includes(block?.kind),
      ),
  );
  return latest?.threadId === input.roleThreadId;
}

/** The latest request another conversation delegated to this role team, if it still answers back. */
async function openDelegation(prisma: PrismaClient, threadId: string) {
  const since = new Date(Date.now() - DELEGATION_RETURN_WINDOW_MS);
  const where = {
    threadId,
    role: "user",
    createdAt: { gte: since },
    // A request whose turn has not started yet is not the work that just finished.
    sourceRuns: { none: { status: "queued" as const } },
  };
  const delegated = await prisma.message.findFirst({
    where: { ...where, blocks: { array_contains: [{ kind: "bot_message_received" }] } },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true, blocks: true, createdAt: true },
  });
  const root = botMessageContext(
    Array.isArray(delegated?.blocks) ? (delegated.blocks as MessageBlock[]) : [],
  );
  // Only a request answers back; a returned result never bounces to the team again.
  if (!delegated || !root?.returnThreadId) return null;
  if (root.intent !== undefined && root.intent !== "request" && root.intent !== "question")
    return null;
  return { delegated, root: { ...root, returnThreadId: root.returnThreadId } };
}

/**
 * A role team working on delegated work failed: tell the conversation that delegated it right
 * away, once per turn, so it never waits silently.
 */
export async function reportDelegatedTeamBlocked(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  blocked: { kind: "failed"; text: string },
): Promise<"later" | undefined> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: run.threadId, spaceId: run.spaceId, userId: run.userId, groupId: { not: null } },
    select: { group: { select: { name: true } } },
  });
  if (!thread?.group) return;
  const found = await openDelegation(deps.prisma, run.threadId);
  if (!found) return;
  const detail = blocked.text.trim().slice(0, 600);
  const sent = await messageBot(
    deps,
    run,
    { id: run.botId, name: thread.group.name },
    {
      bot_id: found.root.fromBotId,
      thread_id: found.root.returnThreadId,
      sender_label: `${thread.group.name} team`,
      target_label: found.root.fromBotName,
      message: clampBotMessage(`The ${thread.group.name} team could not finish: ${detail}`),
      intent: "status",
      deliveryKey: `delegation-${blocked.kind}:${run.id}`,
    },
    { allowTerminalSource: true },
  );
  if (!sent.ok)
    getLogger().warn("delegated team block not reported", { runId: run.id, reason: sent.error });
}

/**
 * A role team working on delegated work stopped on a card (a question, form or approval): show
 * that card in the conversation that delegated the work, where the recruiter is, and route the
 * answer back to the waiting run. Workloop does the same for a child agent waiting on a person;
 * the delegating agent is not woken. Staging 11-16: the old "waiting on its card" message was
 * refused every time (the paused run is neither running nor finished), 194 times in 24 h.
 */
export async function showDelegatedTeamCard(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: { id: string; spaceId: string; threadId: string; userId: string },
): Promise<"later" | undefined> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: run.threadId, spaceId: run.spaceId, userId: run.userId, groupId: { not: null } },
    select: { id: true },
  });
  if (!thread) return;
  const found = await openDelegation(deps.prisma, run.threadId);
  if (!found) return;
  const card = await deps.prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      runId: run.id,
      role: "bot",
      blocks: { array_contains: [{ kind: "ask", status: "pending" }] },
    },
    orderBy: { seq: "desc" },
    select: { id: true },
  });
  if (!card) return;
  if (
    await recruiterInRoleChat(deps.prisma, {
      roleThreadId: run.threadId,
      returnThreadId: found.root.returnThreadId,
      since: found.delegated.createdAt,
    })
  )
    return;
  const shown = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      // The source card's row too, so an answer to it cannot write the copy's row mid-way.
      await lockConversationPair(tx, [run.threadId, found.root.returnThreadId]);
      return mirrorAskInTransaction(tx, {
        spaceId: run.spaceId,
        sourceThreadId: run.threadId,
        sourceMessageId: card.id,
        runId: run.id,
        targetThreadId: found.root.returnThreadId,
        botId: found.root.fromBotId,
      });
    }),
  );
  if (shown) await deps.events.notify(shown.threadId, shown.seq);
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
