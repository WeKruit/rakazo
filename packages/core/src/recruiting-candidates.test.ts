import { describe, expect, it } from "vitest";
import {
  normalizeRecruitingCandidateRow,
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
      candidateIdentity: "/in/synthetic-engineer",
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
      variants.map((linkedin_url) => normalize({ ...candidate, linkedin_url }).candidateIdentity),
    ).toEqual(["/in/synthetic-engineer", "/in/synthetic-engineer"]);
  });

  it("never finds identity or names by scanning aliases or unrelated source links", () => {
    const result = normalize({
      full_name: candidate.name,
      profile: candidate.linkedin_url,
      _sources: { source: candidate.linkedin_url },
    });
    expect(result.candidateIdentity).toBeNull();
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
    expect(unknown.candidateIdentity).toBeNull();
    expect(normalize({ ...candidate, evidence_urls: [] }).evidenceUrls).toEqual([]);
  });

  it("keeps independently valid fields when a row violates the schema", () => {
    const result = normalize({ ...candidate, name: 42, current_title: { unexpected: "title" } });
    expect(result.name).toBeNull();
    expect(result.title).toBeNull();
    expect(result.company).toBe(candidate.current_company);
    expect(result.candidateIdentity).toBe("/in/synthetic-engineer");
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
      expect(result.candidateIdentity).toBeNull();
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
      candidateIdentity: null,
    });
  });

  it("records an invalid row without inventing a candidate profile", () => {
    const result = normalize(null);
    expect(result.name).toBeNull();
    expect(result.candidateIdentity).toBeNull();
    expect(result.issues).toEqual(["invalid_row"]);
  });

  it("puts the actual canonical field contract into the requested output", () => {
    expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain("candidate_output_v1");
    for (const key of Object.keys(candidate))
      expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain(`"${key}"`);
    expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain("null");
    expect(RECRUITING_CANDIDATE_OUTPUT_INSTRUCTIONS).toContain("provider_report");
  });
});
