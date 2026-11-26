import { describe, expect, it } from "vitest";
import { estimateWorkMs, workCountdownLeftMs, workCountdownsElapsed } from "./work-estimate.js";

const MINUTE = 60_000;

describe("work estimates", () => {
  it("counts up for small work and down for big work", () => {
    expect(estimateWorkMs("search", 30)).toBeNull();
    expect(estimateWorkMs("search", 100)).toBe(2 * MINUTE);
    expect(estimateWorkMs("search", 200)).toBe(5 * MINUTE);
    expect(estimateWorkMs("search", 300)).toBe(10 * MINUTE);
    expect(estimateWorkMs("search", 500)).toBe(10 * MINUTE);
    expect(estimateWorkMs("search", 1000)).toBe(20 * MINUTE);
    expect(estimateWorkMs("search", 5000)).toBe(30 * MINUTE);
    expect(estimateWorkMs("emails", 100)).toBe(5 * MINUTE);
    expect(estimateWorkMs("emails", 500)).toBe(25 * MINUTE);
  });

  it("starts a run-out countdown over at full length", () => {
    const startedAt = "2026-10-30T20:00:00Z";
    const start = Date.parse(startedAt);
    const estimate = { startedAt, estimateMs: 10 * MINUTE };
    expect(workCountdownLeftMs(estimate, start + 4 * MINUTE)).toBe(6 * MINUTE);
    expect(workCountdownsElapsed(estimate, start + 4 * MINUTE)).toBe(0);
    expect(workCountdownLeftMs(estimate, start + 12 * MINUTE)).toBe(8 * MINUTE);
    expect(workCountdownsElapsed(estimate, start + 12 * MINUTE)).toBe(1);
    expect(workCountdownLeftMs({ startedAt, estimateMs: null }, start)).toBeNull();
  });
});
