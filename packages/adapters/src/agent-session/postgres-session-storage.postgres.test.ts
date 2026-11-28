import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { insertEntry, setValue, value } from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import type { PrismaClient } from "@rakazo/db";
import {
  acquireSessionLease,
  createDb,
  ensureConversationSession,
  SESSION_LEASE_TTL_MS,
  SessionFenceLost,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSessionStorage } from "./postgres-session-storage.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Pi session storage (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `pi-storage-user-${suffix}`;
  const organizationId = `pi-storage-organization-${suffix}`;
  const spaceId = `pi-storage-space-${suffix}`;
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
        name: "Pi Storage Org",
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

  describe("conformance", () => {
    const cases = createStorageConformance(async () => {
      const { id } = await freshSession();
      return {
        storage: new PostgresSessionStorage(prisma, id, 0),
        [Symbol.asyncDispose]: async () => {
          await prisma.conversationSession.delete({ where: { id } });
        },
      };
    });
    for (const conformanceCase of cases) {
      it(`${conformanceCase.group} ${conformanceCase.name}`, () => conformanceCase.run());
    }
  });

  it("stale fence commit rejects", async () => {
    const { id } = await freshSession();
    const first = (await acquireSessionLease(prisma, id, "worker-a"))!;
    const stale = new PostgresSessionStorage(prisma, id, first.fence);
    await stale.commit([setValue(value("test.value", "before"), 1)], BACKGROUND_CONTEXT);
    const later = new Date(Date.now() + SESSION_LEASE_TTL_MS + 1);
    const second = (await acquireSessionLease(prisma, id, "worker-b", later))!;

    const entry = {
      id: "late",
      parentId: null,
      type: "custom" as const,
      customType: "note",
    };
    await expect(stale.commit([insertEntry(entry)], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
      SessionFenceLost,
    );
    await expect(prisma.sessionEntry.count({ where: { sessionId: id } })).resolves.toBe(0);

    const current = new PostgresSessionStorage(prisma, id, second.fence);
    const result = await current.commit([insertEntry(entry)], BACKGROUND_CONTEXT);
    expect(result.firstSeq).toBe(2);
  });
});
