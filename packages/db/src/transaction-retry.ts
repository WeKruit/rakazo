const MAX_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_DATABASE_CODES = new Set(["40001", "40P01"]);

function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const prismaError = error as {
    code?: unknown;
    name?: unknown;
    cause?: { kind?: unknown; originalCode?: unknown };
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (prismaError.code === "P2034") return true;
  const databaseCode =
    prismaError.meta?.driverAdapterError?.cause?.originalCode ??
    (prismaError.name === "DriverAdapterError" &&
    prismaError.cause?.kind === "TransactionWriteConflict"
      ? prismaError.cause.originalCode
      : undefined);
  return typeof databaseCode === "string" && RETRYABLE_DATABASE_CODES.has(databaseCode);
}

export async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt >= MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }
}
