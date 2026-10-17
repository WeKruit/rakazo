import { createHash } from "node:crypto";
import type {
  Actor,
  RecruitingAssessmentSourceRef,
  RecruitingBrief,
  RecruitingCriterion,
} from "@rakazo/contracts";
import { ReviseRecruitingRoleInput } from "@rakazo/contracts";
import { qualifiedEmploymentMonths, RecruitingPlaybookValidationError } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import type { RecruitingRoleMaterialContext } from "./recruiting.js";
import * as recruiting from "./recruiting.js";
import { confirmRecruitingBrief } from "./recruiting.js";
import { IsolationError } from "./scope.js";

vi.mock("@rakazo/core/node/pdf-text", () => ({ extractPdfText: vi.fn() }));

const actor: Actor = {
  spaceId: "space",
  userId: "human",
  email: "human@example.test",
  isDeploymentOwner: false,
};
function fixture(crmBindingEffectId: string | null = null) {
  const thread = {
    id: "thread",
    spaceId: "space",
    userId: "human",
    botId: "bot",
    activeRecruitingRoleId: "role",
  };
  let role = {
    id: "role",
    spaceId: "space",
    userId: "human",
    sourceThreadId: "thread",
    title: "Example engineer",
    revision: 1,
    currentRevisionId: "revision-1",
    crmBindingEffectId,
  };
  const source = {
    id: "jd",
    kind: "original_material",
    anchor: { kind: "message", messageId: "jd-message", locator: "blocks[0].text" },
    readState: "read",
    readAt: "2026-10-16T18:00:00Z",
    quote: "GBP 90,000 to 120,000. Location unrestricted.",
  };
  const revisions = [
    {
      id: "revision-1",
      roleId: "role",
      revision: 1,
      sourceRefs: [source],
      criteria: [] as RecruitingCriterion[],
      preferences: [],
      definitionQuestions: [],
      createdAt: new Date(0),
      brief: {
        fields: [
          {
            key: "salary_range",
            value: "GBP 90,000 to 120,000",
            state: "known",
            origin: "jd",
            consequential: true,
            sourceRefIds: ["jd"],
          },
          {
            key: "location",
            value: "Unrestricted",
            state: "known",
            origin: "jd",
            consequential: true,
            sourceRefIds: ["jd"],
          },
        ],
        searchFilters: [] as RecruitingBrief["searchFilters"],
        questions: [],
        rules: [] as RecruitingBrief["rules"],
        confirmation: null as RecruitingBrief["confirmation"],
      },
    },
  ];
  const humanMessages = new Map<string, Record<string, unknown>>();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: {
      findFirst: vi.fn(async (_args: { where: { id: string } }) => thread),
      update: vi.fn(async () => ({ nextMessageSeq: 2 })),
    },
    bot: { findFirst: vi.fn(async () => actor) },
    message: {
      findUnique: vi.fn(
        async ({ where }) =>
          humanMessages.get(where.id) ?? {
            id: "jd-message",
            role: "user",
            botId: null,
            externalTranscriptFor: null,
            blocks: [{ kind: "text", text: "GBP 90,000 to 120,000. Location unrestricted." }],
          },
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => humanMessages.get(id) ?? { id, threadId: "thread" }),
      ),
      create: vi.fn(async ({ data }) => {
        const message = {
          id: humanMessages.size
            ? `human-confirmation-${humanMessages.size + 1}`
            : "human-confirmation",
          externalTranscriptFor: null,
          ...data,
          botId: data.botId ?? null,
        };
        humanMessages.set(message.id, message);
        return message;
      }),
    },
    recruitingRole: {
      findFirst: vi.fn(async () => role),
      updateMany: vi.fn(async ({ data }) => {
        role = { ...role, ...data };
        return { count: 1 };
      }),
    },
    recruitingRoleRevision: {
      findFirst: vi.fn(async ({ where }) =>
        revisions.find((revision) =>
          where.id
            ? revision.id === where.id
            : revision.roleId === where.roleId && revision.revision === where.revision,
        ),
      ),
      create: vi.fn(async ({ data }) => {
        const revision = { id: `revision-${data.revision}`, createdAt: new Date(), ...data };
        revisions.push(revision);
        return revision;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, thread, revisions };
}

function criteriaFixture(crmBindingEffectId: string | null = null) {
  const f = fixture(crmBindingEffectId);
  const original = f.revisions[0]!;
  original.criteria = [
    {
      id: "skills",
      priority: "hard",
      sourceRefs: original.sourceRefs as RecruitingCriterion["sourceRefs"],
      definitionQuestions: ["Keep this unresolved question"],
      expression: {
        kind: "all",
        items: [
          { kind: "atom", id: "code", statement: "Implemented geometry" },
          {
            kind: "any",
            items: [
              { kind: "atom", id: "web", statement: "Built a web app" },
              { kind: "not", item: { kind: "atom", id: "ui", statement: "Only configured a UI" } },
            ],
          },
        ],
      },
    },
    {
      id: "location",
      priority: "preferred",
      sourceRefs: original.sourceRefs as RecruitingCriterion["sourceRefs"],
      definitionQuestions: [],
      expression: { kind: "atom", id: "onsite", statement: "Works onsite" },
    },
  ];
  original.brief.rules = original.criteria.map((criterion) => ({
    criterionId: criterion.id,
    origin: "jd",
    effect: criterion.priority === "hard" ? "reject" : "flag",
    sourceRefIds: ["jd"],
  }));
  original.brief.confirmation = {
    revision: 1,
    userId: actor.userId,
    messageId: "confirmation",
    confirmedAt: new Date(0).toISOString(),
  };
  const input = {
    threadId: "thread",
    roleId: "role",
    expectedRevision: 1,
    criteria: [
      {
        criterionId: "skills",
        priority: "preferred" as const,
        atoms: [
          { atomId: "code", statement: "Personally implemented 3D geometry" },
          { atomId: "web", statement: "Built a web app" },
          { atomId: "ui", statement: "Only configured a UI" },
        ],
      },
    ],
  };
  return { ...f, input };
}

describe("native human criterion editing", () => {
  it("allows a filter-only human revision when qualification has no criteria", async () => {
    const f = fixture();
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
      criteria: [],
      searchFilters: [{ id: "titles", statement: "Prefer backend titles", mode: "prefer" }],
    });
    expect(saved.revision.criteria).toEqual([]);
    expect(saved.revision.brief?.searchFilters).toMatchObject([
      { id: "titles", mode: "prefer", origin: "user_instruction" },
    ]);
    expect(saved.role.revision).toBe(2);
  });
  it("saves filter-only add/edit/remove through the existing native human revision while preserving qualification", async () => {
    const f = criteriaFixture();
    f.input.criteria[0]!.priority = "hard" as never;
    f.input.criteria[0]!.atoms[0]!.statement = "Implemented geometry";
    const original = structuredClone(f.revisions[0]!);
    original.brief.searchFilters = [
      {
        id: "existing",
        statement: "Prefer backend titles",
        mode: "prefer",
        origin: "jd",
        sourceRefIds: ["jd"],
      },
    ];
    f.revisions[0]!.brief.searchFilters = original.brief.searchFilters;
    const searchFilters = [
      { id: "existing", statement: "Prefer backend titles", mode: "prefer" },
      { id: "region", statement: "Search the UK", mode: "include" },
    ];
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      searchFilters,
    });
    expect(saved.role.revision).toBe(2);
    expect(saved.revision.criteria).toEqual(original.criteria);
    expect(saved.revision.brief?.confirmation).toBeNull();
    expect(saved.revision.brief?.searchFilters[0]).toEqual(original.brief.searchFilters[0]);
    const human = saved.revision.sourceRefs.at(-1)!;
    expect(saved.revision.brief?.searchFilters[1]).toEqual({
      ...searchFilters[1],
      origin: "user_instruction",
      sourceRefIds: [human.id],
    });
    expect(human.quote).toContain('"statement":"Search the UK"');
    expect(f.revisions[0]).toEqual(original);
    const changedFilters = [
      { ...searchFilters[0]!, statement: "Search senior backend titles", mode: "include" },
      searchFilters[1]!,
    ];
    const changed = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      expectedRevision: 2,
      searchFilters: changedFilters,
    });
    const changedSource = changed.revision.sourceRefs.at(-1)!;
    expect(changed.revision.brief?.searchFilters[0]).toEqual({
      ...changedFilters[0],
      origin: "user_instruction",
      sourceRefIds: [changedSource.id],
    });
    expect(changed.revision.brief?.searchFilters[1]).toEqual(
      saved.revision.brief?.searchFilters[1],
    );
    expect(changed.revision.criteria).toEqual(original.criteria);
    const removed = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      expectedRevision: 3,
      searchFilters: [],
    });
    expect(removed.role.revision).toBe(4);
    expect(removed.revision.brief?.searchFilters).toEqual([]);
    expect(removed.revision.criteria).toEqual(original.criteria);
  });
  it("preserves filter provenance on criteria-only edits and avoids a revision for unchanged filters", async () => {
    const f = criteriaFixture();
    const filters: RecruitingBrief["searchFilters"] = [
      {
        id: "region",
        statement: "Search the UK",
        mode: "include",
        origin: "jd",
        sourceRefIds: ["jd"],
      },
    ];
    f.revisions[0]!.brief.searchFilters = filters;
    const edited = await recruiting.editRecruitingCriteria(f.prisma, actor, f.input);
    expect(edited.revision.brief?.searchFilters).toEqual(filters);
    const unchanged = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      expectedRevision: 2,
      searchFilters: filters.map(({ origin: _origin, sourceRefIds: _refs, ...filter }) => filter),
    });
    expect(unchanged.role.revision).toBe(2);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
  });
  it("rejects stale filter edits without changing the saved filters", async () => {
    const f = criteriaFixture();
    const original = structuredClone(f.revisions[0]);
    await expect(
      recruiting.editRecruitingCriteria(f.prisma, actor, {
        ...f.input,
        expectedRevision: 99,
        searchFilters: [],
      }),
    ).rejects.toThrow();
    expect(f.revisions[0]).toEqual(original);
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });
  it("preserves the expression, immutable original and other fields while sourcing exact meaningful edits to one human message", async () => {
    const f = criteriaFixture();
    const original = structuredClone(f.revisions[0]!);
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, f.input);
    expect(saved.role.revision).toBe(2);
    expect(f.revisions[0]).toEqual(original);
    expect(saved.revision.criteria[1]).toEqual(original.criteria[1]);
    expect(saved.revision.criteria[0]!.expression).toEqual({
      ...original.criteria[0]!.expression,
      items: [
        { kind: "atom", id: "code", statement: "Personally implemented 3D geometry" },
        (original.criteria[0]!.expression as { kind: "all"; items: unknown[] }).items[1],
      ],
    });
    const human = saved.revision.sourceRefs.at(-1)!;
    expect(human).toMatchObject({
      kind: "recruiter_verified",
      anchor: { kind: "message", messageId: "human-confirmation", locator: "blocks[0].text" },
      readState: "read",
    });
    expect(saved.revision.sourceRefs.slice(0, -1)).toEqual(original.sourceRefs);
    expect(saved.revision.criteria[0]!.sourceRefs).toEqual([
      ...original.criteria[0]!.sourceRefs,
      human,
    ]);
    const message = f.tx.message.create.mock.calls[0]![0].data;
    expect(message).toMatchObject({ threadId: "thread", role: "user" });
    expect(message.botId).toBeUndefined();
    expect(message.runId).toBeUndefined();
    expect(message.blocks).toEqual([{ kind: "text", text: human.quote }]);
    expect(human.quote).toContain('"statement":"Personally implemented 3D geometry"');
    expect(human.quote).toContain('"priority":"preferred"');
    expect(human.quote).not.toContain("Built a web app");
    expect(saved.revision.brief?.rules[0]).toEqual({
      criterionId: "skills",
      origin: "user_instruction",
      effect: "flag",
      sourceRefIds: [human.id],
    });
    expect(saved.revision.brief?.rules[1]).toEqual(original.brief.rules[1]);
    expect(saved.revision.brief?.confirmation).toBeNull();
    expect(saved.revision.brief?.fields).toEqual(original.brief.fields);
    expect(saved.revision.brief?.questions).toEqual(original.brief.questions);
    expect(saved.revision.criteria[0]!.definitionQuestions).toEqual(
      original.criteria[0]!.definitionQuestions,
    );
    expect(saved.revision.preferences).toEqual(original.preferences);
    expect(saved.revision.definitionQuestions).toEqual(original.definitionQuestions);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
  });

  it.each([null, "binding-effect"])(
    "returns a public unchanged snapshot for a true no-op with CRM binding %s without writes",
    async (crmBindingEffectId) => {
      const f = criteriaFixture(crmBindingEffectId);
      f.input.criteria[0]!.priority = "hard" as never;
      f.input.criteria[0]!.atoms[0]!.statement = "Implemented geometry";
      f.input.criteria[0]!.atoms.reverse();
      const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, f.input);
      expect(saved.role.revision).toBe(1);
      expect(saved.role).not.toHaveProperty("crmBindingEffectId");
      expect(saved.revision.brief?.confirmation?.revision).toBe(1);
      expect(f.tx.message.create).not.toHaveBeenCalled();
      expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
      expect(f.tx.recruitingRole.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    "unknown-criterion",
    "unknown-atom",
    "missing-atom",
    "extra-atom",
    "duplicate-criterion",
    "duplicate-atom",
    "blank",
    "priority",
  ])("rejects %s before any writes", async (mode) => {
    const f = criteriaFixture();
    const edit = f.input.criteria[0]!;
    if (mode === "unknown-criterion") edit.criterionId = "unknown";
    if (mode === "unknown-atom") edit.atoms[0]!.atomId = "unknown";
    if (mode === "missing-atom") edit.atoms.pop();
    if (mode === "extra-atom") edit.atoms.push({ atomId: "extra", statement: "Extra" });
    if (mode === "duplicate-criterion") f.input.criteria.push(edit);
    if (mode === "duplicate-atom") edit.atoms[1]!.atomId = edit.atoms[0]!.atomId;
    if (mode === "blank") edit.atoms[0]!.statement = "   ";
    if (mode === "priority") edit.priority = "optional" as never;
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it.each([
    "foreign-owner",
    "foreign-space",
    "unbound",
    "stale",
    "raced-revision",
    "raced-binding",
  ])("rejects %s without a human message", async (mode) => {
    const f = criteriaFixture();
    if (mode === "foreign-owner") f.thread.userId = "foreign";
    if (mode === "foreign-space") f.thread.spaceId = "foreign";
    if (mode === "unbound") f.thread.activeRecruitingRoleId = "foreign";
    if (mode === "stale") f.input.expectedRevision = 2;
    if (mode === "raced-revision") {
      const role = await f.tx.recruitingRole.findFirst();
      f.tx.recruitingRole.findFirst
        .mockResolvedValueOnce(role)
        .mockResolvedValue({ ...role, revision: 2 });
    }
    if (mode === "raced-binding")
      f.tx.thread.findFirst
        .mockImplementationOnce(async () => f.thread)
        .mockImplementationOnce(async () => f.thread)
        .mockImplementationOnce(async () => f.thread)
        .mockImplementation(async () => ({ ...f.thread, activeRecruitingRoleId: "foreign" }));
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });

  it("rechecks original source quotes rather than trusting the retained snapshot", async () => {
    const f = criteriaFixture();
    f.tx.message.findUnique.mockResolvedValue({
      id: "jd-message",
      role: "user",
      botId: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: "Changed original source" }],
    });
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow(
      /quote/,
    );
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it("preserves unchanged typed rules and repeated references during a priority edit", async () => {
    const f = criteriaFixture();
    const employmentRule = {
      minimumMonths: 60,
      countingRule: "complete_calendar_months" as const,
      qualificationDefinition: "Full-time geometry engineering",
      cutoff: { kind: "assessment_date" as const },
    };
    const leaf = {
      kind: "atom" as const,
      id: "code",
      statement: "Implemented geometry",
      employmentRule,
    };
    f.revisions[0]!.criteria[0] = {
      ...f.revisions[0]!.criteria[0]!,
      expression: { kind: "any", items: [leaf, { kind: "not", item: leaf }] },
    };
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      criteria: [{ ...f.input.criteria[0]!, atoms: [{ atomId: "code", employmentRule }] }],
    });
    expect(saved.revision.criteria[0]!.expression).toEqual({
      kind: "any",
      items: [leaf, { kind: "not", item: leaf }],
    });
    expect(f.revisions[0]!.criteria[0]!.expression).toEqual({
      kind: "any",
      items: [leaf, { kind: "not", item: leaf }],
    });
  });

  it("rejects a text-only five-to-seven-year edit that would leave the evaluator at 60 months", async () => {
    const f = criteriaFixture();
    f.revisions[0]!.criteria[0] = {
      ...f.revisions[0]!.criteria[0]!,
      expression: {
        kind: "atom",
        id: "code",
        statement: "5+ years",
        employmentRule: {
          minimumMonths: 60,
          countingRule: "complete_calendar_months",
          qualificationDefinition: "Full-time geometry engineering",
          cutoff: { kind: "assessment_date" },
        },
      },
    };
    f.input.criteria[0]!.atoms = [{ atomId: "code", statement: "7+ years" }];
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow(
      /structured employment rule/,
    );
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it("changes the authoritative threshold from 60 to 84 months and records the same coherent rule and description", async () => {
    const f = criteriaFixture();
    const cutoff = { precision: "day" as const, year: 2026, month: 1, day: 1 };
    const employmentRule = {
      minimumMonths: 60,
      countingRule: "complete_calendar_months" as const,
      qualificationDefinition: "Full-time geometry engineering",
      cutoff: { kind: "fixed" as const, date: cutoff },
    };
    const leaf = { kind: "atom" as const, id: "code", statement: "5+ years", employmentRule };
    f.revisions[0]!.criteria[0] = {
      ...f.revisions[0]!.criteria[0]!,
      expression: { kind: "any", items: [leaf, { kind: "not", item: leaf }] },
    };
    const evaluate = (minimumMonths: number) =>
      qualifiedEmploymentMonths({
        ...employmentRule,
        minimumMonths,
        cutoff,
        historyComplete: true,
        intervals: [
          {
            start: { precision: "day", year: 2020, month: 1, day: 1 },
            end: { precision: "day", year: 2025, month: 12, day: 31 },
            qualifyingFullTime: "met",
          },
        ],
      });
    expect(evaluate(60)).toMatchObject({ verdict: "met", lowerMonths: 72 });
    const updatedRule = { ...employmentRule, minimumMonths: 84 };
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      criteria: [
        { ...f.input.criteria[0]!, atoms: [{ atomId: "code", employmentRule: updatedRule }] },
      ],
    });
    const statement =
      "At least 84 complete calendar months of Full-time geometry engineering; cutoff: 2026-01-01 (UTC).";
    const expectedLeaf = { ...leaf, statement, employmentRule: updatedRule };
    expect(saved.revision.criteria[0]!.expression).toEqual({
      kind: "any",
      items: [expectedLeaf, { kind: "not", item: expectedLeaf }],
    });
    const actual = saved.revision.criteria[0]!.expression;
    if (actual.kind !== "any" || actual.items[0]!.kind !== "atom")
      throw new Error("Expected employment atom");
    expect(evaluate(actual.items[0]!.employmentRule!.minimumMonths)).toMatchObject({
      verdict: "unmet",
      upperMonths: 72,
    });
    expect(f.revisions[0]!.criteria[0]!.expression).toEqual({
      kind: "any",
      items: [leaf, { kind: "not", item: leaf }],
    });
    const human = saved.revision.sourceRefs.at(-1)!;
    expect(human.quote).toContain(
      JSON.stringify({ atomId: "code", employmentRule: updatedRule, statement }),
    );
    expect(saved.revision.brief?.fields).toEqual(f.revisions[0]!.brief.fields);
    expect(saved.revision.brief?.confirmation).toBeNull();
  });

  it("rejects adding a typed rule to an existing semantic atom", async () => {
    const f = criteriaFixture();
    const atoms = [
      {
        atomId: "code",
        employmentRule: {
          minimumMonths: 84,
          countingRule: "complete_calendar_months",
          qualificationDefinition: "Full-time engineering",
          cutoff: { kind: "assessment_date" },
        },
      },
      ...f.input.criteria[0]!.atoms.slice(1),
    ];
    await expect(
      recruiting.editRecruitingCriteria(f.prisma, actor, {
        ...f.input,
        criteria: [{ ...f.input.criteria[0]!, atoms }],
      }),
    ).rejects.toThrow(/atom kind/);
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });

  it("treats an unchanged structured rule as a no-op and generates changed qualification and assessment cutoff coherently", async () => {
    const f = criteriaFixture();
    const rule = {
      minimumMonths: 60,
      countingRule: "complete_calendar_months" as const,
      qualificationDefinition: "Full-time geometry implementation",
      cutoff: {
        kind: "fixed" as const,
        date: { precision: "day" as const, year: 2025, month: 12, day: 31 },
      },
    };
    const leaf = {
      kind: "atom" as const,
      id: "code",
      statement: "5+ years of personal geometry implementation",
      employmentRule: rule,
    };
    f.revisions[0]!.criteria[0] = { ...f.revisions[0]!.criteria[0]!, expression: leaf };
    const input = {
      ...f.input,
      criteria: [
        {
          criterionId: "skills",
          priority: "hard" as const,
          atoms: [{ atomId: "code", employmentRule: rule }],
        },
      ],
    };
    const unchanged = await recruiting.editRecruitingCriteria(f.prisma, actor, input);
    expect(unchanged.role.revision).toBe(1);
    expect(unchanged.revision.criteria[0]!.expression).toEqual(leaf);
    expect(f.tx.message.create).not.toHaveBeenCalled();
    const updated = {
      ...rule,
      qualificationDefinition: "Full-time personally implemented geometry",
      cutoff: { kind: "assessment_date" as const },
    };
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...input,
      criteria: [{ ...input.criteria[0], atoms: [{ atomId: "code", employmentRule: updated }] }],
    });
    expect(saved.revision.criteria[0]!.expression).toEqual({
      ...leaf,
      employmentRule: updated,
      statement:
        "At least 60 complete calendar months of Full-time personally implemented geometry; cutoff: assessment date (UTC).",
    });
    expect(saved.revision.sourceRefs.at(-1)!.quote).toContain(JSON.stringify(updated));
  });

  it("requires every criterion sharing a typed atom to adopt the same structured rule", async () => {
    const f = criteriaFixture();
    const rule = {
      minimumMonths: 60,
      countingRule: "complete_calendar_months" as const,
      qualificationDefinition: "Full-time engineering",
      cutoff: { kind: "assessment_date" as const },
    };
    const leaf = { kind: "atom" as const, id: "code", statement: "5+ years", employmentRule: rule };
    f.revisions[0]!.criteria = f.revisions[0]!.criteria.map((criterion) => ({
      ...criterion,
      expression: leaf,
    }));
    const atoms = [{ atomId: "code", employmentRule: { ...rule, minimumMonths: 84 } }];
    const input = {
      ...f.input,
      criteria: [{ criterionId: "skills", priority: "hard" as const, atoms }],
    };
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, input)).rejects.toThrow(
      /one definition/,
    );
    expect(f.tx.message.create).not.toHaveBeenCalled();
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...input,
      criteria: [...input.criteria, { criterionId: "location", priority: "preferred", atoms }],
    });
    expect(saved.revision.criteria[0]!.expression).toEqual(saved.revision.criteria[1]!.expression);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
  });

  it("rejects an inconsistent shared atom definition without silently changing another criterion", async () => {
    const f = criteriaFixture();
    f.revisions[0]!.criteria[1] = {
      ...f.revisions[0]!.criteria[1]!,
      expression: { kind: "atom", id: "code", statement: "Implemented geometry" },
    };
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow(
      /one definition/,
    );
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it("uses a human reject rule for a priority-only promotion", async () => {
    const f = criteriaFixture();
    f.input.criteria = [
      {
        criterionId: "location",
        priority: "hard" as never,
        atoms: [{ atomId: "onsite", statement: "Works onsite" }],
      },
    ];
    const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, f.input);
    expect(saved.revision.brief?.rules[1]).toEqual({
      criterionId: "location",
      origin: "user_instruction",
      effect: "reject",
      sourceRefIds: [saved.revision.sourceRefs.at(-1)!.id],
    });
    expect(saved.revision.sourceRefs.at(-1)!.quote).not.toContain('"atoms"');
  });

  it("rejects a failed final CAS instead of reporting an adopted edit", async () => {
    const f = criteriaFixture();
    f.tx.recruitingRole.updateMany.mockResolvedValue({ count: 0 });
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow(
      recruiting.RecruitingConflictError,
    );
    expect(f.tx.recruitingRole.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "role",
          spaceId: actor.spaceId,
          userId: actor.userId,
          revision: 1,
          currentRevisionId: "revision-1",
        },
      }),
    );
  });
});
describe("native human brief confirmation", () => {
  it.each([null, "binding-effect"])(
    "stores human confirmation once and repeats a public snapshot with CRM binding %s",
    async (crmBindingEffectId) => {
      const f = fixture(crmBindingEffectId);
      const saved = await confirmRecruitingBrief(f.prisma, actor, {
        threadId: "thread",
        roleId: "role",
        expectedRevision: 1,
      });
      expect(saved.revision.revision).toBe(2);
      expect(saved.revision.brief?.confirmation).toMatchObject({
        revision: 2,
        userId: actor.userId,
        messageId: "human-confirmation",
      });
      expect(f.revisions[0]!.brief.confirmation).toBeNull();
      expect(saved.role).not.toHaveProperty("crmBindingEffectId");
      const repeated = await confirmRecruitingBrief(f.prisma, actor, {
        threadId: "thread",
        roleId: "role",
        expectedRevision: 2,
      });
      expect(repeated.role).not.toHaveProperty("crmBindingEffectId");
      expect(repeated).toEqual(saved);
      expect(f.tx.message.create).toHaveBeenCalledOnce();
      expect(f.tx.recruitingRoleRevision.create).toHaveBeenCalledOnce();
      expect(f.tx.recruitingRole.updateMany).toHaveBeenCalledOnce();
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(4);
    },
  );
  it("rejects stale, foreign and unbound requests before writing a human message", async () => {
    for (const mode of ["stale", "foreign", "unbound"]) {
      const f = fixture();
      if (mode === "foreign") f.thread.userId = "someone-else";
      if (mode === "unbound") f.thread.activeRecruitingRoleId = "other-role";
      await expect(
        confirmRecruitingBrief(f.prisma, actor, {
          threadId: "thread",
          roleId: "role",
          expectedRevision: mode === "stale" ? 2 : 1,
        }),
      ).rejects.toThrow();
      expect(f.tx.message.create).not.toHaveBeenCalled();
    }
  });
  it("rejects material conflicts and caller-supplied confirmation metadata", async () => {
    const f = fixture();
    f.revisions[0]!.brief.fields[0]!.state = "conflict";
    await expect(
      confirmRecruitingBrief(f.prisma, actor, {
        threadId: "thread",
        roleId: "role",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/questions/);
    await expect(
      confirmRecruitingBrief(f.prisma, actor, {
        threadId: "thread",
        roleId: "role",
        expectedRevision: 1,
        confirmation: { userId: "invented" },
      }),
    ).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });
});

it("revalidates the original quoted material before recording confirmation", async () => {
  const f = fixture();
  f.tx.message.findUnique.mockResolvedValueOnce({
    id: "jd-message",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "Different source text" }],
  });
  await expect(
    confirmRecruitingBrief(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    }),
  ).rejects.toThrow(/quote/);
  expect(f.tx.message.create).not.toHaveBeenCalled();
});

