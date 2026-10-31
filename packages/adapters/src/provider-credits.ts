/**
 * An outside service that ran out of credits refuses a call without doing or charging anything.
 * Auto top-up usually refills it within minutes, so the same call waits and tries again. Only
 * when it is still refused after that does the model hear once what happened, and the run stops
 * calling that service instead of reporting "nobody found".
 */
const OUT_OF_CREDITS =
  /\b402\b|payment required|out of credits?|no credits?(?: left| remaining)?|insufficient (?:credits?|balance|funds)|credits? (?:exhausted|depleted|used up)|(?:credit|usage) (?:limit|quota) (?:reached|exceeded)|quota exceeded/i;

export function isOutOfCredits(errorText: string): boolean {
  return OUT_OF_CREDITS.test(errorText);
}

/** The connector a tool belongs to: "<service>__<tool>", or null for a built-in tool. */
export function connectorOf(toolName: string): string | null {
  const at = toolName.indexOf("__");
  return at > 0 ? toolName.slice(0, at) : null;
}

/** Model-facing: what to tell the recruiter and where to go instead. */
export const OUT_OF_CREDITS_NOTE =
  "This service is still out of credits after waiting several minutes for a top-up, so every further call fails until the account is topped up; do not call it again in this turn. Tell the recruiter in one plain sentence that this lookup is paused because the service's credits ran out and needs a top-up (never the service's name), and never report its empty result as nobody found. Then keep going with another assigned source that does the same job (for people, the research provider's own research tools), and say which results came from it.";

/** Per run: services that ran out of credits, so later calls return at once instead of failing again. */
export function createCreditGuard() {
  const exhausted = new Set<string>();
  return {
    /** A call to a service already out of credits in this run, answered without calling it. */
    refusal(toolName: string): { error: string } | undefined {
      const service = connectorOf(toolName);
      return service && exhausted.has(service)
        ? { error: `Not run: ${OUT_OF_CREDITS_NOTE}` }
        : undefined;
    },
    /** The note for a failed call that ran out of credits, once per service; else undefined. */
    failed(toolName: string, errorText: string): string | undefined {
      const service = connectorOf(toolName);
      if (!service || exhausted.has(service) || !isOutOfCredits(errorText)) return undefined;
      exhausted.add(service);
      return OUT_OF_CREDITS_NOTE;
    },
  };
}

/** Waits between tries of a refused call: about eight minutes in all, enough for auto top-up. */
export const OUT_OF_CREDITS_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 120_000, 120_000];

/** Runs a call again while its provider refuses it for credits, then returns the last outcome. */
export async function retryWhileOutOfCredits<T>(
  call: () => Promise<T>,
  options: {
    failure: (outcome: T) => string | undefined;
    signal?: AbortSignal;
    delaysMs?: readonly number[];
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onRetry?: (delayMs: number) => void;
  },
): Promise<T> {
  const delays = options.delaysMs ?? OUT_OF_CREDITS_RETRY_MS;
  const wait = options.wait ?? waitFor;
  let outcome = await call();
  for (const delay of delays) {
    const failure = options.failure(outcome);
    if (failure === undefined || !isOutOfCredits(failure)) return outcome;
    options.onRetry?.(delay);
    await wait(delay, options.signal);
    outcome = await call();
  }
  return outcome;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}
