import type { PushTokenDb } from "./expo-push.js";

type Row = { userId: string; token: string; sessionId: string | null };
type Where = { userId?: string; sessionId?: string; token?: string; NOT?: { userId: string } };

/** The push_tokens table in memory; every session counts as live. Postgres behavior is covered
 * by expo-push.postgres.test.ts. */
export function memoryPushTokens(
  options: {
    threads?: Array<{ id: string; spaceId: string; userId: string; botId: string }>;
    runs?: Array<{
      id: string;
      threadId: string;
      spaceId: string;
      userId: string;
      status: string;
      updatedAt: Date;
    }>;
  } = {},
): PushTokenDb {
  const rows = new Map<string, Row>();
  const events: Array<{
    id: string;
    threadId: string;
    type: string;
    runId?: string;
    seq?: number;
    payload: Record<string, unknown>;
    createdAt: Date;
  }> = [];
  const seqs = new Map<string, number>();
  let transactionTail: Promise<unknown> = Promise.resolve();
  const matches = (row: Row, where: Where) =>
    (where.userId === undefined || row.userId === where.userId) &&
    (where.sessionId === undefined || row.sessionId === where.sessionId) &&
    (where.token === undefined || row.token === where.token) &&
    (where.NOT === undefined || row.userId !== where.NOT.userId);
  const pushToken = {
    findUnique: async ({ where }: { where: { userId: string } }) => {
      const row = rows.get(where.userId);
      return row ? { ...row } : null;
    },
    deleteMany: async ({ where }: { where: Where }) => {
      for (const row of [...rows.values()]) if (matches(row, where)) rows.delete(row.userId);
      return { count: 0 };
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      for (const row of rows.values()) if (matches(row, where)) Object.assign(row, data);
      return { count: 0 };
    },
    upsert: async ({ where, create }: { where: { userId: string }; create: Row }) => {
      rows.set(where.userId, { ...create, userId: where.userId });
      return create;
    },
  };
  const thread = {
    findFirst: async ({ where }: { where: { id?: string; spaceId: string; userId: string } }) =>
      options.threads
        ? (options.threads.find(
            (row) =>
              (!where.id || row.id === where.id) &&
              row.spaceId === where.spaceId &&
              row.userId === where.userId,
          ) ?? null)
        : { id: where.id ?? "desktop-thread", botId: "bot-1", userId: where.userId },
    update: async ({ where }: { where: { id: string } }) => {
      const nextEventSeq = (seqs.get(where.id) ?? 0) + 1;
      seqs.set(where.id, nextEventSeq);
      return { nextEventSeq, userId: "user-1" };
    },
  };
  const event = {
    deleteMany: async ({ where }: { where: { id: string; type: string } }) => {
      const index = events.findIndex((row) => row.id === where.id && row.type === where.type);
      if (index >= 0) events.splice(index, 1);
      return { count: index >= 0 ? 1 : 0 };
    },
    create: async ({ data }: { data: Omit<(typeof events)[number], "id" | "createdAt"> }) => {
      const saved = { ...data, id: `notice-${events.length}`, createdAt: new Date() };
      events.push(saved);
      return saved;
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: {
        id?: string;
        threadId?: string;
        runId?: string;
        type?: string;
        seq?: { lt: number };
        payload?: { path: string[]; equals: string };
        createdAt?: { gt: Date };
        thread?: { userId: string };
        OR?: Array<{ createdAt?: { gt: Date }; payload?: { path: string[]; equals: string } }>;
        AND?: Array<{ payload: { path: string[]; equals: string } }>;
      };
      orderBy?: { seq: string };
    }) =>
      [...events]
        .sort((a, b) => (orderBy?.seq === "desc" ? (b.seq ?? 0) - (a.seq ?? 0) : 0))
        .find(
          (row) =>
            (!where.id || row.id === where.id) &&
            (!where.threadId || row.threadId === where.threadId) &&
            (!where.runId || row.runId === where.runId) &&
            (!where.type || row.type === where.type) &&
            (!where.seq || (row.seq ?? 0) < where.seq.lt) &&
            (!where.payload || row.payload[where.payload.path[0]!] === where.payload.equals) &&
            (!where.createdAt || row.createdAt > where.createdAt.gt) &&
            (!where.thread || row.payload.userId === where.thread.userId) &&
            (!where.OR ||
              where.OR.some((clause) =>
                clause.createdAt
                  ? row.createdAt > clause.createdAt.gt
                  : clause.payload &&
                    row.payload[clause.payload.path[0]!] === clause.payload.equals,
              )) &&
            (!where.AND ||
              where.AND.every(({ payload }) => row.payload[payload.path[0]!] === payload.equals)),
        ) ??
      // Token/session tests use an ordinary native notification source. Policy tests
      // supply explicit runs and retained events, so absent proof stays absent there.
      (!options.runs && where.runId
        ? { id: `source:${where.threadId}:${where.runId}:${where.type}`, seq: 100 }
        : null),
  };
  const run = {
    findFirst: async ({
      where,
    }: {
      where: {
        id: string;
        threadId: string;
        spaceId: string;
        userId: string;
        status: { in: string[] };
      };
    }) =>
      options.runs
        ? (options.runs.find(
            (row) =>
              row.id === where.id &&
              row.threadId === where.threadId &&
              row.spaceId === where.spaceId &&
              row.userId === where.userId &&
              where.status.in.includes(row.status),
          ) ?? null)
        : { id: where.id, status: where.status.in[0], updatedAt: new Date(0) },
  };
  const db = {
    pushToken,
    event,
    $transaction: async (body: (tx: unknown) => Promise<unknown>) => {
      const result = transactionTail.then(() =>
        body({ pushToken, thread, event, run, $queryRaw: async () => [{ id: "live" }] }),
      );
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
  return db as unknown as PushTokenDb;
}
