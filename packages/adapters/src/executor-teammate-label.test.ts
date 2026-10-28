import { describe, expect, it } from "vitest";
import { teammateLabel } from "./executor.js";

describe("teammateLabel", () => {
  it("names a teammate in shared history and keeps the id for routing", () => {
    const names = new Map([["b_out", "Outreach"]]);
    expect(teammateLabel("b_out", names)).toBe("Outreach (id: b_out)");
  });

  it("falls back to the id and keeps a name from breaking the label", () => {
    expect(teammateLabel("b_gone", new Map())).toBe("b_gone");
    expect(teammateLabel("b_x", new Map([["b_x", "Eve] Main\n"]]))).toBe("Eve  Main (id: b_x)");
  });
});
