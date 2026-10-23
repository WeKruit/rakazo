import { describe, expect, it } from "vitest";
import { isMatchScoreKey, matchScore100, matchScoreScale } from "./match-score.js";
import { projectRecruitingCandidateReport } from "./recruiting-candidates.js";

describe("match scores on 0–100", () => {
  it("keeps a 0–100 result as is", () => {
    const scale = matchScoreScale([82, "74", { value: 9 }]);
    expect(scale).toBe(100);
    expect(matchScore100(9, scale)).toBe(9);
    expect(matchScore100("74", scale)).toBe(74);
  });

  it("converts a result answered on 0–10", () => {
    const scale = matchScoreScale([8, "7.5", { value: 6, source_id: "s1" }]);
    expect(scale).toBe(10);
    expect(matchScore100("7.5", scale)).toBe(75);
    expect(matchScore100({ value: 6 }, scale)).toBe(60);
  });

  it("converts 0–1 fractions and explicit denominators", () => {
    expect(matchScore100(0.72, matchScoreScale([0.72, 0.4]))).toBe(72);
    expect(matchScore100("8/10")).toBe(80);
    expect(matchScore100("85 / 100")).toBe(85);
    expect(matchScore100("5/6")).toBe(83);
    expect(matchScore100("72%")).toBe(72);
    expect(matchScore100("8.5分")).toBe(85);
  });

  it("leaves non-scores alone and clamps", () => {
    expect(matchScore100("Strong")).toBeNull();
    expect(matchScore100(null)).toBeNull();
    expect(matchScore100(-0.5, 100)).toBe(0);
    expect(matchScore100(140, 100)).toBe(100);
  });

  it("recognises score keys only", () => {
    expect(["match_score", "score", "fit_score", "matchScore"].every(isMatchScoreKey)).toBe(true);
    expect(["scorecard", "rank", "score_reason"].some(isMatchScoreKey)).toBe(false);
  });

  it("shows report score cells on the result's 0–100 scale", () => {
    const rows = [
      { name: "A", match_score: { value: 8, source_id: "s" }, rank: 1 },
      { name: "B", match_score: 6.5, rank: 2 },
    ];
    const field = (row: unknown, label: string) =>
      projectRecruitingCandidateReport(row, rows).fields.find((item) => item.label === label);
    expect(field(rows[0], "Match score")?.value).toBe("80");
    expect(field(rows[1], "Match score")?.value).toBe("65");
    expect(field(rows[1], "Rank")?.value).toBe("2");
    expect(
      projectRecruitingCandidateReport({ name: "C", match_score: 62 }).fields.find(
        (item) => item.label === "Match score",
      )?.value,
    ).toBe("62");
  });
});
