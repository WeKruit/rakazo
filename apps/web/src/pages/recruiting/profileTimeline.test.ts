import { describe, expect, it } from "vitest";
import { parseTimeline, timelineStats } from "./profileTimeline";

const NOW = new Date(Date.UTC(2026, 9, 23));

describe("parseTimeline", () => {
  it("keeps lookup bookkeeping out of dated positions", () => {
    const [entry] = parseTimeline(
      "Recovered cached original profile record (profile lookup 2026-10-23T15:48:51Z) | Example Co",
      "experience",
      new Date("2026-10-25T00:00:00Z"),
    );
    expect(entry).toMatchObject({ structured: false });
    expect(entry?.dateLabel).toBeUndefined();
  });

  it("preserves stored CRM role and employer hierarchy separated by middle dots", () => {
    expect(
      parseTimeline("Engineer · Example Labs · 2020 – 2022", "experience", NOW)[0],
    ).toMatchObject({
      primary: "Engineer",
      secondary: "Example Labs",
      months: 24,
    });
  });

  it("reads the requested pipe format with the organization's own website", () => {
    const [job, earlier] = parseTimeline(
      "Staff Engineer | Acme Inc. | https://www.acme.example | Jan 2022 – Present | St. Louis, MO\nEngineer | Beta | | 2019 – 2021 |",
      "experience",
      NOW,
    );
    expect(job).toMatchObject({
      structured: true,
      primary: "Staff Engineer",
      secondary: "Acme Inc.",
      website: "www.acme.example",
      current: true,
      detail: "St. Louis, MO",
    });
    expect(earlier).toMatchObject({ primary: "Engineer", secondary: "Beta", months: 24 });
    expect(earlier?.website).toBeUndefined();

    const [degree] = parseTimeline(
      "Stanford University | M.S., Computer Science | https://stanford.example.edu | 2016 – 2018",
      "education",
      NOW,
    );
    expect(degree).toMatchObject({
      primary: "Stanford University",
      secondary: "M.S.",
      detail: "Computer Science",
      website: "stanford.example.edu",
    });
  });

  it("keeps research notes as words instead of a dated entry", () => {
    const value =
      "Partial, undated (search-index snippet, checked 2026-10-24): headline 'Ops lead'. Current role per saved profile: Manager at Acme.";
    expect(parseTimeline(value, "experience", NOW).every((entry) => !entry.structured)).toBe(true);
    const [school] = parseTimeline("Rutgers University (checked 2026-10-24)", "education", NOW);
    expect(school?.structured).toBe(false);
  });

  it("never treats a LinkedIn page or a bare name as a website", () => {
    const [entry] = parseTimeline(
      "Node.js Developer | Gamma | https://www.linkedin.com/company/gamma | 2020 – 2021",
      "experience",
      NOW,
    );
    expect(entry).toMatchObject({ primary: "Node.js Developer", secondary: "Gamma" });
    expect(entry?.website).toBeUndefined();
  });

  it("splits positions on semicolons and parses title, company and years", () => {
    const entries = parseTimeline(
      "Senior Staff Research Scientist, NVIDIA (2021–Present); Research Scientist, Google Brain (2018–2021)",
      "experience",
      NOW,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      structured: true,
      primary: "Senior Staff Research Scientist",
      secondary: "NVIDIA",
      current: true,
      months: 2026 * 12 + 9 - 2021 * 12,
    });
    expect(entries[1]).toMatchObject({
      primary: "Research Scientist",
      secondary: "Google Brain",
      months: 36,
    });
  });

  it("handles at, month names, numeric months and bullets", () => {
    const entries = parseTimeline(
      "- Engineer at Acme Corp, Jan 2020 - Mar 2021\n• Lead @ Beta, 03/2021 to 2022-06",
      "experience",
      NOW,
    );
    expect(entries[0]).toMatchObject({ primary: "Engineer", secondary: "Acme Corp", months: 14 });
    expect(entries[1]).toMatchObject({ primary: "Lead", secondary: "Beta", months: 15 });
  });

  it("parses Chinese punctuation and present markers", () => {
    const entries = parseTimeline(
      "高级研究员，字节跳动，2020年3月—至今；算法工程师，百度，2017.06-2020.02",
      "experience",
      NOW,
    );
    expect(entries[0]).toMatchObject({
      primary: "高级研究员",
      secondary: "字节跳动",
      current: true,
    });
    expect(entries[0]?.months).toBe(2026 * 12 + 9 - (2020 * 12 + 2));
    expect(entries[1]).toMatchObject({ primary: "算法工程师", secondary: "百度", months: 32 });
  });

  it("keeps unparseable text verbatim", () => {
    const text = "Worked on large scale ranking systems across several companies.";
    const [entry] = parseTimeline(text, "experience", NOW);
    expect(entry).toMatchObject({ structured: false, text, primary: text });
    expect(entry?.months).toBeUndefined();
  });

  it("keeps a paragraph with several ranges as plain words", () => {
    const text = "Spent 2015-2018 at Foo and later 2018-2020 at Bar.";
    expect(parseTimeline(text, "experience", NOW)[0]?.structured).toBe(false);
  });

  it("does not compute a duration for a future start", () => {
    const [entry] = parseTimeline("Founder, Soon (2030–Present)", "experience", NOW);
    expect(entry?.months).toBeUndefined();
  });

  it("puts the school first for education", () => {
    const entries = parseTimeline(
      "PhD EE, Stanford University, 2013–2018; BS, Tsinghua",
      "education",
      NOW,
    );
    expect(entries[0]).toMatchObject({
      primary: "Stanford University",
      secondary: "PhD EE",
      months: 60,
    });
    expect(entries[1]).toMatchObject({ primary: "Tsinghua", secondary: "BS" });
    const [zh] = parseTimeline("清华大学，计算机硕士，2012–2015", "education", NOW);
    expect(zh).toMatchObject({ primary: "清华大学", secondary: "计算机硕士" });
  });
});

describe("timelineStats", () => {
  it("computes average, current and non-overlapping total from parsed ranges", () => {
    const entries = parseTimeline(
      "A, X (2018–2020); B, Y (2019–2021); C, Z (2022–Present); free text only",
      "experience",
      NOW,
    );
    const present = 2026 * 12 + 9 - 2022 * 12;
    expect(timelineStats(entries)).toEqual({
      average: Math.round((24 + 24 + present) / 3),
      current: present,
      total: 36 + present,
    });
  });

  it("is null when no dates parse", () => {
    expect(timelineStats(parseTimeline("Engineer at Acme", "experience", NOW))).toBeNull();
  });
});
