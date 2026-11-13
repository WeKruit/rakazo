import { describe, expect, it } from "vitest";
import type { LanguageRow, TextJudge } from "./judge.js";
import {
  languageFilters,
  plannedLanguageFilters,
  profileTexts,
  requiredLanguage,
  statedLanguageRequirement,
  withoutName,
  withRequiredLanguage,
} from "./recruiting-language.js";

const listing = [
  "Title: Wei Test\nURL: https://www.linkedin.com/in/wei-test\n# Wei Test\nControls Engineer\n## Languages\nMandarin - Native or bilingual proficiency\n",
  "Title: Joe Sample\nURL: https://www.linkedin.com/in/joe-sample\n# Joe Sample\nMaintenance Engineer\n",
  "Title: Ana Example\nURL: https://www.linkedin.com/in/ana-example\n# Ana Example\nTechnician\n",
].join("");
const result = { content: [{ type: "text", text: listing }] };
const rows = [
  { candidateKey: "linkedin:/in/joe-sample", name: "Joe Sample" },
  { candidateKey: "linkedin:/in/ana-example", name: "Ana Example" },
  { candidateKey: "linkedin:/in/wei-test", name: "Wei Test" },
];
const brief = {
  searchFilters: [
    { id: "f1", statement: "Must speak Mandarin and English", mode: "include" },
    { id: "f2", statement: "Within 30 miles of the site", mode: "include" },
  ],
  fields: [{ key: "title", value: "Maintenance Engineer" }],
};

/** Answers from the profile text alone, and records what it was shown. */
function fakeJudge(seen: string[]): TextJudge {
  return {
    async yes(_instructions, state) {
      const profile = String(state.profile);
      seen.push(profile);
      if (profile.includes("Mandarin")) return 0.9;
      if (profile.includes("Technician")) return 0.4;
      return 0.05;
    },
  };
}

