import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActorDb, withDatabaseActor } from "./actor-db.js";
import { createDb } from "./client.js";

const url = process.env.RLS_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("first-batch RLS with a real restricted role", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const role = `rls_test_${suffix}`;
  const actors = ["a", "b"].map((name) => ({
    userId: `rls-${name}-${suffix}`,
    spaceId: `rls-space-${name}-${suffix}`,
  }));
  let admin: ReturnType<typeof createDb>;
  let restricted: ReturnType<typeof createActorDb>;
  let sql: Pool;
  const run = async <T>(index: number, action: () => Promise<T>) =>
    (await withDatabaseActor(actors[index]!, async () => ({ output: await action() }))).output;
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      !target.pathname.startsWith("/rakazo_a2_rls")
    )
      throw new Error("RLS tests require a dedicated local synthetic database");
    sql = new Pool({ connectionString: url, max: 1 });
    await sql.query(
      await readFile(new URL("../prisma/rls/first-batch.sql", import.meta.url), "utf8"),
    );
    await sql.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await sql.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    admin = createDb(url!, { poolMax: 1 });
    for (const actor of actors) {
      const { userId, spaceId } = actor;
      await admin.prisma.user.create({
        data: { id: userId, name: "Synthetic RLS", email: `${userId}@example.test` },
      });
      await admin.prisma.organization.create({
        data: { id: spaceId, name: "Synthetic RLS", slug: spaceId, createdAt: new Date() },
      });
      await admin.prisma.space.create({
        data: { id: spaceId, organizationId: spaceId, name: "Synthetic RLS", isDefault: true },
      });
      await admin.prisma.member.create({
        data: {
          id: userId,
          organizationId: spaceId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await admin.prisma.bot.create({
        data: { id: userId, userId, spaceId, name: "Synthetic", color: "blue" },
      });
      await admin.prisma.thread.create({ data: { id: userId, userId, spaceId, botId: userId } });
      await admin.prisma.message.create({
        data: { id: userId, threadId: userId, seq: 1, role: "user", blocks: [] },
      });
      await admin.prisma.artifact.create({
        data: {
          id: userId,
          userId,
          spaceId,
          name: "Synthetic",
          mimeType: "text/plain",
          size: 1,
          hash: "a".repeat(64),
          storageKey: userId,
        },
      });
      await admin.prisma.$transaction(async (tx) => {
        await tx.recruitingRole.create({
          data: {
            id: userId,
            spaceId,
            userId,
            sourceThreadId: userId,
            title: "Synthetic role",
            revision: 1,
            currentRevisionId: userId,
          },
        });
        await tx.recruitingRoleRevision.create({
          data: {
            id: userId,
            roleId: userId,
            revision: 1,
            criteria: [],
            sourceRefs: [],
            preferences: [],
            definitionQuestions: [],
          },
        });
      });
    }
    target.username = role;
    target.password = "";
    restricted = createActorDb(target.href, { poolMax: 1 });
    await restricted.prisma.$connect();
  });
  afterAll(async () => {
    await restricted?.prisma.$disconnect();
    await restricted?.pool.end();
    if (admin) {
      for (const actor of actors) {
        await admin.prisma.organization.deleteMany({ where: { id: actor.spaceId } });
        await admin.prisma.user.deleteMany({ where: { id: actor.userId } });
      }
      await admin.prisma.$disconnect();
      await admin.pool.end();
    }
    if (sql) {
      await sql.query(`DROP OWNED BY ${role}`);
      await sql.query(`DROP ROLE ${role}`);
      await sql.end();
    }
  });
  it("rejects privileged role configuration and actor-less access", async () => {
    const unsafe = createActorDb(url!, { poolMax: 1 });
    try {
      await expect(unsafe.prisma.$connect()).rejects.toThrow("must not own");
    } finally {
      await unsafe.prisma.$disconnect();
      await unsafe.pool.end();
    }
    await expect(restricted.prisma.artifact.findMany()).rejects.toThrow("requires an actor");
  });
  it("returns zero foreign rows when every application owner filter is omitted", async () => {
    for (let index = 0; index < 2; index++) {
      const own = actors[index]!.userId;
      const result = await run(index, async () =>
        Promise.all([
          restricted.prisma.artifact.findMany({ select: { id: true } }),
          restricted.prisma.message.findMany({ select: { id: true } }),
          restricted.prisma.recruitingRole.findMany({ select: { id: true } }),
        ]),
      );
      for (const rows of result) expect(rows).toEqual([{ id: own }]);
    }
  });
  it("preserves native batch and callback transactions without identity leakage", async () => {
    await run(0, async () => {
      const rows = await restricted.prisma.$transaction([
        restricted.prisma.artifact.findMany({ select: { id: true } }),
        restricted.prisma.message.findMany({ select: { id: true } }),
      ]);
      expect(rows.map((r) => r[0]?.id)).toEqual([actors[0]!.userId, actors[0]!.userId]);
      await expect(
        restricted.prisma.$transaction(async (tx) => {
          await tx.artifact.update({
            where: { id: actors[0]!.userId },
            data: { name: "rollback" },
          });
          throw new Error("test rollback");
        }),
      ).rejects.toThrow("test rollback");
    });
    expect(
      (await admin.prisma.artifact.findUniqueOrThrow({ where: { id: actors[0]!.userId } })).name,
    ).toBe("Synthetic");
    const state = await restricted.pool.query(
      "SELECT nullif(current_setting('app.user_id', true), '') AS actor",
    );
    expect(state.rows[0].actor).toBeNull();
    expect(
      (await run(1, () => restricted.prisma.artifact.findMany({ select: { id: true } })))[0]?.id,
    ).toBe(actors[1]!.userId);
  });
  it("blocks foreign writes and missing membership", async () => {
    const result = await run(0, () =>
      restricted.prisma.artifact.updateMany({
        where: { id: actors[1]!.userId },
        data: { name: "forbidden" },
      }),
    );
    expect(result.count).toBe(0);
    await expect(
      run(0, () =>
        restricted.prisma.artifact.create({
          data: {
            id: `foreign-${suffix}`,
            userId: actors[1]!.userId,
            spaceId: actors[1]!.spaceId,
            name: "forbidden",
            mimeType: "text/plain",
            size: 0,
            hash: "",
            storageKey: "",
          },
        }),
      ),
    ).rejects.toThrow();
    const membership = await admin.prisma.spaceMember.findFirstOrThrow({
      where: { userId: actors[0]!.userId, spaceId: actors[0]!.spaceId },
    });
    await admin.prisma.spaceMember.delete({ where: { id: membership.id } });
    try {
      expect(await run(0, () => restricted.prisma.artifact.findMany())).toEqual([]);
    } finally {
      await admin.prisma.spaceMember.create({ data: membership });
    }
    const otherSpace = { ...actors[0]!, spaceId: actors[1]!.spaceId };
    expect(
      (
        await withDatabaseActor(otherSpace, async () => ({
          output: await restricted.prisma.artifact.findMany(),
        }))
      ).output,
    ).toEqual([]);
  });
  it("rejects an additional permissive policy at startup", async () => {
    await sql.query("CREATE POLICY unwanted_allow ON artifacts USING (true)");
    const target = new URL(url!);
    target.username = role;
    target.password = "";
    const unsafe = createActorDb(target.href);
    try {
      await expect(unsafe.prisma.$connect()).rejects.toThrow("first-batch RLS policies");
    } finally {
      await unsafe.prisma.$disconnect();
      await unsafe.pool.end();
      await sql.query("DROP POLICY unwanted_allow ON artifacts");
    }
  });
  it("keeps parallel actors and deferred stream pulls isolated on one pooled connection", async () => {
    async function* stream() {
      yield await restricted.prisma.artifact.findMany({ select: { id: true } });
      yield await restricted.prisma.message.findMany({ select: { id: true } });
    }
    const streams = await Promise.all(
      actors.map((actor) => withDatabaseActor(actor, async () => ({ output: stream() }))),
    );
    for (let pull = 0; pull < 2; pull++) {
      const result = await Promise.all(streams.map(({ output }) => output.next()));
      expect(result[0]!.value).toEqual([{ id: actors[0]!.userId }]);
      expect(result[1]!.value).toEqual([{ id: actors[1]!.userId }]);
    }
    expect(restricted.pool.totalCount).toBe(1);
    expect(restricted.pool.idleCount).toBe(1);
    await Promise.all(streams.map(({ output }) => output.return(undefined)));
  });
});
