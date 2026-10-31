import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import { recruitingAgentRunWaitJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { mcpObject } from "./recruiting-research.js";
import {
  countdownReportDue,
  finishWorkEstimate,
  markCountdownReported,
  minutes,
  readWorkEstimate,
  runningSearchEstimates,
  workEstimateCancelled,
} from "./work-estimate.js";

/**
 * A people-search agent run can keep working at the provider for hours, longer than any one
 * turn. When a turn ends with the run still going, the agent that started it is woken in the
 * same conversation to collect it, as often as it takes, until the run finishes. Not a new
 * orchestrator: each wake is one ordinary run whose own agent_run call either collects the
 * people (saved to Results as usual) or, still running, schedules the next wake.
 */
export { RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX };
/** A turn that is still open may collect the run itself, so the first wake waits a minute. */
export const RECRUITING_AGENT_RUN_WAIT_MS = 60_000;
/** Runs nobody has collected after this long since they started are left alone. */
const MAX_WAIT_MS = 12 * 60 * 60_000;
/** A wake waits until the recruiter has not written for this long. */
const QUIET_MS = 5 * 60_000;
/** Wakes for one provider answer that may give way to the recruiter before the next is skipped. */
const MAX_YIELDS = 20;
const BUSY_STATUSES = ["queued", "leased", "running"];
const STILL_RUNNING = new Set(["running", "pending", "queued", "in_progress"]);

/** The agent run a wake was started for, read back from its run nonce. */
export function agentRunWaitTarget(clientNonce: string | null): string | undefined {
  if (!clientNonce?.startsWith(RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX)) return undefined;
  const id = clientNonce.slice(RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX.length).split(":")[0];
  return id?.startsWith("agent_run_") ? id : undefined;
}

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

export function recruitingAgentRunWaitPrompt(
  agentRunId: string,
  countdown?: { estimateMs: number },
): string {
  const quiet = countdown
    ? `The search's estimated ${minutes(countdown.estimateMs)} minutes are up and the recruiter's countdown has started over. Call agent_run with runId "${agentRunId}" once to collect it. The people it returns are saved to Results automatically. If it still reports running, tell the recruiter in one line how many people the role has in Results now and that the search keeps going, about ${minutes(countdown.estimateMs)} more minutes; ask nothing.`
    : `Call agent_run with runId "${agentRunId}" once to collect it. The people it returns are saved to Results automatically. If it still reports running, end the turn with an empty reply: you are woken again later, and the recruiter hears nothing until it finishes.`;
  return [
    `Your people-search agent run ${agentRunId} is still working at the provider. Nobody asked for this message; you are continuing your own work.`,
    quiet,
    "When it has finished, say in one line how many new people were added and whether the role's target is met; if it is short, say why in plain words, as the provider's own summary explains it. Then carry on with the stage as your instructions say: if the role is still short of its target, the next wave continues this run with previousRunId. Start no unrelated search.",
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
  // The recruiter stopped this search: nobody follows it any more.
  if (await workEstimateCancelled(deps.prisma, thread.spaceId, payload.agentRunId))
    return skipped("stopped");
  if (!(await memberOf(deps.prisma, thread, payload.botId))) {
    await finishWorkEstimate(deps.prisma, thread.spaceId, payload.agentRunId);
    return skipped("not a member");
  }
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
  if (!latest) {
    await finishWorkEstimate(deps.prisma, thread.spaceId, payload.agentRunId);
    return skipped("no answer");
  }
  if (!runningAgentRunId(providerResult(latest.result))) {
    await finishWorkEstimate(deps.prisma, thread.spaceId, payload.agentRunId);
    return skipped("finished");
  }
  // The recruiter's own conversation comes first: a wake waits while they are writing.
  const talking = await deps.prisma.message.findFirst({
    where: { threadId: thread.id, role: "user", createdAt: { gte: new Date(now - QUIET_MS) } },
    select: { id: true },
  });
  if (talking) {
    await deps.jobs.enqueue(
      recruitingAgentRunWaitJob(payload, new Date(now + RECRUITING_AGENT_RUN_WAIT_MS)),
    );
    return skipped("recruiter active");
  }
  // One wake per provider answer: a wake that ends without asking again is the agent's choice.
  // A wake that gave way to the recruiter was cancelled before it finished, so it is retried.
  const answerNonce = `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}${payload.agentRunId}:${latest.id}`;
  // When the recruiter's countdown runs out, this wake reports progress instead of staying quiet.
  const estimate = await readWorkEstimate(deps.prisma, thread.spaceId, payload.agentRunId);
  const due = estimate?.estimateMs ? countdownReportDue(estimate, now) : null;
  const runId = await deps.prisma.$transaction(async (tx) => {
    // The thread row serializes this with other automated starts in the conversation.
    const locked = await tx.thread.updateMany({
      where: { id: thread.id, spaceId: thread.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    const [earlier, running] = await Promise.all([
      tx.run.findMany({
        where: { spaceId: thread.spaceId, clientNonce: { startsWith: answerNonce } },
        select: { status: true },
      }),
      tx.run.findFirst({
        where: { threadId: thread.id, status: { in: BUSY_STATUSES } },
        select: { id: true },
      }),
    ]);
    if (earlier.some((run) => run.status !== "cancelled") || earlier.length >= MAX_YIELDS)
      return null;
    if (running) return "busy";
    const clientNonce = earlier.length ? `${answerNonce}:${earlier.length}` : answerNonce;
    const task = await tx.task.create({
      data: {
        spaceId: thread.spaceId,
        botId: payload.botId,
        threadId: thread.id,
        userId: thread.userId,
        prompt: recruitingAgentRunWaitPrompt(
          payload.agentRunId,
          due && estimate?.estimateMs ? { estimateMs: estimate.estimateMs } : undefined,
        ),
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
  if (due && estimate) await markCountdownReported(deps.prisma, estimate.id, due);
  getLogger().info("recruiting.agent_run_wait.woken", { ...payload, runId });
  // The existing run reconciler recovers a queued run after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(runId)).catch(() => {
    getLogger().warn("recruiting agent run wake deferred to reconciliation");
  });
}

/** Re-arms the follow-up of every search still running, from the reconciler. Idempotent. */
export async function rearmRecruitingAgentRunWaits(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  now: Date,
  batchSize: number,
): Promise<number> {
  const waiting = await runningSearchEstimates(deps.prisma, now, batchSize);
  for (const payload of waiting)
    await deps.jobs.enqueue(recruitingAgentRunWaitJob(payload, now)).catch((error) => {
      getLogger().warn("search follow-up not re-armed", { error: String(error) });
    });
  return waiting.length;
}
