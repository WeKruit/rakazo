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
  cancelRunsInTransaction,
  countRecruitingPeopleFoundSince,
  createThreadMessageInTransaction,
  listRecruitingPeopleFoundSince,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import { readMailReplyOutcomeReport } from "./mail-reply.js";
import { roundAwaitingReview } from "./recruiting-grading.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";
import { ROUND_HEADING, roundListedNotRecorded } from "./recruiting-round-check.js";
import { recruitingRoundListText } from "./turn-end-guard.js";
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
      ? `${progress.note} This message reaches that work now and is answered there; never say a new search began.`
      : `Sent to ${targetName}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
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
        // Staging 11-15: a role opened from Kruit's chat ran its first round on the copy of the
        // recruiter's words, and meanwhile Kruit listed seven unchecked people from Results.
        { sourceMessage: { is: { clientNonce: { startsWith: ROLE_START_NONCE } } } },
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
  if (!working) return null;
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
          .catch(() => null)
      : null;
  // Staging 11-15: told round 2 was "already shown in the role's chat" while the Reviewer still
  // held it, Kruit sent the recruiter to the role, where nothing was shown yet.
  const held =
    roleId && recorded
      ? (await roundAwaitingReview(prisma, { threadId: input.threadId, roleId }).catch(
          () => null,
        )) === recorded.round
      : false;
  const minutes = Math.max(0, Math.round((Date.now() - since.getTime()) / 60_000));
  const started = minutes < 1 ? "under a minute" : `${minutes} min`;
  const found = `${peopleFound} ${peopleFound === 1 ? "person" : "people"}`;
  return {
    name: working.bot.name,
    minutes,
    peopleFound,
    // Staging 11-15: asked twice to "just show me the new ten" mid-round, Kruit only repeated the
    // count; the people found so far can be listed, marked as not yet reviewed.
    note: listed
      ? `The next round is being posted right now. Read it with recruiting_candidates round and roleId ${roleId} in a moment and show its people here; never say it is not ready, never mention records, and never send the recruiter to another chat.`
      : recorded && held
        ? `Round ${recorded.round} is picked and being checked by the Reviewer; it is shown here once, already checked (${started} on this request, ${found} found). Never list, name or count its people before it comes, never send the recruiter to another chat, and say in one line that the checked round is on its way.`
        : recorded
          ? `Round ${recorded.round} is already recorded and shown in the role's chat; ${working.bot.name} is still working on the rest of the recruiter's request (${started}, ${found} found). Read the round with recruiting_candidates round and this roleId and answer from it; never say the round is not ready.`
          : `${working.bot.name} has been working on the recruiter's request for ${started}${peopleFound ? ` and has found ${found} so far` : " and is searching now"}; the next round comes back here when it is picked. Give the recruiter these numbers once; never say it has not started.`,
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
  const found = await openDelegation(deps.prisma, run.threadId);
  if (!found) return;
  const { delegated, root } = found;
  // Staging 11-13: the role's intake turn sat on its next-step card the whole time, so a check
  // Kruit delegated finished in the role's chat and never came back. Only a card asked since the
  // request holds the result.
  const busy = await deps.prisma.run.findFirst({
    where: {
      threadId: run.threadId,
      id: { not: run.id },
      OR: [
        { status: { in: ["queued", "running"] } },
        { status: "waiting_input", createdAt: { gte: delegated.createdAt } },
      ],
      // Staging 11-13: Kruit asked "where's the next round?" twice while the round ran; those
      // follow-ups queued behind it and held the finished round back for six minutes. A later
      // request still queued is answered by this result, not waited on.
      NOT: { status: "queued", trigger: "bot_message", createdAt: { gt: delegated.createdAt } },
    },
    select: { id: true },
  });
  if (busy) return;
  if (
    thread.activeRecruitingRoleId &&
    (await recruitingResearchInFlight(deps.prisma, thread.activeRecruitingRoleId))
  )
    return;
  // Staging 11-15: a team turn ended right after recording round 2, its unchecked ten went back
  // and were listed, and the checked round never followed. The Reviewer's turn returns it.
  if (
    thread.activeRecruitingRoleId &&
    (await roundAwaitingReview(deps.prisma, {
      threadId: run.threadId,
      roleId: thread.activeRecruitingRoleId,
    }).catch(() => null)) !== null
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
  let round = "";
  let answeredThere = false;
  for (const message of later) {
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    if (message.role === "user" && !botMessageContext(blocks)) {
      answeredThere = true;
      break;
    }
    if (message.role !== "bot") continue;
    const reply = blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (reply) text = reply;
    if (ROUND_HEADING.test(reply)) round = reply;
  }
  // Staging 11-15: the recruiter answered the round in the role's chat, and nine minutes later
  // it came back here and was shown as the new search. A round is seen once, where it was.
  if (answeredThere && round) return;
  // Staging 11-14: only the team's closing line ("the next round has been posted") came back, so
  // Kruit could neither show the people nor say who has both must-haves. The round comes too.
  if (round && round !== text) text = `${text}\n\n${round}`;
  const saved =
    thread.activeRecruitingRoleId &&
    (await savedForRequest(deps.prisma, {
      threadId: run.threadId,
      spaceId: run.spaceId,
      roleId: thread.activeRecruitingRoleId,
      since: delegated.createdAt,
    }));
  // Gate 71a2cac2: beside the record, the team's "profiles show 6+ years" left Kruit squaring a
  // retelling with the record, and it contradicted itself. The record is the whole answer.
  if (saved) text = round ? `${round}\n\n${saved}` : saved;
  const mail = await readMailReplyOutcomeReport(deps.prisma, run);
  if (mail)
    text = `${mail.text}\n\nAdditional child output (may include earlier progress; the mail status above is authoritative):\n${text}`;
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

/**
 * Everyone the role's search saved for a request and no round lists, read from the record.
 * Long-search-finishes 11-15: "找20个人，好了叫我" saved 20, but the team's reply named the round's
 * 10 and 4 more, so Kruit listed 14 and said 6 were missing. A round after feedback is the
 * Reviewer's checked list and the whole answer: the recruiter sees each round once.
 */
async function savedForRequest(
  prisma: PrismaClient,
  input: { threadId: string; spaceId: string; roleId: string; since: Date },
) {
  const [keys, rounds] = await Promise.all([
    listRecruitingPeopleFoundSince(prisma, input),
    // A checked round replaces its held record in place and keeps the older time, so the
    // request's round is found by its people, not by when it was first recorded.
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId: input.roleId },
      select: { round: true, candidateKeys: true },
    }),
  ]);
  const found = new Set(keys);
  if (rounds.some((round) => round.round > 1 && round.candidateKeys.some((key) => found.has(key))))
    return "";
  const inRound = new Set(rounds.flatMap((round) => round.candidateKeys));
  const rest = keys.filter((key) => !inRound.has(key));
  if (!rest.length) return "";
  const listed = keys.length - rest.length;
  const all = `${keys.length} ${keys.length === 1 ? "person" : "people"} in all`;
  return recruitingRoundListText(prisma, {
    ...input,
    candidateKeys: rest,
    brief: true,
    firstNumber: listed + 1,
    // Long-search-finishes 11-15: given 19 of 20, Kruit promised to keep looking for one more
    // after the team had said the search found nobody new, and ended with paragraphs of caveats.
    heading: `The team finished this request and is looking for nobody more. Saved for it, from the record: ${all}${listed ? `, the round above and these ${rest.length}` : ""}. Reply with one line giving that count, then every one of them once, one line each, and nothing after the list:`,
  });
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
  const select = { id: true, seq: true, blocks: true, createdAt: true } as const;
  const [delegated, started] = await Promise.all([
    prisma.message.findFirst({
      where: { ...where, blocks: { array_contains: [{ kind: "bot_message_received" }] } },
      orderBy: { seq: "desc" },
      select,
    }),
    prisma.message.findFirst({
      where: { ...where, clientNonce: { startsWith: ROLE_START_NONCE } },
      orderBy: { seq: "desc" },
      select: { ...select, clientNonce: true, sourceRuns: { select: { botId: true }, take: 1 } },
    }),
  ]);
  // Long-search-finishes 11-15: a role opened from Kruit's chat with "找完告诉我" finished in the
  // role's chat and never came back, although Kruit had said it would tell the recruiter.
  if (started && (!delegated || started.seq > delegated.seq)) {
    const root = await roleStartReturn(prisma, threadId, started);
    if (root) return { delegated: started, root };
  }
  const root = botMessageContext(
    Array.isArray(delegated?.blocks) ? (delegated.blocks as MessageBlock[]) : [],
  );
  // Only a request answers back; a returned result never bounces to the team again.
  if (!delegated || !root?.returnThreadId) return null;
  if (root.intent !== undefined && root.intent !== "request" && root.intent !== "question")
    return null;
  return { delegated, root: { ...root, returnThreadId: root.returnThreadId } };
}

