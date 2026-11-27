import { createHash } from "node:crypto";
import type { Actor, RecruitingBriefDraft, RecruitingCriterion } from "@rakazo/contracts";
import { ReviseRecruitingRoleInput } from "@rakazo/contracts";
import { boundDirectApprovalRequest, RecruitingPlaybookValidationError } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import type { RecruitingRoleMaterialContext } from "./recruiting.js";
import * as recruiting from "./recruiting.js";
import { IsolationError } from "./scope.js";

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
    botId: "bot" as string | null,
    groupId: null as string | null,
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
        searchFilters: [] as RecruitingBriefDraft["searchFilters"],
        questions: [],
        rules: [] as RecruitingBriefDraft["rules"],
        // Saved rows from before the confirmation step was removed still carry this field.
        confirmation: null as unknown,
      },
    },
  ];
  const humanMessages = new Map<string, Record<string, unknown>>();
  const sourceMessage = (id: string) =>
    humanMessages.get(id) ?? {
      id,
      threadId: "thread",
      role: "user",
      botId: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: "GBP 90,000 to 120,000. Location unrestricted." }],
    };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    recruitingCrmWorkspaceAttachment: { findUnique: vi.fn(async () => null) },
    thread: {
      findFirst: vi.fn(async (_args: { where: { id: string } }) => thread),
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 1 })),
    },
    bot: { findFirst: vi.fn(async () => actor) },
    chatGroup: {
      findFirst: vi.fn(async () => actor),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    event: {
      create: vi.fn(async ({ data }) => ({ id: "changed-event", createdAt: new Date(), ...data })),
    },
    message: {
      findUnique: vi.fn(async ({ where }) => sourceMessage(where.id)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map(sourceMessage),
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
    recruitingCalibrationRound: {
      findFirst: vi.fn(async () => ({ id: "latest-round" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
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
  if (crmBindingEffectId) {
    Object.assign(tx, verifiedCrmBinding(crmBindingEffectId));
    // Autonomous record keeping: no approval card or answer exists for the binding.
    Object.assign(tx.message, { findFirst: vi.fn(async () => null) });
    Object.assign(tx.event, { findFirst: vi.fn(async () => null) });
  }
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, thread, revisions, humanMessages };
}

/** A completed, autonomously recorded CRM binding that the workspace read verifies. */
function verifiedCrmBinding(bindingEffectId: string) {
  const target = {
    mcpServerId: "crm-server",
    serverRevision: 2,
    organizationId: "10000000-0000-4000-8000-000000000001",
    crmRoleId: "20000000-0000-4000-8000-000000000002",
    crmClientId: "30000000-0000-4000-8000-000000000003",
    clientLabel: "Client",
    roleLabel: "Engineer",
  };
  const run = {
    id: "run",
    spaceId: actor.spaceId,
    userId: actor.userId,
    threadId: "thread",
    botId: "bot",
    bot: { spaceId: actor.spaceId, userId: actor.userId },
  };
  const effects = new Map<string, Record<string, unknown>>([
    [
      bindingEffectId,
      {
        id: bindingEffectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_crm_target",
        status: "completed",
        request: {
          operation: "bind",
          roleId: "role",
          expectedRoleRevision: 1,
          expectedBindingEffectId: null,
          crmRoleReadEffectId: "crm-read",
        },
        result: { status: "connected", roleId: "role", bindingEffectId, target },
      },
    ],
    [
      "crm-read",
      {
        id: "crm-read",
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "mcp__crm__get_crm_role",
        status: "completed",
        request: boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: target.mcpServerId,
            resourceRevision: target.serverRevision,
            toolName: "get_crm_role",
          },
          { p_org: target.organizationId, p_role: target.crmRoleId },
          "__rakazoCatalogTool",
        ),
        result: {
          structuredContent: {
            data: {
              role_spec_id: target.crmRoleId,
              client_id: target.crmClientId,
              client_label: target.clientLabel,
              role_label: target.roleLabel,
            },
          },
        },
      },
    ],
  ]);
  return {
    run: { findFirst: vi.fn(async () => run) },
    externalEffect: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => effects.get(where.id)),
    },
  };
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
  it.each([false, true])(
    "records a durable saved change in the authorized thread, group=%s",
    async (group) => {
      const f = criteriaFixture();
      if (group) {
        f.thread.botId = null;
        f.thread.groupId = "group";
      }
      const saved = await recruiting.editRecruitingCriteria(f.prisma, actor, f.input);
      expect(saved.role.revision).toBe(2);
      expect(f.tx.event.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          spaceId: actor.spaceId,
          threadId: f.thread.id,
          botId: f.thread.botId ?? f.thread.id,
          type: "recruiting.changed",
          payload: { roleId: saved.role.id },
        }),
      });
      expect(f.tx.event.create.mock.invocationCallOrder[0]).toBeGreaterThan(
        f.tx.recruitingRole.updateMany.mock.invocationCallOrder[0]!,
      );
    },
  );
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
    expect(saved.revision.brief).not.toHaveProperty("confirmation");
    expect(saved.revision.brief?.searchFilters[0]).toEqual(original.brief.searchFilters[0]);
    const human = saved.revision.sourceRefs.at(-1)!;
    expect(saved.revision.brief?.searchFilters[1]).toEqual({
      ...searchFilters[1],
      origin: "user_instruction",
      sourceRefIds: [human.id],
    });
    expect(human.quote).toContain("Add search filter (include): Search the UK");
    expect(human.quote).not.toContain("Prefer backend titles");
    expect(human.quote).not.toContain('"id"');
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
    expect(changedSource.quote).toContain(
      "Change search filter (prefer): Prefer backend titles → (include): Search senior backend titles",
    );
    expect(changedSource.quote).not.toContain("Search the UK");
    const removed = await recruiting.editRecruitingCriteria(f.prisma, actor, {
      ...f.input,
      expectedRevision: 3,
      searchFilters: [],
    });
    expect(removed.role.revision).toBe(4);
    expect(removed.revision.brief?.searchFilters).toEqual([]);
    expect(removed.revision.criteria).toEqual(original.criteria);
    expect(removed.revision.sourceRefs.at(-1)!.quote).toContain(
      "Remove search filter (include): Search senior backend titles",
    );
    expect(removed.revision.sourceRefs.at(-1)!.quote).toContain(
      "Remove search filter (include): Search the UK",
    );
  });
  it("preserves filter provenance on criteria-only edits and avoids a revision for unchanged filters", async () => {
    const f = criteriaFixture();
    const filters: RecruitingBriefDraft["searchFilters"] = [
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
    expect(human.quote).toContain("Example engineer");
    expect(human.quote).toContain("Implemented geometry → Personally implemented 3D geometry");
    expect(human.quote).toContain("Priority: Required → Preferred");
    expect(human.quote).not.toMatch(/criterionId|atomId|"priority"|"statement"/);
    expect(human.quote).not.toContain("Built a web app");
    expect(saved.revision.brief?.rules[0]).toEqual({
      criterionId: "skills",
      origin: "user_instruction",
      effect: "flag",
      sourceRefIds: [human.id],
    });
    expect(saved.revision.brief?.rules[1]).toEqual(original.brief.rules[1]);
    expect(saved.revision.brief).not.toHaveProperty("confirmation");
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
      expect(saved.revision.brief).not.toHaveProperty("confirmation");
      expect(f.tx.message.create).not.toHaveBeenCalled();
      expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
      expect(f.tx.recruitingRole.updateMany).not.toHaveBeenCalled();
      expect(f.tx.event.create).not.toHaveBeenCalled();
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
        .mockImplementation(async () => ({ ...f.thread, activeRecruitingRoleId: "foreign" }));
    await expect(recruiting.editRecruitingCriteria(f.prisma, actor, f.input)).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
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
    expect(f.revisions[0]!.criteria[0]!.expression).toEqual({
      kind: "any",
      items: [leaf, { kind: "not", item: leaf }],
    });
    const human = saved.revision.sourceRefs.at(-1)!;
    expect(human.quote).toContain(statement);
    expect(human.quote).not.toMatch(/atomId|employmentRule|minimumMonths|qualificationDefinition/);
    expect(saved.revision.brief?.fields).toEqual(f.revisions[0]!.brief.fields);
    expect(saved.revision.brief).not.toHaveProperty("confirmation");
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
    expect(saved.revision.sourceRefs.at(-1)!.quote).toContain(
      "At least 60 complete calendar months of Full-time personally implemented geometry; cutoff: assessment date (UTC).",
    );
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
    expect(saved.revision.sourceRefs.at(-1)!.quote).toContain("Works onsite");
    expect(saved.revision.sourceRefs.at(-1)!.quote).toContain("Priority: Preferred → Required");
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
it("explains mixed JD attribution without accepting it as a human instruction", async () => {
  const f = materialFixture();
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

it("renames the role's chat group only while it still carries the previous title", async () => {
  const f = materialFixture();
  Object.assign(f.tx, { recruitingResearchAction: { findFirst: vi.fn(async () => null) } });
  f.thread.botId = null;
  f.thread.groupId = "group";
  const original = f.revisions[0]!;
  const { confirmation: _confirmation, ...brief } = original.brief;
  const input = ReviseRecruitingRoleInput.parse({
    roleId: "role",
    expectedRevision: 1,
    title: "Staff engineer",
    criteria: original.criteria,
    preferences: original.preferences,
    definitionQuestions: original.definitionQuestions,
    sourceRefs: original.sourceRefs,
    brief,
  });
  await recruiting.reviseRecruitingRole(f.prisma, actor, input, f.material);
  expect(f.tx.chatGroup.updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { id: "group", spaceId: actor.spaceId, userId: actor.userId, name: "Example engineer" },
    data: { name: "Staff engineer" },
  });
});

function materialFixture() {
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
  const effects = new Map<string, Record<string, unknown>>();
  const events: Array<Record<string, any>> = [];
  const tx = {
    ...f.tx,
    $queryRaw: vi.fn(async (_query?: unknown): Promise<unknown[]> => [{ id: "thread" }]),
    run: { findFirst: vi.fn(async () => run), findUnique: vi.fn(async () => run) },
    artifact: {
      findFirst: vi.fn(async ({ where }) => artifacts.find((row) => row.id === where.id)),
      findUniqueOrThrow: vi.fn(async ({ where }) => artifacts.find((row) => row.id === where.id)),
    },
    message: {
      ...f.tx.message,
      findUnique: vi.fn(async ({ where }) => ({
        ...(await f.tx.message.findUnique({ where })),
        id: where.id,
        threadId: "thread",
      })),
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
      findFirst: vi.fn(async ({ where }) =>
        where.id
          ? effects.get(where.id)
          : [...effects.values()].find(
              (effect) =>
                effect.spaceId === where.spaceId &&
                effect.runId === where.runId &&
                effect.kind === where.kind &&
                stableJsonValue(effect.request) === stableJsonValue(where.request.equals),
            ),
      ),
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
  return {
    ...f,
    tx,
    prisma,
    material,
    artifacts,
    bytes,
  };
}

describe("original file source validation (mocked DB and storage)", () => {
  const quote = "🧭 candidate evidence";

  function pdfFixture() {
    const f = materialFixture();
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

  it("saves a quote that is not the file's own wording, and still refuses another file's fingerprint", async () => {
    const f = pdfFixture();
    const sourceRefs = [{ ...f.source, quote: "The agent's own copy of the passage" }];
    const saved = await recruiting.reviseRecruitingRole(
      f.prisma,
      actor,
      { ...f.input, sourceRefs },
      f.material,
    );
    expect(saved.revision.sourceRefs).toEqual(sourceRefs);
    f.tx.recruitingRoleRevision.create.mockClear();
    await expect(
      recruiting.reviseRecruitingRole(
        f.prisma,
        actor,
        {
          ...f.input,
          expectedRevision: 2,
          sourceRefs: sourceRefs.map((source) => ({
            ...source,
            anchor: {
              ...source.anchor,
              artifact: { ...source.anchor.artifact, sha256: "0".repeat(64) },
            },
          })),
        },
        f.material,
      ),
    ).rejects.toThrow(recruiting.RecruitingSourceCheckError);
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it("batch-loads quoted messages", async () => {
    const f = pdfFixture();
    const human = {
      id: "jd-message",
      threadId: "thread",
      role: "user",
      botId: null,
      externalTranscriptFor: null,
      blocks: [{ kind: "text", text: "GBP 90,000 to 120,000. Location unrestricted." }],
    };
    f.humanMessages.set(human.id, human);
    f.humanMessages.set("second-human", { ...human, id: "second-human" });
    const { sourceRefs } = ReviseRecruitingRoleInput.parse({
      ...f.input,
      sourceRefs: [
        ...f.input.sourceRefs,
        f.revisions[0]!.sourceRefs[0]!,
        {
          ...f.revisions[0]!.sourceRefs[0]!,
          id: "location-quote",
          quote: "Location unrestricted.",
        },
        {
          ...f.revisions[0]!.sourceRefs[0]!,
          id: "second-human-source",
          anchor: { kind: "message", messageId: "second-human", locator: "blocks[0].text" },
        },
      ],
    });
    await recruiting.reviseRecruitingRole(f.prisma, actor, { ...f.input, sourceRefs }, f.material);
    expect(f.tx.message.findUnique).not.toHaveBeenCalled();
    expect(f.tx.artifact.findUniqueOrThrow).toHaveBeenCalledOnce();
    const messageLock = f.tx.$queryRaw.mock.calls.findIndex(([query]) =>
      (query as { sql?: string })?.sql?.includes('FROM "messages"'),
    );
    expect(
      f.tx.$queryRaw.mock.calls.filter(([query]) =>
        (query as { sql?: string })?.sql?.includes('FROM "messages"'),
      ),
    ).toHaveLength(1);
    const fullRead = f.tx.message.findMany.mock.calls.findIndex(([args]) => "include" in args);
    expect(f.tx.message.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.$queryRaw.mock.invocationCallOrder[messageLock]!,
    );
    expect(f.tx.$queryRaw.mock.invocationCallOrder[messageLock]).toBeLessThan(
      f.tx.message.findMany.mock.invocationCallOrder[fullRead]!,
    );
    expect(f.provider).toHaveBeenCalledOnce();
  });

  it("rejects a foreign message before locking sources or loading their full content", async () => {
    const f = pdfFixture();
    f.humanMessages.set("jd-message", { id: "jd-message", threadId: "foreign-thread" });
    f.tx.thread.findFirst.mockImplementation(async ({ where }) =>
      where.id === "foreign-thread" ? { ...f.thread, userId: "foreign" } : f.thread,
    );
    await expect(
      recruiting.reviseRecruitingRole(
        f.prisma,
        actor,
        ReviseRecruitingRoleInput.parse({
          ...f.input,
          sourceRefs: [f.source, f.revisions[0]!.sourceRefs[0]!],
        }),
        f.material,
      ),
    ).rejects.toThrow(IsolationError);
    expect(
      f.tx.$queryRaw.mock.calls.filter(([query]) =>
        (query as { sql?: string })?.sql?.includes("FOR SHARE"),
      ),
    ).toHaveLength(0);
    expect(f.tx.message.findMany.mock.calls.some(([args]) => "include" in args)).toBe(false);
    expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
  });

  it.each(["foreign", "hash", "bytes", "provider-label", "provider-origin", "unreceipted"])(
    "rejects PDF %s before writing a revision",
    async (boundary) => {
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
      await expect(
        recruiting.reviseRecruitingRole(
          f.prisma,
          actor,
          { ...f.input, sourceRefs: [source] },
          f.material,
        ),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.recruitingRoleRevision.create).not.toHaveBeenCalled();
    },
  );
});

describe("keepNumberedTitle", () => {
  it("keeps the recruiter's numbered role name when a rename drops its number", () => {
    // Branch fosp 11-21 (479fde17): the rename to "Senior Data Engineer" lost 15261 and the role
    // was opened twice.
    const named = "测试固定 · 数据工程师 6 · 15261";
    expect(recruiting.keepNumberedTitle("Senior Data Engineer", named)).toBe(named);
    expect(recruiting.keepNumberedTitle("数据工程师 · 15261", named)).toBe("数据工程师 · 15261");
    expect(recruiting.keepNumberedTitle("Data Lead", "Data Engineer 2026")).toBe("Data Lead");
  });
});
