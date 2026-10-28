import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import {
  COMPUTER_SCREEN_UNAVAILABLE,
  CodexCatalogCache,
  ComputerBusyError,
  ComputerScreenUnavailableError,
  EncryptedSecretStore,
  IntegrationProviderSettings,
  LocalAgentHomeStore,
  screenLeaseIdForRun,
  serializeModelSecret,
} from "@rakazo/adapters";
import * as nativeAuth from "@rakazo/auth";
import type { Actor, Bot, ProductEvent } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT, REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { openScreenCapability } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { recruitingPresetId } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter, enqueueBotIntroRun, HEARTBEAT_MS, SESSION_RECHECK_MS } from "./router.js";

describe("account preferences", () => {
  function preferencesDeps(avatarStyle: string) {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      user: {
        update,
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle,
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { update, deps, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  function bootstrapDeps() {
    const f = preferencesDeps("robot");
    const stamp = new Date("2026-01-01T00:00:00Z");
    const bot = {
      id: "bot-1",
      spaceId: f.actor.spaceId,
      userId: f.actor.userId,
      name: "Test bot",
      title: "Assistant",
      description: "",
      instructions: "",
      color: "blue",
      notifyOnFinish: false,
      pinned: false,
      sectionId: null,
      archivedAt: null,
      parentBotId: null,
      memoryScope: null,
      createdAt: stamp,
      updatedAt: stamp,
      thread: { id: "thread-1", unread: false, messages: [], runs: [] },
      runs: [],
      computer: null,
    };
    const target = vi.fn().mockResolvedValue(bot);
    const routines = vi.fn().mockResolvedValue([]);
    const prewarmLookup = vi.fn().mockResolvedValue(null);
    const snapshot = vi.fn(async (read: (tx: PrismaClient) => Promise<unknown>) =>
      read(f.deps.prisma),
    );
    Object.assign(f.deps.prisma, {
      space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "organization-1" }) },
      spaceMember: {
        findMany: vi.fn().mockResolvedValue([
          {
            spaceId: f.actor.spaceId,
            role: "owner",
            space: { name: "Test space", isDefault: true, deletingAt: null },
          },
        ]),
      },
      bot: {
        // The platform-service setup looks for a recruiting lead first; this test bot is none.
        findFirst: vi.fn((input: { where?: { mcpServers?: unknown } }) =>
          input.where?.mcpServers ? Promise.resolve(null) : target(input),
        ),
        findMany: vi.fn(async (input) =>
          input.select || input!.where!.archivedAt !== null ? [] : [bot],
        ),
        // A crew without Main and Sourcer is not a recruiting workspace to upgrade.
        count: vi.fn().mockResolvedValue(0),
      },
      chatGroup: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      botSection: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      externalConversation: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      routine: { findMany: routines },
      capabilityInstall: { findFirst: vi.fn().mockResolvedValue(null) },
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findFirst: vi.fn().mockResolvedValue({ seq: 4 }) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      computer: { findFirst: prewarmLookup },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: snapshot,
    });
    return {
      ...f,
      target,
      routines,
      snapshot,
      prewarmLookup,
      client: createRouterClient(createRouter(f.deps), { context: { actor: f.actor } }),
    };
  }

  it("returns bootstrap navigation without waiting for an unselected bot's reads", async () => {
    const f = bootstrapDeps();
    f.target.mockImplementation(() => new Promise(() => {}));
    f.routines.mockImplementation(() => new Promise(() => {}));
    await expect(f.client.bootstrap({})).resolves.toMatchObject({
      bots: [{ id: "bot-1" }],
      thread: null,
      routines: [],
    });
    expect(f.target).not.toHaveBeenCalled();
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.routines).not.toHaveBeenCalled();
  }, 500);

  it("pages 1000 bots through list, navigation and bootstrap without losing the selected thread", async () => {
    const f = bootstrapDeps();
    const base = await f.target();
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...base, id: `bot-${index}` }));
    vi.mocked(f.deps.prisma.bot.findMany).mockImplementation(async (input) =>
      input!.select || input!.where!.archivedAt !== null
        ? []
        : rows.slice(input!.skip ?? 0, (input!.skip ?? 0) + (input!.take ?? rows.length)),
    );
    vi.mocked(f.deps.prisma.bot.count).mockImplementation(async (input) =>
      input?.where?.name ? 0 : 1000,
    );
    const ids: string[] = [];
    for (let offset = 0; offset < 1000; offset += 200) {
      const page = await f.client.bots.page({ offset, archived: false });
      expect(page.items).toHaveLength(200);
      ids.push(...page.items.map((bot) => bot.id));
      const navigation = await f.client.spaces.list({ offset });
      expect(navigation.current.bots).toHaveLength(200);
      expect(navigation.nextOffset).toBe(offset < 800 ? offset + 200 : null);
    }
    expect(new Set(ids).size).toBe(1000);
    expect(await f.client.bots.list()).toHaveLength(200);
    f.target.mockResolvedValue(rows[999]);
    const bootstrap = await f.client.bootstrap({ botId: "bot-999" });
    expect(bootstrap.bots).toHaveLength(200);
    expect(bootstrap.nextOffset).toBe(200);
    expect(bootstrap.thread?.botId).toBe("bot-999");
  });

  it("returns bootstrap without waiting for the computer pre-warm", async () => {
    const f = bootstrapDeps();
    f.prewarmLookup.mockImplementation(() => new Promise(() => {}));
    await expect(f.client.bootstrap({})).resolves.toMatchObject({ bots: [{ id: "bot-1" }] });
    expect(f.prewarmLookup).toHaveBeenCalledTimes(1);
  }, 500);

  it("does not fail bootstrap when the computer pre-warm throws", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    try {
      const f = bootstrapDeps();
      f.prewarmLookup.mockRejectedValue(new Error("computers table unavailable"));
      await expect(f.client.bootstrap({})).resolves.toMatchObject({ bots: [{ id: "bot-1" }] });
      await vi.waitFor(() => {
        expect(
          sink.events.some((e) => e.message === "computer.prewarm" && e.level === "warn"),
        ).toBe(true);
      });
    } finally {
      installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
    }
  });

  it("does not load navigation when the managed recruiting upgrade cannot be read", async () => {
    const f = bootstrapDeps();
    vi.mocked(f.deps.prisma.capabilityInstall.findFirst).mockRejectedValue(
      new Error("Preset storage unavailable"),
    );
    await expect(f.client.bootstrap({})).rejects.toThrow("Preset storage unavailable");
    expect(f.deps.prisma.bot.findMany).not.toHaveBeenCalled();
    expect(f.deps.prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("keeps the internal recruiting preset out of the user's plugin list", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const findMany = vi.fn().mockResolvedValue([]);
    Object.assign(deps.prisma, { capabilityInstall: { findMany } });
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    await expect(client.capabilities.list()).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith({
      take: 200,
      skip: 0,
      orderBy: { id: "asc" },
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        NOT: { id: recruitingPresetId(actor), kind: "plugin", source: "builtin:recruiting" },
      },
    });
  });

  it("does not remove the recruiting management baseline through plugin uninstall", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const id = recruitingPresetId(actor);
    const remove = vi.fn();
    const findFirst = vi.fn().mockResolvedValue({
      id,
      kind: "plugin",
      source: "builtin:recruiting",
    });
    const tx = { capabilityInstall: { findFirst, delete: remove } };
    Object.assign(deps.prisma, {
      ...tx,
      $transaction: vi.fn(async (read: (tx: unknown) => Promise<unknown>) => read(tx)),
    });
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    await expect(client.capabilities.remove({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id, spaceId: actor.spaceId, userId: actor.userId },
    });
  });

  it("keeps user plugins removable even when their source matches the internal preset", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const remove = vi.fn().mockResolvedValue({});
    const row = { id: "user-plugin", kind: "plugin", source: "builtin:recruiting" };
    const tx = { capabilityInstall: { findFirst: vi.fn().mockResolvedValue(row), delete: remove } };
    Object.assign(deps.prisma, {
      ...tx,
      $transaction: vi.fn(async (read: (tx: unknown) => Promise<unknown>) => read(tx)),
    });
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    await expect(client.capabilities.remove({ id: row.id })).resolves.toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it("bootstraps the explicitly selected bot's snapshot and routines", async () => {
    const f = bootstrapDeps();
    await expect(f.client.bootstrap({ botId: "bot-1" })).resolves.toMatchObject({
      thread: { botId: "bot-1", threadId: "thread-1", cursor: 4 },
      routines: [],
    });
    expect(f.target).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "bot-1",
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          archivedAt: null,
        },
      }),
    );
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.routines).toHaveBeenCalledWith({
      take: 200,
      skip: 0,
      orderBy: { id: "asc" },
      where: { botId: "bot-1", spaceId: f.actor.spaceId },
    });
  });

  function groupBootstrapDeps() {
    const f = bootstrapDeps();
    const group = {
      id: "group-1",
      spaceId: f.actor.spaceId,
      userId: f.actor.userId,
      name: "Recruiting team",
      pinned: false,
      sectionId: null,
      archivedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      thread: { id: "group-thread", unread: false, messages: [], runs: [] },
      members: ["bot-1", "bot-2"].map((id) => ({ bot: { id, name: id, color: "blue", runs: [] } })),
    };
    const groupTarget = vi.fn().mockResolvedValue(group);
    Object.assign(f.deps.prisma, {
      chatGroup: {
        count: vi.fn().mockResolvedValue(1),
        findFirst: groupTarget,
        findMany: vi.fn(async (input) => (input.where.archivedAt === null ? [group] : [])),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    });
    return { ...f, group, groupTarget };
  }

  it("bootstraps the selected authorized group through its native snapshot", async () => {
    const f = groupBootstrapDeps();
    await expect(f.client.bootstrap({ groupId: "group-1" })).resolves.toMatchObject({
      thread: { groupId: "group-1", threadId: "group-thread", cursor: 4 },
      routines: [],
    });
    expect(f.groupTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "group-1",
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          archivedAt: null,
        },
      }),
    );
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.target).not.toHaveBeenCalled();
    expect(f.routines).not.toHaveBeenCalled();
  });

  it("loads the selected group snapshot while navigation is still loading", async () => {
    const f = groupBootstrapDeps();
    const memberships = await f.deps.prisma.spaceMember.findMany();
    let finish!: (value: typeof memberships) => void;
    vi.mocked(f.deps.prisma.spaceMember.findMany).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    const response = f.client.bootstrap({ groupId: "group-1" });
    await vi.waitFor(() => expect(f.groupTarget).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
    finish(memberships);
    await expect(response).resolves.toMatchObject({ thread: { groupId: "group-1" } });
  });

  it.each(["missing-group", "foreign-group"])(
    "does not expose an inaccessible bootstrap target %s",
    async (groupId) => {
      const f = groupBootstrapDeps();
      f.groupTarget.mockResolvedValue(null);
      await expect(f.client.bootstrap({ groupId })).rejects.toThrow("Resource not found");
      expect(f.groupTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: groupId,
            spaceId: f.actor.spaceId,
            userId: f.actor.userId,
            archivedAt: null,
          },
        }),
      );
      expect(f.snapshot).not.toHaveBeenCalled();
    },
  );

  it("does not read a requested group without an authenticated actor", async () => {
    const f = groupBootstrapDeps();
    const client = createRouterClient(createRouter(f.deps), { context: { actor: null } });
    await expect(client.bootstrap({ groupId: "group-1" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(f.groupTarget).not.toHaveBeenCalled();
  });

  it("reports model credential store outages as service unavailable", async () => {
    const { deps, actor } = preferencesDeps("robot");
    Object.assign(deps.prisma, {
      userModelCredential: {
        findMany: vi.fn(async () => [{ secretId: "secret", preferences: [] }]),
      },
      secret: { findMany: vi.fn(async () => [{ id: "secret", ciphertext: "ref" }]) },
    });
    deps.secrets = {
      load: vi.fn(async () => {
        throw new SecretStoreUnavailableError();
      }),
    } as never;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    await expect(client.models.credentials()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("keeps an unconfigured catalog offline unless explicitly requested", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    deps.remoteConnectors = { fetch } as RouterDeps["remoteConnectors"];
    const handler = new RPCHandler(createRouter(deps));
    const request = async (usePublicCatalog?: boolean) =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/capabilities/catalogSearch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { query: "notion", usePublicCatalog } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    const { response } = await request();
    await expect(response.json()).resolves.toEqual({ json: { enabled: false, results: [] } });
    expect(fetch).not.toHaveBeenCalled();
    await request(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("persists and returns the selected avatar style", async () => {
    const { update, actor, handler } = preferencesDeps("organic");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "organic" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { avatarStyle: "organic" },
    });
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });

  it("rejects avatar styles outside robot|organic", async () => {
    const { update, actor, handler } = preferencesDeps("robot");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "dicebear" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["robot", "organic", "custom-cdn"])(
    "returns the stored style or organic fallback for %s",
    async (style) => {
      const { actor, handler } = preferencesDeps(style);

      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/me", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: null }),
        }),
        { prefix: "/rpc", context: { actor } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        json: expect.objectContaining({ avatarStyle: style === "robot" ? "robot" : "organic" }),
      });
    },
  );
});

describe("billing", () => {
  function billingDeps(isDeploymentOwner: boolean, billing?: RouterDeps["billing"]) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      billing,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    } satisfies Actor;
    return createRouterClient(createRouter(deps), { context: { actor } });
  }

  it("is not found when the deployment does not bill", async () => {
    const client = billingDeps(false);
    await expect(client.billing.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.billing.checkout()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.me()).resolves.toMatchObject({ billingEnabled: false });
  });

  it("enables billing on me for everyone but the deployment owner", async () => {
    const billing = { status: vi.fn() } as unknown as RouterDeps["billing"];
    await expect(billingDeps(false, billing).me()).resolves.toMatchObject({
      billingEnabled: true,
    });
    await expect(billingDeps(true, billing).me()).resolves.toMatchObject({
      billingEnabled: false,
    });
  });
});

describe("model setup gate", () => {
  function modelGateDeps(options: {
    agentRuntime: string;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    deploymentModelCredentialCipher?: string;
  }) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            options.deploymentModelCredentialCipher
              ? { deploymentModelCredentialCipher: options.deploymentModelCredentialCipher }
              : null,
          ),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        agentRuntime: options.agentRuntime,
        defaultProvider: "openrouter",
        defaultModel: "test-model",
        deploymentModelConfigured: options.deploymentModelConfigured,
        deploymentModelHostCredentials: options.deploymentModelHostCredentials,
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { actor, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("refuses to start a run when no model is configured", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "pi" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Connect a model to start a run.",
      }),
    });
  });

  it("does not require a model credential for the scripted test runtime", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("accepts a configured deployment model as model configuration", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelConfigured: true,
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("names the provider the deployment default runs on with host credentials", async () => {
    const hostCredentials = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelConfigured: true,
      deploymentModelHostCredentials: true,
    });
    const keyed = modelGateDeps({ agentRuntime: "pi", deploymentModelConfigured: true });

    const withHost = await call(hostCredentials.handler, hostCredentials.actor, "me", null);
    const withKey = await call(keyed.handler, keyed.actor, "me", null);

    await expect(withHost.json()).resolves.toEqual({
      json: expect.objectContaining({
        hostCredentialProvider: "openrouter",
        hostCredentialSource: "host",
      }),
    });
    await expect(withKey.json()).resolves.toEqual({
      json: expect.objectContaining({ hostCredentialProvider: null, hostCredentialSource: null }),
    });
  });

  it("does not accept a stored deployment cipher the executor cannot use", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelCredentialCipher: "legacy-ciphertext",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: true }),
    });
  });

  it("rejects a reply quote without a reply target", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
      replyQuote: "just this span",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        data: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ["replyQuote"] })]),
        }),
      }),
    });
  });

  it("rejects an over-length reply quote", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
      replyToMessageId: "parent-1",
      replyQuote: "x".repeat(REPLY_QUOTE_MAX_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        data: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ["replyQuote"] })]),
        }),
      }),
    });
  });
});

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
            clientNonce: "call:call-1:spoken-answer",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        clientNonce: "call:call-1:spoken-answer",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(sink.events.some((event) => event.message === "thread answer enqueue")).toBe(true);
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });
});

