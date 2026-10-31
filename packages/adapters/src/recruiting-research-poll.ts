import type {
  AdapterContext,
  BackgroundJobPayloads,
  ConnectorProvider,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { recruitingResearchPollJob, runContinueJob } from "@rakazo/adapter-kit";
import type { RunTrigger } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { STOPPED_TURN } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  NOT_GRADING_TASK,
  RECRUITING_GRADE_NONCE_PREFIX,
  scheduleRecruitingGrading,
} from "./recruiting-grading.js";
import { classifyRecruitingResearchResult, mcpObject } from "./recruiting-research.js";

/** How long a foreground status read waits at the provider before the turn moves on. */
export const RECRUITING_RESEARCH_FOREGROUND_WAIT_SECONDS = 10;
/** Shown to the model when a task is still working after the foreground wait. */
export const RECRUITING_RESEARCH_BACKGROUND_NOTICE =
  "Research continues in the background. Its results are delivered to this conversation automatically when the provider finishes; do not poll status.";
/** Returned with a research request or reply the server now follows in the background. */
export const RECRUITING_RESEARCH_DIRECT_NOTICE =
  "This research continues in the background. People are saved into Results as they come back, and the final results are delivered to this conversation automatically. Do not call get_task again or wait for it in this turn: reply with where it stands and end the turn.";
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
  /** Told once when a task stops being followed before the provider finished it. */
  onStalled?: (run: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
  }) => Promise<void>;
};

/** The wake nonce of the provider round in progress: the latest accepted reply on the task, or the first round. */
async function recruitingResearchRound(
  prisma: Pick<PrismaClient, "externalEffect">,
  spaceId: string,
  task: { id: string; providerTaskId: string; mcpServerId: string },
): Promise<{ nonce: string; repliedAt: Date | null }> {
  // The latest accepted reply on this provider task identifies the round; none means the first.
  const reply = await prisma.externalEffect.findFirst({
    where: {
      spaceId,
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
            { request: { path: [...args, "task_id"], equals: task.providerTaskId } },
          ],
        };
      }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
  return {
    nonce: recruitingResearchWakeNonce(task.id, task.providerTaskId, reply?.id),
    repliedAt: reply?.createdAt ?? null,
  };
}

/**
 * True while a role's research round is still running at the provider: an active task whose
 * current round started within the poll window and has not woken the thread yet. A turn that
 * ends while waiting on it is not a stall; the wake brings the results. `startedBy` narrows it
 * to research one bot started in one conversation, which is whom its wake returns to.
 */
export async function recruitingResearchInFlight(
  prisma: Pick<PrismaClient, "externalEffect" | "recruitingResearchTask"> & {
    run: Pick<PrismaClient["run"], "findFirst">;
  },
  roleId: string,
  now = Date.now(),
  startedBy?: { botId: string; threadId: string },
): Promise<boolean> {
  const tasks = await prisma.recruitingResearchTask.findMany({
    where: {
      roleId,
      state: "active",
      providerTaskId: { not: null },
      // Grading people already in Results is not a search anyone waits on.
      AND: [NOT_GRADING_TASK, ...(startedBy ? [{ createdByRun: startedBy }] : [])],
    },
    select: {
      id: true,
      providerTaskId: true,
      mcpServerId: true,
      createdByRun: { select: { spaceId: true, createdAt: true } },
    },
  });
  const window = RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS * RECRUITING_RESEARCH_POLL_INTERVAL_MS;
  for (const task of tasks) {
    const spaceId = task.createdByRun.spaceId;
    const { nonce, repliedAt } = await recruitingResearchRound(prisma, spaceId, {
      ...task,
      providerTaskId: task.providerTaskId!,
    });
    const startedAt = repliedAt ?? task.createdByRun.createdAt;
    if (now - startedAt.getTime() > window) continue;
    const woken = await prisma.run.findFirst({
      where: { spaceId, clientNonce: nonce },
      select: { id: true },
    });
    if (!woken) return true;
  }
  return false;
}

