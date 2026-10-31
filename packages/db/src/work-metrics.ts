import type { WorkMetrics } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { AUTOMATION_RATE_LIMITED_ERROR } from "./automation-rate.js";
import { STOPPED_TURN } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

type MetricsDb = Pick<PrismaClient, "$queryRaw">;

const DAY_MS = 86_400_000;
/** A person's message still without any reply after this long counts as unanswered. */
const UNANSWERED_AFTER_MS = 10 * 60_000;
/** How long after a compaction a person's correction is attributed to it. */
const CORRECTION_WINDOW = "24 hours";
/**
 * A person repeating a constraint the agent should already know. Deliberately narrow: it
 * undercounts rather than flags ordinary feedback as a memory failure.
 */
const CORRECTION_PATTERN =
  "(我(之前|刚才|已经|早就)?(说|讲|提)过|不是说(了|过)|(跟|和)你说过|你(又)?忘了|I (already )?(said|told you|mentioned)|as I said|you forgot)";

type Percentiles = { count: number; p50: number | null; p95: number | null };

function latency(row: Percentiles | undefined) {
  return {
    count: row?.count ?? 0,
    p50Ms: row?.p50 == null ? null : Math.round(row.p50),
    p95Ms: row?.p95 == null ? null : Math.round(row.p95),
  };
}

const PERCENTILES = (ms: Prisma.Sql) => Prisma.sql`
  COUNT(${ms})::int AS "count",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ms}) AS "p50",
  percentile_cont(0.95) WITHIN GROUP (ORDER BY ${ms}) AS "p95"`;

const ACTIVE = Prisma.join([...ACTIVE_RUN_STATUSES]);

/** Readable stop reason: ids and counts collapse so the same failure groups together. */
function stopReason(status: string, error: string | null) {
  if (status === "cancelled" && (error === null || error === STOPPED_TURN)) return "Stopped";
  if (!error) return status === "failed" ? "No error recorded" : "Cancelled";
  return error.length > 120 ? `${error.slice(0, 119)}…` : error;
}

/**
 * Workloop's §6 metrics over every account, computed from runs, messages, events and usage
 * rows that already exist. Authorization is the caller's: only operators may read this. The
 * queries run one after another so the page never holds more than one pooled connection.
 */
