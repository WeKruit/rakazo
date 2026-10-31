import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMATION_RATE_LIMITED_ERROR } from "./automation-rate.js";
import { STOPPED_TURN } from "./cancel-runs.js";
import { PrismaClient } from "./client.js";
import { summarizeWorkMetrics } from "./work-metrics.js";

// Temporary synthetic tables shadow product tables. Never inspect existing records.
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;
const now = new Date("2026-03-01T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

postgres("work metrics (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE tasks (id text PRIMARY KEY, "createdAt" timestamp(3));
      CREATE TEMP TABLE runs (id text PRIMARY KEY, "taskId" text, "threadId" text, trigger text,
        status text, error text, "createdAt" timestamp(3), "startedAt" timestamp(3), "completedAt" timestamp(3));
      CREATE TEMP TABLE threads (id text PRIMARY KEY, "externalConversationId" text);
      CREATE TEMP TABLE messages (id text PRIMARY KEY, "threadId" text, seq integer, role text,
        "runId" text, blocks jsonb, "createdAt" timestamp(3));
      CREATE TEMP TABLE events (id text PRIMARY KEY, "spaceId" text, "runId" text, type text,
        payload jsonb, "createdAt" timestamp(3));
      CREATE TEMP TABLE steering_messages (id text PRIMARY KEY, "createdAt" timestamp(3), "claimedAt" timestamp(3));
      CREATE TEMP TABLE usage_records (id text PRIMARY KEY, "runId" text, "parentRunId" text,
        "operationId" text, "operationKind" text, "createdAt" timestamp(3));
      CREATE TEMP TABLE routines (id text PRIMARY KEY, "spaceId" text);
    `);
    const run = (
      id: string,
      task: string,
      thread: string,
      trigger: string,
      status: string,
      error: string | null,
      minutesAgo: number,
      seconds: number,
    ) =>
      pool.query(`INSERT INTO runs VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`, [
        id,
        task,
        thread,
        trigger,
        status,
        error,
        ago(minutesAgo),
        status === "completed" ? ago(minutesAgo - seconds / 60) : null,
      ]);
    for (const [id, minutes] of [
      ["t-ok", 600],
      ["t-retry", 500],
      ["t-stop", 400],
      ["t-live", 5],
    ] as const)
      await pool.query(`INSERT INTO tasks VALUES ($1,$2)`, [id, ago(minutes)]);
    await run("r-ok", "t-ok", "th-a", "user", "completed", null, 600, 30);
    await run("r-fail", "t-retry", "th-a", "user", "failed", "Model timed out after 120 s", 500, 0);
    await run("r-retry", "t-retry", "th-a", "user", "completed", null, 490, 90);
    await run("r-stop", "t-stop", "th-a", "user", "cancelled", STOPPED_TURN, 400, 0);
    await run("r-live", "t-live", "th-a", "user", "running", null, 5, 0);
    await run("r-bot1", "t-x", "th-g", "bot_message", "completed", null, 300, 10);
    await run("r-bot2", "t-x", "th-g", "bot_message", "completed", null, 290, 10);
    await run("r-routine", "t-y", "th-a", "routine", "completed", null, 200, 10);
    await run("r-routine-f", "t-y", "th-a", "routine", "failed", "Tool failed 3 times", 190, 0);
    await run(
      "r-limited",
      "t-y",
      "th-a",
      "routine",
      "cancelled",
      AUTOMATION_RATE_LIMITED_ERROR,
      180,
      0,
    );
    await run("r-old", "t-old", "th-a", "user", "completed", null, 60 * 24 * 40, 10);
    await pool.query(`
      INSERT INTO threads VALUES ('th-a', NULL), ('th-g', NULL), ('th-x', 'ext-1');
      INSERT INTO messages VALUES
        ('m1','th-a',1,'user',NULL,'[{"kind":"text","text":"find people"}]','${ago(600)}'),
        ('m2','th-a',2,'bot','r-ok','[{"kind":"text","text":"on it"}]','${ago(599.9)}'),
        ('m3','th-a',3,'user',NULL,'[{"kind":"text","text":"我之前说过只要湾区"}]','${ago(100)}'),
        ('m4','th-a',4,'bot','r-ok','[{"kind":"text","text":"sorry"}]','${ago(99)}'),
        ('m5','th-a',5,'user',NULL,'[{"kind":"text","text":"anything?"}]','${ago(30)}'),
        ('m6','th-a',6,'user',NULL,'[{"kind":"text","text":"just now"}]','${ago(2)}'),
        ('g1','th-g',1,'bot','r-bot1','[{"kind":"text","text":"done"}]','${ago(299)}'),
        ('x1','th-x',1,'user',NULL,'[{"kind":"text","text":"candidate reply"}]','${ago(300)}');
      INSERT INTO events VALUES
        ('e1','s1','r-bot1','group.handoff','{}','${ago(300)}'),
        ('e2','s1','r-retry','run.requeued','{}','${ago(480)}'),
        ('e3','s1',NULL,'routine.fired','{"skipped":true}','${ago(170)}'),
        ('e4','s1',NULL,'routine.fired','{"skipped":false}','${ago(160)}');
      INSERT INTO steering_messages VALUES
        ('s-1','${ago(50)}','${ago(49.99)}'), ('s-2','${ago(40)}','${ago(39.9)}'), ('s-3','${ago(30)}',NULL);
      INSERT INTO usage_records VALUES
        ('u1','r-retry',NULL,'op-1','compaction','${ago(120)}'),
        ('u2','r-retry',NULL,'op-1','compaction','${ago(120)}'),
        ('u3','r-ok',NULL,'op-2','answer','${ago(120)}');
      INSERT INTO routines VALUES ('rt-1','s1');
    `);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("counts every metric from stored records", async () => {
    const metrics = await summarizeWorkMetrics(prisma, { now });
    expect(metrics.unrescuedWeeks.reduce((sum, week) => sum + week.tasks, 0)).toBe(3);
    expect(metrics.unrescuedWeeks.reduce((sum, week) => sum + week.unrescued, 0)).toBe(1);
    expect(metrics.completion).toMatchObject({
      completed: 5,
      failed: 2,
      cancelled: 2,
      stoppedByPerson: 1,
    });
    expect(metrics.completion.reasons).toContainEqual({
      status: "failed",
      reason: "Model timed out after N s",
      count: 1,
    });
    expect(metrics.longTasks.runDuration).toMatchObject({ count: 5, p50Ms: 10_000 });
    expect(metrics.longTasks).toMatchObject({
      compactions: 1,
      runsCompacted: 1,
      resumed: { count: 1, of: 1 },
    });
    // m1 and m3 answered, m5 unanswered after 10 minutes, m6 too recent, x1 external.
    expect(metrics.experience).toMatchObject({ inputs: 3, unansweredInputs: 1 });
    expect(metrics.experience.firstReply).toMatchObject({ count: 2, p50Ms: 33_000 });
    expect(metrics.experience.interject).toMatchObject({ count: 2, p50Ms: 3_300 });
    expect(metrics.memory.correctedAfterCompaction).toEqual({ count: 1, of: 1 });
    expect(metrics.collaboration).toEqual({
      handoffs: 1,
      teammateTurns: 2,
      replied: 1,
      silent: 1,
    });
    expect(metrics.automation).toEqual({ fired: 4, skipped: 2, completed: 1, failed: 1 });
  });
});
