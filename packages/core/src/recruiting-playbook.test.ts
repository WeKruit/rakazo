import type { RecruitingBriefDraft } from "@rakazo/contracts";
import {
  RecruitingBriefDraftSchema,
  RecruitingRoleToolInputSchema,
  RecruitingSourceRefSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyTurnEnd,
  laterPlaybookStage,
  nextPlaybookStep,
  recruitingBriefClarifications,
  recruitingCalibrationIdentity,
  recruitingDiscoveryAnswer,
  recruitingOutboundDisposition,
  requireRecruitingBriefConfirmation,
  requireRecruitingPlaybookGate,
  validateRecruitingBrief,
} from "./recruiting-playbook.js";

// Synthetic English material; deliberately not the original production JD.
const completeJd =
  "Example Labs seeks a backend engineer with 5+ years of production experience. Remote within the UK. Salary: GBP 90,000 to 120,000. Distributed systems are preferred.";
const source = {
  id: "jd",
  kind: "original_material" as const,
  anchor: { kind: "message" as const, messageId: "jd-message", locator: "blocks[0].text" },
  readState: "read" as const,
  readAt: "2026-10-16T18:00:00Z",
  quote: completeJd,
};
const criteria = [
  {
    id: "experience",
    priority: "hard" as const,
    expression: {
      kind: "atom" as const,
      id: "years",
      statement: "5+ years of production experience",
    },
    sourceRefs: [source],
    definitionQuestions: [],
  },
];
const role = { criteria, sourceRefs: [source] };
function brief(): RecruitingBriefDraft {
  return {
    fields: [
      {
        key: "salary_range",
        value: "GBP 90,000 to 120,000",
        origin: "jd",
        state: "known",
        consequential: true,
        sourceRefIds: ["jd"],
      },
      {
        key: "location",
        value: "Remote within the UK",
        origin: "jd",
        state: "known",
        consequential: true,
        sourceRefIds: ["jd"],
      },
    ],
    searchFilters: [],
    questions: [],
    rules: [{ criterionId: "experience", origin: "jd", effect: "reject", sourceRefIds: ["jd"] }],
  };
}
describe("sourced recruiting intake", () => {
  it("reuses an identical full reference and identifies conflicting source IDs across the definition", () => {
    const copied = RecruitingSourceRefSchema.parse(
      Object.fromEntries(Object.entries(source).reverse()),
    );
    const reused = { ...role, criteria: [{ ...criteria[0]!, sourceRefs: [copied] }] };
    expect(() => validateRecruitingBrief(brief(), reused)).not.toThrow();
    for (const [location, definition] of [
      [
        "sourceRefs[1]",
        { ...role, sourceRefs: [source, { ...copied, quote: "Remote within the UK." }] },
      ],
      [
        "criteria[0].sourceRefs[0]",
        {
          ...role,
          criteria: [
            { ...criteria[0]!, sourceRefs: [{ ...copied, quote: "Remote within the UK." }] },
          ],
        },
      ],
    ] as const) {
      expect(() => validateRecruitingBrief(brief(), definition)).toThrow(
        `${location}: source ID "jd" already identifies a different reference. Reuse the full unchanged reference, or use a distinct source ID for a different quote and update its sourceRefIds.`,
      );
    }
    expect(reused.criteria[0]!.sourceRefs[0]).toEqual(source);
  });
  it("identifies a known human field without its actual source and accepts the cited reference", () => {
    const draft = brief();
    draft.fields[0] = { ...draft.fields[0]!, origin: "user_instruction", sourceRefIds: [] };
    expect(() => validateRecruitingBrief(draft, role)).toThrow(
      "brief.fields[0].sourceRefIds: add at least one source ID. Cite a full read source reference with an exact quote; user_instruction must cite the actual human-message reference.",
    );
    const answer = {
      ...source,
      id: "salary-answer",
      anchor: { ...source.anchor, messageId: "human-answer" },
      quote: "Use GBP 90,000 to 120,000.",
    };
    draft.fields[0]!.sourceRefIds = [answer.id];
    expect(() =>
      validateRecruitingBrief(draft, { ...role, sourceRefs: [source, answer] }),
    ).not.toThrow();
  });
  it("identifies the criterion missing a brief rule without creating one", () => {
    const draft = brief();
    draft.rules = [];
    expect(() => validateRecruitingBrief(draft, role)).toThrow(
      'brief.rules: missing criterionId "experience". Add its rule with origin, effect and sourceRefIds; every criterion needs a corresponding rule.',
    );
    expect(draft.rules).toEqual([]);
    draft.rules = brief().rules;
    expect(() => validateRecruitingBrief(draft, role)).not.toThrow();
  });
  it("requires material location clarification even when the extractor omitted the field", () => {
    const draft = brief();
    draft.fields = draft.fields.filter((field) => field.key !== "location");
    expect(recruitingBriefClarifications(draft).map((question) => question.fieldKey)).toEqual([
      "location",
    ]);
  });
  // 2026-10-26: a known "locations" field kept the brief from ever being confirmable.
  it("accepts a known location field under another location key", () => {
    const draft = brief();
    draft.fields = draft.fields.map((field) =>
      field.key === "location" ? { ...field, key: "locations" } : field,
    );
    expect(recruitingBriefClarifications(draft)).toEqual([]);
  });
  it("phrases missing known brief fields without exposing internal keys", () => {
    const draft = brief();
    draft.fields[0] = { ...draft.fields[0]!, state: "missing", value: null };
    draft.fields.push(
      { ...draft.fields[0]!, key: "company_deck", consequential: true },
      { ...draft.fields[0]!, key: "private_internal_field", consequential: true },
    );
    expect(recruitingBriefClarifications(draft)).toEqual([
      { fieldKey: "salary_range", question: "What salary range may be stated in outreach?" },
      { fieldKey: "company_deck", question: "Is a company deck available?" },
      {
        fieldKey: "private_internal_field",
        question: "Please clarify the unresolved role detail.",
      },
    ]);
    draft.questions.push({
      id: "deck-question",
      fieldKey: "company_deck",
      question: "Should we use the saved company presentation?",
      answeredBySourceRefId: null,
    });
    expect(recruitingBriefClarifications(draft)[1]!.question).toBe(draft.questions[0]!.question);
  });
  it("accepts sourced unrestricted location without inventing a retrieval restriction", () => {
    const draft = brief();
    draft.fields[1]!.value = "Unrestricted";
    expect(recruitingBriefClarifications(draft)).toEqual([]);
  });
  it("keeps sourced retrieval filters separate from qualification and rejects invented or hard inferred filters", () => {
    const draft = brief();
    const originalCriteria = structuredClone(role.criteria);
    const filter = {
      id: "region",
      statement: "Search the UK",
      mode: "include" as const,
      origin: "jd" as const,
      sourceRefIds: ["jd"],
    };
    draft.searchFilters = [filter];
    expect(() => validateRecruitingBrief(draft, role)).not.toThrow();
    expect(role.criteria).toEqual(originalCriteria);
    for (const filters of [
      [filter, filter],
      [{ ...filter, sourceRefIds: [] }],
      [{ ...filter, sourceRefIds: ["invented"] }],
      [{ ...filter, origin: "inferred" as const }],
      [{ ...filter, origin: "inferred" as const, mode: "exclude" as const }],
    ])
      expect(() => validateRecruitingBrief({ ...draft, searchFilters: filters }, role)).toThrow();
    expect(() =>
      validateRecruitingBrief(
        {
          ...draft,
          searchFilters: [{ ...filter, mode: "prefer", origin: "inferred", sourceRefIds: [] }],
        },
        role,
      ),
    ).not.toThrow();
    expect(() =>
      validateRecruitingBrief(
        {
          ...draft,
          searchFilters: [
            { ...filter, mode: "prefer", origin: "inferred", sourceRefIds: ["invented"] },
          ],
        },
        role,
      ),
    ).toThrow(/source/);
  });
  it("accepts a complete English JD without mandatory or redundant questions", () => {
    const draft = brief();
    expect(() => validateRecruitingBrief(draft, role)).not.toThrow();
    expect(recruitingBriefClarifications(draft)).toEqual([]);
    expect(completeJd).not.toContain("seven");
  });
  it("asks only material missing questions for a vague English JD", () => {
    const vagueJd = "We need a great engineer. Work setup and compensation are undecided.";
    expect(vagueJd).toContain("undecided");
    const draft = brief();
    draft.fields = draft.fields.map((field) => ({ ...field, state: "missing", value: null }));
    draft.fields.push({
      key: "company_deck",
      value: null,
      state: "missing",
      origin: "jd",
      consequential: false,
      sourceRefIds: [],
    });
    expect(recruitingBriefClarifications(draft).map((question) => question.fieldKey)).toEqual([
      "salary_range",
      "location",
    ]);
  });
  it("keeps a consequential JD/user conflict open until the sourced answer resolves it", () => {
    const conflictJd = "This role is based in London five days a week.";
    const humanAnswer = "Use remote within the UK instead of the office requirement.";
    expect(conflictJd).not.toBe(humanAnswer);
    const draft = brief();
    draft.fields[1] = { ...draft.fields[1]!, state: "conflict", value: null };
    draft.questions = [
      {
        id: "location-conflict",
        fieldKey: "location",
        question: "Should the office requirement or the remote instruction apply?",
        answeredBySourceRefId: null,
      },
    ];
    expect(recruitingBriefClarifications(draft)).toHaveLength(1);
    const answer = { ...source, id: "answer", quote: humanAnswer };
    draft.fields[1] = {
      ...draft.fields[1]!,
      state: "known",
      value: "Remote within the UK",
      origin: "user_instruction",
      sourceRefIds: ["answer"],
    };
    draft.questions[0]!.answeredBySourceRefId = "answer";
    validateRecruitingBrief(draft, { ...role, sourceRefs: [source, answer] });
    expect(recruitingBriefClarifications(draft)).toEqual([]);
  });
  it("retains answered-question provenance without asking the same question again", () => {
    const draft = brief();
    draft.questions = [
      {
        id: "salary",
        fieldKey: "salary_range",
        question: "What range may we state?",
        answeredBySourceRefId: "jd",
      },
    ];
    validateRecruitingBrief(draft, role);
    expect(recruitingBriefClarifications(draft)).toEqual([]);
  });
  it("rejects invented provenance, unconfirmed inferred hard rules and flag-only rejection", () => {
    const draft = brief();
    draft.fields[0]!.sourceRefIds = ["invented"];
    expect(() => validateRecruitingBrief(draft, role)).toThrow(/source/);
    for (const rule of [
      { ...brief().rules[0]!, origin: "inferred" as const },
      { ...brief().rules[0]!, effect: "flag" as const },
    ])
      expect(() => validateRecruitingBrief({ ...brief(), rules: [rule] }, role)).toThrow(
        /cannot reject|flag-only/,
      );
    expect(() =>
      validateRecruitingBrief(
        { ...brief(), rules: [{ ...brief().rules[0]!, origin: "inferred", effect: "flag" }] },
        { ...role, criteria: [{ ...criteria[0]!, priority: "preferred" }] },
      ),
    ).not.toThrow();
  });
  it("requires explicit current-version confirmation and invalidates it on revision", () => {
    const confirmed = {
      revision: 2,
      brief: {
        ...brief(),
        confirmation: {
          revision: 2,
          userId: "human",
          messageId: "confirmation",
          confirmedAt: "2026-10-16T18:00:00Z",
        },
      },
    };
    expect(() => requireRecruitingBriefConfirmation(confirmed)).not.toThrow();
    expect(() => requireRecruitingBriefConfirmation({ ...confirmed, revision: 3 })).toThrow(
      "Confirm the current recruiting brief before continuing.",
    );
    expect(() => requireRecruitingBriefConfirmation({ revision: 1, brief: null })).toThrow(
      "Confirm the current recruiting brief before continuing.",
    );
    expect(RecruitingBriefDraftSchema.safeParse(confirmed.brief).success).toBe(false);
    expect(
      RecruitingRoleToolInputSchema.safeParse({
        operation: "confirm",
        roleId: "role",
        expectedRevision: 2,
      }).success,
    ).toBe(false);
  });
});
const hash = "a".repeat(64);
const gates = ["G0", "G1", "G2", "G3", "G4"] as const;
const profiles = Array.from({ length: 10 }, (_, i) => ({
  candidateKey: `profile-${i}`,
  linkedinUrl: `https://www.linkedin.com/in/example-${i}`,
  evidenceUrl: `https://example.test/evidence/${i}`,
}));
describe("deterministic playbook approval gates", () => {
  it("requires a concrete LinkedIn profile and canonicalizes identity across URL variants", () => {
    expect(recruitingCalibrationIdentity("https://linkedin.com/in/Example/?trk=test")).toBe(
      "/in/example",
    );
    for (const url of [
      "https://linkedin.com/in/",
      "https://linkedin.com/in/%20",
      "https://linkedin.com/in/example/extra",
      "https://linkedin.com/in/a%2Fb",
      "http://linkedin.com/in/example",
      "https://example.com/in/example",
    ])
      expect(recruitingCalibrationIdentity(url)).toBeNull();
  });
  it.each(gates)("requires an exact current receipt for %s", (gate) => {
    const input = {
      actor: { userId: "human", spaceId: "space" },
      gate,
      roleRevisionId: "revision-2",
      payloadHash: hash,
      prerequisiteHashes: { G0: hash, G1: hash, G2: hash },
      calibration: profiles,
      receipts: gates.map((gate) => ({
        gate,
        roleRevisionId: "revision-2",
        payloadHash: hash,
        spaceId: "space",
        approvedByUserId: "human",
        approvedAt: "2026-10-16T18:00:00-07:00",
      })),
    };
    expect(() => requireRecruitingPlaybookGate(input)).not.toThrow();
    for (const receipts of [
      [],
      input.receipts.map((receipt) => ({ ...receipt, roleRevisionId: "old" })),
      input.receipts.filter((receipt) => receipt.gate !== gate),
      input.receipts.map((receipt) => ({ ...receipt, spaceId: "foreign" })),
      input.receipts.map((receipt) => ({ ...receipt, approvedByUserId: "foreign" })),
      input.receipts.map((receipt) => ({ ...receipt, payloadHash: "b".repeat(64) })),
    ]) {
      expect(() => requireRecruitingPlaybookGate({ ...input, receipts })).toThrow(/approval/);
      expect(() => requireRecruitingPlaybookGate({ ...input, receipts })).not.toThrow(/\bG[0-4]\b/);
    }
  });
  it("rejects nine, eleven, duplicated or unevidenced calibration profiles", () => {
    const receipts = gates.map((gate) => ({
      gate,
      roleRevisionId: "revision",
      payloadHash: hash,
      spaceId: "space",
      approvedByUserId: "human",
      approvedAt: "2026-10-16T18:00:00Z",
    }));
    for (const calibration of [
      profiles.slice(1),
      [...profiles, profiles[0]!],
      profiles.map(() => profiles[0]!),
      profiles.map((profile) => ({
        ...profile,
        linkedinUrl: `${profiles[0]!.linkedinUrl}?trk=${profile.candidateKey}`,
      })),
      profiles.map((profile) => ({ ...profile, evidenceUrl: "" })),
    ])
      expect(() =>
        requireRecruitingPlaybookGate({
          actor: { userId: "human", spaceId: "space" },
          gate: "G2",
          roleRevisionId: "revision",
          payloadHash: hash,
          prerequisiteHashes: { G0: hash, G1: hash },
          receipts,
          calibration,
        }),
      ).toThrow(
        "Candidate review requires exactly ten distinct profiles with supporting evidence.",
      );
  });
  it("blocks suppression, hold/pass and duplicates before the CRM-note exception", () => {
    const base = {
      suppressed: false,
      hold: false,
      pass: false,
      duplicate: false,
      checksComplete: true,
      scheduling: false,
      exactApproval: true,
      crmNote: true,
      approvedPolicy: true,
      allTopicsApproved: true,
      approvedFactsOnly: true,
    };
    for (const flag of ["suppressed", "hold", "pass", "duplicate"] as const)
      expect(recruitingOutboundDisposition({ ...base, [flag]: true })).toMatch(/^blocked_/);
    expect(recruitingOutboundDisposition({ ...base, exactApproval: false, scheduling: true })).toBe(
      "draft",
    );
    expect(recruitingOutboundDisposition({ ...base, checksComplete: false })).toBe("draft");
  });
  it("never fabricates LinkedIn provenance for an actual different or unknown source", () => {
    expect(
      recruitingDiscoveryAnswer({ label: "a public research paper", verified: true }),
    ).not.toContain("LinkedIn");
    expect(recruitingDiscoveryAnswer(null)).toBeNull();
  });
});

