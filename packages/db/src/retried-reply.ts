import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

/** A turn the server pushed on after it ended: a declined reply, or work it promised and did not do. */
const CONTINUATION = /^autocontinue:(.+):(?:decline|\d+)$/;

/** Blocks a person acts on; a reply holding one is never rewritten. Tool steps are not one. */
const CARD_KINDS = ["ask", "computer", "subagent"];

/**
 * The reply a pushed-on turn takes the place of, so the person reads one answer to one message.
 * Staging 11-16: the decline guard pushed a second turn after the first answer was shown (66
 * messages a day got two answers), and the promise guard did the same on send-at-night, where the
 * pushed turn restated "queued, sends within 58 min". Only while nobody has written since that
 * answer; a card is never rewritten. Returns the earlier reply's id, or null to post on its own.
 */
export async function retriedReplyInTransaction(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string; blocks: readonly MessageBlock[] },
): Promise<string | null> {
  if (input.blocks.some((block) => CARD_KINDS.includes(block.kind))) return null;
  const run = await tx.run.findUnique({
    where: { id: input.runId },
    select: { sourceMessage: { select: { clientNonce: true } } },
  });
  const retried = run?.sourceMessage?.clientNonce?.match(CONTINUATION)?.[1];
  if (!retried) return null;
  const earlier = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      runId: retried,
      role: "bot",
      blocks: { array_contains: [{ kind: "text" }] },
      NOT: CARD_KINDS.map((kind) => ({ blocks: { array_contains: [{ kind }] } })),
    },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true },
  });
  if (!earlier) return null;
  // Anything said after it, by the person or another turn, keeps both answers where they are.
  const since = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      seq: { gt: earlier.seq },
      OR: [
        { role: "bot", NOT: { runId: input.runId } },
        {
          role: "user",
          OR: [{ clientNonce: null }, { NOT: { clientNonce: { startsWith: "autocontinue:" } } }],
        },
      ],
    },
    select: { id: true },
  });
  return since ? null : earlier.id;
}

/** A pushed-on turn's own note: its answer, if any, took the place of the reply above it. */
export function isContinuationNonce(clientNonce: string | null | undefined): boolean {
  return !!clientNonce && CONTINUATION.test(clientNonce);
}
