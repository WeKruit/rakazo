// @vitest-environment jsdom
import type { RecruitingCandidateReport } from "@rakazo/contracts";
import { projectRecruitingCandidateReport } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { CandidateDirectory } from "./CandidateDirectory";
import type { RoleCandidate } from "./useRoleCandidates";

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
const field = (label: string, value: string): RecruitingCandidateReport["fields"][number] => ({
  label,
  value,
  sourceUrls: [],
});
function row(key: string, fields: RecruitingCandidateReport["fields"] = []): RoleCandidate {
  return {
    key,
    name: `Candidate ${key}`,
    title: "Platform engineer",
    location: "Example City",
    email: null,
    linkedinUrl: "https://example.test/source-profile",
    autumn: {
      company: "Example Labs",
      shortlisted: false,
      latestSource: { report: { fields } },
    } as RoleCandidate["autumn"],
    crm: null,
  };
}

const assetFields = [
  field("Profile photo URL", "https://example.test/avatar.png"),
  field("Company", "Example Labs"),
  field("Company logo URL", "https://example.test/company.png"),
  field("Company website", "https://example.test/company"),
  field("School", "Example University"),
  field("School logo URL", "https://example.test/school.png"),
  field("School website", "https://example.test/school"),
  field("Education", "BSc Computer Science, Example University, 2015 – 2019"),
];

