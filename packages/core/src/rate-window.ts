/**
 * Fixed-size sliding window per key, held in this process. A single server needs no shared
 * store; each container enforcing its own window only makes the cap looser, never stricter.
 */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Record one hit for `key`; false when the key is already at its limit in this window. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(since);
    return true;
  }

  private prune(since: number) {
    for (const [key, times] of this.hits) {
      if (!times.some((at) => at > since)) this.hits.delete(key);
    }
  }
}

/** Calls that create or send something: what a runaway client or script repeats. */
const CREATING_RPC = /^(create|send|add|import|upload|duplicate|copy|spawn|start|post|invite)/i;

export function isCreatingRpcPath(path: string): boolean {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return CREATING_RPC.test(last);
}

/** Creating calls one person may make per minute across the product. */
export const CREATING_RPC_PER_MINUTE = 120;
/** Outbound tool calls (connectors, web) one run may make per minute. */
export const RUN_EGRESS_PER_MINUTE = 300;
export const RUN_EGRESS_RATE_LIMITED =
  "Not run: this conversation made too many outside calls in the last minute. Wait a minute, then continue with fewer calls at once.";
