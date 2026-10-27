import { randomUUID } from "node:crypto";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createDb } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_OAUTH_PROVIDER, PiOAuthLogins } from "./pi-oauth.js";
import { DurablePiOAuthLogins } from "./pi-oauth-durable.js";
import { PostgresRealtimeFanout } from "./realtime.js";
import { EncryptedSecretStore } from "./secrets.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
describePostgres("durable model OAuth (PostgreSQL)", () => {
  const databases: ReturnType<typeof createDb>[] = [];
  const services: DurablePiOAuthLogins[] = [];
  const fanouts: PostgresRealtimeFanout[] = [];
  const ids: string[] = [];
  let db: ReturnType<typeof createDb>;
  const secrets = new EncryptedSecretStore("synthetic-local-oauth-test-key");
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 2 });
    databases.push(db);
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.abortAll()));
    await Promise.all(fanouts.splice(0).map((f) => f.close()));
  });
  afterAll(async () => {
    await db.prisma.organization.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.user.deleteMany({ where: { id: { in: ids } } });
    for (const d of databases) {
      await d.prisma.$disconnect();
      await d.pool.end();
    }
  });
  async function fixture(login?: ConstructorParameters<typeof PiOAuthLogins>[0]) {
    const instance = createDb(process.env.DATABASE_URL!, { poolMax: 2 });
    databases.push(instance);
    const realtime = new PostgresRealtimeFanout({
      connectionString: process.env.DATABASE_URL!,
      publisher: instance.pool,
    });
    const publish = vi.spyOn(realtime, "publish");
    fanouts.push(realtime);
    const service = new DurablePiOAuthLogins(
      instance.prisma,
      secrets,
      realtime,
      new PiOAuthLogins(login),
    );
    services.push(service);
    return { service, publish };
  }
  async function actor() {
    const id = randomUUID();
    ids.push(id);
    await db.prisma.user.create({
      data: { id, name: "Synthetic OAuth", email: `${id}@example.test` },
    });
    await db.prisma.organization.create({
      data: { id, name: "Synthetic OAuth", slug: id, createdAt: new Date() },
    });
    await db.prisma.space.create({ data: { id, organizationId: id, name: "Synthetic OAuth" } });
    return { userId: id, spaceId: id };
  }
  async function login(_provider: string, _type: "oauth", interaction: AuthInteraction) {
    interaction.notify({ type: "auth_url", url: "https://example.test/oauth" });
    const code = await interaction.prompt({ type: "manual_code", message: "Paste code" });
    expect(code).toBe("synthetic-code");
    return {
      type: "oauth" as const,
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 60_000,
    };
  }
  it("starts on A, submits and completes on B, persists exactly once without client finish", async () => {
    const owner = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn(async () => {
      const credential = await db.prisma.userModelCredential.create({
        data: {
          userId: owner.userId,
          provider: "synthetic",
          secretId: "synthetic-secret",
          label: "Synthetic OAuth",
        },
      });
      return { id: credential.id, provider: credential.provider };
    });
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    expect(await b.service.complete(begun.loginId, owner)).toEqual({ status: "pending" });
    await b.service.submit(begun.loginId, owner, "synthetic-code");
    const row = await db.prisma.modelOAuthSession.findUniqueOrThrow({
      where: { id: begun.loginId },
    });
    expect(JSON.stringify(row)).not.toContain("synthetic-code");
    expect(b.publish.mock.calls.every(([, payload]) => payload === begun.loginId)).toBe(true);
    await vi.waitFor(
      async () =>
        expect(await b.service.complete(begun.loginId, owner)).toEqual({ status: "connected" }),
      { timeout: 5000 },
    );
    const forbiddenPersist = vi.fn();
    const [first, second] = await Promise.all([
      b.service.finish(begun.loginId, owner, forbiddenPersist),
      a.service.finish(begun.loginId, owner, forbiddenPersist),
    ]);
    expect(first).toEqual(second);
    expect(first.status).toBe("connected");
    expect(forbiddenPersist).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await db.prisma.userModelCredential.count({ where: { userId: owner.userId } })).toBe(1);
    expect(
      (await db.prisma.modelOAuthSession.findUniqueOrThrow({ where: { id: begun.loginId } }))
        .codeCiphertext,
    ).toBeNull();
  });
  it("rejects other users/spaces and remote cancellation prevents a late save", async () => {
    const owner = await actor();
    const other = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn();
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    for (const denied of [other, { ...owner, spaceId: other.spaceId }]) {
      expect((await b.service.complete(begun.loginId, denied)).status).toBe("error");
      await expect(b.service.submit(begun.loginId, denied, "synthetic-code")).rejects.toThrow(
        "not found",
      );
      await b.service.cancel(begun.loginId, denied);
    }
    await b.service.cancel(begun.loginId, owner);
    await expect(a.service.submit(begun.loginId, owner, "synthetic-code")).rejects.toThrow(
      "not found",
    );
    expect(persist).not.toHaveBeenCalled();
  });
  it("catches a lost notification and isolates simultaneous logins by space", async () => {
    const owner = await actor();
    const other = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    b.publish.mockRejectedValue(new Error("notification unavailable"));
    const persist = vi.fn(async () => ({ id: "synthetic-result" }));
    const first = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    const second = await b.service.begin({
      userId: owner.userId,
      spaceId: other.spaceId,
      provider: ANTHROPIC_OAUTH_PROVIDER,
      persist,
    });
    await b.service.submit(first.loginId, owner, "synthetic-code");
    await vi.waitFor(
      async () => expect((await b.service.complete(first.loginId, owner)).status).toBe("connected"),
      { timeout: 5000 },
    );
    expect(
      (await a.service.complete(second.loginId, { userId: owner.userId, spaceId: other.spaceId }))
        .status,
    ).toBe("pending");
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it("a replacement on B fences the original A login", async () => {
    const owner = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn(async () => ({ id: "synthetic-result" }));
    const first = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    const replacement = await b.service.begin({
      ...owner,
      provider: ANTHROPIC_OAUTH_PROVIDER,
      persist,
    });
    await expect(a.service.submit(first.loginId, owner, "synthetic-code")).rejects.toThrow();
    await a.service.submit(replacement.loginId, owner, "synthetic-code");
    await vi.waitFor(
      async () =>
        expect((await a.service.complete(replacement.loginId, owner)).status).toBe("connected"),
      { timeout: 5000 },
    );
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it("device-code completion saves on the owner before any finish request", async () => {
    const owner = await actor();
    const a = await fixture(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "SYNTHETIC",
        verificationUri: "https://example.test/device",
      });
      return {
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 60000,
      };
    });
    const b = await fixture(login);
    const persist = vi.fn(async () => ({ id: "device-result" }));
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    await vi.waitFor(
      async () => expect((await b.service.complete(begun.loginId, owner)).status).toBe("connected"),
      { timeout: 5000 },
    );
    expect(persist).toHaveBeenCalledTimes(1);
    await expect(b.service.submit(begun.loginId, owner, "synthetic-code")).rejects.toThrow(
      "not waiting",
    );
  });
  it("remote cancel waits for an in-flight save and prevents receipt reuse", async () => {
    const owner = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = vi.fn(async () => {
      await gate;
      return { id: "saved" };
    });
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    await b.service.submit(begun.loginId, owner, "synthetic-code");
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1), { timeout: 5000 });
    let cancelled = false;
    const cancellation = b.service.cancel(begun.loginId, owner).then(() => {
      cancelled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cancelled).toBe(false);
    } finally {
      release();
    }
    await cancellation;
    expect((await a.service.finish(begun.loginId, owner, vi.fn())).status).toBe("error");
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it("expired sessions cannot submit or finish and their encrypted code is removed", async () => {
    const owner = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn(async () => ({ id: "expired" }));
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    await db.prisma.modelOAuthSession.update({
      where: { id: begun.loginId },
      data: { expiresAt: new Date(0), codeCiphertext: "synthetic-expired-ciphertext" },
    });
    await expect(b.service.submit(begun.loginId, owner, "synthetic-code")).rejects.toThrow(
      "not found",
    );
    expect((await b.service.finish(begun.loginId, owner, vi.fn())).status).toBe("error");
    await vi.waitFor(async () =>
      expect(
        (await db.prisma.modelOAuthSession.findUniqueOrThrow({ where: { id: begun.loginId } }))
          .codeCiphertext,
      ).toBeNull(),
    );
    expect(persist).not.toHaveBeenCalled();
  });
  it("provider disconnect cancels all spaces without touching another user", async () => {
    const owner = await actor();
    const other = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn(async () => ({ id: "unused" }));
    const first = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    const second = await b.service.begin({
      userId: owner.userId,
      spaceId: other.spaceId,
      provider: ANTHROPIC_OAUTH_PROVIDER,
      persist,
    });
    const third = await b.service.begin({ ...other, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    await b.service.cancelProvider({ userId: owner.userId, provider: ANTHROPIC_OAUTH_PROVIDER });
    expect((await a.service.complete(first.loginId, owner)).status).toBe("error");
    expect(
      (await a.service.complete(second.loginId, { userId: owner.userId, spaceId: other.spaceId }))
        .status,
    ).toBe("error");
    expect((await a.service.complete(third.loginId, other)).status).toBe("pending");
    expect(persist).not.toHaveBeenCalled();
  });
  it("does not replay an uncertain save after owner loss; expired attempts can be replaced", async () => {
    const owner = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn(async () => ({ id: "not-replayed" }));
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    await db.prisma.modelOAuthSession.update({
      where: { id: begun.loginId },
      data: { state: "saving" },
    });
    expect((await b.service.finish(begun.loginId, owner, persist)).status).toBe("pending");
    await db.prisma.modelOAuthSession.update({
      where: { id: begun.loginId },
      data: { expiresAt: new Date(0) },
    });
    const replacement = await b.service.begin({
      ...owner,
      provider: ANTHROPIC_OAUTH_PROVIDER,
      persist,
    });
    expect(replacement.loginId).not.toBe(begun.loginId);
    expect((await b.service.complete(begun.loginId, owner)).status).toBe("error");
    expect(persist).not.toHaveBeenCalled();
  });
  it("does not expose or store persistence error contents", async () => {
    const owner = await actor();
    const a = await fixture(login);
    const b = await fixture(login);
    const persist = vi.fn(async () => {
      throw new Error("sensitive-synthetic-token");
    });
    const begun = await a.service.begin({ ...owner, provider: ANTHROPIC_OAUTH_PROVIDER, persist });
    await b.service.submit(begun.loginId, owner, "synthetic-code");
    await vi.waitFor(
      async () => expect((await b.service.complete(begun.loginId, owner)).status).toBe("error"),
      { timeout: 5000 },
    );
    const row = await db.prisma.modelOAuthSession.findUniqueOrThrow({
      where: { id: begun.loginId },
    });
    expect(JSON.stringify(row)).not.toContain("sensitive-synthetic-token");
    expect(JSON.stringify(await b.service.finish(begun.loginId, owner, persist))).not.toContain(
      "sensitive-synthetic-token",
    );
    expect(row.codeCiphertext).toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
