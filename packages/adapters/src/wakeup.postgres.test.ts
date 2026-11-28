import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

let pool: Pool | undefined;
function testPool(): Pool {
  pool ??= new Pool({ connectionString: databaseUrl, max: 4 });
  return pool;
}
afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

function handlers(overrides: Partial<BackgroundJobHandlers> = {}): BackgroundJobHandlers {
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
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

describePostgres("Graphile background jobs (PostgreSQL contract)", () => {
  it("replaces a keyed delayed job without running the old payload or schedule", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    const target = handlers({
      "computer.sleep": async ({ computerId }) => {
        received.push(computerId);
      },
    });
    const key = `contract:replacement:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "old" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "replacement" },
        availableAt: new Date(Date.now() + 800),
        replaceKey: key,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received).toEqual([]);
      await waitFor(() => expect(received).toEqual(["replacement"]));
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("removes a keyed delayed job before a worker can run it", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const target = handlers();
    const key = `contract:cancellation:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "cancelled" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.cancel(key);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  async function keyedRow(key: string): Promise<{
    attempts: number;
    maxAttempts: number;
    runAt: Date;
    payload: string;
  } | null> {
    const result = await testPool().query<{
      attempts: number;
      max_attempts: number;
      run_at: Date;
      payload: unknown;
    }>(
      "select attempts, max_attempts, run_at, payload from graphile_worker._private_jobs where key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      runAt: new Date(row.run_at),
      payload: JSON.stringify(row.payload),
    };
  }
});
