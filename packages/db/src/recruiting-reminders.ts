import type {
  Actor,
  CreateRecruitingReminderInput,
  ListRecruitingRemindersInput,
  RecruitingReminder,
  RecruitingRemindersToolInput,
  UpdateRecruitingReminderInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type Row = {
  id: string;
  roleId: string | null;
  candidateKey: string | null;
  title: string;
  note: string | null;
  dueAt: Date;
  status: "open" | "done" | "dismissed";
  completedAt: Date | null;
  createdByBotId: string | null;
  createdAt: Date;
};

// Scope is (spaceId, ownerUserId): recruiting tables have no organizationId, only space + user.
const owned = (actor: Actor) => ({ spaceId: actor.spaceId, ownerUserId: actor.userId });

const view = (r: Row): RecruitingReminder => ({
  id: r.id,
  roleId: r.roleId,
  candidateKey: r.candidateKey,
  title: r.title,
  note: r.note,
  dueAt: r.dueAt.toISOString(),
  status: r.status,
  completedAt: r.completedAt?.toISOString() ?? null,
  createdBy: r.createdByBotId ? "agent" : "user",
  createdAt: r.createdAt.toISOString(),
});

async function requireOwnedRole(prisma: PrismaClient, actor: Actor, roleId: string) {
  const role = await prisma.recruitingRole.findFirst({
    where: { id: roleId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!role) throw new IsolationError();
}

export async function listRecruitingReminders(
  prisma: PrismaClient,
  actor: Actor,
  input: ListRecruitingRemindersInput,
  now = new Date(),
) {
  const where = {
    ...owned(actor),
    ...(input.candidateKey ? { candidateKey: input.candidateKey } : {}),
    ...(input.roleId ? { roleId: input.roleId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.dueBefore ? { dueAt: { lt: new Date(input.dueBefore) } } : {}),
  };
  const [rows, overdueCount] = await Promise.all([
    prisma.recruitingReminder.findMany({ where, orderBy: [{ dueAt: "asc" }, { id: "asc" }] }),
    // Overdue = open and past due, within the same role/candidate filters.
    prisma.recruitingReminder.count({
      where: { ...where, status: "open", dueAt: { lt: now } },
    }),
  ]);
  return { items: rows.map(view), overdueCount };
}

export async function createRecruitingReminder(
  prisma: PrismaClient,
  actor: Actor,
  input: CreateRecruitingReminderInput,
  botId?: string,
) {
  if (input.roleId) await requireOwnedRole(prisma, actor, input.roleId);
  const row = await prisma.recruitingReminder.create({
    data: {
      spaceId: actor.spaceId,
      ownerUserId: actor.userId,
      roleId: input.roleId ?? null,
      candidateKey: input.candidateKey ?? null,
      title: input.title,
      note: input.note ?? null,
      dueAt: new Date(input.dueAt),
      createdByBotId: botId ?? null,
    },
  });
  return view(row);
}

export async function updateRecruitingReminder(
  prisma: PrismaClient,
  actor: Actor,
  input: UpdateRecruitingReminderInput,
  now = new Date(),
) {
  const found = await prisma.recruitingReminder.findFirst({
    where: { id: input.id, ...owned(actor) },
  });
  if (!found) throw new IsolationError();
  const row = await prisma.recruitingReminder.update({
    where: { id: found.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
      ...(input.status !== undefined
        ? { status: input.status, completedAt: input.status === "done" ? now : null }
        : {}),
    },
  });
  return view(row);
}

export async function deleteRecruitingReminder(prisma: PrismaClient, actor: Actor, id: string) {
  const { count } = await prisma.recruitingReminder.deleteMany({
    where: { id, ...owned(actor) },
  });
  if (!count) throw new IsolationError();
  return { ok: true as const };
}

/** Agent-tool op mapping; a created reminder is attributed to the run's bot. */
export function executeRecruitingRemindersTool(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  input: RecruitingRemindersToolInput,
) {
  switch (input.operation) {
    case "list": {
      const { operation: _, ...rest } = input;
      return listRecruitingReminders(prisma, actor, rest);
    }
    case "create": {
      const { operation: _, ...rest } = input;
      return createRecruitingReminder(prisma, actor, rest, botId);
    }
    case "update": {
      const { operation: _, ...rest } = input;
      return updateRecruitingReminder(prisma, actor, rest);
    }
    case "delete":
      return deleteRecruitingReminder(prisma, actor, input.id);
  }
}
