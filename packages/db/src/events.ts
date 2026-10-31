import { createHash, randomUUID } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type {
  AskAnswer,
  AskFormResponse,
  BotSecretDestination,
  ConnectionAskAnswer,
  MessageBlock,
  ProductEvent,
} from "@rakazo/contracts";
import {
  encodeLoginSecret,
  LoginSecretValue,
  MessageBlock as MessageBlockSchema,
  parseAskFormResponse,
  RecruitingSchedulingApprovalEvidenceSchema,
} from "@rakazo/contracts";
import {
  askFormAnswerText,
  blocksToAgentHistoryText,
  boundDirectApprovalDetails,
  callIdFromClientNonce,
  catalogApprovalDetails,
  isApprovalAskBlock,
  isConversationalRun,
  isSecretAskBlock,
  messagingChannelId,
  resolveAskChoice,
  runsBesidePerson,
  sanitizeJsonValue,
  type WorkActivity,
  workActivityForTool,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { getLogger } from "@rakazo/logging";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { loadConnectServer } from "./connect-asks.js";
import {
  assertRunCanWriteHistory,
  assertRunIsCancelled,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";
import type { RecruitingQuestionPauseContext } from "./recruiting.js";
import {
  authorizeRecruitingApprovalAnswerInTransaction,
  authorizeRecruitingFeedbackMessage,
  authorizeRecruitingQuestionAnswerInTransaction,
  commitRecruitingQuestionInTransaction,
  prepareRecruitingQuestionInTransaction,
} from "./recruiting.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

const EVENT_BATCH_SIZE = 200;
/** Live-only events one follower may hold while its client is not reading. */
export const MAX_PENDING_TRANSIENTS = 100;
/**
 * Interject marker stored in SteeringMessage.originTrigger (no migration). Only rows
 * attached to a live conversational run carry it; it is cleared when a row reverts to
 * pending so the pending filters (originTrigger null | "messaging") still match.
 */
export const INTERRUPT_ORIGIN = "interrupt";
/** Unread input reserved for the next turn, released by the existing continuation path. */
export const FOLLOW_UP_ORIGIN = "follow_up";
/** Run nonce of a background follow-up on a people search that outlived its turn. */
export const RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX = "recruiting-agent-run-wait:";

/**
 * Whether a run takes a person's new message into its turn. A background follow-up on a people
 * search never does: the message waits for the person's own turn, which the follow-up gives
 * way to.
 */
function takesMessages(run: { trigger: string | null; clientNonce?: string | null }): boolean {
  return (
    isConversationalRun(run.trigger) &&
    !run.clientNonce?.startsWith(RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX)
  );
}
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;
/** Without push, each sidebar wake re-lists the roster, so poll no faster than the old client did. */
const SIDEBAR_POLL_ONLY_CATCH_UP_MS = 5_000;
// ponytail: process-local per-client/thread backpressure; DB row locks remain the cross-process authority.
const appendTails = new WeakMap<PrismaClient, Map<string, Promise<void>>>();

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  /** Terminal echo after the run is already cancelled. Every other event stays rejected. */
  allowCancelledRun?: boolean;
}

export interface ThreadEvents {
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  finalizeComputerControlRelease(
    input: FinalizeComputerControlReleaseInput,
  ): Promise<FinalizeComputerControlReleaseResult | false>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  notify(threadId: string, seq: number): Promise<void>;
  /** Fan a live-only event (streaming progress) out over realtime without storing it. */
  publishTransient(input: AppendEventInput): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<boolean>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
  /** Wake once per sidebar-relevant change to the actor's own bots (see SIDEBAR_EVENT_TYPES). */
  followSidebar(
    actor: { spaceId: string; userId: string },
    signal?: AbortSignal,
  ): AsyncGenerator<SidebarSignal | undefined>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
}

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string | null;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
  /** Interject: the sender asked to interrupt the live reply rather than wait for it. */
  interrupt?: true;
}

/** ISO timestamps of the current attempt, carried on run progress and run.completed. */
export interface RunTiming {
  activeSince: string;
  resumedAt: string | null;
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        blocks: MessageBlock[];
        markUnread?: boolean;
        /** When this attempt began executing, and when it resumed after a restart (else null). */
        timing?: RunTiming;
        /** Model calls this attempt retried after a stalled stream, kept on run.completed. */
        modelRetries?: number;
      }
    | { outcome: "failed"; error: string }
  );

export interface PauseRunForInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
  /** Server-owned replay binding; reuse its pending native card without rewriting it. */
  existingApprovalEffectId?: string;
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
  /** Server-owned native question binding; model tool arguments never supply this context. */
  recruitingQuestion?: RecruitingQuestionPauseContext;
  /** Model calls this attempt retried after a stalled stream, kept on run.waiting_input. */
  modelRetries?: number;
}

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

function choiceAskCheckpoint(actions: Array<{ id: string; label: string }>): string {
  return JSON.stringify({ kind: CHOICE_ASK_CHECKPOINT_KIND, actions });
}

function resumeChoiceLabel(
  selected: { id: string; label: string },
  checkpoint: string | null | undefined,
): string {
  if (!checkpoint) return selected.label;
  try {
    const parsed = JSON.parse(checkpoint) as {
      kind?: string;
      actions?: Array<{ id?: unknown; label?: unknown }>;
    };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND || !Array.isArray(parsed.actions)) {
      return selected.label;
    }
    const offered = parsed.actions.find((action) => action.id === selected.id);
    return typeof offered?.label === "string" && offered.label.length > 0
      ? offered.label
      : selected.label;
  } catch {
    return selected.label;
  }
}

/**
 * Keep authoritative task state, including resolved private choice labels. The
 * executor separately projects native goals/questions/answers into conversation turns.
 */
function resumePrompt(
  run: { trigger: string; task?: { prompt: string } | null },
  question: string,
  answer: string,
): string {
  return [run.task?.prompt, `${question}\nAnswer: ${answer}`]
    .filter((part) => part?.trim())
    .join("\n\n");
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
}

