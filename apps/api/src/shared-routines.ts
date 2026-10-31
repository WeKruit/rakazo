import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { nextRoutineDate } from "@rakazo/adapters";
import type { Actor, SharedRoutine } from "@rakazo/contracts";
import { isOneShotRoutineCrons, nextRoutineWakeAt } from "@rakazo/core";
import { IsolationError, type PrismaClient, type Routine } from "@rakazo/db";

type Deps = { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> };

/**
 * Team routines: a member shares one of their routines with the Space explicitly, and each other
 * member who adds it gets their own copy on their own bot. A copy runs as its member, with that
 * member's tools, memory and credentials; it follows the original's instructions and schedule
 * but never its owner's identity, history, approvals or webhook secrets.
 */
export function createSharedRoutines(deps: Deps) {
  return {
    async list(actor: Actor): Promise<SharedRoutine[]> {
      const rows = await deps.prisma.routine.findMany({
        where: {
          spaceId: actor.spaceId,
          shared: true,
          sharedFromId: null,
          userId: { not: actor.userId },
          bot: { archivedAt: null },
          // Only schedule and record triggers carry over to a member's copy.
          OR: [{ crons: { isEmpty: false } }, { recordTrigger: { not: null } }],
        },
        orderBy: { name: "asc" },
        take: 200,
      });
      if (rows.length === 0) return [];
      const [owners, copies] = await Promise.all([
        deps.prisma.user.findMany({
          where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
          select: { id: true, name: true },
        }),
        deps.prisma.routine.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            sharedFromId: { in: rows.map((row) => row.id) },
          },
          select: { sharedFromId: true },
        }),
      ]);
      const names = new Map(owners.map((owner) => [owner.id, owner.name]));
      const added = new Set(copies.map((copy) => copy.sharedFromId));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        prompt: row.prompt,
        crons: row.crons,
        timezone: row.timezone,
        recordTrigger: (row.recordTrigger as SharedRoutine["recordTrigger"]) ?? null,
        ownerName: names.get(row.userId) ?? "",
        added: added.has(row.id),
      }));
    },

    async add(
      actor: Actor,
      input: { routineId: string; botId: string; active: boolean },
    ): Promise<Routine> {
      const [original, bot] = await Promise.all([
        deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: actor.spaceId,
            shared: true,
            sharedFromId: null,
            userId: { not: actor.userId },
            bot: { archivedAt: null },
            OR: [{ crons: { isEmpty: false } }, { recordTrigger: { not: null } }],
          },
        }),
        deps.prisma.bot.findFirst({
          where: {
            id: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        }),
      ]);
      if (!original || !bot) throw new IsolationError();
      const existing = await deps.prisma.routine.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId, sharedFromId: original.id },
      });
      if (existing) return existing;
      // Webhook, Git and message triggers belong to the owner's bot secrets; only the schedule
      // and record trigger carry over.
      const scheduled =
        original.crons.length > 0 && !isOneShotRoutineCrons(original.crons)
          ? nextRoutineDate(original.crons, original.timezone)
          : null;
      const active = input.active && Boolean(scheduled || original.recordTrigger);
      const nextRunAt = !active ? null : (scheduled ?? nextRoutineWakeAt(original, new Date()));
      const copy = await deps.prisma.routine.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          name: original.name,
          prompt: original.prompt,
          crons: isOneShotRoutineCrons(original.crons) ? [] : original.crons,
          timezone: original.timezone,
          sessionMode: original.sessionMode,
          condition: original.condition,
          probeCommand: original.probeCommand,
          recordTrigger: original.recordTrigger,
          sharedFromId: original.id,
          notify: true,
          active,
          nextRunAt,
        },
      });
      if (copy.active && copy.nextRunAt)
        await deps.jobs.enqueue(routineWakeupJob(copy.id, copy.nextRunAt));
      return copy;
    },
  };
}
