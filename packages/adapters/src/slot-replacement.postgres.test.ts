import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  acquireSessionReplacement,
  configureSessionAdmissionBudget,
  createDb,
  listSessionAdmissions,
  releaseSessionReplacement,
  setDesiredSessionGeneration,
} from "@rakazo/db";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SlotPlatform, SlotTarget } from "./slot-replacement.js";
import { replaceWorkerSlot } from "./slot-replacement.js";

const url = process.env.SESSION_ADMISSION_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const quiesced = {
  withQuiescedSlot: async <T>(run: (assert: () => Promise<void>) => Promise<T>) =>
    run(async () => {}),
};
type Child = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  id: string;
  target: SlotTarget;
  port: number;
  applicationName: string;
};
const targets: SlotTarget[] = ["worker-a", "worker-b"].map((slot) => ({
  slot: slot as SlotTarget["slot"],
  appId: `synthetic-${slot}`,
  appName: `synthetic-${slot}`,
  entry: `synthetic-${slot}.py`,
  environment: "local-test",
}));
class LocalProcessPlatform implements SlotPlatform {
  readonly children: Child[] = [];
  readonly mutations: string[] = [];
  constructor(private readonly behavior = "normal") {}
  private binding(target: SlotTarget) {
    const known = targets.find((item) => item.slot === target.slot);
    if (!known || JSON.stringify(known) !== JSON.stringify(target))
      throw new Error("Local target binding mismatch");
  }
  async validateTarget(target: SlotTarget, generation: string) {
    this.binding(target);
    if (generation !== "g2") throw new Error("Unapproved synthetic generation");
  }
  async launch(target: SlotTarget, generation: string, behavior = "normal") {
    this.binding(target);
    const child = spawn(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("./slot-replacement.fixture.ts", import.meta.url)),
        url!,
        target.slot,
        generation,
        behavior,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (data) => {
      error += String(data);
    });
    const record: Child = {
      process: child,
      id: String(child.pid),
      target,
      port: 0,
      applicationName: "",
    };
    this.children.push(record);
    const data = await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error(`Synthetic worker exited before readiness: ${error}`);
      }),
    ]);
    const ready = JSON.parse(String(data[0]));
    record.port = ready.port;
    record.applicationName = ready.applicationName;
    return record;
  }
  async containers(target: SlotTarget) {
    this.binding(target);
    return this.children
      .filter(
        (child) =>
          child.target.slot === target.slot &&
          child.process.exitCode === null &&
          child.process.signalCode === null,
      )
      .map((child) => child.id);
  }
  private child(target: SlotTarget, id: string) {
    this.binding(target);
    const child = this.children.find((item) => item.id === id && item.target.slot === target.slot);
    if (!child) throw new Error("Unknown synthetic process");
    return child;
  }
  async health(target: SlotTarget, id: string) {
    const child = this.child(target, id);
    const response = await fetch(`http://127.0.0.1:${child.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.json() as Promise<{
      ok: boolean;
      state: string;
      identity: { instanceId: string; generation: string; service: string };
      ticks: number;
    }>;
  }
  async finished(target: SlotTarget, id: string) {
    const child = this.child(target, id);
    return child.process.exitCode !== null || child.process.signalCode !== null;
  }
  async drain(target: SlotTarget, id: string, timeoutSeconds: number) {
    this.mutations.push("drain");
    this.child(target, id).process.kill("SIGUSR2");
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      if ((await this.health(target, id)).state === "drained") return;
      if (Date.now() >= deadline) throw new Error("Synthetic drain timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async stop(target: SlotTarget, id: string) {
    this.mutations.push("stop");
    this.child(target, id).process.kill("SIGTERM");
  }
  async deploy(target: SlotTarget, generation: string) {
    this.mutations.push("deploy");
    await this.launch(target, generation);
  }
  async start() {
    await Promise.all([
      this.launch(targets[0]!, "g1", this.behavior),
      this.launch(targets[1]!, "g1"),
    ]);
  }
  async close() {
    await Promise.all(
      this.children.map(async (child) => {
        if (child.process.exitCode === null && child.process.signalCode === null) {
          const exited = once(child.process, "exit");
          child.process.kill("SIGKILL");
          await exited;
        }
      }),
    );
  }
}
suite("slot replacement controller with local processes and real PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let sql: Pool;
  let platform: LocalProcessPlatform | undefined;
  beforeAll(() => {
    const target = new URL(url!);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55434" ||
      target.pathname !== "/rakazo_c5_slots"
    )
      throw new Error("Dedicated local synthetic database required");
    db = createDb(url!, { poolMax: 2 });
    sql = new Pool({ connectionString: url, max: 1 });
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
    for (const target of targets)
      await setDesiredSessionGeneration(
        db.prisma,
        { service: target.slot, expectedGeneration: null, desiredGeneration: "g1" },
        quiesced,
      );
  });
  afterEach(async () => {
    await platform?.close();
    platform = undefined;
    await clean();
  });
  afterAll(async () => {
    await sql.end();
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const input = () => ({
    target: targets[0]!,
    peer: targets[1]!,
    expectedGeneration: "g1",
    generation: "g2",
    timeoutMs: 2000,
  });
  it("drains and exits the old process before spawning the new generation, keeping its peer ready", async () => {
    platform = new LocalProcessPlatform();
    await platform.start();
    const old = platform.children[0]!;
    const peer = platform.children.find((child) => child.target.slot === "worker-b")!;
    const peerBefore = await platform.health(peer.target, peer.id);
    const result = await replaceWorkerSlot(db.prisma, platform, input());
    expect(result.status).toBe("completed");
    expect(platform.mutations).toEqual(["drain", "stop", "deploy"]);
    expect(await platform.finished(old.target, old.id)).toBe(true);
    expect((await platform.health(peer.target, peer.id)).state).toBe("ready");
    expect((await platform.health(peer.target, peer.id)).ticks).toBeGreaterThan(peerBefore.ticks);
    expect(
      (await listSessionAdmissions(db.prisma)).find((row) => row.service === "worker-a")
        ?.generation,
    ).toBe("g2");
    expect(
      (await sql.query('SELECT "replacementToken" FROM session_admission_budget')).rows[0]
        .replacementToken,
    ).toBeNull();
  });
  it("drain timeout never stops or deploys and preserves the ready peer", async () => {
    platform = new LocalProcessPlatform("drain-timeout");
    await platform.start();
    const result = await replaceWorkerSlot(db.prisma, platform, { ...input(), timeoutMs: 100 });
    expect(result.status).toBe("postponed");
    expect(platform.mutations).toEqual(["drain"]);
    expect(result).toMatchObject({ mutated: true });
    const peer = platform.children.find((child) => child.target.slot === "worker-b")!;
    expect((await platform.health(peer.target, peer.id)).state).toBe("ready");
    expect(await listSessionAdmissions(db.prisma)).toHaveLength(2);
    expect(
      (await sql.query('SELECT "replacementToken" FROM session_admission_budget')).rows[0]
        .replacementToken,
    ).not.toBeNull();
  });
  it("does not deploy when the old process stays alive even though its sessions are zero", async () => {
    platform = new LocalProcessPlatform("hang-stop");
    await platform.start();
    const old = platform.children.find((child) => child.target.slot === "worker-a")!;
    const result = await replaceWorkerSlot(db.prisma, platform, { ...input(), timeoutMs: 100 });
    expect(result.status).toBe("postponed");
    expect(platform.mutations).toEqual(["drain", "stop"]);
    expect(await platform.finished(old.target, old.id)).toBe(false);
    expect(
      Number(
        (
          await sql.query("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", [
            old.applicationName,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      (await listSessionAdmissions(db.prisma)).find((row) => row.service === "worker-a")?.status,
    ).toBe("closing");
  });
  it("wrong binding produces no process mutation", async () => {
    platform = new LocalProcessPlatform();
    const result = await replaceWorkerSlot(db.prisma, platform, {
      ...input(),
      target: { ...targets[0]!, appId: "wrong-local-binding" },
    });
    expect(result.status).toBe("postponed");
    expect(platform.mutations).toEqual([]);
    expect(platform.children).toHaveLength(0);
    // Nothing changed, so the controller lease is released for the next attempt.
    expect(result).toMatchObject({ mutated: false });
    expect(
      (await sql.query('SELECT "replacementToken" FROM session_admission_budget')).rows[0]
        .replacementToken,
    ).toBeNull();
  });
  it("an existing replacement controller blocks a second controller before any process mutation", async () => {
    platform = new LocalProcessPlatform();
    const claim = await acquireSessionReplacement(db.prisma, {
      owner: "external-synthetic-controller",
    });
    await expect(replaceWorkerSlot(db.prisma, platform, input())).rejects.toThrow(
      /already reserved/,
    );
    expect(platform.mutations).toEqual([]);
    await releaseSessionReplacement(db.prisma, claim);
  });
});
