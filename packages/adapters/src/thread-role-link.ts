import type { PrismaClient } from "@rakazo/db";

/**
 * A run reads its thread once, at the start; a role this run saves links the thread afterwards.
 * Branch fosp 11-20 (2ff3f187): a role conversation's first turn saved its role and then every
 * round call answered "This conversation has no active role.", so round one was never recorded.
 * Before a recruiting call, a thread with no role takes the one now linked to it. The global
 * conversation never has one, so it skips the read.
 */
export async function linkSavedThreadRole(
  prisma: Pick<PrismaClient, "thread">,
  thread: { id: string; groupId: string | null; activeRecruitingRoleId: string | null },
  toolName: string,
): Promise<void> {
  if (thread.activeRecruitingRoleId || !toolName.includes("recruiting_")) return;
  if (thread.groupId?.startsWith("recruiting-global-")) return;
  const linked = await prisma.thread
    .findUnique({ where: { id: thread.id }, select: { activeRecruitingRoleId: true } })
    .catch(() => null);
  if (linked?.activeRecruitingRoleId) thread.activeRecruitingRoleId = linked.activeRecruitingRoleId;
}
