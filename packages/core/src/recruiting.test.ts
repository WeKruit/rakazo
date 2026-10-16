import type { Verdict } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

const preference = {
  target: "preference",
  scope: "user",
  path: "preferences.md",
  expectedRevision: 1,
  intent: { basis: "direct", quote: "Remember this" },
  sourceRefs: [],
} as const;

describe("exact recruiting preference edits", () => {
  it("appends exact new content and returns its resulting UTF-16 anchor", () => {
    const input = { ...preference, operation: "add" as const, content: "  prompt preference\n" };
    expect(core.applyRecruitingPreferenceEdit?.("", input)).toEqual({
      content: input.content,
      anchor: { start: 0, end: input.content.length, quote: input.content },
    });
    expect(core.applyRecruitingPreferenceEdit?.("🙂 previous", input)).toEqual({
      content: `🙂 previous\n\n${input.content}`,
      anchor: {
        start: "🙂 previous\n\n".length,
        end: "🙂 previous\n\n".length + input.content.length,
        quote: input.content,
      },
    });
  });

  it("replaces only the selected duplicate span and preserves every surrounding character", () => {
    const content = "🙂 old\nkeep old\n";
    const start = content.lastIndexOf("old");
    const result = core.applyRecruitingPreferenceEdit?.(content, {
      ...preference,
      operation: "replace",
      anchor: { start, end: start + 3, quote: "old" },
      content: "new🙂",
    });
    expect(result).toEqual({
      content: "🙂 old\nkeep new🙂\n",
      anchor: { start, end: start + 5, quote: "new🙂" },
    });
  });

  it("revokes only the exact span and allows the last preference to become empty", () => {
    expect(
      core.applyRecruitingPreferenceEdit?.("keep\nold\nkeep", {
        ...preference,
        operation: "revoke",
        anchor: { start: 5, end: 8, quote: "old" },
      }),
    ).toEqual({ content: "keep\n\nkeep", anchor: null });
    expect(
      core.applyRecruitingPreferenceEdit?.("🙂", {
        ...preference,
        operation: "revoke",
        anchor: { start: 0, end: 2, quote: "🙂" },
      }),
    ).toEqual({ content: "", anchor: null });
  });

  it("rejects stale, out-of-range and surrogate-splitting anchors without fuzzy matching", () => {
    for (const anchor of [
      { start: 0, end: 1, quote: "\ud83d" },
      { start: 1, end: 2, quote: "\ude42" },
      { start: -1, end: 2, quote: "🙂" },
      { start: 0, end: 20, quote: "🙂 old" },
      { start: 3, end: 6, quote: "new" },
      { start: 3, end: 3, quote: "old" },
    ])
      expect(() =>
        core.applyRecruitingPreferenceEdit?.("🙂 old", {
          ...preference,
          operation: "revoke",
          anchor,
        }),
      ).toThrow();
  });
});

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
