import { describe, expect, it } from "vitest";
import { candidateSections, requirementRows } from "./profile";

const ASSESSMENT =
  "R1: Fact - PhD EE Stanford and MS/PhD-level background. R2: Gap - no explicit named sim stack hands-on evidence. R3: Partial - large-scale simulation mentioned. R4: hands-on robotics; [Sources read 2026-10-20: LINKEDIN, https://example.test/a, https://example.test/b/]";

describe("requirementRows", () => {
  it("splits Autumn's R-numbered assessment into rows and keeps its words", () => {
    const { rows, sourceUrls } = requirementRows(ASSESSMENT);
    expect(rows.map((row) => [row.label, row.status, row.text])).toEqual([
      ["R1", "match", "PhD EE Stanford and MS/PhD-level background."],
      ["R2", "gap", "no explicit named sim stack hands-on evidence."],
      ["R3", "partial", "large-scale simulation mentioned."],
      ["R4", "unknown", "hands-on robotics"],
    ]);
    expect(sourceUrls).toEqual(["https://example.test/a", "https://example.test/b/"]);
  });

  it("keeps unsplittable text as one row and does not split on inline references", () => {
    const { rows } = requirementRows("Strong fit; gaps remain on R3/R5 as noted");
    expect(rows).toEqual([
      {
        key: "row:0",
        label: null,
        status: "unknown",
        text: "Strong fit; gaps remain on R3/R5 as noted",
        sourceUrls: [],
      },
    ]);
  });

  it("reads Chinese status words", () => {
    const { rows } = requirementRows("R1：符合 - 斯坦福博士；R2：缺口 - 没有仿真经验");
    expect(rows.map((row) => row.status)).toEqual(["match", "gap"]);
  });
});

describe("candidateSections", () => {
  it("moves assessment, scope and resume link out of research findings", () => {
    const sections = candidateSections([
      { label: "Ranking scope", value: "Rank within the first ten", sourceUrls: [] },
      { label: "Recommendation", value: "review", sourceUrls: [] },
      { label: "Requirement assessment", value: ASSESSMENT, sourceUrls: [] },
      { label: "Resume status", value: "available", sourceUrls: [] },
      { label: "Resume url", value: "https://example.test/cv.pdf", sourceUrls: [] },
      { label: "Hometown", value: "Somewhere", sourceUrls: [] },
      {
        label: "Robotics",
        value: "match",
        providerStatus: "match",
        evidence: "Built robots",
        sourceUrls: [],
      },
    ]);
    expect(sections.summary).toBe("review");
    expect(sections.scope).toBe("Rank within the first ten");
    expect(sections.resumeUrl).toBe("https://example.test/cv.pdf");
    expect(sections.requirements.map((row) => [row.label, row.status])).toEqual([
      ["Robotics", "match"],
      ["R1", "match"],
      ["R2", "gap"],
      ["R3", "partial"],
      ["R4", "unknown"],
    ]);
    expect(sections.findings.map((field) => field.label)).toEqual(["Hometown"]);
  });
});
