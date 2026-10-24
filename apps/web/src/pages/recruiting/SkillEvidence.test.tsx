// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { AssessmentCard } from "./AssessmentCard";
import { HighlightText, keywordRanges, mentionsKeyword } from "./evidence";
import { candidateSections } from "./profile";
import { SkillEvidence } from "./SkillEvidence";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});
async function mount(node: ReactNode) {
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  const render = async (next: ReactNode) => {
    await act(async () => root.render(next));
  };
  await render(node);
  cleanup = async () => {
    await act(async () => root.unmount());
    view.remove();
  };
  return { view, render };
}
const button = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll("button")].find((item) => item.textContent === text)!;
const NO_QUICK = { headline: null, highlights: [], keyWorks: [], concerns: [], entities: [] };
/** Opens every assessment row so its full evidence is in the DOM. */
async function expandRows(view: HTMLElement) {
  for (const row of view.querySelectorAll<HTMLButtonElement>("li > button:not([disabled])"))
    await act(async () => row.click());
}
const context = (view: HTMLElement) => view.querySelector('section[aria-label="Skill evidence"]')!;
const profile = candidateSections([
  { label: "Skills", value: "Go, Rust, Kotlin", sourceUrls: ["https://example.test/profile"] },
  {
    label: "Experience",
    value: "Built services in Go at Northwind.",
    sourceUrls: ["https://example.test/project"],
  },
  {
    label: "Concern",
    value: "No evidence of production Rust use.",
    sourceUrls: ["https://example.test/assessment"],
  },
  { label: "Rust", value: "unclear", providerStatus: "unclear", sourceUrls: [] },
]);
const skills = () => <SkillEvidence skills={profile.skills} evidence={profile.skillEvidence} />;

describe("literal keyword highlighting", () => {
  it("matches technical names exactly without substring matches or regular-expression syntax", () => {
    expect(mentionsKeyword("Google and Django", "Go")).toBe(false);
    expect(mentionsKeyword("C++ and C#", "C")).toBe(false);
    expect(mentionsKeyword("C++ and C#", "C++")).toBe(true);
    expect(mentionsKeyword("Worked with .NET", ".NET")).toBe(true);
    expect(mentionsKeyword("Built in Go.", "go")).toBe(true);
    expect(mentionsKeyword("没有分布式系统经验", "分布式系统")).toBe(true);
    expect(keywordRanges("React Native", ["React", "React Native"])).toEqual([
      { start: 0, end: 12 },
    ]);
  });

  it("leaves negative context intact and renders HTML-like source text as text", async () => {
    const text = "No Rust evidence; <script>untrusted</script>. Go is listed.";
    const { view } = await mount(<HighlightText text={text} terms={["Rust", "Go"]} />);
    expect(view.textContent).toBe(text);
    expect([...view.querySelectorAll("mark")].map((item) => item.textContent)).toEqual([
      "Rust",
      "Go",
    ]);
    expect(view.querySelector("script")).toBeNull();
  });
});

it("selects, filters, and clears source context without promoting a skill mention to a match", async () => {
  const { view } = await mount(skills());
  expect(context(view).textContent).toBe("");
  const go = button(view, "Go");
  go.focus();
  await act(async () => go.click());
  expect(go.getAttribute("aria-pressed")).toBe("true");
  expect(go.getAttribute("aria-controls")).toBe(context(view).id);
  expect(document.activeElement).toBe(go);
  expect(context(view).textContent).toContain("Built services in Go at Northwind.");
  expect(context(view).textContent).not.toContain("No evidence of production Rust use.");
  expect(context(view).querySelector('a[href="https://example.test/project"]')).not.toBeNull();
  expect(context(view).textContent).not.toContain("Match");
  await act(async () => button(view, "Rust").click());
  expect(go.getAttribute("aria-pressed")).toBe("false");
  expect(context(view).textContent).toContain("No evidence of production Rust use.");
  expect(context(view).textContent).toContain("Unknown");
  expect(context(view).textContent).toContain("No evidence provided.");
  expect(context(view).textContent).not.toContain("Partial match");
  await act(async () => button(view, "Rust").click());
  expect(context(view).textContent).toBe("");
});

