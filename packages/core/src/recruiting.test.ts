import type {
  RecruitingCriterion,
  RecruitingCriterionExpression,
  Verdict,
} from "@rakazo/contracts";
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

const atom = (id: string): RecruitingCriterionExpression => ({ kind: "atom", id, statement: id });
const criterion = (
  id: string,
  expression: RecruitingCriterionExpression,
  priority: "hard" | "preferred" = "hard",
  definitionQuestions: readonly string[] = [],
): RecruitingCriterion => ({
  id,
  expression,
  priority,
  definitionQuestions,
  sourceRefs: [
    {
      id: "source",
      kind: "original_material",
      anchor: { kind: "message", messageId: "message", locator: "body" },
      readState: "read",
      readAt: "2024-01-01T00:00:00.000Z",
    },
  ],
});

describe("recruiting criterion evaluation", () => {
  it("evaluates nested AND, OR and NOT from semantic atom verdicts", () => {
    const expression: RecruitingCriterionExpression = {
      kind: "all",
      items: [atom("a"), { kind: "any", items: [atom("b"), { kind: "not", item: atom("c") }] }],
    };
    for (const a of verdicts)
      for (const b of verdicts)
        for (const c of verdicts) {
          const result = core.evaluateRecruitingCriteria(
            { criteria: [criterion("requirement", expression)], definitionQuestions: [] },
            new Map([
              ["a", a],
              ["b", b],
              ["c", c],
            ]),
          );
          const verdict = core.allOf([a, core.anyOf([b, core.not(c)])]);
          expect(result).toEqual({
            criteria: [{ criterionId: "requirement", verdict }],
            hardGate: verdict,
          });
        }
  });

  it("keeps an absent atom unknown instead of inventing a negative fact", () => {
    expect(
      core.evaluateRecruitingCriteria(
        {
          criteria: [criterion("missing", { kind: "not", item: atom("onsite") })],
          definitionQuestions: [],
        },
        new Map(),
      ),
    ).toEqual({ criteria: [{ criterionId: "missing", verdict: "unknown" }], hardGate: "unknown" });
  });

  it("does not let preferred results compensate for a hard gap or failure", () => {
    const role = {
      criteria: [criterion("hard", atom("hard")), criterion("nice", atom("nice"), "preferred")],
      definitionQuestions: [],
    };
    for (const verdict of ["unmet", "unknown"] as const)
      expect(
        core.evaluateRecruitingCriteria(
          role,
          new Map([
            ["hard", verdict],
            ["nice", "met"],
          ]),
        ).hardGate,
      ).toBe(verdict);
  });

  it("does not qualify an undefined hard requirement or an empty hard set", () => {
    expect(
      core.evaluateRecruitingCriteria(
        {
          criteria: [criterion("vague", atom("a"), "hard", ["What counts?"])],
          definitionQuestions: [],
        },
        new Map([["a", "met"]]),
      ).hardGate,
    ).toBe("unknown");
    expect(
      core.evaluateRecruitingCriteria(
        { criteria: [criterion("nice", atom("a"), "preferred")], definitionQuestions: [] },
        new Map([["a", "met"]]),
      ).hardGate,
    ).toBe("unknown");
  });

  it("role definition questions block met without erasing an independent hard failure", () => {
    const role = {
      criteria: [criterion("a", atom("a"))],
      definitionQuestions: ["Which location?"],
    };
    expect(core.evaluateRecruitingCriteria(role, new Map([["a", "met"]])).hardGate).toBe("unknown");
    expect(core.evaluateRecruitingCriteria(role, new Map([["a", "unmet"]])).hardGate).toBe("unmet");
  });

  it("retains an independent hard failure beside an unresolved criterion", () => {
    expect(
      core.evaluateRecruitingCriteria(
        {
          criteria: [criterion("a", atom("a")), criterion("b", atom("b"), "hard", ["Define b"])],
          definitionQuestions: [],
        },
        new Map([
          ["a", "unmet"],
          ["b", "met"],
        ]),
      ).hardGate,
    ).toBe("unmet");
  });

  it("does not mutate the supplied expression or atom verdicts", () => {
    const expression = Object.freeze({ kind: "atom", id: "a", statement: "a" } as const);
    const judgments = new Map<string, Verdict>([["a", "met"]]);
    core.evaluateRecruitingCriteria(
      { criteria: Object.freeze([criterion("a", expression)]), definitionQuestions: [] },
      judgments,
    );
    expect(expression).toEqual({ kind: "atom", id: "a", statement: "a" });
    expect([...judgments]).toEqual([["a", "met"]]);
  });
});