const AUTUMN_MCP = "https://api.autumn.ai/mcp";

/**
 * A research request or reply sent straight through the provider's tools on a role conversation
 * gets the same background follow-up as a saved research action: the task is recorded on the
 * role and polled, so the agent never waits inside its turn and results reach the conversation
 * (and Results) as they arrive. Best effort: tracking never changes the call's own result.
 */
export async function trackDirectRecruitingResearch(
  deps: { prisma: PrismaClient; jobs?: JobPublisher },
  context: Pick<AdapterContext, "spaceId" | "userId" | "runId">,
  route: { connectorId: string; resourceId?: string; toolName: string } | undefined,
  args: Record<string, unknown>,
  result: unknown,
): Promise<string | null> {
  if (
    !deps.jobs ||
    !context.runId ||
    route?.connectorId !== "mcp" ||
    !route.resourceId ||
    !["research", "reply"].includes(route.toolName)
  )
    return null;
  const create = route.toolName === "research" && args.task_id === undefined;
  if (!create && route.toolName !== "reply") return null;
  const observation = classifyRecruitingResearchResult(result, {
    operation: create ? "create" : "continue",
    ...(create ? {} : { providerTaskId: String(args.task_id ?? "") }),
  });
  const providerTaskId = observation.providerTaskId;
  if (observation.deliveryState !== "accepted" || !providerTaskId) {
    // Why the provider didn't take the request; the code is the provider's own error code.
    getLogger().warn("recruiting.research.not_accepted", {
      runId: context.runId,
      tool: route.toolName,
      deliveryState: observation.deliveryState,
      refusalCode: observation.refusalCode ?? null,
      isError: (result as { isError?: unknown } | null)?.isError === true,
      bodyKeys: Object.keys(mcpObject(result) ?? {}).slice(0, 20),
    });
    return null;
  }
  const scope = { spaceId: context.spaceId, userId: context.userId };
  const source = await deps.prisma.run.findFirst({
    where: { id: context.runId, ...scope },
    select: { threadId: true },
  });
  if (!source) return null;
  const taskId = await deps.prisma.$transaction(async (tx) => {
    // Serialize registration with both Stop scopes: a stopped turn keeps accepted work,
    // while Stop everything cannot be undone by a provider response that arrives later.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} FOR UPDATE`;
    const [server, run] = await Promise.all([
      tx.mcpServer.findFirst({
        where: { id: route.resourceId, ...scope },
        select: { id: true, revision: true, endpoint: true, transport: true },
      }),
      tx.run.findFirst({
        where: {
          id: context.runId,
          ...scope,
          OR: [
            { status: { in: [...ACTIVE_RUN_STATUSES] } },
            { status: "cancelled", error: STOPPED_TURN },
          ],
        },
        select: { id: true, thread: { select: { activeRecruitingRoleId: true } } },
      }),
    ]);
    const roleId = run?.thread.activeRecruitingRoleId;
    if (server?.transport !== "streamable_http" || server.endpoint !== AUTUMN_MCP || !roleId)
      return null;
    const role = await tx.recruitingRole.findFirst({
      where: { id: roleId, ...scope },
      select: { id: true },
    });
    if (!role) return null;
    const identity = { mcpServerId: server.id, serverRevision: server.revision, providerTaskId };
    const task = await tx.recruitingResearchTask.upsert({
      where: { mcpServerId_serverRevision_providerTaskId: identity },
      update: {},
      create: { ...identity, roleId, createdByRunId: run.id },
      select: { id: true, roleId: true, state: true, createdByRunId: true },
    });
    if (task.roleId !== roleId) return null;
    if (task.state === "closed" && task.createdByRunId === run.id) return null;
    if (task.state !== "active")
      await tx.recruitingResearchTask.update({
        where: { id: task.id },
        data: { state: "active" },
      });
    return task.id;
  });
  if (taskId)
    await deps.jobs.enqueue(recruitingResearchPollJob({ taskId }, recruitingResearchPollDelay(0)));
  return taskId;
}

