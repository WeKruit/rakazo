import type { PushTokenDb } from "./expo-push.js";

type Row = { userId: string; token: string; sessionId: string | null };
type Where = { userId?: string; sessionId?: string; token?: string; NOT?: { userId: string } };

/** The push_tokens table in memory; every session counts as live. Postgres behavior is covered
 * by expo-push.postgres.test.ts. */
export function memoryPushTokens(): PushTokenDb {
  const rows = new Map<string, Row>();
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
  const db = {
    pushToken,
    $transaction: async (body: (tx: unknown) => Promise<unknown>) =>
      body({ pushToken, $queryRaw: async () => [{ id: "live" }] }),
  };
  return db as unknown as PushTokenDb;
}
