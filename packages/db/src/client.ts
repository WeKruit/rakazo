import { PrismaPg } from "@prisma/adapter-pg";
import { getLogContext, getLogger, recordJobStatement } from "@rakazo/logging";
import type { Client, PoolClient } from "pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export interface DbClientOptions {
  poolMax?: number;
  applicationName?: string;
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
/** db.pool.wait also reports a window whose statements were this slow at p90, waits or not. */
const SLOW_QUERY_P90_MS = 100;

const poolSessions = new WeakMap<Pool, Set<Client>>();
/** The container is killed 8 s after SIGTERM; sessions still open when this passes are ended. */
export const SESSION_RELEASE_MS = 4_000;

export function createPool(connectionString: string, options: DbClientOptions = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    // Fail a checkout instead of queueing forever when Postgres is already at
    // max_connections (53300) or the pool is saturated.
    connectionTimeoutMillis: 10_000,
    // 0 disables idle eviction. Dropping idle clients and reopening them on the
    // next job burst is how a tight Postgres hits 53300; keep what we already have.
    idleTimeoutMillis: 0,
    application_name: options.applicationName,
    keepAlive: true,
  });
  // graphile-worker (and Node itself) require an 'error' listener on a shared
  // pool: an idle-client disconnect is otherwise an unhandled error that kills
  // the process and orphans the TCP sessions until Postgres times them out.
  pool.on("error", () => undefined);
  const sessions = new Set<Client>();
  poolSessions.set(pool, sessions);
  const report = poolWaitReporter(pool);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
    sessions.add(client);
    client.once("end", () => sessions.delete(client));
    timeQueries(client, report.queried);
  });
  installConnectRetry(pool, report.acquired);
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

function installConnectRetry(
  pool: Pool,
  acquired: (startedAt: number, caller?: string) => void,
): void {
  type ConnectCallback = (
    err: Error,
    client: PoolClient,
    done: (release?: boolean) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };

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
  const context = getLogContext();
  const work = context["job.type"] ?? context["rpc.procedure"] ?? "-";
  return `${String(work)} ${callerFrame() ?? "?"}`;
}

/** Frames that sit under every query and would hide the code that asked for it. */
const WRAPPER_FRAMES = ["db/src/client.ts", "adapters/src/secret-persistence.ts"];

/** The first app source line on the current (async) stack outside the query wrappers. */
function callerFrame(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  return stack
    .split("\n")
    .slice(1)
    .map((line) => /(?:packages|apps)\/([^/]+\/src\/[^:)\s]+:\d+)/.exec(line)?.[1])
    .find((found) => found && !WRAPPER_FRAMES.some((wrapper) => found.startsWith(wrapper)));
}

/**
 * Counts checkouts that waited for a free connection and logs one `db.pool.wait` summary per
 * window that had any, so pool contention shows up in the logs instead of only as slow turns.
 * `callers` lists the busiest sampled callers, each count scaled back to all checkouts.
 */
function poolWaitReporter(pool: Pool): {
  acquired: (startedAt: number, caller?: string) => void;
  queried: (ms: number) => void;
} {
  let windowStart = Date.now();
  let checkouts = 0;
  let waited = 0;
  let totalMs = 0;
  let maxMs = 0;
  let maxQueued = 0;
  let callers = new Map<string, number>();
  let queries: number[] = [];
  const percentile = (sorted: number[], p: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  const flush = (now: number) => {
    if (now - windowStart < POOL_WAIT_REPORT_MS) return;
    const sorted = queries.sort((a, b) => a - b);
    const queryP90Ms = percentile(sorted, 0.9);
    if (waited || queryP90Ms >= SLOW_QUERY_P90_MS)
      getLogger().info("db.pool.wait", {
        pool: pool.options.application_name,
        max: pool.options.max,
        checkouts,
        waited,
        totalMs,
        maxMs,
        maxQueued,
        queries: sorted.length,
        queryP50Ms: percentile(sorted, 0.5),
        queryP90Ms,
        queryMaxMs: Math.round(sorted.at(-1) ?? 0),
        callers: [...callers]
          .sort((a, b) => b[1] - a[1])
          .slice(0, POOL_CALLERS_LOGGED)
          .map(([name, count]) => `${name} ×${count * POOL_CALLER_SAMPLE}`)
          .join("; "),
      });
    windowStart = now;
    checkouts = waited = totalMs = maxMs = maxQueued = 0;
    callers = new Map();
    queries = [];
  };
  return {
    acquired(startedAt, caller) {
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
      flush(now);
    },
    queried(ms) {
      queries.push(ms);
      flush(Date.now());
    },
  };
}

/**
 * Prisma's engine drops the async stack, so its statements are named by verb and first table,
 * such as `SELECT runs`.
 */
function statementShape(statement: unknown): string {
  const text =
    typeof statement === "string"
      ? statement
      : typeof (statement as { text?: unknown } | undefined)?.text === "string"
        ? (statement as { text: string }).text
        : "";
  const verb = /^\s*(\w+)/.exec(text)?.[1]?.toUpperCase() ?? "?";
  const table = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:"?\w+"?\.)?"?(\w+)"?/i.exec(text)?.[1];
  return table ? `${verb} ${table}` : verb;
}

/**
 * Times every statement from send to reply. A statement that waits for a server connection inside
 * a transaction-mode pooler shows up here, not as a pool checkout wait.
 */
function timeQueries(client: PoolClient, queried: (ms: number) => void): void {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  client.query = ((...args: unknown[]) => {
    const startedAt = performance.now();
    // Inside a background job, name the statement's source line for that job's tally.
    const site = getLogContext()["job.id"] ? (callerFrame() ?? statementShape(args[0])) : undefined;
    const done = () => {
      const ms = performance.now() - startedAt;
      queried(ms);
      if (site) recordJobStatement(site, ms);
    };
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === "function") {
      args[last] = (...result: unknown[]) => {
        done();
        return callback(...result);
      };
      return query(...args);
    }
    const result = query(...args);
    if (result instanceof Promise) result.then(done, done);
    return result;
  }) as PoolClient["query"];
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
