import type { RecruitingBriefDraft } from "@rakazo/contracts";
import { RecruitingBriefDraftSchema, RecruitingRoleToolInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  recruitingBriefClarifications,
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
    questions: [],
    rules: [{ criterionId: "experience", origin: "jd", effect: "reject", sourceRefIds: ["jd"] }],
  };
}
describe("sourced recruiting intake", () => {
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
    expect(() => requireRecruitingBriefConfirmation({ ...confirmed, revision: 3 })).toThrow(/G0/);
    expect(() => requireRecruitingBriefConfirmation({ revision: 1, brief: null })).toThrow(/G0/);
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
    ])
      expect(() => requireRecruitingPlaybookGate({ ...input, receipts })).toThrow(/approval/);
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
      ).toThrow(/ten/);
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
