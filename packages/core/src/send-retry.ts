import { isServerUnreachable } from "./user-error.js";

/** Waits between tries: seven tries over about a minute. */
export const SEND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

const RETRY_STATUSES = new Set([408, 425, 429]);

function errorStatus(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") return status;
    current = current.cause;
  }
  return undefined;
}

/**
 * True when the same send may simply be tried again: it may never have arrived, or the server
 * asked to wait or failed without refusing it. The send's clientNonce makes a repeat a no-op.
 */
export function isRetryableSendFailure(error: unknown): boolean {
  if (isServerUnreachable(error)) return true;
  const status = errorStatus(error);
  return status !== undefined && (RETRY_STATUSES.has(status) || status >= 500);
}

/**
 * Runs one send, retrying it unchanged (same clientNonce) with bounded backoff while it fails
 * transiently. A refusal, or `keepTrying` turning false, ends it with the last error.
 */
export async function retrySend<T>(
  send: () => Promise<T>,
  options: {
    keepTrying?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const delay = SEND_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableSendFailure(error)) throw error;
      await sleep(delay);
      if (options.keepTrying && !options.keepTrying()) throw error;
    }
  }
}
