import { createHash } from "node:crypto";
import type {
  ReassessRecruitingAssessmentInput,
  RecruitingAssessment,
  RecruitingCriterion,
  RecruitingCriterionExpression,
  RecruitingEmploymentRule,
  RecruitingRoleRevision,
  SaveRecruitingAssessmentInput,
  Verdict,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("native recruiting result snapshot reads", () => {
  const rows = [
    {
      name: { value: "Synthetic person", source_id: "s1" },
      label: "Strong Match",
      _sources: { s1: "https://example.test/profile" },
      missing: null,
    },
  ];
  const snapshot = {
    version: 1,
    taskId: "task",
    actionId: "action",
    operation: "rows",
    effectId: "read-effect",
    request: { task_id: "provider-task", cursor: "  opaque/游标==  ", limit: 10 },
    providerResult: { rows, next_cursor: null },
    observation: {
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      observedProviderState: null,
      done: null,
      providerApplicationConfirmed: false,
      automaticRetry: false,
      usage: null,
      rows,
      nextCursor: null,
      outputId: "real-output",
    },
  };
  function fixture(value: unknown = snapshot) {
    const bytes = Buffer.from(JSON.stringify(value));
    const artifact = {
      artifactId: "rows-artifact",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return {
      bytes,
      expected: {
        task: { id: "task", providerTaskId: "provider-task" },
        action: { id: "action", taskId: "task", outputArtifacts: [artifact] },
        artifact,
      },
    };
  }
  it("reads exact provider rows and preserves opaque page metadata without making judgments", async () => {
    expect(core.readRecruitingResearchReadArtifact).toBeTypeOf("function");
    const f = fixture();
    const result = await core.readRecruitingResearchReadArtifact(f.bytes, f.expected);
    expect(result).toEqual(snapshot);
    expect(result.observation.rows).toEqual(rows);
    expect(result).not.toHaveProperty("assessment");
    expect(result).not.toHaveProperty("candidateKey");
  });
  it.each([
    "bytes",
    "task",
    "action",
    "action-task",
    "provider",
    "request",
    "membership",
    "hash-ref",
    "utf8",
  ])("rejects a snapshot with mismatched %s", async (boundary) => {
    expect(core.readRecruitingResearchReadArtifact).toBeTypeOf("function");
    const value = structuredClone(snapshot);
    if (boundary === "task") value.taskId = "foreign-task";
    if (boundary === "action") value.actionId = "foreign-action";
    if (boundary === "provider") value.observation.providerTaskId = "foreign-provider";
    if (boundary === "request") value.request.task_id = "foreign-provider";
    const f = fixture(value);
    if (boundary === "action-task") f.expected.action.taskId = "foreign-task";
    if (boundary === "bytes") f.bytes = Buffer.from("{}");
    if (boundary === "membership") f.expected.action.outputArtifacts = [];
    if (boundary === "hash-ref")
      f.expected.action.outputArtifacts = [{ ...f.expected.artifact, sha256: "a".repeat(64) }];
    if (boundary === "utf8") {
      f.bytes = Buffer.from([0xff]);
      f.expected.artifact.sha256 = createHash("sha256").update(f.bytes).digest("hex");
    }
    await expect(core.readRecruitingResearchReadArtifact(f.bytes, f.expected)).rejects.toThrow();
  });
  it("keeps status receipts distinct and does not turn absent cursors into end-of-results", async () => {
    expect(core.readRecruitingResearchReadArtifact).toBeTypeOf("function");
    const { rows: _, nextCursor: __, outputId: ___, ...observation } = snapshot.observation;
    const f = fixture({
      ...snapshot,
      operation: "status",
      providerResult: { state: "completed", done: true },
      observation: { ...observation, observedProviderState: "completed", done: true },
    });
    const result = await core.readRecruitingResearchReadArtifact(f.bytes, f.expected);
    expect(result.operation).toBe("status");
    expect(result.observation).not.toHaveProperty("rows");
    expect(result.observation).not.toHaveProperty("nextCursor");
  });
  it.each(["missing-rows", "status-rows", "unknown-rows"])(
    "rejects contradictory %s envelopes",
    async (boundary) => {
      const value: Record<string, unknown> = structuredClone(snapshot);
      const observation = { ...snapshot.observation } as Record<string, unknown>;
      if (boundary === "missing-rows") delete observation.rows;
      if (boundary === "status-rows") value.operation = "status";
      if (boundary === "unknown-rows") observation.deliveryState = "unknown";
      const f = fixture({ ...value, observation });
      await expect(core.readRecruitingResearchReadArtifact(f.bytes, f.expected)).rejects.toThrow();
    },
  );
});

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

const primaryAssessmentSource = {
  id: "original",
  kind: "original_material",
  anchor: {
    kind: "artifact",
    artifact: { artifactId: "original", sha256: "a".repeat(64) },
    locator: "body",
  },
  readState: "read",
  readAt: "2024-12-31T00:00:00.000Z",
  quote: "  original evidence\n",
  selection: { kind: "artifact_text", start: 0, end: 20 },
} as const;
const statementFact = {
  kind: "statement",
  id: "fact",
  statement: "Original component evidence",
  sourceRefIds: ["original"],
} as const;
const semantic = (atomId: string, verdict: Verdict = "met") => ({
  atomId,
  verdict,
  factIds: ["fact"],
  evidence: ["original"],
  missing: verdict === "unknown" ? ["Confirm the component"] : [],
});
const assessmentInput = (
  changes: Partial<SaveRecruitingAssessmentInput> = {},
): SaveRecruitingAssessmentInput => ({
  roleId: "role",
  candidateKey: "candidate",
  roleRevisionId: "revision",
  expectedRevision: 0,
  facts: [statementFact],
  sourceRefs: [primaryAssessmentSource],
  questions: [],
  atomJudgments: [semantic("a")],
  employmentEvaluations: [],
  ...changes,
});
const assessmentRole = (
  criteria: readonly RecruitingCriterion[] = [criterion("c", atom("a"))],
) => ({ criteria, definitionQuestions: [] });
const fixedRule = (minimumMonths: number): RecruitingEmploymentRule => ({
  minimumMonths,
  countingRule: "complete_calendar_months",
  qualificationDefinition: "Full-time personally implemented relevant work",
  cutoff: { kind: "fixed", date: { precision: "day", year: 2024, month: 12, day: 31 } },
});
const employmentFact = (id: string, startYear: number, endYear: number) => ({
  kind: "employment" as const,
  id,
  statement: "Worked full time",
  sourceRefIds: ["original"],
  employmentType: "full-time",
  start: { precision: "day" as const, year: startYear, month: 1, day: 1 },
  end: { precision: "day" as const, year: endYear, month: 12, day: 31 },
});
const completenessFact = {
  kind: "history_completeness",
  id: "complete",
  statement: "This is the complete employment history",
  sourceRefIds: ["original"],
  complete: true,
  asOf: { precision: "day", year: 2024, month: 12, day: 31 },
} as const;
const employmentInput = (minimumMonths = 60) => ({
  role: assessmentRole([
    criterion("years", {
      kind: "atom",
      id: "experience",
      statement: "Enough qualifying experience",
      employmentRule: fixedRule(minimumMonths),
    }),
  ]),
  input: assessmentInput({
    facts: [
      employmentFact("job1", 2020, 2022),
      employmentFact("job2", 2022, 2024),
      completenessFact,
    ],
    atomJudgments: [],
    employmentEvaluations: [
      {
        atomId: "experience",
        intervals: ["job1", "job2"].map((factId) => ({
          factId,
          qualifyingFullTime: "met",
          evidence: ["original"],
          missing: [],
        })),
        historyCompletenessFactId: "complete",
        evidence: ["original"],
        missing: [],
      },
    ],
  }),
});
const assessmentDay = { precision: "day", year: 2025, month: 1, day: 15 } as const;

describe("server-owned recruiting assessment evaluation", () => {
  it("stores deterministic nested criteria with source and fact dependencies and excludes preferences from the hard gate", () => {
    const role = assessmentRole([
      criterion("hard", {
        kind: "all",
        items: [atom("a"), { kind: "any", items: [atom("b"), { kind: "not", item: atom("c") }] }],
      }),
      criterion("preference", atom("d"), "preferred"),
    ]);
    const result = core.evaluateRecruitingAssessment?.(
      role,
      assessmentInput({
        atomJudgments: [
          semantic("a"),
          semantic("b", "unknown"),
          semantic("c", "unmet"),
          semantic("d", "unmet"),
        ],
      }),
      assessmentDay,
    );
    expect(result?.hardGate).toBe("met");
    expect(result?.criteria).toEqual([
      {
        criterionId: "hard",
        verdict: "met",
        factIds: ["fact"],
        evidence: ["original"],
        missing: ["Confirm the component"],
      },
      {
        criterionId: "preference",
        verdict: "unmet",
        factIds: ["fact"],
        evidence: ["original"],
        missing: [],
      },
    ]);
    expect(result?.atoms).toHaveLength(4);
  });

  it("rejects missing, extra, duplicate and dangling atom inputs", () => {
    for (const change of [
      { atomJudgments: [] },
      { atomJudgments: [semantic("other")] },
      { atomJudgments: [semantic("a"), semantic("a")] },
      { atomJudgments: [{ ...semantic("a"), factIds: ["missing"] }] },
      { atomJudgments: [{ ...semantic("a"), evidence: ["missing"] }] },
      { facts: [statementFact, statementFact] },
      { sourceRefs: [primaryAssessmentSource, primaryAssessmentSource] },
    ])
      expect(() =>
        core.evaluateRecruitingAssessment?.(
          assessmentRole(),
          assessmentInput(change),
          assessmentDay,
        ),
      ).toThrow();
  });

  it("requires primary read proof connected to facts for met and unmet and retains provider-only facts as unknown gaps", () => {
    const provider = { ...primaryAssessmentSource, kind: "provider_report" as const };
    for (const verdict of ["met", "unmet"] as const) {
      for (const change of [
        { sourceRefs: [provider], atomJudgments: [semantic("a", verdict)] },
        { atomJudgments: [{ ...semantic("a", verdict), factIds: [] }] },
        { atomJudgments: [{ ...semantic("a", verdict), evidence: [] }] },
      ])
        expect(() =>
          core.evaluateRecruitingAssessment?.(
            assessmentRole(),
            assessmentInput(change),
            assessmentDay,
          ),
        ).toThrow();
    }
    expect(
      core.evaluateRecruitingAssessment?.(
        assessmentRole(),
        assessmentInput({ sourceRefs: [provider], atomJudgments: [semantic("a", "unknown")] }),
        assessmentDay,
      )?.hardGate,
    ).toBe("unknown");
  });

  it("deduplicates overlapping qualifying intervals and applies only the explicit atom threshold", () => {
    for (const [minimumMonths, verdict] of [
      [17, "met"],
      [60, "met"],
      [61, "unmet"],
      [84, "unmet"],
    ] as const) {
      const { role, input } = employmentInput(minimumMonths);
      const result = core.evaluateRecruitingAssessment?.(role, input, assessmentDay);
      expect(result?.hardGate).toBe(verdict);
      expect(result?.employment[0]).toMatchObject({
        lowerMonths: 60,
        upperMonths: 60,
        minimumMonths,
        verdict,
        cutoff:
          fixedRule(minimumMonths).cutoff.kind === "fixed"
            ? { precision: "day", year: 2024, month: 12, day: 31 }
            : undefined,
      });
      expect(result?.atoms[0]).toMatchObject({ atomId: "experience", verdict });
      expect(result?.employment[0]?.intervals).toEqual(input.employmentEvaluations[0]?.intervals);
    }
  });

  it("rejects an omitted known employment interval rather than deriving a false negative from completeness", () => {
    const { role, input } = employmentInput(61);
    expect(() =>
      core.evaluateRecruitingAssessment(
        role,
        {
          ...input,
          employmentEvaluations: [{ ...input.employmentEvaluations[0]!, intervals: [] }],
        },
        assessmentDay,
      ),
    ).toThrow("Every employment fact requires an explicit eligibility judgment");
  });

  it("leaves plain text years atoms semantic without inferring any numeric rule", () => {
    const role = assessmentRole([
      criterion("years", {
        kind: "atom",
        id: "a",
        statement: "Requires 7+ years full-time engineering experience",
      }),
    ]);
    const result = core.evaluateRecruitingAssessment?.(role, assessmentInput(), assessmentDay);
    expect(result?.hardGate).toBe("met");
    expect(result?.employment).toEqual([]);
    const numeric = employmentInput();
    expect(() => core.evaluateRecruitingAssessment?.(role, numeric.input, assessmentDay)).toThrow(
      core.RecruitingAssessmentValidationError,
    );
  });

  it("keeps an insufficient lower bound unknown unless sourced completeness covers the effective cutoff", () => {
    const { role, input } = employmentInput(61);
    for (const fact of [
      undefined,
      { ...completenessFact, complete: false },
      { ...completenessFact, asOf: { precision: "day" as const, year: 2023, month: 12, day: 31 } },
    ]) {
      const result = core.evaluateRecruitingAssessment?.(
        role,
        {
          ...input,
          facts: fact ? [...input.facts.slice(0, 2), fact] : input.facts.slice(0, 2),
          employmentEvaluations: input.employmentEvaluations.map((evaluation) => ({
            ...evaluation,
            historyCompletenessFactId: fact ? "complete" : null,
          })),
        },
        assessmentDay,
      );
      expect(result?.hardGate).toBe("unknown");
      expect(result?.employment[0]?.upperMonths).toBeNull();
      expect(result?.employment[0]?.missing.length).toBeGreaterThan(0);
    }
  });

  it("freezes assessment-date rules to the supplied trusted UTC day and retains unknown semantic eligibility", () => {
    const { input } = employmentInput(61);
    const role = assessmentRole([
      criterion("years", {
        kind: "atom",
        id: "experience",
        statement: "Enough work",
        employmentRule: { ...fixedRule(61), cutoff: { kind: "assessment_date" } },
      }),
    ]);
    const result = core.evaluateRecruitingAssessment?.(
      role,
      {
        ...input,
        facts: [{ ...employmentFact("job1", 2020, 2022), end: "present" }, completenessFact],
        employmentEvaluations: [
          {
            ...input.employmentEvaluations[0]!,
            intervals: [
              {
                factId: "job1",
                qualifyingFullTime: "unknown",
                evidence: ["original"],
                missing: ["Confirm eligible work"],
              },
            ],
          },
        ],
      },
      assessmentDay,
    );
    expect(result?.employment[0]).toMatchObject({
      cutoff: assessmentDay,
      lowerMonths: 0,
      upperMonths: null,
      verdict: "unknown",
    });
    expect(result?.criteria[0]?.missing).toContain("Confirm eligible work");
  });

  it("cannot derive a finite upper bound from unverified dates when employment eligibility is unknown", () => {
    const { role, input } = employmentInput(61);
    const result = core.evaluateRecruitingAssessment(
      role,
      {
        ...input,
        sourceRefs: [
          ...input.sourceRefs,
          {
            id: "unread",
            kind: "original_material",
            anchor: primaryAssessmentSource.anchor,
            readState: "unread",
            readAt: null,
          },
        ],
        facts: input.facts.map((fact) =>
          fact.id === "job2" ? { ...fact, sourceRefIds: ["unread"] } : fact,
        ),
        employmentEvaluations: input.employmentEvaluations.map((evaluation) => ({
          ...evaluation,
          intervals: evaluation.intervals.map((interval) =>
            interval.factId === "job2"
              ? {
                  ...interval,
                  qualifyingFullTime: "unknown",
                  evidence: [],
                  missing: ["Read original employment dates"],
                }
              : interval,
          ),
        })),
      },
      assessmentDay,
    );
    expect(result.hardGate).toBe("unknown");
    expect(result.employment[0]).toMatchObject({
      lowerMonths: 36,
      upperMonths: null,
      verdict: "unknown",
    });
    expect(result.employment[0]?.intervals[1]?.qualifyingFullTime).toBe("unknown");
    expect(result.criteria[0]?.missing).toContain("Read original employment dates");
  });

  it("requires employment and completeness references to the correct fact kinds and primary evidence", () => {
    const { role, input } = employmentInput(61);
    for (const evaluation of [
      {
        ...input.employmentEvaluations[0]!,
        intervals: [
          {
            factId: "complete",
            qualifyingFullTime: "met" as const,
            evidence: ["original"],
            missing: [],
          },
        ],
      },
      { ...input.employmentEvaluations[0]!, historyCompletenessFactId: "job1" },
    ])
      expect(() =>
        core.evaluateRecruitingAssessment?.(
          role,
          { ...input, employmentEvaluations: [evaluation] },
          assessmentDay,
        ),
      ).toThrow();
    expect(() =>
      core.evaluateRecruitingAssessment?.(
        role,
        { ...input, sourceRefs: [{ ...primaryAssessmentSource, kind: "provider_report" }] },
        assessmentDay,
      ),
    ).toThrow();
  });
});

function savedAssessment(
  role: Pick<RecruitingRoleRevision, "criteria" | "definitionQuestions">,
  input: SaveRecruitingAssessmentInput,
): RecruitingAssessment {
  return {
    roleId: input.roleId,
    roleRevisionId: input.roleRevisionId,
    candidateKey: input.candidateKey,
    version: 1,
    basedOnVersion: null,
    createdByRunId: "first-run",
    createdAt: "2025-01-15T00:00:00.000Z",
    facts: input.facts,
    sourceRefs: input.sourceRefs,
    questions: input.questions,
    judgments: core.evaluateRecruitingAssessment(role, input, assessmentDay),
  };
}

const reassessmentRole = () => ({
  id: "revision",
  roleId: "role",
  definitionQuestions: [],
  criteria: [
    criterion("geometry-and-onsite", { kind: "all", items: [atom("geometry"), atom("onsite")] }),
    criterion("geometry-or-onsite", { kind: "any", items: [atom("geometry"), atom("onsite")] }),
    criterion("not-geometry", { kind: "not", item: atom("geometry") }, "preferred"),
  ],
});
const reassessmentFixture = () => {
  const role = reassessmentRole();
  const sources = [primaryAssessmentSource, { ...primaryAssessmentSource, id: "onsite-source" }];
  const input = assessmentInput({
    sourceRefs: sources,
    facts: [
      { ...statementFact, id: "geometry-fact" },
      {
        ...statementFact,
        id: "onsite-fact",
        statement: "Confirmed onsite",
        sourceRefIds: ["onsite-source"],
      },
    ],
    atomJudgments: [
      { ...semantic("geometry", "unknown"), factIds: ["geometry-fact"] },
      { ...semantic("onsite"), factIds: ["onsite-fact"], evidence: ["onsite-source"] },
    ],
  });
  const previous = savedAssessment(role, input);
  const reassess: ReassessRecruitingAssessmentInput = {
    ...input,
    expectedRevision: 1,
    atomJudgments: [],
    employmentEvaluations: [],
  };
  return { role, input, previous, reassess };
};

describe("dependency-checked recruiting reassessment", () => {
  it("reuses unchanged onsite semantics while geometry alone changes derived AND, OR, NOT and the hard gate", () => {
    const { role, previous, reassess } = reassessmentFixture();
    const merged = core.mergeRecruitingReassessment?.(role, previous, {
      ...reassess,
      facts: reassess.facts.map((fact) =>
        fact.id === "geometry-fact"
          ? { ...fact, statement: "Personally implemented coordinate transforms" }
          : fact,
      ),
      atomJudgments: [{ ...semantic("geometry"), factIds: ["geometry-fact"] }],
    });
    expect(merged?.atomJudgments.find((judgment) => judgment.atomId === "onsite")).toEqual(
      previous.judgments.atoms.find((judgment) => judgment.atomId === "onsite"),
    );
    expect(previous.judgments.hardGate).toBe("unknown");
    const next = merged && core.evaluateRecruitingAssessment(role, merged, assessmentDay);
    expect(next?.criteria.map(({ verdict }) => verdict)).toEqual(["met", "met", "unmet"]);
    expect(next?.hardGate).toBe("met");
    expect(previous.facts[0]?.statement).toBe("Original component evidence");
  });

  it("rejects changed or removed fact and source dependencies without an explicit atom update", () => {
    const { role, previous, reassess } = reassessmentFixture();
    for (const change of [
      {
        facts: reassess.facts.map((fact) =>
          fact.id === "geometry-fact" ? { ...fact, statement: "Changed implementation" } : fact,
        ),
      },
      { facts: reassess.facts.filter((fact) => fact.id !== "geometry-fact") },
      {
        sourceRefs: reassess.sourceRefs.map((source) =>
          source.id === "original" ? { ...source, quote: "Changed original quote" } : source,
        ),
      },
      {
        facts: reassess.facts.map((fact) =>
          fact.id === "geometry-fact" ? { ...fact, sourceRefIds: ["onsite-source"] } : fact,
        ),
        sourceRefs: reassess.sourceRefs.filter((source) => source.id !== "original"),
      },
    ])
      expect(() =>
        core.mergeRecruitingReassessment?.(role, previous, { ...reassess, ...change }),
      ).toThrow(core.RecruitingAssessmentValidationError);
  });

  it("does not assign new statement facts to an atom or reevaluate untouched semantics", () => {
    const { role, previous, reassess } = reassessmentFixture();
    const merged = core.mergeRecruitingReassessment?.(role, previous, {
      ...reassess,
      facts: [...reassess.facts, { ...statementFact, id: "new-unassigned" }],
    });
    expect(merged?.atomJudgments).toEqual(previous.judgments.atoms);
    expect(
      merged?.atomJudgments.some((judgment) => judgment.factIds.includes("new-unassigned")),
    ).toBe(false);
  });

  it("rejects wrong atom types, unknown dependencies, stale versions and a different role revision with the typed validation error", () => {
    const { role, previous, reassess } = reassessmentFixture();
    for (const change of [
      { atomJudgments: [semantic("not-in-role")] },
      { atomJudgments: [{ ...semantic("geometry"), factIds: ["unknown"] }] },
      { atomJudgments: [{ ...semantic("geometry"), evidence: ["unknown"] }] },
      {
        employmentEvaluations: [
          {
            atomId: "geometry",
            intervals: [],
            historyCompletenessFactId: null,
            evidence: [],
            missing: [],
          },
        ],
      },
      { roleRevisionId: "new-revision" },
      { roleId: "other-role" },
      { candidateKey: "other-candidate" },
      { expectedRevision: 2 },
    ])
      expect(() =>
        core.mergeRecruitingReassessment?.(role, previous, { ...reassess, ...change }),
      ).toThrow(core.RecruitingAssessmentValidationError);
    expect(() =>
      core.mergeRecruitingReassessment?.({ ...role, id: "new-revision" }, previous, reassess),
    ).toThrow(core.RecruitingAssessmentValidationError);
  });

  it("requires explicit classification of added, changed or removed employment facts for every numeric atom", () => {
    const fixture = employmentInput(61);
    const role = {
      ...fixture.role,
      id: "revision",
      roleId: "role",
      criteria: [
        ...fixture.role.criteria,
        criterion("second-numeric", {
          kind: "atom",
          id: "second-experience",
          statement: "Another numeric definition",
          employmentRule: fixedRule(17),
        }),
      ],
    };
    const input = {
      ...fixture.input,
      employmentEvaluations: [
        ...fixture.input.employmentEvaluations,
        { ...fixture.input.employmentEvaluations[0]!, atomId: "second-experience" },
      ],
    };
    const previous = savedAssessment(role, input);
    const reassess = {
      ...input,
      expectedRevision: 1,
      atomJudgments: [],
      employmentEvaluations: [],
    };
    const untouched = core.mergeRecruitingReassessment?.(role, previous, reassess);
    expect(untouched?.employmentEvaluations[0]?.intervals).toEqual(
      previous.judgments.employment[0]?.intervals,
    );
    for (const facts of [
      [...input.facts, employmentFact("job3", 2025, 2025)],
      input.facts.map((fact) =>
        fact.id === "job1" ? { ...fact, statement: "Changed job dates or work" } : fact,
      ),
      input.facts.filter((fact) => fact.id !== "job1"),
    ])
      expect(() =>
        core.mergeRecruitingReassessment?.(role, previous, {
          ...reassess,
          facts,
          employmentEvaluations: [input.employmentEvaluations[0]!],
        }),
      ).toThrow(core.RecruitingAssessmentValidationError);
    expect(() =>
      core.mergeRecruitingReassessment(role, previous, {
        ...reassess,
        facts: [...input.facts, employmentFact("job3", 2018, 2018)],
        employmentEvaluations: input.employmentEvaluations,
      }),
    ).toThrow("Every employment fact requires an explicit eligibility judgment");
    const newJob = employmentFact("job3", 2018, 2018);
    const merged = core.mergeRecruitingReassessment?.(role, previous, {
      ...reassess,
      facts: [...input.facts, newJob],
      employmentEvaluations: input.employmentEvaluations.map((evaluation) => ({
        ...evaluation,
        intervals: [
          ...evaluation.intervals,
          { factId: newJob.id, qualifyingFullTime: "met", evidence: ["original"], missing: [] },
        ],
      })),
    });
    expect(
      merged &&
        core
          .evaluateRecruitingAssessment(role, merged, assessmentDay)
          .employment.map((judgment) => judgment.lowerMonths),
    ).toEqual([72, 72]);
  });
});
