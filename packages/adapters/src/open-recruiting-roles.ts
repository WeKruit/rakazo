/** The account's open roles: not archived, and the role's chat (or bot) not archived either. */
export function openRecruitingRoles(actor: { userId: string; spaceId: string }) {
  return {
    userId: actor.userId,
    spaceId: actor.spaceId,
    archivedAt: null,
    sourceThread: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      OR: [{ group: { archivedAt: null } }, { bot: { archivedAt: null } }],
    },
  };
}
