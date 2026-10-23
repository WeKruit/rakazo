// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExperienceTimeline } from "./ProfileTimeline";
import { candidateSections, storedProfileFields } from "./profile";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("preserves employer evidence and reasoning even when no value is supplied", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const sections = candidateSections([
    {
      label: "Employer descriptions",
      value: null,
      evidence: "Original employment evidence",
      reasoning: "Dates unverified",
      sourceUrls: ["https://evidence.example.test"],
    },
  ]);
  await act(async () =>
    root.render(
      <ExperienceTimeline
        fields={sections.experience}
        Sources={({ urls }) => <a href={urls[0]}>Source</a>}
      />,
    ),
  );
  expect(node.textContent).toContain("Original employment evidence");
  expect(node.textContent).toContain("Dates unverified");
  expect(node.querySelector("a")?.href).toBe("https://evidence.example.test/");
  await act(async () => root.unmount());
});

it("renders explicit company-only and title-only history without guessing an organization", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const fields = storedProfileFields({
    history: [
      { company: "Example Labs" },
      { title: "Example Labs" },
      { description: "Supplied work description with unknown employer", location: "Remote" },
    ],
    summary: "",
    skills: [],
    sources: [],
  });
  await act(async () =>
    root.render(
      <ExperienceTimeline
        fields={fields}
        Sources={() => null}
        asset={{ name: "Example Labs", url: "https://assets.example.test/logo.png" }}
        link={{ name: "Example Labs", url: "https://company.example.test" }}
      />,
    ),
  );
  const rows = node.querySelectorAll("li");
  expect(rows).toHaveLength(3);
  expect(rows[0]?.querySelector("a")?.href).toBe("https://company.example.test/");
  expect(rows[0]?.querySelector("img")?.src).toBe("https://assets.example.test/logo.png");
  expect(rows[1]?.querySelector("img")).toBeNull();
  expect(rows[1]?.querySelector("a")).toBeNull();
  expect(rows[2]?.textContent).toContain("Supplied work description with unknown employer");
  expect(node.textContent).not.toContain("Present");
  await act(async () => root.unmount());
});

it("includes distinct dated plain jobs alongside mapped history in visible rows and total tenure", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <ExperienceTimeline
        fields={[
          {
            label: "Employment",
            value: "Engineer, Earlier Labs (Jan 2010–Jan 2015)",
            sourceUrls: [],
          },
          {
            label: "Experience",
            value: null,
            structuredValue: [
              {
                title: "Scientist",
                company_name: "Later Labs",
                start_date: "Jan 2020",
                end_date: "Jan 2021",
              },
            ],
            sourceUrls: [],
          },
        ]}
        Sources={() => null}
      />,
    ),
  );
  expect(node.querySelectorAll("li")).toHaveLength(2);
  const total = [...node.querySelectorAll("dt")].find(
    (item) => item.textContent === "Total experience",
  );
  expect(total?.nextElementSibling?.textContent).toBe("6 yrs");
  await act(async () => root.unmount());
});