describe("thread stream authorization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function threadStream() {
    vi.useFakeTimers();
    const queued: ProductEvent[] = [];
    let waiting: ((result: IteratorResult<ProductEvent>) => void) | undefined;
    const follow = {
      next: () =>
        queued.length > 0
          ? Promise.resolve({ done: false as const, value: queued.shift()! })
          : new Promise<IteratorResult<ProductEvent>>((resolve) => {
              waiting = resolve;
            }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const emit = (seq: number, text: string, extra?: Partial<ProductEvent>) => {
      const event: ProductEvent = {
        id: `event-${seq}`,
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq,
        type: "thread.message.created",
        createdAt: new Date().toISOString(),
        payload: { text },
        ...extra,
      };
      if (waiting) {
        waiting({ done: false, value: event });
        waiting = undefined;
      } else {
        queued.push(event);
      }
    };
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({ trigger: "bot_message" }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { follow: vi.fn(() => follow) },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const stillAuthorized = vi.fn().mockResolvedValue(true);
    const client = createRouterClient(createRouter(deps), {
      context: { actor, stillAuthorized },
    });
    return { client, emit, follow, stillAuthorized };
  }

  it("stops delivering a busy thread once the session is revoked", async () => {
    const { client, emit, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    emit(1, "before");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(stillAuthorized).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    emit(2, "still signed in");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 2 } });
    expect(stillAuthorized).toHaveBeenCalledTimes(1);

    stillAuthorized.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    emit(3, "after revocation");
    await expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(follow.return).toHaveBeenCalled();
  });

  it("ends an idle stream at its next heartbeat once the session is revoked", async () => {
    const { client, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    stillAuthorized.mockResolvedValue(false);
    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(follow.return).toHaveBeenCalled();
  });

  it("re-checks authorization before skipping filtered peer events", async () => {
    const { client, emit, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    emit(1, "before");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(stillAuthorized).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    stillAuthorized.mockResolvedValue(false);
    emit(2, "hidden", { type: "thread.progress", runId: "run-peer", payload: {} });
    const pending = stream.next();
    const outcome = await Promise.race([
      pending.then(
        () => "yielded" as const,
        () => "rejected" as const,
      ),
      (async () => {
        for (let step = 0; step < 30; step++) {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(0);
        }
        return "still-open" as const;
      })(),
    ]);
    expect(outcome).toBe("rejected");
    await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stillAuthorized).toHaveBeenCalledTimes(1);
    expect(follow.return).toHaveBeenCalled();
  });
});

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      secret: { deleteMany: deleteSecrets },
      message: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        id: "old-secret",
        spaceId: "workspace-1",
        userId: "user-1",
      },
    });
  });
});

describe("MCP prepared credential updates", () => {
  it("keeps slow secret I/O outside transactions and retries a concurrent OAuth edit", async () => {
    let clock = 0;
    let active = false;
    let writes = 0;
    const server = {
      id: "server",
      spaceId: "space",
      userId: "user",
      slug: "demo",
      name: "Demo",
      description: "",
      enabled: true,
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/mcp",
      secretId: "old",
      revision: 1,
      args: [],
      env: {},
      headers: {},
      command: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const rows = new Map([["old", { id: "old", ciphertext: "old-ref" }]]);
    const values = new Map([
      [
        "old-ref",
        JSON.stringify({ oauth: { tokens: { access_token: "old", token_type: "bearer" } } }),
      ],
    ]);
    const prisma = {
      mcpServer: {
        findFirst: async () => ({ ...server }),
        update: async ({
          data,
        }: {
          data: { secretId: string; revision: { increment: number } };
        }) => {
          Object.assign(server, data, { revision: server.revision + data.revision.increment });
          return { ...server };
        },
      },
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: { id: string; ciphertext: string } }) => {
          rows.set(data.id, data);
          return data;
        },
        deleteMany: async ({ where }: { where: { id: string } }) => {
          rows.delete(where.id);
          return { count: 1 };
        },
        count: async ({ where }: { where: { ciphertext: string } }) =>
          [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
      },
      botSecret: { count: async () => 0 },
      integrationProviderConfig: { count: async () => 0 },
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      async $transaction(callback: (tx: typeof prisma) => Promise<unknown>) {
        active = true;
        const start = clock;
        try {
          const result = await callback(prisma);
          if (clock - start > 5000) throw new Error("Transaction expired");
          return result;
        } finally {
          active = false;
        }
      },
    };
    const secrets = {
      load: async (ref: string) => {
        expect(active).toBe(false);
        clock += 15000;
        return values.get(ref)!;
      },
      put: async (plaintext: string) => {
        expect(active).toBe(false);
        clock += 15000;
        const id = `write-${++writes}`;
        values.set(id, plaintext);
        if (writes === 1) {
          rows.set("concurrent", { id: "concurrent", ciphertext: "concurrent-ref" });
          values.set(
            "concurrent-ref",
            JSON.stringify({
              oauth: { tokens: { access_token: "concurrent", token_type: "bearer" } },
            }),
          );
          server.secretId = "concurrent";
          server.revision++;
        }
        return { id, ref: id, ciphertext: id };
      },
      delete: vi.fn(async (ref: string) => {
        expect(active).toBe(false);
        values.delete(ref);
      }),
    };
    const deps = {
      prisma,
      secrets,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space",
      userId: "user",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    await client.mcp.servers.update({ id: "server", secret: "updated-key" });
    expect(writes).toBe(2);
    expect(values.has("write-1")).toBe(false);
    expect(JSON.parse(values.get(server.secretId)!)).toMatchObject({
      secret: "updated-key",
      oauth: { tokens: { access_token: "concurrent" } },
    });
  });
});