it("distinguishes a skill list from supporting detail and refreshes selected context", async () => {
  const { view, render } = await mount(skills());
  await act(async () => button(view, "Kotlin").click());
  expect(context(view).textContent).toContain("Listed skill");
  expect(context(view).textContent).toContain("No supporting detail in the saved profile.");
  const updated = candidateSections([
    { label: "Experience", value: "Kotlin project", sourceUrls: [] },
  ]);
  await render(<SkillEvidence skills={profile.skills} evidence={updated.skillEvidence} />);
  expect(context(view).textContent).toContain("Kotlin project");
  expect(context(view).textContent).not.toContain("No supporting detail");
  await render(<SkillEvidence skills={["SQL"]} evidence={[]} />);
  expect(context(view).textContent).toBe("");
});

it("reveals skills beyond the initial set with usable long-name buttons", async () => {
  const names = Array.from({ length: 13 }, (_, index) => `Technical skill ${index}`);
  names[12] = "Long technical skill name ".repeat(10);
  const { view } = await mount(<SkillEvidence skills={names} evidence={[]} />);
  expect(button(view, names[12]!)).toBeUndefined();
  await act(async () => button(view, "Show more").click());
  expect(button(view, names[12]!)).toBeDefined();
  await act(async () => button(view, names[12]!).click());
  expect(context(view).textContent).toContain("No supporting detail in the saved profile.");
});

it("leads with the supplied criterion name, preserves all assessment states, and highlights source text", async () => {
  const sections = candidateSections([
    {
      label: "Go",
      value: "match",
      providerStatus: "match",
      evidence: "Go services",
      reasoning: "Concern: scale unverified.",
      sourceUrls: [],
    },
    { label: "Rust", value: "unclear", providerStatus: "unclear", sourceUrls: [] },
    {
      label: "Kotlin",
      value: "miss",
      providerStatus: "miss",
      evidence: "No Kotlin experience.",
      sourceUrls: [],
    },
    {
      label: "Requirement assessment",
      value: "R1: Partial - C++ experience in a lab.",
      sourceUrls: [],
    },
  ]);
  const { view } = await mount(
    <AssessmentCard
      score={null}
      rank={null}
      summary={null}
      quick={NO_QUICK}
      rows={sections.requirements}
      sourceUrls={[]}
      keywords={["C++"]}
    />,
  );
  await expandRows(view);
  const rows = [...view.querySelectorAll("li")];
  // The status is the row icon's accessible name; the evidence opens under the criterion.
  expect(rows.map((row) => row.querySelector("svg")?.getAttribute("aria-label"))).toEqual([
    "Match",
    "Unknown",
    "Gap",
    "Partial match",
  ]);
  expect(rows[0]?.textContent).toBe("GoGo services\n\nConcern: scale unverified.");
  expect(rows[1]?.textContent).toContain("RustNo evidence provided.");
  expect(rows[2]?.textContent).toContain("KotlinNo Kotlin experience.");
  expect(rows[3]?.textContent).toContain("Criterion name unavailableR1C++ experience in a lab.");
  expect([...view.querySelectorAll("mark")].map((item) => item.textContent)).toEqual([
    "Go",
    "Kotlin",
    "C++",
  ]);
});

it("shows the exact technical definition ahead of its reference in assessment and selected skill context", async () => {
  const sections = candidateSections(
    [
      { label: "Skills", value: "C++", sourceUrls: [] },
      {
        label: "Requirement assessment",
        value: "R4: Partial - Prototype only. Counterevidence: no production ownership stated.",
        sourceUrls: ["https://example.test/evidence"],
      },
    ],
    {
      roleRevisionId: "revision-1",
      revision: {
        id: "revision-1",
        criteria: [
          {
            id: "R4",
            priority: "hard",
            sourceRefs: [],
            definitionQuestions: [],
            expression: { kind: "atom", id: "cpp", statement: "C++ production systems" },
          },
        ],
      },
    },
  );
  const { view } = await mount(
    <>
      <AssessmentCard
        score={null}
        rank={null}
        summary={null}
        quick={NO_QUICK}
        rows={sections.requirements}
        sourceUrls={[]}
      />
      <SkillEvidence skills={sections.skills} evidence={sections.skillEvidence} />
    </>,
  );
  // Only the assessment card's rows; the skill list below has its own buttons.
  await expandRows(view.firstElementChild as HTMLElement);
  const row = view.querySelector("li")!;
  expect(row.textContent).toBe(
    "C++ production systemsR4Prototype only. Counterevidence: no production ownership stated.",
  );
  expect(row.querySelector(".font-medium")?.textContent).toBe("C++ production systems");
  await act(async () => button(view, "C++").click());
  expect(context(view).textContent).toContain("C++ production systemsR4Partial match");
  expect(context(view).textContent).toContain("Counterevidence: no production ownership stated.");
  expect(context(view).querySelector('a[href="https://example.test/evidence"]')).not.toBeNull();
});