/** New rows at the provider that justify showing them in Results before the research finishes. */
export const RECRUITING_RESEARCH_PARTIAL_STEP = 20;

function progressRows(raw: unknown): number | null {
  const body = mcpObject(raw);
  const progress = body?.progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const rows = (progress as Record<string, unknown>).rows;
  return typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 0 ? rows : null;
}

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
      createdByRunId: true,
      role: { select: { spaceId: true, userId: true } },
      createdByRun: {
        select: { spaceId: true, userId: true, botId: true, threadId: true, clientNonce: true },
      },
    },
  });
  if (task?.state !== "active" || !task.providerTaskId) return;
  const grading = Boolean(task.createdByRun.clientNonce?.startsWith(RECRUITING_GRADE_NONCE_PREFIX));
  const { role, createdByRun: run } = task;
  // The task's role and creating run must agree on one owner; otherwise it is nobody's to wake.
  if (role.spaceId !== run.spaceId || role.userId !== run.userId) return;
  const { providerTaskId } = task;
  const { nonce } = await recruitingResearchRound(deps.prisma, run.spaceId, {
    ...task,
    providerTaskId,
  });
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
  if (observation?.deliveryState === "accepted")
    await recordDirectResearchCredits(deps.prisma, task, observation.usage);
  const terminal = observation?.deliveryState === "accepted" && observation.done === true;
  if (!terminal && !grading && observation?.deliveryState === "accepted") {
    const rows = progressRows(result);
    if (rows !== null) await wakeForPartialRows(deps, task, run, nonce, rows);
  }
  if (!terminal) {
    if (attempt + 1 >= RECRUITING_RESEARCH_POLL_MAX_ATTEMPTS) {
      await deps.onStalled?.(run).catch((error) => {
        getLogger().error("recruiting research stall report", error);
      });
      return;
    }
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
    const [bot, existing, live] = await Promise.all([
      tx.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
        select: { id: true },
      }),
      tx.run.findFirst({
        where: { spaceId: run.spaceId, clientNonce: nonce },
        select: { id: true },
      }),
      // Read under the thread lock: a Stop that closed the task while this probe ran wins.
      tx.recruitingResearchTask.count({ where: { id: task.id, state: "active" } }),
    ]);
    if (!bot || existing || !live) return null;
    // Provider text is untrusted. Wake with local identity and status only.
    const direct = !(await tx.recruitingResearchAction.count({ where: { taskId: task.id } }));
    const summary = grading
      ? `The research service's grades for people already in Results on recruiting role ${task.roleId} are ${state}. Read them with the research provider's get_rows on the same research (task ${providerTaskId}), following each returned cursor, and save every page with recruiting_research save_results. Do not start new research and do not ask anything. Then end the turn.`
      : direct
        ? `Research for recruiting role ${task.roleId} is ${state}. Read the people not saved yet with the research provider's get_rows on the same research (task ${providerTaskId}), following each returned cursor, and save every page with recruiting_research save_results, so all returned people are kept, including unassessed people. Do not start new research. Then report how many new people were added in total and the highlights, and offer the next step in one question card.`
        : `Research task ${task.id} for recruiting role ${task.roleId} is ${state}. Use recruiting_research status, then read and save every rows page with save_results, following each returned cursor, so all returned people are kept, including unassessed people. Do not start new research. Then continue the playbook in this same turn: during calibration, record the ten new people as the round and present them for feedback.`;
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
        // Grades are saved quietly, like the request that asked for them.
        trigger: (grading ? "recruiting_grade" : "recruiting_research") satisfies RunTrigger,
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
  // The next people without a grade follow once this batch's grades are saved.
  if (grading)
    await scheduleRecruitingGrading(deps.jobs, run.threadId).catch((error) =>
      getLogger().warn("recruiting grade schedule", { error: String(error) }),
    );
}

/**
 * Research started directly has no research action, so the ledger trigger on actions never sees
 * its credits. The provider reports a running total; record each increase, as that trigger does.
 */
