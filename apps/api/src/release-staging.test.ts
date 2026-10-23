import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStagingApp } from "./release-staging.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  disconnect: vi.fn(),
  poolEnd: vi.fn(),
  persisted: vi.fn(),
  normalApp: vi.fn(),
  normalEnv: vi.fn(),
  rootEnv: vi.fn(),
  serve: vi.fn(),
}));
vi.mock("@rakazo/db", () => ({
  createDb: () => ({
    prisma: {
      $queryRaw: mocks.query,
      $disconnect: mocks.disconnect,
      integrationProviderConfig: { findUnique: mocks.persisted },
      mcpServer: { findMany: mocks.persisted },
      account: { findMany: mocks.persisted },
    },
    pool: { end: mocks.poolEnd },
  }),
}));
vi.mock("./app.js", () => ({ createApp: mocks.normalApp }));
vi.mock("./env.js", () => ({ loadEnv: mocks.normalEnv }));
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: mocks.rootEnv }));
vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));
vi.mock("@rakazo/logging/axiom", () => ({
  createRootLogger: () => ({ info: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

const config = {
  databaseUrl: "postgres://synthetic@127.0.0.1/rakazo_staging",
  revision: "a".repeat(40),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([{ "?column?": 1 }]);
  mocks.persisted.mockImplementation(() => {
    throw new Error("Persisted provider must not load");
  });
  mocks.normalApp.mockImplementation(() => {
    throw new Error("Normal app must not start");
  });
  mocks.normalEnv.mockImplementation(() => {
    throw new Error("Normal env must not resolve");
  });
  mocks.serve.mockReturnValue({ on: vi.fn(), close: vi.fn() });
});
afterEach(() => vi.restoreAllMocks());

describe("restricted hosted staging API", () => {
  it("uses real DB readiness and source identity without reading persisted providers", async () => {
    const { app, stop } = createStagingApp(config);
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-rakazo-profile")).toBe("staging");
    expect(ready.headers.get("x-rakazo-revision")).toBe(config.revision);
    expect(await ready.json()).toEqual({ ok: true, degraded: false });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[0]).toEqual(["SELECT 1"]);
    expect((await app.request("/health")).status).toBe(200);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.persisted).not.toHaveBeenCalled();
    await stop();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
  });

  it("rejects every other path and method even with a cookie", async () => {
    const { app, stop } = createStagingApp(config);
    for (const [method, path] of [
      ["POST", "/api/__release_smoke_denied__"],
      ["POST", "/rpc/recruiting/crmSync"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-up/email"],
      ["GET", "/internal/health"],
      ["POST", "/ready"],
      ["HEAD", "/ready"],
      ["GET", "/rpc/connections/list"],
      ["GET", "/ready/"],
    ]) {
      const response = await app.request(path, {
        method,
        headers: { cookie: "existing=synthetic" },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("x-rakazo-profile")).toBe("staging");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.persisted).not.toHaveBeenCalled();
    await stop();
  });

  it("fails readiness on a database outage without leaking driver errors", async () => {
    mocks.query.mockRejectedValue(new Error("private connection details"));
    const { app, stop } = createStagingApp(config);
    const response = await app.request("/ready");
    expect(response.status).toBe(503);
    expect(response.headers.get("x-rakazo-profile")).toBe("staging");
    expect(await response.json()).toEqual({ ok: false, degraded: true });
    await stop();
  });

  it("entrypoint selects staging before normal app, dotenv or provider configuration", async () => {
    const previous = process.env;
    process.env = {
      RAKAZO_RELEASE_PROFILE: "staging",
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WEB_PROVIDER: "fake",
      CLOUD_AGENT_PROVIDER: "none",
      WAKEUP_DRIVER: "memory",
      SECRET_STORE: "encrypted",
      MCP_STDIO_ENABLED: "false",
      DATABASE_URL: config.databaseUrl,
      RAKAZO_GIT_SHA: config.revision,
    };
    vi.spyOn(process, "once").mockReturnValue(process);
    try {
      await import("./index.js");
      expect(mocks.serve).toHaveBeenCalledOnce();
      expect(mocks.normalApp).not.toHaveBeenCalled();
      expect(mocks.normalEnv).not.toHaveBeenCalled();
      expect(mocks.rootEnv).not.toHaveBeenCalled();
      expect(mocks.persisted).not.toHaveBeenCalled();
    } finally {
      process.env = previous;
    }
  });
});
