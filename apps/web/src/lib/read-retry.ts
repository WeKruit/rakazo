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

/**
 * Reads through transient failures with backoff, so callers keep their cached or loading state
 * and show a failure only once retries are exhausted. Aborting stops the retries.
 */
export async function retryTransientRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= RETRIES || signal?.aborted || !isTransientReadError(error)) throw error;
    }
    await abortableDelay(sessionRetryDelayMs(attempt, 30_000), signal);
    signal?.throwIfAborted();
  }
}
