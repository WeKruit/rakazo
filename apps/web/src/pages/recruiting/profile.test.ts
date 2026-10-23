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

  it("does not turn an unknown assessment into a partial match or a gap", () => {
    const { rows } = requirementRows(
      "R1: Unknown - Rust not assessed. R2: Unclear - no evidence provided. R3: Partial match - Some Go experience. R4: Gap - Requirement not met.",
    );
    expect(rows.map((row) => row.status)).toEqual(["unknown", "unknown", "partial", "gap"]);
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

  it("preserves uncertainty, missing evidence, and counterevidence without recalculating matches", () => {
    const sections = candidateSections([
      { label: "Rust", value: "unclear", providerStatus: "unclear", sourceUrls: [] },
      {
        label: "Go",
        value: "match",
        providerStatus: "match",
        evidence: "Built services in Go.",
        reasoning: "Concern: production scale remains unverified.",
        sourceUrls: ["https://example.test/role"],
      },
      {
        label: "Kotlin",
        value: "miss",
        providerStatus: "miss",
        evidence: "No Kotlin experience reported.",
        sourceUrls: [],
      },
      { label: "Concern", value: null, reasoning: "Limited evidence of Rust use.", sourceUrls: [] },
    ]);
    expect(sections.requirements.map((row) => row.status)).toEqual(["unknown", "match", "gap"]);
    expect(sections.requirements[0]?.text).toBe("");
    expect(sections.requirements[1]?.text).toBe(
      "Built services in Go.\n\nConcern: production scale remains unverified.",
    );
    expect(sections.findings.map((field) => field.label)).toEqual(["Concern"]);
    expect(sections.skillEvidence.find((entry) => entry.label === "Concern")?.text).toBe(
      "Limited evidence of Rust use.",
    );
  });

  it("keeps skill concerns as research context and retains summary reasoning", () => {
    const sections = candidateSections([
      { label: "Technical skills", value: "Go, SQL", sourceUrls: [] },
      { label: "Skill concerns", value: "No evidence of Rust use", sourceUrls: [] },
      {
        label: "Recommendation",
        value: "Review",
        reasoning: "Concern: Go scale is unknown.",
        sourceUrls: [],
      },
    ]);
    expect(sections.skills).toEqual(["Go", "SQL"]);
    expect(sections.findings.map((field) => field.label)).toEqual(["Skill concerns"]);
    expect(sections.summary).toBe("Review\n\nConcern: Go scale is unknown.");
    expect(sections.skillEvidence.find((entry) => entry.label === "Skill concerns")?.kind).toBe(
      "profile",
    );
  });

  it("keeps each source context and citation attached without treating a listed skill as proof", () => {
    const sections = candidateSections([
      { label: "Skills", value: "Go, Kotlin", sourceUrls: ["https://example.test/profile"] },
      {
        label: "Requirement assessment",
        value:
          "R1: Partial - Go used in a side project. [Sources read: https://example.test/project]",
        sourceUrls: [],
      },
      {
        label: "Requirement assessment",
        value: "R1: Unknown - Kotlin not assessed.",
        sourceUrls: ["https://example.test/report"],
      },
      { label: "Email", value: "go@example.test", sourceUrls: [] },
    ]);
    const contexts = sections.skillEvidence;
    expect(contexts.find((entry) => entry.kind === "listed")).toMatchObject({
      label: "Skills",
      text: "Go, Kotlin",
    });
    expect(contexts.find((entry) => entry.text.includes("side project"))?.sourceUrls).toEqual([
      "https://example.test/project",
    ]);
    expect(contexts.find((entry) => entry.text.includes("not assessed"))?.sourceUrls).toEqual([
      "https://example.test/report",
    ]);
    expect(contexts.some((entry) => entry.label === "Email")).toBe(false);
    expect(new Set(contexts.map((entry) => entry.key)).size).toBe(contexts.length);
  });
});
