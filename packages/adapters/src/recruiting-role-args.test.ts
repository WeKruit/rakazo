import { describe, expect, it } from "vitest";
import { normalizeRecruitingRoleArgs } from "./recruiting-tools.js";

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

  it("fills a missing read time on human-message references only", () => {
    const artifactRef = {
      ...messageRef(null),
      anchor: { kind: "artifact", artifact: {}, locator: "text" },
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
