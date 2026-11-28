import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type {
  CommitResult,
  CommittedWrite,
  Entry,
  EntryScan,
  EntryStructure,
  EntryType,
  ListElement,
  ListReadOptions,
  SessionStats,
  Storage,
  StorageBranchScan,
  StoredValue,
  UsageRow,
  UsageScan,
  Value,
  ValueList,
  Write,
} from "@earendil-works/pi-agent-core/harness/session";
import {
  prepareStorageCommit,
  resolveListReadOptions,
  validateCommittedWrites,
  value,
} from "@earendil-works/pi-agent-core/harness/session";
import type { Usage } from "@earendil-works/pi-ai";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, reserveSessionSeqs } from "@rakazo/db";

type Tx = Prisma.TransactionClient;

interface StructureRow {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: bigint;
  type: EntryType;
  customType: string | null;
  body?: Entry;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Pi's own ledger sum (harness/utils/usage.js addUsage), which its package does not export. */
function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
    ...(left.reasoning === undefined && right.reasoning === undefined
      ? {}
      : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function physicalKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

function structureOf(row: StructureRow): EntryStructure {
  return {
    id: row.id,
    parentId: row.parentId,
    seq: Number(row.seq),
    timestamp: Number(row.timestamp),
    type: row.type,
    ...(row.customType === null ? {} : { customType: row.customType }),
  };
}

/**
 * Pi's `Storage` for one conversation session in Postgres, with the semantics of Pi's
 * MemoryStorage (the conformance suite in harness/session/testing is the contract).
 *
 * Every commit runs in one transaction that first reserves its seqs at `fence`; once another
 * worker has taken the session lease the commit rejects with `SessionFenceLost` and writes nothing.
 * Session totals (message count, usage sum) are kept on the session row by each commit.
 */
export class PostgresSessionStorage implements Storage {
  private commitQueue: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly db: PrismaClient,
    readonly sessionId: string,
    readonly fence: number,
  ) {}

  commit(writes: Write[], _context: Context): Promise<CommitResult> {
    if (this.state !== "open") return Promise.reject(this.closedError());
    const result = this.commitQueue.then(() =>
      this.db.$transaction((tx) => this.commitInTransaction(tx, writes)),
    );
    this.commitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async commitInTransaction(tx: Tx, writes: Write[]): Promise<CommitResult> {
    const reservation = await reserveSessionSeqs(tx, this.sessionId, this.fence, writes.length);
    const prepared = prepareStorageCommit(writes, reservation.firstSeq, Date.now());
    await this.validate(tx, prepared.writes, reservation.firstSeq);

    let messageCount = reservation.messageCount;
    let usage = (reservation.usage as Usage | null) ?? emptyUsage();
    const entries: Prisma.SessionEntryCreateManyInput[] = [];
    const usageRows: Prisma.SessionUsageCreateManyInput[] = [];
    // A commit's value and list writes apply in write order: fold them to their final effect.
    const values = new Map<
      string,
      { namespace: string; key: string; set?: { value: unknown; seq: number } }
    >();
    const lists = new Map<
      string,
      {
        namespace: string;
        key: string;
        cleared: boolean;
        appends: { value: unknown; seq: number }[];
      }
    >();
    for (const write of prepared.writes) {
      switch (write.kind) {
        case "entry": {
          const { kind: _kind, ...entry } = write;
          entries.push({
            sessionId: this.sessionId,
            id: entry.id,
            parentId: entry.parentId,
            seq: entry.seq,
            timestamp: BigInt(entry.timestamp),
            type: entry.type,
            customType: entry.customType ?? null,
            body: json(entry),
          });
          if (entry.type === "message") messageCount++;
          break;
        }
        case "usage": {
          usageRows.push({
            sessionId: this.sessionId,
            id: write.id,
            seq: write.seq,
            usage: json(write.usage),
            entryId: write.entryId ?? null,
            adjustment: write.adjustment,
            ...(write.details === undefined ? {} : { details: json(write.details) }),
          });
          usage = addUsage(usage, write.usage);
          break;
        }
        case "value": {
          const address = { namespace: write.namespace, key: write.key };
          values.set(
            physicalKey(write.namespace, write.key),
            write.op === "set"
              ? { ...address, set: { value: write.value, seq: write.seq } }
              : address,
          );
          break;
        }
        case "list": {
          const id = physicalKey(write.namespace, write.key);
          const current = lists.get(id) ?? {
            namespace: write.namespace,
            key: write.key,
            cleared: false,
            appends: [],
          };
          if (write.op === "delete") lists.set(id, { ...current, cleared: true, appends: [] });
          else {
            current.appends.push({ value: write.value, seq: write.seq });
            lists.set(id, current);
          }
          break;
        }
      }
    }

    if (entries.length > 0) await tx.sessionEntry.createMany({ data: entries });
    if (usageRows.length > 0) await tx.sessionUsage.createMany({ data: usageRows });
    await this.applyValues(tx, [...values.values()]);
    await this.applyLists(tx, [...lists.values()]);
    if (entries.length > 0 || usageRows.length > 0) {
      await tx.conversationSession.update({
        where: { id: this.sessionId },
        data: { messageCount, usage: json(usage) },
      });
    }
    return { ...prepared.result, stats: { messageCount, usage } };
  }

  private async validate(tx: Tx, writes: CommittedWrite[], firstSeq: number): Promise<void> {
    const ids = new Set<string>();
    for (const write of writes) {
      if (write.kind === "entry") {
        ids.add(write.id);
        if (write.parentId !== null) ids.add(write.parentId);
      } else if (write.kind === "usage") ids.add(write.id);
    }
    const [entryIds, usageIds] =
      ids.size === 0
        ? [new Set<string>(), new Set<string>()]
        : await Promise.all([
            tx.sessionEntry
              .findMany({
                where: { sessionId: this.sessionId, id: { in: [...ids] } },
                select: { id: true },
              })
              .then((rows) => new Set(rows.map((row) => row.id))),
            tx.sessionUsage
              .findMany({
                where: { sessionId: this.sessionId, id: { in: [...ids] } },
                select: { id: true },
              })
              .then((rows) => new Set(rows.map((row) => row.id))),
          ]);
    validateCommittedWrites(writes, firstSeq, {
      hasEntryOrUsageId: (id) => entryIds.has(id) || usageIds.has(id),
      hasEntryId: (id) => entryIds.has(id),
    });
  }

  private async applyValues(
    tx: Tx,
    values: { namespace: string; key: string; set?: { value: unknown; seq: number } }[],
  ): Promise<void> {
    const deleted = values.filter((write) => write.set === undefined);
    const set = values.flatMap((write) =>
      write.set === undefined ? [] : [{ namespace: write.namespace, key: write.key, ...write.set }],
    );
    if (deleted.length > 0) {
      await tx.$executeRaw`
        DELETE FROM session_values v
        USING jsonb_array_elements(${JSON.stringify(deleted)}::jsonb) d
        WHERE v."sessionId" = ${this.sessionId}
          AND v.namespace = d->>'namespace' AND v.key = d->>'key'`;
    }
    if (set.length > 0) {
      await tx.$executeRaw`
        INSERT INTO session_values ("sessionId", namespace, key, value, seq)
        SELECT ${this.sessionId}, d->>'namespace', d->>'key', d->'value', (d->>'seq')::int
        FROM jsonb_array_elements(${JSON.stringify(set)}::jsonb) d
        ON CONFLICT ("sessionId", namespace, key)
        DO UPDATE SET value = EXCLUDED.value, seq = EXCLUDED.seq`;
    }
  }

  private async applyLists(
    tx: Tx,
    lists: {
      namespace: string;
      key: string;
      cleared: boolean;
      appends: { value: unknown; seq: number }[];
    }[],
  ): Promise<void> {
    const cleared = lists.filter((list) => list.cleared);
    const appends = lists.flatMap((list) =>
      list.appends.map((element) => ({ namespace: list.namespace, key: list.key, ...element })),
    );
    if (cleared.length > 0) {
      await tx.$executeRaw`
        DELETE FROM session_list_elements l
        USING jsonb_array_elements(${JSON.stringify(cleared)}::jsonb) d
        WHERE l."sessionId" = ${this.sessionId}
          AND l.namespace = d->>'namespace' AND l.key = d->>'key'`;
    }
    if (appends.length > 0) {
      await tx.$executeRaw`
        INSERT INTO session_list_elements ("sessionId", namespace, key, seq, value)
        SELECT ${this.sessionId}, d->>'namespace', d->>'key', (d->>'seq')::int, d->'value'
        FROM jsonb_array_elements(${JSON.stringify(appends)}::jsonb) d`;
    }
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    this.assertOpen();
    const found = new Map<string, Entry>();
    if (ids.length === 0) return found;
    const rows = await this.db.sessionEntry.findMany({
      where: { sessionId: this.sessionId, id: { in: ids } },
      select: { id: true, body: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.body as unknown as Entry]));
    for (const id of ids) {
      const entry = byId.get(id);
      if (entry !== undefined) found.set(id, entry);
    }
    return found;
  }

  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    this.assertOpen();
    const row = await this.db.sessionValue.findUnique({
      where: {
        sessionId_namespace_key: {
          sessionId: this.sessionId,
          namespace: address.namespace,
          key: address.key,
        },
      },
      select: { value: true, seq: true },
    });
    if (row === null) return undefined;
    return {
      address: value<T>(address.namespace, address.key),
      value: row.value as T,
      seq: row.seq,
    };
  }

  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    this.assertOpen();
    // Keys order by code point, as Pi's in-memory state sorts them; "C" collation on UTF-8 does that.
    const rows = await this.db.$queryRaw<{ key: string; value: unknown; seq: number }[]>`
      SELECT key, value, seq FROM session_values
      WHERE "sessionId" = ${this.sessionId} AND namespace = ${prefix.namespace}
        AND starts_with(key, ${prefix.key})
      ORDER BY key COLLATE "C"`;
    return rows.map((row) => ({
      address: value<T>(prefix.namespace, row.key),
      value: row.value as T,
      seq: Number(row.seq),
    }));
  }