it("uses supplied assets and links in both layouts without changing row order or callback identity", async () => {
  const rows = [row("second", assetFields), row("first")];
  const onOpen = vi.fn();
  const { view } = await mount(
    <CandidateDirectory rows={rows} selectedKey={rows[0]!.key} onOpen={onOpen} />,
  );
  expect([...view.querySelectorAll("tbody th button")].map((item) => item.textContent)).toEqual([
    "Candidate second",
    "Candidate first",
  ]);
  expect([...view.querySelectorAll("img")].map((item) => item.src)).toEqual([
    "https://example.test/avatar.png",
    "https://example.test/company.png",
    "https://example.test/school.png",
  ]);
  expect(view.querySelector('a[href="https://example.test/company"]')?.textContent).toBe(
    "Example Labs",
  );
  expect(view.querySelector('a[href="https://example.test/school"]')?.textContent).toBe(
    "Example University",
  );
  expect(view.querySelectorAll("tbody tr[data-selected=true]")).toHaveLength(1);
  const name = button(view, "Candidate second");
  name.focus();
  expect(document.activeElement).toBe(name);
  expect(name.type).toBe("button");
  expect(name.getAttribute("aria-current")).toBe("true");
  await act(async () => name.click());
  expect(onOpen).toHaveBeenLastCalledWith(rows[0], 0, name);
  const cards = button(view, "Cards");
  cards.focus();
  await act(async () => cards.click());
  expect(cards.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(cards);
  expect(view.querySelector("table")).toBeNull();
  expect(view.querySelector('ul[aria-label="Candidate cards"]')).not.toBeNull();
  expect(view.querySelectorAll("img")).toHaveLength(3);
  const other = button(view, "Candidate first");
  await act(async () => other.click());
  expect(onOpen).toHaveBeenLastCalledWith(rows[1], 1, other);
  await act(async () => button(view, "Table").click());
  const scroll = view.querySelector('section[aria-label="Candidate table"]') as HTMLElement;
  scroll.focus();
  expect(document.activeElement).toBe(scroll);
  expect(scroll.className).toContain("overflow-auto");
});

it("does not turn missing fields or unknown criteria into matches, partial matches, or invented activity", async () => {
  const empty = row("missing");
  Object.assign(empty, {
    name: null,
    title: null,
    location: null,
    linkedinUrl: null,
    autumn: null,
  });
  const unknown = row("unknown", [
    { ...field("Rust", "unclear"), providerStatus: "unclear" },
    field("Score", "72"),
  ]);
  const { view } = await mount(<CandidateDirectory rows={[empty, unknown]} onOpen={vi.fn()} />);
  expect(button(view, "Unnamed candidate")).toBeDefined();
  expect(view.textContent).toContain("Rust · Unknown");
  expect(view.textContent).toContain("72");
  expect(view.textContent).not.toContain("Partial match");
  expect(view.textContent).not.toContain("Match");
  expect(view.textContent).not.toContain("No activity");
  expect(view.textContent).not.toContain("Education");
  expect(view.querySelectorAll("img")).toHaveLength(0);
  expect(view.querySelectorAll("tbody tr")[0]?.querySelector("a")).toBeNull();
});

it("keeps actual supplied fit states and stored statuses separate", async () => {
  const candidate = row("states", [
    { ...field("Go", "match"), providerStatus: "match" },
    { ...field("Rust", "miss"), providerStatus: "miss" },
  ]);
  candidate.crm = { stage: "not_interested", outreachStatus: "replied" } as RoleCandidate["crm"];
  candidate.autumn!.shortlisted = true;
  const { view, render } = await mount(<CandidateDirectory rows={[candidate]} onOpen={vi.fn()} />);
  expect(view.textContent).toContain("Go · Match");
  expect(view.textContent).toContain("Rust · Gap");
  expect(view.textContent).toContain("Not interested");
  expect(view.textContent).toContain("Shortlisted");
  expect(view.textContent).not.toContain("Replied");
  await render(
    <CandidateDirectory
      rows={[
        row("partial", [
          field("Requirements assessment", "R1: Partial - C++ experience in a lab."),
        ]),
      ]}
      onOpen={vi.fn()}
    />,
  );
  expect(view.textContent).toContain("Criterion name unavailable · R1 · Partial match");
});

it("rejects unsafe source URLs and mismatched organization images and recovers on a new supplied image", async () => {
  const unsafe = row("unsafe", [
    field("Profile photo URL", "javascript:alert(1)"),
    field("Company", "Old Company"),
    field("Company logo URL", "https://example.test/old-company.png"),
    field("Company website", "https://example.test/old-company"),
    field("Education", "Example University"),
    field("School logo URL", "https://example.test/unpaired-school.png"),
  ]);
  unsafe.linkedinUrl = "javascript:alert(1)";
  const { view, render } = await mount(<CandidateDirectory rows={[unsafe]} onOpen={vi.fn()} />);
  expect(view.querySelectorAll("img,a")).toHaveLength(0);
  const supplied = row("unsafe", assetFields);
  await render(<CandidateDirectory rows={[supplied]} onOpen={vi.fn()} />);
  const photo = view.querySelector('img[src="https://example.test/avatar.png"]')!;
  await act(async () => photo.dispatchEvent(new Event("error")));
  expect(view.querySelector('img[src="https://example.test/avatar.png"]')).toBeNull();
  await render(
    <CandidateDirectory
      rows={[row("unsafe", [field("Profile photo URL", "https://example.test/new-avatar.png")])]}
      onOpen={vi.fn()}
    />,
  );
  expect(view.querySelector('img[src="https://example.test/new-avatar.png"]')).not.toBeNull();
});

it("keeps caller actions independent of opening and uses fresh callbacks after rows change", async () => {
  const onOpen = vi.fn();
  const onAction = vi.fn();
  const rows = [row("original")];
  const { view, render } = await mount(
    <CandidateDirectory
      rows={rows}
      onOpen={onOpen}
      renderActions={() => (
        <button type="button" onClick={onAction}>
          Shortlist
        </button>
      )}
    />,
  );
  await act(async () => button(view, "Shortlist").click());
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
  const updated = row("updated");
  updated.name = "Long candidate name ".repeat(20);
  const nextOpen = vi.fn();
  await render(<CandidateDirectory rows={[updated]} selectedKey="updated" onOpen={nextOpen} />);
  const name = button(view, updated.name);
  expect(name).toBeDefined();
  expect(name.title).toBe(updated.name);
  await act(async () => name.click());
  expect(nextOpen).toHaveBeenCalledWith(updated, 0, name);
  expect(onOpen).not.toHaveBeenCalled();
  expect(view.textContent).not.toContain("Candidate original");
  await render(<CandidateDirectory rows={[]} onOpen={nextOpen} />);
  expect(view.textContent).toBe("");
});

it("uses source-revision-matched criterion definitions in table and cards, never a newer role definition", async () => {
  const candidate = row("definition", [
    field("Requirements assessment", "R4: Partial - Prototype only."),
  ]);
  candidate.autumn = {
    ...candidate.autumn!,
    latestSource: { ...candidate.autumn!.latestSource!, roleRevisionId: "revision-1" },
  };
  const criterionRevision = {
    id: "revision-1",
    criteria: [
      {
        id: "R4",
        priority: "hard" as const,
        sourceRefs: [],
        definitionQuestions: [],
        expression: { kind: "atom" as const, id: "cpp", statement: "C++ production systems" },
      },
    ],
  };
  const { view, render } = await mount(
    <CandidateDirectory
      rows={[candidate]}
      criterionRevision={criterionRevision}
      onOpen={vi.fn()}
    />,
  );
  expect(view.textContent).toContain("C++ production systems · R4 · Partial match");
  await act(async () => button(view, "Cards").click());
  expect(view.textContent).toContain("C++ production systems · R4 · Partial match");
  await render(
    <CandidateDirectory
      rows={[candidate]}
      criterionRevision={{ ...criterionRevision, id: "revision-2" }}
      onOpen={vi.fn()}
    />,
  );
  expect(view.textContent).not.toContain("C++ production systems");
  expect(view.textContent).toContain("Criterion name unavailable · R4 · Partial match");
});

it("shows the Fit column only once someone in the list has an assessment", async () => {
  const { view, render } = await mount(
    <CandidateDirectory rows={[row("a"), row("b")]} onOpen={vi.fn()} />,
  );
  const headers = () => [...view.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(headers()).not.toContain("Fit");
  await render(
    <CandidateDirectory rows={[row("a"), row("b", [field("Grade", "A")])]} onOpen={vi.fn()} />,
  );
  expect(headers()).toContain("Fit");
});

it("shows education from a graded row and from the saved profile when the newest row has none", async () => {
  const graded = projectRecruitingCandidateReport({
    name: "Candidate graded",
    linkedin_url: "https://www.linkedin.com/in/graded",
    current_title: "Site Leader",
    current_company: "Example Fulfillment",
    education: ["Example State University | BS, Supply Chain | 2010 – 2014"],
    match_score: 97,
    match_tier: "Strong",
  });
  const saved = row(
    "saved",
    graded.fields.filter((item) => item.label !== "Education"),
  );
  saved.autumn!.savedProfile = {
    personKey: "linkedin:/in/saved",
    provider: "people_search",
    fetchedAt: "2026-10-30T10:00:00.000Z",
    headline: null,
    profileImageUrl: null,
    experience: [],
    education: [
      {
        school_name: "Example Institute of Technology",
        degree: "MS, Operations",
        field_of_study: null,
        school_url: null,
        school_logo_url: null,
        start_date: "2015",
        end_date: "2017",
      },
    ],
  };
  const { view } = await mount(
    <CandidateDirectory rows={[row("graded", graded.fields), saved]} onOpen={vi.fn()} />,
  );
  const cells = [...view.querySelectorAll("tbody tr")].map((item) => item.textContent ?? "");
  expect(cells[0]).toContain("Example State University");
  expect(cells[1]).toContain("Example Institute of Technology");
});
