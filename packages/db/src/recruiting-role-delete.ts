import type { Prisma } from "./client.js";

/**
 * Deletes roles together with their saved search pages, research steps and reviews. Those records
 * point at conversation files without cascading, so a conversation or account holding a role could
 * not be deleted while they remained. Replies are the only role records outside the role's own
 * cascade.
 */
export async function deleteRecruitingRoles(
  tx: Prisma.TransactionClient,
  where: Prisma.RecruitingRoleWhereInput,
) {
  await tx.recruitingReply.deleteMany({ where: { roleRevision: { role: where } } });
  await tx.recruitingRole.deleteMany({ where });
}
