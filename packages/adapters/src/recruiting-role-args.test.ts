import { IsolationError, RecruitingIntentQuoteError } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { normalizeRecruitingRoleArgs, repairedRoleSave } from "./recruiting-tools.js";

const now = "2026-10-25T20:00:00.000Z";
const messageRef = (readAt: string | null) => ({
  id: "scope",
  kind: "original_material",
  anchor: { kind: "message", messageId: "m1", locator: "blocks[0].text" },
  readState: "read",
  readAt,
  quote: "Austin metro",
});

describe("normalizeRecruitingRoleArgs", () => {
  it("drops extra keys from a read", () => {
    expect(normalizeRecruitingRoleArgs({ operation: "read", roleId: "r1" }, now)).toEqual({
      operation: "read",
    });
  });

  it("fills a missing read time on references", () => {
    const artifactRef = {
      ...messageRef("2026-10-25T18:00:00.000Z"),
      anchor: {
        kind: "artifact",
        artifact: { artifactId: "a1", sha256: "f".repeat(64) },
        locator: "text",
      },
    };
    const result = normalizeRecruitingRoleArgs(
      {
        operation: "update",
        sourceRefs: [messageRef(null), artifactRef],
        criteria: { upsert: [{ id: "c1", sourceRefs: [messageRef("2026-10-25T19:00:00.000Z")] }] },
      },
      now,
    );
    expect(result).toEqual({
      operation: "update",
      sourceRefs: [messageRef(now), artifactRef],
      criteria: { upsert: [{ id: "c1", sourceRefs: [messageRef("2026-10-25T19:00:00.000Z")] }] },
    });
  });

  it("moves brief lists the model wrote next to the brief into it (2026-10-26 04:25 link role)", () => {
    const filter = {
      id: "bay-area",
      statement: "Bay Area",
      mode: "include",
      origin: "user_instruction",
      sourceRefIds: [],
    };
    const result = normalizeRecruitingRoleArgs(
      {
        operation: "update",
        roleId: "r1",
        expectedRevision: 1,
        brief: { fields: [], questions: [], definitionQuestions: [] },
        searchFilters: [filter],
        rules: [],
      },
      now,
    );
    expect(result).toEqual({
      operation: "update",
      roleId: "r1",
      expectedRevision: 1,
      definitionQuestions: [],
      brief: { fields: [], questions: [], searchFilters: [filter], rules: [] },
    });
  });

  // 2026-10-26: an update nested brief, expectedRevision and definitionQuestions inside criteria.
  it("moves call keys an update wrote inside criteria back to the call", () => {
    const upsert = [{ id: "c1" }];
    expect(
      normalizeRecruitingRoleArgs(
        {
          operation: "update",
          roleId: "r1",
          criteria: { upsert, expectedRevision: 2, definitionQuestions: [], brief: { fields: [] } },
        },
        now,
      ),
    ).toEqual({
      operation: "update",
      roleId: "r1",
      expectedRevision: 2,
      definitionQuestions: [],
      criteria: { upsert },
      brief: { fields: [] },
    });
    expect(
      normalizeRecruitingRoleArgs({ operation: "update", criteria: { expectedRevision: 1 } }, now),
    ).toEqual({ operation: "update", expectedRevision: 1 });
  });

  it("leaves a brief's omitted lists to the schema defaults and operations without a brief alone", () => {
    expect(
      normalizeRecruitingRoleArgs({ operation: "create", brief: { fields: [] } }, now),
    ).toEqual({ operation: "create", brief: { fields: [] } });
    const archive = { operation: "archive", roleId: "r1", expectedRevision: 2 };
    expect(normalizeRecruitingRoleArgs(archive, now)).toEqual(archive);
  });
});

// 2026-10-27 16:28, LA attachment role: the file citation failed the tool's format check
// (anchor kind, messageId, sha256) and the role was never saved.
describe("source reference repair", () => {
  it("puts a malformed file citation into the schema's shape", () => {
    const result = normalizeRecruitingRoleArgs(
      {
        operation: "create",
        title: "TikTok Live Commerce Operations Specialist",
        sourceRefs: [
          {
            id: "jd",
            kind: "original_material",
            anchor: { kind: "file", artifactId: "a1", sha256: "not-a-hash", page: 1 },
            readState: "read",
            quote: "City of Industry",
          },
          { id: "junk", kind: "original_material", anchor: { kind: "file" } },
        ],
        criteria: [{ id: "c1", sourceRefs: [{ id: "x" }] }],
      },
      now,
    );
    const jd = {
      id: "jd",
      kind: "original_material",
      anchor: {
        kind: "artifact",
        artifact: { artifactId: "a1", sha256: "0".repeat(64) },
        locator: "text",
      },
      readState: "read",
      readAt: now,
      quote: "City of Industry",
    };
    expect(result.sourceRefs).toEqual([jd]);
    // A criterion whose only citation names nothing keeps the role's first one.
    expect(result.criteria).toEqual([{ id: "c1", sourceRefs: [jd] }]);
  });

  it("keeps a message citation and drops a quote on unread material", () => {
    const result = normalizeRecruitingRoleArgs(
      {
        operation: "create",
        sourceRefs: [{ anchor: { messageId: "m1" }, readState: "unread", quote: "x", extra: 1 }],
      },
      now,
    );
    expect(result.sourceRefs).toEqual([
      {
        id: "source-1",
        kind: "original_material",
        anchor: { kind: "message", messageId: "m1", locator: "blocks[0].text" },
        readState: "unread",
        readAt: null,
      },
    ]);
  });
});

describe("repairedRoleSave", () => {
  const args = {
    operation: "create",
    title: "Role",
    intent: { basis: "direct", quote: "find people" },
    sourceRefs: [{ ...messageRef(now) }],
    criteria: [{ id: "c1", sourceRefs: [{ ...messageRef(now) }] }],
  };

  it("repeats a refused save with citations as locators", () => {
    const { quote: _quote, ...locator } = messageRef(now);
    expect(repairedRoleSave(args, new IsolationError())).toEqual({
      ...args,
      sourceRefs: [locator],
      criteria: [{ id: "c1", sourceRefs: [locator] }],
    });
  });

  it("uses the recruiter's own words when the intent quote was mistyped", () => {
    const repeat = repairedRoleSave(
      { ...args, sourceRefs: [], criteria: [] },
      new RecruitingIntentQuoteError("然后呢 继续找吗？"),
    );
    expect(repeat?.intent).toEqual({ basis: "direct", quote: "然后呢 继续找吗？" });
  });

  it("does not repeat a conflict, a read or a save it would not change", () => {
    expect(repairedRoleSave(args, new Error("Recruiting revision changed"))).toBeUndefined();
    expect(repairedRoleSave({ operation: "read" }, new IsolationError())).toBeUndefined();
    expect(
      repairedRoleSave({ ...args, sourceRefs: [], criteria: [] }, new IsolationError()),
    ).toBeUndefined();
  });
});
