import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActorDb, withDatabaseActor } from "./actor-db.js";
import { createDb } from "./client.js";

const url = process.env.HOME_AUTHORITY_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("system-only home authority with an ordinary actor", () => {
  const role = `home_actor_${process.pid}_${Date.now()}`;
  const id = randomUUID();
  const retired = `retired-${id}`;
  const hash = createHash("sha256").update(retired).digest("hex");
  let admin: ReturnType<typeof createDb>;
  let sql: Pool;
  let actorSql: Pool;
  let actorUrl: string;
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55434" ||
      target.pathname !== "/rakazo_c5"
    )
      throw new Error("Requires dedicated synthetic local rakazo_c5 database");
    sql = new Pool({ connectionString: url, max: 1 });
    await sql.query(
      await readFile(new URL("../prisma/rls/first-batch.sql", import.meta.url), "utf8"),
    );
    await sql.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // Broad CRUD deliberately excludes TRUNCATE/DDL, which bypass RLS.
    await sql.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    target.username = role;
    target.password = "";
    actorUrl = target.toString();
    actorSql = new Pool({ connectionString: actorUrl, max: 1 });
    admin = createDb(url!, { poolMax: 1 });
    await admin.prisma.user.create({
      data: { id, name: "Synthetic", email: `${id}@example.test` },
    });
    await admin.prisma.organization.create({
      data: { id, name: "Synthetic", slug: id, createdAt: new Date() },
    });
    await admin.prisma.space.create({ data: { id, organizationId: id, name: "Synthetic" } });
    await sql.query('INSERT INTO home_authority_tombstones ("homeKeyHash") VALUES ($1)', [hash]);
  });
  afterAll(async () => {
    await actorSql?.end();
    if (admin) {
      await admin.prisma.organization.deleteMany({ where: { id } });
      await admin.prisma.user.deleteMany({ where: { id } });
      await admin.prisma.$disconnect();
      await admin.pool.end();
    }
    if (sql) {
      await sql.query('DELETE FROM home_authority_tombstones WHERE "homeKeyHash" = $1', [hash]);
      await sql.query(`DROP OWNED BY ${role}`);
      await sql.query(`DROP ROLE ${role}`);
      await sql.end();
    }
  });
  async function startup() {
    const client = createActorDb(actorUrl, { poolMax: 1 });
    try {
      return await withDatabaseActor({ userId: id, spaceId: id }, async () => ({
        output: await client.prisma.$queryRaw`SELECT 1`,
      }));
    } finally {
      await client.prisma.$disconnect();
      await client.pool.end();
    }
  }
  it("denies metadata CRUD despite broad grants and allows safe startup", async () => {
    await expect(startup()).resolves.toBeDefined();
    expect((await actorSql.query("SELECT * FROM home_authority_tombstones")).rows).toEqual([]);
    await expect(
      actorSql.query('INSERT INTO home_authority_tombstones ("homeKeyHash") VALUES ($1)', [
        "f".repeat(64),
      ]),
    ).rejects.toThrow(/row-level security/);
    expect(
      (
        await actorSql.query(
          'UPDATE home_authority_tombstones SET "homeKeyHash" = $1 WHERE "homeKeyHash" = $2',
          ["e".repeat(64), hash],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await actorSql.query('DELETE FROM home_authority_tombstones WHERE "homeKeyHash" = $1', [
          hash,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await sql.query('SELECT * FROM home_authority_tombstones WHERE "homeKeyHash" = $1', [hash]))
        .rowCount,
    ).toBe(1);
    await expect(actorSql.query("TRUNCATE home_authority_tombstones")).rejects.toThrow(
      /permission denied/,
    );
  });
  it("allows legacy CRUD but rejects retired keys, activation and v2 publication", async () => {
    const computerId = randomUUID();
    const keyHash = createHash("sha256").update(computerId).digest("hex");
    const insert = (home: string) =>
      actorSql.query(
        'INSERT INTO computers (id, "spaceId", "userId", "scopeKey", "homeKey", kind, "updatedAt") VALUES ($1,$2,$2,$1,$3,\'modal\',now())',
        [computerId, id, home],
      );
    await expect(insert(retired)).rejects.toThrow(/retired authoritative/);
    await insert(computerId);
    try {
      expect(
        (
          await actorSql.query(
            "UPDATE computers SET \"homeRevision\" = 'legacy-new' WHERE id = $1",
            [computerId],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        actorSql.query('UPDATE computers SET "homeKey" = $1 WHERE id = $2', [retired, computerId]),
      ).rejects.toThrow(/retired authoritative/);
      const revision = `v2:1:${"a".repeat(64)}`;
      await expect(
        actorSql.query('UPDATE computers SET "homeRevision" = $1 WHERE id = $2', [
          revision,
          computerId,
        ]),
      ).rejects.toThrow(/row-level security/);
      await sql.query('UPDATE computers SET "homeRevision" = $1 WHERE id = $2', [
        revision,
        computerId,
      ]);
      await expect(
        actorSql.query('UPDATE computers SET "homeRevision" = $1 WHERE id = $2', [
          `v2:2:${"b".repeat(64)}`,
          computerId,
        ]),
      ).rejects.toThrow(/system metadata access/);
      expect(
        (await actorSql.query("DELETE FROM computers WHERE id = $1", [computerId])).rowCount,
      ).toBe(1);
      await expect(insert(computerId)).rejects.toThrow(/retired authoritative/);
    } finally {
      await sql.query("DELETE FROM computers WHERE id = $1", [computerId]);
      await sql.query('DELETE FROM home_authority_tombstones WHERE "homeKeyHash" = $1', [keyHash]);
    }
  });
  it("permits legacy CRUD without direct metadata privileges", async () => {
    const computerId = randomUUID();
    await sql.query(`REVOKE ALL ON home_authority_tombstones FROM ${role}`);
    try {
      await actorSql.query(
        'INSERT INTO computers (id, "spaceId", "userId", "scopeKey", "homeKey", kind, "updatedAt") VALUES ($1,$2,$2,$1,$1,\'modal\',now())',
        [computerId, id],
      );
      expect(
        (
          await actorSql.query(
            "UPDATE computers SET \"homeRevision\" = 'legacy-next' WHERE id = $1",
            [computerId],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        actorSql.query('UPDATE computers SET "homeKey" = $1 WHERE id = $2', [retired, computerId]),
      ).rejects.toThrow(/retired authoritative/);
      expect(
        (await actorSql.query("DELETE FROM computers WHERE id = $1", [computerId])).rowCount,
      ).toBe(1);
    } finally {
      await sql.query("DELETE FROM computers WHERE id = $1", [computerId]);
      await sql.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON home_authority_tombstones TO ${role}`,
      );
    }
  });
  it("rejects startup if the authority table is missing", async () => {
    await sql.query("ALTER TABLE home_authority_tombstones RENAME TO home_authority_test_hidden");
    try {
      await expect(startup()).rejects.toThrow(/system-only home authority/);
    } finally {
      await sql.query("ALTER TABLE home_authority_test_hidden RENAME TO home_authority_tombstones");
    }
  });
  it("rejects startup with authority RLS disabled", async () => {
    await sql.query("ALTER TABLE home_authority_tombstones DISABLE ROW LEVEL SECURITY");
    try {
      await expect(startup()).rejects.toThrow(/system-only home authority/);
    } finally {
      await sql.query("ALTER TABLE home_authority_tombstones ENABLE ROW LEVEL SECURITY");
    }
  });
  it("rejects startup if any authority policy exists", async () => {
    await sql.query("CREATE POLICY unsafe_test_policy ON home_authority_tombstones USING (true)");
    try {
      await expect(startup()).rejects.toThrow(/system-only home authority/);
    } finally {
      await sql.query("DROP POLICY unsafe_test_policy ON home_authority_tombstones");
    }
  });
});
