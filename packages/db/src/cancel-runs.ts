import { ACTIVE_RUN_STATUSES, AUTOMATION_RUN_TRIGGERS } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { closeRunAsksInTransaction } from "./closed-asks.js";

/** A cancelled turn may finish registering research that the provider already accepted. */
export const STOPPED_TURN = "turn_stopped";

export function threadStopRunWhere(
  threadId: string,
  runId?: string,
  scope: "turn" | "all" = "turn",
): Prisma.RunWhereInput {
  return {
    threadId,
    ...(runId !== undefined
      ? { id: runId }
      : scope === "turn"
        ? {
            trigger: { notIn: [...AUTOMATION_RUN_TRIGGERS] },
            NOT: {
              sourceMessage: { is: { blocks: { array_contains: [{ kind: "handoff" }] } } },
            },
          }
        : {}),
    status: { in: [...ACTIVE_RUN_STATUSES] },
  };
}

/**
 * The caller selects authorized runs and owns the surrounding transaction and cleanup.
 * A card the cancelled run was waiting on closes with it, so nothing reads it as waiting later.
 */
export async function cancelRunsInTransaction(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  const ended = await tx.run.findMany({
    where: { id: { in: runIds } },
    select: { id: true, spaceId: true, threadId: true, botId: true },
  });
  for (const run of ended) {
    await closeRunAsksInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
    });
  }
}