export interface AnswerRunInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answeredByUserId: string;
  answer: AskAnswer;
  /** Server-only: an authenticated composer message already created in this transaction. */
  answerMessageId?: string;
  /** Identifies a spoken answer as part of a live voice call. */
  clientNonce?: string;
  /** Only for a login card; `answer` carries its password. */
  username?: string;
}

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  clientNonce?: string;
  linkMessageToRun?: boolean;
  /** Server-only wake: never a human statement or an approval source. */
  internal?: boolean;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
  /**
   * Server continuations of a finished turn: a run of this bot still waiting on an earlier card
   * does not take the message (it would only see it once that card is answered), so a new run starts.
   */
  skipWaitingRuns?: boolean;
  /** Interject: interrupt the busy run's live model stream with this message. */
  interrupt?: boolean;
  queueMode?: "steer" | "follow_up";
  /** Server-only: recheck and claim this saved event routine in the message transaction. */
  routineEvent?: {
    routineId: string;
    source: "webhook" | "github" | "messaging";
    provider?: string;
    webhookSecretId?: string;
  };
  /** Model pinned by a native inbound sender. */
  modelPin?: {
    modelProvider: string;
    modelId: string;
    thinkingLevel: string | null;
  };
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
  /** An event routine's durable receipt already existed; do not enqueue it again. */
  replayed?: true;
}

export interface RunSecretWriter {
  withPrepared?<T>(
    prisma: PrismaClient,
    input: AnswerRunInput,
    commit: (writer: RunSecretWriter) => Promise<T>,
  ): Promise<T>;
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: { catchUpMs?: number; runSecretWriter?: RunSecretWriter } = {},
): ThreadEvents {
  return {
    answerRunInput: (input) => answerRunInput(prisma, input, realtime, options.runSecretWriter),
    append: (input) => appendEvent(prisma, input, realtime),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    notify: (threadId, seq) => notifyRealtime(realtime, threadId, seq),
    publishTransient: (input) => publishTransientThreadEvent(prisma, input, realtime),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
    followSidebar: (actor, signal) => followSidebar(actor, realtime, signal, options.catchUpMs),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
      },
      data: { unread: false },
      select: { nextMessageSeq: true, historyCompactionGeneration: true },
    });
    const activeRuns = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        threadId: input.threadId,
        ...(input.groupId ? {} : { botId: input.botId }),
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, taskId: true },
    });
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    await cancelRunsInTransaction(tx, activeRuns, now);
    // Expire as tombstones so a still-open provider screen claim cannot reset fencing to 1.
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: runIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    await tx.message.deleteMany({ where: { threadId: input.threadId } });
    await tx.event.deleteMany({ where: { threadId: input.threadId } });
    if (thread.nextMessageSeq > 0) {
      // nextMessageSeq is not reset, so mark every deleted message as already compacted.
      // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
      // to null, immediately re-fire on the fresh conversation).
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactedUpToSeq: thread.nextMessageSeq - 1,
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    } else {
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    }
    if (input.groupId) {
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
    } else {
      await tx.bot.update({
        where: { id: input.botId, spaceId: input.spaceId },
        data: { updatedAt: now },
      });
    }
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: runIds,
      historyCompactionGeneration: thread.historyCompactionGeneration,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
  };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (
    db: Pick<PrismaClient, "message" | "run"> = prisma,
  ): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const include = { sourceRuns: { orderBy: { createdAt: "asc" as const }, take: 1 } };
    const message = input.routineEvent
      ? await db.message.findFirst({
          where: {
            clientNonce: input.clientNonce,
            sourceRuns: {
              some: {
                routineId: input.routineEvent.routineId,
                spaceId: input.spaceId,
                botId: input.botId,
                userId: input.userId,
              },
            },
          },
          include,
        })
      : await db.message.findUnique({
          where: {
            threadId_clientNonce: { threadId: input.threadId, clientNonce: input.clientNonce },
          },
          include,
        });
    if (!message) return null;
    const created = message.sourceRuns[0];
    const run =
      created ?? (message.runId ? await db.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
      ...(input.routineEvent ? { replayed: true as const } : {}),
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let modelPin = input.modelPin;
      if (input.routineEvent) {
        const routineEvent = input.routineEvent;
        if (
          input.trigger !== "webhook" ||
          input.createRun === false ||
          (routineEvent.source === "messaging"
            ? !routineEvent.provider
            : !routineEvent.webhookSecretId)
        )
          throw new IsolationError();
        // Group edits lock the group before its thread; keep membership valid through admission.
        await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = (SELECT "groupId" FROM threads WHERE id = ${input.threadId}) FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
        const thread = await tx.thread.findFirst({
          where: {
            id: input.threadId,
            spaceId: input.spaceId,
            userId: input.userId,
            OR: [
              { botId: input.botId },
              { group: { archivedAt: null, members: { some: { botId: input.botId } } } },
              {
                externalConversation: {
                  botId: input.botId,
                  spaceId: input.spaceId,
                  userId: input.userId,
                },
              },
            ],
          },
          select: { id: true },
        });
        if (!thread) throw new IsolationError();
        // Serialize nonce admission across saved-room changes as well as same-thread retries.
        await tx.$queryRaw`SELECT id FROM routines WHERE id = ${routineEvent.routineId} FOR UPDATE`;
        const winner = await replay(tx);
        if (winner) return { replay: winner } as const;
        const admitted = await tx.routine.updateMany({
          where: {
            id: routineEvent.routineId,
            spaceId: input.spaceId,
            botId: input.botId,
            userId: input.userId,
            active: true,
            bot: {
              archivedAt: null,
              spaceId: input.spaceId,
              userId: input.userId,
              ...(routineEvent.source === "messaging"
                ? {}
                : { webhookSecretId: routineEvent.webhookSecretId }),
            },
            OR: [
              { threadId: input.threadId },
              {
                threadId: null,
                ...(routineEvent.source === "messaging"
                  ? {}
                  : { bot: { thread: { id: input.threadId } } }),
              },
            ],
            ...(routineEvent.source === "messaging"
              ? { messageProvider: routineEvent.provider }
              : routineEvent.source === "github"
                ? { githubEnabled: true }
                : { webhookEnabled: true }),
          },
          data: { lastRunAt: new Date() },
        });
        if (admitted.count !== 1) throw new IsolationError();
        const routine = await tx.routine.findUniqueOrThrow({
          where: { id: routineEvent.routineId },
          select: { modelProvider: true, modelId: true, thinkingLevel: true },
        });
        modelPin =
          routine.modelProvider && routine.modelId
            ? {
                modelProvider: routine.modelProvider,
                modelId: routine.modelId,
                thinkingLevel: routine.thinkingLevel,
              }
            : undefined;
      }
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: input.internal ? "system" : "user",
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      for (const block of input.blocks) {
        if (block.kind !== "text" || !block.recruitingFeedback) continue;
        if (input.trigger !== "follow_up") throw new IsolationError();
        await authorizeRecruitingFeedbackMessage(
          tx,
          { spaceId: input.spaceId, userId: input.userId, email: "", isDeploymentOwner: false },
          input.threadId,
          block.recruitingFeedback,
          message.id,
        );
      }
      const createRun = input.createRun !== false;
      // Include the creation intro. It has no tools, so it must not absorb the message, and a
      // second run would overlap it on a dedicated computer. Pending steering waits for the
      // continuation that starts when the intro finishes.
      const activeRuns =
        createRun && !input.allowParallelRun && !input.routineEvent
          ? await tx.run.findMany({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: {
                  in: input.skipWaitingRuns
                    ? ["running", "queued", "leased"]
                    : ["running", "queued", "leased", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true, status: true, trigger: true, clientNonce: true },
            })
          : [];
      // Steer a conversational run when there is one. A person's message is never held behind
      // other work (grading, check-ins, reports, routines): it starts its own turn beside it.
      // Server input and inbound apps still wait their turn behind it.
      const person = !input.internal && (input.trigger === "user" || input.trigger === "follow_up");
      const holding = activeRuns.filter(
        (run) => !person || !runsBesidePerson(run.trigger) || run.status === "waiting_input",
      );
      const busy = holding.find(takesMessages) ?? holding[0] ?? null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
            routineId: input.routineEvent?.routineId,
            ...(modelPin
              ? {
                  modelProvider: modelPin.modelProvider,
                  modelId: modelPin.modelId,
                  thinkingLevel: modelPin.thinkingLevel,
                  modelPinned: true,
                }
              : {}),
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        const held = !takesMessages(busy);
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            // Keep messaging on the hold so the later run is mirrored back to that app.
            runId: held ? null : busy.id,
            ...(held && input.trigger === "messaging"
              ? { originTrigger: "messaging" }
              : input.queueMode === "follow_up"
                ? { originTrigger: FOLLOW_UP_ORIGIN }
                : !held && input.interrupt
                  ? { originTrigger: INTERRUPT_ORIGIN }
                  : {}),
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                }
              : {}),
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: {
          messageId: message.id,
          role: input.internal ? "system" : "user",
          blocks: input.blocks,
          // Carries the call id on the live event so a spoken turn groups into the
          // call card immediately, instead of after a refetch reads the nonce.
          callId: callIdFromClientNonce(message.clientNonce),
          ...(message.clientNonce?.startsWith("autocontinue:") ? { internal: true } : {}),
        },
      });
      return { message, task, run, busy, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if (committed.replay) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: {
        id: true,
        spaceId: true,
        trigger: true,
        clientNonce: true,
        sourceMessage: { select: { blocks: true } },
      },
    });
    if (!run || run.trigger === "created") return [];
    // A background search follow-up never takes the recruiter's message: it waits for the
    // recruiter's own turn, which the follow-up gives way to.
    const takesPending = takesMessages(run);
    const channelId =
      run.trigger === "messaging"
        ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
        : undefined;
    const directMessage = run.trigger === "messaging" && !channelId;
    // Pending rows from another chat stay for their own continuation.
    const pendingWhere = directMessage
      ? { runId: null, originTrigger: "messaging" }
      : channelId
        ? { runId: null }
        : { runId: null, originTrigger: null };
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        AND: [{ OR: [{ originTrigger: null }, { originTrigger: { not: FOLLOW_UP_ORIGIN } }] }],
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        // A routine or webhook turn only takes steering addressed to it; pending user messages
        // wait for the conversational continuation that starts once it finishes.
        OR: takesPending ? [pendingWhere, { runId: input.runId }] : [{ runId: input.runId }],
        message: {
          threadId: input.threadId,
          // Private follow-ups remain unclaimed for the existing private continuation.
          ...(channelId
            ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
            : directMessage
              ? { NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } } }
              : {}),
        },
      },
      include: { message: { select: { blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    // The thread lock serializes this watermark with message writes. Unlike claim
    // timestamps, it cannot drift from the database clock or tie with a reply.
    const { nextMessageSeq } = await tx.thread.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { nextMessageSeq: true },
    });
    await appendEventInTransaction(tx, {
      threadId: input.threadId,
      spaceId: run.spaceId,
      botId: input.botId,
      runId: input.runId,
      type: "run.steering.claimed",
      payload: {
        steeringIds: steering.map((item) => item.id),
        // Clients drop these from the visible input queue: they are part of the run now.
        messageIds: [...new Set(steering.map((item) => item.messageId))],
        nextMessageSeq,
      },
    });
    return steering.map((item) => ({
      id: item.id,
      messageId: item.messageId,
      text: blocksToAgentHistoryText(item.message.blocks as MessageBlock[]),
      blocks: item.message.blocks as MessageBlock[],
      ...(item.originTrigger === INTERRUPT_ORIGIN ? { interrupt: true as const } : {}),
    }));
  });
}

