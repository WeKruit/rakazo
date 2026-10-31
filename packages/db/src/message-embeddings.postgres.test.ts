import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { searchHistory } from "./history-retrieval.js";
import type { TextEmbedder } from "./message-embeddings.js";
import { embedRecentMessages, unitVector } from "./message-embeddings.js";

// Temporary synthetic tables shadow product tables. Never inspect existing chat content.
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

/** Three topics, so "meaning" is predictable without a model. */
function topic(text: string) {
  if (/candidate|hire|hiring|recruit|engineer/i.test(text)) return [1, 0.1, 0];
  if (/rain|weather|sunny/i.test(text)) return [0, 1, 0.1];
  return [0.1, 0, 1];
}
function fakeEmbedder(calls: string[][], fail = false): TextEmbedder {
  return {
    provider: "synthetic",
    model: "synthetic-embedding",
    async embed(texts) {
      calls.push(texts);
      if (fail) throw new Error("connection down");
      return { vectors: texts.map(topic), tokens: texts.length * 10, costUsd: 0.000001 };
    },
  };
}

postgres("message embeddings (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const scope = {
    spaceId: "space-a",
    userId: "user-a",
    threadId: "thread-a",
    botId: "bot-a",
  };
  const text = (value: string) => JSON.stringify([{ kind: "text", text: value }]);
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE bots (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamp(3), name text);
      CREATE TEMP TABLE threads (id text PRIMARY KEY, "spaceId" text, "userId" text, "botId" text, "groupId" text);
      CREATE TEMP TABLE chat_groups (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamp(3), name text);
      CREATE TEMP TABLE chat_group_members ("groupId" text, "botId" text);
      CREATE TEMP TABLE messages (LIKE public.messages INCLUDING DEFAULTS);
      CREATE TEMP TABLE message_embeddings (LIKE public.message_embeddings INCLUDING DEFAULTS);
      CREATE TEMP TABLE usage_records (LIKE public.usage_records INCLUDING DEFAULTS);
      INSERT INTO bots VALUES ('bot-a','space-a','user-a',NULL,'Main'), ('bot-a2','space-a','user-a',NULL,'Sourcer'),
        ('bot-b','space-a','user-b',NULL,'Other');
      INSERT INTO threads VALUES ('thread-a','space-a','user-a','bot-a',NULL), ('thread-a2','space-a','user-a','bot-a2',NULL),
        ('thread-b','space-a','user-b','bot-b',NULL);
    `);
    const rows: Array<[string, string, number, string, string]> = [
      ["m1", "thread-a", 1, "user", text("We need a backend engineer for the payments team")],
      ["m2", "thread-a", 2, "bot", text("It looks sunny and warm today")],
      ["m3", "thread-a", 3, "bot", JSON.stringify([{ kind: "tool_call", name: "x" }])],
      ["m4", "thread-a2", 1, "bot", text("Shortlisted five candidates to hire")],
      ["m5", "thread-b", 1, "user", text("Another person's hiring plan")],
      ["m6", "thread-a2", 2, "user", text("Lunch order for today")],
    ];
    for (const [id, threadId, seq, role, blocks] of rows)
      await pool.query(
        `INSERT INTO messages (id, "threadId", seq, role, blocks) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, threadId, seq, role, blocks],
      );
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("stops a pass when the connection fails and leaves word search untouched", async () => {
    const calls: string[][] = [];
    const errors: unknown[] = [];
    const result = await embedRecentMessages(prisma, fakeEmbedder(calls, true), {
      maxTokensPerDay: 1_000,
      onError: (error) => errors.push(error),
    });
    expect(result.embedded).toBe(0);
    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(await prisma.messageEmbedding.count()).toBe(0);
  });

  it("embeds every recent message with text, records spend on each owner's Space, and stops at the cap", async () => {
    const calls: string[][] = [];
    expect(
      await embedRecentMessages(prisma, fakeEmbedder(calls), { maxTokensPerDay: 0 }),
    ).toMatchObject({ embedded: 0 });
    expect(calls).toHaveLength(0);
    const result = await embedRecentMessages(prisma, fakeEmbedder(calls), {
      maxTokensPerDay: 1_000,
    });
    expect(result).toMatchObject({ embedded: 5, tokens: 50, failed: 0 });
    const stored = await prisma.messageEmbedding.findMany({ orderBy: { messageId: "asc" } });
    expect(stored.map((row) => row.messageId)).toEqual(["m1", "m2", "m4", "m5", "m6"]);
    expect(Math.hypot(...stored[0]!.embedding)).toBeCloseTo(1);
    const usage = await prisma.usageRecord.findMany({ orderBy: { userId: "asc" } });
    expect(usage.map((row) => [row.userId, row.operationKind, row.inputTokens])).toEqual([
      ["user-a", "retrieval", 40],
      ["user-b", "retrieval", 10],
    ]);
    // Nothing left, and the next pass spends nothing.
    expect(
      await embedRecentMessages(prisma, fakeEmbedder(calls), { maxTokensPerDay: 1_000 }),
    ).toMatchObject({ embedded: 0 });
  });

  it("ranks by meaning only when no message shares a word, inside the same visibility", async () => {
    const queries: string[] = [];
    const embed = async (query: string) => {
      queries.push(query);
      return { model: "synthetic-embedding", vector: unitVector(topic(query)) };
    };
    // Shares a word: the word search answers and the embedder is not called.
    const literal = await searchHistory(prisma, scope, { query: "payments" }, embed);
    expect(literal.messages.map((m) => m.messageId)).toEqual(["m1"]);
    expect(queries).toEqual([]);

    const conversation = await searchHistory(prisma, scope, { query: "recruiting" }, embed);
    expect(conversation).toMatchObject({
      match: "meaning_ranked",
      coverage: { status: "partial" },
    });
    expect(conversation.messages.map((m) => m.messageId)).toEqual(["m1"]);
    expect(await searchHistory(prisma, scope, { query: "recruiting" })).not.toHaveProperty("match");

    // Another conversation of the same person is found; another person's never is.
    const mine = await searchHistory(prisma, scope, { query: "recruiting", scope: "mine" }, embed);
    expect(mine).toMatchObject({ match: "meaning_ranked" });
    expect(mine.messages.map((m) => m.messageId)).toEqual(["m4"]);
    // A stray shared word ("today") must not hide the message that means the same.
    const paraphrase = await searchHistory(
      prisma,
      scope,
      { query: "recruiting today", scope: "mine" },
      embed,
    );
    expect(paraphrase).toMatchObject({ match: "meaning_ranked" });
    expect(paraphrase.messages.map((m) => m.messageId)).toEqual(["m4", "m6"]);

    // A failing embedder falls back to the empty word result.
    const failing = await searchHistory(prisma, scope, { query: "recruiting" }, async () => {
      throw new Error("down");
    });
    expect(failing.messages).toEqual([]);
  });
});
