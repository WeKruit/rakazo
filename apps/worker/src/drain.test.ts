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
