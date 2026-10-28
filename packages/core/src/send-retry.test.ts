import { describe, expect, it, vi } from "vitest";
import { isRetryableSendFailure, retrySend, SEND_RETRY_DELAYS_MS } from "./send-retry.js";

const offline = () => new TypeError("Failed to fetch");
const status = (code: number) => Object.assign(new Error(`status ${code}`), { status: code });

describe("retrySend", () => {
  it("resends the same request after a network failure until it is accepted", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const send = vi
      .fn()
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce({ seq: 7 });
    await expect(retrySend(send, { sleep })).resolves.toEqual({ seq: 7 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it("gives up after seven tries over about a minute with the last error", async () => {
    const waited: number[] = [];
    const last = offline();
    const send = vi.fn(async () => {
      throw send.mock.calls.length === 7 ? last : offline();
    });
    await expect(retrySend(send, { sleep: async (ms) => void waited.push(ms) })).rejects.toBe(last);
    expect(send).toHaveBeenCalledTimes(7);
    expect(waited).toEqual([...SEND_RETRY_DELAYS_MS]);
    const total = waited.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(45_000);
    expect(total).toBeLessThanOrEqual(75_000);
  });

  it("never repeats a send the server refused", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const refused = status(409);
    const send = vi.fn().mockRejectedValue(refused);
    await expect(retrySend(send, { sleep })).rejects.toBe(refused);
    expect(send).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops once the caller no longer wants the send", async () => {
    let keep = true;
    const send = vi.fn().mockRejectedValue(offline());
    await expect(
      retrySend(send, {
        sleep: async () => {
          keep = false;
        },
        keepTrying: () => keep,
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("isRetryableSendFailure", () => {
  it.each([
    [offline(), true],
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), true],
    [status(429), true],
    [status(408), true],
    [status(500), true],
    [new Error("wrapped", { cause: status(502) }), true],
    [status(400), false],
    [status(403), false],
    [new Error("Unknown acceptance"), false],
  ])("%s → %s", (error, expected) => {
    expect(isRetryableSendFailure(error)).toBe(expected);
  });
});
