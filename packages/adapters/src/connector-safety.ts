import { containsSecret, redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
    secrets,
  ).slice(0, 2_000);
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    const copied: unknown = JSON.parse(JSON.stringify(value));
    if (containsSecret(copied, secrets))
      // A secret reached a tool result: counted as an exposure path, never logged itself.
      getLogger().warn("security.secret_redacted", { path: "tool_result" });
    return redactPayloadValue(copied, secrets);
  } catch {
    return { ok: true };
  }
}

function redactPayloadValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPayloadValue(item, secrets));
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = String(value);
    return redactSecrets(serialized, secrets) === serialized ? value : "[redacted]";
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactSecrets(key, secrets),
      redactPayloadValue(item, secrets),
    ]),
  );
}

/** A mistake in the call itself: the connection works and a corrected call can succeed. */
const ARGUMENT_ERROR =
  /\b(?:invalid|malformed|missing|unknown|unexpected) (?:argument|param(?:eter)?|field|input|value|id|property|request body)s?\b|\bvalidation\b|\bINVALID_ARGUMENT\b|\b(?:is|are) required\b|\brequired (?:argument|param(?:eter)?|field|property)\b|\bmust (?:be|have|include|not)\b|\bnot found\b|\bdoes not exist\b/i;
/**
 * The provider refuses this account or project the tool as a whole: an enrollment, setup, billing
 * or plan problem that no retry or other argument fixes until someone changes the connection's
 * setup at the provider.
 */
const SETUP_ERROR =
  /\benrol(?:l)?(?:ed|ment)\b[^.]{0,80}\b(?:program(?:me)?|preview|beta)\b|\bdeveloper preview\b|\baccess to this (?:tool|api|service|feature) requires\b|\b(?:api|service) has not been used\b|\bSERVICE_DISABLED\b|\bbilling (?:is )?(?:not enabled|disabled|required)\b|\b(?:plan|subscription) does not (?:include|allow|support)\b|\bupgrade your plan\b/i;
/** Access or permission-scope refusals; a message that also blames an argument is about the call. */
const ACCESS_ERROR =
  /\binsufficient (?:authentication )?(?:permission|scope|privilege)s?\b|\bmissing (?:required )?(?:oauth )?scopes?\b|\b(?:api|service|tool|feature) (?:is )?(?:not enabled|disabled)\b|\baccount (?:is )?(?:suspended|disabled|not activated)\b/i;

/**
 * Whether a failed tool call means the provider refuses this connection outright, rather than
 * the call's arguments: then the connection is unusable for now and retrying it wastes the turn.
 */
export function providerRefusesConnection(text: string): boolean {
  return SETUP_ERROR.test(text) || (ACCESS_ERROR.test(text) && !ARGUMENT_ERROR.test(text));
}