it("does not let a model mark a location conflict inconsequential or invent inferred provenance", () => {
  const draft = brief();
  draft.fields[1] = { ...draft.fields[1]!, state: "conflict", consequential: false };
  expect(recruitingBriefClarifications(draft).map((question) => question.fieldKey)).toEqual([
    "location",
  ]);
  draft.rules[0] = {
    ...draft.rules[0]!,
    origin: "inferred",
    effect: "flag",
    sourceRefIds: ["invented"],
  };
  expect(() =>
    validateRecruitingBrief(draft, {
      ...role,
      criteria: [{ ...criteria[0]!, priority: "preferred" }],
    }),
  ).toThrow(/source/);
});

describe("playbook stage machine", () => {
  it("never regresses a stage", () => {
    expect(laterPlaybookStage("feedback", "calibration_10")).toBe("feedback");
    expect(laterPlaybookStage("intake", "calibration_10")).toBe("calibration_10");
  });

  it("pushes open clarifications before anything else", () => {
    const step = nextPlaybookStep("intake", {
      title: "后端",
      hasBrief: true,
      openClarifications: 2,
      savedCandidates: 0,
    });
    expect(step?.label).toBe("还有 2 个待确认问题");
  });

  it("starts calibration once title and brief exist", () => {
    expect(
      nextPlaybookStep("intake", { title: "后端", hasBrief: true, savedCandidates: 0 })?.label,
    ).toBe("开始校准搜寻");
    expect(
      nextPlaybookStep("intake", { title: "后端", hasBrief: false, savedCandidates: 0 })?.label,
    ).toBe("完成岗位信息");
  });

  it("counts remaining calibration profiles and stops at human-owned stages", () => {
    expect(
      nextPlaybookStep("calibration_10", { title: "x", hasBrief: true, savedCandidates: 4 })?.label,
    ).toBe("校准搜寻（还差 6 人）");
    const present = nextPlaybookStep("calibration_10", {
      title: "x",
      hasBrief: true,
      savedCandidates: 10,
    })?.prompt;
    expect(present).toContain("calibration_round");
    expect(present).toContain("不要求逐人评分");
    expect(present).toContain("Results 校准面板");
    expect(present).toContain("下一步选择");
    expect(nextPlaybookStep("feedback", { hasBrief: true, savedCandidates: 44 })?.prompt).toContain(
      "10 位全新的人",
    );
    const feedback = nextPlaybookStep("feedback", { hasBrief: true, savedCandidates: 44 })?.prompt;
    expect(feedback).toContain("「找 100 个」");
    expect(feedback).toContain("operation approve");
    expect(feedback).toContain("下一步选择");
    expect(nextPlaybookStep("scale", { hasBrief: true, savedCandidates: 20 })?.prompt).toContain(
      "save_search",
    );
    expect(nextPlaybookStep("closed", { hasBrief: true, savedCandidates: 50 })).toBeNull();
    expect(nextPlaybookStep("screening", { hasBrief: true, savedCandidates: 50 })).toBeNull();
  });
});

