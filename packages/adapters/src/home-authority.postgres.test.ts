import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createDb } from "@rakazo/db";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  checkpointAndRecordComputerWorkspace,
  claimComputerWorkspaceMaintenance,
} from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { AuthoritativeAgentHomeStore } from "./home-authoritative-store.js";
import type { HomeCutoverDriver } from "./home-authority.js";
import {
  activateHomeMigration,
  homeAuthority,
  homeSnapshotKey,
  inspectHomeMigration,
  nextHomeRevision,
} from "./home-authority.js";
import { assertHomeStorageConfiguration, packSnapshot } from "./home-replicated.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("authoritative homes on isolated PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  const ids: string[] = [];
  const roots: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const remote = {
    async getObject(key: string) {
      return objects.get(key) ?? null;
    },
    async putObject(key: string, bytes: Uint8Array) {
      objects.set(key, bytes.slice());
    },
    async removeObjects(keys: string[]) {
      for (const key of keys) objects.delete(key);
    },
  };
  const signal = new AbortController().signal;
  // Synthetic deployment: there are no legacy processes. Real driver remains a deployment gate.
  const driver: HomeCutoverDriver = {
    async withStoppedLegacyWriters(run) {
      return run(async () => {});
    },
  };
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || !["/rakazo_c5", "/rakazo_c5_final"].includes(url.pathname))
      throw new Error("Requires dedicated local rakazo_c5 database");
    db = createDb(url.toString(), { poolMax: 2 });
  });
  afterEach(async () => {
    await db.prisma.homeAuthorityCutover.deleteMany();
    await db.prisma.organization.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.user.deleteMany({ where: { id: { in: ids.splice(0) } } });
    objects.clear();
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  async function fixture(scope = "team") {
    const id = randomUUID();
    ids.push(id);
    await db.prisma.user.create({
      data: { id, name: "Synthetic Home", email: `${id}@example.test` },
    });
    await db.prisma.organization.create({
      data: { id, name: "Synthetic Home", slug: id, createdAt: new Date() },
    });
    await db.prisma.space.create({ data: { id, organizationId: id, name: "Synthetic Home" } });
    await db.prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "member", createdAt: new Date() },
    });
    await db.prisma.spaceMember.create({
      data: { id, organizationId: id, spaceId: id, userId: id, createdAt: new Date() },
    });
    const computer = await db.prisma.computer.create({
      data: {
        id,
        spaceId: id,
        userId: id,
        scopeKey: id,
        scope,
        homeKey: id,
        kind: "modal",
        state: "stopped",
      },
    });
    const context = {
      userId: id,
      spaceId: id,
      operationId: randomUUID(),
      signal,
    } as AdapterContext;
    const bytes = await packSnapshot(
      (async function* () {
        yield {
          path: "notes.txt",
          content: new TextEncoder().encode("original"),
          executable: false,
        };
      })(),
    );
    const prefix = `agent-homes/${Buffer.from(id).toString("base64url")}`;
    objects.set(`${prefix}/current`, new TextEncoder().encode("legacy1"));
    objects.set(`${prefix}/legacy1`, bytes);
    return { id, computer, context, bytes, prefix };
  }
  async function activate() {
    const f = await fixture();
    const manifest = await inspectHomeMigration(db.prisma, remote, signal);
    const revisions = await activateHomeMigration(db.prisma, remote, manifest, signal, driver);
    return { ...f, revision: revisions.get(f.id)! };
  }
  async function store() {
    const root = await mkdtemp(join(tmpdir(), "rakazo-c5-authority-"));
    roots.push(root);
    return new AuthoritativeAgentHomeStore(root, remote, db.prisma);
  }
  it("activates only a complete, rechecked manifest into an independent namespace", async () => {
    const a = await fixture();
    await fixture();
    const manifest = await inspectHomeMigration(db.prisma, remote, signal);
    await expect(
      activateHomeMigration(db.prisma, remote, manifest.slice(0, 1), signal, driver),
    ).rejects.toThrow("incomplete");
    expect(await homeAuthority(db.prisma).read(a.id)).toBe("empty");
    const revisions = await activateHomeMigration(db.prisma, remote, manifest, signal, driver);
    objects.delete(`${a.prefix}/current`);
    objects.delete(`${a.prefix}/legacy1`);
    expect(objects.get(homeSnapshotKey(a.id, revisions.get(a.id)!))).toEqual(a.bytes);
    expect(await (await store()).readFile(a.id, "notes.txt", a.context)).toBe("original");
  });
  it("rejects a changed pointer, digest, malformed archive and lost quiescence", async () => {
    const f = await fixture();
    const manifest = await inspectHomeMigration(db.prisma, remote, signal);
    objects.set(`${f.prefix}/current`, new TextEncoder().encode("legacy2"));
    await expect(
      activateHomeMigration(db.prisma, remote, manifest, signal, driver),
    ).rejects.toThrow("pointer changed");
    objects.set(`${f.prefix}/current`, new TextEncoder().encode("legacy1"));
    objects.set(`${f.prefix}/legacy1`, new Uint8Array([1]));
    await expect(
      activateHomeMigration(db.prisma, remote, manifest, signal, driver),
    ).rejects.toThrow("integrity");
    const bad = await inspectHomeMigration(db.prisma, remote, signal);
    await expect(activateHomeMigration(db.prisma, remote, bad, signal, driver)).rejects.toThrow();
    await expect(
      activateHomeMigration(db.prisma, remote, manifest, signal, {
        async withStoppedLegacyWriters(run) {
          return run(async () => {
            throw new Error("writers still present");
          });
        },
      }),
    ).rejects.toThrow("writers still present");
    expect(await homeAuthority(db.prisma).read(f.id)).toBe("empty");
  });
  it("rejects legacy/same/malformed/skipped revisions but allows ordinary heartbeat", async () => {
    const f = await activate();
    for (const revision of [
      "legacy2",
      f.revision,
      "v2:01:bad",
      f.revision.replace("v2:1:", "v2:3:"),
    ])
      await expect(
        db.prisma.computer.update({ where: { id: f.id }, data: { homeRevision: revision } }),
      ).rejects.toThrow();
    await db.prisma.computer.update({ where: { id: f.id }, data: { state: "suspended" } });
    expect(await homeAuthority(db.prisma).read(f.id)).toBe(f.revision);
  });
  it("preserves legal cascade deletion while rejecting old homeKey reuse and identity swaps", async () => {
    const f = await activate();
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { homeKey: "different" } }),
    ).rejects.toThrow();
    await db.prisma.computer.delete({ where: { id: f.id } });
    await expect(
      db.prisma.computer.create({
        data: {
          id: f.id,
          spaceId: f.id,
          userId: f.id,
          scopeKey: f.id,
          homeKey: f.id,
          kind: "modal",
        },
      }),
    ).rejects.toThrow();
    await db.prisma.organization.delete({ where: { id: f.id } });
    expect(await db.prisma.homeAuthorityTombstone.count()).toBeGreaterThan(0);
  });
  it("allows exactly one concurrent CAS and rejects wrong scope/maintenance owner", async () => {
    const f = await activate();
    const authority = homeAuthority(db.prisma);
    await db.prisma.computerUpdate.create({
      data: { id: f.context.operationId, computerId: f.id, botId: "synthetic", status: "running" },
    });
    await db.prisma.computer.update({
      where: { id: f.id },
      data: { maintenanceId: f.context.operationId },
    });
    const next = nextHomeRevision(f.revision, f.bytes);
    const results = await Promise.allSettled([
      authority.publish(f.id, f.revision, next, f.context),
      authority.publish(f.id, f.revision, next, f.context),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      authority.publish(f.id, next, nextHomeRevision(next, f.bytes), {
        ...f.context,
        userId: "other",
      }),
    ).rejects.toThrow("membership");
    await db.prisma.computer.update({ where: { id: f.id }, data: { maintenanceId: "other" } });
    await expect(
      authority.publish(f.id, next, nextHomeRevision(next, f.bytes), f.context),
    ).rejects.toThrow("reserved");
  });
  it("captures before export, rejects stale commit and refreshes dirty cache", async () => {
    const f = await activate();
    const a = await store();
    const b = await store();
    const expected = await a.captureRevision(f.id, f.context);
    await b.editStored(
      f.id,
      async (dir) => {
        await writeFile(join(dir, "notes.txt"), "winner");
      },
      f.context,
    );
    const src = await mkdtemp(join(tmpdir(), "rakazo-c5-src-"));
    roots.push(src);
    await writeFile(join(src, "notes.txt"), "stale");
    await db.prisma.computerUpdate.create({
      data: { id: f.context.operationId, computerId: f.id, botId: "synthetic", status: "running" },
    });
    await db.prisma.computer.update({
      where: { id: f.id },
      data: { maintenanceId: f.context.operationId },
    });
    await expect(a.commit(f.id, src, f.context, expected)).rejects.toThrow("conflict");
    expect(await a.readFile(f.id, "notes.txt", f.context)).toBe("winner");
  });
  it("accepts another current Team member with a live lease, rejects outsiders and dedicated access", async () => {
    const f = await activate();
    const user = randomUUID();
    ids.push(user);
    await db.prisma.user.create({
      data: { id: user, name: "Synthetic Member", email: `${user}@example.test` },
    });
    await db.prisma.member.create({
      data: { id: user, organizationId: f.id, userId: user, role: "member", createdAt: new Date() },
    });
    await db.prisma.spaceMember.create({
      data: { id: user, organizationId: f.id, spaceId: f.id, userId: user, createdAt: new Date() },
    });
    const runId = randomUUID();
    const botId = randomUUID();
    await db.prisma.computerExecutionLease.create({
      data: { computerId: f.id, botId, runId, fence: 2, expiresAt: new Date(Date.now() + 60_000) },
    });
    const member = { ...f.context, userId: user, runId, botId, screenLeaseId: `${runId}:2` };
    const authority = homeAuthority(db.prisma);
    const next = nextHomeRevision(f.revision, f.bytes);
    expect(await authority.read(f.id, member)).toBe(f.revision);
    await authority.publish(f.id, f.revision, next, member);
    await expect(
      authority.publish(f.id, next, nextHomeRevision(next, f.bytes), {
        ...member,
        spaceId: "wrong",
      }),
    ).rejects.toThrow("scope");
    await db.prisma.spaceMember.delete({ where: { id: user } });
    await expect(authority.read(f.id, member)).rejects.toThrow("membership");
    await expect(
      authority.publish(f.id, next, nextHomeRevision(next, f.bytes), member),
    ).rejects.toThrow("membership");
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { scope: "dedicated" } }),
    ).rejects.toThrow();
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { scopeKey: "changed" } }),
    ).rejects.toThrow();
    const dedicated = await fixture("dedicated");
    await expect(
      authority.read(dedicated.id, { ...member, spaceId: dedicated.id }),
    ).rejects.toThrow("scope");
  });
  it("requires real owners and rejects expired lifecycle and run fences", async () => {
    const f = await activate();
    const authority = homeAuthority(db.prisma);
    const next = nextHomeRevision(f.revision, f.bytes);
    await expect(authority.publish(f.id, f.revision, next, f.context)).rejects.toThrow("requires");
    await expect(
      authority.publish(f.id, f.revision, next, {
        ...f.context,
        runId: "run",
        botId: "bot",
        screenLeaseId: "run:1",
      }),
    ).rejects.toThrow("stale");
    const stamp = new Date();
    await db.prisma.computer.update({
      where: { id: f.id },
      data: { state: "suspending", providerRef: "provider", updatedAt: stamp },
    });
    const owned = {
      ...f.context,
      homeLifecycleClaim: { computerId: f.id, providerRef: "provider", updatedAt: stamp },
    };
    await authority.publish(f.id, f.revision, next, owned);
    await db.prisma.computer.update({
      where: { id: f.id },
      data: { updatedAt: new Date(stamp.getTime() + 1) },
    });
    await expect(
      authority.publish(f.id, next, nextHomeRevision(next, f.bytes), owned),
    ).rejects.toThrow("claim is stale");
  });
  it("verifies checkpoint revisions without repeating DB publication on both record paths", async () => {
    const f = await activate();
    const home = await store();
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision(
      { botId: "synthetic", homePath: "/ignored" },
      f.context,
    );
    await sandbox.writeFile(
      computer,
      { path: "notes.txt", content: new TextEncoder().encode("checkpoint") },
      f.context,
    );
    await db.prisma.computer.update({
      where: { id: f.id },
      data: { providerRef: computer.providerRef, state: "running" },
    });
    const maintenance = await claimComputerWorkspaceMaintenance(
      db.prisma,
      {
        computerId: f.id,
        botId: "synthetic",
        providerRef: computer.providerRef,
        where: { state: "running" },
      },
      f.context,
    );
    expect(maintenance).not.toBeNull();
    try {
      const revision = await checkpointAndRecordComputerWorkspace(
        { home, sandbox, prisma: db.prisma },
        { id: f.id, homeKey: f.id },
        computer,
        maintenance!.context,
      );
      await maintenance!.recordRevision(revision);
      expect(await homeAuthority(db.prisma).read(f.id)).toBe(revision);
      await expect(maintenance!.recordRevision(f.revision)).rejects.toThrow("interrupted");
    } finally {
      await maintenance!.finish("running", "completed");
    }
  });
  it("fails startup closed if storage configuration is removed after activation", async () => {
    await fixture();
    await assertHomeStorageConfiguration(db.prisma);
    const manifest = await inspectHomeMigration(db.prisma, remote, signal);
    await activateHomeMigration(db.prisma, remote, manifest, signal, driver);
    await expect(assertHomeStorageConfiguration(db.prisma)).rejects.toThrow(
      "fallback is forbidden",
    );
    await db.prisma.computer.deleteMany();
    await expect(assertHomeStorageConfiguration(db.prisma)).rejects.toThrow(
      "fallback is forbidden",
    );
  });
  it("reserves new homes after verified cutover and initializes exactly once across caches", async () => {
    await activate();
    const f = await fixture();
    expect(f.computer.homeRevision).toBe("v2:pending");
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { scope: "dedicated" } }),
    ).rejects.toThrow();
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { kind: "docker" } }),
    ).rejects.toThrow();
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { homeKey: "legacy-replacement" } }),
    ).rejects.toThrow();
    const a = await store();
    const b = await store();
    await Promise.all([a.initialize(f.id, f.context), b.initialize(f.id, f.context)]);
    const revision = await homeAuthority(db.prisma).read(f.id);
    expect(revision).toMatch(/^v2:1:/);
    expect(await a.list(f.id, "", f.context)).toEqual([]);
    expect(await b.captureRevision(f.id, f.context)).toBe(revision);
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { homeRevision: "legacy" } }),
    ).rejects.toThrow();
  });
  it("retries storage failure on pending only and forbids manufacturing pending by update", async () => {
    const existing = await fixture();
    await expect(
      db.prisma.computer.update({
        where: { id: existing.id },
        data: { homeRevision: "v2:pending" },
      }),
    ).rejects.toThrow();
    await activateHomeMigration(
      db.prisma,
      remote,
      await inspectHomeMigration(db.prisma, remote, signal),
      signal,
      driver,
    );
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "rakazo-c5-fail-"));
    roots.push(root);
    const broken = new AuthoritativeAgentHomeStore(
      root,
      {
        ...remote,
        async putObject() {
          throw new Error("storage unavailable");
        },
      },
      db.prisma,
    );
    await expect(broken.initialize(f.id, f.context)).rejects.toThrow("storage unavailable");
    expect(await homeAuthority(db.prisma).read(f.id)).toBe("v2:pending");
    await (await store()).initialize(f.id, f.context);
    expect(await homeAuthority(db.prisma).read(f.id)).toMatch(/^v2:1:/);
    await expect(
      db.prisma.computer.update({ where: { id: f.id }, data: { homeRevision: "v2:pending" } }),
    ).rejects.toThrow();
  });
  it("allows restricted actor creation after cutover, then verified system initialization", async () => {
    const f = await activate();
    const role = `home_create_${process.pid}_${Date.now()}`;
    await db.pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await db.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON computers TO ${role}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = role;
    const actor = new Pool({ connectionString: url.toString(), max: 1 });
    const id = randomUUID();
    try {
      await actor.query(
        'INSERT INTO computers (id,"spaceId","userId","scopeKey","homeKey",kind,"updatedAt") VALUES ($1,$2,$2,$1,$1,\'modal\',now())',
        [id, f.id],
      );
      expect(await homeAuthority(db.prisma).read(id)).toBe("v2:pending");
      await expect(
        actor.query("UPDATE computers SET \"homeRevision\"='legacy' WHERE id=$1", [id]),
      ).rejects.toThrow();
      await (await store()).initialize(id, f.context);
      expect(await homeAuthority(db.prisma).read(id)).toMatch(/^v2:1:/);
    } finally {
      await actor.end();
      await db.pool.query(`DROP OWNED BY ${role}`);
      await db.pool.query(`DROP ROLE ${role}`);
    }
  });
  it("never falls back to legacy when authoritative bytes are missing or corrupt", async () => {
    const f = await activate();
    const key = homeSnapshotKey(f.id, f.revision);
    objects.delete(key);
    await expect((await store()).readFile(f.id, "notes.txt", f.context)).rejects.toThrow(
      "fallback",
    );
    objects.set(key, new Uint8Array([1]));
    await expect((await store()).readFile(f.id, "notes.txt", f.context)).rejects.toThrow("digest");
  });
});
