import type {
  AdapterContext,
  BackgroundJobPayloads,
  ConnectorProvider,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { recruitingResearchPollJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { classifyRecruitingResearchResult } from "./recruiting-research.js";

/** How long a foreground status read waits at the provider before the turn moves on. */
export const RECRUITING_RESEARCH_FOREGROUND_WAIT_SECONDS = 10;
/** Shown to the model when a task is still working after the foreground wait. */
export const RECRUITING_RESEARCH_BACKGROUND_NOTICE =
  "Research continues in the background. Its results are delivered to this conversation automatically when the provider finishes; do not poll status.";
/** Polls stop after this many checks (2 hours at the fixed interval). */
export const RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS = 720;
/** A status probe is a free provider read; a short fixed interval keeps the handoff delay small. */
export const RECRUITING_RESEARCH_POLL_INTERVAL_MS = 10_000;

/** One wake per provider round: a reply (feedback/continuation) on the same task is a new round. */
export function recruitingResearchWakeNonce(
  taskId: string,
  providerTaskId: string,
  replyEffectId?: string | null,
): string {
  const base = `recruiting-research-wake:${taskId}:${providerTaskId}`;
  return replyEffectId ? `${base}:${replyEffectId}` : base;
}

export function recruitingResearchPollDelay(_attempt: number): Date {
  return new Date(Date.now() + RECRUITING_RESEARCH_POLL_INTERVAL_MS);
}

export type RecruitingResearchPollDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  connector?: ConnectorProvider;
};

/**
 * Sibling of `cloud_agent.poll`: one read-only `get_task` probe per tick, never a paid search.
 * On a terminal provider state, exactly one wake run opens for the owning actor/space/bot/thread
 * (unique run clientNonce per task+provider task); its text carries only local ids. That run saves
 * the output through the ordinary recruiting_research status/rows/save_results tools, so effect
 * receipts, task ownership checks and candidate-page idempotency stay the existing ones.
 */
export async function pollRecruitingResearch(
  deps: RecruitingResearchPollDeps,
  payload: BackgroundJobPayloads["recruiting_research.poll"],
): Promise<void> {
  const attempt = payload.attempt ?? 0;
  const task = await deps.prisma.recruitingResearchTask.findFirst({
    where: { id: payload.taskId },
    select: {
      id: true,
      state: true,
      roleId: true,
      providerTaskId: true,
      mcpServerId: true,
      serverRevision: true,
      role: { select: { spaceId: true, userId: true } },
      createdByRun: { select: { spaceId: true, userId: true, botId: true, threadId: true } },
    },
  });
  if (task?.state !== "active" || !task.providerTaskId) return;
  const { role, createdByRun: run } = task;
  // The task's role and creating run must agree on one owner; otherwise it is nobody's to wake.
  if (role.spaceId !== run.spaceId || role.userId !== run.userId) return;
  const { providerTaskId } = task;
  // The latest accepted reply on this provider task identifies the round; none means the first.
  const reply = await deps.prisma.externalEffect.findFirst({
    where: {
      spaceId: run.spaceId,
      status: "completed",
      request: { path: ["0"], equals: "__rakazoCatalogTool" },
      OR: ["direct", "connectors_execute_tool", "mcp_execute_tool"].map((tool) => {
        const route = tool === "direct" ? ["2", "route"] : ["3"];
        const args = ["2", tool === "direct" ? "args" : "arguments"];
        return {
          AND: [
            { request: { path: ["1"], equals: tool } },
            { request: { path: [...route, "resourceId"], equals: task.mcpServerId } },
            { request: { path: [...route, "toolName"], equals: "reply" } },
            { request: { path: [...args, "task_id"], equals: providerTaskId } },
          ],
        };
      }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const nonce = recruitingResearchWakeNonce(task.id, task.providerTaskId, reply?.id);
  const woken = await deps.prisma.run.findFirst({
    where: { spaceId: run.spaceId, clientNonce: nonce },
    select: { id: true },
  });
  if (woken || !deps.connector) return;
  const context: AdapterContext = {
    operationId: `recruiting_research.poll:${task.id}:${attempt}`,
    traceId: `recruiting_research.poll:${task.id}`,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: AbortSignal.timeout(30_000),
  };
  let result: unknown;
  let failed = false;
  try {
    for await (const event of deps.connector.execute(
      {
        tool: "mcp__recruiting_research_poll__get_task",
        executionId: context.operationId,
        route: {
          connectorId: "mcp",
          resourceId: task.mcpServerId,
          resourceRevision: task.serverRevision,
          toolName: "get_task",
        },
        args: { task_id: task.providerTaskId, wait_seconds: 0 },
      },
      context,
    )) {
      if (event.type === "result") result = event.data;
      if (event.type === "error") failed = true;
    }
  } catch (error) {
    failed = true;
    getLogger().warn("recruiting research poll probe failed", { error: String(error) });
  }
  const observation = failed
    ? undefined
    : classifyRecruitingResearchResult(result, {
        operation: "status",
        providerTaskId: task.providerTaskId,
      });
  const terminal = observation?.deliveryState === "accepted" && observation.done === true;
  if (!terminal) {
    if (attempt + 1 >= RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS) return;
    await deps.jobs.enqueue(
      recruitingResearchPollJob(
        { taskId: task.id, attempt: attempt + 1 },
        recruitingResearchPollDelay(attempt),
      ),
    );
    return;
  }
  const state = observation.observedProviderState ?? "finished";
  const wakeRunId = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as the cloud-agent poll: the thread row serializes concurrent wakes.
    const locked = await tx.thread.updateMany({
      where: { id: run.threadId, spaceId: run.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    const [bot, existing] = await Promise.all([
      tx.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
        select: { id: true },
      }),
      tx.run.findFirst({
        where: { spaceId: run.spaceId, clientNonce: nonce },
        select: { id: true },
      }),
    ]);
    if (!bot || existing) return null;
    // Provider text is untrusted. Wake with local identity and status only.
    const summary = `Research task ${task.id} for recruiting role ${task.roleId} is ${state}. Use recruiting_research status, then read and save every rows page with save_results, following each returned cursor, so all returned people are kept, including unassessed people. Do not start new research.`;
    const wakeTask = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: summary,
        status: "queued",
      },
    });
    const wake = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        taskId: wakeTask.id,
        status: "queued",
        trigger: "recruiting_research",
        clientNonce: nonce,
      },
    });
    return wake.id;
  });
  if (!wakeRunId) return;
  // The existing run reconciler recovers a queued wake after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(wakeRunId)).catch(() => {
    getLogger().warn("recruiting research wake deferred to reconciliation");
  });
}
