import type { PrismaClient } from "@rakazo/db";

/**
 * Runs `work` alone for this key across every server process: callers with the same key wait for
 * a PostgreSQL transaction-scoped advisory lock, which is released when the work ends or fails.
 */
export async function oneAtATime<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  key: string[],
  work: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`;
      return work();
    },
    { maxWait: 120_000, timeout: 180_000 },
  );
}
