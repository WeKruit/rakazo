import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "./client.js";

/** Runs one automation may start per minute; fires past this are skipped, never run. */
export const AUTOMATION_RUNS_PER_MINUTE = 20;
/** The `error` a skipped fire's cancelled run carries; it also keeps skips out of the count. */
export const AUTOMATION_RATE_LIMITED_ERROR = "Skipped. This automation fired too often.";

/** Triggers a retry storm can repeat with no person behind them. */
const RATE_LIMITED_TRIGGERS = new Set(["routine", "webhook", "tickets", "bot_message"]);
const WINDOW_MS = 60_000;

export type AutomationFire = {
  spaceId: string;
  botId: string;
  trigger: string;
  routineId: string | null;
  createdAt: Date;
  /** The run already created for this fire, which is not counted against itself. */
  id?: string;
};

/**
 * Whether this fire would exceed the automation's per-minute cap. An automation is its routine,
 * or else one bot's turns of one trigger. Only runs fired before this one count, so the first
 * runs of a burst go ahead whatever order workers pick them up in.
 */
export async function automationRateLimited(
  db: Pick<Prisma.TransactionClient, "run">,
  fire: AutomationFire,
): Promise<boolean> {
  if (!RATE_LIMITED_TRIGGERS.has(fire.trigger)) return false;
  const since = new Date(fire.createdAt.getTime() - WINDOW_MS);
  const earlier = await db.run.count({
    where: {
      ...(fire.routineId
        ? { routineId: fire.routineId }
        : { spaceId: fire.spaceId, botId: fire.botId, trigger: fire.trigger }),
      AND: [
        fire.id
          ? {
              OR: [
                { createdAt: { gte: since, lt: fire.createdAt } },
                { createdAt: fire.createdAt, id: { lt: fire.id } },
              ],
            }
          : { createdAt: { gte: since, lte: fire.createdAt } },
        { OR: [{ error: null }, { error: { not: AUTOMATION_RATE_LIMITED_ERROR } }] },
      ],
    },
  });
  return earlier >= AUTOMATION_RUNS_PER_MINUTE;
}

/** Cancel a never-claimed run as a skipped fire. Returns false when the run already moved on. */
export async function skipRateLimitedRun(
  tx: Pick<Prisma.TransactionClient, "run" | "task">,
  run: { id: string; taskId: string },
  now: Date,
): Promise<boolean> {
  const skipped = await tx.run.updateMany({
    where: { id: run.id, status: "queued", leaseFence: 0 },
    data: { status: "cancelled", error: AUTOMATION_RATE_LIMITED_ERROR, completedAt: now },
  });
  if (skipped.count !== 1) return false;
  const sibling = await tx.run.count({
    where: { taskId: run.taskId, id: { not: run.id }, status: { in: [...ACTIVE_RUN_STATUSES] } },
  });
  if (!sibling) {
    await tx.task.updateMany({ where: { id: run.taskId }, data: { status: "cancelled" } });
  }
  return true;
}
