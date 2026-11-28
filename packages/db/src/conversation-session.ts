import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./client.js";

/** A session owner that stops renewing loses the session to the next worker after this. */
export const SESSION_LEASE_TTL_MS = 30_000;

/** Storage format of the rows in session_entries, session_values and session_list_elements. */
export const SESSION_STORAGE_VERSION = 1;

/** Thrown when a newer owner has taken the session: this writer may no longer commit. */
export class SessionFenceLost extends Error {
  constructor(sessionId: string, fence: number) {
    super(`Session ${sessionId} is no longer owned at fence ${fence}`);
    this.name = "SessionFenceLost";
  }
}

export interface ConversationSessionKey {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
}

export interface SessionLease {
  sessionId: string;
  threadId: string;
  botId: string;
  workerId: string;
  fence: number;
}

export type SessionInputKind = "message" | "followUp" | "stop" | "cardAnswer";

export interface SessionInputRow {
  id: string;
  sessionId: string;
  seq: number;
  kind: SessionInputKind;
  messageId: string | null;
  payload: Prisma.JsonValue;
  trigger: string;
  createdAt: Date;
}

type Sql = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** The session of one agent in one conversation; the id is `<threadId>:<botId>`. */
export async function ensureConversationSession(
  db: Pick<PrismaClient, "conversationSession">,
  key: ConversationSessionKey,
): Promise<{ id: string; created: boolean }> {
  const id = `${key.threadId}:${key.botId}`;
  const { count } = await db.conversationSession.createMany({
    data: [{ id, ...key, storageVersion: SESSION_STORAGE_VERSION }],
    skipDuplicates: true,
  });
  return { id, created: count === 1 };
}

/** Take the session when its lease has lapsed (or is already ours), with a new fence. */
export async function acquireSessionLease(
  db: Sql,
  sessionId: string,
  workerId: string,
  now: Date = new Date(),
): Promise<SessionLease | null> {
  const expiresAt = new Date(now.getTime() + SESSION_LEASE_TTL_MS);
  const rows = await db.$queryRaw<{ threadId: string; botId: string; leaseFence: number }[]>`
    UPDATE conversation_sessions
    SET "leaseOwner" = ${workerId}, "leaseFence" = "leaseFence" + 1, "leaseExpiresAt" = ${expiresAt}
    WHERE id = ${sessionId}
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now} OR "leaseOwner" = ${workerId})
    RETURNING "threadId", "botId", "leaseFence"`;
  const row = rows[0];
  if (!row) return null;
  return { sessionId, threadId: row.threadId, botId: row.botId, workerId, fence: row.leaseFence };
}

/** Extend a lease still held at its fence; false means another worker owns the session. */
export async function renewSessionLease(
  db: Pick<PrismaClient, "conversationSession">,
  lease: SessionLease,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await db.conversationSession.updateMany({
    where: { id: lease.sessionId, leaseFence: lease.fence, leaseOwner: lease.workerId },
    data: { leaseExpiresAt: new Date(now.getTime() + SESSION_LEASE_TTL_MS) },
  });
  return count === 1;
}

/** Let the next worker take the session at once. A lease lost to a newer fence is left alone. */
export async function releaseSessionLease(
  db: Pick<PrismaClient, "conversationSession">,
  lease: SessionLease,
): Promise<void> {
  await db.conversationSession.updateMany({
    where: { id: lease.sessionId, leaseFence: lease.fence, leaseOwner: lease.workerId },
    data: { leaseExpiresAt: new Date() },
  });
}

export interface SessionSeqReservation {
  /** First of the n storage sequences reserved. */
  firstSeq: number;
  /** Session totals before this commit, read under the same row lock. */
  messageCount: number;
  usage: Prisma.JsonValue | null;
}

/**
 * Reserve n storage sequences for one commit, only while `fence` is the session's lease fence.
 * Run it first in the commit's transaction: it locks the session row until the commit ends.
 */
export async function reserveSessionSeqs(
  tx: Sql,
  sessionId: string,
  fence: number,
  n: number,
): Promise<SessionSeqReservation> {
  const rows = await tx.$queryRaw<
    { nextSeq: number; messageCount: number; usage: Prisma.JsonValue | null }[]
  >`
    UPDATE conversation_sessions SET "nextSeq" = "nextSeq" + ${n}::int
    WHERE id = ${sessionId} AND "leaseFence" = ${fence}::int
    RETURNING "nextSeq", "messageCount", usage`;
  const row = rows[0];
  if (!row) throw new SessionFenceLost(sessionId, fence);
  return { firstSeq: row.nextSeq - n + 1, messageCount: row.messageCount, usage: row.usage };
}

/**
 * Add one input to the session's outbox. One statement takes the next input seq and inserts the
 * row, so it is atomic on its own and joins the caller's transaction when given one.
 */
export async function submitSessionInput(
  tx: Sql,
  input: {
    sessionId: string;
    kind: SessionInputKind;
    trigger: string;
    messageId?: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<{ inputId: string; seq: number }> {
  const rows = await tx.$queryRaw<{ id: string; seq: number }[]>`
    WITH next AS (
      UPDATE conversation_sessions SET "nextInputSeq" = "nextInputSeq" + 1
      WHERE id = ${input.sessionId}
      RETURNING "nextInputSeq" AS seq
    )
    INSERT INTO session_inputs (id, "sessionId", seq, kind, "messageId", payload, trigger)
    SELECT ${randomUUID()}, ${input.sessionId}, next.seq, ${input.kind}, ${input.messageId ?? null},
      ${JSON.stringify(input.payload)}::jsonb, ${input.trigger}
    FROM next
    RETURNING id, seq`;
  const row = rows[0];
  if (!row) throw new Error(`Unknown session: ${input.sessionId}`);
  return { inputId: row.id, seq: row.seq };
}

/** Inputs not yet delivered to Pi, in submit order. */
export async function pendingSessionInputs(
  db: Pick<PrismaClient, "sessionInput">,
  sessionId: string,
): Promise<SessionInputRow[]> {
  const rows = await db.sessionInput.findMany({
    where: { sessionId, deliveredAt: null },
    orderBy: { seq: "asc" },
    select: {
      id: true,
      sessionId: true,
      seq: true,
      kind: true,
      messageId: true,
      payload: true,
      trigger: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({ ...row, kind: row.kind as SessionInputKind }));
}

/** Record that the owner handed an input to Pi. False when the lease's fence is no longer current. */
export async function markSessionInputDelivered(
  db: Sql,
  lease: SessionLease,
  inputId: string,
  delivery: { piEntryId?: string; operationId?: string },
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE session_inputs SET "deliveredAt" = now(),
      "piEntryId" = ${delivery.piEntryId ?? null}, "operationId" = ${delivery.operationId ?? null}
    WHERE id = ${inputId} AND "sessionId" = ${lease.sessionId} AND "deliveredAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM conversation_sessions
        WHERE id = ${lease.sessionId} AND "leaseFence" = ${lease.fence}::int
        FOR SHARE
      )`;
  return count === 1;
}
