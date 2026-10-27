import { describe, expect, it, vi } from "vitest";
import { fillRecruitingRoleArgs } from "./recruiting.js";

const actor = { spaceId: "space-1", userId: "user-1", email: "", isDeploymentOwner: false };
const hash = "a".repeat(64);
const receipt = {
  reader: "web_fetch",
  artifact: { artifactId: "artifact-1", sha256: hash },
  url: "https://jobs.example.com/role/1",
  readAt: "2026-10-26T03:38:20.000Z",
};
const human = (id: string, text: string) => ({
  id,
  role: "user",
  botId: null,
  clientNonce: null,
  externalTranscriptFor: null,
  blocks: [{ kind: "text", text }],
});

function prisma({
  activeRoleId = null as string | null,
  events = [receipt] as unknown[],
  messages = [] as unknown[],
  outside = [] as string[],
} = {}) {
  return {
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        spaceId: "space-1",
        userId: "user-1",
        activeRecruitingRoleId: activeRoleId,
      })),
    },
    artifact: { findMany: vi.fn(async () => [{ id: "artifact-1", hash }]) },
    event: { findMany: vi.fn(async () => events.map((payload) => ({ payload }))) },
    message: {
      // An id lookup finds every message in this conversation except the ones named outside.
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id
          ? where.id.in.filter((id) => !outside.includes(id)).map((id) => ({ id }))
          : messages,
      ),
      findFirst: vi.fn(async () => ({ id: "latest-human" })),
    },
    recruitingRole: { findFirst: vi.fn(async () => null) },
    recruitingRoleRevision: { findUnique: vi.fn(async () => null) },
  } as never;
}

// The link-intake source as the model wrote it on 2026-10-26 (url, time, fingerprint, locator off).
const jd = {
  id: "jd",
  kind: "original_material",
  readState: "read",
  url: "https://jobs.example.com/role/1/",
  readAt: "2026-10-26T03:38:20Z",
  quote: "Build simulation",
  anchor: { kind: "artifact", artifact: { artifactId: "artifact-1", sha256: "b".repeat(64) } },
};
const criterion = (id: string, priority: "hard" | "preferred", sourceRefs: unknown[] = [jd]) => ({
  id,
  priority,
  expression: { kind: "atom", id: `${id}-atom`, statement: id },
  sourceRefs,
  definitionQuestions: [],
});
const context = { threadId: "thread-1" };