async function recordDirectResearchCredits(
  prisma: PrismaClient,
  task: {
    id: string;
    roleId: string;
    mcpServerId: string;
    role: { spaceId: string; userId: string };
    createdByRun: { botId: string };
    createdByRunId: string;
  },
  usage: ReturnType<typeof classifyRecruitingResearchResult>["usage"],
): Promise<void> {
  const total = usage?.find((item) => item.unit === "credits" && item.scope === "task")?.amount;
  if (typeof total !== "number") return;
  if (await prisma.recruitingResearchAction.count({ where: { taskId: task.id } })) return;
  const recorded = await prisma.usageRecord.aggregate({
    where: { unit: "credits", operationId: task.id },
    _sum: { quantity: true },
  });
  const increase = total - (recorded._sum.quantity ?? 0);
  if (increase <= 0) return;
  const server = await prisma.mcpServer.findFirst({
    where: { id: task.mcpServerId },
    select: { slug: true },
  });
  await prisma.usageRecord.createMany({
    data: [
      {
        spaceId: task.role.spaceId,
        userId: task.role.userId,
        botId: task.createdByRun.botId,
        runId: task.createdByRunId,
        parentRunId: task.createdByRunId,
        roleId: task.roleId,
        provider: server?.slug ?? "research",
        model: "research",
        unit: "credits",
        quantity: increase,
        usageSource: "provider_receipt",
        callId: `credits:${task.id}:${total}`,
        operationId: task.id,
        operationKind: "retrieval",
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * While a long research is still working, wake the owning conversation each time the provider
 * reports another RECRUITING_RESEARCH_PARTIAL_STEP people, so they are saved into Results now
 * instead of after the whole search. One partial wake runs at a time; the final wake still comes.
 */
async function wakeForPartialRows(
  deps: RecruitingResearchPollDeps,
  task: { id: string; roleId: string; providerTaskId: string | null },
  run: { spaceId: string; userId: string; botId: string; threadId: string },
  nonce: string,
  rows: number,
): Promise<void> {
  const prefix = `${nonce}:rows:`;
  const previous = await deps.prisma.run.findMany({
    where: { spaceId: run.spaceId, clientNonce: { startsWith: prefix } },
    select: { clientNonce: true, status: true },
  });
  if (previous.some((wake) => ["queued", "running"].includes(wake.status))) return;
  const last = Math.max(
    0,
    ...previous.map((wake) => Number(wake.clientNonce?.slice(prefix.length)) || 0),
  );
  if (rows - last < RECRUITING_RESEARCH_PARTIAL_STEP) return;
  const wakeRunId = await deps.prisma.$transaction(async (tx) => {
    const locked = await tx.thread.updateMany({
      where: { id: run.threadId, spaceId: run.spaceId },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!locked.count) return null;
    const [bot, existing, busy, live] = await Promise.all([
      tx.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
        select: { id: true },
      }),
      tx.run.findFirst({
        where: { spaceId: run.spaceId, clientNonce: `${prefix}${rows}` },
        select: { id: true },
      }),
      // Never interleave with a turn already working in this conversation.
      tx.run.findFirst({
        where: { threadId: run.threadId, status: { in: ["queued", "running"] } },
        select: { id: true },
      }),
      tx.recruitingResearchTask.count({ where: { id: task.id, state: "active" } }),
    ]);
    if (!bot || existing || busy || !live) return null;
    const summary = `Research for recruiting role ${task.roleId} is still working and has returned ${rows} people so far. Read the people not saved yet with the research provider's get_rows on the same research (task ${task.providerTaskId}), following each returned cursor, and save every page with recruiting_research save_results so they show in Results now. Do not reply to, restart or wait for the research; the rest arrives on its own. Then say in one short line how many new people were added, and end the turn.`;
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
        trigger: "recruiting_research" satisfies RunTrigger,
        clientNonce: `${prefix}${rows}`,
      },
    });
    return wake.id;
  });
  if (!wakeRunId) return;
  await deps.jobs.enqueue(runContinueJob(wakeRunId)).catch(() => {
    getLogger().warn("recruiting research partial wake deferred to reconciliation");
  });
}
