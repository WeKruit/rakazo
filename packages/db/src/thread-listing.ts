import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];

/**
 * The newest conversational/foreground run for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "kind" in block &&
      block.kind !== "bot_message_sent" &&
      block.kind !== "bot_message_received" &&
      block.kind !== "handoff" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  return "";
}

type LatestRowsDb = Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The newest messages of each thread, `take` per thread, newest first. Prisma applies a nested
 * relation `take` in memory after reading every related row, so a sidebar list read every message
 * of every listed conversation; this asks the (threadId, seq) index for only the rows shown.
 */
export async function latestThreadMessages(
  db: LatestRowsDb,
  threadIds: readonly string[],
  options: { take: number; hideAutocontinue?: boolean },
): Promise<Map<string, LatestThreadMessage[]>> {
  const ids = [...new Set(threadIds)];
  const byThread = new Map<string, LatestThreadMessage[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return byThread;
  const rows = await db.$queryRaw<LatestThreadMessage[]>`
    SELECT m."id", m."threadId", m."seq", m."role", m."blocks", m."botId", m."runId",
      m."clientNonce", m."createdAt"
    FROM unnest(${ids}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT * FROM "messages" WHERE "threadId" = t.id
      ${
        options.hideAutocontinue
          ? Prisma.sql`AND ("clientNonce" IS NULL OR "clientNonce" NOT LIKE 'autocontinue:%')`
          : Prisma.empty
      }
      ORDER BY "seq" DESC LIMIT ${options.take}
    ) m
    ORDER BY m."threadId", m."seq" DESC`;
  for (const row of rows) byThread.get(row.threadId)?.push(row);
  return byThread;
}

export type LatestThreadMessage = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: unknown;
  botId: string | null;
  runId: string | null;
  clientNonce: string | null;
  createdAt: Date;
};

/**
 * Each thread's newest run other than peer-bot and background runs, for the roster's error signal;
 * a later success clears an older failure.
 */
export async function latestThreadBotRuns(
  db: LatestRowsDb,
  threadIds: readonly string[],
): Promise<Map<string, { id: string; status: string }>> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ threadId: string; id: string; status: string }>>`
    SELECT t.id AS "threadId", r."id", r."status"
    FROM unnest(${ids}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT "id", "status" FROM "runs"
      WHERE "threadId" = t.id AND "trigger" <> ALL(${userVisibleBotRunTriggers}::text[])
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
    ) r`;
  return new Map(rows.map((row) => [row.threadId, { id: row.id, status: row.status }]));
}
