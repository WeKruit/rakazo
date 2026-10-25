import type { HostedStagingConfig } from "@rakazo/core";
import { createDb } from "@rakazo/db";
import { Hono } from "hono";
import { healthRoutes } from "./health.js";

/** No auth, connectors, credentials, runtime, or jobs are composed for hosted smoke. */
export function createStagingApp(config: HostedStagingConfig) {
  const { prisma, pool } = createDb(config.databaseUrl, {
    poolMax: 1,
    applicationName: "rakazo-staging-api",
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("x-rakazo-profile", "staging");
    c.header("cache-control", "no-store");
    if (c.req.method !== "GET" || !["/health", "/ready"].includes(c.req.path))
      return c.json({ error: "Hosted staging is restricted to release smoke checks" }, 403);
    await next();
  });
  app.route(
    "/",
    healthRoutes(
      () => ({ revision: config.revision }),
      () => prisma.$queryRaw`SELECT 1`,
    ),
  );
  return {
    app,
    async stop() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
