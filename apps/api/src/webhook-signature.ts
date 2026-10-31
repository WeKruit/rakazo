import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signed delivery may be; older ones are refused as replays. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed with the bot's webhook secret. */
export function signWebhookBody(secret: string, body: string, nowSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${nowSeconds}.${body}`).digest("hex");
  return `t=${nowSeconds},v1=${digest}`;
}

/**
 * A sender that cannot keep the secret in an Authorization header can sign each delivery instead.
 * The timestamp is inside the signature, so a captured delivery cannot be replayed later.
 */
export function hasValidWebhookSignature(
  header: string | undefined,
  secret: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  const supplied = parts.get("v1") ?? "";
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(supplied)) return false;
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}
