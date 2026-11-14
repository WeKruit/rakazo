import { ORPCError } from "@orpc/client";
import { abortableDelay } from "@rakazo/core";
import { sessionRetryDelayMs } from "./session-gate";

/** Network failures and 5xx (a deploy, an edge 503) pass; a 4xx or a denial is the answer. */
export function isTransientReadError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return !(error instanceof ORPCError) || error.status >= 500;
}

/** 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s: about two minutes, past a deploy's unavailable window. */
const RETRIES = 8;

let waiting = 0;
const listeners = new Set<() => void>();
function setWaiting(change: number) {
  waiting += change;
  for (const listener of listeners) listener();
}
/** Whether any page read is waiting out a transient failure, so one status can say so. */
export const readRetries = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => waiting > 0,
};

/**
 * Reads through transient failures with backoff, so callers keep their cached or loading state
 * and show a failure only once retries are exhausted. Aborting stops the retries.
 */
export async function retryTransientRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let retrying = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (attempt >= RETRIES || signal?.aborted || !isTransientReadError(error)) throw error;
      }
      if (!retrying) {
        retrying = true;
        setWaiting(1);
      }
      await abortableDelay(sessionRetryDelayMs(attempt, 30_000), signal);
      signal?.throwIfAborted();
    }
  } finally {
    if (retrying) setWaiting(-1);
  }
}
