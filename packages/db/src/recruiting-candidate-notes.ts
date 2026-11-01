import type {
  Actor,
  CreateRecruitingCandidateNoteInput,
  ListRecruitingCandidateNotesInput,
  RecruitingCandidateNote,
  RecruitingNotesToolInput,
  UpdateRecruitingCandidateNoteInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type Row = {
  id: string;
  roleId: string | null;
  candidateKey: string;
  body: string;
  artifactIds: string[];
  createdByBotId: string | null;
  createdAt: Date;
  updatedAt: Date;
  owner?: { name: string } | null;
};

// Scope is (spaceId, ownerUserId), like reminders; soft-deleted notes are never visible.
const owned = (actor: Actor) => ({
  spaceId: actor.spaceId,
  ownerUserId: actor.userId,
  deletedAt: null,
});
const withOwner = { owner: { select: { name: true } } } as const;

type Attachment = RecruitingCandidateNote["attachments"][number];
async function ownedAttachments(
  prisma: PrismaClient,
  actor: Actor,
  ids: readonly string[],
): Promise<Attachment[]> {
  if (!ids.length) return [];
  return prisma.artifact.findMany({
    where: { id: { in: [...new Set(ids)] }, userId: actor.userId, spaceId: actor.spaceId },
    select: { id: true, name: true, mimeType: true, size: true },
  });
}
const view = (
  r: Row,
  botNames: ReadonlyMap<string, string>,
  attachments: readonly Attachment[],
): RecruitingCandidateNote => {
  const authorName = r.createdByBotId ? botNames.get(r.createdByBotId) : r.owner?.name;
  return {
    id: r.id,
    roleId: r.roleId,
    candidateKey: r.candidateKey,
    body: r.body,
    attachments: attachments.filter((item) => r.artifactIds.includes(item.id)),
    createdBy: r.createdByBotId ? "agent" : "user",
    ...(authorName ? { authorName } : {}),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
};

async function botNames(prisma: PrismaClient, actor: Actor, rows: readonly Row[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.createdByBotId ? [r.createdByBotId] : [])))];
  if (!ids.length) return new Map<string, string>();
  const bots = await prisma.bot.findMany({
    where: { id: { in: ids }, spaceId: actor.spaceId },
    select: { id: true, name: true },
  });
  return new Map(bots.map((bot) => [bot.id, bot.name]));
}

const one = async (prisma: PrismaClient, actor: Actor, row: Row) =>
  view(
    row,
    await botNames(prisma, actor, [row]),
    await ownedAttachments(prisma, actor, row.artifactIds),
  );

async function requireOwnedRole(prisma: PrismaClient, actor: Actor, roleId: string) {
  const role = await prisma.recruitingRole.findFirst({
    where: { id: roleId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!role) throw new IsolationError();
}

export async function listRecruitingCandidateNotes(
  prisma: PrismaClient,
  actor: Actor,
  input: ListRecruitingCandidateNotesInput,
) {
  const rows = await prisma.recruitingCandidateNote.findMany({
    where: {
      ...owned(actor),
      candidateKey: { in: input.candidateKeys },
      ...(input.roleId ? { roleId: input.roleId } : {}),
    },
    include: withOwner,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const names = await botNames(prisma, actor, rows);
  const attachments = await ownedAttachments(
    prisma,
    actor,
    rows.flatMap((row) => row.artifactIds),
  );
  return { items: rows.map((row) => view(row, names, attachments)) };
}

export async function createRecruitingCandidateNote(
  prisma: PrismaClient,
  actor: Actor,
  input: CreateRecruitingCandidateNoteInput,
  botId?: string,
) {
  if (input.roleId) await requireOwnedRole(prisma, actor, input.roleId);
  const artifactIds = [...new Set(input.artifactIds ?? [])];
  if ((await ownedAttachments(prisma, actor, artifactIds)).length !== artifactIds.length)
    throw new IsolationError();
  const row = await prisma.recruitingCandidateNote.create({
    data: {
      spaceId: actor.spaceId,
      ownerUserId: actor.userId,
      roleId: input.roleId ?? null,
      candidateKey: input.candidateKey,
      body: input.body,
      artifactIds,
      createdByBotId: botId ?? null,
    },
    include: withOwner,
  });
  return one(prisma, actor, row);
}

export async function updateRecruitingCandidateNote(
  prisma: PrismaClient,
  actor: Actor,
  input: UpdateRecruitingCandidateNoteInput,
) {
  const found = await prisma.recruitingCandidateNote.findFirst({
    where: { id: input.id, ...owned(actor) },
    select: { id: true },
  });
  if (!found) throw new IsolationError();
  const artifactIds = input.artifactIds && [...new Set(input.artifactIds)];
  if (
    artifactIds &&
    (await ownedAttachments(prisma, actor, artifactIds)).length !== artifactIds.length
  )
    throw new IsolationError();
  const row = await prisma.recruitingCandidateNote.update({
    where: { id: found.id },
    data: { body: input.body, ...(artifactIds ? { artifactIds } : {}) },
    include: withOwner,
  });
  return one(prisma, actor, row);
}

export async function deleteRecruitingCandidateNote(
  prisma: PrismaClient,
  actor: Actor,
  id: string,
  now = new Date(),
) {
  const { count } = await prisma.recruitingCandidateNote.updateMany({
    where: { id, ...owned(actor) },
    data: { deletedAt: now },
  });
  if (!count) throw new IsolationError();
  return { ok: true as const };
}

/** Agent-tool op mapping; a created note is attributed to the run's bot. */
export function executeRecruitingNotesTool(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  input: RecruitingNotesToolInput,
) {
  switch (input.operation) {
    case "list": {
      const { operation: _, ...rest } = input;
      return listRecruitingCandidateNotes(prisma, actor, rest);
    }
    case "create": {
      const { operation: _, ...rest } = input;
      return createRecruitingCandidateNote(prisma, actor, rest, botId);
    }
    case "update": {
      const { operation: _, ...rest } = input;
      return updateRecruitingCandidateNote(prisma, actor, rest);
    }
    case "delete":
      return deleteRecruitingCandidateNote(prisma, actor, input.id);
  }
}
