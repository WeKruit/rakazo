import { describe, expect, it } from "vitest";
import { isCreatingRpcPath, RateWindow } from "./rate-window.js";

describe("RateWindow", () => {
  it("allows up to the limit per key, then again once the window has passed", () => {
    const window = new RateWindow(2, 1_000);
    expect(window.take("a", 0)).toBe(true);
    expect(window.take("a", 10)).toBe(true);
    expect(window.take("a", 20)).toBe(false);
    expect(window.take("b", 20)).toBe(true);
    expect(window.take("a", 1_001)).toBe(true);
  });

  it("counts only creating RPC calls", () => {
    expect(isCreatingRpcPath("/rpc/threads/send")).toBe(true);
    expect(isCreatingRpcPath("/rpc/bots/create")).toBe(true);
    expect(isCreatingRpcPath("/rpc/threads/list")).toBe(false);
    expect(isCreatingRpcPath("/rpc/threads/subscribe")).toBe(false);
  });
});
