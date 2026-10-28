import { randomUUID } from "node:crypto";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "@rakazo/adapters";
import { createDb } from "@rakazo/db";
import { expect, it } from "vitest";
import { createWorkerDrain } from "./drain.js";

const databaseTest = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? it : it.skip;
databaseTest(
  "real Graphile drain preserves the active job while a second worker accepts new work",
  async () => {
    const a = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
    const b = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
    const first = randomUUID(),
      second = randomUUID();
    let completeFirst!: () => void;
    const active = new Promise<void>((resolve) => {
      completeFirst = resolve;
    });
    const completed: string[] = [],
      started: string[] = [];
    const handlers = {
      "run.continue": async ({ runId }: { runId: string }) => {
        started.push(runId);
        if (runId === first) await active;
        completed.push(runId);
      },
    } as BackgroundJobHandlers;
    const hostA = new GraphileJobWorkerHost(a.pool, {
      concurrency: 1,
      pollInterval: 20,
      noHandleSignals: true,
    });
    const hostB = new GraphileJobWorkerHost(b.pool, {
      concurrency: 1,
      pollInterval: 20,
      noHandleSignals: true,
    });
    const publisher = new GraphileJobPublisher(b.pool);
    try {
      await hostA.start(handlers);
      await publisher.enqueue(runContinueJob(first));
      await expect.poll(() => started.includes(first)).toBe(true);
      const drain = createWorkerDrain({
        stopJobs: () => hostA.stop(),
        stopReconciler: async () => undefined,
      });
      const done = drain.begin();
      await hostB.start(handlers);
      await publisher.enqueue(runContinueJob(second));
      await expect.poll(() => completed.includes(second)).toBe(true);
      expect(completed).not.toContain(first);
      expect(drain.state()).toBe("draining");
      completeFirst();
      await done;
      expect(drain.state()).toBe("drained");
      expect(started.filter((id) => id === first)).toHaveLength(1);
      expect(completed.filter((id) => id === first)).toHaveLength(1);
    } finally {
      completeFirst();
      await Promise.all([hostA.stop(), hostB.stop()]);
      await publisher.close();
      for (const db of [a, b]) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  },
  30_000,
);
