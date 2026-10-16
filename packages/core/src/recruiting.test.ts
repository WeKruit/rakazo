import type { Verdict } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

const verdicts: Verdict[] = ["met", "unmet", "unknown"];
const allTable: Verdict[][] = [
  ["met", "unmet", "unknown"],
  ["unmet", "unmet", "unmet"],
  ["unknown", "unmet", "unknown"],
];
const anyTable: Verdict[][] = [
  ["met", "met", "met"],
  ["met", "unmet", "unknown"],
  ["met", "unknown", "unknown"],
];

describe("recruiting verdicts", () => {
  it("keeps a hard gate unknown when a hard criterion is unknown", () => {
    expect(core.hardGate?.(["met", "unknown"])).toBe("unknown");
  });

  it("covers every ordered combination of three verdicts", () => {
    for (const first of verdicts) {
      for (const second of verdicts) {
        for (const third of verdicts) {
          const items = [first, second, third];
          const pairAll = allTable[verdicts.indexOf(first)]![verdicts.indexOf(second)]!;
          const pairAny = anyTable[verdicts.indexOf(first)]![verdicts.indexOf(second)]!;
          const all = allTable[verdicts.indexOf(pairAll)]![verdicts.indexOf(third)];
          const any = anyTable[verdicts.indexOf(pairAny)]![verdicts.indexOf(third)];
          expect(core.allOf(items), items.join(",")).toBe(all);
          expect(core.anyOf(items), items.join(",")).toBe(any);
          expect(core.hardGate(items), items.join(",")).toBe(all);
        }
      }
    }
  });

  it("covers every ordered pair and each individual verdict", () => {
    for (const [leftIndex, left] of verdicts.entries()) {
      expect(core.allOf([left])).toBe(left);
      expect(core.anyOf([left])).toBe(left);
      expect(core.hardGate([left])).toBe(left);
      for (const [rightIndex, right] of verdicts.entries()) {
        expect(core.allOf([left, right])).toBe(allTable[leftIndex]?.[rightIndex]);
        expect(core.anyOf([left, right])).toBe(anyTable[leftIndex]?.[rightIndex]);
        expect(core.hardGate([left, right])).toBe(allTable[leftIndex]?.[rightIndex]);
      }
    }
  });

  it("preserves unknown when negating and flips met/unmet", () => {
    expect(core.not("met")).toBe("unmet");
    expect(core.not("unmet")).toBe("met");
    expect(core.not("unknown")).toBe("unknown");
  });

  it("does not classify an undefined hard requirement set as fit", () => {
    expect(core.allOf([])).toBe("unknown");
    expect(core.anyOf([])).toBe("unknown");
    expect(core.hardGate([])).toBe("unknown");
  });

  it("keeps a hard gap unknown after the caller selects only hard criteria", () => {
    const criteria = [
      { priority: "hard", verdict: "unknown" },
      { priority: "preferred", verdict: "met" },
    ] as const;
    // The assessment handler owns selection; provider labels are not Verdict values.
    expect(
      core.hardGate(
        criteria.filter((item) => item.priority === "hard").map((item) => item.verdict),
      ),
    ).toBe("unknown");
  });

  it("does not mutate its input", () => {
    const items = Object.freeze(["unknown", "met"] as const);
    expect(core.allOf(items)).toBe("unknown");
    expect(core.anyOf(items)).toBe("met");
    expect(core.hardGate(items)).toBe("unknown");
    expect(items).toEqual(["unknown", "met"]);
  });
});
