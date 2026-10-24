import { describe, expect, it } from "vitest";
import { candidateSections, requirementRows, shortFact } from "./profile";

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
  it("reads the photo and current company facts out of research findings", () => {
    const field = (label: string, value: string) => ({ label, value, sourceUrls: [] });
    const sections = candidateSections([
      field("Profile image url", "https://img.example/p.jpg"),
      field("Current company url", "www.acme.example"),
      field("Current company industry", "Robotics"),
      field("Current company size", "1,001-5,000"),
      field("Other", "kept"),
    ]);
    expect(sections.photoUrl).toBe("https://img.example/p.jpg");
    expect(sections.company).toEqual({
      host: "www.acme.example",
      industry: "Robotics",
      size: "1,001-5,000",
    });
    expect(sections.findings.map((item) => item.label)).toEqual(["Other"]);
    expect(
      candidateSections([field("Profile image url", "http://img.example/p.jpg")]).photoUrl,
    ).toBeNull();
  });

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

  it("reads the short headline, tags, works, concerns and criterion verdicts", () => {
    const field = (label: string, value: string) => ({ label, value, sourceUrls: [] });
    const sections = candidateSections([
      field("Headline", "斯坦福博士，移动操作一作"),
      field("Highlights", "斯坦福 CS 博士\n湾区\n"),
      field("Key works", "BRS | CoRL 2025 | 一作 | https://example.test/brs\nMoMaGen | ICLR 2026"),
      field("Concerns", "未提仿真栈"),
      field(
        "Criteria brief",
        "rule_bay_area_based | 常驻湾区 | 人在湾区\nrule_sim_stack | 仿真栈 |",
      ),
      {
        label: "Bay area based",
        value: "match",
        providerStatus: "match" as const,
        reasoning: "Stanford is in the Bay Area.",
        sourceUrls: [],
      },
      {
        label: "Sim stack",
        value: "unclear",
        providerStatus: "unclear" as const,
        sourceUrls: [],
      },
      field("Hometown", "Somewhere"),
    ]);
    expect(sections.quick).toEqual({
      headline: "斯坦福博士，移动操作一作",
      highlights: ["斯坦福 CS 博士", "湾区"],
      keyWorks: [
        { title: "BRS", detail: "CoRL 2025 · 一作", url: "https://example.test/brs" },
        { title: "MoMaGen", detail: "ICLR 2026", url: null },
      ],
      concerns: ["未提仿真栈"],
    });
    expect(sections.requirements.map((row) => [row.label, row.brief, row.text])).toEqual([
      ["Bay area based", { name: "常驻湾区", verdict: "人在湾区" }, "Stanford is in the Bay Area."],
      ["Sim stack", { name: "仿真栈", verdict: null }, ""],
    ]);
    expect(sections.findings.map((item) => item.label)).toEqual(["Hometown"]);
  });

  it("leaves the short output empty for older candidates", () => {
    expect(candidateSections([]).quick).toEqual({
      headline: null,
      highlights: [],
      keyWorks: [],
      concerns: [],
    });
  });
});

describe("shortFact", () => {
  it("keeps the lead clause of a provider note", () => {
    expect(shortFact("Transportation, Logistics (provider label). Long blurb.")).toBe(
      "Transportation, Logistics",
    );
    expect(shortFact("812 employees (provider-reported count, checked 2026-10-24)")).toBe(
      "812 employees",
    );
    expect(shortFact("1,001-5,000")).toBe("1,001-5,000");
    expect(shortFact("  ")).toBeNull();
  });
});
