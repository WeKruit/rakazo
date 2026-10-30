import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import { recruitingAgentRunWaitJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { mcpObject } from "./recruiting-research.js";

/**
 * A people-search agent run can keep working at the provider for hours, longer than any one
 * turn. When a turn ends with the run still going, the agent that started it is woken in the
 * same conversation to collect it, as often as it takes, until the run finishes. Not a new
 * orchestrator: each wake is one ordinary run whose own agent_run call either collects the
 * people (saved to Results as usual) or, still running, schedules the next wake.
 */
export const RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX = "recruiting-agent-run-wait:";
/** A turn that is still open may collect the run itself, so the first wake waits a minute. */
export const RECRUITING_AGENT_RUN_WAIT_MS = 60_000;
/** Runs nobody has collected after this long since they started are left alone. */
const MAX_WAIT_MS = 12 * 60 * 60_000;
const BUSY_STATUSES = ["queued", "leased", "running"];
const STILL_RUNNING = new Set(["running", "pending", "queued", "in_progress"]);

/** The agent run a provider result describes while it is still working, if it is one. */
export function runningAgentRunId(result: unknown): string | undefined {
  const body = mcpObject(result);
  return typeof body?.id === "string" &&
    body.id.startsWith("agent_run_") &&
    typeof body.status === "string" &&
    STILL_RUNNING.has(body.status)
    ? body.id
    : undefined;
}

export function recruitingAgentRunWaitPrompt(agentRunId: string): string {
  return [
    `Your people-search agent run ${agentRunId} is still working at the provider. Nobody asked for this message; you are continuing your own work.`,
    `Call agent_run with runId "${agentRunId}" to collect it, and call it again while it still reports running. The people it returns are saved to Results automatically.`,
    "When it has finished, say in one line how many new people were added and whether the role's target is met, then carry on with the stage as your instructions say: if the role is still short of its target, the next wave continues this run with previousRunId. Start no unrelated search.",
  ].join("\n");
}

/** A saved provider answer: the executor keeps it whole or under providerResult. */
function providerResult(saved: unknown): unknown {
  return saved !== null && typeof saved === "object" && "providerResult" in saved
    ? (saved as { providerResult: unknown }).providerResult
    : saved;
}

/** Whether the bot still belongs to the conversation. */
async function memberOf(
  prisma: PrismaClient,
  thread: { botId: string | null; groupId: string | null },
  botId: string,
): Promise<boolean> {
  if (!thread.groupId) return thread.botId === botId;
  const member = await prisma.chatGroupMember.findFirst({
    where: { groupId: thread.groupId, botId, bot: { archivedAt: null } },
    select: { botId: true },
  });
  return Boolean(member);
}

export async function waitForRecruitingAgentRun(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["recruiting_agent_run.wait"],
  now = Date.now(),
): Promise<void> {
  const skipped = (reason: string) =>
    getLogger().info("recruiting.agent_run_wait.skipped", { ...payload, reason });
  const thread = await deps.prisma.thread.findUnique({
    where: { id: payload.threadId },
    select: { id: true, spaceId: true, userId: true, botId: true, groupId: true },
  });
  if (!thread) return skipped("no thread");
  if (!(await memberOf(deps.prisma, thread, payload.botId))) return skipped("not a member");
  // The provider's answers to this conversation's agent_run calls, newest first: the newest
  // says whether the run is still going.
  const effects = await deps.prisma.externalEffect.findMany({
    where: {
      spaceId: thread.spaceId,
      status: "completed",
      createdAt: { gte: new Date(now - MAX_WAIT_MS) },
      run: { threadId: thread.id, userId: thread.userId },
      OR: [["2", "route"], ["3"]].map((path) => ({
        request: { path: [...path, "toolName"], equals: "agent_run" },
      })),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true },
  });
  const latest = effects.find(
    (effect) => mcpObject(providerResult(effect.result))?.id === payload.agentRunId,
  );
  if (!latest) return skipped("no answer");
  if (!runningAgentRunId(providerResult(latest.result))) return skipped("finished");
  // One wake per provider answer: a wake that ends without asking again is the agent's choice.
  const clientNonce = `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}${payload.agentRunId}:${latest.id}`;
  const runId = await deps.prisma.$transaction(async (tx) => {
    // The thread row serializes this with other automated starts in the conversation.
    const locked = await tx.thread.updateMany({
      where: { id: thread.id, spaceId: thread.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    const [existing, running] = await Promise.all([
      tx.run.findFirst({ where: { spaceId: thread.spaceId, clientNonce }, select: { id: true } }),
      tx.run.findFirst({
        where: { threadId: thread.id, status: { in: BUSY_STATUSES } },
        select: { id: true },
      }),
    ]);
    if (existing) return null;
    if (running) return "busy";
    const task = await tx.task.create({
      data: {
        spaceId: thread.spaceId,
        botId: payload.botId,
        threadId: thread.id,
        userId: thread.userId,
        prompt: recruitingAgentRunWaitPrompt(payload.agentRunId),
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: thread.spaceId,
        botId: payload.botId,
        threadId: thread.id,
        userId: thread.userId,
        taskId: task.id,
        status: "queued",
        trigger: "recruiting_research" satisfies RunTrigger,
        clientNonce,
      },
    });
    return run.id;
  });
  if (runId === "busy") {
    // The open turn may collect the run itself; look again once it ends.
    await deps.jobs.enqueue(
      recruitingAgentRunWaitJob(payload, new Date(now + RECRUITING_AGENT_RUN_WAIT_MS)),
    );
    return skipped("busy");
  }
  if (!runId) return skipped("already woken");
  getLogger().info("recruiting.agent_run_wait.woken", { ...payload, runId });
  // The existing run reconciler recovers a queued run after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(runId)).catch(() => {
    getLogger().warn("recruiting agent run wake deferred to reconciliation");
  });
}
