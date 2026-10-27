import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExpoPushProvider,
  endSessionPushToken,
  loadPushToken,
  PushSessionEndedError,
  savePushToken,
} from "./expo-push.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("push tokens (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const users = ["a", "b", "c"].map((name) => `push-${name}-${suffix}`);
  const [userA, userB, userC] = users as [string, string, string];
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let n = 0;

  async function session(userId: string, expiresInMs = 60_000) {
    n += 1;
    const id = `push-session-${suffix}-${n}`;
    await prisma.session.create({
      data: { id, userId, token: id, expiresAt: new Date(Date.now() + expiresInMs) },
    });
    return id;
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { poolMax: 6 });
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of users) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await close();
  });

  it("moves a device token to the account that saves it last", async () => {
    const token = `ExponentPushToken[move-${suffix}]`;
    await savePushToken(prisma, userA, token, await session(userA));
    await savePushToken(prisma, userB, token, await session(userB));
    await expect(loadPushToken(prisma, userA)).resolves.toBeUndefined();
    await expect(loadPushToken(prisma, userB)).resolves.toBe(token);
  });

  it("refuses a registration whose session is gone or expired", async () => {
    const token = `ExponentPushToken[ended-${suffix}]`;
    await expect(savePushToken(prisma, userC, token, "no-such-session")).rejects.toBeInstanceOf(
      PushSessionEndedError,
    );
    await expect(
      savePushToken(prisma, userC, token, await session(userC, -1_000)),
    ).rejects.toBeInstanceOf(PushSessionEndedError);
    await expect(loadPushToken(prisma, userC)).resolves.toBeUndefined();
  });

  it("ends or retargets only the token of the session that registered it", async () => {
    const token = `ExponentPushToken[retarget-${suffix}]`;
    const first = await session(userC);
    const next = await session(userC);
    await savePushToken(prisma, userC, token, first);
    await endSessionPushToken(prisma, userC, "other-session");
    await expect(loadPushToken(prisma, userC)).resolves.toBe(token);
    await endSessionPushToken(prisma, userC, first, next);
    await endSessionPushToken(prisma, userC, first);
    await expect(loadPushToken(prisma, userC)).resolves.toBe(token);
    await endSessionPushToken(prisma, userC, next);
    await expect(loadPushToken(prisma, userC)).resolves.toBeUndefined();
  });

  it("keeps one owner when several accounts claim one token at once", async () => {
    const token = `ExponentPushToken[race-${suffix}]`;
    const sessions = await Promise.all(users.map((userId) => session(userId)));
    await Promise.all(
      users.map((userId, index) => savePushToken(prisma, userId, token, sessions[index])),
    );
    const owners = await prisma.pushToken.findMany({ where: { token } });
    expect(owners).toHaveLength(1);
  });

  it("removes a token registered just before its session was signed out", async () => {
    const token = `ExponentPushToken[signout-${suffix}]`;
    const id = await session(userA);
    await savePushToken(prisma, userA, token, id);
    // Sign-out: the session row goes first, then the hook ends its token.
    await prisma.session.delete({ where: { id } });
    await endSessionPushToken(prisma, userA, id);
    await expect(loadPushToken(prisma, userA)).resolves.toBeUndefined();
  });

  it("delivers only while the registering session is live, and drops the account's token with it", async () => {
    const token = `ExponentPushToken[deliver-${suffix}]`;
    const id = await session(userB);
    await savePushToken(prisma, userB, token, id);
    const lookup = async (sessionId: string) =>
      (await prisma.session.findUnique({ where: { id: sessionId } }))?.expiresAt ?? null;
    const push = new ExpoPushProvider(prisma, lookup);
    await expect(push.hasPushRecipient(userB)).resolves.toBe(true);
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(push.hasPushRecipient(userB)).resolves.toBe(false);
    await expect(loadPushToken(prisma, userB)).resolves.toBeUndefined();
  });
});
