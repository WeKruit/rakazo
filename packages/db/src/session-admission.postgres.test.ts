import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createActorDb, withDatabaseActor } from "./actor-db.js";
import { createDb } from "./client.js";
import {
  beginSessionAdmissionShutdown,
  acquireSessionReplacement,
  releaseSessionReplacement,
  configureSessionAdmissionBudget,
  listSessionAdmissions,
  registerSessionConnection,
  releaseSessionAdmission,
  reserveSessionAdmission,
  setDesiredSessionGeneration,
} from "./session-admission.js";
import type {
  QuiescedSessionSlotDriver,
  StoppedSessionInstanceDriver,
} from "./session-admission.js";

const url = process.env.SESSION_ADMISSION_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
// Synthetic drivers: these tests own every connection/process represented by their fixtures.
const stopped: StoppedSessionInstanceDriver = { withStoppedInstance: (run) => run(async () => {}) };
const quiesced: QuiescedSessionSlotDriver = { withQuiescedSlot: (run) => run(async () => {}) };
suite("global session admission on dedicated real PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  let sql: Pool;
  let actor: Pool;
  let actorUrl: string;
  const role = `slots_actor_${process.pid}_${Date.now()}`;
  const metadata = [
    "session_admission_generations",
    "session_admission_budget",
    "session_admissions",
    "session_admission_connections",
  ];
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55434" ||
      target.pathname !== "/rakazo_c5_slots"
    )
      throw new Error("Requires dedicated local synthetic rakazo_c5_slots database");
    db = createDb(url!, { poolMax: 4, applicationName: "slots-test-query" });
    other = createDb(url!, { poolMax: 4, applicationName: "slots-test-query-other" });
    sql = new Pool({ connectionString: url, max: 1 });
    await sql.query(
      await readFile(new URL("../prisma/rls/first-batch.sql", import.meta.url), "utf8"),
    );
    await sql.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await sql.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    target.username = role;
    target.password = "";
    actorUrl = target.toString();
    actor = new Pool({ connectionString: actorUrl, max: 1 });
  });
  beforeEach(async () => {
    await sql.query("DELETE FROM session_admissions");
    await sql.query("DELETE FROM session_admission_generations");
    await sql.query("DELETE FROM session_admission_budget");
    await sql.query("DELETE FROM home_authority_cutover");
  });
  afterAll(async () => {
    await actor?.end();
    if (sql) {
      await sql.query("DELETE FROM session_admissions");
      await sql.query("DELETE FROM session_admission_generations");
      await sql.query("DELETE FROM session_admission_budget");
      await sql.query("DELETE FROM home_authority_cutover");
      await sql.query(`DROP OWNED BY ${role}`);
      await sql.query(`DROP ROLE ${role}`);
      await sql.end();
    }
    for (const client of [db, other])
      if (client) {
        await client.prisma.$disconnect();
        await client.pool.end();
      }
  });
  const receipt = async () => {
    await sql.query(
      "INSERT INTO home_authority_cutover(id,\"manifestDigest\") VALUES ('verified',$1)",
      ["a".repeat(64)],
    );
    await configureSessionAdmissionBudget(db.prisma, { externalReservedSessions: 1 }, quiesced);
  };
  const reserve = (service: "api" | "worker-a" | "worker-b" = "api", generation = "g1") =>
    reserveSessionAdmission(db.prisma, { service, instanceId: randomUUID(), generation });
  async function desired(service: "worker-a" | "worker-b", generation = "g1") {
    await setDesiredSessionGeneration(
      db.prisma,
      { service, expectedGeneration: null, desiredGeneration: generation },
      quiesced,
    );
  }
  async function connected(name: string) {
    const client = new Client({ connectionString: url, application_name: name });
    await client.connect();
    const result = await client.query(
      'SELECT pg_backend_pid() AS "backendPid", backend_start::text AS "backendStart", current_setting(\'application_name\') AS "applicationName" FROM pg_stat_activity WHERE pid=pg_backend_pid()',
    );
    return {
      client,
      observed: result.rows[0] as {
        backendPid: number;
        backendStart: string;
        applicationName: string;
      },
    };
  }
  it("requires a verified cutover and explicit desired worker generation", async () => {
    await expect(reserve()).rejects.toThrow(/verified home cutover/);
    await receipt();
    await expect(reserve("worker-a")).rejects.toThrow(/not desired/);
    await desired("worker-a");
    expect((await reserve("worker-a")).reservedSessions).toBe(5);
  });
  it("serializes independent containers and admits exactly fourteen APIs plus one explicit external session", async () => {
    await receipt();
    const results = await Promise.allSettled(
      Array.from({ length: 22 }, (_, i) =>
        reserveSessionAdmission(i % 2 ? db.prisma : other.prisma, {
          service: "api",
          instanceId: randomUUID(),
          generation: "g1",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(14);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(8);
    expect(
      (await listSessionAdmissions(db.prisma)).reduce((n, r) => n + r.reservedSessions, 0),
    ).toBe(14);
  });
  it("requires explicit nonzero external headroom and refuses implicit budget changes", async () => {
    await expect(
      configureSessionAdmissionBudget(db.prisma, { externalReservedSessions: 0 }, quiesced),
    ).rejects.toThrow(/between one and fourteen/);
    await receipt();
    await expect(
      configureSessionAdmissionBudget(db.prisma, { externalReservedSessions: 2 }, quiesced),
    ).rejects.toThrow();
    await sql.query("DELETE FROM session_admission_budget");
    await expect(reserve()).rejects.toThrow(/budget is required/);
    await configureSessionAdmissionBudget(db.prisma, { externalReservedSessions: 5 }, quiesced);
    for (let i = 0; i < 10; i++) await reserve();
    await expect(reserve()).rejects.toThrow(/capacity exceeded/);
    await expect(
      configureSessionAdmissionBudget(db.prisma, { externalReservedSessions: 1 }, quiesced),
    ).rejects.toThrow(/no admitted instances/);
  });
  it("fails closed for a different session owner and changed observer identity", async () => {
    await receipt();
    const reservation = await reserve();
    const client = new Client({
      connectionString: actorUrl,
      application_name: reservation.sessionApplicationName,
    });
    await client.connect();
    try {
      const result = await client.query(
        'SELECT pg_backend_pid() AS "backendPid", backend_start::text AS "backendStart", current_setting(\'application_name\') AS "applicationName" FROM pg_stat_activity WHERE pid=pg_backend_pid()',
      );
      await expect(
        registerSessionConnection(db.prisma, { ...reservation, ...result.rows[0] }),
      ).rejects.toThrow(/not observable/);
    } finally {
      await client.end();
    }
    await sql.query('UPDATE session_admissions SET "observerRole"=$1 WHERE token=$2', [
      role,
      reservation.token,
    ]);
    await expect(releaseSessionAdmission(db.prisma, reservation, stopped)).rejects.toThrow(
      /observer identity/,
    );
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
  });
  it("excludes concurrent replacement controllers and never expires a failed owner", async () => {
    await receipt();
    const results = await Promise.allSettled([
      acquireSessionReplacement(db.prisma, { owner: "controller-a" }),
      acquireSessionReplacement(other.prisma, { owner: "controller-b" }),
    ]);
    const success = results.filter((result) => result.status === "fulfilled");
    expect(success).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const held = success[0]!;
    if (held.status !== "fulfilled") throw new Error("Missing controller fixture");
    await expect(
      acquireSessionReplacement(db.prisma, { owner: "crash-replacement" }),
    ).rejects.toThrow(/already reserved/);
    await expect(
      releaseSessionReplacement(db.prisma, { ...held.value, owner: "wrong-owner" }),
    ).rejects.toThrow(/Stale/);
    await expect(
      releaseSessionReplacement(db.prisma, { ...held.value, token: randomUUID() }),
    ).rejects.toThrow(/Stale/);
    await releaseSessionReplacement(db.prisma, held.value);
    await expect(releaseSessionReplacement(db.prisma, held.value)).rejects.toThrow(/Stale/);
    const replacement = await acquireSessionReplacement(db.prisma, { owner: "next-controller" });
    expect(replacement.token).not.toBe(held.value.token);
    await releaseSessionReplacement(db.prisma, replacement);
  });
  it("holds crashed worker slots without TTL and respects worker5 + worker5 + API4 + external1", async () => {
    await receipt();
    await desired("worker-a");
    await desired("worker-b");
    await reserve("worker-a");
    await reserve("worker-b");
    await sql.query("UPDATE session_admissions SET \"createdAt\"=now()-interval '1 year'");
    await expect(reserve("worker-a")).rejects.toThrow(/already reserved/);
    for (let i = 0; i < 4; i++) await reserve();
    await expect(reserve()).rejects.toThrow(/capacity exceeded/);
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(6);
  });
  it("requires closing and desired-generation rotation before worker replacement", async () => {
    await receipt();
    await desired("worker-a");
    const old = await reserve("worker-a");
    const replacement = await acquireSessionReplacement(db.prisma, {
      owner: "rotation-controller",
    });
    const next = {
      replacement,
      service: "worker-a" as const,
      expectedGeneration: "g1",
      desiredGeneration: "g2",
    };
    await expect(setDesiredSessionGeneration(db.prisma, next, quiesced)).rejects.toThrow(
      /Close old worker/,
    );
    await expect(releaseSessionAdmission(db.prisma, old, stopped)).rejects.toThrow(
      /Rotate desired/,
    );
    await expect(
      setDesiredSessionGeneration(
        db.prisma,
        { ...next, replacement: { ...replacement, token: randomUUID() } },
        quiesced,
      ),
    ).rejects.toThrow(/global replacement claim/);
    await setDesiredSessionGeneration(db.prisma, next, quiesced);
    await expect(setDesiredSessionGeneration(db.prisma, next, quiesced)).rejects.toThrow(
      /generation conflict/,
    );
    await expect(reserve("worker-a", "g1")).rejects.toThrow(/not desired/);
    await expect(reserve("worker-a", "g2")).rejects.toThrow(/already reserved/);
    await releaseSessionAdmission(db.prisma, old, stopped);
    expect((await reserve("worker-a", "g2")).generation).toBe("g2");
    await expect(releaseSessionAdmission(db.prisma, old, stopped)).rejects.toThrow(/Stale/);
    await releaseSessionReplacement(db.prisma, replacement);
  });
  it("observes actual backend identity and refuses live or late connections at release", async () => {
    await receipt();
    const reservation = await reserve();
    const session = await connected(reservation.sessionApplicationName);
    try {
      await registerSessionConnection(db.prisma, { ...reservation, ...session.observed });
      await expect(
        registerSessionConnection(db.prisma, {
          ...reservation,
          ...session.observed,
          backendStart: "2000-01-01T00:00:00Z",
        }),
      ).rejects.toThrow(/not observable/);
      await expect(
        registerSessionConnection(db.prisma, {
          ...reservation,
          ...session.observed,
          applicationName: "wrong",
        }),
      ).rejects.toThrow(/name mismatch/);
      await expect(releaseSessionAdmission(db.prisma, reservation, stopped)).rejects.toThrow(
        /still present/,
      );
      await expect(
        registerSessionConnection(db.prisma, { ...reservation, ...session.observed }),
      ).rejects.toThrow(/admission is closed/);
      expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
    } finally {
      await session.client.end();
    }
    await releaseSessionAdmission(db.prisma, reservation, stopped);
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(0);
  });
  it("counts unregistered physical connections and rejects excess session cost", async () => {
    await receipt();
    const reservation = await reserve();
    const a = await connected(reservation.sessionApplicationName);
    const b = await connected(reservation.sessionApplicationName);
    try {
      await expect(
        registerSessionConnection(db.prisma, { ...reservation, ...a.observed }),
      ).rejects.toThrow(/exceed reserved/);
      await expect(releaseSessionAdmission(db.prisma, reservation, stopped)).rejects.toThrow(
        /still present/,
      );
    } finally {
      await Promise.all([a.client.end(), b.client.end()]);
    }
    await releaseSessionAdmission(db.prisma, reservation, stopped);
  });
  it("keeps reservation charged if the stopped-instance driver cannot prove shutdown", async () => {
    await receipt();
    const reservation = await reserve();
    await expect(
      releaseSessionAdmission(db.prisma, reservation, {
        withStoppedInstance: async () => {
          throw new Error("old instance may resume");
        },
      }),
    ).rejects.toThrow(/may resume/);
    expect((await listSessionAdmissions(db.prisma))[0]?.status).toBe("closing");
    await expect(
      beginSessionAdmissionShutdown(db.prisma, { ...reservation, token: randomUUID() }),
    ).rejects.toThrow(/Stale/);
  });
  it("denies ordinary actors metadata mutation and fails startup for unsafe metadata", async () => {
    await receipt();
    const reservation = await reserve();
    expect((await actor.query("SELECT * FROM session_admissions")).rows).toEqual([]);
    await expect(
      actor.query(
        "INSERT INTO session_admission_generations(service,generation) VALUES ('worker-a','bad')",
      ),
    ).rejects.toThrow(/row-level security/);
    expect((await actor.query("DELETE FROM session_admissions")).rowCount).toBe(0);
    expect(
      (
        await actor.query(
          "UPDATE session_admission_budget SET \"replacementToken\"='bad', \"replacementOwner\"='bad'",
        )
      ).rowCount,
    ).toBe(0);
    expect((await actor.query("UPDATE session_admissions SET status='closing'")).rowCount).toBe(0);
    await expect(
      actor.query(
        'INSERT INTO session_admission_connections(token,pid,"backendStart") VALUES ($1,1,now())',
        [reservation.token],
      ),
    ).rejects.toThrow(/row-level security/);
    async function startup() {
      const restricted = createActorDb(actorUrl, { poolMax: 1 });
      try {
        await withDatabaseActor({ userId: "synthetic", spaceId: "synthetic" }, async () => ({
          output: await restricted.prisma.$queryRaw`SELECT 1`,
        }));
      } finally {
        await restricted.prisma.$disconnect();
        await restricted.pool.end();
      }
    }
    await startup();
    for (const table of metadata) {
      await sql.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      try {
        await expect(startup()).rejects.toThrow(/system-only/);
      } finally {
        await sql.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      }
      await sql.query(`CREATE POLICY unsafe_slot_test ON ${table} USING (true)`);
      try {
        await expect(startup()).rejects.toThrow(/system-only/);
      } finally {
        await sql.query(`DROP POLICY unsafe_slot_test ON ${table}`);
      }
      await sql.query(`ALTER TABLE ${table} RENAME TO slot_metadata_test_hidden`);
      try {
        await expect(startup()).rejects.toThrow(/system-only/);
      } finally {
        await sql.query(`ALTER TABLE slot_metadata_test_hidden RENAME TO ${table}`);
      }
    }
  });
});
