import { RecruitingRoleToolInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { mergeRecruitingRoleUpdate } from "./recruiting.js";

const source = (id: string, quote: string) => ({
  id,
  kind: "original_material" as const,
  anchor: { kind: "message" as const, messageId: "message", locator: "blocks[0].text" },
  readState: "read" as const,
  readAt: "2026-10-22T00:00:00.000Z",
  quote,
});
const criterion = (id: string, priority: "hard" | "preferred", statement: string) => ({
  id,
  priority,
  expression: { kind: "atom" as const, id: `${id}-atom`, statement },
  sourceRefs: [source(`${id}-source`, statement)],
  definitionQuestions: [],
});
const current = {
  role: {
    id: "role",
    spaceId: "space",
    userId: "human",
    sourceThreadId: "thread",
    title: "Senior Backend Engineer",
    revision: 3,
    currentRevisionId: "revision-3",
  },
  revision: {
    id: "revision-3",
    roleId: "role",
    revision: 3,
    brief: null,
    sourceRefs: [source("jd", "Senior Backend Engineer")],
    criteria: [criterion("go", "hard", "Go or Rust"), criterion("kafka", "preferred", "Kafka")],
    preferences: ["Fintech background"],
    definitionQuestions: ["Salary range?"],
    createdAt: "2026-10-22T00:00:00.000Z",
  },
} as unknown as Parameters<typeof mergeRecruitingRoleUpdate>[0];
const intent = { basis: "direct" as const, quote: "Make Kafka required" };

describe("partial recruiting role update", () => {
  it("parses a changed-fields-only update", () => {
    expect(
      RecruitingRoleToolInputSchema.parse({
        operation: "update",
        roleId: "role",
        expectedRevision: 3,
        intent,
        criteria: { upsert: [criterion("kafka", "hard", "Kafka")] },
      }).operation,
    ).toBe("update");
  });

  it("changes only the supplied fields of the expected revision", () => {
    const merged = mergeRecruitingRoleUpdate(current, {
      operation: "update",
      roleId: "role",
      expectedRevision: 3,
      intent,
      criteria: { upsert: [criterion("kafka", "hard", "Kafka")], remove: [] },
    });
    expect(merged).toMatchObject({
      operation: "revise",
      roleId: "role",
      expectedRevision: 3,
      title: "Senior Backend Engineer",
      preferences: ["Fintech background"],
      definitionQuestions: ["Salary range?"],
      intent,
    });
    expect(merged.criteria.map((item) => [item.id, item.priority])).toEqual([
      ["go", "hard"],
      ["kafka", "hard"],
    ]);
    expect(merged.sourceRefs.map((ref) => ref.id)).toEqual(["jd"]);
  });

  it("adds, removes and replaces by ID without reordering kept criteria", () => {
    const merged = mergeRecruitingRoleUpdate(current, {
      operation: "update",
      roleId: "role",
      expectedRevision: 3,
      intent,
      criteria: { upsert: [criterion("pg", "hard", "Postgres")], remove: ["kafka"] },
      preferences: [],
    });
    expect(merged.criteria.map((item) => item.id)).toEqual(["go", "pg"]);
    expect(merged.preferences).toEqual([]);
  });

  it("starts the new revision's saved brief unconfirmed", () => {
    const confirmed = structuredClone(current) as typeof current;
    (confirmed.revision as { brief: unknown }).brief = {
      searchFilters: [],
      questions: [],
      fields: [],
      rules: [],
      confirmation: {
        revision: 3,
        userId: "human",
        messageId: "m",
        confirmedAt: "2026-10-22T00:00:00.000Z",
      },
    };
    const merged = mergeRecruitingRoleUpdate(confirmed, {
      operation: "update",
      roleId: "role",
      expectedRevision: 3,
      intent,
      title: "Staff Backend Engineer",
    });
    expect(merged.title).toBe("Staff Backend Engineer");
    expect(merged.brief).not.toHaveProperty("confirmation");
  });
});
