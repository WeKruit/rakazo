import { describe, expect, it } from "vitest";
import { createCreditGuard, isOutOfCredits, OUT_OF_CREDITS_NOTE } from "./provider-credits.js";

describe("a service out of credits", () => {
  it("recognises the ways services say it", () => {
    for (const text of [
      "HTTP 402 Payment Required",
      "Insufficient credits to complete this request",
      "You have no credits left",
      "Usage limit reached for this billing period",
    ])
      expect(isOutOfCredits(text)).toBe(true);
    for (const text of ["429 Too Many Requests", "invalid query", "timeout after 30s"])
      expect(isOutOfCredits(text)).toBe(false);
  });

  it("tells the model once, then stops calling that service in the run", () => {
    const guard = createCreditGuard();
    expect(guard.refusal("people-search__web_search_advanced_exa")).toBeUndefined();
    expect(guard.failed("people-search__web_search_advanced_exa", "402 Payment Required")).toBe(
      OUT_OF_CREDITS_NOTE,
    );
    expect(guard.failed("people-search__web_search_advanced_exa", "402")).toBeUndefined();
    expect(guard.refusal("people-search__agent_run")?.error).toContain("out of credits");
    // Another service and built-in tools are untouched.
    expect(guard.refusal("autumn__research")).toBeUndefined();
    expect(guard.failed("recruiting_role", "402")).toBeUndefined();
  });
});
