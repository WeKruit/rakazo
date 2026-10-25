import { describe, expect, it } from "vitest";
import type { ProfileCriterionRevision } from "./profile";
import { candidateSections, requirementRows, shortFact, withSavedProfile } from "./profile";

const ASSESSMENT =
  "R1: Fact - PhD EE Stanford and MS/PhD-level background. R2: Gap - no explicit named sim stack hands-on evidence. R3: Partial - large-scale simulation mentioned. R4: hands-on robotics; [Sources read 2026-10-20: LINKEDIN, https://example.test/a, https://example.test/b/]";

describe("requirementRows", () => {
  it("splits Autumn's R-numbered assessment into rows and keeps its words", () => {
    const { rows, sourceUrls } = requirementRows(ASSESSMENT);
    expect(rows.map((row) => [row.criterionId, row.status, row.text])).toEqual([
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
    expect(sections.requirements.map((row) => [row.label ?? row.criterionId, row.status])).toEqual([
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

const revision: ProfileCriterionRevision = {
  id: "revision-1",
  criteria: [
    {
      id: "R4",
      priority: "hard",
      expression: { kind: "atom", id: "cpp", statement: "C++ production systems" },
      sourceRefs: [],
      definitionQuestions: [],
    },
  ],
};

it("resolves exact source references using matching revision metadata while retaining counterevidence", () => {
  const sections = candidateSections(
    [
      {
        label: "Requirement assessment",
        value:
          "R4: Partial - C++ prototyping is described. Concern: production scale is unverified. R1: Unknown - No evidence.",
        sourceUrls: ["https://example.test/source"],
      },
      {
        label: "R4",
        value: "match",
        providerStatus: "match",
        evidence: "C++ services.",
        reasoning: "Counterevidence: maintenance ownership is not stated.",
        sourceUrls: [],
      },
    ],
    { roleRevisionId: "revision-1", revision },
  );
  expect(sections.requirements[0]).toMatchObject({
    label: "C++ production systems",
    criterionId: "R4",
    status: "match",
    text: "C++ services.\n\nCounterevidence: maintenance ownership is not stated.",
  });
  expect(sections.requirements[1]).toMatchObject({
    label: "C++ production systems",
    criterionId: "R4",
    status: "partial",
    text: "C++ prototyping is described. Concern: production scale is unverified.",
  });
  expect(sections.requirements[2]).toMatchObject({
    label: null,
    criterionId: "R1",
    status: "unknown",
  });
  expect(sections.skillEvidence[1]).toMatchObject({
    label: "C++ production systems",
    criterionId: "R4",
    sourceUrls: ["https://example.test/source"],
  });
});

it("keeps unresolved definitions honest when metadata is missing, stale, or a different exact ID", () => {
  for (const context of [
    undefined,
    { roleRevisionId: undefined, revision },
    { roleRevisionId: "older-revision", revision },
    {
      roleRevisionId: "revision-1",
      revision: { ...revision, criteria: [{ ...revision.criteria[0]!, id: "r4" }] },
    },
  ]) {
    const { rows } = requirementRows("R4: Partial - C++ research only.", context);
    expect(rows[0]).toMatchObject({
      label: null,
      criterionId: "R4",
      status: "partial",
      text: "C++ research only.",
    });
  }
  // An unrelated named source field is not renamed from a similarly worded role criterion.
  expect(
    candidateSections(
      [{ label: "C++", value: "unclear", providerStatus: "unclear", sourceUrls: [] }],
      { roleRevisionId: "revision-1", revision },
    ).requirements[0]?.label,
  ).toBe("C++");
});

it("does not turn one child of a composite definition into its criterion name", () => {
  const composite: ProfileCriterionRevision = {
    ...revision,
    criteria: [
      {
        ...revision.criteria[0]!,
        expression: { kind: "not", item: revision.criteria[0]!.expression },
      },
    ],
  };
  expect(
    requirementRows("R4: Unknown - Not assessed.", {
      roleRevisionId: "revision-1",
      revision: composite,
    }).rows[0],
  ).toMatchObject({ label: null, criterionId: "R4", status: "unknown" });
});

describe("candidateSections quick output", () => {
  it("reads the short headline, tags, works, concerns and criterion verdicts", () => {
    const field = (label: string, value: string) => ({ label, value, sourceUrls: [] });
    const sections = candidateSections([
      field("Headline", "斯坦福博士，移动操作一作"),
      field("Highlights", "斯坦福 CS 博士\n湾区\n"),
      field("Key works", "BRS | CoRL 2025 | 一作 | https://example.test/brs\nMoMaGen | ICLR 2026"),
      field("Concerns", "未提仿真栈"),
      field(
        "Entities",
        "Stanford University | school | https://www.stanford.edu | 湾区研究型大学\nNVIDIA | company | linkedin.com/company/nvidia |",
      ),
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
      entities: [
        {
          name: "Stanford University",
          kind: "school",
          host: "www.stanford.edu",
          description: "湾区研究型大学",
        },
        { name: "NVIDIA", kind: "company", host: null, description: null },
      ],
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
      entities: [],
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

describe("withSavedProfile", () => {
  it("leads with the saved full profile and drops the report fields it covers", () => {
    const fields = withSavedProfile(
      {
        personKey: "linkedin:/in/sam-example",
        provider: "example",
        fetchedAt: "2026-10-24T00:00:00.000Z",
        headline: null,
        profileImageUrl: "https://img.example/sam.jpg",
        experience: [
          {
            title: "Operations Manager",
            company_name: "Acme Logistics",
            company_url: "https://acme.example/",
            company_linkedin_url: null,
            company_logo_url: "https://img.example/acme.png",
            company_industry: "Logistics",
            company_size: "1,001-5,000",
            location: null,
            start_date: "2021-03",
            end_date: null,
            is_current: true,
            description: null,
          },
        ],
        education: [],
      },
      [
        { label: "Experience", value: "Manager at Acme (dates unknown)", sourceUrls: [] },
        { label: "Education", value: "State University", sourceUrls: [] },
      ],
    );
    expect(fields.map((field) => field.label)).toEqual([
      "Profile image url",
      "Current company url",
      "Current company industry",
      "Current company size",
      "Experience",
      "Education",
    ]);
    expect(fields[4]!.value).toBe("Operations Manager · Acme Logistics · 2021-03");
    expect(fields[5]!.value).toBe("State University");
    const sections = candidateSections(fields);
    expect(sections.photoUrl).toBe("https://img.example/sam.jpg");
    expect(withSavedProfile(null, fields.slice(5))).toEqual(fields.slice(5));
  });
});

describe("research findings", () => {
  it("hides provider names, links, bookkeeping and column names", () => {
    const sections = candidateSections([
      {
        label: "Company logo url",
        value: "https://crustdata-media.s3.amazonaws.com/logo.png",
        evidence: "logo_url in cached company provider record",
        sourceUrls: [],
      },
      { label: "Fit rationale", value: "Autumn: weak on ops", sourceUrls: [] },
      { label: "review_rationale_zh", value: "未核实线索（Autumn 排名 #7）", sourceUrls: [] },
      {
        label: "Selection basis",
        value: "Selected by existing Autumn rank order",
        sourceUrls: ["https://app.autumn.ai/x", "https://example.test/p"],
      },
    ]);
    const findings = sections.findings.map((field) => [field.label, field.value, field.sourceUrls]);
    expect(findings).toEqual([
      ["Fit rationale", "The search: weak on ops", []],
      ["Review rationale", "未核实线索（人才搜索排名 #7）", []],
      ["Selection basis", "Selected by existing search rank order", ["https://example.test/p"]],
    ]);
  });
});
