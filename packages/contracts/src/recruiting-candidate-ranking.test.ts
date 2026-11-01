import { describe, expect, it } from "vitest";
import { recruitingCandidateRanking } from "./recruiting-candidate-ranking.js";

describe("saved candidate ranking", () => {
  it("uses Reviewer tier alone against the current role revision", () => {
    expect(
      recruitingCandidateRanking({
        sourceEffectId: "saved-effect",
        grade: "Promising",
        score: 2,
        roleRevisionId: "v2",
        currentRoleRevisionId: "v2",
        source: "reviewer",
      }).group,
    ).toBe("worth_talking");
    expect(
      recruitingCandidateRanking({
        sourceEffectId: "saved-effect",
        grade: "Promising",
        score: 99,
        roleRevisionId: "v1",
        currentRoleRevisionId: "v2",
        source: "reviewer",
      }).group,
    ).toBe("outdated");
    expect(
      recruitingCandidateRanking({
        sourceEffectId: "saved-effect",
        grade: "Strong",
        score: 99,
        roleRevisionId: "v2",
        currentRoleRevisionId: "v2",
        source: "provider",
      }).group,
    ).toBe("unreviewed");
    expect(
      recruitingCandidateRanking({
        sourceEffectId: "saved-effect",
        grade: null,
        score: null,
        roleRevisionId: null,
        currentRoleRevisionId: "v2",
        source: "none",
      }).score,
    ).toBeNull();
  });
});
