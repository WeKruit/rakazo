import { describe, expect, it } from "vitest";
import { withinDeadline } from "./deadline.js";

describe("withinDeadline", () => {
  it("goes on with the late result when a call never settles", async () => {
    await expect(
      withinDeadline(new Promise<string>(() => undefined), 10, () => "late"),
    ).resolves.toBe("late");
  });

  it("keeps the result of a call that settles in time", async () => {
    await expect(withinDeadline(Promise.resolve("done"), 1_000, () => "late")).resolves.toBe(
      "done",
    );
  });

  it("keeps a call's failure", async () => {
    await expect(
      withinDeadline(Promise.reject(new Error("refused")), 1_000, () => "late"),
    ).rejects.toThrow("refused");
  });
});