async function findPendingAsk(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const messages = await tx.message.findMany({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
    orderBy: { seq: "desc" },
    take: 50,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const pendingAsk = parsed.data.find(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    if (pendingAsk?.kind === "ask") return { messageId: message.id, pendingAsk };
  }
  return null;
}

async function commitAnswerRunInput(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
): Promise<{ threadId: string; seq: number } | null> {
  // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
  // concurrent clear cannot deadlock against this transaction.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: {
      botId: true,
      userId: true,
      checkpoint: true,
      trigger: true,
      task: { select: { prompt: true } },
    },
  });
  if (!run) return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered",
  );
  if (pendingAsk?.kind !== "ask") return null;
  let formResponse: AskFormResponse | undefined;
  try {
    if (pendingAsk.requestedSchema)
      formResponse = parseAskFormResponse(pendingAsk.requestedSchema, input.answer);
    else if (typeof input.answer !== "string") return null;
  } catch {
    return null;
  }
  const answerText = formResponse
    ? askFormAnswerText(pendingAsk.requestedSchema!, formResponse)
    : (input.answer as string);
  // Composer/voice messages cannot stand in for a structured card submission.
  if (formResponse && (input.answerMessageId || input.username || input.clientNonce)) return null;
  const approvalAsk = isApprovalAskBlock(pendingAsk);
  const secretAsk = isSecretAskBlock(pendingAsk);
  const connection = pendingAsk.connection;
  // Only a verified connection for this bot answers "connected"; anything else is not_connected.
  if (connection && (input.answerMessageId || input.username)) return null;
  const connectAnswer: ConnectionAskAnswer | undefined = connection
    ? answerText === "connected" &&
      (
        await loadConnectServer(
          tx,
          { spaceId: input.spaceId, userId: run.userId, botId: run.botId },
          connection.serverId,
        )
      )?.connected
      ? "connected"
      : "not_connected"
    : undefined;
  const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
  const selectedChoice = choiceAsk ? resolveAskChoice(answerText, pendingAsk.actions) : undefined;
  if (secretAsk && !runSecretWriter) return null;
  if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
  const loginAsk = secretAsk && pendingAsk.credential?.auth.type === "login";
  // A username belongs only to a login card, which cannot be saved without one.
  if (loginAsk !== Boolean(input.username?.trim())) return null;
  const login = loginAsk
    ? LoginSecretValue.safeParse({ username: input.username!.trim(), password: answerText })
    : undefined;
  if (login && !login.success) return null;
  let approvalEffect: {
    id: string;
    kind: string;
    request: Prisma.JsonValue;
    result?: Prisma.JsonValue;
  } | null = null;
  let approvalUserId: string | null = null;

  if (approvalAsk) {
    if (!pendingAsk.actions?.some((action) => action.id === answerText)) return null;
    await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${pendingAsk.approvalEffectId} FOR UPDATE`;
    approvalEffect = await tx.externalEffect.findFirst({
      where: {
        id: pendingAsk.approvalEffectId,
        spaceId: input.spaceId,
        runId: input.runId,
        status: "intended",
      },
    });
    if (!approvalEffect) return null;
    const approvedRoute = (
      boundDirectApprovalDetails(approvalEffect.request, "__rakazoCatalogTool") ??
      catalogApprovalDetails(approvalEffect.request, "__rakazoCatalogTool")
    )?.route;
    if (
      answerText !== "deny" &&
      !pendingAsk.approvalEvidenceHash &&
      approvedRoute?.connectorId === "mcp" &&
      ["reschedule_booking", "cancel_booking"].includes(approvedRoute.toolName)
    ) {
      const source = await tx.mcpServer.findFirst({
        where: {
          id: approvedRoute.resourceId,
          spaceId: input.spaceId,
          userId: run.userId,
        },
        select: { endpoint: true },
      });
      const url = source?.endpoint ? URL.parse(source.endpoint) : null;
      if (url && `${url.origin}${url.pathname.replace(/\/$/, "")}` === "https://mcp.cal.com/mcp")
        return null;
    }
    const evidence =
      approvalEffect.result &&
      typeof approvalEffect.result === "object" &&
      !Array.isArray(approvalEffect.result)
        ? (approvalEffect.result.calendarApprovalEvidence ??
          approvalEffect.result.schedulingApprovalEvidence)
        : undefined;
    if (answerText !== "deny" && (pendingAsk.approvalEvidenceHash || evidence)) {
      if (
        !pendingAsk.approvalEvidenceHash ||
        !evidence ||
        typeof evidence !== "object" ||
        Array.isArray(evidence) ||
        (evidence.kind !== "cal_booking_original" &&
          !RecruitingSchedulingApprovalEvidenceSchema.safeParse(evidence).success) ||
        evidence.version !== 1 ||
        evidence.requestHash !==
          createHash("sha256").update(stableJsonValue(approvalEffect.request)).digest("hex") ||
        pendingAsk.approvalEvidenceHash !==
          createHash("sha256").update(stableJsonValue(evidence)).digest("hex")
      )
        return null;
    }

    if (
      approvalEffect.kind === "recruiting_request_approval" &&
      (answerText === "always" ||
        (answerText === "allow" &&
          !(await authorizeRecruitingApprovalAnswerInTransaction(
            tx,
            input,
            approvalEffect.request,
          ))))
    )
      return null;
    if (answerText === "always") {
      if (run.userId !== input.answeredByUserId) return null;
      approvalUserId = input.answeredByUserId;
    }
  }

  const ordinaryAsk = !approvalAsk && !secretAsk && !connection;
  if (ordinaryAsk && !answerText.trim()) return null;
  let answerMessageId = input.answerMessageId;
  if (answerMessageId !== undefined) {
    if (!ordinaryAsk) return null;
    const answerMessage = await tx.message.findFirst({
      where: { id: answerMessageId, threadId: input.threadId, role: "user", botId: null },
      include: { externalTranscriptFor: { select: { id: true } } },
    });
    const answerBlocks = MessageBlockSchema.array().safeParse(answerMessage?.blocks);
    if (
      !answerMessage ||
      answerMessage.threadId !== input.threadId ||
      answerMessage.role !== "user" ||
      answerMessage.botId !== null ||
      answerMessage.externalTranscriptFor ||
      !answerBlocks.success ||
      answerBlocks.data.some((block) => !["text", "file", "image"].includes(block.kind)) ||
      answerBlocks.data
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("\n") !== answerText
    )
      return null;
  }

  if (
    !(await authorizeRecruitingQuestionAnswerInTransaction(
      tx,
      input,
      message,
      parsed.data.indexOf(pendingAsk),
    ))
  )
    return null;

  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: {
      status: "queued",
      ...(choiceAsk ? { checkpoint: null } : {}),
    },
  });
  if (queued.count !== 1) return null;

  const recordedAnswer = secretAsk ? "" : (connectAnswer ?? selectedChoice?.id ?? answerText);
  const callId = callIdFromClientNonce(input.clientNonce);
  const recordsCallUtterance = Boolean(callId && !secretAsk);

  // Ordinary answers are native human messages; spoken approvals keep their existing call transcript.
  // Secret asks stay out of message history.
  if (!answerMessageId && (ordinaryAsk || recordsCallUtterance)) {
    const blocks = [
      {
        kind: "text" as const,
        text: ordinaryAsk ? (selectedChoice?.label ?? answerText) : answerText,
      },
    ];
    const utterance = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "user",
      blocks,
      botId: ordinaryAsk ? undefined : run.botId,
      runId: input.runId,
      clientNonce: input.clientNonce,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: utterance.id, role: "user", blocks, ...(callId ? { callId } : {}) },
    });
    answerMessageId = utterance.id;
  }

  if (approvalAsk) {
    const allowed = answerText === "allow" || answerText === "always";
    await tx.externalEffect.update({
      where: { id: approvalEffect!.id },
      data: { status: allowed ? "approved" : "denied" },
    });
    if (answerText === "always") {
      await tx.actionApprovalRule.upsert({
        where: {
          spaceId_createdByUserId_effect_matchKind_matchValue: {
            spaceId: input.spaceId,
            createdByUserId: approvalUserId!,
            effect: "always_allow",
            matchKind: "tool",
            matchValue: approvalEffect!.kind,
          },
        },
        create: {
          spaceId: input.spaceId,
          createdByUserId: approvalUserId!,
          effect: "always_allow",
          matchKind: "tool",
          matchValue: approvalEffect!.kind,
        },
        update: {},
      });
    }
  } else if (secretAsk) {
    await runSecretWriter!.store({
      botId: run.botId,
      credential: pendingAsk.credential,
      runId: input.runId,
      userId: run.userId,
      spaceId: input.spaceId,
      plaintext: login?.success ? encodeLoginSecret(login.data) : answerText,
      tx,
    });
    await tx.externalEffect.updateMany({
      where: {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(pendingAsk.credential ? { result: { credentialSaved: pendingAsk.credential } } : {}),
      },
    });
  } else {
    const resumeLabel = selectedChoice
      ? resumeChoiceLabel(selectedChoice, run.checkpoint)
      : undefined;
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: {
        prompt: resumePrompt(
          run,
          pendingAsk.text,
          formResponse
            ? JSON.stringify(formResponse)
            : connection
              ? connectAnswer === "connected"
                ? `${connection.name} is connected. Continue the original task.`
                : `${connection.name} is still not connected. Continue without it or tell the user what it blocks; do not request it again unless the user asks.`
              : selectedChoice
                ? `Selected choice ${selectedChoice.id}: ${resumeLabel}`
                : answerText,
        ),
      },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  }

  const blocks = parsed.data.map((block) =>
    block === pendingAsk
      ? {
          ...block,
          status: "answered" as const,
          answer: recordedAnswer,
          ...(formResponse ? { formResponse } : {}),
        }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks },
  });
  if (ordinaryAsk) {
    const proof = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      runId: input.runId,
      type: "thread.choice",
      payload: {
        messageId: message.id,
        askIndex: parsed.data.indexOf(pendingAsk),
        answerMessageId: answerMessageId!,
        answeredByUserId: input.answeredByUserId,
      },
    });
    return { threadId: proof.threadId, seq: proof.seq };
  }
  if (approvalAsk) {
    const proof = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      runId: input.runId,
      type: "effect.approval.answered",
      payload: {
        effectId: approvalEffect!.id,
        ...(pendingAsk.approvalEvidenceHash
          ? { approvalEvidenceHash: pendingAsk.approvalEvidenceHash }
          : {}),
        messageId: message.id,
        askIndex: parsed.data.indexOf(pendingAsk),
        answeredByUserId: input.answeredByUserId,
        answer: answerText,
        requestHash: createHash("sha256")
          .update(stableJsonValue(approvalEffect!.request))
          .digest("hex"),
      },
    });
    return { threadId: proof.threadId, seq: proof.seq };
  }
  return { threadId: updated.threadId, seq: updated.seq };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
): Promise<boolean> {
  const commit = (writer = runSecretWriter) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) =>
      commitAnswerRunInput(tx, input, writer),
    );
  const committed = runSecretWriter?.withPrepared
    ? await runSecretWriter.withPrepared(prisma, input, commit)
    : await commit();

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

/** Answer a waiting question ask with composer free-text. Approval and secret cards stay on the card path. */
export async function answerWaitingRunWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
    /** Server-only native composer message, reused across the waiting runs it answers. */
    answerMessageId?: string;
  },
): Promise<{ threadId: string; seq: number } | null> {
  if (!input.answer.trim()) return null;
  const found = await findPendingAsk(tx, input);
  if (!found) return null;
  if (
    isApprovalAskBlock(found.pendingAsk) ||
    isSecretAskBlock(found.pendingAsk) ||
    found.pendingAsk.requestedSchema ||
    found.pendingAsk.connection
  )
    return null;
  return commitAnswerRunInput(tx, { ...input, messageId: found.messageId });
}

/**
 * A connect card cannot be answered by typing. A recruiter who writes past it has moved on, so the
 * card closes as not connected and the run resumes; the caller delivers the message as steering.
 */
export async function declineConnectionAskInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; runId: string; answeredByUserId: string },
): Promise<boolean> {
  const found = await findPendingAsk(tx, input);
  if (!found?.pendingAsk.connection) return false;
  return Boolean(
    await commitAnswerRunInput(tx, {
      ...input,
      messageId: found.messageId,
      answer: "not_connected" satisfies ConnectionAskAnswer,
    }),
  );
}

/**
 * A recruiter who writes while the turn is still finishing (for example "find 100" typed as soon
 * as the ten appear) can land after the turn's last steering read and just before it pauses on a
 * question card. Sent a moment later, the same text would have answered the card, so it answers
 * the card now; otherwise the message would sit unread behind a card nobody answers.
 * Returns the answered run's event when the paused run was resumed.
 */
export async function answerPausedAskWithSteering(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string },
): Promise<{ threadId: string; seq: number } | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const rows = await tx.steeringMessage.findMany({
      where: {
        runId: input.runId,
        botId: input.botId,
        claimedAt: null,
        OR: [{ originTrigger: null }, { originTrigger: { not: FOLLOW_UP_ORIGIN } }],
      },
      include: { message: { select: { id: true, role: true, threadId: true, blocks: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    const human = rows.filter(
      (row) =>
        row.message.threadId === input.threadId &&
        row.message.role === "user" &&
        Array.isArray(row.message.blocks) &&
        (row.message.blocks as MessageBlock[]).length > 0 &&
        (row.message.blocks as MessageBlock[]).every((block) => block.kind === "text"),
    );
    const last = human.at(-1);
    if (!last) return null;
    // The latest message answers the card; earlier ones stay steering for the resumed turn.
    const answered = await answerWaitingRunWithTextInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      runId: input.runId,
      answeredByUserId: last.userId,
      answer: (last.message.blocks as MessageBlock[])
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("\n"),
      answerMessageId: last.message.id,
    });
    if (!answered) return null;
    // The message is the answer now; left as steering it would reach the resumed turn twice.
    await tx.steeringMessage.delete({ where: { id: last.id } });
    return answered;
  });
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  // Validate the exact durable card before changing run/attempt state.
  MessageBlockSchema.array().parse(input.blocks);
  if (
    input.existingApprovalEffectId !== undefined &&
    (!input.existingApprovalEffectId.trim() ||
      input.blocks.length ||
      input.offeredActions?.length ||
      input.recruitingQuestion)
  )
    return false;
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    if (input.existingApprovalEffectId) {
      await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${input.existingApprovalEffectId} FOR UPDATE`;
      const effect = await tx.externalEffect.findFirst({
        where: {
          id: input.existingApprovalEffectId,
          spaceId: input.spaceId,
          runId: input.runId,
          status: "intended",
        },
        select: { id: true, spaceId: true, runId: true, status: true },
      });
      if (
        !effect ||
        effect.id !== input.existingApprovalEffectId ||
        effect.spaceId !== input.spaceId ||
        effect.runId !== input.runId ||
        effect.status !== "intended"
      )
        return null;
      const cards = await tx.message.findMany({
        where: {
          threadId: input.threadId,
          runId: input.runId,
          botId: input.botId,
          role: "bot",
          blocks: { array_contains: [{ approvalEffectId: effect.id }] },
        },
        select: { id: true, threadId: true, runId: true, botId: true, role: true, blocks: true },
        take: 2,
      });
      const message = cards.length === 1 ? cards[0] : undefined;
      const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
      const asks = parsed.success
        ? parsed.data.filter(
            (block) => block.kind === "ask" && block.approvalEffectId === effect.id,
          )
        : [];
      const ask = asks.length === 1 ? asks[0] : undefined;
      if (
        !message ||
        message.threadId !== input.threadId ||
        message.runId !== input.runId ||
        message.botId !== input.botId ||
        message.role !== "bot" ||
        ask?.kind !== "ask" ||
        ask.status !== "pending" ||
        !isApprovalAskBlock(ask) ||
        ask.input === "secret" ||
        ask.credential
      )
        return null;
      const answered = await tx.event.findFirst({
        where: {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          runId: input.runId,
          type: "effect.approval.answered",
          payload: { path: ["effectId"], equals: effect.id },
        },
        select: { id: true },
      });
      if (answered) return null;
    }
    const question = input.recruitingQuestion
      ? await prepareRecruitingQuestionInTransaction(tx, input)
      : undefined;
    if (question?.kind === "completed") return { threadId: input.threadId, seq: question.eventSeq };
    const waitAt = new Date();
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
        ...(input.recruitingQuestion || input.existingApprovalEffectId
          ? { leaseExpiresAt: { gt: new Date() } }
          : {}),
      },
      data: {
        status: "waiting_input",
        updatedAt: waitAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.offeredActions?.length
          ? { checkpoint: choiceAskCheckpoint(input.offeredActions) }
          : {}),
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: waitAt },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const message = input.existingApprovalEffectId
      ? null
      : await createThreadMessageInTransaction(tx, {
          threadId: input.threadId,
          role: "bot",
          blocks: input.blocks,
          botId: input.botId,
          runId: input.runId,
          ...(question?.kind === "new"
            ? { clientNonce: `recruiting-question:${question.effectId}` }
            : {}),
        });
    if (message)
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: input.blocks },
      });
    let waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: {
        updatedAt: waitAt.toISOString(),
        ...(input.modelRetries ? { modelRetries: input.modelRetries } : {}),
      },
    });
    if (question?.kind === "new" && message)
      waitingEvent = await commitRecruitingQuestionInTransaction(tx, input, question, message);
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const now = new Date();
    // Serialize with concurrent computer/takeover grants that mutate the same row.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const retainControl = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && computer.controlBotId !== input.botId,
    );
    const marked = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  if (!input.leaseId && !input.runId) return false;
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cleared = await tx.computer.updateMany({
      where: input.leaseId
        ? {
            id: input.computerId,
            spaceId: input.spaceId,
            controlBotId: input.botId,
            controlLeaseId: input.leaseId,
            controlRunId: input.runId,
          }
        : {
            id: input.computerId,
            spaceId: input.spaceId,
            controlHolder: "none",
            controlBotId: null,
            controlLeaseId: null,
            controlRunId: input.runId,
          },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
    const resumed = input.runId
      ? await tx.run.updateMany({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            botId: input.botId,
            status: "waiting_takeover",
          },
          data: {
            status: "queued",
            checkpoint,
          },
        })
      : { count: 0 };
    // A steered continue may already hold the run as leased/running. Stamp the
    // checkpoint without stealing the lease so the worker can restore tools.
    const stamped =
      input.runId && resumed.count !== 1
        ? await tx.run.updateMany({
            where: {
              id: input.runId,
              spaceId: input.spaceId,
              botId: input.botId,
              status: { in: ["leased", "running"] },
            },
            data: { checkpoint },
          })
        : { count: 0 };
    const runId = resumed.count === 1 || stamped.count === 1 ? input.runId : null;

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null, runId };
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: bot.thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq, runId };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return { runId: committed.runId };
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<ProductEvent> {
  let tails = appendTails.get(prisma);
  if (!tails) {
    tails = new Map();
    appendTails.set(prisma, tails);
  }
  const pending = (tails.get(input.threadId) ?? Promise.resolve()).then(async () => {
    // Cross-process writers can still deadlock on the thread row.
    const event = await withTransactionRetry(() =>
      prisma.$transaction((tx: Prisma.TransactionClient) => appendEventInTransaction(tx, input)),
    );
    const productEvent = mapProductEvent(event);
    await notifyRealtime(realtime, event.threadId, event.seq);
    return productEvent;
  });
  const tail = pending.then(
    () => undefined,
    () => undefined,
  );
  tails.set(input.threadId, tail);
  try {
    return await pending;
  } finally {
    if (tails.get(input.threadId) === tail) tails.delete(input.threadId);
    if (tails.size === 0) appendTails.delete(prisma);
  }
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return { continuationRunId: committed.continuationRunId };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

/** run.completed summary: wall time since start and finished steps grouped by category. */
export function completedRunSummary(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
  timing?: RunTiming,
): {
  startedAt?: string;
  activeMs?: number;
  steps: { category: WorkActivity; count: number }[];
} & Partial<RunTiming> {
  const counts = new Map<WorkActivity, number>();
  for (const block of blocks)
    if (block.kind === "steps")
      for (const step of block.steps) {
        const category = workActivityForTool(step.label);
        counts.set(category, (counts.get(category) ?? 0) + step.count);
      }
  const steps = [...counts].map(([category, count]) => ({ category, count }));
  if (!startedAt) return { steps, ...timing };
  // ponytail: wall time since run start; pauses are counted until runs record resumedAt.
  const activeMs = Math.max(0, Math.round(completedAt.getTime() - startedAt.getTime()));
  return { startedAt: startedAt.toISOString(), activeMs, steps, ...timing };
}

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{ threadId: string; seq: number; continuationRunId: string | null } | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    let writableRun: { startedAt: Date | null } | undefined;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    const events: AppendEventInput[] = [];
    if (input.outcome === "completed") {
      const completedBlocks = completedRunBlocks(input.blocks, writableRun?.startedAt ?? null, now);
      if (completedBlocks.length > 0) {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: input.threadId,
          role: "bot",
          blocks: completedBlocks,
          botId: input.botId,
          runId: input.runId,
          markUnread: input.markUnread,
        });
        events.push({
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "thread.message.created",
          runId: input.runId,
          payload: { messageId: message.id, role: "bot", blocks: completedBlocks },
        });
      }
    }
    events.push({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload:
        input.outcome === "completed"
          ? {
              ...completedRunSummary(
                input.blocks,
                writableRun?.startedAt ?? null,
                now,
                input.timing,
              ),
              ...(input.modelRetries ? { modelRetries: input.modelRetries } : {}),
            }
          : { error: input.error },
    });
    // The final message and the terminal event share one sequence reservation and insert.
    const lastEvent = (await appendEventsInTransaction(tx, events)).at(-1)!;
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    // An interject only means something to the run it targeted.
    await tx.steeringMessage.updateMany({
      where: { runId: input.runId, originTrigger: INTERRUPT_ORIGIN },
      data: { originTrigger: null },
    });
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    } else {
      await discardAnsweredSteering(tx, input);
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    const continuationRunId = await createPendingSteeringRun(tx, input);
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastEvent.seq, continuationRunId };
  });
}