describe("MCP loopback endpoints", () => {
  const LOOPBACK = "http://localhost:3100/api/auth/get-session";

  function mcpDeps(firstParty = false) {
    const list = vi.fn().mockResolvedValue([]);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "server-1",
      secretId: null,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const prisma = {
      mcpServer: {
        create,
        findMany: list,
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "server-1", endpoint: LOOPBACK, secretId: null }),
      },
      mcpOAuthSession: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      secret: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }) },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        ...(firstParty
          ? {
              firstPartyMcpUrl: "https://crm.example.test/mcp",
              oidc: { issuer: "https://identity.example.test", clientId: "product-client" },
            }
          : {}),
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { create, list, prisma, deps, handler: new RPCHandler(createRouter(deps)) };
  }

  function actor(isDeploymentOwner: boolean): Actor {
    return {
      spaceId: "workspace-1",
      userId: isDeploymentOwner ? "owner-1" : "member-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    };
  }

  function rpc(path: string, json: unknown) {
    return new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json }),
    });
  }

  const createInput = {
    transport: "streamable_http",
    slug: "local",
    name: "Local",
    endpoint: LOOPBACK,
  };

  it("reports platform configuration without credentials or overriding a personal connection", async () => {
    vi.stubEnv("AUTUMN_API_KEY", "test-platform-credential-not-for-clients");
    vi.stubEnv("FULLENRICH_API_KEY", "");
    try {
      const { list, handler } = mcpDeps();
      const server = {
        id: "research-service",
        spaceId: "workspace-1",
        slug: "research",
        name: "Recruiting research",
        description: "",
        transport: "streamable_http",
        endpoint: "https://api.autumn.ai/mcp",
        command: null,
        args: [],
        env: {},
        headers: {},
        secretId: null,
        enabled: true,
        revision: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      list.mockResolvedValue([
        server,
        { ...server, id: "other-endpoint", endpoint: "https://api.autumn.ai/mcp?other=1" },
        { ...server, id: "unconfigured-service", endpoint: "https://mcp.fullenrich.com/mcp" },
        { ...server, id: "stdio-service", transport: "stdio" },
        { ...server, id: "personal-service", secretId: "personal-secret" },
      ]);
      const { response } = await handler.handle(rpc("mcp/servers/list", {}), {
        prefix: "/rpc",
        context: { actor: actor(false) },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        json: Array<{ platformCredentialConfigured: boolean; oauthStatus: string }>;
      };
      expect(body.json.map((row) => row.platformCredentialConfigured)).toEqual([
        true,
        false,
        false,
        false,
        false,
      ]);
      expect(body.json.every((row) => row.oauthStatus === "none")).toBe(true);
      expect(JSON.stringify(body)).not.toContain("test-platform-credential-not-for-clients");
      expect(list).toHaveBeenCalledWith({
        where: { spaceId: "workspace-1", userId: "member-1" },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 200,
        skip: 0,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("projects one product identity read across exact first-party servers while keeping private and other endpoints unchanged", async () => {
    const status = vi.spyOn(nativeAuth, "getOidcAccountStatus").mockResolvedValue("connected");
    const { list, handler } = mcpDeps(true);
    const server = {
      id: "crm",
      spaceId: "workspace-1",
      slug: "crm",
      name: "CRM",
      description: "",
      transport: "streamable_http",
      endpoint: "https://crm.example.test/mcp",
      command: null,
      args: [],
      env: {},
      headers: {},
      secretId: null,
      enabled: true,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    list.mockResolvedValue([
      server,
      { ...server, id: "crm-two" },
      { ...server, id: "private", secretId: "own-secret" },
      { ...server, id: "other", endpoint: `${server.endpoint}?x=1` },
    ]);
    try {
      const { response } = await handler.handle(rpc("mcp/servers/list", {}), {
        prefix: "/rpc",
        context: { actor: actor(false) },
      });
      expect(
        (await response.json()).json.map((row: { oauthStatus: string }) => row.oauthStatus),
      ).toEqual(["connected", "connected", "none", "none"]);
      expect(status).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith(
        expect.anything(),
        { issuer: "https://identity.example.test", clientId: "product-client" },
        actor(false),
      );
    } finally {
      status.mockRestore();
    }
  });

  it.each(["connected", "reconnect"] as const)(
    "returns native product sign-in status %s without starting generic MCP OAuth",
    async (state) => {
      const status = vi.spyOn(nativeAuth, "getOidcAccountStatus").mockResolvedValue(state);
      const { deps, prisma } = mcpDeps(true);
      const begin = vi.fn().mockRejectedValue(new Error("Generic MCP OAuth must not run"));
      vi.mocked(prisma.mcpServer.findFirst).mockResolvedValue({
        id: "crm",
        spaceId: "workspace-1",
        userId: "member-1",
        endpoint: "https://crm.example.test/mcp",
        transport: "streamable_http",
        enabled: true,
        secretId: null,
      } as never);
      const handler = new RPCHandler(createRouter({ ...deps, mcpOAuth: { begin } as never }));
      try {
        const { response } = await handler.handle(
          rpc("mcp/oauth/begin", {
            serverId: "crm",
            redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          }),
          { prefix: "/rpc", context: { actor: actor(false) } },
        );
        expect(response.status).toBe(200);
        expect((await response.json()).json.status).toBe(
          state === "connected" ? "already_connected" : "product_sign_in_required",
        );
        expect(begin).not.toHaveBeenCalled();
      } finally {
        status.mockRestore();
      }
    },
  );

  it("does not read product Account metadata for personal, non-exact or other-transport servers", async () => {
    const status = vi.spyOn(nativeAuth, "getOidcAccountStatus");
    const { list, handler } = mcpDeps(true);
    const server = {
      id: "crm",
      spaceId: "workspace-1",
      slug: "crm",
      name: "CRM",
      description: "",
      transport: "streamable_http",
      endpoint: "https://crm.example.test/mcp",
      command: null,
      args: [],
      env: {},
      headers: {},
      secretId: null,
      enabled: true,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    list.mockResolvedValue([
      { ...server, secretId: "personal" },
      { ...server, endpoint: `${server.endpoint}/` },
      { ...server, transport: "sse" },
    ]);
    try {
      const { response } = await handler.handle(rpc("mcp/servers/list", {}), {
        prefix: "/rpc",
        context: { actor: actor(false) },
      });
      expect(response.status).toBe(200);
      expect(
        (await response.json()).json.map((row: { oauthStatus: string }) => row.oauthStatus),
      ).toEqual(["none", "none", "none"]);
      expect(status).not.toHaveBeenCalled();
    } finally {
      status.mockRestore();
    }
  });

  it("requires product sign-in without OIDC configuration rather than trying generic MCP OAuth", async () => {
    const status = vi.spyOn(nativeAuth, "getOidcAccountStatus");
    const { deps, prisma, list } = mcpDeps(true);
    delete deps.env.oidc;
    const server = {
      id: "crm",
      spaceId: "workspace-1",
      userId: "member-1",
      slug: "crm",
      name: "CRM",
      description: "",
      transport: "streamable_http",
      endpoint: "https://crm.example.test/mcp",
      command: null,
      args: [],
      env: {},
      headers: {},
      secretId: null,
      enabled: true,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    list.mockResolvedValue([server]);
    vi.mocked(prisma.mcpServer.findFirst).mockResolvedValue(server as never);
    const begin = vi.fn();
    const handler = new RPCHandler(createRouter({ ...deps, mcpOAuth: { begin } as never }));
    try {
      const listed = await handler.handle(rpc("mcp/servers/list", {}), {
        prefix: "/rpc",
        context: { actor: actor(false) },
      });
      expect((await listed.response.json()).json[0].oauthStatus).toBe("reconnect");
      const started = await handler.handle(
        rpc("mcp/oauth/begin", {
          serverId: "crm",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
        { prefix: "/rpc", context: { actor: actor(false) } },
      );
      expect(started.response.status).toBe(200);
      expect((await started.response.json()).json).toEqual({ status: "product_sign_in_required" });
      expect(status).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
    } finally {
      status.mockRestore();
    }
  });

  it.each(["disabled", "foreign"])(
    "rejects a %s server before product sign-in or generic OAuth",
    async (kind) => {
      const status = vi.spyOn(nativeAuth, "getOidcAccountStatus");
      const { deps, prisma } = mcpDeps(true);
      vi.mocked(prisma.mcpServer.findFirst).mockResolvedValue(
        kind === "foreign"
          ? null
          : ({
              id: "crm",
              endpoint: "https://crm.example.test/mcp",
              transport: "streamable_http",
              enabled: false,
              secretId: null,
            } as never),
      );
      const begin = vi.fn();
      const handler = new RPCHandler(createRouter({ ...deps, mcpOAuth: { begin } as never }));
      try {
        const { response } = await handler.handle(
          rpc("mcp/oauth/begin", {
            serverId: "crm",
            redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          }),
          { prefix: "/rpc", context: { actor: actor(false) } },
        );
        expect(response.status).toBe(400);
        expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith({
          where: { id: "crm", spaceId: "workspace-1", userId: "member-1", enabled: true },
        });
        expect(status).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
      } finally {
        status.mockRestore();
      }
    },
  );

  it("keeps the existing personal MCP OAuth broker for a first-party server with its own secret", async () => {
    const status = vi.spyOn(nativeAuth, "getOidcAccountStatus");
    const { deps, prisma } = mcpDeps(true);
    vi.mocked(prisma.mcpServer.findFirst).mockResolvedValue({
      id: "crm",
      endpoint: "https://crm.example.test/mcp",
      transport: "streamable_http",
      enabled: true,
      secretId: "personal",
    } as never);
    const begin = vi.fn().mockResolvedValue({ status: "authorization_not_requested" });
    const handler = new RPCHandler(createRouter({ ...deps, mcpOAuth: { begin } as never }));
    try {
      const { response } = await handler.handle(
        rpc("mcp/oauth/begin", {
          serverId: "crm",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
        { prefix: "/rpc", context: { actor: actor(false) } },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).json).toEqual({ status: "authorization_not_requested" });
      expect(begin).toHaveBeenCalledWith({
        serverId: "crm",
        spaceId: "workspace-1",
        userId: "member-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      });
      expect(status).not.toHaveBeenCalled();
    } finally {
      status.mockRestore();
    }
  });

  it.each(["connected", "reconnect"] as const)(
    "projects the same %s product connection status after create and update",
    async (state) => {
      const status = vi.spyOn(nativeAuth, "getOidcAccountStatus").mockResolvedValue(state);
      const { deps, prisma } = mcpDeps(true);
      deps.remoteConnectors = {
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
      } as RouterDeps["remoteConnectors"];
      const server = {
        id: "server-1",
        spaceId: "workspace-1",
        userId: "member-1",
        slug: "crm",
        name: "CRM",
        description: "",
        transport: "streamable_http",
        endpoint: "https://crm.example.test/mcp",
        command: null,
        args: [],
        env: {},
        headers: {},
        secretId: null,
        enabled: true,
        revision: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      vi.mocked(prisma.mcpServer.findFirst).mockResolvedValue(server as never);
      prisma.mcpServer.update = vi
        .fn()
        .mockResolvedValue({ ...server, name: "Updated CRM", revision: 2 });
      prisma.$executeRaw = vi.fn().mockResolvedValue(1);
      const handler = new RPCHandler(createRouter(deps));
      try {
        const created = await handler.handle(
          rpc("mcp/servers/create", {
            slug: "crm",
            name: "CRM",
            transport: "streamable_http",
            endpoint: server.endpoint,
          }),
          { prefix: "/rpc", context: { actor: actor(false) } },
        );
        expect(created.response.status).toBe(200);
        const createdBody = await created.response.json();
        expect(createdBody.json).toMatchObject({
          oauthStatus: state,
          hasSecret: false,
          platformCredentialConfigured: false,
        });
        const updated = await handler.handle(
          rpc("mcp/servers/update", {
            id: server.id,
            config: {
              slug: "crm",
              name: "Updated CRM",
              transport: "streamable_http",
              endpoint: server.endpoint,
            },
          }),
          { prefix: "/rpc", context: { actor: actor(false) } },
        );
        expect(updated.response.status).toBe(200);
        const updatedBody = await updated.response.json();
        expect(updatedBody.json).toMatchObject({
          oauthStatus: state,
          name: "Updated CRM",
          hasSecret: false,
          platformCredentialConfigured: false,
        });
        expect(status).toHaveBeenCalledTimes(2);
        for (const body of [createdBody, updatedBody]) {
          expect(body.json).not.toHaveProperty("issuer");
          expect(body.json).not.toHaveProperty("clientId");
          expect(body.json).not.toHaveProperty("idToken");
          expect(body.json).not.toHaveProperty("accessToken");
          expect(body.json).not.toHaveProperty("refreshToken");
        }
      } finally {
        status.mockRestore();
      }
    },
  );

  it("refuses a loopback endpoint from a user who is not the deployment owner", async () => {
    const { create, handler } = mcpDeps();
    const { response } = await handler.handle(rpc("mcp/servers/create", createInput), {
      prefix: "/rpc",
      context: { actor: actor(false) },
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("lets the deployment owner save a loopback endpoint", async () => {
    const { create, handler } = mcpDeps();
    const { response } = await handler.handle(rpc("mcp/servers/create", createInput), {
      prefix: "/rpc",
      context: { actor: actor(true) },
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to start OAuth against a stored loopback endpoint for a non-owner", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const { handler } = mcpDeps();
      const { response } = await handler.handle(
        rpc("mcp/oauth/begin", {
          serverId: "server-1",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
        { prefix: "/rpc", context: { actor: actor(false) } },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { json: { message: string } };
      expect(body.json.message).toMatch(/HTTPS/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("bounded native MCP assignment", () => {
  function assignmentDeps(existing?: { allowAllTools: boolean; allowedTools: string[] }) {
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: false,
    } satisfies Actor;
    const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      ...create,
      ...existing,
      id: "assignment-1",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const prisma = {
      thread: { findMany: vi.fn().mockResolvedValue([]) },
      bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1" }) },
      mcpServer: { findFirst: vi.fn().mockResolvedValue({ id: "server-1" }) },
      botMcpServer: { upsert },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake",
        webOrigin: "https://app.example.test",
        sandboxProvider: "fake",
        screenProxySecret: "test",
      },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const approve = (allowedTools?: string[]) =>
      handler.handle(
        new Request("https://app.example.test/rpc/mcp/assignments/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              botId: "bot-1",
              serverId: "server-1",
              ...(allowedTools ? { allowedTools } : {}),
            },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { actor, prisma, upsert, approve };
  }
  it("atomically adds only the requested tool allowlist within the current actor and Space", async () => {
    const { actor, prisma, upsert, approve } = assignmentDeps();
    const { response } = await approve(["get_thread", "create_draft"]);
    expect(response.status).toBe(200);
    expect((await response.json()).json).toMatchObject({
      allowAllTools: false,
      allowedTools: ["get_thread", "create_draft"],
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { botId_serverId: { botId: "bot-1", serverId: "server-1" } },
      create: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
        serverId: "server-1",
        allowAllTools: false,
        allowedTools: ["get_thread", "create_draft"],
      },
      update: {},
    });
    expect(prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    });
    expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith({
      where: { id: "server-1", spaceId: actor.spaceId, userId: actor.userId, enabled: true },
      select: { id: true },
    });
  });
  it.each([{ allowedTools: ["get_thread"] }, { allowedTools: [] }])(
    "does not replace an existing narrower or revoked %j assignment",
    async ({ allowedTools }) => {
      const { upsert, approve } = assignmentDeps({ allowAllTools: false, allowedTools });
      const { response } = await approve(["get_thread", "create_draft"]);
      expect(response.status).toBe(200);
      expect((await response.json()).json).toMatchObject({ allowAllTools: false, allowedTools });
      expect(upsert.mock.calls[0]?.[0]).toMatchObject({ update: {} });
    },
  );
  it("retains the native default only for an explicit unbounded connection request", async () => {
    const { approve } = assignmentDeps();
    const { response } = await approve();
    expect(response.status).toBe(200);
    expect((await response.json()).json).toMatchObject({ allowAllTools: true, allowedTools: [] });
  });
  it("does not assign a missing, disabled or foreign server", async () => {
    const { prisma, upsert, approve } = assignmentDeps();
    prisma.mcpServer.findFirst.mockResolvedValue(null as never);
    const { response } = await approve(["get_thread"]);
    expect(response.status).not.toBe(200);
    expect(upsert).not.toHaveBeenCalled();
  });
  it.each([[""], ["x".repeat(201)], Array.from({ length: 501 }, () => "get_thread")])(
    "validates tool names and count before writing",
    async (...tools) => {
      const { prisma, upsert, approve } = assignmentDeps();
      const { response } = await approve(tools as string[]);
      expect(response.status).toBe(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    },
  );
});

describe("private API connectors", () => {
  function privateDeps(mcpAllowPrivateEndpoint = false) {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "install-1",
      secretId: null,
      version: "1.0.0",
      digest: "sha256:fake",
      createdAt: new Date(0),
    }));
    const prisma = {
      capabilityInstall: { create },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        mcpAllowPrivateEndpoint,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { create, handler: new RPCHandler(createRouter(deps)) };
  }

  function actor(isDeploymentOwner: boolean): Actor {
    return {
      spaceId: "workspace-1",
      userId: isDeploymentOwner ? "owner-1" : "member-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    };
  }

  function rpc(path: string, json: unknown) {
    return new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json }),
    });
  }

  const installInput = {
    kind: "api",
    name: "Local API",
    source: "http://localhost:4000",
    config: {
      auth: { type: "none" },
      operations: [{ id: "list_items", method: "GET", path: "/items" }],
    },
  };

  it.each([
    ["the deployment owner", true, false],
    ["every user under the instance flag", false, true],
  ])("lets %s install a loopback API connector", async (_label, owner, flag) => {
    const { create, handler } = privateDeps(flag);
    const { response } = await handler.handle(rpc("capabilities/install", installInput), {
      prefix: "/rpc",
      context: { actor: actor(owner) },
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a loopback API connector from a user who is not the deployment owner", async () => {
    const { create, handler } = privateDeps();
    const { response } = await handler.handle(rpc("capabilities/install", installInput), {
      prefix: "/rpc",
      context: { actor: actor(false) },
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("connections.begin", () => {
  it("reuses a revoked row for the same provider instead of inserting a duplicate", async () => {
    const begin = vi.fn().mockResolvedValue({ state: "gmail-state", authorizationUrl: null });
    const update = vi.fn().mockResolvedValue({
      id: "conn-old",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "pending",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          connection: {
            findMany: vi.fn().mockResolvedValue([{ id: "conn-old", status: "revoked" }]),
            update,
            updateMany,
            create,
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ begin })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectorId: "composio",
            provider: "gmail",
            displayName: "Gmail",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "conn-old" },
      data: {
        displayName: "Gmail",
        status: "pending",
        providerRef: null,
        metadata: {},
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      json: { connectionId: "conn-old" },
    });
  });
});

describe("connections.complete", () => {
  it.each([
    ["complete", false],
    ["complete", true],
    ["revoke", false],
    ["revoke", true],
  ] as const)(
    "prepares slow configured credentials for %s (changed: %s)",
    async (operation, changed) => {
      const secrets = new EncryptedSecretStore("test-encryption-key");
      const stored = await secrets.put(
        JSON.stringify({ provider: "composio", apiKey: "fake-key" }),
        {
          operationId: "test",
          traceId: "test",
          spaceId: "workspace-1",
          userId: "user-1",
          signal: new AbortController().signal,
        },
        { recordId: "integration-provider:composio" },
      );
      let ref = stored.ref;
      let inTransaction = false;
      let elapsed = 0;
      const originalLoad = EncryptedSecretStore.prototype.load.bind(secrets);
      const load = vi.spyOn(secrets, "load").mockImplementation(async (...args) => {
        expect(inTransaction).toBe(false);
        elapsed += 15_000;
        return originalLoad(...args);
      });
      const row = {
        id: "conn-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "gmail",
        displayName: "Gmail",
        status: "pending",
        createdAt: new Date(0),
      };
      const client = {
        integrationProviderConfig: {
          findUnique: vi.fn(async () => ({ id: "composio", ciphertext: ref })),
        },
        connection: {
          findFirst: vi.fn(async () => row),
          findMany: vi.fn(async () => []),
          count: vi.fn(async () => 0),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn(async () => []),
      };
      const prisma = {
        ...client,
        $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
          const started = elapsed;
          if (changed) ref = "replacement-ref";
          inTransaction = true;
          try {
            const result = await fn(client);
            expect(elapsed - started).toBeLessThan(5_000);
            return result;
          } finally {
            inTransaction = false;
          }
        }),
      };
      const complete = vi.fn(async () => ({ connectionRef: "gmail" }));
      const revoke = vi.fn(async () => undefined);
      const adapter = {
        complete,
        revoke,
        connectionReady: vi.fn(async () => false),
      } as unknown as ManagedConnectorProvider;
      const settings = new IntegrationProviderSettings(
        prisma as unknown as PrismaClient,
        secrets,
        "fake-identity",
        {},
        () => adapter,
      );
      const connector = settings
        .providers()
        .find((provider) => provider.describe().id === "composio");
      const handler = new RPCHandler(
        createRouter({
          prisma,
          connectors: { managed: () => connector },
          env: {
            defaultProvider: "fake",
            defaultModel: "fake-model",
            webOrigin: "http://127.0.0.1:5173",
            screenProxySecret: "fake-test-secret",
            sandboxProvider: "fake",
          },
        } as unknown as RouterDeps),
      );
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/connections/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              connectionId: row.id,
              ...(operation === "complete" ? { code: "fake-code" } : {}),
            },
          }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "workspace-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
      expect(response.status).toBe(changed ? 409 : 200);
      expect(elapsed).toBe(15_000);
      expect(load).toHaveBeenCalledTimes(1);
      expect(operation === "complete" ? complete : revoke).toHaveBeenCalledTimes(changed ? 0 : 1);
    },
  );

  it("forwards an optional code to the managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue({
      id: "conn-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "connected",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        update,
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const row = {
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        };
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          connection: {
            findFirst: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi
              .fn()
              .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
                ...row,
                ...data,
              })),
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ complete, connectionReady })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "conn-1",
            code: "123456",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      { state: "gmail-state", code: "123456" },
      expect.objectContaining({ spaceId: "workspace-1", userId: "user-1" }),
    );
    expect(connectionReady).toHaveBeenCalled();
  });
});

describe("updater owner gate", () => {
  function updaterDeps() {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        gitSha: "deadbeef",
        updaterUrl: undefined,
        updaterToken: undefined,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { deps, handler: new RPCHandler(createRouter(deps)) };
  }

  it("forbids non-owners from updater status", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-2",
      email: "member@rakazo.test",
      isDeploymentOwner: false,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });

  it("lets the deployment owner read status without applying git", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.supported).toBe(false);
    expect(["source", "compose"]).toContain(body.json.installKind);
    expect(Array.isArray(body.json.manualCommands)).toBe(true);
  });

  it("refuses apply when the sidecar is not configured", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    const message = JSON.stringify(body);
    expect(message).toMatch(/sidecar/i);
    expect(message).not.toMatch(/git (fetch|merge|pull)/i);
  });
});

describe("computer screen url", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const computerRow = {
    id: "computer-1",
    screenGeneration: 3,
    kind: "e2b",
    scope: "team",
    state: "running",
    providerRef: "sandbox-ref-1",
    homeKey: "home-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
  };

  const callScreenUrl = async (connectScreen: () => Promise<unknown>, updateMany = vi.fn()) => {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: computerRow,
        }),
      },
      computer: { updateMany },
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { connectScreen },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "e2b",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/computer/screenUrl", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, updateMany };
  };

  it("issues lifecycle-bound capabilities for managed-provider screens too", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "https://screen.example/vnc.html?token=fake-token",
    }));
    expect(response.status).toBe(200);
    const { json } = await response.json();
    const url = new URL(json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: {
        botId: "bot-1",
        computerId: "computer-1",
        botGeneration: 2,
        computerGeneration: 3,
        controlLeaseId: null,
      },
      target: { hostname: "screen.example", interactive: false },
    });
  });

  it("returns desktop provider screen URLs without sealing them", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "desktop://screen/computer-1",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { url: "desktop://screen/computer-1?view_only=true" },
    });
  });

  it("clears the row instead of 500ing when the provider says the sandbox is gone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { url: null } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
  });

  it("keeps a transport blip an error and leaves the row alone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    );
    expect(response.status).toBe(500);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns a recoverable conflict when the screen is temporarily busy", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(new ComputerScreenUnavailableError()),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: COMPUTER_SCREEN_UNAVAILABLE,
      }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("computer terminal and file transfer", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const controlled = {
    controlHolder: "user",
    controlLeaseId: "lease-1",
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
    controlBotId: "bot-1",
  };

  function setup(computer: Record<string, unknown> = {}) {
    const sandbox = {
      execute: vi.fn(async function* () {
        yield { type: "exit" as const, code: 0 };
      }),
      listFiles: vi.fn().mockResolvedValue([]),
      connectTerminal: vi.fn().mockResolvedValue({
        url: "https://screen.example/vnc.html?path=websockify%3Ftoken%3Dterminal-1",
      }),
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("hello")),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: {
            id: "computer-1",
            screenGeneration: 3,
            kind: "docker",
            scope: "team",
            state: "running",
            providerRef: "sandbox-ref-1",
            homeKey: "home-1",
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
            ...computer,
          },
        }),
      },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computerExecutionLease: {
        findUnique: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      computerUpdate: {
        create: vi.fn().mockResolvedValue({ id: "manual-checkpoint" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox,
      home: { commit: vi.fn().mockResolvedValue("saved-revision") },
      jobs: {
        enqueue: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
      env: {
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "docker",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const call = async (procedure: string, json: Record<string, unknown>) => {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/computer/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-1", ...json } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return { status: response.status, body: await response.json() };
    };
    return { sandbox, prisma, call };
  }

  it.each(["confirmed", "unknown"])(
    "keeps manual Stop under native ownership for a %s pause",
    async (outcome) => {
      const { sandbox, prisma, call } = setup();
      Object.assign(sandbox, {
        exportWorkspace: vi.fn(async function* () {}),
        stop:
          outcome === "unknown"
            ? vi.fn().mockRejectedValue(new Error("pause timed out"))
            : vi.fn().mockResolvedValue(undefined),
      });
      await expect(call("stop", {})).resolves.toMatchObject({
        status: outcome === "unknown" ? 500 : 200,
      });
      expect(prisma.computer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { homeRevision: "saved-revision" } }),
      );
      expect(prisma.computerUpdate.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: { status: outcome === "unknown" ? "interrupted" : "completed" },
        }),
      );
      expect(prisma.computer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            maintenanceId: "manual-checkpoint",
            state: "suspending",
          }),
        }),
      );
      if (outcome === "unknown") {
        expect(prisma.computer.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ maintenanceId: null }) }),
        );
      } else {
        expect(prisma.computer.updateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ maintenanceId: "manual-checkpoint" }),
            data: expect.objectContaining({ maintenanceId: null, state: "stopped" }),
          }),
        );
      }
    },
  );

  it("prepares an unused bot's folders before listing a running Team Computer", async () => {
    const { sandbox, call } = setup();
    let prepared = false;
    sandbox.execute.mockImplementation(async function* () {
      prepared = true;
      yield { type: "exit" as const, code: 0 };
    });
    sandbox.listFiles.mockImplementation(async () => {
      if (!prepared) throw new Error("workspace folder does not exist");
      return [];
    });

    await expect(call("files", { path: "" })).resolves.toEqual({
      status: 200,
      body: { json: [] },
    });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      expect.anything(),
    );
    expect(sandbox.listFiles).toHaveBeenCalledWith(
      expect.anything(),
      "bots/bot-1",
      expect.anything(),
    );
  });

  it("prepares the bot's folders when boot reuses an already running Team Computer", async () => {
    const { sandbox, call } = setup();
    await expect(call("boot", {})).resolves.toMatchObject({ status: 200 });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      expect.anything(),
    );
  });

  it("clears a reclaimed sandbox before boot attempts provisioning again", async () => {
    const { sandbox, prisma, call } = setup();
    sandbox.execute.mockImplementation(async function* () {
      yield await Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      );
    });
    const findUniqueOrThrow = vi.fn().mockRejectedValue(new ComputerBusyError());
    prisma.computer.findUniqueOrThrow = findUniqueOrThrow;

    await expect(call("boot", {})).resolves.toMatchObject({ status: 409 });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "computer-1" } });
  });

  it("does not discard a live sandbox when folder preparation fails", async () => {
    const { sandbox, prisma, call } = setup();
    sandbox.execute.mockImplementation(async function* () {
      yield { type: "exit" as const, code: 1 };
    });
    await expect(call("boot", {})).resolves.toMatchObject({ status: 500 });
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("opens a terminal only for the user holding this bot's control lease", async () => {
    const released = setup();
    await expect(released.call("terminalUrl", {})).resolves.toMatchObject({ status: 403 });
    expect(released.sandbox.connectTerminal).not.toHaveBeenCalled();

    const { sandbox, call } = setup(controlled);
    const { status, body } = await call("terminalUrl", {});
    expect(status).toBe(200);
    expect(sandbox.connectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { controlToken: "lease-1", cwd: "bots/bot-1" },
      expect.anything(),
    );
    const url = new URL(body.json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: { botId: "bot-1", controlLeaseId: "lease-1" },
      target: { hostname: "screen.example", interactive: true },
    });
  });

  it("clears the row when the provider reclaimed the sandbox before the terminal opened", async () => {
    const gone = setup(controlled);
    gone.sandbox.connectTerminal.mockRejectedValueOnce(
      Object.assign(new Error("Sandbox is probably not running anymore"), {
        name: "SandboxNotFoundError",
      }),
    );
    await expect(gone.call("terminalUrl", {})).resolves.toEqual({
      status: 200,
      body: { json: { url: null } },
    });
    expect(gone.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });

    const blip = setup(controlled);
    blip.sandbox.connectTerminal.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(blip.call("terminalUrl", {})).resolves.toMatchObject({ status: 500 });
    expect(blip.prisma.computer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: "stopped", providerRef: null } }),
    );
  });

  it("offers no terminal on host computers", async () => {
    const { sandbox, call } = setup({ ...controlled, kind: "desktop" });
    await expect(call("terminalUrl", {})).resolves.toEqual({
      status: 200,
      body: { json: { url: null } },
    });
    expect(sandbox.connectTerminal).not.toHaveBeenCalled();
  });

  it("uploads into the bot workspace only under control", async () => {
    const contentBase64 = Buffer.from("notes").toString("base64");
    const released = setup();
    await expect(
      released.call("uploadFile", { path: "notes.txt", contentBase64 }),
    ).resolves.toMatchObject({ status: 403 });
    expect(released.sandbox.writeFile).not.toHaveBeenCalled();

    const { sandbox, call } = setup(controlled);
    await expect(call("uploadFile", { path: "notes.txt", contentBase64 })).resolves.toMatchObject({
      status: 200,
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { path: "bots/bot-1/notes.txt", content: Buffer.from("notes") },
      expect.anything(),
    );
  });

  it("rejects team uploads into another bot workspace", async () => {
    const contentBase64 = Buffer.from("x").toString("base64");
    const { sandbox, call } = setup(controlled);
    await expect(
      call("uploadFile", { path: "bots/bot-2/secret.txt", contentBase64 }),
    ).resolves.toMatchObject({ status: 400 });
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("downloads bytes from a running computer", async () => {
    const { sandbox, call } = setup();
    await expect(call("downloadFile", { path: "notes.txt" })).resolves.toEqual({
      status: 200,
      body: { json: { path: "notes.txt", contentBase64: Buffer.from("hello").toString("base64") } },
    });
    expect(sandbox.readFile).toHaveBeenCalledWith(
      expect.anything(),
      "bots/bot-1/notes.txt",
      expect.anything(),
      { maxBytes: 10 * 1024 * 1024 },
    );
    const stopped = setup({ state: "stopped" });
    await expect(stopped.call("downloadFile", { path: "notes.txt" })).resolves.toMatchObject({
      status: 409,
    });
  });
});

describe("integration setup authorization", () => {
  it.each([
    { owner: false, configured: false, needsSetup: false },
    { owner: true, configured: false, needsSetup: true },
    { owner: true, configured: true, needsSetup: false },
  ])(
    "offers server setup only to an owner without configured providers: %j",
    async ({ owner, configured, needsSetup }) => {
      const lookup = vi.fn(async () => configured);
      const deps = {
        prisma: {},
        env: { webOrigin: "https://example.test" },
        integrationSettings: { configured: lookup },
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      const { response } = await handler.handle(
        new Request("https://example.test/rpc/integrationSetup/get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: null }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              userId: "user",
              spaceId: "space",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
      const result = (await response.json()).json;
      expect(result).toMatchObject({ canConfigure: owner, needsSetup });
      if (!owner) {
        expect(result.providers).toEqual([]);
        expect(lookup).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects provider credentials from a non-owner before verification or persistence", async () => {
    const save = vi.fn();
    const deps = {
      prisma: {},
      env: { webOrigin: "https://example.test" },
      integrationSettings: { save },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("https://example.test/rpc/integrationSetup/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { provider: "composio", apiKey: "fake-key" } }),
      }),
      {
        prefix: "/rpc",
        context: {
          actor: {
            userId: "member",
            spaceId: "space",
            email: "member@rakazo.test",
            isDeploymentOwner: false,
          },
        },
      },
    );
    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("computer maintenance visibility", () => {
  it("keeps unresolved operations but stops presenting a superseded checkpoint failure", async () => {
    const completed = {
      action: "checkpoint",
      status: "completed",
      createdAt: new Date("2026-01-01T00:00:02Z"),
    };
    const failed = {
      id: "saved-later",
      botId: "bot-1",
      action: "checkpoint",
      status: "failed",
      stage: "saving",
      updatedAt: new Date("2026-01-01T00:00:01Z"),
      computer: {
        scope: "team",
        maintenanceId: null,
        bots: [{ id: "bot-1", name: "Writer" }],
        updates: [completed],
      },
    };
    const rows = [
      failed,
      { ...failed, id: "unsaved", computer: { ...failed.computer, updates: [] } },
      { ...failed, id: "later-failure", updatedAt: new Date("2026-01-01T00:00:03Z") },
      { ...failed, id: "same-instant", updatedAt: completed.createdAt },
      { ...failed, id: "interrupted", status: "interrupted" },
      { ...failed, id: "update-failed", action: "update" },
      { ...failed, id: "recover-failed", action: "recover" },
      { ...failed, id: "running", status: "running" },
      {
        ...failed,
        id: "still-owned",
        computer: { ...failed.computer, maintenanceId: "still-owned" },
      },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = { computerUpdate: { findMany } } as unknown as PrismaClient;
    const client = createRouterClient(
      createRouter({ prisma, env: { deploymentModelConfigured: false } } as RouterDeps),
      {
        context: {
          actor: {
            userId: "user-1",
            spaceId: "space-1",
            email: "user@rakazo.test",
            isDeploymentOwner: true,
          },
        },
      },
    );

    const visible = await client.computer.updates();

    expect(visible.map((row) => row.id)).toEqual(rows.slice(1).map((row) => row.id));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          computer: { spaceId: "space-1", bots: { some: { userId: "user-1" } } },
        }),
        include: {
          computer: {
            include: {
              bots: {
                where: { userId: "user-1", archivedAt: null },
                select: { id: true, name: true },
              },
              updates: {
                where: { action: "checkpoint", status: "completed" },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
      }),
    );
    expect(rows[0]).toBe(failed);
    expect(failed.status).toBe("failed");
  });
});

describe("interrupted computer reservation release", () => {
  function fixture() {
    const order: string[] = [];
    const computerUpdate = {
      findFirst: vi.fn(async () => ({ id: "update-1", computerId: "computer-1" })),
      updateMany: vi.fn(async () => {
        order.push("operation");
        return { count: 1 };
      }),
    };
    const computer = {
      updateMany: vi.fn(async () => {
        order.push("computer");
        return { count: 1 };
      }),
    };
    const prisma = { computer, computerUpdate, $transaction: vi.fn(async (fn) => fn(prisma)) };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
    );
    const call = async (owner: boolean, workersStopped?: boolean) =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/computer/releaseInterrupted", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { id: "update-1", workersStopped } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
    return { prisma, computer, computerUpdate, order, call };
  }
  it.each([
    { owner: false, stopped: true, status: 403 },
    { owner: true, stopped: false, status: 400 },
    { owner: true, stopped: undefined, status: 400 },
  ])(
    "requires owner authorization and an explicit stopped-workers assertion: %j",
    async ({ owner, stopped, status }) => {
      const { call, prisma } = fixture();
      const { response } = await call(owner, stopped);
      expect(response.status).toBe(status);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("atomically releases only an interrupted reservation in the owner's workspace", async () => {
    const { call, computer, computerUpdate, order } = fixture();
    const { response } = await call(true, true);
    expect(response.status).toBe(200);
    expect(computerUpdate.findFirst).toHaveBeenCalledWith({
      where: {
        id: "update-1",
        status: "interrupted",
        OR: [
          { computer: { bots: { some: { userId: "user-1", archivedAt: null } } } },
          { action: "checkpoint", computer: { scope: "dedicated" } },
        ],
        computer: { spaceId: "space-1", bots: { some: { userId: "user-1" } } },
      },
    });
    expect(computerUpdate.updateMany).toHaveBeenCalledWith({
      where: { id: "update-1", status: "interrupted" },
      data: { status: "failed" },
    });
    expect(computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", maintenanceId: "update-1" },
      data: { maintenanceId: null, state: "error" },
    });
    expect(order).toEqual(["operation", "computer"]);
  });
});

describe("model credential persistence", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function persistDeps(options?: { envDefaultModel?: string }) {
    const upsert = vi.fn().mockResolvedValue({ id: "preference" });
    const finish = vi.fn();
    // Connect loads any previous credential on the root client before the write transaction.
    const userModelCredential = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: { provider: string } }) => ({
        id: "cred-1",
        userId: actor.userId,
        provider: data.provider,
        label: data.provider,
        secretId: "secret-1",
        supportsImages: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    };
    const spaceModelPreference = {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert,
    };
    const tx = {
      userModelCredential,
      secret: { create: vi.fn().mockResolvedValue({}) },
      spaceModelPreference,
    };
    const deps = {
      prisma: {
        userModelCredential,
        spaceModelPreference,
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      },
      secrets: {
        put: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
      oauthLogins: {
        finish,
      },
      env: {
        defaultProvider: "openrouter",
        defaultModel: options?.envDefaultModel ?? "openai/gpt-5.6-luna",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        agentRuntime: "pi",
      },
    } as unknown as RouterDeps;
    return { upsert, finish, deps, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, path: string, body: unknown): Promise<Response> {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("does not persist a stringified null model id from subscription sign-in", async () => {
    const { upsert, finish, handler } = persistDeps();
    finish.mockImplementation(async (_loginId, _actor, persist) => ({
      status: "connected" as const,
      value: await persist({
        status: "connected",
        provider: "anthropic",
        modelId: "null",
        label: "Anthropic",
        credential: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        signal: new AbortController().signal,
      }),
    }));

    const response = await call(handler, "models/finishOAuth", { loginId: "login-1" });
    expect(response.status).toBe(200);
    const persisted = upsert.mock.calls[0]?.[0] as {
      create: { modelId: string | null };
      update: { modelId: string | null };
    };
    expect(persisted.create.modelId).not.toBe("null");
    expect(persisted.create.modelId).toBeTruthy();
    expect(persisted.update.modelId).toBe(persisted.create.modelId);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        provider: "anthropic",
        modelId: persisted.create.modelId,
      }),
    });
  });

  it("does not persist a missing model id as the string null", async () => {
    const { upsert, handler } = persistDeps({ envDefaultModel: "null" });

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: undefined,
    });
    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ modelId: null }),
        update: expect.objectContaining({ modelId: null }),
      }),
    );
  });

  it("rejects an API key for ChatGPT-subscription Codex before persisting", async () => {
    const { upsert, deps, handler } = persistDeps();

    const response = await call(handler, "models/connect", {
      provider: "openai-codex",
      apiKey: "sk-test-key-123",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: expect.stringContaining("ChatGPT subscription sign-in is required"),
      }),
    });
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("still accepts an API key for other providers", async () => {
    const { deps, handler } = persistDeps();

    const response = await call(handler, "models/connect", {
      provider: "anthropic",
      apiKey: "sk-test-key-123",
    });

    expect(response.status).toBe(200);
    expect(deps.secrets.put).toHaveBeenCalledWith(
      "sk-test-key-123",
      expect.objectContaining({ userId: actor.userId }),
    );
  });

  it.each([
    ["github-copilot", "GitHub Copilot"],
    ["openai-codex", "OpenAI Codex"],
    ["anthropic", "Anthropic"],
  ])("labels a %s subscription sign-in with its own provider name", async (provider, label) => {
    const { finish, deps, handler } = persistDeps();
    finish.mockImplementation(async (_loginId, _actor, persist) => ({
      status: "connected" as const,
      value: await persist({
        status: "connected",
        provider,
        credential: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        signal: new AbortController().signal,
      }),
    }));

    const response = await call(handler, "models/finishOAuth", { loginId: "login-1" });

    expect(response.status).toBe(200);
    expect(deps.prisma.userModelCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider, label }),
      }),
    );
  });
});

