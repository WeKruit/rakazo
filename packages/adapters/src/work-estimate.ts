import type { WorkEstimate, WorkEstimateKind } from "@rakazo/core";
import {
  estimateWorkMs,
  WORK_DEFAULT_PEOPLE,
  workCountdownLeftMs,
  workCountdownsElapsed,
} from "@rakazo/core";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";

/**
 * A big search or contact lookup gets a countdown the recruiter sees (Workloop's wait clock).
 * The estimate is one effect row per piece of work, started the first time the work is seen
 * still going; its age is the countdown's start. Nothing is sent and nothing is spent.
 */
export const WORK_ESTIMATE_KIND = "work_estimate";
/** Work nobody finished after this long is not shown any more. */
const MAX_AGE_MS = 12 * 60 * 60_000;
const BUSY = ["queued", "leased", "running"];
/** A new wave of the same search within this long continues its countdown. */
const SAME_ASK_MS = 60 * 60_000;

type Turn = { id: string; spaceId: string; threadId: string };
type Request = {
  threadId: string;
  kind: WorkEstimateKind;
  people: number;
  estimateMs: number | null;
  /** A search's role and how many people its Results held when the search started. */
  roleId?: string;
  saved?: number;
  /** When the countdown started, for a search that continues an earlier one. */
  since?: string;
};

const key = (ref: string) => `${WORK_ESTIMATE_KIND}:${ref}`;

/**
 * Start the countdown for one piece of work; returns it only the first time. A search that
 * continues the same ask (same role, same Results target) keeps the countdown already running.
 */
export async function startWorkEstimate(
  prisma: PrismaClient,
  run: Turn,
  work: { ref: string; kind: WorkEstimateKind; people: number },
): Promise<WorkEstimate | null> {
  const existing = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: key(work.ref) },
    select: { id: true },
  });
  if (existing) return null;
  const saved =
    work.kind === "search" ? await savedSoFar(prisma, run.threadId).catch(() => ({})) : {};
  const earlier = await sameAsk(prisma, run, saved, work.people).catch(() => null);
  const request: Request = earlier?.request ?? {
    threadId: run.threadId,
    kind: work.kind,
    people: work.people,
    estimateMs: estimateWorkMs(work.kind, work.people),
    ...saved,
  };
  const row = await prisma.externalEffect
    .create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: WORK_ESTIMATE_KIND,
        idempotencyKey: key(work.ref),
        status: "running",
        request,
        ...(earlier ? { result: { reported: earlier.reported } } : {}),
      },
      select: { createdAt: true },
    })
    .catch(() => null);
  if (!row || earlier) return null;
  return {
    kind: request.kind,
    people: request.people,
    estimateMs: request.estimateMs,
    startedAt: row.createdAt.toISOString(),
  };
}

/**
 * The countdown of an earlier search for the same ask in this conversation: a new wave toward
 * the same Results target, with no new message from the recruiter since, continues it instead
 * of starting over; the earlier one stops counting so each run-out countdown is reported once.
 */
