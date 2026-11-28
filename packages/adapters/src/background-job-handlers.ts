import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  BackgroundJobHandlers,
  ConnectorProvider,
  JobPublisher,
  MessagingSurface,
  NotificationProvider,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sendRunNotification } from "./agent-session/run-projection.js";
import { cutoverToSessions } from "./agent-session/session-cutover.js";
import type { DriveSession } from "./agent-session/session-driver.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import { warmBotDiscovery } from "./discovery-prewarm.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { closePollAndWake } from "./poll-close.js";
import { waitForRecruitingAgentRun } from "./recruiting-agent-run-wait.js";
import { startRecruitingCheckin } from "./recruiting-checkin.js";
import { projectRecruitingCandidateProfiles } from "./recruiting-profiles.js";
import { projectRecruitingInboxJob } from "./recruiting-reads.js";
import {
  pauseRoutineAfterRepeatedFailures,
  skipRoutineWithoutNewActivity,
} from "./routine-precondition.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

/**
 * Run triggers with no conversation behind them. A handoff (bot_message) or research result is
 * part of a conversation someone is following, so it is not limited here.
 */

/**
 * After a session run's terminal row is written: a routine whose last five runs all failed stops
 * firing, and the run's bot messages are mirrored to the messaging outbox.
 */
export async function afterSessionRun(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
    messaging?: MessagingSurface;
  },
  runId: string,
): Promise<void> {
  await pauseRoutineAfterRepeatedFailures(deps, runId).catch((error) => {
    getLogger().error("routine failure pause error", error);
  });
  if (!deps.messaging) return;
  const messaging = {
    prisma: deps.prisma,
    messaging: deps.messaging,
    events: deps.events,
    jobs: deps.jobs,
  };
  await mirrorMessagingOutbound(messaging, runId);
  await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
    getLogger().error("messaging.deliver enqueue error", error);
    await deliverMessagingOutbound(
      messaging,
      { runId: undefined },
      {
        operationId: "messaging.deliver:drain",
        traceId: "messaging.deliver:drain",
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  });
}

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
  /** Saved files; a reply's attachments read in the background are kept here. */
  artifacts?: ArtifactStore;
  /** Owns one session until it is idle (plan Task 4 `runSessionHost`, deps bound). */
  driveSession: DriveSession;
  /** Aborted when the worker drains: each owned session quiesces and releases its lease. */
  sessionHostSignal: AbortSignal;
}): BackgroundJobHandlers {
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
    "recruiting_inbox.project": async (payload) => {
      await projectRecruitingInboxJob({ prisma: deps.prisma, events: deps.events }, payload);
    },
    "recruiting_profile.project": async (payload) => {
      await projectRecruitingCandidateProfiles(
        { prisma: deps.prisma, events: deps.events },
        payload,
      );
    },
    "recruiting_agent_run.wait": async (payload) => {
      await waitForRecruitingAgentRun(
        { prisma: deps.prisma, jobs: deps.jobs, events: deps.events },
        payload,
      );
    },
    "session.drive": async (payload) => {
      // Returns when the session is idle and released, or when another worker owns it (that
      // owner hears the notify). A deploy drain aborts the signal: the live turn may finish first.
      await deps.driveSession(payload.sessionId, deps.sessionHostSignal);
    },
    "session.cutover": async () => {
      await cutoverToSessions({ prisma: deps.prisma, events: deps.events });
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
    "discovery.warm": async (payload) => {
      if (deps.connector) await warmBotDiscovery(deps.prisma, deps.connector, payload.botId);
    },
    "poll.close": async (payload) => {
      await closePollAndWake({ prisma: deps.prisma, events: deps.events }, payload);
    },
    // Retired: checks already queued before the upgrade finish without pushing the agent.
    "thread.reply_check": async () => {},
    "recruiting_checkin.start": async (payload) => {
      await startRecruitingCheckin(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          connector: deps.connector,
          artifacts: deps.artifacts,
        },
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
