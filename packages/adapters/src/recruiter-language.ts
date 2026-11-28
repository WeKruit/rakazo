import type { MessageBlock } from "@rakazo/contracts";
import type { ReplyLanguage } from "@rakazo/core";
import { screenLanguage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** The recruiter's most recently active conversations read for their screen's language. */
const CONVERSATIONS = 9;

/**
 * The language the recruiter's screen shows, from the UI locale the client sends with each of
 * their messages: the newest one in any of their conversations. A role conversation opened by a
 * hand-off holds none of their own messages.
 */
export async function recruiterScreenLanguage(
  prisma: Pick<PrismaClient, "message" | "chatGroup">,
  scope: { spaceId: string; userId: string },
): Promise<ReplyLanguage | undefined> {
  const listed = await prisma.chatGroup.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      archivedAt: null,
      thread: { isNot: null },
    },
    orderBy: { updatedAt: "desc" },
    take: CONVERSATIONS,
    select: { thread: { select: { id: true } } },
  });
  const threadIds = listed.flatMap((group) => (group.thread ? [group.thread.id] : []));
  if (!threadIds.length) return undefined;
  const rows = await prisma.message.findMany({
    where: { threadId: { in: threadIds }, role: "user", botId: null },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { blocks: true },
  });
  for (const row of rows)
    for (const block of (Array.isArray(row.blocks) ? row.blocks : []) as MessageBlock[])
      if (block.kind === "text" && block.uiLocale) return screenLanguage(block.uiLocale);
  return undefined;
}