describe("bot intro run", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const bot = { id: "bot-1", threadId: "thread-1" } as unknown as Bot;

  function introDeps(options: { agentRuntime?: string; hasCredential?: boolean } = {}) {
    let calls = 0;
    const create = vi.fn(({ data }: { data: object }) => {
      calls += 1;
      return Promise.resolve({ id: `record-${calls}`, ...data });
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const tx = { task: { create }, run: { create } };
    const preference =
      (options.hasCredential ?? true)
        ? { isDefault: true, modelId: "model-1", credential: { id: "cred-1", provider: "test" } }
        : null;
    const spaceModelPreference = { findFirst: vi.fn().mockResolvedValue(preference) };
    const deps = {
      prisma: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        spaceModelPreference,
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      },
      jobs: { enqueue },
      env: { agentRuntime: options.agentRuntime ?? "pi" },
    } as unknown as RouterDeps;
    return { create, enqueue, deps };
  }

  it("queues an invisible-prompt run so the bot states how it read its role", async () => {
    const { create, enqueue, deps } = introDeps();

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-1",
          botId: "bot-1",
          threadId: "thread-1",
          userId: "user-1",
          status: "queued",
        }),
      }),
    );
    const [taskCall, runCall] = create.mock.calls as Array<
      [{ data: { prompt?: string; trigger?: string; taskId?: string } }]
    >;
    expect(taskCall?.[0].data.prompt).toMatch(/understood your role/i);
    expect(runCall?.[0].data.trigger).toBe("created");
    // The Run must reference the Task this same call created, not a stale or
    // mismatched id, and the enqueued job must target that Run.
    expect(runCall?.[0].data.taskId).toBe("record-1");
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: { runId: "record-2" } }),
    );
  });

  it("does nothing when the bot has no thread", async () => {
    const { create, enqueue, deps } = introDeps();

    await enqueueBotIntroRun(deps, actor, { id: "bot-1", threadId: null } as unknown as Bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing on the scripted test/eval runtime", async () => {
    const { create, enqueue, deps } = introDeps({ agentRuntime: "scripted" });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing when no model is configured yet", async () => {
    const { create, enqueue, deps } = introDeps({ hasCredential: false });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("codex catalog auth", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    if (path === "models/list" && body === null) {
      const json: unknown[] = [];
      for (let offset = 0; ; offset += 200) {
        const response = await call(handler, path, { offset });
        if (!response?.ok) return response;
        const page = (await response.json()).json as unknown[];
        expect(page.length).toBeLessThanOrEqual(200);
        json.push(...page);
        if (page.length < 200) return Response.json({ json });
      }
    }
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  function catalogDeps() {
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const prisma = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([
          { provider: "openai-codex", secretId: "secret-api" },
          { provider: "openai-codex", secretId: "secret-oauth" },
        ]),
      },
      spaceModelPreference: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { credential: { provider: "openai-codex", secretId: "secret-oauth" } },
          ]),
      },
      secret: {
        findMany: vi.fn().mockResolvedValue([{ id: "secret-oauth", ciphertext: "cipher-oauth" }]),
      },
    };
    const deps = {
      prisma,
      secrets: { load },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;
    return { load, prisma, handler: new RPCHandler(createRouter(deps)) };
  }

  it("hides Codex Spark for the space's ChatGPT credential when a newer key exists", async () => {
    const { load, prisma, handler } = catalogDeps();

    const response = await call(handler, "models/list", null);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: Array<{ provider: string; id: string }>;
    };
    expect(body.json.some((entry) => entry.provider === "openai-codex" && entry.id === spark)).toBe(
      false,
    );
    expect(body.json.some((entry) => entry.provider === "openai-codex" && entry.id === luna)).toBe(
      true,
    );
    expect(prisma.spaceModelPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: actor.userId, spaceId: actor.spaceId },
      }),
    );
    expect(load).toHaveBeenCalledWith("cipher-oauth", "secret-oauth");
    expect(load).not.toHaveBeenCalledWith("cipher-api", "secret-api");
  });
});

