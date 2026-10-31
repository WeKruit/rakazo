import { describe, expect, it } from "vitest";
import { hasValidWebhookSignature, signWebhookBody } from "./webhook-signature.js";

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = '{"event":"candidate.replied"}';

  it("accepts a fresh signature over the exact body", () => {
    const header = signWebhookBody(secret, body, 1_000);
    expect(hasValidWebhookSignature(header, secret, body, 1_100)).toBe(true);
  });

  it("refuses a changed body, a wrong secret, an old timestamp and junk", () => {
    const header = signWebhookBody(secret, body, 1_000);
    expect(hasValidWebhookSignature(header, secret, `${body} `, 1_000)).toBe(false);
    expect(hasValidWebhookSignature(header, "other", body, 1_000)).toBe(false);
    expect(hasValidWebhookSignature(header, secret, body, 1_301)).toBe(false);
    expect(hasValidWebhookSignature("t=x,v1=zz", secret, body, 1_000)).toBe(false);
    expect(hasValidWebhookSignature(undefined, secret, body, 1_000)).toBe(false);
  });
});
