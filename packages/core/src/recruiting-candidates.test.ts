import { describe, expect, it } from "vitest";
import {
  normalizeRecruitingCandidateRow,
  projectRecruitingCandidateReport,
  RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS,
} from "./recruiting-candidates.js";

const candidate = {
  name: "Synthetic Engineer",
  linkedin_url: "https://www.linkedin.com/in/synthetic-engineer/?trk=example",
  current_title: "Software Engineer",
  current_company: "Example Robotics",
  location: "Example City",
  resume_url: null,
  evidence_urls: ["https://example.test/engineering"],
};
const normalize = (row: unknown) => normalizeRecruitingCandidateRow(row, { schemaKnown: true });

describe("canonical recruiting candidate output", () => {
  it("preserves only exact native rule statuses as display metadata without classifying prose or absence", () => {
    const row = {
      rule_positive: {
        value: "match",
        evidence: "Saved supporting evidence.",
        reasoning: "Original provider reasoning.",
      },
      rule_negative: { value: "miss" },
      rule_uncertain: { value: "unclear" },
      rule_boolean: { value: false },
      rule_absent: { absent: true },
      rule_absent_value: { value: "match", absent: true },
      rule_prose: { value: "MET in one area, PARTIAL in another." },
      fit_reasons: { value: "match" },
    };
    const original = structuredClone(row);
    const report = projectRecruitingCandidateReport(row);
    expect(
      report.fields
        .filter((field) => field.providerStatus)
        .map((field) => [field.value, field.providerStatus]),
    ).toEqual([
      ["match", "match"],
      ["miss", "miss"],
      ["unclear", "unclear"],
    ]);
    expect(report.fields.slice(0, 3).map((field) => field.label)).toEqual([
      "Positive",
      "Negative",
      "Uncertain",
    ]);
    expect(report.fields[6]?.label).toBe("Rule prose");
    expect(report.fields[0]).toMatchObject({
      evidence: row.rule_positive.evidence,
      reasoning: row.rule_positive.reasoning,
    });
    expect(report.fields.map((field) => field.value)).toEqual([
      "match",
      "miss",
      "unclear",
      "false",
      "true",
      "match",
      row.rule_prose.value,
      "match",
    ]);
    expect(row).toEqual(original);
  });
  it("projects the defined columns without treating a provider report as an assessment", () => {
    expect(normalize({ ...candidate, grade: "A", arbitrary_signal: true })).toEqual({
      name: candidate.name,
      title: candidate.current_title,
      company: candidate.current_company,
      location: candidate.location,
      linkedinUrl: candidate.linkedin_url,
      resumeUrl: null,
      evidenceUrls: candidate.evidence_urls,
      issues: [],
      candidateKey: "linkedin:/in/synthetic-engineer",
    });
  });

  it("reads native sourced cells without altering the retained row or source map", () => {
    const row = Object.freeze({
      ...Object.fromEntries(
        Object.entries(candidate).map(([key, value]) => [
          key,
          Object.freeze({ value, source_id: "s1" }),
        ]),
      ),
      _sources: Object.freeze({ s1: "https://example.test/engineering" }),
    });
    const before = JSON.stringify(row);
    expect(normalize(row)).toEqual(normalize(candidate));
    expect(JSON.stringify(row)).toBe(before);
  });

  it("uses the shared exact LinkedIn identity across query, case and trailing slash variants", () => {
    const variants = [
      "https://linkedin.com/in/Synthetic-Engineer",
      "https://www.linkedin.com/in/synthetic-engineer/?trk=other#about",
    ];
    expect(
      variants.map((linkedin_url) => normalize({ ...candidate, linkedin_url }).candidateKey),
    ).toEqual(["linkedin:/in/synthetic-engineer", "linkedin:/in/synthetic-engineer"]);
  });

  it("does not infer person identity from two people sharing an article", () => {
    const rows = ["Example One", "Example Two"].map((name) =>
      Object.freeze({
        ...candidate,
        name,
        linkedin_url: null,
        profile_url: Object.freeze({
          value: "https://example.test/interviews/two-people",
          source_id: "article",
        }),
      }),
    );
    const before = JSON.stringify(rows);
    expect(rows.map((row) => normalize(row).candidateKey)).toEqual([null, null]);
    expect(rows.map((row) => normalize(row).name)).toEqual(["Example One", "Example Two"]);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("keeps the LinkedIn profile key across evaluation changes without changing projected fields", () => {
    const profileUrl = "https://www.linkedin.com/in/Synthetic-Engineer/?trk=example#about";
    const first = Object.freeze({
      ...candidate,
      linkedin_url: null,
      profile_url: Object.freeze({ value: profileUrl, source_id: "first-cell" }),
      fit_reasons: "Initial provider observation",
    });
    const second = Object.freeze({
      ...first,
      profile_url: profileUrl,
      fit_reasons: "Updated provider observation",
    });
    const before = JSON.stringify([first, second]);
    expect(normalize(first).candidateKey).toBe("linkedin:/in/synthetic-engineer");
    expect(normalize(second).candidateKey).toBe(normalize(first).candidateKey);
    expect(normalize(first).linkedinUrl).toBeNull();
    expect(JSON.stringify([first, second])).toBe(before);
  });

  it("does not infer person identity from generic URLs, name or provenance", () => {
    const urls = [
      "http://profiles.example.test/People/Example?View=Full#About",
      "https://profiles.example.test/People/Example?View=Full#About",
      "https://profiles.example.test/people/Example?View=Full#About",
      "https://profiles.example.test/People/Example?View=Other#About",
      "https://profiles.example.test/People/Example?View=Full#Other",
    ];
    const keys = urls.map(
      (value) =>
        normalize({
          ...candidate,
          linkedin_url: null,
          profile_url: { value, source_id: "same-cell" },
        }).candidateKey,
    );
    expect(keys).toEqual(urls.map(() => null));
    expect(
      normalize({ ...candidate, linkedin_url: null, source_id: "same-cell" }).candidateKey,
    ).toBeNull();
  });

  it("does not infer person identity from invalid or inherited profile fields", () => {
    for (const profile_url of [
      null,
      undefined,
      { value: null, source_id: "person-looking-id" },
      { source_id: "https://profiles.example.test/person" },
      { value: ["https://profiles.example.test/person"] },
      Object.create({ value: "https://profiles.example.test/person" }),
      "not a URL",
      "javascript:alert(1)",
      "file:///private/person",
      "https://user:password@profiles.example.test/person",
    ])
      expect(normalize({ ...candidate, linkedin_url: null, profile_url }).candidateKey).toBeNull();
    const inherited = Object.assign(
      Object.create({ profile_url: "https://profiles.example.test/person" }),
      {
        ...candidate,
        linkedin_url: null,
      },
    );
    expect(normalize(inherited).candidateKey).toBeNull();
  });

  it("uses the same LinkedIn key from either declared field and rejects company profiles", () => {
    const profile_url = "https://linkedin.com/in/Synthetic-Engineer/?trk=other#about";
    expect(normalize({ ...candidate, linkedin_url: null, profile_url }).candidateKey).toBe(
      "linkedin:/in/synthetic-engineer",
    );
    expect(normalize({ ...candidate, linkedin_url: null, profile_url }).linkedinUrl).toBeNull();
    expect(
      normalize({ ...candidate, profile_url: "https://profiles.example.test/another" })
        .candidateKey,
    ).toBe("linkedin:/in/synthetic-engineer");
    for (const invalid of [
      "https://linkedin.com/company/example",
      "http://linkedin.com/in/example",
      "https://linkedin.com:8443/in/example",
      "https://linkedin.com/in/example/extra",
      "https://uk.linkedin.com/in/example",
      "https://linkedin.com./company/example",
    ])
      expect(
        normalize({ ...candidate, linkedin_url: null, profile_url: invalid }).candidateKey,
      ).toBeNull();
  });

  it("never finds identity or names by scanning aliases or unrelated source links", () => {
    const result = normalize({
      full_name: candidate.name,
      profile: candidate.linkedin_url,
      _sources: { source: candidate.linkedin_url },
    });
    expect(result.candidateKey).toBeNull();
    expect(result.name).toBeNull();
    expect(result.linkedinUrl).toBeNull();
    expect(result.issues).toContain("missing_field:name");
    expect(result.issues).toContain("missing_field:linkedin_url");
  });

  it("preserves null unknowns separately from a known empty evidence list", () => {
    const unknown = normalize({
      name: null,
      linkedin_url: null,
      current_title: null,
      current_company: null,
      location: null,
      resume_url: null,
      evidence_urls: null,
    });
    expect(unknown.issues).toEqual([]);
    expect(unknown.evidenceUrls).toBeNull();
    expect(unknown.candidateKey).toBeNull();
    expect(normalize({ ...candidate, evidence_urls: [] }).evidenceUrls).toEqual([]);
  });

  it("keeps independently valid fields when a row violates the schema", () => {
    const result = normalize({ ...candidate, name: 42, current_title: { unexpected: "title" } });
    expect(result.name).toBeNull();
    expect(result.title).toBeNull();
    expect(result.company).toBe(candidate.current_company);
    expect(result.candidateKey).toBe("linkedin:/in/synthetic-engineer");
    expect(result.issues).toEqual(["invalid_field:name", "invalid_field:current_title"]);
  });

  it("does not render unsafe or non-profile URLs as candidate identity", () => {
    for (const linkedin_url of [
      "javascript:alert(1)",
      "http://linkedin.com/in/synthetic-engineer",
      "https://linkedin.com.evil.test/in/synthetic-engineer",
      "https://linkedin.com/company/example",
      "https://user:password@linkedin.com/in/example",
      "https://linkedin.com:8443/in/example",
      "https://linkedin.com/in/example/extra",
    ]) {
      const result = normalize({ ...candidate, linkedin_url });
      expect(result.linkedinUrl).toBeNull();
      expect(result.candidateKey).toBeNull();
      expect(result.issues).toContain("invalid_url:linkedin_url");
    }
    const invalidSources = normalize({
      ...candidate,
      resume_url: "file:///private/resume.pdf",
      evidence_urls: ["javascript:alert(1)"],
    });
    expect(invalidSources.resumeUrl).toBeNull();
    expect(invalidSources.evidenceUrls).toBeNull();
    expect(invalidSources.issues).toContain("invalid_url:resume_url");
    expect(invalidSources.issues).toContain("invalid_url:evidence_urls");
  });

  it("does not read inherited row fields or stringify structured values", () => {
    const { name: inherited, ...own } = candidate;
    const row = Object.assign(Object.create({ name: inherited }), own);
    const result = normalize(row);
    expect(result.name).toBeNull();
    expect(result.issues).toContain("missing_field:name");
    expect(normalize({ ...candidate, name: "  " }).issues).toContain("blank_field:name");
  });

  it("does not assign a new schema to historical responses", () => {
    expect(normalizeRecruitingCandidateRow(candidate, { schemaKnown: false })).toEqual({
      name: null,
      title: null,
      company: null,
      location: null,
      linkedinUrl: null,
      resumeUrl: null,
      evidenceUrls: null,
      issues: ["historical_schema_unknown"],
      candidateKey: null,
    });
  });

  it("records an invalid row without inventing a candidate profile", () => {
    const result = normalize(null);
    expect(result.name).toBeNull();
    expect(result.candidateKey).toBeNull();
    expect(result.issues).toEqual(["invalid_row"]);
  });

  it("puts the actual canonical field contract into the requested output", () => {
    expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain("candidate_output_v1");
    for (const key of Object.keys(candidate))
      expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain(`"${key}"`);
    expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain("null");
    expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain("provider_report");
  });

  it("asks for the profile columns the profile view renders", () => {
    for (const column of [
      "experience: list[str]",
      "education: list[str]",
      "profile_image_url",
      "current_company_url",
      "current_company_industry",
      "current_company_size",
      "headline",
      "highlights",
      "key_works",
      "concerns",
      "criteria_brief",
      "entities",
    ])
      expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain(column);
  });
});
