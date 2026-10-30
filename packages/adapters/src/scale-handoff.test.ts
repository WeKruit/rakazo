import { describe, expect, it } from "vitest";
import { scaleHandoffTooEarly } from "./executor.js";

function prisma(text: string, total: number) {
  const message = { blocks: [{ kind: "text", text }], createdAt: new Date() };
  return {
    thread: { findUnique: async () => ({ activeRecruitingRoleId: "role-1" }) },
    message: { findFirst: async () => message },
    recruitingCandidate: { count: async () => total },
  } as never;
}

describe("scale handoff", () => {
  it("keeps searching while the last wave still added people", async () => {
    const note = await scaleHandoffTooEarly(
      prisma("Find 500 people like them in total.", 113),
      "thread-1",
      [40, 60, 70, 78, 90, 100, 108, 113],
    );
    expect(note).toMatch(/still added 35 new people/);
    expect(note).toMatch(/numResults 100/);
  });

  it("hands off once a wave adds fewer than five", async () => {
    const note = await scaleHandoffTooEarly(
      prisma("Find 500 people like them in total.", 113),
      "thread-1",
      [109, 110, 111, 112, 113],
    );
    expect(note).toBeUndefined();
  });

  it("never hands off when the recruiter limited the search to the quick search", async () => {
    const note = await scaleHandoffTooEarly(
      prisma("Find 500 people in total, using the quick people search only.", 113),
      "thread-1",
      [113],
    );
    expect(note).toMatch(/limited this to the quick people search/);
  });

  it("does nothing once the target is met", async () => {
    const note = await scaleHandoffTooEarly(
      prisma("Find 100 people like them in total.", 120),
      "thread-1",
      [80, 90, 100, 110, 120],
    );
    expect(note).toBeUndefined();
  });
});
