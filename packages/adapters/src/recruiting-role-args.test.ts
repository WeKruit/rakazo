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
});
