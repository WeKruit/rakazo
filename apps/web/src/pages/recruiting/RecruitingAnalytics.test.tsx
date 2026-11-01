// @vitest-environment jsdom

import type { RecruitingAnalyticsInput, RecruitingAnalyticsOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { RecruitingAnalytics } from "./RecruitingAnalytics";

const output: RecruitingAnalyticsOutput = {
  roles: [{ id: "r", title: "Engineer", groupId: "g" }],
  observedShortlistedPeople: 3,
  shortlistDateUnknownPeople: 2,
  observedContactedPeople: null,
  observedRepliedPeople: null,
  firstContactedPeople: null,
  replyRate: null,
  coverage: "partial",
  sources: {
    storedCrmMessages: "unavailable",
    nativeCorrespondence: "not_included",
    importedCorrespondence: "not_included",
    firstSendHistory: "unknown",
    replyClassification: "unknown",
    identityResolution: "partial",
    shortlistHistory: "unknown",
  },
};
it("shows incomplete coverage and unknown metrics, and sends role filtering to the server", async () => {
  const load = vi.fn(async (_input: RecruitingAnalyticsInput) => output);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <RecruitingAnalytics accountKey="a" load={load} />
        </MemoryRouter>,
      ),
    );
    expect(host.textContent).toContain("Native and imported correspondence are not included");
    expect(host.textContent).toContain("No dated CRM messages");
    expect(host.textContent).toContain("Unknown");
    const select = host.querySelector("select")!;
    await act(async () => {
      select.value = "r";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(load.mock.lastCall?.[0]).toMatchObject({ roleId: "r" });
    await act(async () =>
      root.render(
        <MemoryRouter>
          <RecruitingAnalytics accountKey="b" load={() => new Promise(() => {})} />
        </MemoryRouter>,
      ),
    );
    expect(host.textContent).not.toContain("Engineer");
    expect(host.textContent).toContain("Loading analytics");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([
  ["2026-10-01", "2026-99-99"],
  ["2026-02-30", "2026-03-31"],
  ["2026-02-01", "2026-02-29"],
])("rejects invalid calendar dates %s through %s before loading", async (since, until) => {
  const load = vi.fn(async (_input: RecruitingAnalyticsInput) => output);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/?analyticsSince=${since}&analyticsUntil=${until}`]}>
          <RecruitingAnalytics accountKey="a" load={load} />
        </MemoryRouter>,
      ),
    );
    expect(host.textContent).toContain("Choose a valid date range.");
    expect(load).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