it("accepts actual native human provenance for a user instruction", async () => {
  const f = fixture();
  f.revisions[0]!.brief.fields[0]!.origin = "user_instruction";
  const native = {
    id: "jd-message",
    threadId: "thread",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "GBP 90,000 to 120,000. Location unrestricted." }],
  };
  f.tx.message.findMany.mockResolvedValue([native]);
  const saved = await confirmRecruitingBrief(f.prisma, actor, {
    threadId: "thread",
    roleId: "role",
    expectedRevision: 1,
  });
  expect(saved.revision.brief?.confirmation?.userId).toBe(actor.userId);
  expect(f.tx.message.create).toHaveBeenCalledOnce();
});

it("explains mixed JD attribution without accepting it as a human instruction", async () => {
  const f = approvalFixture();
  Object.assign(f.tx, { recruitingResearchAction: { findFirst: vi.fn(async () => null) } });
  const original = f.revisions[0]!;
  const artifact = f.artifacts[0]!;
  const { confirmation: _confirmation, ...brief } = original.brief;
  const input = ReviseRecruitingRoleInput.parse({
    roleId: "role",
    expectedRevision: 1,
    title: "Example engineer",
    criteria: original.criteria,
    preferences: original.preferences,
    definitionQuestions: original.definitionQuestions,
    sourceRefs: [
      ...original.sourceRefs,
      {
        id: "jd-document",
        kind: "original_material" as const,
        anchor: {
          kind: "artifact" as const,
          artifact: { artifactId: artifact.id, sha256: artifact.hash },
          locator: "text",
        },
        readState: "read" as const,
        readAt: "2026-10-16T18:00:00Z",
        quote: "Final engineer job description",
      },
    ],
    brief: {
      ...brief,
      fields: brief.fields.map((field, index) =>
        index === 0
          ? { ...field, origin: "user_instruction" as const, sourceRefIds: ["jd", "jd-document"] }
          : field,
      ),
    },
  });
  const rejected = recruiting.reviseRecruitingRole(f.prisma, actor, input, f.material);
  await expect(rejected).rejects.toThrow(RecruitingPlaybookValidationError);
  await expect(rejected).rejects.toThrow(
    "User-instruction facts require human-message sources; keep JD evidence separately attributed.",
  );
  expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();

  artifact.userId = "another-human";
  await expect(recruiting.reviseRecruitingRole(f.prisma, actor, input, f.material)).rejects.toThrow(
    IsolationError,
  );
  artifact.userId = actor.userId;
  const hash = artifact.hash;
  artifact.hash = "0".repeat(64);
  await expect(recruiting.reviseRecruitingRole(f.prisma, actor, input, f.material)).rejects.toThrow(
    IsolationError,
  );
  artifact.hash = hash;

  input.brief!.fields[0]!.sourceRefIds = ["jd"];
  f.tx.message.findMany.mockResolvedValue([
    {
      id: "jd-message",
      threadId: "thread",
      role: "user",
      botId: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: original.sourceRefs[0]!.quote }],
    },
  ]);
  const saved = await recruiting.reviseRecruitingRole(f.prisma, actor, input, f.material);
  expect(saved.revision.brief?.fields[0]?.sourceRefIds).toEqual(["jd"]);
  expect(saved.role.revision).toBe(2);
});

