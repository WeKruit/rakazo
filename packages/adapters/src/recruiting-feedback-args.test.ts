import { RecruitingFeedbackInputSchema } from "@rakazo/contracts";
import { IsolationError, RecruitingIntentQuoteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { feedbackSaveRefused, filledRecruitingFeedbackArgs } from "./executor.js";
import { recruitingFeedbackInputError } from "./recruiting-feedback.js";

const people = [
  { candidateKey: "linkedin:/in/jane-doe-1a2b", name: "Jane Doe" },
  { candidateKey: "linkedin:/in/sam-lee-77", name: "Sam Lee" },
];

function prisma() {
  const saved = new Set(people.map((person) => person.candidateKey));
  return {
    recruitingRole: { findUnique: vi.fn(async () => ({ revision: 4 })) },
    recruitingCalibrationRound: {
      findFirst: vi.fn(async () => ({ candidateKeys: people.map((p) => p.candidateKey) })),
    },
    recruitingCandidate: {
      findMany: vi.fn(async (args: { where: { candidateKey?: { in?: string[] } } }) =>
        (args.where.candidateKey?.in ?? [])
          .filter((key) => saved.has(key))
          .map((candidateKey) => ({ candidateKey })),
      ),
    },
    recruitingCandidateOccurrence: { findMany: vi.fn(async () => people) },
  } as unknown as Parameters<typeof filledRecruitingFeedbackArgs>[0];
}

const intent = { basis: "direct", quote: "Jane 和 Sam 不太合适，多找带过 50 人团队的。" };

describe("recruiting_feedback arguments", () => {
  it("fills the role, revision and sources and reads a round review as its direction", async () => {
    const { args, error } = await filledRecruitingFeedbackArgs(prisma(), "role-1", {
      target: "round",
      operation: "review",
      intent,
    });
    expect(error).toBeUndefined();
    expect(args).toEqual({
      target: "round",
      operation: "scope",
      intent,
      roleId: "role-1",
      expectedRoleRevision: 4,
      sourceRefs: [],
      summary: intent.quote,
    });
    expect(RecruitingFeedbackInputSchema.safeParse(args).success).toBe(true);
  });

  it("names people by their full name or profile link", async () => {
    const { args, error } = await filledRecruitingFeedbackArgs(prisma(), "role-1", {
      target: "candidate",
      operation: "review",
      candidateKeys: ["Jane Doe", "https://www.linkedin.com/in/sam-lee-77/"],
      intent,
      summary: "Not a fit",
    });
    expect(error).toBeUndefined();
    expect(args.candidateKeys).toEqual(people.map((person) => person.candidateKey));
  });

  it("saves which way the recruiter went on people, however the call words it", async () => {
    for (const [given, fit] of [
      [{ operation: "review", fit: "Not a fit" }, "not_fit"],
      [{ operation: "rejected" }, "not_fit"],
      [{ operation: "review", fit: "good" }, "good_example"],
    ] as const) {
      const { args, error } = await filledRecruitingFeedbackArgs(prisma(), "role-1", {
        target: "candidate",
        candidateKeys: ["Jane Doe"],
        intent,
        ...given,
      });
      expect(error).toBeUndefined();
      expect(args).toMatchObject({ operation: "review", fit });
      expect(RecruitingFeedbackInputSchema.safeParse(args).success).toBe(true);
    }
    expect(
      RecruitingFeedbackInputSchema.safeParse({
        target: "candidate",
        operation: "pass",
        fit: "not_fit",
        roleId: "role-1",
        expectedRoleRevision: 4,
        candidateKeys: [people[0]!.candidateKey],
        candidateRevisions: [{ candidateKey: people[0]!.candidateKey, expectedRevision: 0 }],
        summary: "x",
        intent,
        sourceRefs: [],
      }).success,
    ).toBe(false);
  });

  it("lists the round's people when a name matches no one or none is given", async () => {
    for (const candidateKeys of [["Pat Kim"], undefined]) {
      const { error } = await filledRecruitingFeedbackArgs(prisma(), "role-1", {
        target: "candidate",
        operation: "review",
        intent,
        ...(candidateKeys ? { candidateKeys } : {}),
      });
      expect(error).toMatch(/^Not recorded: nothing was saved, so never tell the recruiter/);
      expect(error).toContain("Jane Doe = linkedin:/in/jane-doe-1a2b");
      expect(error).toContain('target "round" with operation "scope"');
      if (candidateKeys) expect(error).toContain('No saved person on this role matches "Pat Kim"');
    }
  });

  it("explains a rejected call in plain words", () => {
    const parsed = RecruitingFeedbackInputSchema.safeParse({
      target: "round",
      operation: "approve-ish",
      roleId: "role-1",
      expectedRoleRevision: 1,
      summary: "x",
      intent,
      sourceRefs: [],
    });
    expect(parsed.success).toBe(false);
    const text = recruitingFeedbackInputError(parsed.error!);
    expect(text).toMatch(/^Not recorded: nothing was saved/);
    expect(text).toContain("operation:");
    expect(text).toContain('"round" with operation "scope"');
    expect(text).not.toContain('"code"');
  });
});

describe("feedbackSaveRefused", () => {
  it("passes on which words to quote, so a refused save can be fixed instead of retried blindly", () => {
    const text = feedbackSaveRefused(
      new RecruitingIntentQuoteError("Jane Doe 很好。Sam Lee 不合适。"),
    );
    expect(text).toMatch(/^Not recorded/);
    expect(text).toContain("Jane Doe 很好。Sam Lee 不合适。");
    expect(text).toContain("carry on with the rest of the recruiter's request");
    expect(text).not.toContain("Never run people searches");
  });

  it("names every field to check when the refusal gives no reason", () => {
    const text = feedbackSaveRefused(new IsolationError());
    expect(text).toContain("sourceRefs");
    expect(text).not.toContain("Resource not found");
  });
});
