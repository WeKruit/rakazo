import { EventEmitter } from "node:events";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  createPool,
  isTooManyDatabaseConnections,
  Prisma,
  parsePositiveInteger,
  retryOnTooManyConnections,
} from "./client.js";

const pools: Array<{ end: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("createDb", () => {
  it("admits a bounded remote checkout once while preserving the snapshot transaction", async () => {
    const { prisma, pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
    pools.push(pool);
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (_query: { text: string }) => ({ rows: [], fields: [], rowCount: 0 })),
      release: vi.fn(),
    });
    const ready = new Promise<PoolClient>((resolve) =>
      setTimeout(() => resolve(client as unknown as PoolClient), 2_500),
    );
    const checkout = vi.spyOn(pool, "connect").mockImplementation(() => ready);
    const read = vi.fn(async () => "snapshot");
    try {
      await expect(
        prisma.$transaction(read, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        }),
      ).resolves.toBe("snapshot");
      expect(checkout).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(client.query.mock.calls.map(([query]) => query.text)).toEqual([
        "BEGIN",
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        "COMMIT",
      ]);
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      await ready;
      await prisma.$disconnect();
    }
  });
  it("caps the pg pool and swallows idle-client errors so they cannot crash the process", () => {
    const { pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo", {
      poolMax: 3,
      applicationName: "rakazo-test",
    });
    pools.push(pool);

    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(0);
    expect(pool.options.application_name).toBe("rakazo-test");
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(pool.listenerCount("connect")).toBeGreaterThan(0);

    expect(() => pool.emit("error", new Error("idle client lost"))).not.toThrow();
  });

  it("defaults to a four-connection pool", () => {
    const { pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
    pools.push(pool);
    expect(pool.options.max).toBe(4);
  });
});

describe("pool wait log", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    installLogger(createLogger({ service: "rakazo-test", level: "off", sinks: [] }));
  });

  it("summarizes slow checkouts once per minute and stays quiet when nothing waited", async () => {
    vi.useFakeTimers({ now: 0 });
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
    let delay = 0;
    vi.spyOn(Pool.prototype, "connect").mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ release: () => undefined } as unknown as PoolClient), delay),
        ) as never,
    );
    const pool = createPool("postgres://rakazo:rakazo@127.0.0.1:9/rakazo", {
      poolMax: 2,
      applicationName: "rakazo-worker",
    });
    const checkout = async () => {
      const pending = pool.connect();
      await vi.advanceTimersByTimeAsync(delay);
      await pending;
    };

    await checkout();
    vi.setSystemTime(61_000);
    await checkout();
    expect(sink.events.filter((event) => event.message === "db.pool.wait")).toEqual([]);

    delay = 400;
    await checkout();
    delay = 0;
    vi.setSystemTime(130_000);
    await checkout();
    const waits = sink.events.filter((event) => event.message === "db.pool.wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      pool: "rakazo-worker",
      max: 2,
      checkouts: 2,
      waited: 1,
      maxMs: 400,
    });
  });
});

describe("parsePositiveInteger", () => {
  it("falls back when the value is missing, zero, or not an integer", () => {
    expect(parsePositiveInteger(undefined, 8)).toBe(8);
    expect(parsePositiveInteger("0", 8)).toBe(8);
    expect(parsePositiveInteger("nope", 8)).toBe(8);
    expect(parsePositiveInteger("6", 8)).toBe(6);
  });
});

describe("isTooManyDatabaseConnections", () => {
  it("recognises Prisma P2037 and Postgres 53300", () => {
    expect(isTooManyDatabaseConnections({ code: "P2037" })).toBe(true);
    expect(isTooManyDatabaseConnections({ code: "53300" })).toBe(true);
    expect(
      isTooManyDatabaseConnections(
        new Error("Too many database connections opened: sorry, too many clients already"),
      ),
    ).toBe(true);
    expect(isTooManyDatabaseConnections(new Error("relation does not exist"))).toBe(false);
    expect(isTooManyDatabaseConnections(undefined)).toBe(false);
  });

  it("walks a nested cause, matching the pg-pool unhandledRejection shape", () => {
    const root = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
    expect(isTooManyDatabaseConnections(new Error("pool.connect failed", { cause: root }))).toBe(
      true,
    );
  });
});

describe("retryOnTooManyConnections", () => {
  it("retries 53300 and returns the first success", async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    const result = await retryOnTooManyConnections(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
        }
        return "ok";
      },
      { sleep },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated failures", async () => {
    const error = new Error("relation does not exist");
    await expect(
      retryOnTooManyConnections(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe("createPool", () => {
  it("builds a bounded pool with connect-retry and idle-error listeners", () => {
    const pool = createPool("postgres://rakazo:rakazo@127.0.0.1:9/rakazo", {
      poolMax: 2,
      applicationName: "rakazo-pool-test",
    });
    pools.push(pool);
    expect(pool.options.max).toBe(2);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(0);
    expect(pool.options.application_name).toBe("rakazo-pool-test");
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(pool.listenerCount("connect")).toBeGreaterThan(0);
    expect(() => pool.emit("error", new Error("idle client lost"))).not.toThrow();
  });
});
