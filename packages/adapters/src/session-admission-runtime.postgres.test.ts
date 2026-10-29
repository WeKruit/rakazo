import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  acquireSessionReplacement,
  beginSessionAdmissionShutdown,
  configureSessionAdmissionBudget,
  createDb,
  createPool,
  listSessionAdmissions,
  registerSessionConnection,
  releaseSessionAdmission,
  releaseSessionReplacement,
  reserveSessionAdmission,
  setDesiredSessionGeneration,
} from "@rakazo/db";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeListenerClient } from "./realtime.js";
import { PostgresRealtimeFanout } from "./realtime.js";
import { SessionAdmissionRuntime } from "./session-admission-runtime.js";

const url = process.env.SESSION_ADMISSION_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const quiesced = {
  withQuiescedSlot: async <T>(run: (assert: () => Promise<void>) => Promise<T>) =>
    run(async () => {}),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
suite("session owners against isolated real PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let sql: Pool;
  beforeAll(() => {
    const target = new URL(url!);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55434" ||
      target.pathname !== "/rakazo_c5_slots"
    )
      throw new Error("Requires dedicated local synthetic rakazo_c5_slots");
    db = createDb(url!, { poolMax: 2, applicationName: "runtime-test-query" });
    sql = new Pool({ connectionString: url, max: 1, application_name: "runtime-test-observer" });
  });
  async function clean() {
    await sql.query("DELETE FROM session_admissions");
    await sql.query("DELETE FROM session_admission_generations");
    await sql.query("DELETE FROM session_admission_budget");
    await sql.query("DELETE FROM home_authority_cutover");
  }
  beforeEach(async () => {
    await clean();
    await sql.query(
      "INSERT INTO home_authority_cutover(id,\"manifestDigest\") VALUES ('verified',$1)",
      ["a".repeat(64)],
    );
    await configureSessionAdmissionBudget(db.prisma, { externalReservedSessions: 1 }, quiesced);
  });
  afterAll(async () => {
    if (sql) {
      await clean();
      await sql.end();
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function runtime(service: "api" | "worker-a" = "api") {
    if (service !== "api")
      await setDesiredSessionGeneration(
        db.prisma,
        { service, expectedGeneration: null, desiredGeneration: "g1" },
        quiesced,
      );
    return new SessionAdmissionRuntime(
      db.prisma,
      await reserveSessionAdmission(db.prisma, {
        service,
        instanceId: randomUUID(),
        generation: "g1",
      }),
    );
  }
  const count = async (name: string) =>
    Number(
      (await sql.query("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", [name]))
        .rows[0].count,
    );
  function fanout(guard: SessionAdmissionRuntime, clientFactory?: () => RealtimeListenerClient) {
    return new PostgresRealtimeFanout({
      connectionString: url!,
      publisher: sql,
      applicationName: guard.admission.sessionApplicationName,
      assertConnectionAdmission: guard.assertConnectionAdmission,
      verifyConnection: guard.verifyConnection,
      clientFactory,
    });
  }
  it("runs pool four plus listener one and preserves worker reservation until desired rotation", async () => {
    const guard = await runtime("worker-a");
    const pool = createPool(url!, {
      poolMax: 4,
      applicationName: guard.admission.sessionApplicationName,
      verifyConnection: guard.verifyConnection,
    });
    const realtime = fanout(guard);
    guard.bindOwners(realtime, pool);
    const clients = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
    try {
      await realtime.subscribe("synthetic", () => {});
      await vi.waitFor(async () =>
        expect(await count(guard.admission.sessionApplicationName)).toBe(5),
      );
      await vi.waitFor(async () => {
        expect(
          Number(
            (
              await sql.query("SELECT count(*) FROM session_admission_connections WHERE token=$1", [
                guard.admission.token,
              ])
            ).rows[0].count,
          ),
        ).toBe(5);
      });
      const shutdown = guard.beginShutdown();
      let done = false;
      void shutdown.then(() => {
        done = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      for (const client of clients.splice(0)) client.release();
      await shutdown;
      await expect(pool.connect()).rejects.toThrow(/end|closed/i);
      await expect(realtime.subscribe("late", () => {})).rejects.toThrow(/closed/);
      await expect(guard.closeAndRelease()).rejects.toThrow(/Rotate desired/);
      expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
      const replacement = await acquireSessionReplacement(db.prisma, {
        owner: "synthetic-runtime-controller",
      });
      await setDesiredSessionGeneration(
        db.prisma,
        { service: "worker-a", expectedGeneration: "g1", desiredGeneration: "g2", replacement },
        quiesced,
      );
      await guard.closeAndRelease();
      await expect(
        reserveSessionAdmission(db.prisma, {
          service: "worker-a",
          instanceId: randomUUID(),
          generation: "g1",
        }),
      ).rejects.toThrow(/not desired/);
      expect(
        (
          await reserveSessionAdmission(db.prisma, {
            service: "worker-a",
            instanceId: randomUUID(),
            generation: "g2",
          })
        ).generation,
      ).toBe("g2");
      await releaseSessionReplacement(db.prisma, replacement);
    } finally {
      for (const client of clients) client.release();
      await guard.beginShutdown();
    }
  });
  it("two closes wait for a delayed physical listener connect and actual end", async () => {
    const guard = await runtime();
    const gate = deferred();
    const entered = deferred();
    const ending = deferred();
    const actual = new Client({
      connectionString: url,
      application_name: guard.admission.sessionApplicationName,
    });
    let connection: Promise<void> | undefined;
    const wrapped: RealtimeListenerClient = {
      connect() {
        entered.resolve();
        const pending = gate.promise.then(async () => {
          await actual.connect();
        });
        connection = pending;
        return pending;
      },
      query: (statement) => actual.query(statement),
      async end() {
        ending.resolve();
        await connection;
        await actual.end();
      },
      on(event: "notification" | "error" | "end", listener: (...args: any[]) => void) {
        actual.on(event, listener);
        return this;
      },
      removeAllListeners() {
        actual.removeAllListeners();
        return this;
      },
    };
    const realtime = fanout(guard, () => wrapped);
    guard.bindOwners(realtime);
    await realtime.subscribe("synthetic", () => {});
    await entered.promise;
    const first = realtime.close();
    const second = realtime.close();
    expect(second).toBe(first);
    const release = guard.closeAndRelease();
    let settled = false;
    void release.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await ending.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
    } finally {
      gate.resolve();
    }
    await Promise.all([first, second, release]);
    expect(await count(guard.admission.sessionApplicationName)).toBe(0);
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(0);
  });
  it("does not release after pool.end until a delayed physical client end event", async () => {
    const guard = await runtime();
    const pool = createPool(url!, {
      poolMax: 1,
      applicationName: guard.admission.sessionApplicationName,
      verifyConnection: guard.verifyConnection,
    });
    const realtime = fanout(guard);
    guard.bindOwners(realtime, pool);
    const client = await pool.connect();
    const gate = deferred();
    const ending = deferred();
    const originalEnd = client.end.bind(client);
    client.end = (() => {
      ending.resolve();
      return gate.promise.then(() => originalEnd());
    }) as typeof client.end;
    client.release();
    const release = guard.closeAndRelease();
    let done = false;
    void release.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    try {
      await ending.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      expect(await count(guard.admission.sessionApplicationName)).toBe(1);
      expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
    } finally {
      gate.resolve();
    }
    await release;
    expect(await count(guard.admission.sessionApplicationName)).toBe(0);
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(0);
  });
  it("retains a failed close promise and reservation even after the physical socket disappears", async () => {
    const guard = await runtime();
    const actual = new Client({
      connectionString: url,
      application_name: guard.admission.sessionApplicationName,
    });
    const wrapped: RealtimeListenerClient = {
      connect: () => actual.connect(),
      query: (statement) => actual.query(statement),
      async end() {
        await actual.end();
        throw new Error("synthetic shutdown confirmation failed");
      },
      on(event: "notification" | "error" | "end", listener: (...args: any[]) => void) {
        actual.on(event, listener);
        return this;
      },
      removeAllListeners() {
        actual.removeAllListeners();
        return this;
      },
    };
    const realtime = fanout(guard, () => wrapped);
    guard.bindOwners(realtime);
    await realtime.subscribe("synthetic", () => {});
    await vi.waitFor(async () =>
      expect(await count(guard.admission.sessionApplicationName)).toBe(1),
    );
    await expect(guard.closeAndRelease()).rejects.toThrow(/shutdown confirmation failed/);
    await expect(guard.closeAndRelease()).rejects.toThrow(/shutdown confirmation failed/);
    expect(await count(guard.admission.sessionApplicationName)).toBe(0);
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
  });
  it("refuses release while any tagged physical session remains outside the closed owners", async () => {
    const guard = await runtime();
    const realtime = fanout(guard);
    guard.bindOwners(realtime);
    const extra = new Client({
      connectionString: url,
      application_name: guard.admission.sessionApplicationName,
    });
    await extra.connect();
    try {
      await expect(guard.closeAndRelease()).rejects.toThrow(/still present/);
      expect((await listSessionAdmissions(db.prisma))[0]?.status).toBe("closing");
    } finally {
      await extra.end();
    }
    await guard.closeAndRelease();
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(0);
  });
  it("a killed child leaves its reservation charged; verified exit plus generation rotation permits replacement", async () => {
    await setDesiredSessionGeneration(
      db.prisma,
      { service: "worker-a", expectedGeneration: null, desiredGeneration: "g1" },
      quiesced,
    );
    const admission = await reserveSessionAdmission(db.prisma, {
      service: "worker-a",
      instanceId: randomUUID(),
      generation: "g1",
    });
    const script = `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const {Client}=require(process.argv[1]); const c=new Client({connectionString:process.argv[2],application_name:process.argv[3]}); await c.connect(); const r=await c.query('SELECT pg_backend_pid() AS "backendPid",backend_start::text AS "backendStart",current_setting(\\'application_name\\') AS "applicationName" FROM pg_stat_activity WHERE pid=pg_backend_pid()'); console.log(JSON.stringify(r.rows[0])); setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        createRequire(import.meta.url).resolve("pg"),
        url!,
        admission.sessionApplicationName,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (data) => {
      error += String(data);
    });
    try {
      const data = await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw new Error(`Synthetic child exited before ready: ${error}`);
        }),
      ]);
      const identity = JSON.parse(String(data[0]));
      await registerSessionConnection(db.prisma, { ...admission, ...identity });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await vi.waitFor(async () => expect(await count(admission.sessionApplicationName)).toBe(0));
      expect(await listSessionAdmissions(db.prisma)).toHaveLength(1);
      await expect(
        reserveSessionAdmission(db.prisma, {
          service: "worker-a",
          instanceId: randomUUID(),
          generation: "g1",
        }),
      ).rejects.toThrow(/already reserved/);
      await beginSessionAdmissionShutdown(db.prisma, admission);
      const replacement = await acquireSessionReplacement(db.prisma, {
        owner: "synthetic-runtime-controller",
      });
      await setDesiredSessionGeneration(
        db.prisma,
        { service: "worker-a", expectedGeneration: "g1", desiredGeneration: "g2", replacement },
        quiesced,
      );
      await releaseSessionAdmission(db.prisma, admission, {
        withStoppedInstance: (run) =>
          run(async () => {
            if (child.exitCode === null && child.signalCode === null)
              throw new Error("Child exit is not confirmed");
          }),
      });
      expect(
        (
          await reserveSessionAdmission(db.prisma, {
            service: "worker-a",
            instanceId: randomUUID(),
            generation: "g2",
          })
        ).generation,
      ).toBe("g2");
      await releaseSessionReplacement(db.prisma, replacement);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
});
