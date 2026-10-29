import { describe, expect, it } from "vitest";
import { providerRefusesConnection, redactConnectorPayload } from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
    });
  });

  it("falls back to an inert result when the payload is not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactConnectorPayload(circular, ["secret"])).toEqual({ ok: true });
  });

  it("redacts secrets represented by non-string JSON leaves", () => {
    expect(
      redactConnectorPayload({ number: 123, boolean: true, empty: null }, ["123", "true", "null"]),
    ).toEqual({ number: "[redacted]", boolean: "[redacted]", empty: "[redacted]" });
  });
});

describe("providerRefusesConnection", () => {
  it.each([
    "Access to this tool requires that your Google Cloud project (123) is enrolled in the Google Workspace Developer Preview Program.",
    "Your organization is not enrolled in the beta program for this API.",
    "Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting the console.",
    "SERVICE_DISABLED: the service is turned off for this project",
    "Request had insufficient authentication scopes.",
    "Billing is not enabled for this account.",
    "Your plan does not include API access; upgrade your plan.",
    "This account is suspended.",
  ])("treats a provider access or setup refusal as an unusable connection: %s", (text) => {
    expect(providerRefusesConnection(text)).toBe(true);
  });

  it.each([
    "Invalid argument: 'to' is required.",
    "Validation failed: subject must be a string",
    "Draft not found",
    "Message 42 does not exist",
    "The lead is not enrolled in this campaign",
    "Rate limit exceeded, retry later",
    "Internal server error",
    "Missing required field 'body'; insufficient permissions are not the problem",
  ])("treats an argument or ordinary error as a call to correct or retry: %s", (text) => {
    expect(providerRefusesConnection(text)).toBe(false);
  });
});
