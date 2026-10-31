import type {
  AgentHomeStore,
  AgentRuntime,
  BackgroundJobHandlers,
  ConnectorProvider,
  JobPublisher,
  MessagingSurface,
  NotificationProvider,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import { sendRunNotification } from "./executor.js";
import { reportStalledGroupStage } from "./group-handoff.js";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { waitForRecruitingAgentRun } from "./recruiting-agent-run-wait.js";
import { startRecruitingCheckin } from "./recruiting-checkin.js";
import { startRecruitingGrading } from "./recruiting-grading.js";
import { pollRecruitingResearch } from "./recruiting-research-poll.js";
import { checkThreadReplied } from "./reply-check.js";
import {
  pauseRoutineAfterRepeatedFailures,
  skipRoutineWithoutNewActivity,
} from "./routine-precondition.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

/**
 * Run triggers with no conversation behind them. A handoff (bot_message) or research result is
 * part of a conversation someone is following, so it is not limited here.
 */
const SCHEDULED_TRIGGERS = ["routine", "webhook", "tickets", "cloud_agent"];
/** How long a scheduled run waits before trying for a slot again. */
const SCHEDULED_RUN_RETRY_MS = 5_000;

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: SecretStore;
  memoryProviders: MemoryProviderResolver;
  shutdownSignal: AbortSignal;
  deploymentModelKey?: string;
  deploymentModelConfigured?: boolean;
  messaging?: MessagingSurface;
  notifications?: NotificationProvider;
  cloudAgent?: CloudAgentConnection | null;
  /** The native MCP connector; without it research tasks are not polled in the background. */
  connector?: ConnectorProvider;
  /**
   * Most worker slots scheduled runs may hold at once in this process, so a burst of routines
   * cannot take every slot from people chatting. Unset means no limit.
   */
  scheduledRunSlots?: number;
}): BackgroundJobHandlers {
  let scheduledRunsActive = 0;
  const isScheduledRun = async (runId: string) =>
    (await deps.prisma.run.count({
      where: { id: runId, trigger: { in: SCHEDULED_TRIGGERS } },
    })) > 0;
  const deliverMessaging = async (runId?: string) => {
    if (!deps.messaging) return;
    await deliverMessagingOutbound(
      { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
      { runId },
      {
        operationId: `messaging.deliver:${runId ?? "drain"}`,
        traceId: `messaging.deliver:${runId ?? "drain"}`,
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  };

  return {
    "run.continue": async (payload) => {
      const limited = deps.scheduledRunSlots !== undefined && (await isScheduledRun(payload.runId));
      if (limited && scheduledRunsActive >= deps.scheduledRunSlots!) {
        getLogger().info("run.scheduled.deferred", {
          runId: payload.runId,
          active: scheduledRunsActive,
        });
        await deps.jobs.enqueue({
          ...runContinueJob(payload.runId),
          availableAt: new Date(Date.now() + SCHEDULED_RUN_RETRY_MS),
        });
        return;
      }
      if (limited) scheduledRunsActive++;
      try {
        await deps.executor.continueRun(payload.runId, deps.workerId);
      } finally {
        if (limited) scheduledRunsActive--;
      }
      // A routine whose last five runs all failed stops firing; never let this fail the run.
      await pauseRoutineAfterRepeatedFailures(deps, payload.runId).catch((error) => {
        getLogger().error("routine failure pause error", error);
      });
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
    },
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "routine.wakeup": async (payload) => {
      // A routine with a `precondition:` line wakes the model only when something changed.
      if (await skipRoutineWithoutNewActivity(deps, payload)) return;
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "cloud_agent.poll": async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
        },
        payload,
      );
    },
    "recruiting_research.poll": async (payload) => {
      await pollRecruitingResearch(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          connector: deps.connector,
          onStalled: (run) => reportStalledGroupStage(deps, run),
        },
        payload,
      );
    },
    "recruiting_grade.start": async (payload) => {
      await startRecruitingGrading({ prisma: deps.prisma, jobs: deps.jobs }, payload);
    },
    "recruiting_agent_run.wait": async (payload) => {
      await waitForRecruitingAgentRun({ prisma: deps.prisma, jobs: deps.jobs }, payload);
    },
    "notification.retry": async (payload) => {
      if (!deps.notifications) return;
      const run = await deps.prisma.run.findUnique({
        where: { id: payload.runId },
        select: { id: true, spaceId: true, userId: true, botId: true, threadId: true },
      });
      // The message must belong to the run's own conversation; anything else is dropped.
      if (!run || run.threadId !== payload.message.threadId) return;
      // Throwing hands the retry back to the queue's backoff.
      await sendRunNotification(deps.notifications, run, payload.message);
    },
    "thread.reply_check": async (payload) => {
      await checkThreadReplied(
        { prisma: deps.prisma, events: deps.events, jobs: deps.jobs },
        payload,
      );
    },
    "recruiting_checkin.start": async (payload) => {
      await startRecruitingCheckin(
        { prisma: deps.prisma, jobs: deps.jobs, connector: deps.connector },
        payload,
      );
    },
    "history.compact": async (payload) => {
      // New automatic summaries carry a validated origin; do not revive unattributed legacy work.
      if (!payload.sourceRunId && deps.executor.contextStrategy !== "current") return;
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          deploymentModelConfigured: deps.deploymentModelConfigured,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
        payload.sourceRunId,
      );
    },
  };
}
