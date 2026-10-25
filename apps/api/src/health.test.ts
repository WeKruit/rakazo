import { InfisicalSecretStore } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import { healthRoutes } from "./health.js";

const app = healthRoutes(() => ({ runtime: "pi", sandbox: "docker", revision: "abc123" }));

describe("health routes", () => {
  it("exposes only a full source revision header on public readiness", async () => {
    const revision = "a".repeat(40);
    const health = healthRoutes(() => ({
      revision,
      runtime: "pi",
      secrets: { private: "not public" },
    }));
    const response = await health.request("/ready");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-rakazo-revision")).toBe(revision);
    await expect(response.json()).resolves.toEqual({ ok: true, degraded: false });
    expect((await health.request("/health")).headers.get("x-rakazo-revision")).toBeNull();
  });

  it.each([undefined, null, "unknown", "abc123", "A".repeat(40), `${"a".repeat(40)}\n`])(
    "omits unknown or malformed public source revision %s",
    async (revision) => {
      const health = healthRoutes(() => ({ revision }));
      const response = await health.request("/ready");
      expect(response.headers.get("x-rakazo-revision")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: true, degraded: false });
    },
  );

  it("fails closed on a database outage and probes again after recovery", async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("private database connection details"))
      .mockResolvedValue(undefined);
    const health = healthRoutes(() => ({ degraded: false }), check);
    const failed = await health.request("/ready");
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ ok: false, degraded: true });

    const recovered = await health.request("/ready");
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ ok: true, degraded: false });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("bounds slow probes and shares the pending database call until it settles", async () => {
    vi.useFakeTimers();
    try {
      let reject: (reason?: unknown) => void = () => {};
      const check = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, rejectCheck) => {
              reject = rejectCheck;
            }),
        )
        .mockResolvedValue(undefined);
      const health = healthRoutes(() => ({}), check);
      const first = health.request("/ready");
      const concurrent = health.request("/ready");
      await vi.advanceTimersByTimeAsync(2_000);
      for (const response of await Promise.all([first, concurrent])) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
      }
      const repeated = health.request("/ready");
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await repeated).status).toBe(503);
      expect(check).toHaveBeenCalledTimes(1);

      // A late driver rejection remains handled and permits a fresh recovery probe.
      reject(new Error("late private driver failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect((await health.request("/ready")).status).toBe(200);
      expect(check).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps liveness independent of database readiness", async () => {
    const check = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const health = healthRoutes(() => ({ revision: "abc123" }), check);
    expect(await (await health.request("/health")).json()).toEqual({ ok: true });
    expect((await health.request("/internal/health")).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });

  it("returns generic unready status if reading local readiness details fails", async () => {
    const health = healthRoutes(() => {
      throw new Error("private store details");
    });
    const response = await health.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
  });

  it("reports degraded readiness during a store outage and recovers on later reads", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("fake", {
      operationId: "test",
      traceId: "test",
      userId: "test",
      spaceId: "test",
      signal: new AbortController().signal,
    });
    await writer.close();
    fake.offline = true;
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const health = healthRoutes(() => ({ degraded: store.describe().capabilities.degraded }));
    try {
      const response = await health.request("/ready");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
      expect((await health.request("/health")).status).toBe(200);
      fake.offline = false;
      await store.load(record.ref, record.id);
      expect((await health.request("/ready")).status).toBe(200);
    } finally {
      await store.close();
    }
  });
  it("keeps public liveness free of deployment details", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves details to direct requests on the API port", async () => {
    const response = await app.request("/internal/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc123",
    });
  });

  it("hides details from requests that came through a reverse proxy", async () => {
    for (const headers of [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
    ]) {
      const response = await app.request("/internal/health", { headers });
      expect(response.status).toBe(404);
    }
  });
});