  async readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    _context: Context,
  ): Promise<ListElement<T>[]> {
    this.assertOpen();
    const resolved = resolveListReadOptions(options);
    const cursor = resolved.cursor?.seq;
    const rows = await this.db.sessionListElement.findMany({
      where: {
        sessionId: this.sessionId,
        namespace: address.namespace,
        key: address.key,
        ...(cursor === undefined
          ? {}
          : { seq: resolved.order === "asc" ? { gt: cursor } : { lt: cursor } }),
      },
      orderBy: { seq: resolved.order },
      take: resolved.limit,
      select: { seq: true, value: true },
    });
    return rows.map((row) => ({ seq: row.seq, value: row.value as T }));
  }

  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    return (await this.branch(query, true)).map((row) => row.body!);
  }

  async scanBranchStructure(
    query: StorageBranchScan,
    _context: Context,
  ): Promise<EntryStructure[]> {
    this.assertOpen();
    return (await this.branch(query, false)).map(structureOf);
  }

  /** The path from `start` to the root, then Pi's order, stop, filters, cursor and limit. */
  private async branch(query: StorageBranchScan, withBody: boolean): Promise<StructureRow[]> {
    // Walking newest first, the stop entry also ends the walk in SQL.
    const stopInWalk = query.order !== "oldestFirst";
    const stopAtId = stopInWalk ? (query.stopAtId ?? null) : null;
    const stopAtType = stopInWalk ? (query.stopAtType ?? null) : null;
    const body = withBody ? Prisma.sql`, e.body` : Prisma.empty;
    const rows = await this.db.$queryRaw<StructureRow[]>`
      WITH RECURSIVE path AS (
        SELECT id, "parentId", type, 0 AS depth FROM session_entries
        WHERE "sessionId" = ${this.sessionId} AND id = ${query.start}
        UNION ALL
        SELECT e.id, e."parentId", e.type, p.depth + 1
        FROM path p JOIN session_entries e ON e."sessionId" = ${this.sessionId} AND e.id = p."parentId"
        WHERE p.id IS DISTINCT FROM ${stopAtId}::text AND p.type IS DISTINCT FROM ${stopAtType}::text
      )
      SELECT e.id, e."parentId", e.seq, e.timestamp, e.type, e."customType"${body}
      FROM path p JOIN session_entries e ON e."sessionId" = ${this.sessionId} AND e.id = p.id
      ORDER BY p.depth`;
    if (rows.length === 0) throw new Error(`Unknown branch start: ${query.start}`);
    const last = rows.at(-1)!;
    if (last.parentId !== null && last.id !== stopAtId && last.type !== stopAtType) {
      throw new Error("Corrupt branch: missing parent");
    }
    if (query.order === "oldestFirst") rows.reverse();
    const stopped: StructureRow[] = [];
    for (const row of rows) {
      stopped.push(row);
      if (row.id === query.stopAtId || row.type === query.stopAtType) break;
    }
    const cursor = query.cursor?.seq;
    const filtered = stopped.filter(
      (row) =>
        (query.type === undefined || row.type === query.type) &&
        (query.customType === undefined || row.customType === query.customType) &&
        (cursor === undefined ||
          (query.order === "oldestFirst" ? row.seq > cursor : row.seq < cursor)),
    );
    return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
  }

  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    const rows = await this.db.sessionEntry.findMany({
      where: {
        sessionId: this.sessionId,
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.customType === undefined ? {} : { customType: query.customType }),
        seq: { gte: query.fromSeq, lte: query.toSeq },
      },
      orderBy: { seq: query.order === "desc" ? "desc" : "asc" },
      ...(query.limit === undefined ? {} : { take: Math.max(0, Math.trunc(query.limit)) }),
      select: { body: true },
    });
    return rows.map((row) => row.body as unknown as Entry);
  }

  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    this.assertOpen();
    const rows = await this.db.sessionUsage.findMany({
      where: { sessionId: this.sessionId, seq: { gte: query.fromSeq, lte: query.toSeq } },
      orderBy: { seq: query.order === "desc" ? "desc" : "asc" },
      ...(query.limit === undefined ? {} : { take: Math.max(0, query.limit) }),
    });
    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      usage: row.usage as unknown as Usage,
      adjustment: row.adjustment,
      ...(row.entryId === null ? {} : { entryId: row.entryId }),
      ...(row.details === null ? {} : { details: row.details as UsageRow["details"] }),
    }));
  }

  async getStats(_context: Context): Promise<SessionStats> {
    this.assertOpen();
    const row = await this.db.conversationSession.findUniqueOrThrow({
      where: { id: this.sessionId },
      select: { messageCount: true, usage: true },
    });
    return { messageCount: row.messageCount, usage: (row.usage as Usage | null) ?? emptyUsage() };
  }

  /** Seal admission, let admitted commits finish, then close. Idempotent. */
  close(_context: Context): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state = "closing";
    this.closePromise = this.commitQueue.then(() => {
      this.state = "closed";
    });
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.state !== "open") throw this.closedError();
  }

  private closedError(): Error {
    return new Error(`Session storage ${this.sessionId} is closed`);
  }
}