async function sameAsk(
  prisma: PrismaClient,
  run: Turn,
  saved: { roleId?: string; saved?: number },
  people: number,
): Promise<{ request: Request; reported: number } | null> {
  if (!saved.roleId || saved.saved === undefined) return null;
  // A new message from the recruiter is a new ask with its own countdown.
  const asked = await prisma.message.findFirst({
    where: { threadId: run.threadId, role: "user" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const since = Math.max(Date.now() - SAME_ASK_MS, asked?.createdAt.getTime() ?? 0);
  const rows = await prisma.externalEffect.findMany({
    where: {
      kind: WORK_ESTIMATE_KIND,
      spaceId: run.spaceId,
      status: { in: ["running", "done"] },
      createdAt: { gte: new Date(since) },
      run: { threadId: run.threadId },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, request: true, result: true, createdAt: true },
  });
  for (const row of rows) {
    const request = row.request as Partial<Request> | null;
    if (request?.kind !== "search" || request.roleId !== saved.roleId) continue;
    if (typeof request.saved !== "number") continue;
    // Still short of the earlier target, and this wave stays within it.
    const target = request.saved + (Number(request.people) || 0);
    if (saved.saved >= target || saved.saved + people > target) continue;
    await prisma.externalEffect.updateMany({
      where: { id: row.id, status: "running" },
      data: { status: "done" },
    });
    const open = openEstimate(row);
    return {
      request: { ...(request as Request), since: open?.startedAt },
      reported: open?.reported ?? 0,
    };
  }
  return null;
}

/** Whether the recruiter stopped this work; a stopped search is not followed any more. */
export async function workEstimateCancelled(prisma: PrismaClient, spaceId: string, ref: string) {
  const row = await prisma.externalEffect.findFirst({
    where: { idempotencyKey: key(ref), spaceId, status: "cancelled" },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Searches still running at the provider, for the reconciler to re-arm their follow-up: a
 * follow-up chain that broke (a worker restart, a lost job) would otherwise leave the countdown
 * running with nobody checking when it ends.
 */
export async function runningSearchEstimates(
  prisma: PrismaClient,
  now: Date,
  batchSize: number,
): Promise<Array<{ threadId: string; botId: string; agentRunId: string }>> {
  const rows = await prisma.externalEffect.findMany({
    where: {
      kind: WORK_ESTIMATE_KIND,
      status: "running",
      createdAt: { gte: new Date(now.getTime() - MAX_AGE_MS) },
      idempotencyKey: { startsWith: `${WORK_ESTIMATE_KIND}:agent_run_` },
    },
    orderBy: { createdAt: "desc" },
    take: batchSize,
    select: { idempotencyKey: true, run: { select: { threadId: true, botId: true } } },
  });
  return rows.map((row) => ({
    threadId: row.run.threadId,
    botId: row.run.botId,
    agentRunId: row.idempotencyKey.slice(WORK_ESTIMATE_KIND.length + 1),
  }));
}

/** The role a search fills and its Results count now, so the countdown can end at the target. */
async function savedSoFar(prisma: PrismaClient, threadId: string) {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { activeRecruitingRoleId: true },
  });
  const roleId = thread?.activeRecruitingRoleId;
  if (!roleId) return {};
  return { roleId, saved: await prisma.recruitingCandidate.count({ where: { roleId } }) };
}

/**
 * A search whose Results already hold the people asked for is done, even when the provider is
 * still working: the recruiter got what they asked for and the countdown ends.
 */
async function reachedTarget(prisma: PrismaClient, row: { request: unknown }) {
  const request = row.request as Partial<Request> | null;
  if (request?.kind !== "search" || !request.roleId || typeof request.saved !== "number")
    return false;
  const target = request.saved + (Number(request.people) || 0);
  return (await prisma.recruitingCandidate.count({ where: { roleId: request.roleId } })) >= target;
}

async function finishReached(prisma: PrismaClient, row: { id: string; request: unknown }) {
  if (!(await reachedTarget(prisma, row).catch(() => false))) return false;
  await prisma.externalEffect.updateMany({
    where: { id: row.id, status: "running" },
    data: { status: "done" },
  });
  return true;
}

export async function finishWorkEstimate(prisma: PrismaClient, spaceId: string, ref: string) {
  await prisma.externalEffect.updateMany({
    where: { idempotencyKey: key(ref), spaceId, status: "running" },
    data: { status: "done" },
  });
}

type Open = WorkEstimate & { id: string; reported: number };

function openEstimate(row: {
  id: string;
  request: unknown;
  result: unknown;
  createdAt: Date;
}): Open | null {
  const request = row.request as Partial<Request> | null;
  if (request?.kind !== "search" && request?.kind !== "emails") return null;
  const reported = Number((row.result as { reported?: unknown } | null)?.reported);
  return {
    id: row.id,
    kind: request.kind,
    people: Number(request.people) || 0,
    estimateMs: typeof request.estimateMs === "number" ? request.estimateMs : null,
    startedAt:
      typeof request.since === "string" && !Number.isNaN(Date.parse(request.since))
        ? request.since
        : row.createdAt.toISOString(),
    reported: Number.isFinite(reported) ? reported : 0,
  };
}

/** The estimate for one piece of work while it is still going. */
export async function readWorkEstimate(
  prisma: PrismaClient,
  spaceId: string,
  ref: string,
): Promise<Open | null> {
  const row = await prisma.externalEffect.findFirst({
    where: { idempotencyKey: key(ref), spaceId, status: "running" },
    select: { id: true, request: true, result: true, createdAt: true },
  });
  if (!row || (await finishReached(prisma, row))) return null;
  return openEstimate(row);
}

/**
 * The work in this conversation the recruiter is waiting on, newest first. A contact lookup
 * runs inside one turn, so it shows only while that turn is going.
 */
export async function currentWorkEstimate(
  prisma: PrismaClient,
  thread: { spaceId: string; threadId: string },
  now = Date.now(),
): Promise<WorkEstimate | null> {
  const open = await currentOpenEstimate(prisma, thread, now);
  if (!open) return null;
  const { id: _id, reported: _reported, ...estimate } = open;
  return estimate;
}

async function currentOpenEstimate(
  prisma: PrismaClient,
  thread: { spaceId: string; threadId: string },
  now: number,
): Promise<Open | null> {
  const rows = await prisma.externalEffect.findMany({
    where: {
      kind: WORK_ESTIMATE_KIND,
      status: "running",
      spaceId: thread.spaceId,
      createdAt: { gte: new Date(now - MAX_AGE_MS) },
      run: { threadId: thread.threadId },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      idempotencyKey: true,
      request: true,
      result: true,
      createdAt: true,
      run: { select: { status: true } },
    },
  });
  for (const row of rows) {
    const open = openEstimate(row);
    if (!open || (open.kind === "emails" && !BUSY.includes(row.run.status))) continue;
    if (await finishReached(prisma, row)) continue;
    return open;
  }
  return null;
}

/**
 * Waiting on background work lasts until the recruiter's countdown runs out, never longer, like
 * Workloop's wait: the agent then reports progress and waits again. Without a countdown the
 * requested wait stands.
 */
export async function waitWithCountdown<T extends { timedOut: boolean }>(
  prisma: PrismaClient,
  thread: { spaceId: string; threadId: string },
  requestedSeconds: number | undefined,
  wait: (timeoutSeconds: number | undefined) => Promise<T>,
  clock: () => number = Date.now,
): Promise<T | (T & { countdown: string })> {
  const open = await currentOpenEstimate(prisma, thread, clock()).catch(() => null);
  const left = open ? workCountdownLeftMs(open, clock()) : null;
  if (!open?.estimateMs || left === null) return wait(requestedSeconds);
  // A couple of seconds past the end, so the run-out countdown is counted as elapsed.
  const untilEnd = Math.ceil(left / 1000) + 2;
  const capped = requestedSeconds === undefined || untilEnd <= requestedSeconds;
  const result = await wait(capped ? untilEnd : requestedSeconds);
  if (!result.timedOut || !capped) return result;
  const due = countdownReportDue(open, clock());
  if (!due) return result;
  await markCountdownReported(prisma, open.id, due).catch(() => undefined);
  const more = minutes(open.estimateMs);
  return {
    ...result,
    countdown: `The recruiter's countdown of about ${more} minutes ran out and started over; the work is still going.`,
  };
}

/** Countdowns run out since the last report, or null when none is owed. */
export function countdownReportDue(estimate: Open, now = Date.now()): number | null {
  const elapsed = workCountdownsElapsed(estimate, now);
  return elapsed > estimate.reported ? elapsed : null;
}

/** Each run-out countdown is reported once. */
export async function markCountdownReported(prisma: PrismaClient, id: string, elapsed: number) {
  await prisma.externalEffect.updateMany({
    where: { id, status: "running" },
    data: { result: { reported: elapsed } },
  });
}

export function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

const STILL_RUNNING = new Set(["running", "pending", "queued", "in_progress"]);

/** What the agent hears once when a big piece of work starts its countdown. */
export function workStartNote(kind: WorkEstimateKind, estimateMs: number): string {
  const what = kind === "search" ? "search" : "contact lookup";
  return [
    `This is a big ${what}: about ${minutes(estimateMs)} minutes. The recruiter sees a countdown.`,
  ].join(" ");
}

/**
 * After an agent_run call: a run still going starts its countdown (its note is returned the
 * first time, only for a big search); a finished run ends it.
 */
export async function workEstimateAfterAgentRun(
  prisma: PrismaClient,
  run: Turn,
  result: unknown,
): Promise<string | null> {
  try {
    const body = mcpObject(result);
    const id = body?.id;
    if (typeof id !== "string" || !id.startsWith("agent_run_")) return null;
    if (typeof body?.status !== "string" || !STILL_RUNNING.has(body.status)) {
      await finishWorkEstimate(prisma, run.spaceId, id);
      return null;
    }
    const started = await startWorkEstimate(prisma, run, {
      ref: id,
      kind: "search",
      people: WORK_DEFAULT_PEOPLE,
    });
    return started?.estimateMs ? workStartNote("search", started.estimateMs) : null;
  } catch {
    return null;
  }
}

/** A contact lookup whose countdown ran out: the agent reports progress before going on. */
export async function contactLookupCountdownNote(
  prisma: PrismaClient,
  run: Turn,
  now = Date.now(),
): Promise<string | null> {
  const estimate = await readWorkEstimate(prisma, run.spaceId, `emails:${run.id}`);
  const due = estimate?.estimateMs ? countdownReportDue(estimate, now) : null;
  if (!estimate?.estimateMs || !due) return null;
  await markCountdownReported(prisma, estimate.id, due);
  return `The estimated ${minutes(estimate.estimateMs)} minutes for this lookup are up and the recruiter's countdown started over; the lookup is still going.`;
}

/** The note rides along with the tool's own result. */
export function withWorkNote(result: unknown, note: string): unknown {
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), countdown: note }
    : { result, countdown: note };
}
