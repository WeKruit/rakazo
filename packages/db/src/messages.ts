import type { Actor, MessageBlock } from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  NativeAskAnswerPayloadSchema,
} from "@rakazo/contracts";
import { resolveAskChoice, scrubVendorBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const humanMessageInclude = { externalTranscriptFor: { select: { id: true } } } as const;
export type SourceMessage = Prisma.MessageGetPayload<{ include: typeof humanMessageInclude }>;

export function isNativeHumanMessage(message: SourceMessage): boolean {
  return (
    message.role === "user" &&
    !message.clientNonce?.startsWith("autocontinue:") &&
    message.botId === null &&
    message.externalTranscriptFor === null &&
    Array.isArray(message.blocks) &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) =>
        block &&
        typeof block === "object" &&
        "kind" in block &&
        ["text", "file", "image"].includes(String(block.kind)),
    )
  );
}

/** Validate the same native answer chain for single-run and batched snapshot reads. */
export function validateRunHumanSourceRows(
  actor: Actor,
  run: { id: string; botId: string; threadId: string; sourceMessageId?: string | null },
  receipts: readonly Pick<
    Prisma.EventGetPayload<Record<string, never>>,
    "seq" | "type" | "payload"
  >[],
  messages: readonly SourceMessage[],
  options: { continuationOnly?: boolean } = {},
) {
  const choices = receipts.filter((receipt) => receipt.type === "thread.choice");
  const latestPause = receipts.findLast((receipt) => receipt.type !== "thread.choice");
  const latestChoice = choices.at(-1);
  if (options.continuationOnly && latestChoice && !latestPause) throw new IsolationError();
  const currentChoice =
    latestChoice && latestPause && latestChoice.seq > latestPause.seq ? latestChoice : undefined;
  const proofs = choices.map((receipt) => ({
    receipt,
    parsed: NativeAskAnswerPayloadSchema.safeParse(receipt.payload),
  }));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const answeredAsks = proofs.flatMap(({ receipt, parsed }) => {
    if (!parsed.success || parsed.data.answeredByUserId !== actor.userId) return [];
    const proof = parsed.data;
    const card = byId.get(proof.messageId);
    const answer = byId.get(proof.answerMessageId);
    const blocks = MessageBlockSchema.array().safeParse(card?.blocks);
    const ask = blocks.success ? blocks.data[proof.askIndex] : undefined;
    if (
      card?.role !== "bot" ||
      card.runId !== run.id ||
      card.botId !== run.botId ||
      ask?.kind !== "ask" ||
      ask.status !== "answered" ||
      ask.approvalEffectId ||
      ask.input === "secret" ||
      ask.credential ||
      !answer ||
      !isNativeHumanMessage(answer) ||
      answer.seq <= card.seq
    )
      return [];
    const answerBlocks = MessageBlockSchema.array().safeParse(answer.blocks);
    const raw = answerBlocks.success
      ? answerBlocks.data
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("\n")
      : "";
    if (!raw.trim() || !ask.answer) return [];
    const choice = resolveAskChoice(raw, ask.actions);
    const recorded = resolveAskChoice(ask.answer, ask.actions);
    if (choice || recorded ? choice?.id !== recorded?.id : raw !== ask.answer) return [];
    return [{ card, askIndex: proof.askIndex, answer, receiptSeq: receipt.seq }];
  });
  const current =
    currentChoice && answeredAsks.find((turn) => turn.receiptSeq === currentChoice.seq);
  if (
    currentChoice &&
    (!current || (options.continuationOnly && answeredAsks.length !== choices.length))
  )
    throw new IsolationError();
  return {
    answers: answeredAsks.map((turn) => turn.answer),
    answeredAsks,
    currentAnswer: current?.answer ?? null,
    originalSource: run.sourceMessageId ? (byId.get(run.sourceMessageId) ?? null) : null,
  };
}

/** Native card receipts, rather than text similarity or answer.runId, bind composer fanout answers. */
export async function loadRunHumanSources(
  tx: Prisma.TransactionClient,
  actor: Actor,
  run: { id: string; botId: string; threadId: string; sourceMessageId?: string | null },
  options: { continuationOnly?: boolean } = {},
) {
  const receipts = await tx.event.findMany({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      runId: run.id,
      botId: run.botId,
      type: { in: ["thread.choice", "run.waiting_input", "computer.takeover.requested"] },
    },
    orderBy: { seq: "asc" },
  });
  const choices = receipts.filter((receipt) => receipt.type === "thread.choice");
  if (options.continuationOnly && choices.length && choices.length === receipts.length)
    throw new IsolationError();
  const ids = choices.flatMap((receipt) => {
    const parsed = NativeAskAnswerPayloadSchema.safeParse(receipt.payload);
    return parsed.success ? [parsed.data.messageId, parsed.data.answerMessageId] : [];
  });
  if (choices.length && run.sourceMessageId) ids.push(run.sourceMessageId);
  const messages = ids.length
    ? await tx.message.findMany({
        where: { threadId: run.threadId, id: { in: [...new Set(ids)] } },
        include: humanMessageInclude,
      })
    : [];
  const sources = validateRunHumanSourceRows(actor, run, receipts, messages, options);
  const steering = options.continuationOnly
    ? []
    : await tx.steeringMessage.findMany({
        where: {
          runId: run.id,
          botId: run.botId,
          userId: actor.userId,
          claimedAt: { not: null },
          message: { threadId: run.threadId },
        },
        include: { message: { include: humanMessageInclude } },
      });
  return {
    steering,
    ...sources,
  };
}

/** Group turns use channel inputs and their own outputs, never private thread history. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  limit: number,
  channelId?: string,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      botId: true,
      runId: true,
      blocks: true,
      createdAt: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, botId: true, blocks: true } },
    },
  });
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /** Terminal echo after the run is already cancelled. Every other write stays rejected. */
  allowCancelledRun?: boolean;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) =>
      createThreadMessageInTransaction(tx, input),
    ),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId, { allowCancelled: input.allowCancelledRun });
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      // Bot text never names a sourcing/enrichment vendor to the recruiter.
      blocks: (input.role === "bot"
        ? scrubVendorBlocks(input.blocks)
        : input.blocks) as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
  options?: { allowCancelled?: boolean },
): Promise<{ status: string; startedAt: Date | null } | undefined> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, startedAt: true },
  });
  if (!run || (run.status === "cancelled" && !options?.allowCancelled)) {
    throw new RunHistoryWriteError();
  }
  return run;
}

/**
 * run.cancelled is recorded by the path that cancelled the run, after the row
 * already reads cancelled — where the liveness assert above would reject it.
 * The event must name its run (clients key off it) and the row must already be
 * cancelled, so it can never announce a cancellation nothing committed.
 */
export async function assertRunIsCancelled(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<void> {
  if (!runId) throw new RunHistoryWriteError();
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status !== "cancelled") {
    throw new RunHistoryWriteError();
  }
}
