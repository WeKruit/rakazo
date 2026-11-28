import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";

/**
 * `applied`: an agent already received the message, so it can no longer change.
 * `not_editable`: only a single plain text part can be rewritten.
 */
export class QueuedMessageError extends Error {
  constructor(readonly code: "applied" | "not_editable") {
    super(code === "applied" ? "This message was already sent." : "This message can't be edited.");
    this.name = "QueuedMessageError";
  }
}

/**
 * A person's message is queued while every session input made from it is still undelivered.
 * Messaging deliveries and group-channel posts stay with their own channel.
 */
interface QueuedInputs {
  delivered: boolean;
  ids: string[];
  botId: string;
  userIds: Set<string>;
}

async function queuedInputs(
  tx: Prisma.TransactionClient,
  threadId: string,
  messageIds?: string[],
): Promise<Map<string, QueuedInputs>> {
  const rows = await tx.sessionInput.findMany({
    where: {
      session: { threadId },
      messageId: messageIds ? { in: messageIds } : { not: null },
      kind: { in: ["message", "followUp"] },
    },
    select: {
      id: true,
      messageId: true,
      deliveredAt: true,
      session: { select: { botId: true, userId: true } },
    },
  });
  const byMessage = new Map<string, QueuedInputs>();
  for (const row of rows) {
    const entry = byMessage.get(row.messageId!) ?? {
      delivered: false,
      ids: [],
      botId: row.session.botId,
      userIds: new Set<string>(),
    };
    entry.userIds.add(row.session.userId);
    entry.ids.push(row.id);
    if (row.deliveredAt) entry.delivered = true;
    byMessage.set(row.messageId!, entry);
  }
  return byMessage;
}

export async function loadQueuedMessageIds(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<string[]> {
  const pending = await tx.sessionInput.findMany({
    where: { session: { threadId }, deliveredAt: null, messageId: { not: null } },
    select: { messageId: true },
  });
  const candidates = [...new Set(pending.map((row) => row.messageId!))];
  if (!candidates.length) return [];
  const inputs = await queuedInputs(tx, threadId, candidates);
  const rows = await tx.message.findMany({
    where: {
      id: { in: candidates.filter((id) => !inputs.get(id)?.delivered) },
      threadId,
      role: "user",
      NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } },
    },
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
}

/**
 * Edit, remove, or send now a message no agent has received yet. Send now changes nothing: a
 * message reaches a working agent at its next step, and only Stop ends a turn.
 */
export async function updateQueuedMessage(
  prisma: PrismaClient,
  input: UpdateQueuedMessageInput,
): Promise<UpdateQueuedMessageResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId, role: "user" },
      select: { id: true, blocks: true, replyToMessageId: true, replyQuote: true },
    });
    if (!message) throw new IsolationError();
    const inputs = (await queuedInputs(tx, input.threadId, [message.id])).get(message.id);
    if (!inputs || inputs.delivered) throw new QueuedMessageError("applied");
    if ([...inputs.userIds].some((userId) => userId !== input.userId)) throw new IsolationError();
    const botId = inputs.botId;
    // The owner may deliver the input between this read and the write below; the lock on the
    // inputs makes that delivery wait for this change.
    await tx.$queryRaw`SELECT id FROM session_inputs WHERE id = ANY(${inputs.ids}) FOR UPDATE`;
    const still = await tx.sessionInput.count({
      where: { id: { in: inputs.ids }, deliveredAt: { not: null } },
    });
    if (still) throw new QueuedMessageError("applied");
    const change = input.change;
    if (change.action === "send_now") return { eventSeq: null };
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
      for (const id of inputs.ids)
        await tx.$executeRaw`
          UPDATE session_inputs SET payload = jsonb_set(payload, '{text}', to_jsonb(${text}::text))
          WHERE id = ${id}`;
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
      return { eventSeq: event.seq };
    }
    await tx.sessionInput.deleteMany({ where: { id: { in: inputs.ids } } });
    await tx.message.delete({ where: { id: message.id } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId,
      type: "thread.message.deleted",
      payload: { messageId: message.id },
    });
    return { eventSeq: event.seq };
  });
}
