import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSilenceWatch } from "./silence-watch.js";

describe("silence watch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops a run once after the limit without events, never before its first event", () => {
    const onSilent = vi.fn();
    const watch = createSilenceWatch({ limitMs: 60_000, checkEveryMs: 1_000, onSilent });
    vi.advanceTimersByTime(5 * 60_000);
    expect(onSilent).not.toHaveBeenCalled();

    watch.touch();
    vi.advanceTimersByTime(59_000);
    watch.touch();
    vi.advanceTimersByTime(59_000);
    expect(onSilent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(onSilent.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(60_000);
    expect(watch.fired).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(onSilent).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
