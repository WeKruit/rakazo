import { describe, expect, it } from "vitest";
import type { TextJudge } from "./judge.js";
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

  it("puts people whose profile shows the language first and never shows the judge a name", async () => {
    const seen: string[] = [];
    const ordered = await withRequiredLanguage(
      { resolve: async () => fakeJudge(seen) },
      brief,
      rows,
      result,
    );
    expect(ordered.map((row) => [row.name, row.requiredLanguage])).toEqual([
      ["Wei Test", "shown"],
      ["Ana Example", "unclear"],
      ["Joe Sample", "no sign"],
    ]);
    expect(seen.join("\n")).not.toMatch(/Wei|Joe|Ana/);
  });

  it("leaves rows unchanged without a requirement, a judge, or when the judge fails", async () => {
    const seen: string[] = [];
    expect(
      await withRequiredLanguage({ resolve: async () => fakeJudge(seen) }, {}, rows, result),
    ).toEqual(rows);
    expect(
      await withRequiredLanguage({ resolve: async () => undefined }, brief, rows, result),
    ).toEqual(rows);
    const silent: TextJudge = { yes: async () => undefined };
    expect(
      await withRequiredLanguage({ resolve: async () => silent }, brief, rows, result),
    ).toEqual(rows);
    expect(seen).toEqual([]);
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
