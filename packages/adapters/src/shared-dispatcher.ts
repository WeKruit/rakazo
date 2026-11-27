import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";

/**
 * One long-lived, keep-alive connection pool per address policy, shared by every outside call
 * in the process (undici's guidance: never an Agent per request). A new connection can cost a
 * second or more, and a reused one costs nothing, so pools stay open for the process lifetime.
 * Each pool keeps its own address check in `connect.lookup`, which runs for every new connection.
 */
const KEEP_ALIVE_MS = 60_000;
const KEEP_ALIVE_MAX_MS = 10 * 60_000;

const pools = new Map<string, Agent>();

export function sharedAgent(
  key: string,
  connect: { lookup: LookupFunction; timeout?: number },
): Agent {
  let pool = pools.get(key);
  if (!pool) {
    pool = new Agent({
      connect: { ...connect, lookup: blipAware(connect.lookup) },
      keepAliveTimeout: KEEP_ALIVE_MS,
      keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
    });
    pools.set(key, pool);
  }
  return pool;
}

/**
 * Test-environment fault injection: for a few seconds every new outside connection fails the
 * way a real network blip does (connect ETIMEDOUT) while open connections keep working. The
 * window is a file in the container's temp folder so the API and worker processes share it.
 */
const BLIP_FILE = join(tmpdir(), "rakazo-network-blip");
let blipRead = { at: 0, until: 0 };

export async function blockNewConnections(seconds: number): Promise<Date> {
  const until = Date.now() + seconds * 1000;
  await writeFile(BLIP_FILE, String(until));
  blipRead = { at: Date.now(), until };
  return new Date(until);
}

function newConnectionsBlocked(): boolean {
  const now = Date.now();
  if (now - blipRead.at > 1000) {
    let until = 0;
    try {
      until = Number(readFileSync(BLIP_FILE, "utf8")) || 0;
    } catch {}
    blipRead = { at: now, until };
  }
  return now < blipRead.until;
}

function blipAware(lookup: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    if (!newConnectionsBlocked()) return lookup(hostname, options, callback);
    const error = Object.assign(new Error(`connect ETIMEDOUT ${hostname} (network blip test)`), {
      code: "ETIMEDOUT",
    });
    process.nextTick(() => callback(error, "", 4));
  };
}