describe("fillRecruitingRoleArgs", () => {
  it("takes a read page's fingerprint, locator, url and time from the server's own records", async () => {
    const args = { operation: "create", sourceRefs: [jd], criteria: [] };
    const filled = await fillRecruitingRoleArgs(prisma(), actor, context, args);
    expect(filled.sourceRefs).toEqual([
      {
        ...jd,
        url: receipt.url,
        readAt: receipt.readAt,
        anchor: {
          kind: "artifact",
          artifact: { artifactId: "artifact-1", sha256: hash },
          locator: "text",
        },
      },
    ]);
  });

  it("acts on the conversation's role when the model mistypes its id", async () => {
    const args = { operation: "update", roleId: "d8399cf9-93e7-407f-b2a5-af4d7f4520da" };
    const filled = await fillRecruitingRoleArgs(
      prisma({ activeRoleId: "d8399cf9-93e7-409f-b2a5-af4d7f4520da" }),
      actor,
      context,
      args,
    );
    expect(filled.roleId).toBe("d8399cf9-93e7-409f-b2a5-af4d7f4520da");
  });

  it("cites the recruiter's message for an invented id and the JD for a JD fact", async () => {
    const brief = {
      searchFilters: [],
      questions: [],
      rules: [],
      fields: [
        {
          key: "salary",
          value: "$150k",
          origin: "user_instruction",
          state: "known",
          sourceRefIds: ["human-salary"],
        },
        {
          key: "location",
          value: "Atlanta",
          origin: "jd",
          state: "known",
          sourceRefIds: ["jd-location"],
        },
      ],
    };
    const filled = await fillRecruitingRoleArgs(
      prisma({ messages: [human("m2", "Atlanta onsite"), human("m1", "Budget is $150k")] }),
      actor,
      context,
      { operation: "create", sourceRefs: [jd], criteria: [], brief },
    );
    const fields = (filled.brief as { fields: { sourceRefIds: string[] }[] }).fields;
    expect(fields.map((field) => field.sourceRefIds)).toEqual([["human-message:m1"], ["jd"]]);
  });

  it("adds the rule each criterion's priority implies when the brief leaves it out", async () => {
    const brief = { searchFilters: [], questions: [], fields: [], rules: [] };
    const filled = await fillRecruitingRoleArgs(prisma(), actor, context, {
      operation: "create",
      sourceRefs: [jd],
      criteria: [criterion("years", "hard"), criterion("chinese", "preferred")],
      brief,
    });
    expect((filled.brief as { rules: unknown[] }).rules).toEqual([
      { criterionId: "years", origin: "jd", effect: "reject", sourceRefIds: ["jd"] },
      { criterionId: "chinese", origin: "jd", effect: "flag", sourceRefIds: ["jd"] },
    ]);
  });

  it("leaves reads, binds and references it cannot resolve unchanged", async () => {
    expect(await fillRecruitingRoleArgs(prisma(), actor, context, { operation: "read" })).toEqual({
      operation: "read",
    });
    const message = {
      id: "m",
      kind: "user_instruction",
      anchor: { kind: "message", messageId: "x" },
    };
    const args = { operation: "create", sourceRefs: [message], criteria: [] };
    expect(await fillRecruitingRoleArgs(prisma({ events: [] }), actor, context, args)).toEqual(
      args,
    );
  });

  it("cites and rules a brief that leaves out every citation and rule", async () => {
    const filled = await fillRecruitingRoleArgs(
      prisma({ messages: [human("m2", "仅旧金山湾区"), human("m1", "不要求特定语言")] }),
      actor,
      context,
      {
        operation: "create",
        sourceRefs: [jd],
        criteria: [criterion("sim", "hard")],
        brief: {
          fields: [
            {
              key: "language",
              value: "不要求特定语言",
              origin: "user_instruction",
              state: "known",
            },
            { key: "focus", value: "Simulation", origin: "jd", state: "known" },
            { key: "salary", value: null, origin: "jd", state: "missing" },
          ],
          searchFilters: [
            { id: "bay", statement: "仅旧金山湾区", mode: "include", origin: "user_instruction" },
          ],
        },
      },
    );
    const brief = filled.brief as Record<string, { sourceRefIds?: string[] }[]>;
    expect(brief.fields!.map((field) => field.sourceRefIds)).toEqual([
      ["human-message:m1"],
      ["jd"],
      [],
    ]);
    expect(brief.searchFilters![0]!.sourceRefIds).toEqual(["human-message:m2"]);
    expect(brief.rules).toEqual([
      { criterionId: "sim", origin: "jd", effect: "reject", sourceRefIds: ["jd"] },
    ]);
  });

  // A made-up message id cites the recruiter's latest message as a plain locator.
  it("re-points a citation of a message outside this conversation", async () => {
    const made = {
      id: "human-salary",
      kind: "original_material",
      anchor: { kind: "message", messageId: "human-salary", locator: "blocks[0].text" },
      readState: "read",
      readAt: "2026-10-27T16:28:00.000Z",
      quote: "US$51K–68K",
    };
    const filled = await fillRecruitingRoleArgs(
      prisma({ events: [], outside: ["human-salary"] }),
      actor,
      context,
      { operation: "create", sourceRefs: [made], criteria: [] },
    );
    const { quote: _quote, ...rest } = made;
    expect(filled.sourceRefs).toEqual([
      {
        ...rest,
        anchor: { kind: "message", messageId: "latest-human", locator: "blocks[0].text" },
      },
    ]);
  });

  // 2026-10-26: roles with several page excerpts, or a JD pasted as a message, left JD facts uncited.
  it("cites the matching excerpt among several, and a pasted JD message, for an uncited JD fact", async () => {
    const title = { ...jd, id: "jd-title" };
    const duties = { ...jd, id: "jd-duties", quote: "Own sim-to-real evaluation" };
    const field = (value: string) => ({
      key: "core_duties",
      value,
      origin: "jd",
      state: "known",
      consequential: false,
      sourceRefIds: [],
    });
    const brief = (value: string) => ({ fields: [field(value)] });
    const paged = await fillRecruitingRoleArgs(prisma(), actor, context, {
      operation: "create",
      sourceRefs: [title, duties],
      criteria: [],
      brief: brief("sim-to-real"),
    });
    expect(
      (paged.brief as { fields: { sourceRefIds: string[] }[] }).fields[0]!.sourceRefIds,
    ).toEqual(["jd-duties"]);
    const pasted = {
      id: "human-message:m1",
      kind: "original_material",
      quote: "Research Scientist, Simulation",
      anchor: { kind: "message", messageId: "m1" },
    };
    const typed = await fillRecruitingRoleArgs(prisma({ events: [] }), actor, context, {
      operation: "create",
      sourceRefs: [pasted],
      criteria: [],
      brief: brief("Simulation research"),
    });
    expect(
      (typed.brief as { fields: { sourceRefIds: string[] }[] }).fields[0]!.sourceRefIds,
    ).toEqual(["human-message:m1"]);
  });

  // 2026-10-26: an update reused a saved source ID for a different quote and was rejected.
  it("gives a reused source ID on a different reference a fresh ID", async () => {
    const saved = { ...jd, id: "jd-quote-role", quote: "Build simulation" };
    const db = prisma({ activeRoleId: "role-1" }) as unknown as {
      recruitingRole: { findFirst: ReturnType<typeof vi.fn> };
      recruitingRoleRevision: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.recruitingRole.findFirst.mockResolvedValue({ currentRevisionId: "rev-1" });
    const savedFilled = (
      await fillRecruitingRoleArgs(db as never, actor, context, {
        operation: "create",
        sourceRefs: [saved],
        criteria: [],
      })
    ).sourceRefs as unknown[];
    db.recruitingRoleRevision.findUnique.mockResolvedValue({
      sourceRefs: savedFilled,
      criteria: [],
    });
    const other = { ...saved, quote: "Own sim-to-real evaluation" };
    const filled = await fillRecruitingRoleArgs(db as never, actor, context, {
      operation: "update",
      roleId: "role-1",
      criteria: {
        upsert: [criterion("ownership", "hard", [other]), criterion("sim", "hard", [saved])],
      },
    });
    const upsert = (
      filled.criteria as { upsert: { sourceRefs: { id: string; quote: string }[] }[] }
    ).upsert;
    expect(upsert.map((item) => item.sourceRefs[0]!.id)).toEqual([
      "jd-quote-role-2",
      "jd-quote-role",
    ]);
    expect(upsert[0]!.sourceRefs[0]!.quote).toBe(other.quote);
  });

  // 2026-10-26: an intake update asked a brief question about a field it had not defined.
  it("moves a question on a near-miss field key to that field and drops one on a missing field", async () => {
    const filled = await fillRecruitingRoleArgs(prisma(), actor, context, {
      operation: "create",
      sourceRefs: [jd],
      criteria: [],
      brief: {
        fields: [
          { key: "location", value: null, origin: "jd", state: "missing", sourceRefIds: [] },
        ],
        questions: [
          { id: "q1", fieldKey: "Locations", question: "Where?", answeredBySourceRefId: null },
          { id: "q2", fieldKey: "salary_range", question: "Pay?", answeredBySourceRefId: null },
        ],
      },
    });
    expect((filled.brief as { questions: unknown[] }).questions).toEqual([
      { id: "q1", fieldKey: "location", question: "Where?", answeredBySourceRefId: null },
    ]);
  });
});
