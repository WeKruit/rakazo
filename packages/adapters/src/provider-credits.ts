/**
 * An outside service that ran out of credits fails every call until someone tops it up, so a
 * turn must not keep retrying it or report "nobody found". The model is told once what happened
 * and what to do, and the run stops calling that service.
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
  "This service is out of credits, so every further call fails until the account is topped up; do not call it again in this turn. Tell the recruiter in one plain sentence that this lookup is paused because the service's credits ran out and needs a top-up (never the service's name), and never report its empty result as nobody found. Then keep going with another assigned source that does the same job (for people, the research provider's own research tools), and say which results came from it.";

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
