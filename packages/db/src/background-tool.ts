import { RUN_TRIGGERS } from "@rakazo/contracts";
import { isConversationalRun } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import {
  appendEventInTransaction,
  createPendingSteeringRun,
  RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX,
} from "./events.js";

/** Scheduling may change the run's lane, never the origin of its conversation or attachments. */
export async function backgroundToolSourceTrigger(
  prisma: Pick<PrismaClient, "event">,
  run: { id: string; spaceId: string; threadId: string; botId: string; trigger: string },
): Promise<string> {
  if (run.trigger !== "tool_background") return run.trigger;
  return originalRunTrigger(prisma, run);
}

async function originalRunTrigger(
  prisma: Pick<PrismaClient, "event">,
  run: { id: string; spaceId: string; threadId: string; botId: string },
): Promise<string> {
  // The executor commits this event before any tool can run. Reuse that original receipt;
  // later lease attempts may append another started event, so the first one is authoritative.
  const started = await prisma.event.findFirst({
    where: {
      runId: run.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "run.started",
    },
    orderBy: { seq: "asc" },
    select: { payload: true },
  });
  const trigger = (started?.payload as { trigger?: unknown } | undefined)?.trigger;
  if (
    typeof trigger !== "string" ||
    !RUN_TRIGGERS.some((value) => value === trigger) ||
    !isConversationalRun(trigger)
  )
    throw new Error("The original turn could not be restored. Try again.");
  return trigger;
}

/** The same tool keeps its lease and receipt; the conversation gets its own native turn. */
export async function backgroundToolRun(
  prisma: PrismaClient,
  input: {
    runId: string;
    threadId: string;
    botId: string;
    spaceId: string;
    userId: string;
    leaseOwner: string;
    leaseFence: number;
    executionId: string;
    toolName: string;
    durationMs: number;
  },
): Promise<{ promoted: boolean; continuationRunId: string | null; eventSeq: number | null }> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const { runId, executionId, toolName, durationMs, ...scope } = input;
    const run = await tx.run.findFirst({
      where: { id: runId, ...scope, status: "running" },
      select: { trigger: true, clientNonce: true },
    });
    const unchanged = { promoted: false, continuationRunId: null, eventSeq: null };
    if (
      !run ||
      !isConversationalRun(run.trigger) ||
      run.clientNonce?.startsWith(RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX)
    )
      return unchanged;
    const sourceTrigger = await originalRunTrigger(tx, { id: runId, ...scope });
    if (sourceTrigger !== run.trigger)
      throw new Error("The original turn could not be restored. Try again.");
    const changed = await tx.run.updateMany({
      where: {
        id: runId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: { trigger: "tool_background" },
    });
    if (changed.count !== 1) return unchanged;
    await tx.steeringMessage.updateMany({
      where: {
        runId,
        claimedAt: null,
        OR: [{ originTrigger: null }, { originTrigger: "interrupt" }],
      },
      data: { runId: null, originTrigger: null },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      runId,
      type: "run.started",
      payload: {
        trigger: "tool_background",
        sourceTrigger: run.trigger,
        backgrounded: true,
        executionId,
        toolName,
        durationMs,
      },
    });
    return {
      promoted: true,
      eventSeq: event.seq,
      continuationRunId: await createPendingSteeringRun(tx, input),
    };
  });
}
