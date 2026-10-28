import { describe, expect, it } from "vitest";
import { untilStopped } from "./pi-runtime.js";

describe("untilStopped", () => {
  it("ends a stopped run even when its tool call never settles", async () => {
    const controller = new AbortController();
    const pending = untilStopped(new Promise<never>(() => undefined), controller.signal);
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("returns the tool result while the run is live", async () => {
    await expect(untilStopped(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });
});