export async function discardAnsweredSteering(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const lastReply = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
      blocks: { array_contains: [{ kind: "text" }] },
      NOT: ["ask", "computer", "steps", "subagent"].map((kind) => ({
        blocks: { array_contains: [{ kind }] },
      })),
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (!lastReply) return;
  const claims = await tx.event.findMany({
    where: { threadId: input.threadId, runId: input.runId, type: "run.steering.claimed" },
    select: { payload: true },
  });
  const answeredIds = new Set<string>();
  for (const claim of claims) {
    const payload = claim.payload as { steeringIds?: unknown; nextMessageSeq?: unknown } | null;
    if (!payload || !Array.isArray(payload.steeringIds)) continue;
    for (const id of payload.steeringIds) {
      if (typeof id !== "string") continue;
      if (typeof payload.nextMessageSeq === "number" && payload.nextMessageSeq <= lastReply.seq) {
        answeredIds.add(id);
      }
    }
  }
  // Old runs without a durable claim watermark are deliberately replayed.
  if (answeredIds.size === 0) return;
  await tx.steeringMessage.deleteMany({
    where: { runId: input.runId, claimedAt: { not: null }, id: { in: [...answeredIds] } },
  });
}

/** Queue one follow-up when this bot still has unclaimed steering and no live run. */
export async function createPendingSteeringRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string },
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      trigger: { not: "tool_background" },
      status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  // One origin per continuation so a group channel and a direct chat are not answered together.
  const origin = steeringOrigin(pending[0]!);
  const batch = pending.filter((item) => steeringOrigin(item) === origin);
  const source = batch.at(-1)!;
  const modelPin = continuationModelPin(batch);
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: batch[0]!.userId,
      prompt: "Respond to the user's steering context.",
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: batch[0]!.userId,
      status: "queued",
      trigger: origin === "app" ? "follow_up" : "messaging",
      sourceMessageId: source.message.id,
      ...(modelPin ?? {}),
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: batch.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null, ...(origin === "app" ? { originTrigger: null } : {}) },
  });
  return run.id;
}

