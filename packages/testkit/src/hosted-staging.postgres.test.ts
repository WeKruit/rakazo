import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createStagingApp } from "../../../apps/api/src/release-staging.js";
import { startStagingWorker } from "../../../apps/worker/src/release-staging.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseAvailable)(
  "restricted staging service on local synthetic Postgres",
  () => {
    it("serves revision and DB readiness over HTTP while denying business actions", async () => {
      const config = {
        databaseUrl: process.env.DATABASE_URL!,
        revision: process.env.RAKAZO_GIT_SHA ?? "a".repeat(40),
      };
      const handles = createStagingApp(config);
      const stopWorker = await startStagingWorker(config);
      const server = serve({ fetch: handles.app.fetch, port: 0, hostname: "127.0.0.1" });
      try {
        if (!server.listening)
          await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Local fixture did not listen");
        const origin = `http://127.0.0.1:${address.port}`;
        const ready = await fetch(`${origin}/ready`);
        expect(ready.status).toBe(200);
        expect(ready.headers.get("x-rakazo-revision")).toBe(config.revision);
        expect(ready.headers.get("x-rakazo-profile")).toBe("staging");
        expect(await ready.json()).toEqual({ ok: true, degraded: false });
        for (const path of [
          "/api/__release_smoke_denied__",
          "/api/auth/sign-up/email",
          "/rpc/recruiting/crmSync",
        ]) {
          const denied = await fetch(`${origin}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: "synthetic=existing" },
            body: "{}",
          });
          expect(denied.status).toBe(403);
          expect(denied.headers.get("x-rakazo-profile")).toBe("staging");
          await denied.text();
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await stopWorker();
        await handles.stop();
      }
    });
  },
);
