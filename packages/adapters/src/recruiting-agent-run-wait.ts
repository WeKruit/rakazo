import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import { recruitingAgentRunWaitJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX, submitConversationInput } from "@rakazo/db";
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
 * orchestrator: each wake is one follow-up in its session whose agent_run call either collects the
 * people (saved to Results as usual) or, still running, schedules the next wake.
 */
export { RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX };
/** A turn that is still open may collect the run itself, so the first wake waits a minute. */
export const RECRUITING_AGENT_RUN_WAIT_MS = 60_000;
/** Runs nobody has collected after this long since they started are left alone. */
const MAX_WAIT_MS = 12 * 60 * 60_000;
/** A wake waits until the recruiter has not written for this long. */
const QUIET_MS = 5 * 60_000;
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
  // Facts only, like a background-task notification: what to do with it is the skill's.
  return [
    `Your people-search agent run ${agentRunId} is still working at the provider. Nobody asked for this message: it is a notice about your own work. The people it returns are saved to Results automatically. An empty reply posts nothing.`,
    countdown
      ? `The search's estimated ${minutes(countdown.estimateMs)} minutes are up and the recruiter's countdown has started over.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "enqueue">;
    events: Pick<ThreadEvents, "wakeSessions">;
  },
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
  // When the recruiter's countdown runs out, this wake reports progress instead of staying quiet.
  const estimate = await readWorkEstimate(deps.prisma, thread.spaceId, payload.agentRunId);
  const due = estimate?.estimateMs ? countdownReportDue(estimate, now) : null;
  // The recruiter's own conversation comes first: a quiet check-in waits while they are writing.
  // A run-out countdown is reported anyway; it is what the recruiter is waiting for.
  const talking =
    !due &&
    (await deps.prisma.message.findFirst({
      where: { threadId: thread.id, role: "user", createdAt: { gte: new Date(now - QUIET_MS) } },
      select: { id: true },
    }));
  if (talking) {
    await deps.jobs.enqueue(
      recruitingAgentRunWaitJob(payload, new Date(now + RECRUITING_AGENT_RUN_WAIT_MS)),
    );
    return skipped("recruiter active");
  }
  // One wake per provider answer: a wake that ends without asking again is the agent's choice.
  const wakeKey = `${RECRUITING_AGENT_RUN_WAIT_NONCE_PREFIX}${payload.agentRunId}:${latest.id}`;
  const sessionId = await deps.prisma.$transaction(async (tx) => {
    // The thread row serializes this with other automated starts in the conversation.
    const locked = await tx.thread.updateMany({
      where: { id: thread.id, spaceId: thread.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    const [earlierInput, earlierRun] = await Promise.all([
      tx.sessionInput.findFirst({
        where: {
          session: { threadId: thread.id, botId: payload.botId },
          payload: { path: ["wakeKey"], equals: wakeKey },
        },
        select: { id: true },
      }),
      // A wake started on the run harness before the upgrade.
      tx.run.findFirst({
        where: {
          spaceId: thread.spaceId,
          clientNonce: { startsWith: wakeKey },
          status: { not: "cancelled" },
        },
        select: { id: true },
      }),
    ]);
    if (earlierInput || earlierRun) return null;
    // A follow-up: it waits for the turn in progress, which may collect the run itself.
    const submitted = await submitConversationInput(
      tx,
      { spaceId: thread.spaceId, userId: thread.userId, threadId: thread.id, botId: payload.botId },
      {
        kind: "followUp",
        trigger: "recruiting_research" satisfies RunTrigger,
        payload: {
          text: recruitingAgentRunWaitPrompt(
            payload.agentRunId,
            due && estimate?.estimateMs ? { estimateMs: estimate.estimateMs } : undefined,
          ),
          internal: true,
          wakeKey,
        },
      },
    );
    return submitted.sessionId;
  });
  if (!sessionId) return skipped("already woken");
  if (due && estimate) await markCountdownReported(deps.prisma, estimate.id, due);
  getLogger().info("recruiting.agent_run_wait.woken", { ...payload, sessionId });
  // The session sweep drives a session whose input was not taken after a lost wake.
  await deps.events.wakeSessions([sessionId]);
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