describe("codex live catalog", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const sol = "gpt-6-sol";
  const oauth = (accountId?: string) =>
    JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      ...(accountId ? { accountId } : {}),
    });
  const apiKey = "sk-test-api-key-12345678";

  function liveModel(slug: string) {
    return {
      slug,
      reasoningEfforts: ["low", "medium", "high"],
      contextWindow: 272_000,
      supportsImages: false,
      supportsFastTier: true,
    };
  }

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    if (path === "models/list" && body === null) {
      const json: unknown[] = [];
      for (let offset = 0; ; offset += 200) {
        const response = await call(handler, path, { offset });
        if (!response?.ok) return response;
        const page = (await response.json()).json as unknown[];
        expect(page.length).toBeLessThanOrEqual(200);
        json.push(...page);
        if (page.length < 200) return Response.json({ json });
      }
    }
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  async function listIds(handler: RPCHandler<never>): Promise<string[]> {
    const response = await call(handler, "models/list", null);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: Array<{ provider: string; id: string }>;
    };
    return body.json.filter((entry) => entry.provider === "openai-codex").map((entry) => entry.id);
  }

  function catalogDeps(opts: {
    read: ReturnType<typeof vi.fn>;
    oauthAccountId?: string | null;
    apiKeyOnly?: boolean;
    disconnected?: boolean;
  }) {
    const oauthPlaintext = oauth(
      opts.oauthAccountId === null ? undefined : (opts.oauthAccountId ?? "acct-live-test"),
    );
    const load = vi.fn((ciphertext: string) =>
      ciphertext === "cipher-oauth" ? oauthPlaintext : apiKey,
    );
    const prisma = opts.disconnected
      ? {
          userModelCredential: { findMany: vi.fn().mockResolvedValue([]) },
          spaceModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
          secret: { findMany: vi.fn().mockResolvedValue([]) },
        }
      : opts.apiKeyOnly
        ? {
            userModelCredential: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ provider: "openai-codex", secretId: "secret-api" }]),
            },
            spaceModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
            secret: {
              findMany: vi.fn().mockResolvedValue([{ id: "secret-api", ciphertext: "cipher-api" }]),
            },
          }
        : {
            userModelCredential: {
              findMany: vi.fn().mockResolvedValue([
                { provider: "openai-codex", secretId: "secret-api" },
                { provider: "openai-codex", secretId: "secret-oauth" },
              ]),
            },
            spaceModelPreference: {
              findMany: vi
                .fn()
                .mockResolvedValue([
                  { credential: { provider: "openai-codex", secretId: "secret-oauth" } },
                ]),
            },
            secret: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ id: "secret-oauth", ciphertext: "cipher-oauth" }]),
            },
          };
    const deps = {
      prisma,
      secrets: { load },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: { read: opts.read },
    } as unknown as RouterDeps;
    return { handler: new RPCHandler(createRouter(deps)) };
  }

  it("unlocks Spark and bounds the codex list to the live account catalog", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark), liveModel(luna)]);
    const { handler } = catalogDeps({ read });

    const ids = await listIds(handler);

    expect(ids).toContain(spark);
    expect(ids).toContain(luna);
    expect(ids).not.toContain(sol);
    expect(read).toHaveBeenCalledWith(
      actor.userId,
      expect.objectContaining({ accountId: "acct-live-test" }),
    );
  });

  it("keeps the static oauth catalog when the live read fails", async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const { handler } = catalogDeps({ read });

    const ids = await listIds(handler);

    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
  });

  it("ignores a live catalog that shares no known codex slug", async () => {
    const read = vi.fn().mockResolvedValue([liveModel("gpt-unknown-from-backend")]);
    const { handler } = catalogDeps({ read });

    const ids = await listIds(handler);

    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(ids).not.toContain("gpt-unknown-from-backend");
  });

  it("never reads the catalog for an API-key credential and still lists Spark", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, apiKeyOnly: true });

    const ids = await listIds(handler);

    expect(ids).toContain(spark);
    expect(read).not.toHaveBeenCalled();
  });

  it("never reads the catalog when no credential exists", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, disconnected: true });

    const ids = await listIds(handler);

    // Disconnected browsing still lists Codex models but keeps the Spark exclusion.
    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(read).not.toHaveBeenCalled();
  });

  it("falls back to the static catalog when the oauth credential has no account id", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, oauthAccountId: null });

    const ids = await listIds(handler);

    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(read).not.toHaveBeenCalled();
  });

  it("governs each codex model by the credential that owns it", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const credentialA = {
      id: "cred-a",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT A",
      secretId: "secret-a",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const credentialB = { ...credentialA, id: "cred-b", secretId: "secret-b" };
    const prisma = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([credentialA, credentialB]) },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-luna",
            modelId: luna,
            isDefault: true,
            updatedAt: stamp,
            credential: credentialA,
          },
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: false,
            updatedAt: stamp,
            credential: credentialB,
          },
        ]),
      },
      secret: {
        findMany: vi.fn().mockResolvedValue([
          { id: "secret-a", ciphertext: "cipher-a" },
          { id: "secret-b", ciphertext: "cipher-b" },
        ]),
      },
    };
    const secrets = {
      load: (ciphertext: string) => (ciphertext === "cipher-a" ? oauth("acct-a") : oauth("acct-b")),
    };
    const deps = {
      prisma,
      secrets,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;

    // Spark's preference points at account B: only B's catalog can unlock it.
    const read = vi.fn(async (_userId: string, account: { accountId: string }) =>
      account.accountId === "acct-b" ? [liveModel(spark)] : [liveModel(luna)],
    );
    deps.codexCatalog = { read };
    const first = await listIds(new RPCHandler(createRouter(deps)));
    expect(first).toContain(spark);
    expect(first).toContain(luna);

    // Account A listing Spark must not unlock it — B's catalog does not list it.
    const swapped = vi.fn(async (_userId: string, account: { accountId: string }) =>
      account.accountId === "acct-a" ? [liveModel(spark), liveModel(luna)] : [liveModel(luna)],
    );
    deps.codexCatalog = { read: swapped };
    const second = await listIds(new RPCHandler(createRouter(deps)));
    expect(second).not.toContain(spark);
    expect(second).toContain(luna);
  });

  it("never fetches the catalog for an expired token and kicks a detached refresh", async () => {
    const expiredOauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() - 1_000,
      accountId: "acct-live-test",
    });
    const prisma = {
      userModelCredential: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ provider: "openai-codex", secretId: "secret-oauth" }]),
      },
      spaceModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
      secret: {
        findMany: vi.fn().mockResolvedValue([{ id: "secret-oauth", ciphertext: "cipher-oauth" }]),
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ models: [{ slug: spark, visibility: "list", supported_in_api: true }] }),
          { status: 200 },
        ),
    );
    const refreshExpiredModelCredential = vi.fn();
    const deps = {
      prisma,
      secrets: { load: vi.fn(() => expiredOauth), put: vi.fn() },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: new CodexCatalogCache({ fetch: fetchImpl }),
      refreshExpiredModelCredential,
    } as unknown as RouterDeps;

    const ids = await listIds(new RPCHandler(createRouter(deps)));

    // Static exclusion stands this round; the credential's refresh is kicked so
    // the next read can see the account's real catalog.
    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refreshExpiredModelCredential).toHaveBeenCalledWith(
      expect.objectContaining({ userId: actor.userId }),
      "secret-oauth",
      "openai-codex",
    );
  });

  it("lets models.setDefault pick Spark when the account's live catalog lists it", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const upsert = vi.fn(async () => ({ id: "pref-spark" }));
    const tx = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([oauthCredential]) },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert,
      },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-oauth", ciphertext: "cipher-oauth" })),
      },
    };
    const deps = {
      prisma: { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
      secrets: { load: vi.fn(() => oauth("acct-live-test")) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: { read: vi.fn(async () => [liveModel(spark)]) },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-oauth",
          },
        },
      }),
    );
  });

  it("still rejects models.setDefault for Spark when the live catalog omits it", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const tx = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([oauthCredential]) },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert: vi.fn(async () => ({ id: "pref-spark" })),
      },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-oauth", ciphertext: "cipher-oauth" })),
      },
    };
    const deps = {
      prisma: { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
      secrets: { load: vi.fn(() => oauth("acct-live-test")) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: { read: vi.fn(async () => [liveModel(luna)]) },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/not available with your current sign-in/i),
      }),
    });
  });

  it.each(["unchanged", "rotated", "reconnected", "unavailable"] as const)(
    "prepares slow model secrets before the transaction: %s",
    async (change) => {
      const stamp = new Date("2026-01-01T00:00:00.000Z");
      const oauthCredential = {
        id: "cred-oauth",
        userId: actor.userId,
        provider: "openai-codex",
        label: "ChatGPT",
        secretId: "secret-oauth",
        createdAt: stamp,
        updatedAt: stamp,
      };
      const upsert = vi.fn(async () => ({ id: "pref-spark" }));
      const tx = {
        userModelCredential: { findMany: vi.fn().mockResolvedValue([oauthCredential]) },
        spaceModelPreference: {
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn(async () => ({ count: 0 })),
          upsert,
        },
        secret: {
          findFirst: vi.fn(async () => ({ id: "secret-oauth", ciphertext: "cipher-oauth" })),
        },
      };
      let elapsed = 0;
      let inTransaction = false;
      const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => {
        if (change === "rotated")
          tx.secret.findFirst.mockResolvedValue({ id: "secret-oauth", ciphertext: "rotated" });
        if (change === "reconnected")
          tx.userModelCredential.findMany.mockResolvedValue([
            { ...oauthCredential, secretId: "replacement" },
          ]);
        const started = elapsed;
        inTransaction = true;
        try {
          const result = await fn(tx);
          expect(elapsed - started).toBeLessThan(5_000);
          return result;
        } finally {
          inTransaction = false;
        }
      });
      const prisma = {
        $transaction: transaction,
        userModelCredential: tx.userModelCredential,
        spaceModelPreference: { findMany: tx.spaceModelPreference.findMany },
        secret: tx.secret,
      };
      const read = vi.fn(
        async (_userId: string, _account: { accountId: string }, _opts?: { waitMs?: number }) => [
          liveModel(spark),
        ],
      );
      const refreshExpiredModelCredential = vi.fn();
      const deps = {
        prisma,
        secrets: {
          load: vi.fn(async () => {
            expect(inTransaction).toBe(false);
            elapsed += 15_000;
            if (change === "unavailable") throw new SecretStoreUnavailableError();
            return oauth("acct-live-test");
          }),
          put: vi.fn(),
        },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
        codexCatalog: { read },
        refreshExpiredModelCredential,
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));

      const response = await call(handler, "models/setDefault", {
        provider: "openai-codex",
        modelId: spark,
      });

      expect(elapsed).toBe(15_000);
      expect(response.status).toBe(
        change === "unchanged" ? 200 : change === "unavailable" ? 503 : 409,
      );
      if (change === "unchanged") {
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.invocationCallOrder[0]).toBeLessThan(
          transaction.mock.invocationCallOrder[0]!,
        );
        expect(upsert).toHaveBeenCalled();
      } else {
        expect(upsert).not.toHaveBeenCalled();
      }
    },
  );
});

describe("model set default auth", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    if (path === "models/list" && body === null) {
      const json: unknown[] = [];
      for (let offset = 0; ; offset += 200) {
        const response = await call(handler, path, { offset });
        if (!response?.ok) return response;
        const page = (await response.json()).json as unknown[];
        expect(page.length).toBeLessThanOrEqual(200);
        json.push(...page);
        if (page.length < 200) return Response.json({ json });
      }
    }
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("sets Spark from the API-key preference when a newer ChatGPT credential exists", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const apiCredential = {
      id: "cred-api",
      userId: actor.userId,
      provider: "openai-codex",
      label: "API key",
      secretId: "secret-api",
      createdAt: older,
      updatedAt: older,
    };
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: newer,
      updatedAt: newer,
    };
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") return { id: "secret-api", ciphertext: "cipher-api" };
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const upsert = vi.fn(async () => ({ id: "pref-spark" }));
    const tx = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([oauthCredential, apiCredential]),
      },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: false,
            updatedAt: older,
            credential: apiCredential,
          },
          {
            id: "pref-luna",
            modelId: luna,
            isDefault: true,
            updatedAt: newer,
            credential: oauthCredential,
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        upsert,
      },
      secret: { findFirst: secretFindFirst },
    };
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const handler = new RPCHandler(
      createRouter({
        prisma: {
          ...tx,
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: { load },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(secretFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "secret-api", userId: actor.userId, spaceId: null }),
      }),
    );
    expect(load).toHaveBeenCalledWith("cipher-api", "secret-api");
    expect(load).not.toHaveBeenCalledWith("cipher-oauth", "secret-oauth");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        update: { modelId: spark, isDefault: true, thinkingLevel: null },
      }),
    );
  });

  it("does not rewrite a Spark API-key preference when another Codex model becomes the default", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const apiCredential = {
      id: "cred-api",
      userId: actor.userId,
      provider: "openai-codex",
      label: "API key",
      secretId: "secret-api",
      createdAt: older,
      updatedAt: older,
    };
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: newer,
      updatedAt: newer,
    };
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") return { id: "secret-api", ciphertext: "cipher-api" };
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const upsert = vi.fn(async () => ({ id: "pref-luna" }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([oauthCredential, apiCredential]),
      },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: true,
            updatedAt: older,
            credential: apiCredential,
          },
        ]),
        updateMany,
        upsert,
      },
      secret: { findFirst: secretFindFirst },
    };
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const handler = new RPCHandler(
      createRouter({
        prisma: {
          ...tx,
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: { load },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: luna,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(load).toHaveBeenCalledWith("cipher-oauth", "secret-oauth");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-oauth",
          },
        },
        create: expect.objectContaining({ modelId: luna, isDefault: true }),
        update: { modelId: luna, isDefault: true, thinkingLevel: null },
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        isDefault: true,
        credentialId: { not: "cred-oauth" },
      },
      data: { isDefault: false },
    });
  });

  it("keeps the working space credential when the other Codex secret cannot be read", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const apiCredential = {
      id: "cred-api",
      userId: actor.userId,
      provider: "openai-codex",
      label: "API key",
      secretId: "secret-api",
      createdAt: older,
      updatedAt: older,
    };
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: newer,
      updatedAt: newer,
    };
    const upsert = vi.fn(async () => ({ id: "pref-luna" }));
    const tx = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([oauthCredential, apiCredential]),
      },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: true,
            updatedAt: older,
            credential: apiCredential,
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        upsert,
      },
      secret: {
        findFirst: vi.fn(async (args: { where: { id?: string } }) => {
          if (args.where.id === "secret-api") return { id: "secret-api", ciphertext: "cipher-api" };
          if (args.where.id === "secret-oauth") {
            return { id: "secret-oauth", ciphertext: "cipher-oauth" };
          }
          return null;
        }),
      },
    };
    const load = vi.fn((ciphertext: string) => {
      if (ciphertext === "cipher-oauth") throw new Error("unreadable");
      return apiKey;
    });
    const handler = new RPCHandler(
      createRouter({
        prisma: {
          ...tx,
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: { load },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: luna,
    });

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        update: { modelId: luna, isDefault: true, thinkingLevel: null },
      }),
    );
  });
});

