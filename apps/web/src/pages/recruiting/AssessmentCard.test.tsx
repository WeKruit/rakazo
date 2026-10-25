// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { LinkFaviconsContext } from "@rakazo/chat-ui/web";
import { AssessmentCard } from "./AssessmentCard";

const ICON = "data:image/png;base64,AAAA";
const loadFavicon = vi.fn(async (_origin: string) => ({ icon: ICON }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

const REASONING = "Stanford, CA is in the SF Bay Area; candidate is a Stanford PhD student.";
const SUMMARY = "A long paragraph of the full assessment.";

function render(quick: Parameters<typeof AssessmentCard>[0]["quick"]) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <LinkFaviconsContext.Provider value={{ load: loadFavicon }}>
        <AssessmentCard
          score="78"
          rank={null}
          summary={SUMMARY}
          quick={quick}
          rows={[
            {
              key: "criterion:Bay area based",
              label: "Bay area based",
              status: "match",
              ...(quick.headline ? { brief: { name: "常驻湾区", verdict: "人在湾区" } } : {}),
              text: REASONING,
              sourceUrls: ["https://example.test/source"],
            },
          ]}
          sourceUrls={[]}
        />
      </LinkFaviconsContext.Provider>,
    ),
  );
  return host;
}

it("leads with the short output and keeps reasoning and summary one click away", async () => {
  const view = render({
    headline: "斯坦福博士，移动操作一作",
    highlights: ["湾区", "NVIDIA GEAR 实习"],
    keyWorks: [{ title: "BRS", detail: "CoRL 2025", url: "https://example.test/brs" }],
    concerns: ["未提仿真栈"],
    entities: [{ name: "NVIDIA", kind: "company", host: "nvidia.example", description: null }],
  });
  expect(view.textContent).toContain("斯坦福博士，移动操作一作");
  expect(view.textContent).toContain("湾区");
  // The organization's icon comes from our API, never straight from its site.
  await act(async () => {});
  expect(loadFavicon).toHaveBeenCalledWith("https://nvidia.example");
  expect(view.querySelector(`img[src="${ICON}"]`)).not.toBeNull();
  expect(view.textContent).toContain("NVIDIA GEAR 实习");
  expect(view.querySelector('a[href="https://example.test/brs"]')?.textContent).toBe(
    "BRSCoRL 2025",
  );
  expect(view.textContent).toContain("未提仿真栈");
  expect(view.textContent).toContain("常驻湾区");
  expect(view.textContent).toContain("人在湾区");
  expect(view.textContent).not.toContain(REASONING);
  expect(view.textContent).not.toContain(SUMMARY);

  const row = view.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  act(() => row.click());
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(view.textContent).toContain(REASONING);

  const full = [...view.querySelectorAll("button")].find(
    (button) => button.textContent === "Full assessment",
  )!;
  act(() => full.click());
  expect(view.textContent).toContain(SUMMARY);
});

it("shows older candidates' criteria by name with a one-line preview", () => {
  const view = render({
    headline: null,
    highlights: [],
    keyWorks: [],
    concerns: [],
    entities: [],
  });
  expect(view.textContent).toContain("Bay area based");
  expect(view.querySelector(".truncate")?.textContent).toBe(REASONING);
  expect(view.querySelector(".line-clamp-3")?.textContent).toBe(SUMMARY);
});
