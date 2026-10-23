import { ORPCError } from "@orpc/client";
import { afterEach, expect, it, vi } from "vitest";
import { retryTransientRead } from "./read-retry";

afterEach(() => vi.useRealTimers());

it("backs off through transient failures and stops after about two minutes", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValue(new ORPCError("SERVICE_UNAVAILABLE", { status: 503 }));
  const result = retryTransientRead(read).catch((error: unknown) => error);
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]) {
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(read).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(calls + 1);
  }
  expect(await result).toBeInstanceOf(ORPCError);
  expect(read).toHaveBeenCalledTimes(9);
});

it("returns the first successful read after a network failure", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(7);
  const result = retryTransientRead(read);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toBe(7);
});

it.each([
  new ORPCError("FORBIDDEN"),
  new ORPCError("NOT_FOUND"),
  new ORPCError("TOO_MANY_REQUESTS"),
])("does not retry %s", async (error) => {
  const read = vi.fn().mockRejectedValue(error);
  await expect(retryTransientRead(read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});

it("stops retrying once the read is abandoned", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const read = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  const result = retryTransientRead(read, abort.signal).catch(() => "stopped");
  abort.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toBe("stopped");
  expect(read).toHaveBeenCalledTimes(1);
});