describe("bot model auth on save", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    if (path === "models/list" && body === null) {
      const json: unknown[] = [];
      for (let offset = 0; ; offset += 200) {
        const response = await call(handler, path, { offset });
        if (!response?.ok) return response;
        const page = (await response.json()).json as unknown[];
        expect(page.length).toBeLessThanOrEqual(200);
        json.push(...page);
        if (page.length < 200) return Response.json({ json });
      }
    }
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  function storedBot(modelId: string) {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: "bot-1",
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "Ada",
      title: "",
      description: "",
      instructions: "",
      color: "ink",
      notifyOnFinish: true,
      pinned: false,
      position: 0,
      sectionId: null,
      archivedAt: null,
      parentBotId: null,
      memoryScope: null,
      createdAt: now,
      updatedAt: now,
      voiceId: null,
      autoSpeak: false,
      modelProvider: "openai-codex",
      modelId,
      thinkingLevel: null,
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      webhookSecretId: null,
      spawnKey: null,
      thread: { id: "thread-1", unread: false, messages: [], runs: [] },
      computer: null,
      runs: [],
    };
  }

  function credentialRow(id: string, secretId: string) {
    return {
      id,
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  function saveDeps(options: {
    modelId: string;
    plaintext?: string;
    deploymentProvider?: string;
    preferences: (args: { where: { modelId?: string; credential?: { provider?: string } } }) => {
      credential: ReturnType<typeof credentialRow>;
      isDefault: boolean;
      modelId: string;
    } | null;
  }) {
    const bot = storedBot(options.modelId);
    const routine = {
      id: "routine-1",
      botId: bot.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "Later",
      prompt: "say done",
      crons: ["@once"],
      timezone: "UTC",
      notify: true,
      active: false,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      modelProvider: bot.modelProvider,
      modelId: bot.modelId,
      thinkingLevel: null,
      createdAt: new Date(0),
      lastRunAt: null,
      nextRunAt: null,
    };
    const createRoutine = vi.fn(async ({ data }) => ({ ...routine, ...data }));
    const updateRoutine = vi.fn(async ({ data }) => ({
      ...routine,
      ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    }));
    const preferenceFindFirst = vi.fn(options.preferences);
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") {
        return { id: "secret-api", ciphertext: "cipher-api" };
      }
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const botUpdate = vi.fn(async () => ({
      id: bot.id,
      name: "Ada renamed",
      title: bot.title,
      description: bot.description,
    }));
    const tx = {
      bot: { update: botUpdate },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => bot),
        findMany: vi.fn(async () => [{ ...bot, name: "Ada renamed" }]),
        update: botUpdate,
      },
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      user: { findUniqueOrThrow: vi.fn(async () => ({ email: actor.email, name: "Test User" })) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: secretFindFirst },
      routine: {
        findFirst: vi.fn(async () => routine),
        create: createRoutine,
        update: updateRoutine,
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const deps = {
      prisma,
      secrets: {
        load: (ciphertext: string) =>
          options.plaintext ?? (ciphertext === "cipher-oauth" ? oauth : apiKey),
      },
      events: {
        notify: vi.fn().mockResolvedValue(undefined),
        append: vi.fn().mockResolvedValue(undefined),
      },
      codexCatalog: { read: vi.fn(async () => []) },
      env: {
        deploymentModelConfigured: Boolean(options.deploymentProvider),
        defaultProvider: options.deploymentProvider ?? "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;
    return {
      preferenceFindFirst,
      secretFindFirst,
      botUpdate,
      createRoutine,
      updateRoutine,
      handler: new RPCHandler(createRouter(deps)),
    };
  }

  it.each([true, false])(
    "exposes platform catalog choices only when deployment funding is %s",
    async (configured) => {
      const handler = new RPCHandler(
        createRouter({
          prisma: {
            userModelCredential: { findMany: vi.fn(async () => []) },
            spaceModelPreference: { findMany: vi.fn(async () => []) },
          },
          env: {
            deploymentModelConfigured: configured,
            defaultProvider: "openai",
            defaultModel: luna,
          },
        } as unknown as RouterDeps),
      );
      const response = await call(handler, "models/list", null);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        json: Array<{ provider: string; id: string; deployment?: boolean }>;
      };
      expect(
        body.json.find((entry) => entry.provider === "openai" && entry.id === luna)?.deployment,
      ).toBe(configured ? true : undefined);
      expect(
        body.json.filter((entry) => entry.deployment).every((entry) => entry.provider === "openai"),
      ).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/secretId|apiKey/);
    },
  );

  it.each(["bots/update", "routines/create", "routines/update"])(
    "allows %s to select a platform catalog model without personal authorization",
    async (path) => {
      const { handler, secretFindFirst } = saveDeps({
        modelId: luna,
        deploymentProvider: "openai",
        preferences: () => null,
      });
      const response = await call(handler, path, {
        ...(path === "bots/update"
          ? { botId: "bot-1" }
          : path === "routines/create"
            ? { botId: "bot-1", name: "Later", prompt: "say done", crons: ["@once"] }
            : { routineId: "routine-1" }),
        modelProvider: "openai",
        modelId: luna,
      });
      expect(response.status).toBe(200);
      expect(secretFindFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["anthropic", "openai"])(
    "rejects an unfunded or unknown bot choice for %s",
    async (provider) => {
      const { handler, botUpdate } = saveDeps({
        modelId: luna,
        deploymentProvider: "openai",
        preferences: () => null,
      });
      const response = await call(handler, "bots/update", {
        botId: "bot-1",
        modelProvider: provider,
        modelId: provider === "openai" ? "not-a-model" : "claude-sonnet-5",
      });
      expect(response.status).toBe(400);
      expect(botUpdate).not.toHaveBeenCalled();
    },
  );

  it("saves a rename while resending an existing Spark override", async () => {
    const { preferenceFindFirst, secretFindFirst, botUpdate, handler } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });

    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      name: "Ada renamed",
      modelProvider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ id: "bot-1", name: "Ada renamed", modelId: spark }),
    });
    expect(preferenceFindFirst).not.toHaveBeenCalled();
    expect(secretFindFirst).not.toHaveBeenCalled();
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Ada renamed", modelId: spark }),
      }),
    );
  });

  it("rejects setting Codex Spark on the space's ChatGPT subscription credential", async () => {
    const oauthCredential = credentialRow("cred-oauth", "secret-oauth");
    const { preferenceFindFirst, handler } = saveDeps({
      modelId: luna,
      preferences: (args) => {
        if (args.where.modelId) return null;
        if (args.where.credential?.provider === "openai-codex") {
          return { credential: oauthCredential, isDefault: true, modelId: luna };
        }
        return null;
      },
    });

    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      modelProvider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/not available with your current sign-in/i),
      }),
    });
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelId: spark,
          credential: { provider: "openai-codex" },
        }),
      }),
    );
  });

  it("accepts Spark when the preference that owns that model is an API key", async () => {
    const apiCredential = credentialRow("cred-api", "secret-api");
    const oauthCredential = credentialRow("cred-oauth", "secret-oauth");
    const { secretFindFirst, handler } = saveDeps({
      modelId: luna,
      preferences: (args) => {
        if (args.where.modelId === spark) {
          return { credential: apiCredential, isDefault: false, modelId: spark };
        }
        if (args.where.credential?.provider === "openai-codex") {
          return { credential: oauthCredential, isDefault: true, modelId: luna };
        }
        return null;
      },
    });

    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      modelProvider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    expect(secretFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "secret-api", userId: actor.userId, spaceId: null }),
      }),
    );
  });

  it("validates bot thinking with the selected custom model's connection", async () => {
    const selected = { ...credentialRow("cred-api", "secret-api"), provider: "openai-compatible" };
    const other = { ...credentialRow("cred-oauth", "secret-oauth"), provider: "openai-compatible" };
    const { handler, botUpdate, secretFindFirst } = saveDeps({
      modelId: luna,
      plaintext: serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        reasoning: true,
      }),
      preferences: (args) =>
        args.where.modelId === "selected-model"
          ? { credential: selected, isDefault: false, modelId: "selected-model" }
          : { credential: other, isDefault: true, modelId: "other-model" },
    });
    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      modelProvider: "openai-compatible",
      modelId: "selected-model",
      thinkingLevel: "high",
    });
    expect(response.status).toBe(200);
    expect(secretFindFirst).toHaveBeenCalledWith({
      where: { id: "secret-api", userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    });
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelProvider: "openai-compatible",
          modelId: "selected-model",
          thinkingLevel: "high",
        }),
      }),
    );
  });

  it.each(["create", "update"])(
    "rejects a routine %s using a model unavailable to its selected sign-in",
    async (operation) => {
      const credential = credentialRow("cred-oauth", "secret-oauth");
      const { handler, createRoutine, updateRoutine } = saveDeps({
        modelId: luna,
        preferences: () => ({ credential, isDefault: true, modelId: luna }),
      });
      const response = await call(handler, `routines/${operation}`, {
        ...(operation === "create"
          ? { botId: "bot-1", name: "Later", prompt: "say done", crons: ["@once"] }
          : { routineId: "routine-1" }),
        modelProvider: "openai-codex",
        modelId: spark,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        json: { message: expect.stringMatching(/not available with your current sign-in/i) },
      });
      expect(createRoutine).not.toHaveBeenCalled();
      expect(updateRoutine).not.toHaveBeenCalled();
    },
  );

  it.each(["create", "update"])(
    "keeps the model-specific API credential when validating a routine %s",
    async (operation) => {
      const credential = credentialRow("cred-api", "secret-api");
      const oauthCredential = credentialRow("cred-oauth", "secret-oauth");
      const { handler, secretFindFirst } = saveDeps({
        modelId: luna,
        preferences: (args) =>
          args.where.modelId === spark
            ? { credential, isDefault: false, modelId: spark }
            : { credential: oauthCredential, isDefault: true, modelId: luna },
      });
      const response = await call(handler, `routines/${operation}`, {
        ...(operation === "create"
          ? { botId: "bot-1", name: "Later", prompt: "say done", crons: ["@once"] }
          : { routineId: "routine-1" }),
        modelProvider: "openai-codex",
        modelId: spark,
      });
      expect(response.status).toBe(200);
      expect(secretFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "secret-api", userId: actor.userId, spaceId: null },
        }),
      );
    },
  );
});

