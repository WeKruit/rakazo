import { RecruitingCandidateReportSchema, recruitingCandidateSourceText } from "@rakazo/contracts";
import { projectRecruitingCandidateReport } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { richProfileRow } from "./__fixtures__/profile-history";
import { candidateSections, storedProfileFields } from "./profile";
import { profileAssets, profileContentFields } from "./profileAssets";
import { structuredProfileTimeline } from "./profileTimeline";

describe("retained profile history projection", () => {
  it("preserves nested source cells through report serialization and renders explicit records", () => {
    const before = JSON.stringify(richProfileRow);
    const report = RecruitingCandidateReportSchema.parse(
      JSON.parse(JSON.stringify(projectRecruitingCandidateReport(richProfileRow))),
    );
    const sections = candidateSections(profileContentFields(report.fields));
    const experience = sections.experience.find((field) => field.structuredValue !== undefined)!;
    const education = sections.education.find((field) => field.structuredValue !== undefined)!;
    expect(experience.structuredValue).toEqual(richProfileRow.experience.value);
    expect(experience.sourceIds).toEqual(["work"]);
    expect(experience.sourceUrlsById).toEqual({
      work: [richProfileRow._sources.work],
      school: [richProfileRow._sources.school],
    });
    const now = new Date("2026-10-23T12:00:00Z");
    const work = structuredProfileTimeline(
      experience.structuredValue,
      "experience",
      now,
      experience.sourceUrlsById,
    );
    const studies = structuredProfileTimeline(
      education.structuredValue,
      "education",
      now,
      education.sourceUrlsById,
    );
    expect(work).toHaveLength(5);
    expect(work[0]).toMatchObject({
      primary: "Senior Machine Learning Engineer",
      secondary: "Example Labs",
      current: true,
    });
    expect(work[4]?.primary).toBe("Research and Teaching Assistant");
    expect(studies).toHaveLength(3);
    expect(studies.slice(0, 2).map((entry) => [entry.primary, entry.secondary])).toEqual([
      ["Example University", "PhD"],
      ["Example University", "MS"],
    ]);
    expect(studies[0]?.sourceUrls).toContain(richProfileRow._sources.school);
    expect(studies[2]?.dateLabel).toBeUndefined();
    expect(studies[2]?.secondary).toBeUndefined();
    expect(studies[2]?.current).toBeUndefined();
    expect(JSON.stringify(richProfileRow)).toBe(before);
  });

  it("keeps unmapped nested observations accessible without treating them as skills or assessments", () => {
    const report = projectRecruitingCandidateReport({
      skills: { value: { unknownShape: "Rust" } },
      recommendation: { value: { unknownShape: true } },
      profile_photo_url: { value: { unknownShape: "not a URL" } },
    });
    const sections = candidateSections(profileContentFields(report.fields));
    expect(sections.skills).toEqual([]);
    expect(sections.requirements).toEqual([]);
    expect(sections.findings).toHaveLength(3);
  });
  it("makes mapped descriptions selectable skill evidence with the original source context", () => {
    const sections = candidateSections(
      projectRecruitingCandidateReport({
        skills: "Go",
        experience: {
          value: [
            {
              title: "Engineer",
              company_name: "Example Labs",
              description: { value: "Built services in Go", source_id: "work" },
            },
          ],
        },
        _sources: { work: "https://evidence.example.test/work" },
      }).fields,
    );
    expect(sections.skills).toEqual(["Go"]);
    expect(sections.skillEvidence).toContainEqual(
      expect.objectContaining({
        label: "Experience · Engineer · Example Labs",
        text: "Engineer\nExample Labs\nBuilt services in Go",
        kind: "profile",
        sourceUrls: ["https://evidence.example.test/work"],
      }),
    );
    expect(sections.requirements).toEqual([]);
  });

  it("retains conflicting end-date wording without calculating a confirmed current tenure", () => {
    const entries = structuredProfileTimeline(
      [
        {
          title: "Engineer",
          company_name: "Example Labs",
          start_date: "2020",
          end_date: "Present",
          is_current: false,
        },
      ],
      "experience",
      new Date("2026-10-23"),
    );
    expect(entries[0]?.dateLabel).toBe("2020 – Present");
    expect(entries[0]?.current).toBeUndefined();
    expect(entries[0]?.months).toBeUndefined();
  });

  it("keeps diagnostics in the original artifact and source IDs as provenance, outside displayed source text", () => {
    const raw = {
      details: {
        metadata: { task_id: "synthetic-task", connector_id: "synthetic-connector" },
        nested: "observation",
      },
      experience: {
        value: [
          {
            title: {
              value: "Engineer",
              source_id: "work",
              metadata: { task_id: "synthetic-task" },
            },
            company_name: "Example Labs",
            task_id: "synthetic-task",
          },
        ],
      },
      _sources: { work: "https://evidence.example.test/work" },
    };
    const original = JSON.stringify(raw);
    const report = projectRecruitingCandidateReport(raw);
    expect(report.fields[0]?.structuredValue).toEqual({ nested: "observation" });
    expect(report.fields[1]?.structuredValue).toEqual([
      { title: { value: "Engineer", source_id: "work" }, company_name: "Example Labs" },
    ]);
    const visible = recruitingCandidateSourceText(report.fields[1]?.structuredValue);
    expect(visible).toContain("Engineer");
    expect(visible).not.toContain("source_id");
    expect(visible).not.toContain("synthetic-task");
    expect(JSON.stringify(raw)).toBe(original);
  });

  it("routes the actual employerDescriptions column to Experience with its source intact", () => {
    const value = "Original employer description, retained without rewriting.";
    const raw = {
      current_title: "Senior Machine Learning Engineer",
      employerDescriptions: { value, source_id: "profile" },
      _sources: { profile: "https://evidence.example.test/profile" },
    };
    const before = JSON.stringify(raw);
    const report = projectRecruitingCandidateReport(raw);
    const sections = candidateSections(profileContentFields(report.fields));
    expect(sections.experience).toEqual([
      { label: "Employer Descriptions", value, sourceUrls: [raw._sources.profile] },
    ]);
    expect(sections.findings.map((field) => field.label)).toEqual(["Current title"]);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("transports supplied LinkedIn CDN scalar URLs without a hostname block or guessed lookup", () => {
    const url = "https://media.licdn.com/dms/image/synthetic-only/company-logo?e=123&v=beta";
    const report = projectRecruitingCandidateReport({
      current_company: "Example Labs",
      company_logo_url: { value: url, source_id: "company" },
      _sources: { company: "https://www.linkedin.com/company/synthetic-example" },
    });
    expect(profileAssets(report.fields).company).toEqual({ name: "Example Labs", url });
    expect(
      profileAssets(projectRecruitingCandidateReport({ current_company: "Example Labs" }).fields)
        .company,
    ).toBeNull();
  });

  it("does not classify a research appointment as education from an employer's name", () => {
    const report = projectRecruitingCandidateReport({
      employer_descriptions:
        "Research and Teaching Assistant, Example University, Sep 2017–Sep 2021",
    });
    const sections = candidateSections(report.fields);
    expect(sections.experience).toHaveLength(1);
    expect(sections.education).toEqual([]);
  });

  it("prefers explicit CRM history fields over guessing delimiters in long titles and employer names", () => {
    const history: Record<string, string>[] = [
      {
        title: "Research and Teaching Assistant, Systems; Applied ML",
        company: "Example University, School of Engineering",
        start: "Sep 2017",
        end: "Sep 2021",
        description: "A long original description. ".repeat(15),
        location: "Example City",
      },
      { title: "Engineer", company: "Example Labs", start: "2025" },
    ];
    const fields = storedProfileFields({ history, summary: "", skills: [], sources: [] });
    const entries = candidateSections(profileContentFields(fields)).experience[0]?.timelineEntries;
    expect(entries).toHaveLength(2);
    expect(entries?.[0]).toMatchObject({
      primary: history[0]!.title,
      secondary: history[0]!.company,
      description: history[0]!.description!.trim(),
      detail: "Example City",
      months: 48,
    });
    expect(entries?.[1]?.current).toBeUndefined();
    expect(entries?.[1]?.months).toBeUndefined();
    expect(entries?.[1]?.dateLabel).toBe("2025");
    expect(fields[0]?.sourceText).toContain(history[0]!.description!.trim());
    expect(fields[0]?.value).not.toContain('"title":');
    expect(fields[0]?.value).toContain("Engineer · Example Labs · 2025");
  });
});
