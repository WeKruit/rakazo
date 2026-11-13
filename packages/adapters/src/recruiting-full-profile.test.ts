import { describe, expect, it } from "vitest";
import {
  hardRequirements,
  requirementEvidence,
  withRequirementEvidence,
} from "./recruiting-full-profile.js";

const revision = {
  criteria: [
    {
      priority: "hard",
      expression: {
        kind: "all",
        items: [
          { kind: "atom", statement: "Active Arizona RN license" },
          { kind: "atom", statement: "Current CCRN certification" },
        ],
      },
    },
    { priority: "soft", expression: { kind: "atom", statement: "Epic charting" } },
  ],
};

const page = [
  "Pat Sample",
  "Phoenix, Arizona",
  "## Experience",
  "ICU Nurse at Example Health 2019 - Present",
  "## Licenses & certifications",
  "Registered Nurse License - Arizona State Board of Nursing",
  "CCRN - AACN",
  "## Interests",
  "Hiking",
].join("\n");

describe("full profile evidence", () => {
  it("takes the statements of the hard criteria only", () => {
    expect(hardRequirements(revision)).toEqual([
      "Active Arizona RN license",
      "Current CCRN certification",
    ]);
    expect(hardRequirements({})).toEqual([]);
  });

  it("quotes the profile lines that speak to the must-haves", () => {
    const evidence = requirementEvidence(page, hardRequirements(revision))!;
    expect(evidence).toContain("Registered Nurse License - Arizona State Board of Nursing");
    expect(evidence).toContain("CCRN - AACN");
    expect(evidence).not.toContain("Hiking");
    expect(requirementEvidence("## Interests\nHiking", hardRequirements(revision))).toBeUndefined();
  });

  it("reads pages in row order while the reads last and reuses a page read earlier", async () => {
    const read: string[] = [];
    const reader = {
      reads: { left: 1 },
      pages: new Map([["linkedin:/in/sam-test", "Sam Test\nCCRN certified"]]),
      read: async (url: string) => {
        read.push(url);
        return { url, title: "", text: page };
      },
    };
    const rows = [
      { candidateKey: "linkedin:/in/pat-sample", name: "Pat Sample" },
      { candidateKey: "linkedin:/in/ana-example", name: "Ana Example" },
      { candidateKey: "linkedin:/in/sam-test", name: "Sam Test" },
    ];
    const out = await withRequirementEvidence(revision, rows, reader);
    expect(read).toEqual(["https://www.linkedin.com/in/pat-sample"]);
    expect(reader.reads.left).toBe(0);
    expect(out.map((row) => [row.name, Boolean(row.fullProfile)])).toEqual([
      ["Pat Sample", true],
      ["Ana Example", false],
      ["Sam Test", true],
    ]);
    expect(await withRequirementEvidence({}, rows, reader)).toEqual(rows);
  });

  it("returns the rows as they were when a read fails", async () => {
    const rows = [{ candidateKey: "linkedin:/in/pat-sample" }];
    const out = await withRequirementEvidence(revision, rows, {
      reads: { left: 5 },
      read: async () => {
        throw new Error("offline");
      },
    });
    expect(out).toEqual(rows);
  });
});
