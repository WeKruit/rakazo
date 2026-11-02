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
  trend: [],
  groups: [],
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

it("groups observed history without turning missing rates into zero or summing people across roles", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const load = vi.fn(async () => ({
    ...output,
    observedContactedPeople: 2,
    observedRepliedPeople: 1,
    trend: [{ date: "2026-10-02", contacted: 2, replied: 1 }],
    groups: [
      { roleId: "r", title: "Engineer", contacted: 2, replied: 1 },
      { roleId: "r2", title: "Designer", contacted: 1, replied: 0 },
    ],
  }));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/?analyticsSince=2026-10-01&analyticsUntil=2026-10-31"]}>
          <RecruitingAnalytics accountKey="a" load={load} />
        </MemoryRouter>,
      ),
    );
    expect(host.querySelectorAll('svg[role="img"]')).toHaveLength(2);
    expect(host.querySelector("tbody tr")?.textContent).toContain(
      "All roles · deduplicated people21Unknown",
    );
    const select = host.querySelector('select[aria-label="Breakdown"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "response";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("Engineer · Observed reply");
    expect(host.textContent).toContain("Engineer · No observed reply");
    expect(host.textContent).not.toContain("0%");
    const group = host.querySelector('select[aria-label="Group by"]') as HTMLSelectElement;
    await act(async () => {
      group.value = "period";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector("tbody")?.textContent).toContain("2026-10-02");
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("opens an observed metric's exact role/date cohort without requesting unknown rates", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const load = vi.fn(async () => ({ ...output, observedContactedPeople: 2 }));
  const loadPeople = vi.fn(async () => ({
    items: [],
    total: 0,
    nextCursor: null,
    coverage: "partial" as const,
  }));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter
          initialEntries={["/?role=r&analyticsSince=2026-10-01&analyticsUntil=2026-10-31"]}
        >
          <RecruitingAnalytics accountKey="a" load={load} loadPeople={loadPeople} />
        </MemoryRouter>,
      ),
    );
    const metric = host.querySelector<HTMLButtonElement>(
      'button[aria-label="View observed contacted people"]',
    )!;
    expect(metric).not.toBeNull();
    expect(loadPeople).not.toHaveBeenCalled();
    await act(async () => metric.click());
    expect(loadPeople).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "contacted",
        roleId: "r",
        since: "2026-10-01T00:00:00Z",
        until: "2026-11-01T00:00:00.000Z",
        limit: 50,
      }),
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "Observed contacted people",
    );
    expect(host.querySelector('[aria-label="View open rate"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
