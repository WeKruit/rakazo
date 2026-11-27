import type { PrismaClient } from "@rakazo/db";

/**
 * Runs `work` alone for this key across every server process: callers with the same key wait for
 * a PostgreSQL transaction-scoped advisory lock, which is released when the work ends or fails.
 * Several keys are taken in the order given, in one transaction.
 */
export async function oneAtATime<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  key: string[] | string[][],
  work: () => Promise<T>,
): Promise<T> {
  const keys = (Array.isArray(key[0]) ? key : [key]) as string[][];
  return prisma.$transaction(
    async (tx) => {
      for (const each of keys)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(each)}, 0))`;
      return work();
    },
    { maxWait: 120_000, timeout: 180_000 },
  );
}
