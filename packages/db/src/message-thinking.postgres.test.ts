import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { loadMessageThinking, saveRunThinking } from "./message-thinking.js";

// Temporary synthetic tables shadow product tables. Never inspect existing chat content.
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

postgres("message thinking (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const thinking = (text: string) => ({
    provider: "openai-codex",
    model: "gpt-6-luna",
    api: "openai-codex-responses",
    blocks: [{ thinking: text, thinkingSignature: `sig-${text}` }],
  });
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE messages (LIKE public.messages INCLUDING DEFAULTS);
      CREATE TEMP TABLE message_thinking (LIKE public.message_thinking INCLUDING DEFAULTS INCLUDING INDEXES);
      INSERT INTO messages (id, "threadId", seq, role, blocks, "runId") VALUES
        ('u1', 't', 1, 'user', '[]', NULL),
        ('b1', 't', 2, 'bot', '[]', 'run-1'),
        ('b2', 't', 3, 'bot', '[]', 'run-2'),
        ('b3', 't', 4, 'bot', '[]', 'run-2');
    `);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("keeps the reasoning on the run's final reply and replaces it on a second save", async () => {
    expect(await saveRunThinking(prisma, "run-2", thinking("first"))).toBe(true);
    expect(await saveRunThinking(prisma, "run-2", thinking("second"))).toBe(true);
    expect(await saveRunThinking(prisma, "run-missing", thinking("x"))).toBe(false);
    const rows = await prisma.messageThinking.findMany();
    expect(rows.map((row) => [row.messageId, row.blocks])).toEqual([
      ["b3", [{ thinking: "second", thinkingSignature: "sig-second" }]],
    ]);
  });

  it("loads reasoning only for the newest replies", async () => {
    await saveRunThinking(prisma, "run-1", thinking("old"));
    const loaded = await loadMessageThinking(prisma, ["b1", "x1", "x2", "b3"]);
    expect([...loaded.keys()]).toEqual(["b3"]);
    expect(loaded.get("b3")).toEqual(thinking("second"));
  });
});
