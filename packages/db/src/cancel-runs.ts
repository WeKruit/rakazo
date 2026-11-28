import { ACTIVE_RUN_STATUSES, AUTOMATION_RUN_TRIGGERS, ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { submitSessionInput } from "./conversation-session.js";

/**
 * A request another conversation sent: its block names the conversation it returns to (a
 * request message holds that one block).
 */
export const DELEGATED_FROM_ANOTHER_CONVERSATION = {
  blocks: { path: ["0", "returnThreadId"], string_starts_with: "" },
} satisfies Prisma.MessageWhereInput;

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
            OR: [
              {
                trigger: { notIn: [...AUTOMATION_RUN_TRIGGERS] },
                NOT: {
                  sourceMessage: { is: { blocks: { array_contains: [{ kind: "handoff" }] } } },
                },
              },
              // Work handed over from the recruiter's own conversation is their turn too.
              {
                trigger: "bot_message",
                sourceMessage: { is: DELEGATED_FROM_ANOTHER_CONVERSATION },
              },
            ],
          }
        : {}),
    status: { in: [...ACTIVE_RUN_STATUSES] },
  };
}

/**
 * Stop the live runs that are operations of an agent session: each session gets one `stop`
 * input, which its owner turns into an abort; the run ends through its own projection. Returns
 * the sessions to wake after commit and the runs that belong to no session.
 */
export async function submitStopInputsInTransaction(
  tx: Pick<Prisma.TransactionClient, "conversationSession" | "$queryRaw" | "$executeRaw">,
  runs: ReadonlyArray<{ id: string; threadId: string; botId: string }>,
  trigger: string,
): Promise<{ sessionIds: string[]; unowned: string[] }> {
  if (runs.length === 0) return { sessionIds: [], unowned: [] };
  const sessions = await tx.conversationSession.findMany({
    where: { OR: runs.map((run) => ({ threadId: run.threadId, botId: run.botId })) },
    select: { id: true, threadId: true, botId: true },
  });
  const sessionOf = (run: { threadId: string; botId: string }) =>
    sessions.find((session) => session.threadId === run.threadId && session.botId === run.botId);
  const stopped = new Set<string>();
  const unowned: string[] = [];
  for (const run of runs) {
    const session = sessionOf(run);
    if (!session) {
      unowned.push(run.id);
      continue;
    }
    if (stopped.has(session.id)) continue;
    stopped.add(session.id);
    await submitSessionInput(tx, {
      sessionId: session.id,
      kind: "stop",
      trigger,
      payload: { text: "", runId: run.id },
    });
  }
  return { sessionIds: [...stopped], unowned };
}

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task">,
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
}

/**
 * Stopping a whole conversation also ends what would continue it later: queued steering, a
 * people search's follow-ups, one-shot reminders and cloud agents. The stop button and the
 * agent's own stop share it; the caller cancels the runs and holds the thread lock.
 */
export async function endThreadWorkInTransaction(
  tx: Pick<
    Prisma.TransactionClient,
    "steeringMessage" | "externalEffect" | "run" | "routine" | "cloudAgent"
  >,
  scope: {
    spaceId: string;
    userId: string;
    threadId: string;
    /** The agent's own turn that is stopping the rest. */
    keepRunId?: string;
    /** The agent's stop ends the work, not a reminder the person set. */
    keepReminders?: boolean;
  },
): Promise<void> {
  // Clear delivery intent, never the original human messages in the transcript.
  await tx.steeringMessage.deleteMany({
    where: {
      userId: scope.userId,
      message: { threadId: scope.threadId },
      ...(scope.keepRunId ? { NOT: { runId: scope.keepRunId } } : {}),
    },
  });
  await tx.externalEffect.updateMany({
    where: {
      kind: "work_estimate",
      status: "running",
      spaceId: scope.spaceId,
      run: { threadId: scope.threadId, userId: scope.userId },
    },
    data: { status: "cancelled" },
  });
  // An earlier stopped turn no longer keeps what its searches bring back.
  await tx.run.updateMany({
    where: { threadId: scope.threadId, status: "cancelled", error: STOPPED_TURN },
    data: { error: null },
  });
  // Pending one-shot reminders are disarmed, not deleted.
  if (!scope.keepReminders)
    await tx.routine.updateMany({
      where: { threadId: scope.threadId, active: true, crons: { equals: [ONCE_ROUTINE_CRON] } },
      data: { active: false, nextRunAt: null },
    });
  await tx.cloudAgent.updateMany({
    where: {
      threadId: scope.threadId,
      spaceId: scope.spaceId,
      userId: scope.userId,
      status: "running",
    },
    data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: new Date() },
  });
}