function continuationModelPin(
  batch: ReadonlyArray<{
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  }>,
) {
  const first = batch[0];
  if (!first?.modelProvider || !first.modelId) return null;
  const agreed = batch.every(
    (item) =>
      item.modelProvider === first.modelProvider &&
      item.modelId === first.modelId &&
      (item.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  if (!agreed) return null;
  return {
    modelProvider: first.modelProvider,
    modelId: first.modelId,
    thinkingLevel: first.thinkingLevel ?? null,
    modelPinned: true,
  };
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { blocks: unknown };
}): string {
  if (item.originTrigger !== "messaging") return "app";
  const channelId = messagingChannelId(item.message.blocks as MessageBlock[] | undefined);
  return channelId ? `channel:${channelId}` : "dm";
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true, userId: true },
  });
  stashSidebarSignal(input, thread.nextEventSeq - 1, thread.userId);
  await assertEventRunWritable(tx, input);
  const seq = thread.nextEventSeq - 1;
  return alarmOnSeqConflict(input.threadId, seq, 1, () =>
    tx.event.create({ data: eventRow(input, seq) }),
  );
}

/**
 * Appends several events of one thread in order: the sequence range is reserved by a
 * single thread update, each distinct run is checked once, and the rows land in one
 * createMany. Returns the rows in input order with their assigned seq (createMany does
 * not return ids). A single input takes the ordinary one-row path.
 */
