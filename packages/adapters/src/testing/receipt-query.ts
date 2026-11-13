import type { Prisma } from "@rakazo/db";

/** What a native receipt read asked for, read back from its SQL for offline tests. */
export type ReceiptScope = {
  spaceId?: string;
  userId?: string;
  threadId?: string;
  since?: Date;
  serverId?: string;
  toolName?: string;
  limit?: number;
};

const FIELDS: Array<[RegExp, keyof ReceiptScope]> = [
  [/e\."spaceId" = $/, "spaceId"],
  [/r\."userId" = $/, "userId"],
  [/r\."threadId" = $/, "threadId"],
  [/e\."createdAt" >= $/, "since"],
  [/,resourceId}' = $/, "serverId"],
  [/,toolName}' = $/, "toolName"],
  [/LIMIT $/, "limit"],
];

export function receiptScope(query: Prisma.Sql): ReceiptScope {
  const scope: Record<string, unknown> = {};
  query.values.forEach((value, index) => {
    const before = query.strings[index]!.trimEnd().concat(" ");
    for (const [pattern, field] of FIELDS)
      if (pattern.test(before) && scope[field] === undefined) scope[field] = value;
  });
  return scope as ReceiptScope;
}

/** A `$queryRaw` stand-in that answers receipt reads with the rows a test gives for its scope. */
export function receiptQuery(rows: (scope: ReceiptScope) => unknown[]) {
  return async (query: Prisma.Sql) =>
    rows(receiptScope(query)).map((row, index) => ({
      id: `receipt-${index}`,
      createdAt: new Date(0),
      ...(row as object),
    }));
}
