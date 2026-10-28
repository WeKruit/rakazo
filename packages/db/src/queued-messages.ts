import type { MessageBlock } from "@rakazo/contracts";
import { isConversationalRun } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction, createPendingSteeringRun, INTERRUPT_ORIGIN } from "./events.js";
import { IsolationError } from "./scope.js";

/**
 * `applied`: the run already read the message, or started from it, so it can no longer change.
 * `not_editable`: only a single plain text part can be rewritten.
 */
export class QueuedMessageError extends Error {
  constructor(readonly code: "applied" | "not_editable") {
    super(code === "applied" ? "This message was already sent." : "This message can't be edited.");
    this.name = "QueuedMessageError";
  }
}

const LIVE_RUN_STATUSES = ["queued", "leased", "running", "waiting_takeover"];

/**
 * A user message is queued while every steering row for it is unclaimed and no run started
 * from it. Messaging deliveries and group-channel posts stay with their own channel.
 */
function queuedMessageWhere(threadId: string): Prisma.MessageWhereInput {
  return {
    threadId,
    role: "user",
    steeringMessages: {
      some: {},
      every: {
        claimedAt: null,
        OR: [{ originTrigger: null }, { originTrigger: INTERRUPT_ORIGIN }],
      },
    },
    sourceRuns: { none: {} },
    NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } },
  };
}

export async function loadQueuedMessageIds(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<string[]> {
  const rows = await tx.message.findMany({
    where: queuedMessageWhere(threadId),
    orderBy: { seq: "asc" },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export type QueuedMessageChange =
  | { action: "edit"; text: string }
  | { action: "remove" }
  | { action: "send_now" };

export interface UpdateQueuedMessageInput {
  spaceId: string;
  threadId: string;
  userId: string;
  messageId: string;
  change: QueuedMessageChange;
}

export interface UpdateQueuedMessageResult {
  eventSeq: number | null;
  /** Continuations started for pending input that had no run to join. */
  startedRunIds: string[];
}

/**
 * Edit, remove, or send now a message still waiting for the working reply. The thread lock
 * serializes this with claimSteering, so a message the run already read is a conflict.
 */
export async function updateQueuedMessage(
  prisma: PrismaClient,
  input: UpdateQueuedMessageInput,
): Promise<UpdateQueuedMessageResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: input.messageId, ...queuedMessageWhere(input.threadId) },
      select: {
        id: true,
        blocks: true,
        replyToMessageId: true,
        replyQuote: true,
        steeringMessages: {
          select: {
            id: true,
            botId: true,
            userId: true,
            runId: true,
            run: { select: { status: true, trigger: true } },
          },
        },
      },
    });
    if (!message) {
      const known = await tx.message.findFirst({
        where: { id: input.messageId, threadId: input.threadId, role: "user" },
        select: { id: true },
      });
      if (!known) throw new IsolationError();
      throw new QueuedMessageError("applied");
    }
    if (message.steeringMessages.some((row) => row.userId !== input.userId)) {
      throw new IsolationError();
    }
    const botId = message.steeringMessages[0]!.botId;
    const change = input.change;
    if (change.action === "edit") {
      const blocks = message.blocks as MessageBlock[];
      const textBlocks = blocks.filter((block) => block.kind === "text");
      const text = change.text.trim();
      // Feedback is authorized against its exact selection; it is removed, not rewritten.
      if (
        !text ||
        textBlocks.length !== 1 ||
        textBlocks.some((block) => block.kind === "text" && block.recruitingFeedback)
      )
        throw new QueuedMessageError("not_editable");
      const edited = blocks.map((block) => (block.kind === "text" ? { ...block, text } : block));
      await tx.message.update({
        where: { id: message.id },
        data: { blocks: edited as Prisma.InputJsonValue },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId,
        type: "thread.message.updated",
        payload: {
          messageId: message.id,
          role: "user",
          blocks: edited,
          queued: true,
          ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
          ...(message.replyQuote ? { replyQuote: message.replyQuote } : {}),
        },
      });
      return { eventSeq: event.seq, startedRunIds: [] };
    }
    if (change.action === "remove") {
      // Steering rows cascade with the message, so no run can claim it afterwards.
      await tx.message.delete({ where: { id: message.id } });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId,
        type: "thread.message.deleted",
        payload: { messageId: message.id },
      });
      return { eventSeq: event.seq, startedRunIds: [] };
    }
    // Send now: interrupt the live reply, or start the pending input's own continuation.
    const startedRunIds: string[] = [];
    for (const row of message.steeringMessages) {
      if (
        row.runId &&
        row.run &&
        LIVE_RUN_STATUSES.includes(row.run.status) &&
        isConversationalRun(row.run.trigger)
      ) {
        await tx.steeringMessage.update({
          where: { id: row.id },
          data: { originTrigger: INTERRUPT_ORIGIN },
        });
      } else if (!row.runId) {
        const runId = await createPendingSteeringRun(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: row.botId,
        });
        if (runId) startedRunIds.push(runId);
      }
    }
    return { eventSeq: null, startedRunIds };
  });
}