export async function appendEventsInTransaction(
  tx: Prisma.TransactionClient,
  inputs: readonly AppendEventInput[],
) {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    const event = await appendEventInTransaction(tx, inputs[0]!);
    return [event];
  }
  const threadId = inputs[0]!.threadId;
  if (inputs.some((input) => input.threadId !== threadId)) {
    throw new IsolationError("Batched events must belong to one thread");
  }
  const thread = await tx.thread.update({
    where: { id: threadId },
    data: { nextEventSeq: { increment: inputs.length } },
    select: { nextEventSeq: true, userId: true },
  });
  const checked = new Set<string>();
  for (const input of inputs) {
    const key = `${input.type === "run.cancelled" ? "cancelled" : "writable"}:${input.runId ?? ""}:${input.allowCancelledRun ? 1 : 0}`;
    if (checked.has(key)) continue;
    checked.add(key);
    await assertEventRunWritable(tx, input);
  }
  const firstSeq = thread.nextEventSeq - inputs.length;
  inputs.forEach((input, index) => {
    stashSidebarSignal(input, firstSeq + index, thread.userId);
  });
  const rows = inputs.map((input, index) => eventRow(input, firstSeq + index));
  await alarmOnSeqConflict(threadId, firstSeq, inputs.length, () =>
    tx.event.createMany({ data: rows }),
  );
  return rows;
}

