import { describe, expect, it } from "vitest";
import {
  createCreditGuard,
  isOutOfCredits,
  OUT_OF_CREDITS_NOTE,
  retryWhileOutOfCredits,
} from "./provider-credits.js";

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

describe("waiting out a top-up", () => {
  const options = (waits: number[]) => ({
    failure: (outcome: string) => (outcome === "ok" ? undefined : outcome),
    delaysMs: [1, 2, 3],
    wait: async (ms: number) => {
      waits.push(ms);
    },
  });

  it("repeats a refused call until it goes through", async () => {
    const outcomes = ["402 Payment Required", "out of credits", "ok"];
    const waits: number[] = [];
    expect(await retryWhileOutOfCredits(async () => outcomes.shift()!, options(waits))).toBe("ok");
    expect(waits).toEqual([1, 2]);
  });

  it("gives up after the last wait and returns other failures at once", async () => {
    const waits: number[] = [];
    expect(await retryWhileOutOfCredits(async () => "402", options(waits))).toBe("402");
    expect(waits).toEqual([1, 2, 3]);
    const none: number[] = [];
    expect(await retryWhileOutOfCredits(async () => "invalid query", options(none))).toBe(
      "invalid query",
    );
    expect(none).toEqual([]);
  });

  it("stops waiting when the run is stopped", async () => {
    const controller = new AbortController();
    const waiting = retryWhileOutOfCredits(async () => "402", {
      failure: (outcome) => outcome,
      delaysMs: [60_000],
      signal: controller.signal,
    });
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });
});