/** Where a role opened from Kruit's chat returns: the chat holding the recruiter's message. */
async function roleStartReturn(
  prisma: PrismaClient,
  threadId: string,
  started: { clientNonce: string | null; sourceRuns: Array<{ botId: string }> },
) {
  const askedId = started.clientNonce?.slice(ROLE_START_NONCE.length).split(":")[0];
  const fromBotId = started.sourceRuns[0]?.botId;
  if (!askedId || !fromBotId) return null;
  const role = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { spaceId: true, userId: true },
  });
  const asked = role
    ? await prisma.message.findFirst({
        where: {
          id: askedId,
          role: "user",
          thread: {
            spaceId: role.spaceId,
            userId: role.userId,
            groupId: { startsWith: "recruiting-global-" },
          },
        },
        select: { threadId: true },
      })
    : null;
  const bot = asked
    ? await prisma.bot.findFirst({ where: { id: fromBotId }, select: { name: true } })
    : null;
  if (!asked || !bot) return null;
  return {
    fromBotId,
    fromBotName: bot.name,
    returnThreadId: asked.threadId,
    intent: "request" as const,
  };
}

/**
 * A role team working on delegated work stopped to wait on the recruiter (an approval or a
 * question card) or failed: tell the conversation that delegated it right away, once per
 * turn, so it never waits silently behind the card.
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
  blocked: { kind: "waiting" | "failed"; text: string },
): Promise<void> {
  const thread = await deps.prisma.thread.findFirst({
    where: { id: run.threadId, spaceId: run.spaceId, userId: run.userId, groupId: { not: null } },
    select: { group: { select: { name: true } } },
  });
  if (!thread?.group) return;
  const found = await openDelegation(deps.prisma, run.threadId);
  if (!found) return;
  const detail = blocked.text.trim().slice(0, 600);
  const message =
    blocked.kind === "waiting"
      ? `Waiting on the recruiter in the ${thread.group.name} conversation, on its card: "${detail}". The work continues there once they answer.`
      : `The ${thread.group.name} team could not finish: ${detail}`;
  const sent = await messageBot(
    deps,
    run,
    { id: run.botId, name: thread.group.name },
    {
      bot_id: found.root.fromBotId,
      thread_id: found.root.returnThreadId,
      sender_label: `${thread.group.name} team`,
      target_label: found.root.fromBotName,
      message: clampBotMessage(message),
      intent: "status",
      deliveryKey: `delegation-${blocked.kind}:${run.id}`,
    },
    { allowTerminalSource: true },
  );
  if (!sent.ok)
    getLogger().warn("delegated team block not reported", { runId: run.id, error: sent.error });
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
