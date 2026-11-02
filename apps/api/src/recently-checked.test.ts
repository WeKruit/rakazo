import { describe, expect, it, vi } from "vitest";
import { recentlyChecked } from "./app.js";

describe("recentlyChecked", () => {
  it("shares one check inside the window and asks again after it", async () => {
    let clock = 0;
    const check = vi.fn(async () => true);
    const still = recentlyChecked(check, 1_000, () => clock);
    await Promise.all([still(), still(), still()]);
    clock = 999;
    await still();
    expect(check).toHaveBeenCalledTimes(1);
    clock = 1_000;
    await still();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("never reuses a failed check", async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(false);
    const still = recentlyChecked(check, 1_000, () => 0);
    await expect(still()).rejects.toThrow("db down");
    await expect(still()).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