export async function summarizeWorkMetrics(
  prisma: MetricsDb,
  options: { now?: Date; windowDays?: number; weeks?: number } = {},
): Promise<WorkMetrics> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 28;
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const weeksSince = new Date(now.getTime() - (options.weeks ?? 8) * 7 * DAY_MS);
  const answeredBy = new Date(now.getTime() - UNANSWERED_AFTER_MS);

  const weeks = await prisma.$queryRaw<{ week: string; tasks: number; unrescued: number }[]>`
    SELECT to_char(date_trunc('week', t."createdAt"), 'YYYY-MM-DD') AS "week",
      COUNT(*)::int AS "tasks", COUNT(*) FILTER (WHERE r."ok")::int AS "unrescued"
    FROM "tasks" t
    JOIN LATERAL (
      SELECT COUNT(*) > 0 AND bool_and(x."status" = 'completed') AS "ok",
        COALESCE(bool_or(x."status" IN (${ACTIVE})), false) AS "active"
      FROM "runs" x WHERE x."taskId" = t."id"
    ) r ON TRUE
    WHERE t."createdAt" >= ${weeksSince} AND t."createdAt" < ${now} AND NOT r."active"
    GROUP BY 1 ORDER BY 1`;

  const statuses = await prisma.$queryRaw<
    { status: string; error: string | null; count: number }[]
  >`
    SELECT "status", CASE WHEN "status" = 'completed' THEN NULL
        ELSE regexp_replace("error", '[0-9]+', 'N', 'g') END AS "error",
      COUNT(*)::int AS "count"
    FROM "runs"
    WHERE "createdAt" >= ${since} AND "createdAt" < ${now}
      AND "status" IN ('completed', 'failed', 'cancelled')
    GROUP BY 1, 2`;
  const reasons = new Map<string, { status: string; reason: string; count: number }>();
  const completion = { completed: 0, failed: 0, cancelled: 0, stoppedByPerson: 0 };
  for (const row of statuses) {
    if (row.status === "completed") {
      completion.completed += row.count;
      continue;
    }
    if (row.status === "failed") completion.failed += row.count;
    else completion.cancelled += row.count;
    const reason = stopReason(row.status, row.error);
    if (reason === "Stopped") completion.stoppedByPerson += row.count;
    const key = `${row.status}\u0000${reason}`;
    const entry = reasons.get(key) ?? { status: row.status, reason, count: 0 };
    entry.count += row.count;
    reasons.set(key, entry);
  }

  const [runDuration] = await prisma.$queryRaw<Percentiles[]>`
    SELECT ${PERCENTILES(Prisma.sql`EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000`)}
    FROM "runs"
    WHERE "createdAt" >= ${since} AND "createdAt" < ${now} AND "status" = 'completed'
      AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL`;
  const [taskDuration] = await prisma.$queryRaw<Percentiles[]>`
    SELECT ${PERCENTILES(Prisma.sql`d."ms"`)}
    FROM (
      SELECT EXTRACT(EPOCH FROM (MAX(r."completedAt") - MIN(r."createdAt"))) * 1000 AS "ms"
      FROM "tasks" t JOIN "runs" r ON r."taskId" = t."id"
      WHERE t."createdAt" >= ${since} AND t."createdAt" < ${now}
      GROUP BY t."id"
      HAVING bool_and(r."status" = 'completed') AND bool_and(r."completedAt" IS NOT NULL)
    ) d`;
  const [compactions] = await prisma.$queryRaw<{ compactions: number; runs: number }[]>`
    SELECT COUNT(DISTINCT COALESCE("operationId", "id"))::int AS "compactions",
      COUNT(DISTINCT COALESCE("parentRunId", "runId"))::int AS "runs"
    FROM "usage_records"
    WHERE "operationKind" = 'compaction' AND "createdAt" >= ${since} AND "createdAt" < ${now}`;
  const [resumed] = await prisma.$queryRaw<{ count: number; of: number }[]>`
    SELECT COUNT(*) FILTER (WHERE r."status" = 'completed')::int AS "count",
      COUNT(*) FILTER (WHERE r."status" IN ('completed', 'failed', 'cancelled'))::int AS "of"
    FROM "runs" r
    WHERE r."createdAt" >= ${since} AND r."createdAt" < ${now}
      AND EXISTS (SELECT 1 FROM "events" e WHERE e."runId" = r."id" AND e."type" = 'run.requeued')`;

  // A person's message in an agent conversation, and the first agent message after it.
  // External conversations are excluded: their inbound side is not a product user.
  const [inputs] = await prisma.$queryRaw<(Percentiles & { inputs: number; unanswered: number })[]>`
    SELECT COUNT(*)::int AS "inputs", COUNT(*) FILTER (WHERE nb."createdAt" IS NULL)::int AS "unanswered",
      ${PERCENTILES(Prisma.sql`EXTRACT(EPOCH FROM (nb."createdAt" - m."createdAt")) * 1000`)}
    FROM "messages" m
    JOIN "threads" th ON th."id" = m."threadId" AND th."externalConversationId" IS NULL
    LEFT JOIN LATERAL (
      SELECT b."createdAt" FROM "messages" b
      WHERE b."threadId" = m."threadId" AND b."seq" > m."seq" AND b."role" = 'bot'
      ORDER BY b."seq" LIMIT 1
    ) nb ON TRUE
    WHERE m."role" = 'user' AND m."createdAt" >= ${since} AND m."createdAt" < ${answeredBy}`;
  const [interject] = await prisma.$queryRaw<Percentiles[]>`
    SELECT ${PERCENTILES(Prisma.sql`EXTRACT(EPOCH FROM ("claimedAt" - "createdAt")) * 1000`)}
    FROM "steering_messages"
    WHERE "createdAt" >= ${since} AND "createdAt" < ${now} AND "claimedAt" IS NOT NULL`;

  const [corrected] = await prisma.$queryRaw<{ count: number; of: number }[]>`
    WITH c AS (
      SELECT DISTINCT ON (COALESCE(u."operationId", u."id")) r."threadId", u."createdAt"
      FROM "usage_records" u JOIN "runs" r ON r."id" = COALESCE(u."parentRunId", u."runId")
      WHERE u."operationKind" = 'compaction' AND u."createdAt" >= ${since} AND u."createdAt" < ${now}
    )
    SELECT COUNT(*)::int AS "of", COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM "messages" m
      WHERE m."threadId" = c."threadId" AND m."role" = 'user' AND m."createdAt" > c."createdAt"
        AND m."createdAt" < c."createdAt" + ${CORRECTION_WINDOW}::interval
        AND m."blocks"::text ~* ${CORRECTION_PATTERN}
    ))::int AS "count"
    FROM c`;

  const [collaboration] = await prisma.$queryRaw<
    { handoffs: number; turns: number; replied: number }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM "events" e JOIN "runs" h ON h."id" = e."runId"
        WHERE e."type" = 'group.handoff' AND h."createdAt" >= ${since} AND h."createdAt" < ${now}
      ) AS "handoffs",
      COUNT(*)::int AS "turns",
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "messages" m WHERE m."threadId" = r."threadId" AND m."runId" = r."id"
          AND m."role" = 'bot'
      ))::int AS "replied"
    FROM "runs" r
    WHERE r."trigger" = 'bot_message' AND r."status" = 'completed'
      AND r."createdAt" >= ${since} AND r."createdAt" < ${now}`;

  const [automation] = await prisma.$queryRaw<
    { runs: number; limited: number; completed: number; failed: number; skipped: number }[]
  >`
    SELECT COUNT(*)::int AS "runs",
      COUNT(*) FILTER (WHERE r."error" = ${AUTOMATION_RATE_LIMITED_ERROR})::int AS "limited",
      COUNT(*) FILTER (WHERE r."status" = 'completed')::int AS "completed",
      COUNT(*) FILTER (WHERE r."status" = 'failed')::int AS "failed",
      (SELECT COUNT(*)::int FROM "events" e
        WHERE e."spaceId" IN (SELECT DISTINCT "spaceId" FROM "routines")
          AND e."createdAt" >= ${since} AND e."createdAt" < ${now}
          AND e."type" = 'routine.fired' AND e."payload"->>'skipped' = 'true') AS "skipped"
    FROM "runs" r
    WHERE r."trigger" = 'routine' AND r."createdAt" >= ${since} AND r."createdAt" < ${now}`;

  return {
    windowDays,
    since: since.toISOString(),
    unrescuedWeeks: weeks,
    completion: {
      ...completion,
      reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    },
    longTasks: {
      runDuration: latency(runDuration),
      taskDuration: latency(taskDuration),
      compactions: compactions?.compactions ?? 0,
      runsCompacted: compactions?.runs ?? 0,
      resumed: { count: resumed?.count ?? 0, of: resumed?.of ?? 0 },
    },
    experience: {
      firstReply: latency(inputs),
      interject: latency(interject),
      unansweredInputs: inputs?.unanswered ?? 0,
      inputs: inputs?.inputs ?? 0,
    },
    memory: { correctedAfterCompaction: { count: corrected?.count ?? 0, of: corrected?.of ?? 0 } },
    collaboration: {
      handoffs: collaboration?.handoffs ?? 0,
      teammateTurns: collaboration?.turns ?? 0,
      replied: collaboration?.replied ?? 0,
      silent: (collaboration?.turns ?? 0) - (collaboration?.replied ?? 0),
    },
    automation: {
      fired: (automation?.runs ?? 0) + (automation?.skipped ?? 0),
      skipped: (automation?.skipped ?? 0) + (automation?.limited ?? 0),
      completed: automation?.completed ?? 0,
      failed: automation?.failed ?? 0,
    },
  };
}
