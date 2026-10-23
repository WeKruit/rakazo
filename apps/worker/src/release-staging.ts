import type { HostedStagingConfig } from "@rakazo/core";
import { createDb } from "@rakazo/db";

/** Keep the real worker process available without loading persisted jobs or providers. */
export async function startStagingWorker(config: HostedStagingConfig) {
  const { prisma, pool } = createDb(config.databaseUrl, {
    poolMax: 1,
    applicationName: "rakazo-staging-worker",
  });
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    await prisma.$disconnect();
    await pool.end();
    throw new Error("Restricted staging worker database check failed");
  }
  const keepAlive = setInterval(() => {}, 60_000);
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(keepAlive);
    await prisma.$disconnect();
    await pool.end();
  };
}
