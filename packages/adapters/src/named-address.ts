import type { PrismaClient } from "@rakazo/db";
import { editDistance } from "./edit-distance.js";

const fold = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

const TYPED_ADDRESS =
  /[^\s\p{Script=Han}@<>()[\]{}"'`，,;；:：「」『』（）]+@[^\s\p{Script=Han}@<>()[\]{}"'`，,;；:：「」『』（）]+\.[a-z]{2,}/giu;

/**
 * An address a person wrote in this run's conversation is theirs, not a guess: their own recent
 * message, or a teammate's brief that hands their words over. Delegated work also looks at the
 * conversation it came from, where the recruiter typed it, since a brief may paraphrase the
 * address away. Its mail can be read without a saved contact.
 */
export async function addressTypedInConversation(
  prisma: Pick<PrismaClient, "message">,
  runId: string,
  email: string,
) {
  const wanted = fold(email);
  const texts = (blocks: unknown) =>
    Array.isArray(blocks)
      ? blocks.filter(
          (
            block,
          ): block is {
            text: string;
            kind?: unknown;
            returnThreadId?: unknown;
          } =>
            block && typeof block === "object" && "text" in block && typeof block.text === "string",
        )
      : [];
  let where: Parameters<typeof prisma.message.findMany>[0] = {
    where: { role: "user", thread: { runs: { some: { id: runId } } } },
  };
  let spaceId: string | undefined;
  const seen = new Set<string>();
  // The run's own conversation, then up to two conversations that delegated to it.
  for (let hop = 0; hop < 3; hop += 1) {
    const rows = await prisma.message.findMany({
      ...where,
      orderBy: { seq: "desc" },
      take: 20,
      select: {
        blocks: true,
        threadId: true,
        thread: { select: { spaceId: true } },
      },
    });
    const from = new Set<string>();
    for (const row of rows) {
      seen.add(row.threadId);
      spaceId ??= row.thread.spaceId;
      for (const block of texts(row.blocks)) {
        if ((block.text.match(TYPED_ADDRESS) ?? []).some((address) => fold(address) === wanted))
          return true;
        if (
          block.kind === "bot_message_received" &&
          typeof block.returnThreadId === "string" &&
          !seen.has(block.returnThreadId)
        )
          from.add(block.returnThreadId);
      }
    }
    if (!from.size || !spaceId) return false;
    where = {
      where: { role: "user", threadId: { in: [...from] }, thread: { spaceId } },
    };
  }
  return false;
}

/**
 * An address for someone who is not a saved candidate is used only when a person wrote it in the
 * conversation (or the brief that handed the work over): an agent that retypes it from memory can
 * get a letter wrong, and the mail would go to a stranger. Returns why it is refused, naming the
 * one closest saved address when it is a letter or two off.
 */
export async function untypedAddressRefusal(
  prisma: Pick<PrismaClient, "message">,
  runId: string | undefined,
  address: string,
  known: readonly string[],
): Promise<string | null> {
  if (!runId || (await addressTypedInConversation(prisma, runId, address))) return null;
  const wanted = address.trim().toLowerCase();
  const near = [...new Set(known.map((email) => email.trim().toLowerCase()))]
    .map((email) => ({ email, distance: editDistance(wanted, email) }))
    .filter((entry) => entry.distance > 0 && entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance);
  // Named only when one address is the closest; two as close could be either person.
  const closest = near[0] && near[1]?.distance !== near[0].distance ? near[0] : undefined;
  const ask = "ask the recruiter one question: which person they mean, by full name or email.";
  return `Nothing was saved: ${address} is not an address anyone wrote in this conversation or a saved email of this role's candidates. ${closest ? `If they mean ${closest.email}, the closest saved address, use it exactly; otherwise ${ask}` : `A${ask.slice(1)}`}`;
}
