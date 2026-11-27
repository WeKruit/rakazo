import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

/** A turn the server pushed on after it ended: a declined reply, or work it promised and did not do. */
const CONTINUATION = /^autocontinue:(.+):(?:decline|\d+)$/;
/** A teammate's turn on work another turn in the same conversation handed it. */
const HANDOFF = /^group-handoff:(.+)$/;
/** How far back a turn's chain is followed: a pushed-on turn, its hand-off, and so on. */
const MAX_CHAIN = 4;

/** Blocks a person acts on; a reply holding one is never rewritten. Tool steps are not one. */
const CARD_KINDS = ["ask", "computer", "subagent"];

/** Whether this is Kruit's account-wide chat, where one assistant answers each message. */
async function followsHandoffs(tx: Prisma.TransactionClient, threadId: string) {
  const thread = await tx.thread.findUnique({ where: { id: threadId }, select: { groupId: true } });
  return thread?.groupId?.startsWith("recruiting-global-") === true;
}

/**
 * The turns this turn carries on from, nearest first: the turn it was pushed on from, or the turn
 * that handed it the work, and theirs in turn.
 */
async function earlierTurns(
  tx: Prisma.TransactionClient,
  runId: string,
  threadId: string,
): Promise<string[]> {
  let handoffs: Promise<boolean> | undefined;
  const chain: string[] = [];
  let current = runId;
  while (chain.length < MAX_CHAIN) {
    const run = await tx.run.findUnique({
      where: { id: current },
      select: { sourceMessage: { select: { clientNonce: true } } },
    });
    const nonce = run?.sourceMessage?.clientNonce ?? "";
    const handedFrom = nonce.match(HANDOFF)?.[1];
    handoffs ??= handedFrom ? followsHandoffs(tx, threadId) : undefined;
    const parent =
      nonce.match(CONTINUATION)?.[1] ?? (handedFrom && (await handoffs) ? handedFrom : undefined);
    if (!parent || parent === runId || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * The reply a carried-on turn takes the place of, so the person reads one answer to one message.
 * Staging 11-16: the decline guard pushed a second turn after the first answer was shown (66
 * messages a day got two answers), and the promise guard did the same on send-at-night, where the
 * pushed turn restated "queued, sends within 58 min". On honest-limits (c9a6991e) the pushed turn,
 * or Kruit's own first turn, handed the question to a teammate, whose answer came 25–50 s after
 * Kruit's and said the same thing. A hand-off is followed only in Kruit's account-wide chat, where
 * one assistant answers each message; in a role chat teammates add their own work (a round, then
 * drafts) that must stay. Only while nobody has written since that answer; a card is never
 * rewritten. Returns the earlier reply's id, or null to post on its own.
 */
export async function retriedReplyInTransaction(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string; blocks: readonly MessageBlock[] },
): Promise<string | null> {
  if (input.blocks.some((block) => CARD_KINDS.includes(block.kind))) return null;
  const chain = await earlierTurns(tx, input.runId, input.threadId);
  if (!chain.length) return null;
  const earlier = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      runId: { in: chain },
      role: "bot",
      blocks: { array_contains: [{ kind: "text" }] },
      NOT: CARD_KINDS.map((kind) => ({ blocks: { array_contains: [{ kind }] } })),
    },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true },
  });
  if (!earlier) return null;
  // Anything said after it, by the person or a turn outside this chain, keeps both answers. So
  // does a card, even this turn's own: the answer to it belongs below it (branch sends 11-20: "the
  // first email is confirmed and queued" sat above the send card it answered).
  const since = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      seq: { gt: earlier.seq },
      OR: [
        { role: "bot", NOT: { runId: { in: [input.runId, ...chain] } } },
        ...CARD_KINDS.map((kind) => ({
          role: "bot" as const,
          blocks: { array_contains: [{ kind }] },
        })),
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
