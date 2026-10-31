import type { WorkEstimate, WorkEstimateKind } from "@rakazo/core";
import { estimateWorkMs, peopleNamedIn, workCountdownsElapsed } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { COMPLETION_EMAIL_TOOL } from "./completion-email.js";
import { mcpObject } from "./recruiting-research.js";

/**
 * A big search or contact lookup gets a countdown the recruiter sees (Workloop's wait clock).
 * The estimate is one effect row per piece of work, started the first time the work is seen
 * still going; its age is the countdown's start. Nothing is sent and nothing is spent.
 */
export const WORK_ESTIMATE_KIND = "work_estimate";
/** Work nobody finished after this long is not shown any more. */
const MAX_AGE_MS = 12 * 60 * 60_000;
const BUSY = ["queued", "leased", "running"];

type Turn = { id: string; spaceId: string; threadId: string };
type Request = {
  threadId: string;
  kind: WorkEstimateKind;
  people: number;
  estimateMs: number | null;
};

const key = (ref: string) => `${WORK_ESTIMATE_KIND}:${ref}`;

/** Start the countdown for one piece of work; returns it only the first time. */
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
  const request: Request = {
    threadId: run.threadId,
    kind: work.kind,
    people: work.people,
    estimateMs: estimateWorkMs(work.kind, work.people),
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
      },
      select: { createdAt: true },
    })
    .catch(() => null);
  return row
    ? {
        kind: request.kind,
        people: request.people,
        estimateMs: request.estimateMs,
        startedAt: row.createdAt.toISOString(),
      }
    : null;
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
    startedAt: row.createdAt.toISOString(),
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
  return row ? openEstimate(row) : null;
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
      request: true,
      result: true,
      createdAt: true,
      run: { select: { status: true } },
    },
  });
  for (const row of rows) {
    const open = openEstimate(row);
    if (!open || (open.kind === "emails" && !BUSY.includes(row.run.status))) continue;
    const { id: _id, reported: _reported, ...estimate } = open;
    return estimate;
  }
  return null;
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

/**
 * A target bigger than what is public (every student of a school) is said up front and again
 * at the end, the way the people-search provider explains its own shortfalls.
 */
export const SHORTFALL_RULE =
  "If the target is probably more people than have public profiles (for example every current student of a school), say so in the same line: give the published total if you know it and why not all can be found (no public roster, many people have no public profile). When the search ends short, say how many were found, how many are confirmed and how many only possible, and that the list is partial; do not keep starting waves without saying so.";

/** What the agent hears once when a big piece of work starts its countdown. */
export function workStartNote(kind: WorkEstimateKind, estimateMs: number): string {
  const what = kind === "search" ? "search" : "contact lookup";
  return [
    `This is a big ${what}: about ${minutes(estimateMs)} minutes. The recruiter sees a countdown.`,
    `Tell them in one line that it takes about ${minutes(estimateMs)} minutes and they can keep chatting or leave; you report when the time is up.`,
    `If you have ${COMPLETION_EMAIL_TOOL} and they were not asked yet in this conversation, offer the email when it finishes.`,
    ...(kind === "search" ? [SHORTFALL_RULE] : []),
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
  args: Record<string, unknown> | undefined,
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
      people: peopleNamedIn(args?.query),
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
  return `The estimated ${minutes(estimate.estimateMs)} minutes for this lookup are up and the recruiter's countdown started over: tell them in one line how many people are looked up and how many emails were found so far, then keep going without asking.`;
}

/** The note rides along with the tool's own result. */
export function withWorkNote(result: unknown, note: string): unknown {
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), countdown: note }
    : { result, countdown: note };
}
