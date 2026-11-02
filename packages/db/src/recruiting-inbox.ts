import type {
  Actor,
  ListRecruitingInboxInput,
  MarkRecruitingInboxInput,
  RecruitingInboxReadState,
  RecruitingOverviewRole,
} from "@rakazo/contracts";
import { inboxThreadKey, RecruitingOverviewRoleSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export async function listRecruitingInbox(
  prisma: PrismaClient,
  actor: Actor,
  input: ListRecruitingInboxInput,
): Promise<RecruitingInboxReadState> {
  // The first read fixes a durable baseline, including for threads discovered later.
  const baseline = await prisma.recruitingInboxInitialization.upsert({
    where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
    create: { userId: actor.userId, spaceId: actor.spaceId },
    update: { userId: actor.userId },
  });
  const rows = await prisma.recruitingInboxCursor.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      threadKey: { in: input.threads.map(inboxThreadKey) },
    },
  });
  return {
    initializedAt: baseline.initializedAt.toISOString(),
    items: rows.map((row) => ({
      key: row.threadKey,
      lastReadAt: row.lastReadAt?.toISOString() ?? null,
      unread: row.unread,
    })),
  };
}

export async function markRecruitingInbox(
  prisma: PrismaClient,
  actor: Actor,
  input: MarkRecruitingInboxInput,
): Promise<void> {
  const observed = new Date(input.observedIncomingAt);
  if (!Number.isFinite(observed.getTime()) || observed.getTime() > Date.now())
    throw new Error("Invalid incoming timestamp");
  const baseline = await prisma.recruitingInboxInitialization.upsert({
    where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
    create: { userId: actor.userId, spaceId: actor.spaceId },
    update: { userId: actor.userId },
  });
  const through = new Date(Math.max(observed.getTime(), baseline.initializedAt.getTime()));
  // One atomic upsert: two concurrent opens cannot move a read cursor backwards.
  await prisma.$executeRaw`
    INSERT INTO recruiting_inbox_cursors (user_id, space_id, thread_key, last_read_at, unread)
    VALUES (${actor.userId}, ${actor.spaceId}, ${inboxThreadKey(input.thread)}, ${input.unread ? null : through}, ${input.unread})
    ON CONFLICT (user_id, space_id, thread_key) DO UPDATE SET
      last_read_at = GREATEST(recruiting_inbox_cursors.last_read_at, EXCLUDED.last_read_at),
      unread = EXCLUDED.unread
  `;
}

/** The last finished Home overview for this account, or none. Roles that fail to parse are dropped. */
export async function readRecruitingOverviewSnapshot(
  prisma: PrismaClient,
  actor: Actor,
): Promise<RecruitingOverviewRole[]> {
  const row = await prisma.recruitingOverviewSnapshot.findUnique({
    where: { userId_spaceId: { userId: actor.userId, spaceId: actor.spaceId } },
    select: { roles: true },
  });
  const roles = Array.isArray(row?.roles) ? row.roles : [];
  return roles.flatMap((role) => {
    const parsed = RecruitingOverviewRoleSchema.safeParse(role);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function saveRecruitingOverviewSnapshot(
  prisma: PrismaClient,
  actor: Actor,
  roles: RecruitingOverviewRole[],
): Promise<void> {
  const where = { userId: actor.userId, spaceId: actor.spaceId };
  await prisma.recruitingOverviewSnapshot.upsert({
    where: { userId_spaceId: where },
    create: { ...where, roles },
    update: { roles, savedAt: new Date() },
  });
}
