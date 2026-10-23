import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoalescedRefresh } from "./coalesced-refresh";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeDocument() {
  const target = new EventTarget();
  return Object.assign(target, { hidden: false });
}

it("runs a burst once now and once at the end of the window", () => {
  const run = vi.fn();
  const queue = createCoalescedRefresh(run, { windowMs: 1_000, doc: fakeDocument() });
  for (let i = 0; i < 50; i++) queue.request();
  expect(run).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1_000);
  expect(run).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it("waits for the page to be visible", () => {
  const run = vi.fn();
  const doc = fakeDocument();
  const queue = createCoalescedRefresh(run, { windowMs: 1_000, doc });
  doc.hidden = true;
  for (let i = 0; i < 10; i++) queue.request();
  vi.advanceTimersByTime(60_000);
  expect(run).not.toHaveBeenCalled();
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(run).toHaveBeenCalledTimes(1);
  queue.dispose();
});