it("rejects bot-authored evidence mislabeled as a user instruction", async () => {
  const f = fixture();
  f.revisions[0]!.brief.fields[0]!.origin = "user_instruction";
  const bot = {
    id: "jd-message",
    threadId: "thread",
    role: "bot",
    botId: "bot",
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "GBP 90,000 to 120,000. Location unrestricted." }],
  };
  f.tx.message.findMany.mockResolvedValue([bot]);
  await expect(
    confirmRecruitingBrief(f.prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    }),
  ).rejects.toThrow(IsolationError);
  expect(f.tx.message.create).not.toHaveBeenCalled();
});

function approvalFixture() {
  const f = fixture();
  const run = {
    id: "run",
    ...actor,
    threadId: "thread",
    botId: "bot",
    bot: actor,
    status: "running",
    leaseOwner: "worker",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  f.revisions[0]!.brief.confirmation = {
    revision: 1,
    userId: actor.userId,
    messageId: "confirmation",
    confirmedAt: new Date(0).toISOString(),
  } as never;
  const bytes = new Map([
    ["jd", new TextEncoder().encode("Final engineer job description")],
    ["pdf", new TextEncoder().encode("%PDF-1.7\nsynthetic PDF")],
  ]);
  const artifacts = [...bytes].map(([id, body]) => ({
    id,
    ...actor,
    groupId: null,
    botId: "bot",
    runId: null as string | null,
    name: id === "jd" ? "JD.txt" : "JD.pdf",
    storageKey: id,
    mimeType: id === "jd" ? "text/plain" : "application/pdf",
    size: body.byteLength,
    hash: createHash("sha256").update(body).digest("hex"),
  }));
  const ref = (id: string) => ({
    artifactId: id,
    sha256: artifacts.find((a) => a.id === id)!.hash,
  });
  const input = {
    stage: "documents" as const,
    roleId: "role",
    expectedRoleRevision: 1,
    documents: { jdText: ref("jd"), namedPdf: ref("pdf"), anonymousPdf: null, deck: null },
  };
  const effects = new Map<string, Record<string, unknown>>();
  const events: Array<Record<string, any>> = [];
  const cards = new Map<string, Record<string, any>>();
  const tx = {
    ...f.tx,
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    run: { findFirst: vi.fn(async () => run), findUnique: vi.fn(async () => run) },
    artifact: {
      findFirst: vi.fn(async ({ where }) => artifacts.find((row) => row.id === where.id)),
      findUniqueOrThrow: vi.fn(async ({ where }) => artifacts.find((row) => row.id === where.id)),
    },
    message: {
      ...f.tx.message,
      findUnique: vi.fn(
        async ({ where }) =>
          cards.get(where.id) ?? {
            ...(await f.tx.message.findUnique({ where })),
            id: where.id,
            threadId: "thread",
          },
      ),
    },
    event: {
      findFirst: vi.fn(async ({ where }) =>
        events.find((event) => {
          if (event.type !== where.type || (where.runId && event.runId !== where.runId))
            return false;
          const filters = [
            ...(where.AND ?? []),
            ...(where.payload ? [{ payload: where.payload }] : []),
          ];
          return filters.every(
            ({ payload }) =>
              payload.path.reduce(
                (v: Record<string, any>, key: string) => v?.[key],
                event.payload,
              ) === payload.equals,
          );
        }),
      ),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `event-${events.length}`,
          seq: events.length + 1,
          createdAt: new Date("2026-10-16T19:00:00Z"),
          ...data,
        };
        events.push(row);
        return row;
      }),
    },
    externalEffect: {
      findFirst: vi.fn(async ({ where }) => effects.get(where.id)),
      findUnique: vi.fn(async ({ where }) => effects.get(where.id)),
      updateMany: vi.fn(async ({ where, data }) => {
        Object.assign(effects.get(where.id)!, data);
        return { count: 1 };
      }),
    },
    recruitingAssessment: { findFirst: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const material = {
    context: { ...actor, signal: new AbortController().signal },
    artifacts: { get: vi.fn(async (key: string) => bytes.get(key)!) },
  } as unknown as RecruitingRoleMaterialContext;
  const trusted = {
    runId: "run",
    threadId: "thread",
    botId: "bot",
    leaseOwner: "worker",
    leaseFence: 1,
  };
  function approve(id: string, request: unknown, status = "executing") {
    effects.set(id, {
      id,
      spaceId: actor.spaceId,
      runId: "run",
      kind: "recruiting_request_approval",
      status,
      request,
    });
    cards.set(`card-${id}`, {
      id: `card-${id}`,
      threadId: "thread",
      botId: "bot",
      runId: "run",
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Review",
          approvalEffectId: id,
          status: "answered",
          answer: "allow",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    events.push({
      id: `proof-${id}`,
      spaceId: actor.spaceId,
      threadId: "thread",
      botId: "bot",
      runId: "run",
      type: "effect.approval.answered",
      createdAt: new Date("2026-10-16T18:00:00Z"),
      payload: {
        effectId: id,
        messageId: `card-${id}`,
        askIndex: 0,
        answeredByUserId: actor.userId,
        answer: "allow",
        requestHash: createHash("sha256").update(stableJsonValue(request)).digest("hex"),
      },
    });
  }
  return {
    ...f,
    tx,
    prisma,
    material,
    trusted,
    input,
    artifacts,
    bytes,
    effects,
    events,
    cards,
    run,
    approve,
  };
}

describe("original PDF source validation (mocked DB, storage and processor)", () => {
  const text = "Original 🧭 candidate evidence\nSecond evidence line\f";
  const quote = "🧭 candidate evidence";
  beforeEach(() => vi.mocked(extractPdfText).mockReset().mockResolvedValue(text));

  function pdfFixture() {
    const f = approvalFixture();
    const artifact = f.artifacts[1]!;
    const provider = vi.fn(async () => null as { id: string } | null);
    Object.assign(f.tx, { recruitingResearchAction: { findFirst: provider } });
    const source = {
      id: "pdf-evidence",
      kind: "original_material" as const,
      anchor: {
        kind: "artifact" as const,
        artifact: { artifactId: artifact.id, sha256: artifact.hash },
        locator: "text",
      },
      readState: "read" as const,
      readAt: "2026-10-16T18:00:00Z",
      quote,
    };
    const input = ReviseRecruitingRoleInput.parse({
      roleId: "role",
      expectedRevision: 1,
      title: "Example engineer",
      sourceRefs: [source, { ...source, id: "second-quote", quote: "Second evidence line" }],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
      brief: { fields: [], searchFilters: [], rules: [], questions: [] },
    });
    return { ...f, artifact, source, input, provider };
  }

  it("persists exact role quotes from one extraction per PDF within each validation call", async () => {
    const f = pdfFixture();
    const saved = await recruiting.reviseRecruitingRole(f.prisma, actor, f.input, f.material);
    expect(saved.revision.sourceRefs).toEqual(f.input.sourceRefs);
    expect(extractPdfText).toHaveBeenCalledOnce();
    expect(extractPdfText).toHaveBeenCalledWith(f.bytes.get("pdf"));
    await recruiting.reviseRecruitingRole(
      f.prisma,
      actor,
      { ...f.input, expectedRevision: 2 },
      f.material,
    );
    expect(extractPdfText).toHaveBeenCalledTimes(2);
  });

  it.each([
    "foreign",
    "hash",
    "bytes",
    "provider-label",
    "provider-origin",
    "unreceipted",
    "locator",
  ])("rejects PDF %s before processing and writing a revision", async (boundary) => {
    const f = pdfFixture();
    let source = f.source;
    if (boundary === "foreign") f.artifact.userId = "another-human";
    if (boundary === "hash")
      source = {
        ...source,
        anchor: { ...source.anchor, artifact: { artifactId: "pdf", sha256: "0".repeat(64) } },
      };
    if (boundary === "bytes") f.bytes.set("pdf", new TextEncoder().encode("changed"));
    if (boundary === "provider-label") source = { ...source, kind: "provider_report" as never };
    if (boundary === "provider-origin") f.provider.mockResolvedValue({ id: "provider" });
    if (boundary === "unreceipted") f.artifact.runId = "run";
    if (boundary === "locator")
      source = { ...source, anchor: { ...source.anchor, locator: "page:1" } };
    await expect(
      recruiting.reviseRecruitingRole(
        f.prisma,
        actor,
        { ...f.input, sourceRefs: [source] },
        f.material,
      ),
    ).rejects.toThrow(IsolationError);
    expect(extractPdfText).not.toHaveBeenCalled();
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it.each(["quote", "processor"])("fails closed on PDF %s errors", async (boundary) => {
    const f = pdfFixture();
    if (boundary === "processor")
      vi.mocked(extractPdfText).mockRejectedValueOnce(new Error("private processor path"));
    const error = await recruiting
      .reviseRecruitingRole(
        f.prisma,
        actor,
        {
          ...f.input,
          sourceRefs: [{ ...f.source, quote: boundary === "quote" ? "Invented evidence" : quote }],
        },
        f.material,
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(
      boundary === "quote" ? recruiting.RecruitingSourceValidationError : IsolationError,
    );
    expect((error as Error).message).not.toMatch(/private processor path|%PDF|Invented evidence/);
    expect(extractPdfText).toHaveBeenCalledOnce();
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it.each(["exact", "json-selection", "offset", "quote"])(
    "revalidates saved assessment PDF evidence with %s UTF-16 selections",
    async (boundary) => {
      const f = await calibrationFixture();
      const artifact = f.artifacts[1]!;
      Object.assign(f.tx, { recruitingResearchAction: { findFirst: vi.fn(async () => null) } });
      const start = text.indexOf(quote);
      const source: RecruitingAssessmentSourceRef = {
        id: "pdf-evidence",
        kind: "original_material",
        anchor: {
          kind: "artifact",
          artifact: { artifactId: artifact.id, sha256: artifact.hash },
          locator: "text",
        },
        readState: "read",
        readAt: "2026-10-16T18:00:00Z",
        quote: boundary === "quote" ? "Invented evidence" : quote,
        selection:
          boundary === "json-selection"
            ? { kind: "artifact_json_string", path: ["text"], start, end: start + quote.length }
            : {
                kind: "artifact_text",
                start: boundary === "offset" ? start + 1 : start,
                end: start + quote.length,
              },
      };
      for (const assessment of f.assessments)
        assessment.sourceRefs.push(
          source as never,
          {
            ...source,
            id: "second-pdf-evidence",
            quote: "Second evidence line",
            selection: {
              kind: "artifact_text",
              start: text.indexOf("Second evidence line"),
              end: text.indexOf("Second evidence line") + "Second evidence line".length,
            },
          } as never,
        );
      const prepared = recruiting.prepareRecruitingApproval(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        f.material,
      );
      if (boundary === "exact") await expect(prepared).resolves.toHaveProperty("files");
      else await expect(prepared).rejects.toThrow(IsolationError);
      expect(extractPdfText).toHaveBeenCalledTimes(boundary === "json-selection" ? 0 : 1);
    },
  );
});

describe("native recruiting stage approvals", () => {
  it("preflights real authorized files without writes and rejects changed bytes", async () => {
    const f = approvalFixture();
    const result = await recruiting.prepareRecruitingApproval(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.material,
    );
    expect(result.files).toEqual(
      f.artifacts.map((row) => ({
        kind: "file",
        artifactId: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
      })),
    );
    expect(f.tx.event.create).not.toHaveBeenCalled();
    f.bytes.set("pdf", new TextEncoder().encode("fake PDF"));
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toThrow();
  });
  it.each(["stale", "unbound", "unconfirmed", "expired", "fake-pdf", "missing-store"])(
    "rejects %s approval preflight",
    async (mode) => {
      const f = approvalFixture();
      if (mode === "stale") f.input.expectedRoleRevision = 2;
      if (mode === "unbound") f.thread.activeRecruitingRoleId = "different";
      if (mode === "unconfirmed") f.revisions[0]!.brief.confirmation = null;
      if (mode === "expired") f.run.leaseExpiresAt = new Date(0);
      if (mode === "fake-pdf") {
        const bytes = new TextEncoder().encode("not a PDF");
        f.bytes.set("pdf", bytes);
        f.artifacts[1]!.size = bytes.length;
        f.artifacts[1]!.hash = createHash("sha256").update(bytes).digest("hex");
        f.input.documents.namedPdf.sha256 = f.artifacts[1]!.hash;
      }
      await expect(
        recruiting.prepareRecruitingApproval(
          f.prisma,
          actor,
          f.trusted,
          f.input,
          mode === "missing-store" ? undefined : f.material,
        ),
      ).rejects.toThrow();
    },
  );
  it("atomically persists the original owner approval time and replays its immutable receipt", async () => {
    const f = approvalFixture();
    f.approve("g1", f.input);
    const trusted = { ...f.trusted, effectId: "g1", effectRequest: f.input };
    const result = await recruiting.executeRecruitingApproval(
      f.prisma,
      actor,
      trusted,
      f.input,
      f.material,
    );
    expect(result).toMatchObject({
      status: "approved",
      stage: "documents",
      approvalEffectId: "g1",
      roleId: "role",
      roleRevisionId: "revision-1",
      approvedByUserId: actor.userId,
      approvedAt: "2026-10-16T18:00:00.000Z",
    });
    expect(f.effects.get("g1")!.status).toBe("completed");
    expect(f.tx.event.create).toHaveBeenCalledOnce();
    expect(f.tx.recruitingRole.updateMany).not.toHaveBeenCalled();
    f.thread.activeRecruitingRoleId = "another-role";
    f.run.status = "completed";
    expect(
      await recruiting.executeRecruitingApproval(f.prisma, actor, trusted, f.input, f.material),
    ).toEqual(result);
    expect(f.tx.event.create).toHaveBeenCalledOnce();
  });
  it.each(["missing-proof", "always", "other-owner", "wrong-hash", "wrong-card", "wrong-effect"])(
    "rejects %s native proof",
    async (mode) => {
      const f = approvalFixture();
      f.approve("g1", f.input);
      const proof = f.events[0]!;
      if (mode === "missing-proof") f.events.length = 0;
      if (mode === "always") proof.payload.answer = "always";
      if (mode === "other-owner") proof.payload.answeredByUserId = "teammate";
      if (mode === "wrong-hash") proof.payload.requestHash = "a".repeat(64);
      if (mode === "wrong-card")
        f.cards.get("card-g1")!.blocks[0].approvalEffectId = "other-effect";
      if (mode === "wrong-effect") f.effects.get("g1")!.kind = "other-tool";
      await expect(
        recruiting.executeRecruitingApproval(
          f.prisma,
          actor,
          { ...f.trusted, effectId: "g1", effectRequest: f.input },
          f.input,
          f.material,
        ),
      ).rejects.toThrow();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
      expect(f.tx.event.create).not.toHaveBeenCalled();
    },
  );
});

async function calibrationFixture() {
  const f = approvalFixture();
  f.approve("g1", f.input);
  await recruiting.executeRecruitingApproval(
    f.prisma,
    actor,
    { ...f.trusted, effectId: "g1", effectRequest: f.input },
    f.input,
    f.material,
  );
  const profiles = Array.from({ length: 10 }, (_, index) => ({
    candidateKey: `candidate-${index}`,
    assessmentVersion: 1,
    linkedinUrl: `https://www.linkedin.com/in/example-${index}/`,
    evidenceUrl: `https://example.test/evidence/${index}`,
  }));
  const quoteFor = (profile: (typeof profiles)[number]) =>
    `Profile ${profile.linkedinUrl}\nEvidence ${profile.evidenceUrl}`;
  const findMessage = f.tx.message.findUnique.getMockImplementation()!;
  f.tx.message.findUnique.mockImplementation(async (args) => {
    const profile = profiles.find((profile) => args.where.id === `profile-${profile.candidateKey}`);
    return profile
      ? {
          id: args.where.id,
          threadId: "thread",
          role: "user",
          botId: null,
          externalTranscriptFor: null,
          blocks: [{ kind: "text", text: quoteFor(profile) }],
        }
      : findMessage(args);
  });
  const assessments = profiles.map((profile) => ({
    roleId: "role",
    candidateKey: profile.candidateKey,
    version: 1,
    basedOnVersion: null,
    roleRevisionId: "revision-1",
    facts: [],
    questions: [],
    judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" },
    sourceRefs: [profile.linkedinUrl, profile.evidenceUrl].map((url, index) => ({
      id: `source-${profile.candidateKey}-${index}`,
      kind: "original_material",
      anchor: {
        kind: "message",
        messageId: `profile-${profile.candidateKey}`,
        locator: "blocks[0].text",
      },
      readState: "read",
      readAt: new Date(0).toISOString(),
      url,
      quote: quoteFor(profile),
      selection: { kind: "message_text", blockIndex: 0, start: 0, end: quoteFor(profile).length },
    })),
    createdByRunId: "run",
    createdAt: new Date(0),
  }));
  f.tx.recruitingAssessment.findFirst.mockImplementation(async ({ where }) =>
    assessments.find((row) => row.candidateKey === where.candidateKey),
  );
  const input = {
    stage: "calibration" as const,
    roleId: "role",
    expectedRoleRevision: 1,
    documentsApprovalEffectId: "g1",
    profiles,
    ruleChanges: ["Prioritize supplied implementation evidence."],
  };
  return { ...f, input, assessments };
}

describe("calibration approval package", () => {
  it("accepts ten saved current assessments with unknown judgments and read source URLs", async () => {
    const f = await calibrationFixture();
    expect(
      (await recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material))
        .files,
    ).toHaveLength(2);
    f.approve("g2", f.input);
    expect(
      await recruiting.executeRecruitingApproval(
        f.prisma,
        actor,
        { ...f.trusted, effectId: "g2", effectRequest: f.input },
        f.input,
        f.material,
      ),
    ).toMatchObject({ stage: "calibration", approvalEffectId: "g2" });
  });
  it.each([
    "duplicate",
    "stale-assessment",
    "wrong-role-revision",
    "missing-linkedin",
    "unread-evidence",
    "invented-url",
    "missing-documents-proof",
  ])("rejects %s calibration", async (mode) => {
    const f = await calibrationFixture();
    if (mode === "duplicate") f.input.profiles[1]!.candidateKey = f.input.profiles[0]!.candidateKey;
    if (mode === "stale-assessment") f.assessments[0]!.version = 2;
    if (mode === "wrong-role-revision") f.assessments[0]!.roleRevisionId = "old-revision";
    if (mode === "missing-linkedin") f.assessments[0]!.sourceRefs.shift();
    if (mode === "unread-evidence") f.assessments[0]!.sourceRefs[1]!.readState = "unread";
    if (mode === "invented-url") f.input.profiles[0]!.evidenceUrl = "https://example.test/invented";
    if (mode === "missing-documents-proof")
      f.events.splice(
        f.events.findIndex((event) => event.type === "effect.approval.answered"),
        1,
      );
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toThrow();
  });
});

describe("owner approval answer admission", () => {
  it("requires the actual owner and the current selected role while stale cards remain rejectable", async () => {
    const f = approvalFixture();
    f.run.status = "waiting_input";
    const input = {
      spaceId: actor.spaceId,
      threadId: "thread",
      runId: "run",
      messageId: "card",
      answeredByUserId: actor.userId,
      answer: "allow",
    };
    const tx = f.tx as unknown as Prisma.TransactionClient;
    expect(
      await recruiting.authorizeRecruitingApprovalAnswerInTransaction(tx, input, f.input),
    ).toBe(true);
    expect(
      await recruiting.authorizeRecruitingApprovalAnswerInTransaction(
        tx,
        { ...input, answeredByUserId: "teammate" },
        f.input,
      ),
    ).toBe(false);
    f.thread.activeRecruitingRoleId = "other-role";
    expect(
      await recruiting.authorizeRecruitingApprovalAnswerInTransaction(tx, input, f.input),
    ).toBe(false);
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });
  it("revalidates calibration assessment versions immediately before accepting allow", async () => {
    const f = await calibrationFixture();
    f.run.status = "waiting_input";
    const input = {
      spaceId: actor.spaceId,
      threadId: "thread",
      runId: "run",
      messageId: "card",
      answeredByUserId: actor.userId,
      answer: "allow",
    };
    const tx = f.tx as unknown as Prisma.TransactionClient;
    expect(
      await recruiting.authorizeRecruitingApprovalAnswerInTransaction(tx, input, f.input),
    ).toBe(true);
    f.assessments[0]!.version = 2;
    expect(
      await recruiting.authorizeRecruitingApprovalAnswerInTransaction(tx, input, f.input),
    ).toBe(false);
  });
});

async function gatedResearchFixture() {
  const f = await calibrationFixture();
  const source = {
    id: "source",
    threadId: "thread",
    role: "user",
    botId: null,
    runId: "run",
    externalTranscriptFor: null,
    seq: 1,
    createdAt: new Date(0),
    blocks: [{ kind: "text", text: "Find synthetic engineers" }],
  };
  const run = { ...f.run, sourceMessageId: "source", trigger: "user" };
  const server = { id: "server", ...actor, enabled: true, revision: 1, slug: "research" };
  let task: Record<string, any> | null = null;
  let action: Record<string, any> | null = null;
  const artifacts = new Map(f.artifacts.map((row) => [row.id, { ...row, runId: "run" }]));
  const contextArtifact = { artifactId: "context", sha256: "a".repeat(64) };
  artifacts.set("context", {
    ...artifacts.get("jd")!,
    id: "context",
    hash: contextArtifact.sha256,
  });
  const adoption = {
    id: "adoption",
    spaceId: actor.spaceId,
    threadId: "thread",
    botId: "bot",
    runId: "run",
    type: "recruiting.context.adopted",
    createdAt: new Date(0),
    seq: 1,
    payload: { roleId: "role", roleRevisionId: "revision-1", contextArtifact },
  };
  const tx = {
    ...f.tx,
    run: {
      findFirst: vi.fn(async (_args: { where: { id: string } }) => run),
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
    },
    message: {
      ...f.tx.message,
      findFirst: vi.fn(async () => source),
      findUnique: vi.fn(async ({ where }) =>
        where.id === "source" ? source : f.tx.message.findUnique({ where }),
      ),
    },
    event: {
      ...f.tx.event,
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async ({ where }) =>
        where.type === "recruiting.context.adopted" ? adoption : f.tx.event.findFirst({ where }),
      ),
    },
    steeringMessage: { findMany: vi.fn(async () => []) },
    mcpServer: { findFirst: vi.fn(async () => server) },
    botMcpServer: { findFirst: vi.fn(async () => ({ allowAllTools: true })) },
    artifact: {
      findFirst: vi.fn(async ({ where }) => artifacts.get(where.id)),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async ({ where }) => artifacts.get(where.id)),
      create: vi.fn(async ({ data }) => {
        const row = { id: "request", ...data };
        artifacts.set(row.id, row);
        return row;
      }),
    },
    recruitingResearchTask: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => task),
      findUniqueOrThrow: vi.fn(async () => task),
      create: vi.fn(async ({ data }) => {
        task = {
          id: "task",
          providerTaskId: null,
          state: "active",
          pendingActionId: null,
          ...data,
        };
        return task;
      }),
      update: vi.fn(async ({ data }) => {
        Object.assign(task!, data);
        return task;
      }),
    },
    recruitingResearchAction: {
      findFirst: vi.fn(async ({ where, select }) => {
        if (
          !action ||
          where.id?.not === action.id ||
          (where.id && typeof where.id === "string" && where.id !== action.id) ||
          (where.clientNonce && where.clientNonce !== action.clientNonce)
        )
          return null;
        return select
          ? {
              ...action,
              run: { threadId: "thread" },
              effect: action.effectId ? f.effects.get(action.effectId) : null,
            }
          : action;
      }),
      findUniqueOrThrow: vi.fn(async () => action),
      create: vi.fn(async ({ data }) => {
        action = {
          id: "action",
          deliveryState: "prepared",
          observedProviderState: null,
          receiptArtifactId: null,
          receiptArtifactHash: null,
          cursor: null,
          effectId: null,
          usage: null,
          ...data,
        };
        return action;
      }),
      update: vi.fn(async ({ data }) => {
        Object.assign(action!, data);
        return action;
      }),
    },
    externalEffect: {
      ...f.tx.externalEffect,
      findUnique: vi.fn(async ({ where }) =>
        where.id
          ? f.effects.get(where.id)
          : [...f.effects.values()].find((row) => row.idempotencyKey === where.idempotencyKey),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }) => f.effects.get(where.id)),
      create: vi.fn(async ({ data }) => {
        const row = { id: "research-effect", ...data };
        f.effects.set(row.id, row);
        return row;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const input = {
    runId: "run",
    sourceMessageId: "source",
    intent: { basis: "direct" as const, quote: "Find synthetic engineers" },
    expectedRoleRevision: 1,
    mcpServerId: "server",
    serverRevision: 1,
    kind: "create" as const,
    purpose: "calibration" as const,
    candidateOutputSchema: "candidate_output_v1" as const,
    approvalEffectId: "g1",
    clientNonce: "research-action",
    recallScope: null,
    requestArtifact: {
      name: "request.json",
      mimeType: "application/json",
      size: 2,
      hash: "b".repeat(64),
      storageKey: "request",
      clientNonce: "request",
    },
    contextArtifact,
  };
  return {
    ...f,
    tx,
    prisma,
    run,
    input,
    source,
    calibrationInput: f.input,
    getAction: () => action!,
  };
}

describe("research stage gate enforcement", () => {
  it.each(["admission", "claim"])(
    "supersedes a pending old-version search after a human edit before %s",
    async (stage) => {
      const f = await gatedResearchFixture();
      const seed = criteriaFixture();
      f.revisions[0]!.criteria = seed.revisions[0]!.criteria;
      f.revisions[0]!.brief.rules = seed.revisions[0]!.brief.rules;
      const prepared = await recruiting.prepareRecruitingResearchAction(f.prisma, actor, f.input);
      const admission = {
        ...f.trusted,
        actionId: prepared.action.id,
        purpose: f.input.purpose,
        approvalEffectId: f.input.approvalEffectId,
        requestArtifact: {
          artifactId: prepared.requestArtifact.id,
          sha256: prepared.requestArtifact.hash,
        },
        contextArtifact: f.input.contextArtifact,
        frozenRequest: { tool: "research" },
        effectKind: "mcp_research",
      };
      const admitted =
        stage === "claim"
          ? await recruiting.admitRecruitingResearchAction(f.prisma, actor, admission)
          : null;
      await recruiting.editRecruitingCriteria(f.prisma, actor, seed.input);
      if (admitted) {
        expect(
          await recruiting.claimRecruitingResearchAction(f.prisma, actor, {
            ...f.trusted,
            actionId: prepared.action.id,
            effectId: admitted.effect!.id,
            from: "intended",
          }),
        ).toBe(false);
        expect(f.effects.get(admitted.effect!.id)!.status).toBe("intended");
      } else {
        expect(
          (await recruiting.admitRecruitingResearchAction(f.prisma, actor, admission)).status,
        ).toBe("superseded");
        expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
      }
      expect(f.getAction().roleRevisionId).toBe("revision-1");
      expect(f.getAction().deliveryState).toBe("superseded");
      expect(f.run.status).toBe("running");
    },
  );
  it.each(["missing-proof", "documents-for-scale", "legacy-purpose"])(
    "rejects %s before research action writes",
    async (mode) => {
      const f = await gatedResearchFixture();
      const input = {
        ...f.input,
        purpose:
          mode === "documents-for-scale"
            ? "scale"
            : mode === "legacy-purpose"
              ? undefined
              : "calibration",
      };
      if (mode === "missing-proof")
        f.events.splice(
          f.events.findIndex((event) => event.type === "effect.approval.answered"),
          1,
        );
      await expect(
        recruiting.prepareRecruitingResearchAction(
          f.prisma,
          actor,
          input as recruiting.RecruitingResearchPreparationInput,
        ),
      ).rejects.toThrow();
      expect(f.tx.recruitingResearchAction.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
    },
  );
  it.each(["missing-proof", "role-revision"])(
    "freezes stage proof and rejects %s between admission and claim",
    async (mode) => {
      const f = await gatedResearchFixture();
      const prepared = await recruiting.prepareRecruitingResearchAction(f.prisma, actor, f.input);
      expect(prepared.action).toMatchObject({ purpose: "calibration", approvalEffectId: "g1" });
      const admission = {
        ...f.trusted,
        actionId: prepared.action.id,
        purpose: f.input.purpose,
        approvalEffectId: f.input.approvalEffectId,
        requestArtifact: {
          artifactId: prepared.requestArtifact.id,
          sha256: prepared.requestArtifact.hash,
        },
        contextArtifact: f.input.contextArtifact,
        frozenRequest: { tool: "research" },
        effectKind: "mcp_research",
      };
      const admitted = await recruiting.admitRecruitingResearchAction(f.prisma, actor, admission);
      expect(admitted.status).toBe("ready");
      if (mode === "missing-proof")
        f.events.splice(
          f.events.findIndex((event) => event.type === "effect.approval.answered"),
          1,
        );
      else {
        const role = await f.tx.recruitingRole.findFirst();
        f.tx.recruitingRole.findFirst.mockResolvedValue({
          ...role,
          revision: 2,
          currentRevisionId: "revision-2",
        });
        f.revisions.push({ ...f.revisions[0]!, id: "revision-2", revision: 2 });
      }
      expect(
        await recruiting.claimRecruitingResearchAction(f.prisma, actor, {
          ...f.trusted,
          actionId: prepared.action.id,
          effectId: admitted.effect!.id,
          from: "intended",
        }),
      ).toBe(false);
      expect(f.effects.get(admitted.effect!.id)!.status).toBe("intended");
      expect(f.getAction().deliveryState).toBe("superseded");
    },
  );
});

describe("approval ownership across conversations", () => {
  it("accepts a G0 human confirmation created in another owned bound conversation", async () => {
    const f = approvalFixture();
    const find = f.tx.message.findUnique.getMockImplementation()!;
    f.tx.message.findUnique.mockImplementation(async (args) => {
      const message = await find(args);
      return args.where.id === "confirmation"
        ? { ...message, threadId: "confirmation-thread" }
        : message;
    });
    f.tx.thread.findFirst.mockImplementation(async ({ where }) => ({ ...f.thread, id: where.id }));
    expect(
      (await recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material))
        .files,
    ).toHaveLength(2);
    f.tx.thread.findFirst.mockImplementation(async ({ where }) => ({
      ...f.thread,
      id: where.id,
      userId: where.id === "confirmation-thread" ? "another-owner" : actor.userId,
    }));
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toThrow();
  });
  it("keeps a current completed gate usable after its original conversation selects another role", async () => {
    const f = await gatedResearchFixture();
    f.effects.get("g1")!.runId = "approval-run";
    f.cards.get("card-g1")!.runId = "approval-run";
    f.cards.get("card-g1")!.threadId = "approval-thread";
    for (const event of f.events) {
      if (event.payload.effectId === "g1") {
        event.runId = "approval-run";
        event.threadId = "approval-thread";
      }
    }
    f.tx.run.findFirst.mockImplementation(async ({ where }) =>
      where.id === "approval-run"
        ? { ...f.run, id: "approval-run", threadId: "approval-thread" }
        : f.run,
    );
    f.tx.thread.findFirst.mockImplementation(async ({ where }) => ({
      ...f.thread,
      id: where.id,
      activeRecruitingRoleId: where.id === "approval-thread" ? "other-role" : "role",
    }));
    expect(
      (await recruiting.prepareRecruitingResearchAction(f.prisma, actor, f.input)).action.purpose,
    ).toBe("calibration");
  });
  it("rejects an empty LinkedIn profile path", async () => {
    const f = await calibrationFixture();
    f.input.profiles[0]!.linkedinUrl = "https://www.linkedin.com/in/";
    f.assessments[0]!.sourceRefs[0]!.url = f.input.profiles[0]!.linkedinUrl;
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toThrow();
  });
});

it("does not count canonical duplicates as two calibration profiles", async () => {
  const f = await calibrationFixture();
  f.input.profiles[1]!.linkedinUrl = "https://linkedin.com/in/EXAMPLE-0?trk=other";
  f.assessments[1]!.sourceRefs[0]!.url = f.input.profiles[1]!.linkedinUrl;
  await expect(
    recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
  ).rejects.toThrow();
});

it.each(["invalid-utf8", "invalid-json", "empty-json"])(
  "returns a known validation error for %s JD material",
  async (mode) => {
    const f = approvalFixture();
    const bytes =
      mode === "invalid-utf8"
        ? Uint8Array.of(0xff)
        : new TextEncoder().encode(mode === "invalid-json" ? "{" : "{}");
    f.bytes.set("jd", bytes);
    f.artifacts[0]!.size = bytes.length;
    f.artifacts[0]!.hash = createHash("sha256").update(bytes).digest("hex");
    f.input.documents.jdText.sha256 = f.artifacts[0]!.hash;
    if (mode !== "invalid-utf8") f.artifacts[0]!.mimeType = "application/json";
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toMatchObject({ name: "IsolationError" });
  },
);

it("records scale approval on a new action of the same provider task", async () => {
  const f = await gatedResearchFixture();
  const calibration = await recruiting.prepareRecruitingResearchAction(f.prisma, actor, f.input);
  calibration.task.providerTaskId = "provider-task";
  calibration.task.pendingActionId = null;
  f.getAction().deliveryState = "accepted";
  f.approve("g2", f.calibrationInput);
  await recruiting.executeRecruitingApproval(
    f.prisma,
    actor,
    { ...f.trusted, effectId: "g2", effectRequest: f.calibrationInput },
    f.calibrationInput,
    f.material,
  );
  const scale = await recruiting.prepareRecruitingResearchAction(f.prisma, actor, {
    ...f.input,
    kind: "continue",
    taskId: calibration.task.id,
    clientNonce: "scale-action",
    purpose: "scale",
    approvalEffectId: "g2",
    requestArtifact: { ...f.input.requestArtifact, clientNonce: "scale-request" },
  });
  expect(scale.task.id).toBe(calibration.task.id);
  expect(calibration.action).toMatchObject({ purpose: "calibration", approvalEffectId: "g1" });
  expect(scale.action).toMatchObject({ purpose: "scale", approvalEffectId: "g2" });
});

it("rejects invented profile URLs attached only as metadata to a real unrelated quote", async () => {
  const f = await calibrationFixture();
  const ref = f.assessments[0]!.sourceRefs[1]!;
  ref.anchor.messageId = "jd-message";
  ref.quote = "GBP 90,000 to 120,000";
  ref.selection.end = ref.quote.length;
  await expect(
    recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
  ).rejects.toThrow();
});

it.each([{ url: "https://example.test", text: "" }, { title: "Draft" }])(
  "rejects a JSON JD with no observed text body %j",
  async (json) => {
    const f = approvalFixture();
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    f.bytes.set("jd", bytes);
    f.artifacts[0]!.size = bytes.length;
    f.artifacts[0]!.mimeType = "application/json";
    f.artifacts[0]!.hash = createHash("sha256").update(bytes).digest("hex");
    f.input.documents.jdText.sha256 = f.artifacts[0]!.hash;
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toThrow();
  },
);

it("accepts a web source URL backed by its exact native read receipt and bytes", async () => {
  const f = await calibrationFixture();
  const body = "Observed public evidence body";
  const bytes = new TextEncoder().encode(JSON.stringify({ text: body }));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const row = {
    ...f.artifacts[0]!,
    id: "web",
    name: "web.json",
    runId: "run",
    mimeType: "application/json",
    hash,
    size: bytes.length,
    storageKey: "web",
  };
  f.artifacts.push(row);
  f.bytes.set("web", bytes);
  const source = f.assessments[0]!.sourceRefs[1]!;
  Object.assign(source, {
    anchor: { kind: "artifact", artifact: { artifactId: "web", sha256: hash }, locator: "text" },
    quote: body,
    selection: { kind: "artifact_json_string", path: ["text"], start: 0, end: body.length },
  });
  const receipt = {
    id: "web-read",
    seq: 20,
    spaceId: actor.spaceId,
    threadId: "thread",
    botId: "bot",
    runId: "run",
    type: "recruiting.material.read",
    createdAt: new Date(0),
    payload: {
      reader: "web_fetch",
      url: source.url,
      readAt: source.readAt,
      artifact: { artifactId: "web", sha256: hash },
    },
  };
  f.events.push(receipt);
  const tx = { ...f.tx, recruitingResearchAction: { findFirst: vi.fn(async () => null) } };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  expect(
    (await recruiting.prepareRecruitingApproval(prisma, actor, f.trusted, f.input, f.material))
      .files,
  ).toHaveLength(2);
  receipt.payload.url = "https://example.test/another-source";
  await expect(
    recruiting.prepareRecruitingApproval(prisma, actor, f.trusted, f.input, f.material),
  ).rejects.toThrow();
});

it("accepts a JSON JD containing the native text field", async () => {
  const f = approvalFixture();
  const bytes = new TextEncoder().encode(
    JSON.stringify({ text: "Final synthetic engineer job description" }),
  );
  f.bytes.set("jd", bytes);
  f.artifacts[0]!.size = bytes.length;
  f.artifacts[0]!.mimeType = "application/json";
  f.artifacts[0]!.hash = createHash("sha256").update(bytes).digest("hex");
  f.input.documents.jdText.sha256 = f.artifacts[0]!.hash;
  expect(
    (await recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material))
      .files,
  ).toHaveLength(2);
});

it.each(["-other", "?fake=true", "#section"])(
  "rejects a URL prefix when only the URL with suffix %s was observed",
  async (suffix) => {
    const f = await calibrationFixture();
    const profile = f.input.profiles[0]!;
    profile.linkedinUrl = profile.linkedinUrl.slice(0, -1);
    const quote = `Profile ${profile.linkedinUrl}${suffix}\nEvidence ${profile.evidenceUrl}`;
    for (const ref of f.assessments[0]!.sourceRefs) {
      ref.quote = quote;
      ref.selection.end = quote.length;
    }
    f.assessments[0]!.sourceRefs[0]!.url = profile.linkedinUrl;
    const findMessage = f.tx.message.findUnique.getMockImplementation()!;
    f.tx.message.findUnique.mockImplementation(async (args) => {
      const message = await findMessage(args);
      return args.where.id === `profile-${profile.candidateKey}`
        ? { ...message, blocks: [{ kind: "text", text: quote }] }
        : message;
    });
    await expect(
      recruiting.prepareRecruitingApproval(f.prisma, actor, f.trusted, f.input, f.material),
    ).rejects.toThrow();
  },
);
