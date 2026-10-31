import type { BackgroundWorkTiming } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

/** Existing receipts record first observed running/completed, never an estimated duration. */
export async function loadBackgroundWorkTiming(
  tx: Pick<Prisma.TransactionClient, "externalEffect">,
  threadId: string,
): Promise<BackgroundWorkTiming[]> {
  const rows = await tx.externalEffect.findMany({
    where: { kind: "work_estimate", status: { in: ["running", "done"] }, run: { threadId } },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      createdAt: true,
      updatedAt: true,
      runId: true,
      run: { select: { botId: true, startedAt: true } },
    },
  });
  return rows.map((row) => ({
    runId: row.runId,
    botId: row.run.botId,
    startedAt: row.createdAt.toISOString(),
    endedAt: row.status === "done" ? row.updatedAt.toISOString() : null,
    turnStartedAt: row.run.startedAt?.toISOString() ?? null,
  }));
}