describe("classifyTurnEnd", () => {
  it("requires saved evidence during calibration even when progress is a list", () => {
    expect(
      classifyTurnEnd(
        { blocks: [{ kind: "text", text: "- Read role\n- Checked sources\n- Saved candidates" }] },
        { savedRows: 9, deliverableRows: 10 },
      ),
    ).toBe("none");
    expect(
      classifyTurnEnd({ blocks: [{ kind: "candidate" }] }, { savedRows: 1, deliverableRows: 10 }),
    ).toBe("none");
    expect(
      classifyTurnEnd({ blocks: [{ kind: "ask", text: "Location", status: "answered" }] }),
    ).toBe("none");
  });
  const text = (t: string) => ({ blocks: [{ kind: "text", text: t }] });
  it("treats a saved-and-stopped status note as none", () => {
    expect(classifyTurnEnd(text("已将公司暂用名保存为 X。尚未启动搜寻。"))).toBe("none");
    expect(classifyTurnEnd({ blocks: [] })).toBe("none");
  });
  it("detects questions, cards, handoffs and deliverables", () => {
    expect(classifyTurnEnd(text("薪资范围是多少？"))).toBe("question");
    expect(classifyTurnEnd({ blocks: [{ kind: "ask", text: "x" }] })).toBe("question");
    expect(classifyTurnEnd({ blocks: [{ kind: "approval", text: "x" }] })).toBe("card");
    expect(classifyTurnEnd(text("ok"), { pendingApproval: true })).toBe("card");
    expect(classifyTurnEnd(text("ok"), { handedOff: true })).toBe("handoff");
    expect(classifyTurnEnd(text("saved"), { savedRows: 10 })).toBe("deliverable");
    expect(classifyTurnEnd(text("saved"), { savedRows: 3, deliverableRows: 10 })).toBe("none");
    expect(classifyTurnEnd({ blocks: [{ kind: "candidate" }] })).toBe("deliverable");
    expect(classifyTurnEnd(text("名单：\n1. 张三\n2. 李四\n3. 王五"))).toBe("deliverable");
  });
});

describe("clarifications before the search", () => {
  it("never asks for a salary the search does not need", () => {
    const brief: RecruitingBriefDraft = {
      searchFilters: [],
      fields: [
        {
          key: "location",
          value: "Chicago, on-site",
          origin: "jd",
          state: "known",
          consequential: true,
          sourceRefIds: ["jd"],
        },
      ],
      questions: [],
      rules: [],
    };
    expect(recruitingBriefClarifications(brief)).toEqual([]);
  });
});
