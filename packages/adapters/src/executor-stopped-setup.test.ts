import { describe, expect, it } from "vitest";
import { IsolationError } from "@rakazo/db";
import { stoppedDuringSetup } from "./executor.js";

function prismaWith(status: string | null) {
  return {
    run: { findUnique: async () => (status === null ? null : { status }) },
  } as unknown as Parameters<typeof stoppedDuringSetup>[0];
}

describe("stoppedDuringSetup", () => {
  it("is true when a stopped run fails its live-run check", async () => {
    expect(
      await stoppedDuringSetup(
        prismaWith("cancelled"),
        "r",
        new IsolationError(),
      ),
    ).toBe(true);
  });
  it("stays an error while the run is still live", async () => {
    expect(
      await stoppedDuringSetup(prismaWith("leased"), "r", new IsolationError()),
    ).toBe(false);
  });
  it("stays an error for other failures", async () => {
    expect(
      await stoppedDuringSetup(
        prismaWith("cancelled"),
        "r",
        new Error("fetch failed"),
      ),
    ).toBe(false);
  });
  it("stays an error when the run is gone", async () => {
    expect(
      await stoppedDuringSetup(prismaWith(null), "r", new IsolationError()),
    ).toBe(false);
  });
});
