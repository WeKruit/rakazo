import type { PrismaClient } from "@rakazo/db";

const AWAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the person comes back after a day or more and work moved on while they were away,
 * the turn opens with a short recap of what changed. Returns nothing when they were here
 * recently or nothing new came in.
 */
export async function awayRecapNote(
  prisma: Pick<PrismaClient, "message">,
  input: { threadId: string; messageId: string; now?: Date },
): Promise<string | undefined> {
  const now = input.now ?? new Date();
  const previous = await prisma.message.findFirst({
    where: {
      threadId: input.threadId,
      role: "user",
      id: { not: input.messageId },
      createdAt: { lt: now },
      OR: [{ clientNonce: null }, { NOT: { clientNonce: { startsWith: "autocontinue:" } } }],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!previous || now.getTime() - previous.createdAt.getTime() < AWAY_MS) return undefined;
  const updates = await prisma.message.count({
    where: { threadId: input.threadId, role: "bot", createdAt: { gt: previous.createdAt } },
  });
  if (!updates) return undefined;
  const date = previous.createdAt.toISOString().slice(0, 10);
  return `The person last wrote here on ${date} (UTC), more than a day ago, and work went on while they were away. Open this reply with a short "while you were away" recap in their language: at most three lines on what finished, what came in and what now waits on them, from the conversation and saved roles. Leave out what did not change, then answer their message.`;
}
