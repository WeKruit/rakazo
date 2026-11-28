import { readFile } from "node:fs/promises";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { Runner } from "graphile-worker";
import { makeWorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());

vi.mock("graphile-worker", () => ({
  run: (...args: unknown[]) => run(...args),
  makeWorkerUtils: vi.fn(),
}));

import {
  databaseCapacityBackoffMs,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  idlePollInterval,
} from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "recruiting_checkin.start": vi.fn(async () => undefined),
    "recruiting_agent_run.wait": vi.fn(async () => undefined),
    "recruiting_profile.project": vi.fn(async () => undefined),
    "recruiting_inbox.project": vi.fn(async () => undefined),
    "thread.reply_check": vi.fn(async () => undefined),
    "notification.retry": vi.fn(async () => undefined),
    "poll.close": vi.fn(async () => undefined),
    "discovery.warm": vi.fn(async () => undefined),
    "session.drive": vi.fn(async () => undefined),
    "session.cutover": vi.fn(async () => undefined),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockRunner() {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    stop: vi.fn(async () => {
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    rejectLife: (error: unknown) => life.reject(error),
  };
}

const tooMany = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

describe("databaseCapacityBackoffMs", () => {
  it("matches the worker startup backoff curve", () => {
    expect(databaseCapacityBackoffMs(0)).toBe(200);
    expect(databaseCapacityBackoffMs(3)).toBe(1_600);
    expect(databaseCapacityBackoffMs(8)).toBe(30_000);
    expect(databaseCapacityBackoffMs(20)).toBe(30_000);
  });
});

describe("GraphileJobPublisher.enqueue", () => {
  function publisherWith(addJob: ReturnType<typeof vi.fn>) {
    vi.mocked(makeWorkerUtils).mockResolvedValue({
      addJob,
      release: vi.fn(async () => undefined),
    } as never);
    return new GraphileJobPublisher({} as Pool);
  }

  it("leaves the queue default when the job sets no cap", async () => {
    const addJob = vi.fn(async (..._args: unknown[]) => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(messagingDeliverJob("run-1"));
    const options = addJob.mock.calls[0]?.[2] as { maxAttempts?: number } | undefined;
    expect(options?.maxAttempts).toBeUndefined();
    await publisher.close();
  });

  // graphile-worker 0.17.3 add_job: unsafe_dedupe on conflict bumps revision only.
  // replace sets attempts = 0 and run_at = excluded.run_at.
  type Job = { attempts: number; maxAttempts: number; runAt: Date; lockedAt?: Date };
  function graphileJobs(jobs: Map<string, Job>) {
    const query = vi.fn(async (_sql: string, params?: readonly unknown[]) => {
      const job = jobs.get(String(params?.[0]));
      return {
        rows: job
          ? [
              {
                attempts: job.attempts,
                max_attempts: job.maxAttempts,
                locked_at: job.lockedAt ?? null,
              },
            ]
          : [],
      };
    });
    const addJob = vi.fn(
      async (
        _name: string,
        _payload: unknown,
        spec: { runAt?: Date; jobKey?: string; maxAttempts?: number; jobKeyMode?: string },
      ) => {
        const key = spec.jobKey;
        if (!key) return;
        const existing = jobs.get(key);
        if (spec.jobKeyMode === "unsafe_dedupe" && existing) return;
        jobs.set(key, {
          attempts: 0,
          maxAttempts: spec.maxAttempts ?? 25,
          runAt: spec.runAt ?? new Date(),
        });
      },
    );
    const withPgClient = vi.fn(
      async (callback: (client: { query: typeof query }) => Promise<unknown>) =>
        callback({ query }),
    );
    return { query, addJob, withPgClient };
  }

  function publisherOver(jobs: Map<string, Job>) {
    const graphile = graphileJobs(jobs);
    vi.mocked(makeWorkerUtils).mockResolvedValue({
      addJob: graphile.addJob,
      withPgClient: graphile.withPgClient,
      release: vi.fn(async () => undefined),
    } as never);
    return { publisher: new GraphileJobPublisher({} as Pool), ...graphile };
  }

  it("queues a fresh job when the kept one already started, even on a worker that died", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const lockedAt = new Date("2029-12-31T23:59:00.000Z");
    const jobs = new Map<string, Job>([
      ["recruiting_checkin.start:thread-1", { attempts: 1, maxAttempts: 25, runAt, lockedAt }],
    ]);
    const { publisher, addJob } = publisherOver(jobs);
    const nextAt = new Date("2030-01-01T00:00:30.000Z");
    await publisher.enqueue({
      name: "recruiting_checkin.start",
      payload: { threadId: "thread-1" },
      replaceKey: "recruiting_checkin.start:thread-1",
      availableAt: nextAt,
      keepExisting: true,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("recruiting_checkin.start:thread-1")).toEqual({
      attempts: 0,
      maxAttempts: 25,
      runAt: nextAt,
    });
    await publisher.close();
  });
});

describe("GraphileJobWorkerHost runner lifecycle", () => {
  afterEach(() => {
    run.mockReset();
  });

  it("keeps the native worker as sole signal owner while awaiting runner drain", async () => {
    // ponytail: inspect the literal configuration; importing this entrypoint starts real services.
    const source = await readFile(
      new URL("../../../apps/worker/src/index.ts", import.meta.url),
      "utf8",
    );
    const options =
      source.match(/new GraphileJobWorkerHost\(sessionPool,\s*\{([^}]*)\}\)/)?.[1] ?? "";
    const noHandleSignals = /\bnoHandleSignals:\s*true\b/.test(options);
    expect(noHandleSignals).toBe(true);
    expect(source).toContain('process.once("SIGTERM", () => void stop())');
    expect(source).toContain('process.once("SIGINT", () => void stop())');

    const first = mockRunner();
    const drain = deferred();
    const stop = vi.mocked(first.runner.stop);
    const finish = stop.getMockImplementation()!;
    stop.mockImplementation(async () => {
      await drain.promise;
      await finish();
    });
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, { noHandleSignals });
    await host.start(handlers());
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ noHandleSignals: true }));

    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    drain.resolve();
    await stopping;
    expect(stop).toHaveBeenCalledOnce();
    expect(first.runner.kill).not.toHaveBeenCalled();
  });

  it("keeps idle polling near five fetches a second however many slots run", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 50 });
    await host.start(handlers());
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 50, pollInterval: 10_000 }),
    );
    expect(idlePollInterval(4)).toBe(2_000);
    await host.stop();
  });

  it("backs off then restarts when the database stops answering connects", async () => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const host = new GraphileJobWorkerHost({} as Pool, { sleep: async () => undefined });

    await host.start(handlers());
    first.rejectLife(new Error("timeout exceeded when trying to connect"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("backs off then restarts when runner.promise rejects with 53300", async () => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    expect(run).toHaveBeenCalledTimes(1);

    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("retries launch with escalating backoff when restart start hits 53300", async () => {
    const first = mockRunner();
    const recovered = mockRunner();
    run
      .mockResolvedValueOnce(first.runner)
      .mockRejectedValueOnce(tooMany)
      .mockResolvedValueOnce(recovered.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(sleeps).toEqual([200, 400]);

    await host.stop();
    expect(recovered.runner.stop).toHaveBeenCalled();
  });

  it("does not restart when runner.promise rejects for a non-53300 error", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });
    await host.start(handlers());
    const superviseTask = (host as unknown as { superviseTask: Promise<void> }).superviseTask;

    first.rejectLife(new Error("runner exploded"));
    await expect(superviseTask).rejects.toThrow("runner exploded");
    expect(run).toHaveBeenCalledTimes(1);

    await host.stop();
  });

  it("wakes a pending restart delay when stop is called", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sleepStarted = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleepStarted.resolve();
        return new Promise(() => undefined);
      },
    });
    await host.start(handlers());
    first.rejectLife(tooMany);
    await sleepStarted.promise;

    await host.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