describe("required language", () => {
  it("reads the language requirement from the brief", () => {
    expect(requiredLanguage({ brief })).toBe("Must speak Mandarin and English");
    // Before the brief is saved, the role's criteria hold the JD's requirements.
    expect(
      requiredLanguage({
        brief: null,
        criteria: [{ text: "3+ years of PLC work. Must speak Mandarin Chinese and English." }],
      }),
    ).toBe("Must speak Mandarin Chinese and English.");
    expect(
      requiredLanguage({ searchFilters: [], fields: [{ key: "语言", value: "会说中文" }] }),
    ).toBe("会说中文");
    expect(requiredLanguage({ searchFilters: [], fields: [{ key: "title", value: "PLC" }] })).toBe(
      undefined,
    );
  });

  it("finds each person's own profile text", () => {
    const texts = profileTexts(result);
    expect(texts.get("linkedin:/in/wei-test")).toContain("Mandarin - Native");
    expect(texts.get("linkedin:/in/joe-sample")).not.toContain("Mandarin");
  });

  it("hides the name, whole words only", () => {
    expect(withoutName("Li works in Linden with Li Wei", "Li Wei")).toBe(
      "[name] works in Linden with [name]",
    );
  });

  it("lists people who show the language first, leaves out those with no sign, and never shows the judge a name", async () => {
    const seen: string[] = [];
    const checked = await withRequiredLanguage(
      { resolve: async () => fakeJudge(seen) },
      brief,
      rows,
      result,
    );
    expect(checked.rows.map((row) => [row.name, row.requiredLanguage])).toEqual([
      ["Wei Test", "strong"],
      ["Ana Example", "unknown"],
    ]);
    expect(checked.withoutLanguage).toBe(1);
    expect(seen.join("\n")).not.toMatch(/Wei|Joe|Ana/);
  });

  it("sends every row, with its whole profile, to the deployment's own check in one call", async () => {
    const calls: Array<{ requirement: string; rows: readonly LanguageRow[] }> = [];
    const judge: TextJudge = {
      yes: async () => {
        throw new Error("the check decides, not the yes/no question");
      },
      language: async (requirement, batch) => {
        calls.push({ requirement, rows: batch });
        return new Map(
          batch.filter((row) => row.profile.includes("Mandarin")).map((row) => [row.id, "confirmed"]),
        );
      },
    };
    const long = `Title: Joe Sample\nURL: https://www.linkedin.com/in/joe-sample\n${"Maintenance. ".repeat(600)}\n`;
    const checked = await withRequiredLanguage({ resolve: async () => judge }, brief, rows, {
      content: [
        { type: "text", text: listing.replace(/Title: Joe Sample[\s\S]*?(?=Title: Ana)/, long) },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.requirement).toBe("Must speak Mandarin and English");
    expect(calls[0]!.rows.map((row) => [row.id, row.name])).toEqual([
      ["linkedin:/in/joe-sample", "Joe Sample"],
      ["linkedin:/in/ana-example", "Ana Example"],
      ["linkedin:/in/wei-test", "Wei Test"],
    ]);
    expect(calls[0]!.rows[0]!.profile).toBe(long);
    expect(calls[0]!.rows[0]!.candidate).toEqual(rows[0]);
    // Unanswered rows stay, as unknown, after those the check confirms.
    expect(checked.rows.map((row) => [row.name, row.requiredLanguage])).toEqual([
      ["Wei Test", "confirmed"],
      ["Joe Sample", undefined],
      ["Ana Example", undefined],
    ]);
  });

  it("reads the full profile page of people the search text does not show it for", async () => {
    const read: string[] = [];
    const reads = { left: 1 };
    const checked = await withRequiredLanguage(
      { resolve: async () => fakeJudge([]) },
      brief,
      rows,
      result,
      {
        reads,
        read: async (url) => {
          read.push(url);
          return { url, title: "", text: "Joe Sample\n## Languages\nMandarin - Professional" };
        },
      },
    );
    // Row order decides who is read while the reads last; Wei already shows it.
    expect(read).toEqual(["https://www.linkedin.com/in/joe-sample"]);
    expect(reads.left).toBe(0);
    expect(checked.rows.map((row) => [row.name, row.requiredLanguage])).toEqual([
      ["Joe Sample", "strong"],
      ["Wei Test", "strong"],
      ["Ana Example", "unknown"],
    ]);
    expect(checked.withoutLanguage).toBe(0);
  });

  it("checks the profile text itself when there is no judge, ranking rather than leaving out", async () => {
    const checked = await withRequiredLanguage(
      { resolve: async () => undefined },
      brief,
      rows,
      result,
    );
    expect(checked.rows.map((row) => [row.name, row.requiredLanguage])).toEqual([
      ["Wei Test", "strong"],
      ["Joe Sample", "unknown"],
      ["Ana Example", "unknown"],
    ]);
    expect(checked.withoutLanguage).toBe(0);
  });

  it("leaves rows unchanged without a requirement, and reads the text when the judge is silent", async () => {
    const seen: string[] = [];
    expect(
      await withRequiredLanguage({ resolve: async () => fakeJudge(seen) }, {}, rows, result),
    ).toEqual({ rows, withoutLanguage: 0 });
    expect(seen).toEqual([]);
    const silent: TextJudge = { yes: async () => undefined };
    const checked = await withRequiredLanguage(
      { resolve: async () => silent },
      brief,
      rows,
      result,
    );
    expect(checked.rows.map((row) => row.name)).toEqual(["Wei Test", "Joe Sample", "Ana Example"]);
  });

  it("requires the language on the profile when most planned searches ask for it", () => {
    expect(
      languageFilters([
        "Maintenance engineers near Linden, NJ, Mandarin-English bilingual",
        "PLC technicians in New Jersey who speak Mandarin",
        "Conveyor maintenance engineers near Newark",
      ]),
    ).toEqual(["Mandarin", "Chinese"]);
    expect(languageFilters(["Maintenance engineers near Linden", "PLC technicians"])).toEqual([]);
    expect(languageFilters(["Bilingual Japanese technicians", "日语 engineers"])).toEqual([
      "Japanese",
    ]);
  });

  it("falls back to the recruiter's own words when the planned queries leave the language out", () => {
    const jd =
      "Location: on-site near Linden, NJ.\nMust speak both Mandarin Chinese and English.\nPLC troubleshooting.";
    expect(statedLanguageRequirement([jd])).toBe("Must speak both Mandarin Chinese and English.");
    expect(statedLanguageRequirement(["Spanish speakers welcome to apply"])).toBe(undefined);
    expect(
      plannedLanguageFilters(["Maintenance engineers near Linden", "PLC technicians in NJ"], [jd]),
    ).toEqual({ filters: ["Mandarin", "Chinese"], queriesNameIt: false });
    expect(plannedLanguageFilters(["PLC technicians in NJ"], ["No language needs"])).toEqual({
      filters: [],
      queriesNameIt: false,
    });
  });
});
