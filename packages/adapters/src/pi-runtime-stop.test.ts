import { describe, expect, it, vi } from "vitest";
import { untilStopped } from "./pi-runtime.js";

describe("untilStopped", () => {
  it("ends a stopped run even when its tool call never settles", async () => {
    const controller = new AbortController();
    const onAbandon = vi.fn();
    const pending = untilStopped(
      new Promise<never>(() => undefined),
      controller.signal,
      onAbandon,
      10,
    );
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    expect(onAbandon).toHaveBeenCalledOnce();
  });

  it("keeps the result of a tool that settles within the grace after a stop", async () => {
    const controller = new AbortController();
    const onAbandon = vi.fn();
    let finish!: (value: number) => void;
    const pending = untilStopped(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
      controller.signal,
      onAbandon,
      1_000,
    );
    controller.abort(new Error("stopped"));
    finish(7);
    await expect(pending).resolves.toBe(7);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("returns the tool result while the run is live", async () => {
    await expect(untilStopped(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });
});
