import { describe, expect, it, vi } from "vitest";
import { createWorkerDrain } from "./drain.js";
import { startWorkerHealth } from "./health.js";

function pending() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("worker deployment drain", () => {
  it("stops admission once and waits for active jobs without canceling them", async () => {
    const jobs = pending();
    const stopJobs = vi.fn(() => jobs.promise);
    const stopReconciler = vi.fn(async () => undefined);
    const drain = createWorkerDrain({ stopJobs, stopReconciler });
    expect(drain.state()).toBe("ready");
    const first = drain.begin();
    expect(drain.begin()).toBe(first);
    await Promise.resolve();
    expect(stopJobs).toHaveBeenCalledOnce();
    expect(stopReconciler).toHaveBeenCalledOnce();
    expect(drain.state()).toBe("draining");
    jobs.resolve();
    await first;
    expect(drain.state()).toBe("drained");
  });
  it("SIGTERM quiesces: live turn finishes within 45 s then lease released", async () => {
    vi.useFakeTimers();
    try {
      const sessionHosts = new AbortController();
      const order: string[] = [];
      let leaseHeld = true;
      // Stand-in for the session host's contract (plan Task 4): on abort it stops taking inputs,
      // lets the live turn run for at most 45 s, then releases the lease and returns.
      const driving = (async (signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        order.push("quiesce");
        const turnLeftMs = 120_000;
        await new Promise((resolve) => setTimeout(resolve, Math.min(turnLeftMs, 45_000)));
        leaseHeld = false;
        order.push("released");
      })(sessionHosts.signal);
      const drain = createWorkerDrain({
        // The job host waits for its running session.drive job.
        stopJobs: async () => {
          order.push("stopJobs");
          await driving;
        },
        stopReconciler: async () => undefined,
        quiesceSessions: () => sessionHosts.abort(),
      });
      const done = drain.begin();
      expect(sessionHosts.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(drain.state()).toBe("draining");
      expect(leaseHeld).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(leaseHeld).toBe(false);
      expect(drain.state()).toBe("drained");
      expect(order).toEqual(["quiesce", "stopJobs", "released"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("never reports drained when a stop operation fails", async () => {
    const drain = createWorkerDrain({
      stopJobs: async () => {
        throw new Error("failed");
      },
      stopReconciler: async () => undefined,
    });
    await expect(drain.begin()).rejects.toThrow("failed");
    expect(drain.state()).toBe("failed");
  });
  it("exposes real read-only HTTP readiness and drain state", async () => {
    const jobs = pending();
    const drain = createWorkerDrain({
      stopJobs: () => jobs.promise,
      stopReconciler: async () => undefined,
    });
    const server = await startWorkerHealth(drain.state, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${url}/ready`)).status).toBe(200);
      expect((await fetch(`${url}/drain`, { method: "POST" })).status).toBe(404);
      const done = drain.begin();
      expect((await fetch(`${url}/ready`)).status).toBe(503);
      expect(await (await fetch(`${url}/drain`)).json()).toEqual({ ok: true, state: "draining" });
      jobs.resolve();
      await done;
      expect(await (await fetch(`${url}/drain`)).json()).toEqual({ ok: true, state: "drained" });
      expect((await fetch(`${url}/ready`)).status).toBe(503);
    } finally {
      jobs.resolve();
      await server.close();
    }
  });
});