const day = (year: number, month: number, day: number) => ({
  precision: "day" as const,
  year,
  month,
  day,
});
const month = (year: number, month: number) => ({ precision: "month" as const, year, month });
const year = (year: number) => ({ precision: "year" as const, year });
type EmploymentInterval = Parameters<typeof core.qualifiedEmploymentMonths>[0]["intervals"][number];
const job = (
  start: EmploymentInterval["start"],
  end: EmploymentInterval["end"],
  qualifyingFullTime: Verdict = "met",
): EmploymentInterval => ({ start, end, qualifyingFullTime });
const months = (
  intervals: readonly EmploymentInterval[],
  minimumMonths: number,
  historyComplete = true,
  cutoff = day(2024, 12, 31),
) =>
  core.qualifiedEmploymentMonths({
    countingRule: "complete_calendar_months",
    cutoff,
    historyComplete,
    minimumMonths,
    intervals,
  });

describe("qualified full-time employment month bounds", () => {
  it("unions unsorted overlapping employment before counting, without double credit", () => {
    const jobs = Object.freeze([
      Object.freeze(job(day(2024, 3, 1), day(2024, 6, 30))),
      Object.freeze(job(day(2024, 1, 1), day(2024, 4, 30))),
    ]);
    expect(months(jobs, 6)).toEqual({ lowerMonths: 6, upperMonths: 6, verdict: "met" });
    expect(jobs[0]?.start).toEqual(day(2024, 3, 1));
  });

  it("merges adjacent partial intervals before testing complete calendar coverage", () => {
    expect(
      months([job(day(2024, 1, 1), day(2024, 1, 15)), job(day(2024, 1, 16), day(2024, 1, 31))], 1),
    ).toEqual({ lowerMonths: 1, upperMonths: 1, verdict: "met" });
    expect(
      months([job(day(2024, 1, 1), day(2024, 1, 14)), job(day(2024, 1, 16), day(2024, 1, 31))], 1),
    ).toEqual({ lowerMonths: 0, upperMonths: 0, verdict: "unmet" });
  });

  it("uses the supplied threshold rather than a global number of years", () => {
    const jobs = [job(day(2020, 1, 1), day(2024, 12, 31))];
    expect(months(jobs, 60)).toEqual({ lowerMonths: 60, upperMonths: 60, verdict: "met" });
    expect(months(jobs, 61)).toEqual({ lowerMonths: 60, upperMonths: 60, verdict: "unmet" });
    expect(months(jobs, 84).verdict).toBe("unmet");
  });

  it("preserves month-precision boundary uncertainty unless a bound resolves the threshold", () => {
    const jobs = [job(month(2024, 1), month(2024, 6))];
    expect(months(jobs, 5)).toEqual({ lowerMonths: 4, upperMonths: 6, verdict: "unknown" });
    expect(months(jobs, 4).verdict).toBe("met");
    expect(months(jobs, 7).verdict).toBe("unmet");
  });

  it("preserves year-precision uncertainty without assuming January and December as facts", () => {
    expect(months([job(year(2024), year(2024))], 1)).toEqual({
      lowerMonths: 0,
      upperMonths: 12,
      verdict: "unknown",
    });
  });

  it("does not turn unknown full-time eligibility into either confirmed work or proven noncompliance", () => {
    expect(months([job(day(2024, 1, 1), day(2024, 12, 31), "unknown")], 6)).toEqual({
      lowerMonths: 0,
      upperMonths: 12,
      verdict: "unknown",
    });
    expect(months([job(day(2024, 1, 1), day(2024, 12, 31), "unmet")], 6)).toEqual({
      lowerMonths: 0,
      upperMonths: 0,
      verdict: "unmet",
    });
  });

  it("distinguishes a complete below-threshold history from an incomplete history", () => {
    const jobs = [job(day(2024, 1, 1), day(2024, 6, 30))];
    expect(months(jobs, 7, true)).toEqual({ lowerMonths: 6, upperMonths: 6, verdict: "unmet" });
    expect(months(jobs, 7, false)).toEqual({
      lowerMonths: 6,
      upperMonths: null,
      verdict: "unknown",
    });
    expect(months(jobs, 6, false)).toEqual({ lowerMonths: 6, upperMonths: null, verdict: "met" });
  });

  it("keeps an unknown start unbounded and an unknown end bounded by the cutoff", () => {
    expect(months([job(null, "present")], 1)).toEqual({
      lowerMonths: 0,
      upperMonths: null,
      verdict: "unknown",
    });
    expect(months([job(day(2024, 1, 1), null)], 6)).toEqual({
      lowerMonths: 0,
      upperMonths: 12,
      verdict: "unknown",
    });
    expect(months([job(day(2024, 1, 1), null)], 13).verdict).toBe("unmet");
  });

  it("freezes present at the explicit cutoff and excludes the partial cutoff month", () => {
    expect(months([job(day(2024, 1, 1), "present")], 3, true, day(2024, 3, 15))).toEqual({
      lowerMonths: 2,
      upperMonths: 2,
      verdict: "unmet",
    });
    expect(months([job(day(2024, 1, 1), day(2027, 12, 31))], 3, true, day(2024, 3, 15))).toEqual({
      lowerMonths: 2,
      upperMonths: 2,
      verdict: "unmet",
    });
    expect(months([job(day(2025, 1, 1), "present")], 1)).toEqual({
      lowerMonths: 0,
      upperMonths: 0,
      verdict: "unmet",
    });
  });

  it("counts real leap-year boundaries and century rules without timezone dependence", () => {
    expect(months([job(day(2024, 2, 1), day(2024, 2, 29))], 1).lowerMonths).toBe(1);
    expect(months([job(day(2000, 2, 1), day(2000, 2, 29))], 1).lowerMonths).toBe(1);
    expect(months([job(day(1900, 2, 1), day(1900, 2, 28))], 1).lowerMonths).toBe(1);
    expect(months([job(day(1, 1, 1), day(1, 12, 31))], 12).lowerMonths).toBe(12);
  });

  it("counts a partial start and end only when their union covers a whole month", () => {
    expect(months([job(day(2024, 1, 15), day(2024, 3, 14))], 2)).toEqual({
      lowerMonths: 1,
      upperMonths: 1,
      verdict: "unmet",
    });
    expect(
      months(
        [
          job(day(2024, 1, 1), day(2024, 1, 15)),
          job(day(2024, 1, 16), day(2024, 1, 31), "unknown"),
        ],
        1,
      ),
    ).toEqual({ lowerMonths: 0, upperMonths: 1, verdict: "unknown" });
  });

  it("handles an empty history honestly", () => {
    expect(months([], 1)).toEqual({ lowerMonths: 0, upperMonths: 0, verdict: "unmet" });
    expect(months([], 1, false)).toEqual({ lowerMonths: 0, upperMonths: null, verdict: "unknown" });
  });

  it("rejects invalid thresholds, dates and impossible employment intervals", () => {
    for (const threshold of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => months([], threshold)).toThrow();
    for (const invalid of [
      day(2023, 2, 29),
      day(1900, 2, 29),
      day(2024, 13, 1),
      day(2024, 1, 0),
      day(0, 1, 1),
      day(10000, 1, 1),
      day(2024.5, 1, 1),
    ])
      expect(() => months([job(invalid, "present")], 1)).toThrow();
    expect(() => months([job(day(2024, 6, 1), day(2024, 5, 31))], 1)).toThrow();
  });

  it("rejects non-verdict eligibility and missing history completeness", () => {
    expect(() => months([job(day(2024, 1, 1), "present", "yes" as Verdict)], 1)).toThrow(
      "Employment eligibility must be a three-state verdict",
    );
    expect(() =>
      core.qualifiedEmploymentMonths({
        countingRule: "complete_calendar_months",
        cutoff: day(2024, 12, 31),
        historyComplete: undefined as unknown as boolean,
        minimumMonths: 1,
        intervals: [],
      }),
    ).toThrow("Employment history completeness must be explicit");
    expect(() =>
      core.qualifiedEmploymentMonths({
        countingRule: "complete_calendar_months",
        cutoff: month(2024, 12) as unknown as ReturnType<typeof day>,
        historyComplete: true,
        minimumMonths: 1,
        intervals: [],
      }),
    ).toThrow("Employment cutoff must be an exact day");
  });

  it("requires the role's explicit counting rule rather than silently choosing partial-month semantics", () => {
    expect(() =>
      core.qualifiedEmploymentMonths({
        countingRule: undefined as unknown as "complete_calendar_months",
        cutoff: day(2024, 12, 31),
        historyComplete: true,
        minimumMonths: 1,
        intervals: [],
      }),
    ).toThrow();
    expect(() =>
      core.qualifiedEmploymentMonths({
        countingRule: "touched_months" as "complete_calendar_months",
        cutoff: day(2024, 12, 31),
        historyComplete: true,
        minimumMonths: 1,
        intervals: [],
      }),
    ).toThrow();
  });
});
