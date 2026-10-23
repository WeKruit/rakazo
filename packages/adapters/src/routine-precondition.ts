import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import { isOneShotRoutineCrons, nextCronDateAcross } from "@rakazo/core";
import type { PrismaClient, Routine, ThreadEvents } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * A routine opts into a native precondition with one line in its prompt, for example
 * `precondition: new_activity`. The line costs nothing to the model and needs no new column.
 * `new_activity`: a person wrote in the routine's thread, an inbound external message arrived
 * for the bot, or a recruiting role changed since the routine last actually ran.
 */
export type RoutinePrecondition = "new_activity";

const DIRECTIVE = /^[ \t]*precondition:[ \t]*(new_activity)[ \t]*$/im;

export function parseRoutinePrecondition(prompt: string): RoutinePrecondition | undefined {
  return DIRECTIVE.exec(prompt)?.[1]?.toLowerCase() as RoutinePrecondition | undefined;
}

type RoutineScope = Pick<Routine, "spaceId" | "userId" | "botId" | "threadId" | "lastRunAt">;

/** Cheap existence checks over existing tables; never a shell probe or a model call. */
export async function routinePreconditionMet(
  prisma: PrismaClient,
  routine: RoutineScope,
  precondition: RoutinePrecondition,
  threadId: string | undefined,
): Promise<boolean> {
  if (precondition !== "new_activity") return true;
  const since = routine.lastRunAt;
  if (!since) return true;
  const { spaceId, userId, botId } = routine;
  const [messages, inbound, recruiting] = await Promise.all([
    threadId
      ? prisma.message.count({ where: { threadId, role: "user", createdAt: { gt: since } } })
      : 0,
    prisma.externalMessage.count({
      where: {
        senderIsBot: false,
        createdAt: { gt: since },
        externalConversation: { spaceId, userId, botId },
      },
    }),
    prisma.recruitingRoleRevision.count({
      where: { createdAt: { gt: since }, role: { spaceId, userId } },
    }),
  ]);
  return messages + inbound + recruiting > 0;
}

/**
 * Before `routine.wakeup` opens a run: when the routine names a precondition and nothing changed,
 * claim this due occurrence, advance the schedule without touching `lastRunAt`, record the skipped
 * trigger on the thread, and report true so the caller does not wake the model. Anything the
 * executor's own wake would reject (inactive, stale, future) is left to it.
 */
export async function skipRoutineWithoutNewActivity(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: Pick<ThreadEvents, "append"> },
  payload: { routineId: string; scheduledFor: string },
): Promise<boolean> {
  const scheduledAt = new Date(payload.scheduledFor);
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() > Date.now() + 1_000)
    return false;
  const routine = await deps.prisma.routine.findUnique({ where: { id: payload.routineId } });
  if (!routine?.active || routine.nextRunAt?.getTime() !== scheduledAt.getTime()) return false;
  const precondition = parseRoutinePrecondition(routine.prompt);
  if (!precondition) return false;
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    select: { archivedAt: true, thread: { select: { id: true } } },
  });
  if (!bot || bot.archivedAt) return false;
  const threadId = routine.threadId ?? bot.thread?.id;
  if (await routinePreconditionMet(deps.prisma, routine, precondition, threadId)) return false;
  const nextRunAt = isOneShotRoutineCrons(routine.crons)
    ? null
    : nextCronDateAcross(
        routine.crons,
        new Date(Math.max(Date.now(), scheduledAt.getTime())),
        routine.timezone,
      );
  const claimed = await deps.prisma.routine.updateMany({
    where: { id: routine.id, active: true, nextRunAt: scheduledAt },
    data: { nextRunAt, ...(nextRunAt ? {} : { active: false }) },
  });
  // A lost claim means another worker took this occurrence; it decides, not us.
  if (claimed.count !== 1) return true;
  if (threadId) {
    try {
      await deps.events.append({
        spaceId: routine.spaceId,
        threadId,
        botId: routine.botId,
        type: "routine.fired",
        payload: {
          routineId: routine.id,
          scheduledFor: payload.scheduledFor,
          skipped: true,
          reason: "no_new_activity",
          precondition,
        },
      });
    } catch (error) {
      getLogger().warn("routine skip event not recorded", error);
    }
  }
  if (nextRunAt) await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  else await deps.jobs.cancel(routineJobKey(routine.id)).catch(() => undefined);
  return true;
}

export const ROUTINE_FAILURE_PAUSE_THRESHOLD = 5;

/**
 * After a routine run fails: when its last five runs all failed, pause the routine and say so
 * once in the thread the run used. The streak is read from the routine's own runs, so a success
 * resets it without any counter column. Returns true when this call paused the routine.
 */
export async function pauseRoutineAfterRepeatedFailures(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: Pick<ThreadEvents, "notify"> },
  runId: string,
): Promise<boolean> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { routineId: true, status: true, threadId: true },
  });
  if (!run?.routineId || run.status !== "failed") return false;
  const recent = await deps.prisma.run.findMany({
    where: { routineId: run.routineId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ROUTINE_FAILURE_PAUSE_THRESHOLD,
    select: { status: true },
  });
  if (
    recent.length < ROUTINE_FAILURE_PAUSE_THRESHOLD ||
    recent.some((entry) => entry.status !== "failed")
  )
    return false;
  const routine = await deps.prisma.routine.findUnique({
    where: { id: run.routineId },
    select: { name: true },
  });
  const paused = await deps.prisma.routine.updateMany({
    where: { id: run.routineId, active: true },
    data: { active: false, nextRunAt: null },
  });
  // Only the call that flipped it posts the notice, so a replayed job never repeats it.
  if (paused.count !== 1) return false;
  await deps.jobs.cancel(routineJobKey(run.routineId)).catch(() => undefined);
  const note = await createThreadMessage(deps.prisma, {
    threadId: run.threadId,
    role: "system",
    blocks: [
      {
        kind: "meta",
        text: `Routine "${routine?.name ?? run.routineId}" was paused after ${ROUTINE_FAILURE_PAUSE_THRESHOLD} consecutive failed runs. Fix the cause, then resume it.`,
      },
    ],
  });
  await deps.events.notify(run.threadId, note.seq).catch(() => undefined);
  return true;
}
