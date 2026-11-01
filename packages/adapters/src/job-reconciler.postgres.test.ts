import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createJobReconciler, createPostgresReconciliationLeadership } from "./job-reconciler.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("job reconciliation leadership (PostgreSQL contract)", () => {
  it("elects one session and hands leadership to a follower after release", async () => {
    const pool = new Pool({ connectionString: databaseUrl!, max: 2 });
    const lockId = -Math.min(process.pid, 2_000_000_000);
    const first = createPostgresReconciliationLeadership(pool, { lockId });
    const second = createPostgresReconciliationLeadership(pool, { lockId });

    try {
      await expect(first.tryAcquire()).resolves.toBe(true);
      await expect(second.tryAcquire()).resolves.toBe(false);

      await first.release();
      await expect(second.tryAcquire()).resolves.toBe(true);
    } finally {
      await first.release();
      await second.release();
      await pool.end();
    }
  });
});

const profileDatabaseUrl = process.env.RECRUITING_PROFILE_TEST_DATABASE_URL;
const profileLocal =
  profileDatabaseUrl &&
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(profileDatabaseUrl).hostname);
const describeProfilePostgres = profileLocal ? describe : describe.skip;
describeProfilePostgres("marked profile intent discovery (isolated PostgreSQL)", () => {
  it("uses the partial intent index and skips unmarked or completed pages without returning profile facts", async () => {
    const pool = new Pool({ connectionString: profileDatabaseUrl!, max: 1 });
    const client = await pool.connect();
    const schema = `profile_queue_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(
        'CREATE TABLE external_effects (id text PRIMARY KEY, kind text, status text, result jsonb, "idempotencyKey" text UNIQUE, "createdAt" timestamp DEFAULT now())',
      );
      await client.query(
        'CREATE TABLE recruiting_candidate_pages ("effectId" text PRIMARY KEY, "artifactHash" text)',
      );
      const migration = await readFile(
        new URL(
          "../../db/prisma/migrations/20261101170000_recruiting_profile_projection_intent_index/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      // Deliberately outside BEGIN: the release migration must build concurrently.
      await client.query(migration);
      await client.query(
        `INSERT INTO recruiting_candidate_pages VALUES ('page-new','hash-new'),('page-done','hash-done'),('page-legacy','hash-legacy')`,
      );
      await client.query(`INSERT INTO external_effects (id,kind,status,result) VALUES
        ('save-new','recruiting_research','completed','{"profileFactsVersion":1,"sourceEffectId":"page-new","candidateRows":[{"_profile":{"photo":"private-url"}}]}'),
        ('save-done','recruiting_research','completed','{"profileFactsVersion":1,"sourceEffectId":"page-done"}'),
        ('save-legacy','recruiting_research','completed','{"sourceEffectId":"page-legacy"}')`);
      await client.query(
        `INSERT INTO external_effects (id,kind,status,result) SELECT 'unrelated-'||n,'other','completed','{"profileFactsVersion":1}'::jsonb FROM generate_series(1,40) n`,
      );
      await client.query(
        `INSERT INTO external_effects (id,kind,status,"idempotencyKey") VALUES ('done','recruiting_profile_projection','completed','recruiting-profile-project:page-done:hash-done')`,
      );
      let discovery: { text: string; values: unknown[] } | undefined;
      const prisma = {
        $queryRaw: async (query: { text: string; values: unknown[] }) => {
          if (!query.text.includes("SELECT saving.id")) return [];
          discovery = query;
          return (await client.query(query.text, query.values)).rows;
        },
        run: { findMany: async () => [] },
        routine: { findMany: async () => [] },
        computer: { findMany: async () => [] },
        messagingOutbound: { findFirst: async () => null },
      } as unknown as PrismaClient;
      const enqueued: BackgroundJob[] = [];
      const jobs = {
        enqueue: async (job: BackgroundJob) => {
          enqueued.push(job);
        },
      } as JobPublisher;
      await createJobReconciler({ prisma, jobs }).reconcileOnce();
      expect(enqueued).toEqual([
        {
          name: "recruiting_profile.project",
          payload: { pageEffectId: "page-new" },
          replaceKey: "recruiting_profile.project:page-new",
          keepExisting: true,
        },
      ]);
      expect(discovery).toBeDefined();
      // Index eligibility, not a performance benchmark on a synthetic table.
      await client.query("SET enable_seqscan=off");
      const plan = await client.query(
        `EXPLAIN (FORMAT JSON) ${discovery!.text}`,
        discovery!.values,
      );
      expect(JSON.stringify(plan.rows)).toContain("recruiting_profile_projection_intents");
      const valid = await client.query(
        "SELECT indisvalid FROM pg_index WHERE indexrelid='recruiting_profile_projection_intents'::regclass",
      );
      expect(valid.rows).toEqual([{ indisvalid: true }]);
    } finally {
      await client.query("RESET enable_seqscan");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
      await pool.end();
    }
  });
});