describe("bot restore computer quota", () => {
  function fixture(archivedBot: { archivedAt: Date | null } | null, inUse = 0) {
    const bot = archivedBot
      ? {
          ...archivedBot,
          id: "bot-archived",
          computerId: "computer-archived",
          computer: { id: "computer-archived" },
          userId: "user-1",
        }
      : null;
    const botApi = {
      findFirst: vi.fn(async () => bot),
      update: vi.fn(async () => ({})),
    };
    const computer = {
      count: vi.fn(async (args: { where: { id?: string } }) => (args.where.id ? 0 : inUse)),
    };
    const $queryRaw = vi.fn(async () => [{ lock: "1" }]);
    const prisma = {
      bot: botApi,
      computer,
      $queryRaw,
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ $queryRaw, computer, bot: botApi }),
      ),
    };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
    );
    const call = async () =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/bots/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-archived" } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
    return { prisma, call };
  }

  it("archives, creates, then restores is refused when the restore would exceed the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, call } = fixture({ archivedAt: new Date() }, 1);
    const { response } = await call();
    expect(response.status).toBe(400);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("restores normally when the user is below the cap or the computer is already live", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, call } = fixture({ archivedAt: new Date() }, 0);
    const { response } = await call();
    expect(response.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledWith({
      where: { id: "bot-archived" },
      data: { archivedAt: null },
    });
  });

  it("does not enforce anything when the cap is unset", async () => {
    const { prisma, call } = fixture({ archivedAt: new Date() }, 99);
    const { response } = await call();
    expect(response.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
});

describe("routines.update", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const routine = {
    id: "routine-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "Later",
    prompt: "say done",
    crons: ["@once"],
    timezone: "UTC",
    active: false,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  function fixture(
    botArchived: boolean,
    archivedBeforeWrite = false,
    model: Record<string, unknown> = {},
    connectedModelId = "old-model",
  ) {
    const savedRoutine = { ...routine, ...model };
    let archiveCommitted = false;
    const credential = {
      id: "credential-1",
      provider: "openai-compatible",
      userId: actor.userId,
      secretId: "secret-1",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...savedRoutine,
      ...data,
    }));
    const update = vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (archivedBeforeWrite) {
          archiveCommitted = true;
          throw Object.assign(new Error("not found"), { code: "P2025" });
        }
        return {
          ...savedRoutine,
          ...Object.fromEntries(
            Object.entries(args.data).filter(([, value]) => value !== undefined),
          ),
        };
      },
    );
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      spaceModelPreference: {
        findMany: vi.fn(async () => [
          { id: "preference-1", modelId: connectedModelId, isDefault: true, credential },
        ]),
        findFirst: vi.fn(async () => ({ id: "preference-1" })),
      },
      userModelCredential: {
        findMany: vi.fn(async () => [credential]),
      },
      secret: { findFirst: vi.fn(async () => ({ ciphertext: "secret-ref" })) },
      routine: {
        findFirst: vi.fn(async (args: { where: { bot?: { archivedAt: null } } }) =>
          (botArchived || archiveCommitted) && args.where.bot?.archivedAt === null
            ? null
            : savedRoutine,
        ),
        update,
        create,
      },
      bot: {
        findFirst: vi.fn(async () =>
          botArchived ? null : { id: "bot-1", thread: { id: "thread-1" }, computer: null },
        ),
      },
    };
    const handler = new RPCHandler(
      createRouter({
        prisma,
        env: { sandboxProvider: "fake" },
        events: { append: vi.fn(async () => undefined) },
        jobs: { enqueue, cancel: vi.fn(async () => undefined) },
        secrets: {
          load: vi.fn(async () =>
            serializeModelSecret({
              kind: "openai_compatible",
              baseUrl: "http://127.0.0.1:8000/v1",
              reasoning: true,
            }),
          ),
        },
      } as unknown as RouterDeps),
    );
    const call = (patch: Record<string, unknown> = {}, operation = "update") =>
      handler.handle(
        new Request(`http://127.0.0.1/rpc/routines/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json:
              operation === "create"
                ? { botId: "bot-1", name: "Later", prompt: "say done", crons: ["@once"], ...patch }
                : {
                    routineId: "routine-1",
                    active: true,
                    runAt: new Date(Date.now() + 60_000).toISOString(),
                    ...patch,
                  },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return {
      create,
      update,
      enqueue,
      call,
      findFirst: prisma.routine.findFirst,
      preferences: prisma.spaceModelPreference.findMany,
      secretRead: prisma.secret.findFirst,
    };
  }

  it("refuses to re-arm a routine on an archived bot without writing", async () => {
    const { update, enqueue, call } = fixture(true);
    const { response } = await call();
    expect(response.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-arms a routine on an active bot", async () => {
    const { update, enqueue, call } = fixture(false);
    const { response } = await call();
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "routine-1",
          bot: { archivedAt: null },
          active: false,
          crons: { equals: ["@once"] },
          timezone: "UTC",
          nextRunAt: null,
          lastRunAt: null,
        },
        data: expect.objectContaining({ active: true }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not re-arm when the bot is archived between the read and the write", async () => {
    const { enqueue, call } = fixture(false, true);
    const { response } = await call();
    expect(response.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not re-arm a completed one-shot even if an older edit restored its due date", async () => {
    const { call, update, enqueue } = fixture(false, false, {
      lastRunAt: new Date(1_000),
      nextRunAt: new Date(1_000),
    });
    expect((await call({ active: true, runAt: undefined })).response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  const ownModel = {
    modelProvider: "openai-compatible",
    modelId: "old-model",
    thinkingLevel: "high",
  };

  it.each([
    { label: "recurring prompt", crons: ["*/5 * * * *"], patch: { prompt: "Keep results local" } },
    { label: "recurring model", crons: ["*/5 * * * *"], patch: { thinkingLevel: "low" } },
    { label: "one-shot prompt", crons: ["@once"], patch: { prompt: "Keep results local" } },
    { label: "one-shot model", crons: ["@once"], patch: { thinkingLevel: "low" } },
  ])("preserves the claimed schedule during a concurrent $label edit", async ({ crons, patch }) => {
    const dueAt = new Date(Date.now() - 1_000);
    const oneShot = crons[0] === "@once";
    const advancedNextRunAt = oneShot ? null : new Date(Date.now() + 300_000);
    const f = fixture(false, false, { ...ownModel, crons, active: true, nextRunAt: dueAt });
    // Wake has committed after the handler's first read but before this patch writes.
    f.update.mockImplementationOnce(async ({ data }) => ({
      ...routine,
      ...ownModel,
      crons,
      active: !oneShot,
      lastRunAt: dueAt,
      nextRunAt: advancedNextRunAt,
      ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    }));
    const { response } = await f.call({
      name: routine.name,
      prompt: routine.prompt,
      crons,
      active: true,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      runAt: undefined,
      ...patch,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      json: { nextRunAt: advancedNextRunAt?.toISOString() ?? null, active: !oneShot },
    });
    expect(f.update.mock.calls[0]![0].data).not.toHaveProperty("nextRunAt");
    expect(f.update.mock.calls[0]![0].data).not.toHaveProperty("active");
  });

  it.each([
    {
      label: "wake",
      before: { active: true },
      current: { nextRunAt: new Date(9_000) },
      patch: { timezone: "America/New_York" },
    },
    {
      label: "pause",
      before: { active: true },
      current: { active: false },
      patch: { crons: ["0 9 * * *"] },
    },
    {
      label: "resume",
      before: { active: false },
      current: { active: true },
      patch: { active: true },
    },
    {
      label: "completed one-shot",
      before: { active: false, crons: ["@once"] },
      current: { lastRunAt: new Date(9_000) },
      patch: { active: true },
    },
  ])(
    "rejects an intentional schedule change that races with $label",
    async ({ before, current, patch }) => {
      const snapshot = {
        ...ownModel,
        crons: ["*/5 * * * *"],
        nextRunAt: null,
        lastRunAt: null,
        ...before,
      };
      const f = fixture(false, false, snapshot);
      f.update.mockImplementationOnce(async ({ where, data }) => {
        const actual = { ...routine, ...snapshot, ...current };
        for (const column of ["active", "nextRunAt", "lastRunAt"] as const) {
          if (Object.hasOwn(where, column) && String(where[column]) !== String(actual[column]))
            throw Object.assign(new Error("not found"), { code: "P2025" });
        }
        return {
          ...actual,
          ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
        };
      });
      const { response } = await f.call({
        active: undefined,
        runAt: before.crons ? new Date(Date.now() + 60_000).toISOString() : undefined,
        ...patch,
      });
      expect(response.status).toBe(409);
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    { patch: { active: false }, timezone: "UTC", hour: null },
    { patch: { crons: ["0 9 * * *"] }, timezone: "UTC", hour: 9 },
    { patch: { timezone: "America/New_York" }, timezone: "America/New_York", hour: 9 },
  ])(
    "keeps explicit pause/cron/timezone changes effective: $patch",
    async ({ patch, timezone, hour }) => {
      const f = fixture(false, false, {
        active: true,
        crons: ["0 9 * * *"],
        nextRunAt: new Date(Date.now() - 1_000),
        ...(patch.crons ? { crons: ["*/5 * * * *"] } : {}),
      });
      const { response } = await f.call({ active: undefined, runAt: undefined, ...patch });
      expect(response.status).toBe(200);
      const next = f.update.mock.calls[0]![0].data.nextRunAt;
      if (hour === null) expect(next).toBeNull();
      else {
        expect(next).toBeInstanceOf(Date);
        expect((next as Date).getTime()).toBeGreaterThan(Date.now());
        expect(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: timezone,
            hour: "numeric",
            hourCycle: "h23",
          }).format(next as Date),
        ).toBe(String(hour).padStart(2, "0"));
      }
    },
  );

  it.each(["create", "update"])(
    "rejects unsupported thinking before a routine %s writes or schedules anything",
    async (operation) => {
      const { call, create, update, enqueue } = fixture(false, false, ownModel);
      const { response } = await call(
        operation === "create" ? { ...ownModel, thinkingLevel: "max" } : { thinkingLevel: "max" },
        operation,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        json: { message: "Thinking level must be one of: off, minimal, low, medium, high" },
      });
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("validates custom thinking with the selected model's connection instead of the provider default", async () => {
    const { call, update, preferences, secretRead } = fixture(false, false, ownModel);
    const [current] = await preferences();
    preferences.mockResolvedValue([
      current!,
      {
        ...current!,
        id: "preference-2",
        modelId: "new-model",
        isDefault: false,
        credential: { ...current!.credential, id: "credential-2", secretId: "secret-2" },
      },
    ]);
    expect((await call({ modelId: "new-model", thinkingLevel: "high" })).response.status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({ thinkingLevel: "high" });
    expect(secretRead).toHaveBeenCalledWith({
      where: { id: "secret-2", userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    });
  });

  it("leaves model columns out of unrelated updates", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect(
      (await call({ name: "Renamed", active: undefined, runAt: undefined })).response.status,
    ).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "routine-1", bot: { archivedAt: null } } }),
    );
    const data = update.mock.calls[0]![0].data;
    for (const column of ["modelProvider", "modelId", "thinkingLevel"])
      expect(data).not.toHaveProperty(column);
  });

  it.each(["modelProvider", "modelId", "thinkingLevel"])(
    "rejects a partial model patch when %s changes before the write",
    async (column) => {
      const { call, update, enqueue } = fixture(false, false, ownModel);
      update.mockImplementationOnce(async (args) => {
        const current: Record<string, unknown> = { ...ownModel, [column]: "concurrent-choice" };
        expect(args.where).toMatchObject(ownModel);
        if (args.where[column] !== current[column]) {
          throw Object.assign(new Error("not found"), { code: "P2025" });
        }
        throw new Error("Concurrent model change was not guarded");
      });
      expect((await call({ thinkingLevel: "low" })).response.status).toBe(409);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("returns not found if a model update races with a parent archive", async () => {
    const { call, findFirst } = fixture(false, true, ownModel);
    findFirst.mockResolvedValueOnce({ ...routine, ...ownModel }).mockResolvedValueOnce(null);
    expect((await call({ thinkingLevel: "low" })).response.status).toBe(404);
  });

  it("merges a model-id-only patch with the saved provider and clears old thinking", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect((await call({ modelId: "new-model" })).response.status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "new-model",
      thinkingLevel: null,
    });
  });

  it("merges a provider-only patch with the saved model and clears old thinking", async () => {
    const { call, update } = fixture(false, false, { ...ownModel, modelProvider: "openrouter" });
    expect((await call({ modelProvider: "openai-compatible" })).response.status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "old-model",
      thinkingLevel: null,
    });
  });

  it("keeps an explicitly supplied thinking level when changing models", async () => {
    const { call, update } = fixture(false, false, ownModel, "new-model");
    expect((await call({ modelId: "new-model", thinkingLevel: "low" })).response.status).toBe(200);
    expect(update.mock.calls[0]![0].data).toMatchObject({ thinkingLevel: "low" });
  });

  it("rejects a partial patch whose resulting model is incomplete", async () => {
    const { call, update } = fixture(false, false, ownModel);
    expect((await call({ modelId: null })).response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects thinking without a resulting model", async () => {
    const { call, update } = fixture(false);
    expect((await call({ thinkingLevel: "high" })).response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("threads.followUp", () => {
  const text = "  Continue on the same research task.\n";
  const clientNonce = "feedback:one-request";

  function fixture({
    active = false,
    activeBotIds = active ? ["bot-1"] : [],
    memberBotIds = ["bot-1", "bot-2"],
    ownedAtLock = true,
    replay = false,
  } = {}) {
    let message: { id: string } | null = replay ? { id: "message-1" } : null;
    let lockTail = Promise.resolve();
    const waitingRun = { id: "run-1", status: "waiting_input" };
    const artifactFindMany = vi.fn().mockResolvedValue([]);
    const tx = {
      artifact: { findMany: artifactFindMany },
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2, nextEventSeq: 2 }),
        findFirst: vi.fn(async () => ({
          id: "thread-1",
          spaceId: "space-1",
          userId: "user-1",
          groupId: "group-1",
          activeRecruitingRoleId: "role-1",
        })),
      },
      recruitingRole: {
        findFirst: vi.fn(async () => ({
          id: "role-1",
          sourceThreadId: "thread-1",
          spaceId: "space-1",
          userId: "user-1",
          revision: 1,
          currentRevisionId: "revision-1",
        })),
      },
      recruitingCandidate: { findMany: vi.fn(async () => [{ candidateKey: "candidate-1" }]) },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          spaceId: "space-1",
          userId: "user-1",
          members: memberBotIds.map((botId) => ({
            botId,
            bot: { id: botId, name: botId === "bot-1" ? "Main" : "Sourcer" },
          })),
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      message: {
        findUnique: vi.fn(async () => message),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "question-1",
            blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
          },
        ]),
        create: vi.fn(async () => {
          if (message) throw Object.assign(new Error("duplicate nonce"), { code: "P2002" });
          message = { id: "message-1" };
          return message;
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      task: {
        create: vi.fn(async ({ data }: { data: { botId: string } }) => ({
          id: data.botId === "bot-1" ? "task-1" : "task-2",
        })),
      },
      run: {
        findFirst: vi.fn(async ({ where }: { where: { botId: string } }) =>
          activeBotIds.includes(where.botId)
            ? { ...waitingRun, id: where.botId === "bot-1" ? "run-1" : "run-2" }
            : null,
        ),
        findUnique: vi.fn().mockResolvedValue(active ? waitingRun : { status: "queued" }),
        create: vi.fn(async ({ data }: { data: { botId: string } }) => ({
          id: data.botId === "bot-1" ? "run-1" : "run-2",
        })),
        update: vi.fn(),
      },
      steeringMessage: { create: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({ seq: 1 }) },
    };
    const lockGroup = vi.fn(async (...args: unknown[]) => {
      expect(args.slice(1)).toEqual(["group-1", "space-1", "user-1"]);
      return ownedAtLock ? [{ id: "group-1" }] : [];
    });
    const prisma = {
      artifact: { findMany: artifactFindMany },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" } }),
      },
      taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          name: "Crew",
          thread: { id: "thread-1" },
          members: ["bot-1", "bot-2"].map((id) => ({
            bot: { id, name: id, color: "blue", runs: [] },
          })),
        }),
      },
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => {
        let releaseLock = () => {};
        try {
          return await callback({
            ...tx,
            $queryRaw: async (...args: unknown[]) => {
              if (!Array.isArray(args[0])) return [{ id: "role-1" }];
              // Model the row lock, not the whole transaction: pre-lock reads can race.
              const previous = lockTail;
              lockTail = new Promise<void>((resolve) => {
                releaseLock = resolve;
              });
              await previous;
              return lockGroup(...args);
            },
          });
        } finally {
          releaseLock();
        }
      }),
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn().mockResolvedValue({ taskId: "task-1", runId: "run-1" });
    const handler = new RPCHandler(
      createRouter({
        prisma,
        events: { notify, sendUserMessage },
        jobs: { enqueue },
        env: { sandboxProvider: "fake" },
      } as unknown as RouterDeps),
    );
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return {
      tx,
      artifactFindMany,
      waitingRun,
      lockGroup,
      notify,
      enqueue,
      sendUserMessage,
      call: (input: Record<string, unknown> = {}) =>
        handler.handle(
          new Request("http://127.0.0.1/rpc/threads/followUp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              json: {
                ...(input.botId ? {} : { groupId: "group-1" }),
                text,
                clientNonce,
                ...input,
              },
            }),
          }),
          { prefix: "/rpc", context: { actor } },
        ),
    };
  }

  it.each(["bot", "group"] as const)(
    "attaches the selected saved file version to a non-answering %s follow-up",
    async (kind) => {
      const f = fixture({ active: true });
      const artifact = {
        id: "artifact-v2",
        name: "outreach-draft.json",
        mimeType: "application/json",
        size: 42,
        storageKey: "saved-version-2",
        version: 2,
      };
      f.artifactFindMany.mockResolvedValue([artifact]);
      const { response } = await f.call({
        ...(kind === "bot" ? { botId: "bot-1" } : { mentions: ["bot-2"] }),
        artifactIds: [artifact.id],
      });
      expect(response.status).toBe(200);
      expect(f.artifactFindMany).toHaveBeenCalledExactlyOnceWith({
        where: {
          id: { in: [artifact.id] },
          spaceId: "space-1",
          userId: "user-1",
          ...(kind === "bot"
            ? { botId: "bot-1", groupId: null }
            : {
                OR: [{ groupId: "group-1" }, { groupId: null, botId: { in: ["bot-1", "bot-2"] } }],
              }),
        },
      });
      const blocks = [
        { kind: "text", text },
        {
          kind: "file",
          artifactId: artifact.id,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
        },
      ];
      const prompt = `${text}\n\nUser attached file "outreach-draft.json" (application/json, 42 bytes).`;
      if (kind === "bot") {
        expect(f.sendUserMessage).toHaveBeenCalledWith(
          expect.objectContaining({ blocks, prompt, trigger: "follow_up", clientNonce }),
        );
      } else {
        expect(f.tx.message.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ blocks, clientNonce }) }),
        );
        expect(f.tx.task.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ botId: "bot-2", prompt }),
        });
      }
      expect(f.tx.message.findMany).not.toHaveBeenCalled();
      expect(f.tx.run.update).not.toHaveBeenCalled();
      expect(f.waitingRun.status).toBe("waiting_input");
    },
  );

  it.each(["bot", "group"] as const)(
    "rejects a foreign saved file before writing a %s follow-up",
    async (kind) => {
      const f = fixture();
      const { response } = await f.call({
        ...(kind === "bot" ? { botId: "bot-1" } : {}),
        artifactIds: ["foreign-artifact"],
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(f.artifactFindMany).toHaveBeenCalledOnce();
      expect(f.sendUserMessage).not.toHaveBeenCalled();
      expect(f.tx.message.create).not.toHaveBeenCalled();
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it("does not duplicate an attached group follow-up on a nonce replay", async () => {
    const f = fixture({ active: true });
    f.artifactFindMany.mockResolvedValue([
      {
        id: "artifact-v2",
        name: "draft.json",
        mimeType: "application/json",
        size: 42,
        storageKey: "saved-v2",
      },
    ]);
    const request = { artifactIds: ["artifact-v2"], mentions: ["bot-2"] };
    const first = await f.call(request);
    const replay = await f.call(request);
    expect([first.response.status, replay.response.status]).toEqual([200, 200]);
    expect(f.artifactFindMany).toHaveBeenCalledOnce();
    expect(f.tx.message.create).toHaveBeenCalledOnce();
    expect(f.tx.event.create).toHaveBeenCalledOnce();
    expect(f.tx.run.create).toHaveBeenCalledOnce();
  });

  it("rejects too many follow-up attachments at the shared contract boundary", async () => {
    const f = fixture();
    const { response } = await f.call({
      artifactIds: Array.from(
        { length: ATTACHMENT_MAX_COUNT + 1 },
        (_, index) => `artifact-${index}`,
      ),
    });
    expect(response.status).toBe(400);
    expect(f.artifactFindMany).not.toHaveBeenCalled();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });

  it.each(["bot", "group"] as const)(
    "persists authored feedback metadata through the existing %s follow-up",
    async (kind) => {
      const f = fixture();
      const recruitingFeedback = {
        roleId: "role-1",
        roleRevisionId: "revision-1",
        expectedRoleRevision: 1,
        candidateKeys: ["candidate-1"],
        choice: "not_fit",
      };
      const { response } = await f.call({
        ...(kind === "bot" ? { botId: "bot-1" } : {}),
        recruitingFeedback,
      });
      expect(response.status).toBe(200);
      const call =
        kind === "bot"
          ? f.sendUserMessage.mock.calls[0]![0]
          : f.tx.message.create.mock.calls[0]![0].data;
      expect(call.blocks).toEqual([{ kind: "text", text, recruitingFeedback }]);
      if (kind === "group") expect(f.tx.recruitingCandidate.findMany).toHaveBeenCalledOnce();
    },
  );

  it("routes explicit feedback to idle Sourcer while Main keeps its pending ask", async () => {
    const { call, tx, waitingRun, enqueue } = fixture({ active: true });
    const { response } = await call({ mentions: ["bot-2"] });

    expect(response.status).toBe(200);
    expect(tx.run.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        botId: "bot-2",
        trigger: "follow_up",
        sourceMessageId: "message-1",
      }),
      select: { id: true },
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.message.findMany).not.toHaveBeenCalled();
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(waitingRun.status).toBe("waiting_input");
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: { runId: "run-2" } }),
    );
  });

  it("creates one human message and event for two explicit recipients and enqueues both", async () => {
    const { call, tx, enqueue } = fixture();
    const { response } = await call({ mentions: ["bot-2", "bot-1", "bot-2"] });

    expect(response.status).toBe(200);
    expect(tx.message.create).toHaveBeenCalledOnce();
    expect(tx.message.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "message-1" },
      data: { runId: "run-2" },
    });
    expect(tx.task.create.mock.calls.map(([{ data }]) => data.botId)).toEqual(["bot-2", "bot-1"]);
    expect(tx.run.create.mock.calls.map(([{ data }]) => data.botId)).toEqual(["bot-2", "bot-1"]);
    expect(tx.event.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        botId: "bot-2",
        runId: "run-2",
        payload: {
          messageId: "message-1",
          role: "user",
          blocks: [{ kind: "text", text }],
          runIds: ["run-2", "run-1"],
        },
      }),
    });
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["run-2", "run-1"]);
  });

  it.each(["foreign-bot", "bot-2"])(
    "rejects unavailable explicit recipient %s before writing",
    async (botId) => {
      const { call, tx, notify, enqueue } = fixture({ memberBotIds: ["bot-1"] });
      const { response } = await call({ mentions: ["bot-1", botId] });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(tx.message.create).not.toHaveBeenCalled();
      expect(tx.event.create).not.toHaveBeenCalled();
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(tx.run.create).not.toHaveBeenCalled();
      expect(tx.steeringMessage.create).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("accepts concurrent duplicate explicit fanout only once", async () => {
    const { call, tx, notify, enqueue } = fixture();
    const results = await Promise.all([
      call({ mentions: ["bot-1", "bot-2"] }),
      call({ mentions: ["bot-1", "bot-2"] }),
    ]);

    expect(results.map(({ response }) => response.status)).toEqual([200, 200]);
    expect(tx.message.create).toHaveBeenCalledOnce();
    expect(tx.event.create).toHaveBeenCalledOnce();
    expect(tx.run.create).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("binds a shared follow-up to the selected waiting and idle bots and only enqueues the new run", async () => {
    const { call, tx, enqueue } = fixture({ active: true });
    const { response } = await call({ mentions: ["bot-1", "bot-2"] });

    expect(response.status).toBe(200);
    expect(tx.message.create).toHaveBeenCalledOnce();
    expect(tx.steeringMessage.create).toHaveBeenCalledExactlyOnceWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: "run-1" },
    });
    expect(tx.run.create.mock.calls.map(([{ data }]) => data.botId)).toEqual(["bot-2"]);
    expect(tx.event.create.mock.calls[0]![0].data.payload).toEqual({
      messageId: "message-1",
      role: "user",
      blocks: [{ kind: "text", text }],
      runIds: ["run-1", "run-2"],
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: { runId: "run-2" } }),
    );
  });

  it("steers only the selected waiting bot without answering any pending card", async () => {
    const { call, tx, waitingRun, enqueue } = fixture({ activeBotIds: ["bot-1", "bot-2"] });
    const { response } = await call({ mentions: ["bot-2"] });

    expect(response.status).toBe(200);
    expect(tx.steeringMessage.create).toHaveBeenCalledExactlyOnceWith({
      data: { messageId: "message-1", botId: "bot-2", userId: "user-1", runId: "run-2" },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.findMany).not.toHaveBeenCalled();
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(waitingRun.status).toBe("waiting_input");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["bot_message", null],
    ["routine", null],
    ["webhook", null],
    ["created", null],
    ["tickets", null],
    ["user", "run-1"],
    ["follow_up", "run-1"],
    ["messaging", "run-1"],
  ] as const)(
    "routes a human group follow-up during a %s turn to its own recipient",
    async (trigger, runId) => {
      const { call, tx, waitingRun, enqueue } = fixture({ active: true });
      Object.assign(waitingRun, { status: "running", trigger });

      const { response } = await call();

      expect(response.status).toBe(200);
      expect(tx.steeringMessage.create).toHaveBeenCalledExactlyOnceWith({
        data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId },
      });
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(tx.run.create).not.toHaveBeenCalled();
      expect(tx.run.update).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("does not interpret candidate text as a recipient mention", async () => {
    const { call, tx } = fixture();
    const { response } = await call({
      text: "Candidate's evidence mentions @Sourcer and @everyone.",
    });

    expect(response.status).toBe(200);
    expect(tx.run.create.mock.calls.map(([{ data }]) => data.botId)).toEqual(["bot-1"]);
  });

  it.each([{ mentions: undefined }, { mentions: [] }])(
    "keeps direct bot follow-ups unchanged with mentions $mentions",
    async ({ mentions }) => {
      const { call, sendUserMessage, enqueue, tx } = fixture();
      const { response } = await call({ botId: "bot-1", mentions });

      expect(response.status).toBe(200);
      expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "follow_up",
        clientNonce,
      });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it("rejects explicit recipients in a direct bot follow-up before writing", async () => {
    const { call, sendUserMessage, enqueue } = fixture();
    const { response } = await call({ botId: "bot-1", mentions: ["bot-2"] });

    expect(response.status).toBe(400);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([{ mentions: [""] }, { mentions: Array.from({ length: 65 }, () => "bot-2") }])(
    "rejects an invalid explicit recipient list before writing: $mentions",
    async ({ mentions }) => {
      const { call, tx } = fixture();
      const { response } = await call({ mentions });

      expect(response.status).toBe(400);
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "accepts concurrent duplicate group follow-ups once with an active run: %s",
    async (active) => {
      const { call, tx, waitingRun, lockGroup, notify, enqueue } = fixture({ active });
      const results = await Promise.all([call(), call()]);
      expect(results.map(({ response }) => response.status)).toEqual([200, 200]);
      for (const { response } of results) {
        await expect(response.json()).resolves.toEqual({ json: { ok: true } });
      }
      expect(lockGroup).toHaveBeenCalledTimes(2);
      expect(tx.message.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          role: "user",
          blocks: [{ kind: "text", text }],
          clientNonce,
        }),
      });
      expect(tx.message.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: "message-1" },
        data: { runId: "run-1" },
      });
      expect(tx.event.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          type: "thread.message.created",
          runId: "run-1",
          payload: {
            messageId: "message-1",
            role: "user",
            blocks: [{ kind: "text", text }],
            runIds: ["run-1"],
            ...(active ? { queued: true } : {}),
          },
        }),
      });
      expect(tx.task.create).toHaveBeenCalledTimes(active ? 0 : 1);
      expect(tx.run.create).toHaveBeenCalledTimes(active ? 0 : 1);
      expect(tx.steeringMessage.create).toHaveBeenCalledTimes(active ? 1 : 0);
      expect(tx.message.findMany).not.toHaveBeenCalled();
      expect(tx.run.update).not.toHaveBeenCalled();
      expect(waitingRun.status).toBe("waiting_input");
      expect(notify).toHaveBeenCalledExactlyOnceWith("thread-1", 1);
      expect(enqueue).toHaveBeenCalledTimes(active ? 0 : 1);
    },
  );

  it("rechecks group ownership before accepting a replay after access is revoked", async () => {
    const { call, tx, lockGroup, notify, enqueue } = fixture({ ownedAtLock: false, replay: true });
    const { response } = await call();
    expect(response.status).toBe(500);
    expect(lockGroup).toHaveBeenCalledOnce();
    expect(tx.message.findUnique).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("threads.endCall", () => {
  function fixture(duplicateMarker?: boolean, userSpoke = true) {
    const created: { blocks?: unknown; clientNonce?: string }[] = [];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 5 }) },
      message: {
        findFirst: vi.fn().mockResolvedValue(userSpoke ? { id: "utterance-1" } : null),
        create: vi.fn(async ({ data }: { data: { blocks: unknown; clientNonce?: string } }) => {
          if (duplicateMarker) throw Object.assign(new Error("unique"), { code: "P2002" });
          created.push({ blocks: data.blocks, clientNonce: data.clientNonce });
          return { id: "message-1" };
        }),
      },
      event: vi.fn(),
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      },
    };
    tx.event = {
      create: vi.fn(async ({ data }: { data: { type: string; payload: never } }) => {
        events.push({ type: data.type, payload: data.payload });
        return { seq: 4, threadId: "thread-1" };
      }),
    } as never;
    const prisma = {
      bot: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" }, computer: null }),
      },
      taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      jobs: { enqueue },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));
    return {
      tx,
      created,
      events,
      enqueue,
      call: () =>
        handler.handle(
          new Request("http://127.0.0.1/rpc/threads/endCall", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { botId: "bot-1", callId: "call-1" } }),
          }),
          { prefix: "/rpc", context: { actor } },
        ),
    };
  }

  it("closes the card and queues a call_end run", async () => {
    const { call, created, events, tx, enqueue } = fixture();
    const { response } = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(created[0]?.blocks).toEqual([
      { kind: "voice_call", callId: "call-1", title: "", farewell: "" },
    ]);
    expect(created[0]?.clientNonce).toBe("call:call-1:marker");
    expect(events.map((event) => event.type)).toEqual([
      "thread.message.created",
      "thread.call.ended",
    ]);
    expect(events[1]?.payload).toMatchObject({
      callId: "call-1",
      title: "",
      messageId: "message-1",
    });
    expect(events[0]?.payload).toMatchObject({ callId: "call-1", messageId: "message-1" });
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "call_end", taskId: "task-1" }),
      }),
    );
    expect(String(tx.run.create.mock.calls[0]?.[0]?.data?.clientNonce)).toMatch(/^call:call-1:/);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("is a no-op for a late hang-up with no user call utterance", async () => {
    const { call, created, events, tx, enqueue } = fixture(false, false);
    const { response } = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-1",
          role: "user",
          clientNonce: { startsWith: "call:call-1:" },
        }),
      }),
    );
    expect(created).toEqual([]);
    expect(events).toEqual([]);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("is a no-op when a concurrent hang-up already wrote the marker", async () => {
    const { call, created, events, tx, enqueue } = fixture(true);
    const { response } = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(created).toEqual([]);
    expect(events).toEqual([]);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("groups.archive", () => {
  async function archiveGroup(archivedAt: Date | null) {
    const calls: string[] = [];
    const groupUpdate = vi.fn();
    // As in production: the run's computer is known only through its execution lease.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          archivedAt,
          thread: { id: "thread-1" },
        }),
        update: groupUpdate,
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3 },
          ]),
        updateMany: vi.fn(async () => {
          calls.push("expire lease");
        }),
      },
      computer: {
        findMany: vi.fn(async ({ where }: { where: { OR?: unknown } }) =>
          where.OR
            ? [
                {
                  id: "computer-1",
                  homeKey: "home-1",
                  kind: "docker",
                  providerRef: "computer-1",
                  executionBotId: null,
                  executionRunId: null,
                },
              ]
            : [],
        ),
        updateMany: vi.fn(),
      },
      event: { deleteMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      computerExecutionLease: {
        updateMany: vi.fn(async () => {
          calls.push("expire lease");
        }),
      },
      computer: { updateMany: vi.fn() },
    } as unknown as PrismaClient;
    const releaseScreen = vi.fn(async () => {
      calls.push("release screen");
    });
    const execute = vi.fn(() => {
      calls.push("cancel run work");
      return [];
    });
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
      sandbox: { releaseScreen, execute },
      jobs: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await new RPCHandler(createRouter(deps)).handle(
      new Request("http://127.0.0.1/rpc/groups/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { groupId: "group-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, releaseScreen, calls, groupUpdate };
  }

  it("stops each member's run work and releases its screen before expiring the lease", async () => {
    const { response, releaseScreen, calls } = await archiveGroup(null);

    expect(response?.status).toBe(200);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(calls).toEqual(["cancel run work", "release screen", "expire lease"]);
  });

  it("finishes teardown when the group is already archived and a lease is still live", async () => {
    const { response, releaseScreen, calls, groupUpdate } = await archiveGroup(
      new Date("2026-09-26T00:00:00.000Z"),
    );

    expect(response?.status).toBe(200);
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(calls).toEqual(["cancel run work", "release screen", "expire lease"]);
  });
});

describe("boards.rename", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function boardRow(ticketPrefix = "RAK") {
    return {
      id: "board-1",
      spaceId: "workspace-1",
      name: "Personal",
      ticketPrefix,
      nextNumber: 2,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
  }

  function renameDeps(tickets: number, ticketPrefix = "RAK") {
    const count = vi.fn(async () => tickets);
    const update = vi.fn(async ({ data }: { data: { name?: string; ticketPrefix?: string } }) => ({
      ...boardRow(ticketPrefix),
      ...data,
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    }));
    const prisma = {
      board: {
        findUnique: vi.fn(async () => boardRow(ticketPrefix)),
        update,
      },
      ticket: { count },
    } as unknown as PrismaClient;
    const deps = { prisma, env: { ticketBoardEnabled: true } } as unknown as RouterDeps;
    return { count, update, handler: new RPCHandler(createRouter(deps)) };
  }

  async function rename(handler: RPCHandler<never>, body: unknown) {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/boards/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("rejects a prefix change after tickets exist", async () => {
    const { count, update, handler } = renameDeps(2);
    const response = await rename(handler, { ticketPrefix: "OPS" });
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Cannot change the ticket prefix once tickets exist.",
      }),
    });
    expect(count).toHaveBeenCalledWith({
      where: { boardId: "board-1", spaceId: "workspace-1" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("renames the board without changing the prefix", async () => {
    const { count, update, handler } = renameDeps(2);
    const response = await rename(handler, { name: "Launch" });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({ name: "Launch", ticketPrefix: "RAK" }),
    });
    expect(count).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "board-1" },
      data: { name: "Launch" },
    });
  });
});

describe("export.bot", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function homeWith(files: Record<string, string | Uint8Array>) {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-export-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(home.pathFor("home-1"), file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return home;
  }

  async function exportFiles(scope: "team" | "dedicated", home: LocalAgentHomeStore) {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          name: "Writer",
          title: "",
          description: "",
          instructions: "",
          thread: { id: "thread-1" },
          computer: { id: "computer-1", scope, homeKey: "home-1" },
        }),
      },
      memoryDocument: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      message: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      home,
      env: {
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "docker",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    const manifest = await client.export.bot({ botId: "bot-1" });
    return manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  it("exports only the bot's own folder from a Team Computer", async () => {
    const home = await homeWith({
      "bots/bot-1/notes/result.txt": "mine",
      "bots/bot-1/project/.gitignore": "dist",
      "bots/bot-1/.cache/pip/wheel": "cache",
      "bots/bot-10/notes.txt": "prefix-sharing bot",
      "bots/bot-2/private.txt": "other bot",
      "shared/handoff.txt": "shared",
      ".cache/fontconfig/cache-1": Uint8Array.from([0, 159, 146, 150]),
      ".browser-profiles/chromium-bot-1/Cookies": "session",
    });
    const own = path.join(home.pathFor("home-1"), "bots/bot-1");
    await symlink("../bot-2", path.join(own, "peer-dir"));
    await symlink("../bot-2/private.txt", path.join(own, "peer-file"));
    await symlink("../../shared", path.join(own, "shared-link"));
    await symlink(".cache/pip/wheel", path.join(own, "wheel.txt"));

    expect(await exportFiles("team", home)).toEqual([
      { path: "notes/result.txt", content: "mine" },
      { path: "project/.gitignore", content: "dist" },
    ]);
  });

  it("keeps the bot's files that another bot links to", async () => {
    const home = await homeWith({
      "bots/bot-1/attachments/photo.bin": Uint8Array.from([0, 255]),
      "bots/bot-00/notes.txt": "other bot",
    });
    await symlink("../bot-1/attachments", path.join(home.pathFor("home-1"), "bots/bot-00/grab"));

    expect((await exportFiles("team", home)).map((file) => file.path)).toEqual([
      "attachments/photo.bin",
    ]);
  });

  it("exports nothing when the bot's Team Computer folder is a link", async () => {
    const home = await homeWith({ "bots/bot-2/private.txt": "other bot" });
    await symlink("bot-2", path.join(home.pathFor("home-1"), "bots/bot-1"));

    expect(await exportFiles("team", home)).toEqual([]);
  });

  it("skips machine state at the root of a Private Computer home", async () => {
    const home = await homeWith({
      "notes/result.txt": "mine",
      "project/.gitignore": "dist",
      ".cache/fontconfig/cache-1": Uint8Array.from([0, 159, 146, 150]),
      ".config/mimeapps.list": "[Default Applications]",
      ".browser-profiles/chromium/Cookies": "session",
      ".bash_history": "history",
    });
    const root = home.pathFor("home-1");
    await symlink(".bash_history", path.join(root, "history.txt"));
    await symlink(".config/mimeapps.list", path.join(root, "notes/mimeapps.list"));
    await symlink(".gitignore", path.join(root, "project/ignore.txt"));

    expect((await exportFiles("dedicated", home)).map((file) => file.path)).toEqual([
      "notes/result.txt",
      "project/.gitignore",
      "project/ignore.txt",
    ]);
  });

  it("keeps binary and byte-order-marked files byte-exact", async () => {
    const binary = Uint8Array.from([0, 255, 137, 80, 78, 71, 13, 10, 26, 10, 192, 128]);
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")]);
    const home = await homeWith({ "image.png": binary, "bom.txt": bom, "plain.txt": "שלום ✎" });

    const files = await exportFiles("dedicated", home);
    expect(files).toEqual([
      { path: "bom.txt", content: "\uFEFFhello" },
      { path: "image.png", content: Buffer.from(binary).toString("base64"), encoding: "base64" },
      { path: "plain.txt", content: "שלום ✎" },
    ]);
    expect(new TextEncoder().encode(files[0]!.content)).toEqual(bom);
  });
});

describe("link favicons", () => {
  function faviconClient(actor: Actor | null) {
    const favicon = vi.fn().mockResolvedValue({ icon: "data:image/png;base64,AAAA" });
    const deps = {
      prisma: {} as PrismaClient,
      favicons: { favicon },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    return { client, favicon };
  }

  const reader = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: false,
  } satisfies Actor;

  it("answers a signed-in reader with the resolved icon for an origin", async () => {
    const { client, favicon } = faviconClient(reader);
    await expect(client.links.favicon({ origin: "https://x.com" })).resolves.toEqual({
      icon: "data:image/png;base64,AAAA",
    });
    expect(favicon).toHaveBeenCalledWith("https://x.com");
  });

  it("passes a busy answer through so the client can ask again", async () => {
    const { client, favicon } = faviconClient(reader);
    favicon.mockResolvedValue({ icon: null, retry: true });
    await expect(client.links.favicon({ origin: "https://x.com" })).resolves.toEqual({
      icon: null,
      retry: true,
    });
  });

  it("accepts the longest origin a host name allows and nothing longer", async () => {
    const { client, favicon } = faviconClient(reader);
    // 253 characters: three 63-character labels and one 61-character label.
    const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(host).toHaveLength(253);
    const longest = `https://${host}:65535`;
    await expect(client.links.favicon({ origin: longest })).resolves.toBeDefined();
    expect(favicon).toHaveBeenCalledWith(longest);
    await expect(client.links.favicon({ origin: `${longest}0` })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a request without a session before resolving anything", async () => {
    const { client, favicon } = faviconClient(null);
    await expect(client.links.favicon({ origin: "https://x.com" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(favicon).not.toHaveBeenCalled();
  });
});

describe("spaces.subscribe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function sidebarStream() {
    vi.useFakeTimers();
    let queued = 0;
    let waiting: ((result: IteratorResult<undefined>) => void) | undefined;
    const follow = {
      next: vi.fn(() => {
        if (queued > 0) {
          queued -= 1;
          return Promise.resolve({ done: false as const, value: undefined });
        }
        return new Promise<IteratorResult<undefined>>((resolve) => {
          waiting = resolve;
        });
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const wake = () => {
      if (!waiting) {
        queued += 1;
        return;
      }
      waiting({ done: false, value: undefined });
      waiting = undefined;
    };
    const bots = [
      { id: "bot-1", userId: "user-1", status: "idle", unread: false, text: "hello" },
      { id: "bot-2", userId: "user-2", status: "running", unread: true, text: "theirs" },
    ];
    const prisma = {
      bot: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; spaceId: string } }) =>
          bots
            .filter((bot) => bot.userId === where.userId)
            .map((bot) => ({
              id: bot.id,
              spaceId: where.spaceId,
              name: bot.id,
              title: "",
              description: "",
              instructions: "",
              color: "#000000",
              notifyOnFinish: true,
              pinned: false,
              sectionId: null,
              archivedAt: null,
              parentBotId: null,
              memoryScope: null,
              createdAt: new Date("2026-08-15T12:00:00.000Z"),
              updatedAt: new Date("2026-08-15T12:00:00.000Z"),
              thread: {
                id: `thread-${bot.id}`,
                unread: bot.unread,
                messages: [{ seq: 1, runId: null, blocks: [{ kind: "text", text: bot.text }] }],
                runs: [],
              },
              runs: bot.status === "idle" ? [] : [{ status: bot.status }],
              computer: null,
            })),
        ),
      },
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { followSidebar: vi.fn(() => follow) },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const client = createRouterClient(createRouter(deps), {
      context: { actor, stillAuthorized: vi.fn().mockResolvedValue(true) },
    });
    return { client, wake, follow, bots, deps };
  }

  it("replays the caller's own bots on open, then pushes only changed states", async () => {
    const { client, wake, bots, deps } = sidebarStream();
    const stream = await client.spaces.subscribe({ since: "2026-08-15T11:00:00.000Z" });

    wake();
    await expect(stream.next()).resolves.toMatchObject({
      value: { botId: "bot-1", status: "idle", unread: false, preview: "hello" },
    });
    expect(deps.events.followSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "workspace-1", userId: "user-1" }),
      undefined,
    );

    bots[0]!.status = "running";
    wake();
    await expect(stream.next()).resolves.toMatchObject({
      value: { botId: "bot-1", status: "running", unread: false, preview: "hello" },
    });

    // A wake with nothing changed (and user-2's bot-2 never present) yields nothing before the heartbeat.
    wake();
    const next = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    const frame = (await next).value as { botId?: string };
    expect(frame.botId).toBeUndefined();
  });

  it("heartbeats while idle and closes the follower on return", async () => {
    const { client, follow } = sidebarStream();
    const stream = await client.spaces.subscribe({});
    const next = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await expect(next).resolves.toMatchObject({ value: { updatedAt: expect.any(String) } });
    await stream.return(undefined);
    expect(follow.return).toHaveBeenCalled();
  });
});
