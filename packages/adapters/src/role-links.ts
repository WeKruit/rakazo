import type { PrismaClient } from "@rakazo/db";

/**
 * The cards that open the named roles' conversations in the side drawer, for this user's own
 * roles only, in the order named. Kruit names the roles its answer is about; the card is the
 * same one a new role or a hand-off shows.
 */
export async function roleLinkBlocks(
  prisma: Pick<PrismaClient, "recruitingRole">,
  owner: { spaceId: string; userId: string },
  roleIds: readonly string[],
): Promise<{ kind: "role_link"; groupId: string; title: string }[]> {
  if (!roleIds.length) return [];
  const roles = await prisma.recruitingRole.findMany({
    where: { id: { in: [...roleIds] }, spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true, title: true, sourceThread: { select: { groupId: true } } },
  });
  return roleIds.flatMap((id) => {
    const role = roles.find((row) => row.id === id);
    const groupId = role?.sourceThread.groupId;
    return role && groupId ? [{ kind: "role_link" as const, groupId, title: role.title }] : [];
  });
}
