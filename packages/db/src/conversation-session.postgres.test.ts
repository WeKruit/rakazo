import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import type { SessionLease } from "./conversation-session.js";
import {
  acquireSessionLease,
  ensureConversationSession,
  markSessionInputDelivered,
  pendingSessionInputs,
  releaseSessionLease,
  renewSessionLease,
  reserveSessionSeqs,
  SESSION_LEASE_TTL_MS,
  SessionFenceLost,
  submitSessionInput,
} from "./conversation-session.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("conversation sessions (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `session-user-${suffix}`;
  const organizationId = `session-organization-${suffix}`;
  const spaceId = `session-space-${suffix}`;
  let threadId: string;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botCount = 0;

  const freshSession = () =>
    ensureConversationSession(prisma, { spaceId, userId, threadId, botId: `bot-${++botCount}` });

  const newThread = async () => {
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Agent", color: "blue" },
    });
    return (await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } })).id;
  };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Session Org",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    threadId = await newThread();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("creates one session per agent per conversation", async () => {
    const key = { spaceId, userId, threadId, botId: "bot-ensure" };
    const first = await ensureConversationSession(prisma, key);
    const second = await ensureConversationSession(prisma, key);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
  });

  it("second acquire while live returns null", async () => {
    const { id } = await freshSession();
    const lease = await acquireSessionLease(prisma, id, "worker-a");
    expect(lease).toMatchObject({ sessionId: id, threadId, workerId: "worker-a", fence: 1 });
    await expect(acquireSessionLease(prisma, id, "worker-b")).resolves.toBeNull();
  });

  it("acquire after expiry bumps fence", async () => {
    const { id } = await freshSession();
    const first = await acquireSessionLease(prisma, id, "worker-a");
    const later = new Date(Date.now() + SESSION_LEASE_TTL_MS + 1);
    const second = await acquireSessionLease(prisma, id, "worker-b", later);
    expect(second?.fence).toBe(first!.fence + 1);
    await expect(renewSessionLease(prisma, first!)).resolves.toBe(false);
    await expect(renewSessionLease(prisma, second!)).resolves.toBe(true);
  });

  it("release lets the next worker acquire at once", async () => {
    const { id } = await freshSession();
    const first = await acquireSessionLease(prisma, id, "worker-a");
    await releaseSessionLease(prisma, first!);
    const second = await acquireSessionLease(prisma, id, "worker-b");
    expect(second?.workerId).toBe("worker-b");
    // A stale owner's release does not free the new owner's lease.
    await releaseSessionLease(prisma, first!);
    await expect(acquireSessionLease(prisma, id, "worker-c")).resolves.toBeNull();
  });

  it("reserves storage seqs only under the current fence", async () => {
    const { id } = await freshSession();
    const lease = await acquireSessionLease(prisma, id, "worker-a");
    const reserve = (fence: number, n: number) =>
      prisma.$transaction((tx) => reserveSessionSeqs(tx, id, fence, n));
    await expect(reserve(lease!.fence, 3)).resolves.toMatchObject({ firstSeq: 1 });
    await expect(reserve(lease!.fence, 2)).resolves.toMatchObject({ firstSeq: 4 });
    await expect(reserve(lease!.fence - 1, 1)).rejects.toBeInstanceOf(SessionFenceLost);
  });

  it("inputs come back in submit order", async () => {
    const { id } = await freshSession();
    for (const text of ["one", "two", "three"]) {
      await prisma.$transaction((tx) =>
        submitSessionInput(tx, {
          sessionId: id,
          kind: "message",
          trigger: "user",
          payload: { text },
        }),
      );
    }
    const pending = await pendingSessionInputs(prisma, id);
    expect(pending.map((input) => input.payload)).toEqual([
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);
    expect(pending.map((input) => input.seq)).toEqual([1, 2, 3]);
  });

  it("delivered inputs are not pending", async () => {
    const { id } = await freshSession();
    const lease = (await acquireSessionLease(prisma, id, "worker-a"))!;
    const first = await submitSessionInput(prisma, {
      sessionId: id,
      kind: "message",
      trigger: "user",
      payload: { text: "first" },
    });
    await submitSessionInput(prisma, {
      sessionId: id,
      kind: "stop",
      trigger: "user",
      payload: {},
    });
    await expect(
      markSessionInputDelivered(prisma, lease, first.inputId, { piEntryId: "entry-1" }),
    ).resolves.toBe(true);
    const pending = await pendingSessionInputs(prisma, id);
    expect(pending.map((input) => input.kind)).toEqual(["stop"]);
    const delivered = await prisma.sessionInput.findUniqueOrThrow({ where: { id: first.inputId } });
    expect(delivered).toMatchObject({ piEntryId: "entry-1", operationId: null });
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
  });

  it("mark with stale fence is a no-op", async () => {
    const { id } = await freshSession();
    const stale = (await acquireSessionLease(prisma, id, "worker-a"))!;
    const input = await submitSessionInput(prisma, {
      sessionId: id,
      kind: "message",
      trigger: "user",
      payload: { text: "hello" },
    });
    const later = new Date(Date.now() + SESSION_LEASE_TTL_MS + 1);
    const current: SessionLease | null = await acquireSessionLease(prisma, id, "worker-b", later);
    expect(current).not.toBeNull();
    await expect(markSessionInputDelivered(prisma, stale, input.inputId, {})).resolves.toBe(false);
    expect((await pendingSessionInputs(prisma, id)).map((row) => row.id)).toEqual([input.inputId]);
  });

  it("deleting the conversation deletes its sessions", async () => {
    const cascadeThreadId = await newThread();
    const { id } = await ensureConversationSession(prisma, {
      spaceId,
      userId,
      threadId: cascadeThreadId,
      botId: "bot-cascade",
    });
    await submitSessionInput(prisma, {
      sessionId: id,
      kind: "message",
      trigger: "user",
      payload: {},
    });
    await prisma.thread.delete({ where: { id: cascadeThreadId } });
    await expect(prisma.conversationSession.count({ where: { id } })).resolves.toBe(0);
    await expect(prisma.sessionInput.count({ where: { sessionId: id } })).resolves.toBe(0);
  });
});
