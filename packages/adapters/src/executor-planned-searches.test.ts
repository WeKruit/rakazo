import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNED_SEARCH_LATE, settlePlannedSearches } from "./executor.js";

const resolveIn = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("settlePlannedSearches", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a search out once the others are in and the wait is over", async () => {
    vi.useFakeTimers({ now: 0 });
    const settled = settlePlannedSearches([resolveIn(1_000, "a"), resolveIn(60_000, "b")], 0);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(settled).resolves.toEqual(["a", PLANNED_SEARCH_LATE]);
  });

  it("waits for the first search even when every search outlasts the wait", async () => {
    vi.useFakeTimers({ now: 0 });
    const settled = settlePlannedSearches([resolveIn(12_000, "a"), resolveIn(60_000, "b")], 0);
    await vi.advanceTimersByTimeAsync(12_001);
    await expect(settled).resolves.toEqual(["a", PLANNED_SEARCH_LATE]);
  });
});
