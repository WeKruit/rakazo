import { PrismaPg } from "@prisma/adapter-pg";
import { getLogContext, getLogger } from "@rakazo/logging";
import type { Client, PoolClient } from "pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export interface DbClientOptions {
  poolMax?: number;
  applicationName?: string;
  /** Use the driver's public ordered-query pipeline on checked-out clients. */
  pipeline?: boolean;
  /** Awaited before a new physical session is exposed to a pool borrower. */
  verifyConnection?: (client: PoolClient) => Promise<void>;
}

const DEFAULT_POOL_MAX = 4;
const CONNECT_RETRY_ATTEMPTS = 8;
/** A checkout slower than this counts as waiting for the pool. */
const POOL_WAIT_MIN_MS = 50;
/** db.pool.wait summarizes at most once per window, and only windows that waited. */
const POOL_WAIT_REPORT_MS = 60_000;
/** One checkout in this many records its caller for db.pool.wait; a stack per checkout costs too much. */
const POOL_CALLER_SAMPLE = 10;
const POOL_CALLERS_LOGGED = 8;

const poolSessions = new WeakMap<Pool, Set<Client>>();
/** The container is killed 8 s after SIGTERM; sessions still open when this passes are ended. */
export const SESSION_RELEASE_MS = 4_000;

export function createPool(connectionString: string, options: DbClientOptions = {}): Pool {
  const config = {
    connectionString,
    pipeline: options.pipeline ?? false,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    // Fail a checkout instead of queueing forever when Postgres is already at
    // max_connections (53300) or the pool is saturated.
    connectionTimeoutMillis: 10_000,
    // 0 disables idle eviction. Dropping idle clients and reopening them on the
    // next job burst is how a tight Postgres hits 53300; keep what we already have.
    idleTimeoutMillis: 0,
    application_name: options.applicationName,
    keepAlive: true,
    verify: options.verifyConnection
      ? (client: PoolClient, done: (error?: Error) => void) => {
          void options.verifyConnection!(client).then(
            () => done(),
            (error) => done(error instanceof Error ? error : new Error(String(error))),
          );
        }
      : undefined,
  };
  const pool = new Pool(config);
  // graphile-worker (and Node itself) require an 'error' listener on a shared
  // pool: an idle-client disconnect is otherwise an unhandled error that kills
  // the process and orphans the TCP sessions until Postgres times them out.
  pool.on("error", () => undefined);
  const sessions = new Set<Client>();
  poolSessions.set(pool, sessions);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
    sessions.add(client);
    client.once("end", () => sessions.delete(client));
  });
  installConnectRetry(pool);
  return pool;
}

/**
 * Ends every session the pool holds, checked out or not. pool.end() waits for checked-out
 * clients, and graphile's LISTEN, the reconciler's lock and running jobs keep theirs until
 * shutdown finishes, which can outlast the container's kill deadline. A session that dies
 * with the container instead of saying goodbye stays counted against the pooler's 15.
 */
export async function closePoolSessions(pool: Pool): Promise<void> {
  await Promise.all(
    [...(poolSessions.get(pool) ?? [])].map((client) => client.end().catch(() => undefined)),
  );
}

/** Unlike pg-pool.end alone, wait for tracked physical clients' end events too. */
export async function endTrackedSessionPool(pool: Pool): Promise<void> {
  const sessions = poolSessions.get(pool);
  if (!sessions) throw new Error("Cannot confirm shutdown of an untracked session pool");
  const pending = new Set<Promise<void>>();
  const watched = new WeakSet<Client>();
  const watch = (client: Client) => {
    if (watched.has(client)) return;
    watched.add(client);
    const ended = new Promise<void>((resolve) => client.once("end", () => resolve()));
    pending.add(ended);
    void ended.finally(() => pending.delete(ended));
  };
  pool.on("connect", watch);
  for (const client of sessions) watch(client);
  try {
    await pool.end();
    while (pending.size) await Promise.all([...pending]);
    if (sessions.size) throw new Error("Session pool still has physical clients");
  } finally {
    pool.off("connect", watch);
  }
}

export function createDb(
  connectionString: string,
  options: DbClientOptions = {},
): { prisma: PrismaClient; pool: Pool } {
  const pool = createPool(connectionString, options);
  const adapter = new PrismaPg(pool);
  // Native source/ACL validation needs a shared bounded budget for remote database round trips.
  const prisma = new PrismaClient({
    adapter,
    transactionOptions: { timeout: 15_000, maxWait: 5_000 },
  });
  return { prisma, pool };
}