/**
 * The thread counter hands out every seq once, so a duplicate (threadId, seq) means two writers
 * bypassed it or the counter was reset. The unique index still rejects the write; this makes the
 * conflict an alert instead of an anonymous failed transaction.
 */
async function alarmOnSeqConflict<T>(
  threadId: string,
  firstSeq: number,
  count: number,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      getLogger().error("event.seq.conflict", error, { threadId, firstSeq, count });
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

// run.cancelled is appended after the run row already reads cancelled, so it
// asserts the terminal status where every other event needs a writable run.
async function assertEventRunWritable(tx: Prisma.TransactionClient, input: AppendEventInput) {
  if (input.type === "run.cancelled") {
    await assertRunIsCancelled(tx, input.runId);
  } else {
    await assertRunCanWriteHistory(tx, input.runId, { allowCancelled: input.allowCancelledRun });
  }
}

function eventRow(input: AppendEventInput, seq: number) {
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload) as Prisma.InputJsonValue;
  return {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    seq,
    type: input.type,
    payload,
    runId: input.runId,
  };
}

async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch((error) => {
    getLogger().error("thread.realtime.publish.failed", error, { threadId, cursor });
  });
  await notifySidebar(realtime, threadId, cursor);
}

/** Event types that change what the sidebar shows for a bot (busy state, unread, preview, roster). */
export const SIDEBAR_EVENT_TYPES: ReadonlySet<ProductEvent["type"]> = new Set<ProductEvent["type"]>(
  [
    "run.started",
    "run.requeued",
    "run.waiting_input",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "thread.message.created",
    "thread.message.deleted",
    "bot.spawned",
    "bot.updated",
    "bot.archived",
    "bot.deleted",
  ],
);

