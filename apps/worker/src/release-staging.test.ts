import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStagingWorker } from "./release-staging.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  disconnect: vi.fn(),
  poolEnd: vi.fn(),
  persisted: vi.fn(),
  normalRealtime: vi.fn(),
  normalSecrets: vi.fn(),
  rootEnv: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createDb: () => ({
    prisma: {
      $queryRaw: mocks.query,
      $disconnect: mocks.disconnect,
      integrationProviderConfig: { findUnique: mocks.persisted },
      run: { findMany: mocks.persisted },
    },
    pool: { end: mocks.poolEnd },
  }),
}));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  PostgresRealtimeFanout: mocks.normalRealtime,
}));
vi.mock("./secret-store.js", () => ({ createWorkerSecretStore: mocks.normalSecrets }));
vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: mocks.rootEnv }));
vi.mock("@rakazo/logging/axiom", () => ({
  createRootLogger: () => ({ info: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

const config = {
  databaseUrl: "postgres://synthetic@127.0.0.1/rakazo_staging",
  revision: "a".repeat(40),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.query.mockResolvedValue([{ "?column?": 1 }]);
  mocks.persisted.mockImplementation(() => {
    throw new Error("Persisted jobs/providers must not load");
  });
  mocks.normalRealtime.mockImplementation(() => {
    throw new Error("Normal worker must not start");
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("restricted hosted staging worker", () => {
  it("checks only DB reachability and stops idempotently without processing saved jobs", async () => {
    const stop = await startStagingWorker(config);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[0]).toEqual(["SELECT 1"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.persisted).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
    await stop();
    await stop();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails startup and closes the DB on a failed probe", async () => {
    mocks.query.mockRejectedValue(new Error("private database endpoint"));
    await expect(startStagingWorker(config)).rejects.toThrow(
      "Restricted staging worker database check failed",
    );
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.persisted).not.toHaveBeenCalled();
  });

  it("entrypoint skips normal worker providers, dotenv and job composition", async () => {
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
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.query).toHaveBeenCalledOnce();
      expect(mocks.normalRealtime).not.toHaveBeenCalled();
      expect(mocks.normalSecrets).not.toHaveBeenCalled();
      expect(mocks.rootEnv).not.toHaveBeenCalled();
      expect(mocks.persisted).not.toHaveBeenCalled();
    } finally {
      process.env = previous;
    }
  });
});
