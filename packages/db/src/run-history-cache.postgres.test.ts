import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "./client.js";
import { createRunHistoryCache, loadRunHistoryMessages } from "./messages.js";

// Temporary synthetic tables shadow product tables. Never inspect existing chat content.
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

postgres("resident run history (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = { id: "synthetic-run", threadId: "synthetic-thread" };
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE messages (id text PRIMARY KEY, "threadId" text, seq integer, role text,
        "botId" text, "runId" text, "replyToMessageId" text, "replyQuote" text, "clientNonce" text,
        "createdAt" timestamp(3), "updatedAt" timestamp(3), blocks jsonb);
      CREATE TEMP TABLE steering_messages (id text PRIMARY KEY, "messageId" text, "originTrigger" text);
      INSERT INTO messages SELECT 'm-' || n, 'synthetic-thread', n, 'user', NULL, NULL, NULL, NULL, NULL,
        '2026-01-01'::timestamp(3), '2026-01-01'::timestamp(3),
        jsonb_build_array(jsonb_build_object('kind','text','text','message ' || n))
        FROM generate_series(1,300) n;
    `);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("returns what a fresh read returns and re-reads only new or changed rows", async () => {
    const cache = createRunHistoryCache();
    const plain = await loadRunHistoryMessages(prisma, run, 100);
    expect(await cache.load(prisma, run, 100)).toEqual(plain);

    await prisma.message.update({
      where: { id: "m-299" },
      data: { blocks: [{ kind: "text", text: "edited" }] },
    });
    await pool.query(`
      INSERT INTO messages VALUES ('m-301','synthetic-thread',301,'bot',NULL,NULL,'m-299',NULL,NULL,
        now(), now(), '[{"kind":"text","text":"reply"}]');
      DELETE FROM messages WHERE id = 'm-298';
      INSERT INTO steering_messages VALUES ('s-1','m-297','follow_up');
    `);
    const read = vi.spyOn(prisma.message, "findMany");
    const cached = await cache.load(prisma, run, 100);
    const fullReads = read.mock.calls
      .map(([args]) => (args?.where as { id?: { in: string[] } })?.id?.in)
      .filter(Boolean);
    read.mockRestore();

    expect(cached).toEqual(await loadRunHistoryMessages(prisma, run, 100));
    // New reply, edited message, and the one older row that slid into the window.
    expect(fullReads).toEqual([["m-301", "m-299", "m-200"]]);
    expect(cached.find((row) => row.id === "m-299")?.blocks).toEqual([
      { kind: "text", text: "edited" },
    ]);
  });
});