export interface SidebarSignal {
  botId: string;
  type: ProductEvent["type"];
}

export function sidebarTopic(spaceId: string, userId: string): string {
  return `space:${spaceId}:user:${userId}`;
}

// ponytail: appendEventInTransaction knows the event but runs before commit; notifyRealtime runs
// after commit but only knows threadId+seq. This in-process stash bridges the two so every append
// path publishes post-commit without widening their signatures. Bounded so rolled-back rows (never
// drained) cannot leak; a dropped entry only delays the sidebar until its catch-up tick.
const SIDEBAR_STASH_LIMIT = 1_000;
const pendingSidebarSignals = new Map<
  string,
  { spaceId: string; userId: string | undefined } & SidebarSignal
>();

function stashSidebarSignal(
  input: AppendEventInput,
  seq: number,
  userId: string | undefined,
): void {
  if (!SIDEBAR_EVENT_TYPES.has(input.type)) return;
  if (pendingSidebarSignals.size >= SIDEBAR_STASH_LIMIT) {
    const oldest = pendingSidebarSignals.keys().next().value;
    if (oldest !== undefined) pendingSidebarSignals.delete(oldest);
  }
  pendingSidebarSignals.set(`${input.threadId}:${seq}`, {
    spaceId: input.spaceId,
    userId,
    botId: input.botId,
    type: input.type,
  });
}

async function notifySidebar(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  seq: number,
): Promise<void> {
  const key = `${threadId}:${seq}`;
  const signal = pendingSidebarSignals.get(key);
  if (!signal) return;
  pendingSidebarSignals.delete(key);
  if (!realtime || !signal.userId) return;
  const payload: SidebarSignal = { botId: signal.botId, type: signal.type };
  await realtime
    .publish(sidebarTopic(signal.spaceId, signal.userId), JSON.stringify(payload))
    .catch((error) => {
      getLogger().error("sidebar.realtime.publish.failed", error, { threadId, seq });
    });
}

/**
 * Yield once at open, once per sidebar signal for this user+space, and once per catch-up tick
 * when nothing arrived. Callers re-read durable bot state on every wake; the signal is only a hint.
 */
export async function* followSidebar(
  actor: { spaceId: string; userId: string },
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : SIDEBAR_POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<SidebarSignal | undefined> {
  const latch = new ChangeLatch();
  const hints: (SidebarSignal | undefined)[] = [];
  const unsubscribe = realtime
    ? await realtime
        .subscribe(sidebarTopic(actor.spaceId, actor.userId), (payload) => {
          let hint: SidebarSignal | undefined;
          try {
            const parsed = JSON.parse(payload) as Partial<SidebarSignal>;
            if (typeof parsed.botId === "string" && typeof parsed.type === "string") {
              hint = { botId: parsed.botId, type: parsed.type };
            }
          } catch {
            hint = undefined;
          }
          hints.push(hint);
          latch.notify();
        })
        .catch(() => async () => {})
    : async () => {};
  try {
    yield undefined;
    while (!signal?.aborted) {
      if (hints.length === 0) {
        await latch.waitForChange(latch.generation, catchUpMs, signal);
        if (signal?.aborted) break;
        if (hints.length === 0) {
          yield undefined;
          continue;
        }
      }
      while (hints.length > 0 && !signal?.aborted) yield hints.shift();
    }
  } finally {
    await unsubscribe();
  }
}

/**
 * Deliver a live-only event through the realtime signal instead of the events table.
 * The signal carries the whole event with `seq: 0`; followers re-stamp it with their
 * current cursor so client cursors never move. Without push fanout, or when the
 * payload cannot fit a NOTIFY frame, the event is stored durably as before.
 */
export async function publishTransientThreadEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<void> {
  if (!realtime?.describe().capabilities.push) {
    await appendEvent(prisma, input, realtime);
    return;
  }
  const transient: ProductEvent = {
    id: randomUUID(),
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    seq: 0,
    type: input.type,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    payload: sanitizeJsonValue(input.payload) as Record<string, unknown>,
  };
  try {
    await realtime.publish(threadTopic(input.threadId), JSON.stringify({ transient }));
  } catch {
    // Oversized or undeliverable signal: the durable path still reaches every follower.
    await appendEvent(prisma, input, realtime);
  }
}

function parseTransientSignal(payload: string): ProductEvent | undefined {
  if (!payload.includes('"transient"')) return undefined;
  try {
    const parsed = JSON.parse(payload) as { transient?: unknown };
    const event = parsed.transient as ProductEvent | undefined;
    return event && typeof event === "object" && typeof event.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const transients: ProductEvent[] = [];
  let droppedTransients = 0;
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), (payload) => {
          const transient = parseTransientSignal(payload);
          if (transient && transient.threadId === threadId) {
            if (transients.length >= MAX_PENDING_TRANSIENTS && droppedTransients++ === 0) {
              getLogger().warn("thread.follow.transients.backlog", { threadId });
            }
            queueTransient(transients, transient);
          }
          latch.notify();
        })
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      // Live-only events ride behind the durable ones they arrived with and carry the
      // follower's cursor, so a client's cursor and durable catch-up stay unaffected.
      while (transients.length > 0 && !signal?.aborted) {
        yield { ...transients.shift()!, seq: Math.max(0, seq) };
      }
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

/**
 * Keeps one follower's live-only queue bounded while its client reads slowly. Once full, a
 * streamed text delta joins the progress preview before it (so the text stays whole), and
 * anything else replaces the oldest preview: the durable final message supersedes them all.
 */
export function queueTransient(queue: ProductEvent[], event: ProductEvent): void {
  if (queue.length < MAX_PENDING_TRANSIENTS) {
    queue.push(event);
    return;
  }
  const last = queue[queue.length - 1]!;
  const delta = event.type === "thread.progress" ? event.payload.delta : undefined;
  const base = last.payload.text ?? last.payload.delta;
  if (
    typeof delta === "string" &&
    last.type === "thread.progress" &&
    last.runId === event.runId &&
    typeof base === "string" &&
    !last.payload.activity
  ) {
    const key = typeof last.payload.text === "string" ? "text" : "delta";
    queue[queue.length - 1] = { ...last, payload: { ...last.payload, [key]: base + delta } };
    return;
  }
  queue.shift();
  queue.push(event);
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}
