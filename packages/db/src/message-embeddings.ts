import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { historyMessageText, searchableText } from "./history-retrieval.js";
import { recordUsage } from "./usage.js";

/** Turns text into meaning vectors. Implemented by an adapter over the deployment model connection. */
export interface TextEmbedder {
  provider: string;
  model: string;
  embed(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<{ vectors: number[][]; tokens: number; costUsd: number | null }>;
}

/** Longest text embedded per message; the start of a long message carries its topic. */
const MAX_TEXT_CHARS = 6_000;
const BATCH = 64;
/** Only messages this recent get a vector; older ones stay searchable by words. */
const RECENT_DAYS = 30;

export function unitVector(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map((value) => value / length) : vector;
}

/** Tokens spent embedding in the last day, so the fill stops at its daily cap. */
async function tokensToday(prisma: Pick<PrismaClient, "$queryRaw">, model: string, now: Date) {
  const [row] = await prisma.$queryRaw<Array<{ tokens: bigint | null }>>`
    SELECT sum("inputTokens")::bigint AS tokens FROM usage_records
    WHERE "operationKind" = 'retrieval' AND model = ${model}
      AND "createdAt" >= ${new Date(now.getTime() - 86_400_000)}`;
  return Number(row?.tokens ?? 0);
}

/**
 * Gives recent messages that have text but no vector one, for every user, newest first, until the
 * daily token cap. Each person's spend is recorded on their own Space. A failed batch ends the pass
 * and is retried on the next one; it never affects search, which falls back to words.
 */
export async function embedRecentMessages(
  prisma: PrismaClient,
  embedder: TextEmbedder,
  options: {
    maxTokensPerDay: number;
    now?: Date;
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
  },
) {
  const now = options.now ?? new Date();
  const total = { embedded: 0, tokens: 0, failed: 0 };
  let spent = await tokensToday(prisma, embedder.model, now);
  while (spent < options.maxTokensPerDay && !options.signal?.aborted) {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        threadId: string;
        blocks: Prisma.JsonValue;
        spaceId: string;
        userId: string;
      }>
    >(Prisma.sql`
      SELECT m.id, m."threadId", m.blocks, t."spaceId", t."userId"
      FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE m."createdAt" >= ${new Date(now.getTime() - RECENT_DAYS * 86_400_000)}
        AND m.role IN ('user', 'bot')
        AND ${searchableText} <> '[][][]'
        AND NOT EXISTS (SELECT 1 FROM message_embeddings e WHERE e."messageId" = m.id)
      ORDER BY m."createdAt" DESC LIMIT ${BATCH * 4}`);
    if (!rows.length) break;
    // Group by owner so each person's spend is recorded on their own Space.
    const owners = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.spaceId}\u0000${row.userId}`;
      owners.set(key, [...(owners.get(key) ?? []), row]);
    }
    for (const group of owners.values()) {
      for (let start = 0; start < group.length; start += BATCH) {
        if (spent >= options.maxTokensPerDay || options.signal?.aborted) return total;
        const batch = group.slice(start, start + BATCH);
        try {
          const result = await embedder.embed(
            batch.map(
              (row) => historyMessageText(row.blocks).trim().slice(0, MAX_TEXT_CHARS) || " ",
            ),
            options.signal,
          );
          if (result.vectors.length !== batch.length) throw new Error("Embedding count mismatch");
          await prisma.messageEmbedding.createMany({
            data: batch.map((row, index) => ({
              messageId: row.id,
              threadId: row.threadId,
              model: embedder.model,
              embedding: unitVector(result.vectors[index]!),
            })),
            skipDuplicates: true,
          });
          await recordUsage(
            prisma,
            {
              type: "usage",
              provider: embedder.provider,
              model: embedder.model,
              inputTokens: result.tokens,
              outputTokens: 0,
              totalTokens: result.tokens,
              costUsd: result.costUsd,
              costSource: result.costUsd == null ? undefined : "catalog-estimate",
            },
            {
              spaceId: batch[0]!.spaceId,
              userId: batch[0]!.userId,
              operationKind: "retrieval",
            },
          );
          spent += result.tokens;
          total.embedded += batch.length;
          total.tokens += result.tokens;
        } catch (error) {
          // The connection may be down: stop this pass and try again on the next one.
          total.failed += batch.length;
          options.onError?.(error);
          return total;
        }
      }
    }
  }
  return total;
}
