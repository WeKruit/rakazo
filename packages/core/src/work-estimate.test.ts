import { describe, expect, it } from "vitest";
import {
  estimateWorkMs,
  peopleNamedIn,
  workCountdownLeftMs,
  workCountdownsElapsed,
} from "./work-estimate.js";

const MINUTE = 60_000;

describe("work estimates", () => {
  it("counts up for small work and down for big work", () => {
    expect(estimateWorkMs("search", 30)).toBeNull();
    expect(estimateWorkMs("search", 100)).toBe(5 * MINUTE);
    expect(estimateWorkMs("search", 300)).toBe(10 * MINUTE);
    expect(estimateWorkMs("search", 500)).toBe(17 * MINUTE);
    expect(estimateWorkMs("search", 5000)).toBe(30 * MINUTE);
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

  it("reads the people count a search names, else the default target", () => {
    expect(peopleNamedIn("Find 500 more USC alumni")).toBe(500);
    expect(peopleNamedIn("Find 1,200 engineers")).toBe(1200);
    expect(peopleNamedIn("Backend engineers with 10+ years, graduated after 2018")).toBe(100);
    expect(peopleNamedIn("Find 30 nurses")).toBe(30);
    expect(peopleNamedIn(undefined)).toBe(100);
  });

  it("counts the people asked for on top of a running total", () => {
    expect(
      peopleNamedIn("Results show 518 people. Deliver 100 additional people, targeting 618 total."),
    ).toBe(100);
    expect(peopleNamedIn("再找 300 个人，目前 451 人")).toBe(300);
    expect(peopleNamedIn("Find another 250; Results have 900")).toBe(250);
  });
});