const SUPAVISOR_FULL = /EMAXCONN|max client(?:s| connections) reached/i;

export function isTooManyDatabaseConnections(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (code === "P2037" || code === "53300") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Too many database connections opened") ||
      message.includes("sorry, too many clients already") ||
      // Supabase's pooler refuses with its own XX000 error, e.g. "(EMAXCONNSESSION) max clients
      // reached in session mode". Unrecognised, it crashed the worker into a restart loop.
      SUPAVISOR_FULL.test(message)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export async function retryOnTooManyConnections<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? CONNECT_RETRY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTooManyDatabaseConnections(error) || attempt >= attempts - 1) throw error;
      await sleep(Math.min(5_000, 200 * 2 ** attempt));
    }
  }
}

function installConnectRetry(pool: Pool): void {
  type ConnectCallback = (
    err: Error,
    client: PoolClient,
    done: (release?: boolean) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };
  const acquired = poolWaitReporter(pool);

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const startedAt = Date.now();
    const caller = sampleCaller();
    if (!callback)
      return retryOnTooManyConnections(() => originalConnect()).then((client) => {
        acquired(startedAt, caller);
        return client;
      });
    const attempt = (n: number) => {
      originalConnect((err, client, done) => {
        if (err && isTooManyDatabaseConnections(err) && n < CONNECT_RETRY_ATTEMPTS - 1) {
          setTimeout(() => attempt(n + 1), Math.min(5_000, 200 * 2 ** n));
          return;
        }
        if (!err) acquired(startedAt, caller);
        callback(err, client, done);
      });
    };
    attempt(0);
  }

  pool.connect = connect as Pool["connect"];
}

let checkoutSeq = 0;

/**
 * For one checkout in POOL_CALLER_SAMPLE: the job or RPC it serves and the first app source line
 * that asked for it (async frames included), such as `run.continue adapters/src/executor.ts:812`.
 */
function sampleCaller(): string | undefined {
  checkoutSeq += 1;
  if (checkoutSeq % POOL_CALLER_SAMPLE) return undefined;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const frame = stack
    .split("\n")
    .slice(1)
    .map((line) => /(?:packages|apps)\/([^/]+\/src\/[^:)\s]+:\d+)/.exec(line)?.[1])
    .find((found) => found && !found.startsWith("db/src/client.ts"));
  const context = getLogContext();
  const work = context["job.type"] ?? context["rpc.procedure"] ?? "-";
  return `${String(work)} ${frame ?? "?"}`;
}

/**
 * Counts checkouts that waited for a free connection and logs one `db.pool.wait` summary per
 * window that had any, so pool contention shows up in the logs instead of only as slow turns.
 * `callers` lists the busiest sampled callers, each count scaled back to all checkouts.
 */
function poolWaitReporter(pool: Pool): (startedAt: number, caller?: string) => void {
  let windowStart = Date.now();
  let checkouts = 0;
  let waited = 0;
  let totalMs = 0;
  let maxMs = 0;
  let maxQueued = 0;
  let callers = new Map<string, number>();
  return (startedAt, caller) => {
    const now = Date.now();
    const ms = now - startedAt;
    checkouts += 1;
    maxQueued = Math.max(maxQueued, pool.waitingCount);
    if (caller) callers.set(caller, (callers.get(caller) ?? 0) + 1);
    if (ms >= POOL_WAIT_MIN_MS) {
      waited += 1;
      totalMs += ms;
      maxMs = Math.max(maxMs, ms);
    }
    if (now - windowStart < POOL_WAIT_REPORT_MS) return;
    if (waited)
      getLogger().info("db.pool.wait", {
        pool: pool.options.application_name,
        max: pool.options.max,
        checkouts,
        waited,
        totalMs,
        maxMs,
        maxQueued,
        callers: [...callers]
          .sort((a, b) => b[1] - a[1])
          .slice(0, POOL_CALLERS_LOGGED)
          .map(([name, count]) => `${name} ×${count * POOL_CALLER_SAMPLE}`)
          .join("; "),
      });
    windowStart = now;
    checkouts = waited = totalMs = maxMs = maxQueued = 0;
    callers = new Map();
  };
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
