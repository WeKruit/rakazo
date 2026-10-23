// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getWorkspace = vi.hoisted(() => vi.fn());
const listCandidates = vi.hoisted(() => vi.fn());
const roleCandidates = vi.hoisted(() => vi.fn());
const roleCampaign = vi.hoisted(() => vi.fn());
const correspondence = vi.hoisted(() => vi.fn());
const listReminders = vi.hoisted(() => vi.fn());
const updateReminder = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: {
      getWorkspace,
      listCandidates,
      roleCandidates,
      roleCampaign,
      correspondence,
      reminders: { list: listReminders, update: updateReminder },
    },
  },
}));
// One attempt per read keeps failures immediate in tests.
vi.mock("../../lib/read-retry", () => ({
  retryTransientRead: <T,>(read: () => Promise<T>) => read(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { HomeDashboard } from "./HomeDashboard";

const group = (id: string, name: string, updatedAt: string) =>
  ({
    id,
    name,
    threadId: `thread-${id}`,
    updatedAt,
    archivedAt: null,
  }) as Group;
const groups = [
  group("g1", "Staff Engineer", "2026-10-20T00:00:00Z"),
  group("g2", "Product Designer", "2026-10-22T00:00:00Z"),
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpenRole = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  getWorkspace.mockImplementation(async ({ threadId }: { threadId: string }) => ({
    role: { id: `role-${threadId}` },
  }));
  correspondence.mockResolvedValue({ status: "not_checked", events: [], partial: false });
  listCandidates.mockResolvedValue({
    items: [
      { shortlisted: true, shortlistedAt: new Date().toISOString(), firstDiscoveredAt: null },
    ],
    total: 3,
  });
  roleCandidates.mockResolvedValue({
    items: [],
    nextCursor: null,
    total: 0,
    counts: { shortlisted: 3, replied: 1 },
    crmStatus: "ok",
    crmCountsComplete: true,
  });
  roleCampaign.mockResolvedValue({ status: "none", serverId: null, campaign: null, leads: [] });
  listReminders.mockResolvedValue({ items: [], overdueCount: 0 });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render(props: Partial<Parameters<typeof HomeDashboard>[0]> = {}) {
  await act(async () => {
    root.render(
      <HomeDashboard userName="Ada Lovelace" groups={groups} onOpenRole={onOpenRole} {...props} />,
    );
  });
}

const text = () => container.textContent ?? "";
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(name) || item.getAttribute("aria-label") === name,
  )!;
async function select(label: string, value: string) {
  const control = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("shows skeletons while the overview loads", async () => {
  getWorkspace.mockReturnValue(new Promise(() => undefined));
  listReminders.mockReturnValue(new Promise(() => undefined));
  await render();
  expect(text()).toContain("Hello, Ada");
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);
  expect(text()).toContain("Staff Engineer");
});

it("aggregates every role into the weekly chart and the funnel", async () => {
  await render();
  expect(getWorkspace).toHaveBeenCalledTimes(2);
  expect(listCandidates).toHaveBeenCalledWith(
    expect.objectContaining({ roleId: "role-thread-g1", shortlisted: true }),
    expect.anything(),
  );
  const funnel = container.querySelector('[aria-label="Outreach funnel"]')!;
  const stages = [...funnel.querySelectorAll("li")].map((item) => item.textContent);
  expect(stages).toEqual(["Shortlisted6 ", "Contacted—Unknown", "Replied2 ", "Interested—Unknown"]);
  const weeks = [...container.querySelectorAll('[aria-label="Shortlisted profiles"] li')];
  expect(weeks).toHaveLength(4);
  expect(weeks.at(-1)!.getAttribute("aria-label")).toMatch(/: 2$/);
  expect(text()).not.toContain("could not be read");
});

it.each([false, undefined])(
  "keeps reply aggregates unknown without complete coverage: %s",
  async (crmCountsComplete) => {
    roleCandidates.mockResolvedValue({
      items: [],
      nextCursor: null,
      total: 0,
      counts: { shortlisted: 3, replied: 1 },
      crmStatus: "ok",
      crmCountsComplete,
    });
    await render();
    expect(container.querySelector('[aria-label="Outreach funnel"]')?.textContent).toContain(
      "Replied—Unknown",
    );
  },
);

it("opens a recent role, newest first", async () => {
  await render();
  const recents = [...container.querySelectorAll('[aria-label="Recents"] button')];
  expect(recents.map((item) => item.textContent)).toEqual([
    expect.stringContaining("Product Designer"),
    expect.stringContaining("Staff Engineer"),
  ]);
  await act(async () => (recents[0] as HTMLButtonElement).click());
  expect(onOpenRole).toHaveBeenCalledWith("g2");
});

it("shows an error with retry when no role can be read", async () => {
  getWorkspace.mockRejectedValue(new Error("down"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load your overview.",
  );
  getWorkspace.mockResolvedValue({ role: { id: "role" } });
  await act(async () => button("Retry").click());
  expect(container.querySelector('[aria-label="Outreach funnel"]')).not.toBeNull();
});

it("flags roles whose outreach could not be read and keeps the rest", async () => {
  roleCampaign.mockRejectedValueOnce(new Error("down"));
  await render();
  expect(text()).toContain("Some roles could not be read.");
  expect(container.querySelector('[aria-label="Outreach funnel"]')).not.toBeNull();
});

it("shows an empty overview when no role is bound yet", async () => {
  getWorkspace.mockResolvedValue(null);
  await render();
  expect(text()).toContain("No saved overview for these projects.");
  expect(listCandidates).not.toHaveBeenCalled();
});

it("lists open tasks overdue first and marks one done", async () => {
  listReminders.mockResolvedValue({
    overdueCount: 1,
    items: [
      {
        id: "later",
        roleId: "role-thread-g1",
        candidateKey: null,
        title: "Check in with Ben",
        note: null,
        dueAt: "2999-01-01T00:00:00Z",
        status: "open",
        completedAt: null,
        createdBy: "agent",
        createdAt: "2026-10-01T00:00:00Z",
      },
      {
        id: "late",
        roleId: null,
        candidateKey: null,
        title: "Send Ada the brief",
        note: null,
        dueAt: "2020-01-01T00:00:00Z",
        status: "open",
        completedAt: null,
        createdBy: "user",
        createdAt: "2019-12-01T00:00:00Z",
      },
    ],
  });
  updateReminder.mockResolvedValue({});
  await render();
  expect(listReminders).toHaveBeenCalledWith({ status: "open" });
  const items = [...container.querySelectorAll('ul[aria-label="Your tasks"] li')];
  expect(items.map((item) => item.querySelector("p")?.textContent)).toEqual([
    "Send Ada the brief",
    "Check in with Ben",
  ]);
  expect(items[0]!.textContent).toContain("Overdue");
  expect(items[1]!.textContent).toContain("Staff Engineer");
  await act(async () => button("Mark Send Ada the brief done").click());
  expect(updateReminder).toHaveBeenCalledWith({ id: "late", status: "done" });
  expect(text()).not.toContain("Send Ada the brief");
});

it("shows a retry when tasks cannot load", async () => {
  listReminders.mockRejectedValueOnce(new Error("down"));
  await render();
  expect(text()).toContain("Could not load your tasks.");
  await act(async () => button("Retry").click());
  expect(text()).toContain("No open tasks.");
});

it("filters project totals, recent roles, and tasks without starting more reads", async () => {
  listCandidates.mockImplementation(async ({ roleId }: { roleId: string }) => ({
    items: [{ shortlisted: true, shortlistedAt: new Date().toISOString() }],
    total: roleId === "role-thread-g1" ? 3 : 7,
  }));
  listReminders.mockResolvedValue({
    items: [
      {
        id: "one",
        title: "First project task",
        roleId: "role-thread-g1",
        status: "open",
        dueAt: "2999-01-01",
      },
      {
        id: "two",
        title: "Second project task",
        roleId: "role-thread-g2",
        status: "open",
        dueAt: "2999-01-01",
      },
      { id: "personal", title: "Personal task", roleId: null, status: "open", dueAt: "2999-01-01" },
    ],
  });
  await render();
  expect(container.querySelector('[aria-label="Outreach funnel"] li')?.textContent).toBe(
    "Shortlisted10 ",
  );
  await select("Project", "g2");
  expect(container.querySelector('[aria-label="Outreach funnel"] li')?.textContent).toBe(
    "Shortlisted7 ",
  );
  expect(
    [...container.querySelectorAll('[aria-label="Recents"] button')].map(
      (item) => item.textContent,
    ),
  ).toEqual([expect.stringContaining("Product Designer")]);
  const tasks = container.querySelector('ul[aria-label="Your tasks"]')!;
  expect(tasks.textContent).toContain("Second project task");
  expect(tasks.textContent).not.toContain("First project task");
  expect(tasks.textContent).not.toContain("Personal task");
  expect(getWorkspace).toHaveBeenCalledTimes(2);
  expect(listCandidates).toHaveBeenCalledTimes(2);
  expect(listReminders).toHaveBeenCalledTimes(1);
  await select("Project", "");
  expect(text()).toContain("Personal task");
});

it("filters recorded shortlist dates without relabeling all-time funnel data", async () => {
  const current = new Date();
  const older = new Date(current);
  older.setDate(older.getDate() - 42);
  const future = new Date(current);
  future.setDate(future.getDate() + 1);
  listCandidates.mockResolvedValue({
    items: [
      { shortlisted: true, shortlistedAt: current.toISOString() },
      { shortlisted: true, shortlistedAt: older.toISOString() },
      { shortlisted: true, shortlistedAt: future.toISOString() },
      { shortlisted: true, shortlistedAt: null },
    ],
    total: 4,
  });
  await render({ groups: [groups[0]!] });
  expect(container.querySelector('[data-testid="weekly-shortlist-total"]')?.textContent).toBe("1");
  expect(text()).toContain("1 without a recorded date");
  const funnel = container.querySelector('[aria-label="Outreach funnel"]')!;
  const before = funnel.textContent;
  expect(before).toContain("Current totals · all dates");
  await select("Shortlist period", "8");
  expect(container.querySelector('[data-testid="weekly-shortlist-total"]')?.textContent).toBe("2");
  expect(container.querySelectorAll('[aria-label="Shortlisted profiles"] li')).toHaveLength(8);
  expect(funnel.textContent).toBe(before);
  expect(listCandidates).toHaveBeenCalledTimes(1);
});

it("keeps unproven interest totals unknown and does not fabricate contacted counts", async () => {
  roleCampaign.mockResolvedValue({
    status: "ready",
    serverId: "fixture",
    campaign: { id: "campaign", status: 1 },
    leads: [
      { status: 1, interestStatus: null },
      { status: 3, interestStatus: 2 },
    ],
  });
  await render({ groups: [groups[0]!] });
  const funnel = container.querySelector('[aria-label="Outreach funnel"]')!;
  expect(funnel.textContent).toContain("Contacted—Unknown");
  expect(funnel.textContent).toContain("Interested—Unknown");
  expect(funnel.textContent).not.toContain("%");
  expect(funnel.textContent).toContain("Send totals are not available from these records.");
  // These populations are not a shared cohort: render counts without relative bar heights.
  expect(funnel.querySelector('[style*="height"]')).toBeNull();
  expect(funnel.querySelectorAll('button[aria-label^="Inspect "]')).toHaveLength(4);
});

it("keeps every week inspectable while sparsely labeling longer chart windows", async () => {
  await render();
  const chart = container.querySelector('[aria-label="Shortlisted profiles"]')!;
  for (const count of [4, 8, 12]) {
    await select("Shortlist period", String(count));
    const weeks = [...chart.querySelectorAll("ol button")];
    const labels = [...chart.querySelectorAll('[data-testid="weekly-shortlist-tick"]')];
    expect(weeks).toHaveLength(count);
    expect(labels).toHaveLength(4);
    expect(weeks[0]?.contains(labels[0]!)).toBe(true);
    expect(weeks.at(-1)?.contains(labels.at(-1)!)).toBe(true);
    const labeledIndexes = weeks.flatMap((week, index) =>
      week.querySelector('[data-testid="weekly-shortlist-tick"]') ? [index] : [],
    );
    if (count > 4)
      expect(labeledIndexes.slice(1).every((index, i) => index - labeledIndexes[i]! >= 2)).toBe(
        true,
      );
  }
});

it("keeps a missing project's metrics partial and offers retry instead of a false empty state", async () => {
  getWorkspace.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId === "thread-g2") throw new Error("unavailable");
    return { role: { id: `role-${threadId}` } };
  });
  await render();
  expect(container.querySelector('[aria-label="Outreach funnel"] li')?.textContent).toBe(
    "Shortlisted≥3Partial data",
  );
  await select("Project", "g1");
  expect(container.querySelector('[aria-label="Outreach funnel"] li')?.textContent).toBe(
    "Shortlisted3 ",
  );
  expect(text()).not.toContain("Some roles could not be read.");
  await select("Project", "g2");
  expect(text()).toContain("Could not load your overview.");
  expect(text()).not.toContain("No saved overview");
});

it("opens the source project from selected metric and weekly-chart breakdowns", async () => {
  await render();
  const funnel = container.querySelector<HTMLElement>('[aria-label="Outreach funnel"]')!;
  await act(async () =>
    funnel.querySelector<HTMLButtonElement>('button[aria-label="Inspect Shortlisted"]')!.click(),
  );
  let projects = [
    ...funnel.querySelectorAll<HTMLButtonElement>('ul[aria-label="Projects"] button'),
  ];
  expect(projects.map((item) => item.textContent)).toEqual([
    "Staff Engineer3",
    "Product Designer3",
  ]);
  await act(async () => projects[1]!.click());
  expect(onOpenRole).toHaveBeenLastCalledWith("g2", "shortlist");
  await act(async () =>
    funnel.querySelector<HTMLButtonElement>('button[aria-label="Inspect Contacted"]')!.click(),
  );
  projects = [...funnel.querySelectorAll<HTMLButtonElement>('ul[aria-label="Projects"] button')];
  expect(projects.map((item) => item.textContent)).toEqual([
    "Staff Engineer—",
    "Product Designer—",
  ]);
  const chart = container.querySelector<HTMLElement>('[aria-label="Shortlisted profiles"]')!;
  const weeks = [...chart.querySelectorAll<HTMLButtonElement>("ol button")];
  await act(async () => weeks.at(-1)!.click());
  const sourceProjects = [
    ...chart.querySelectorAll<HTMLButtonElement>('ul[aria-label="Projects"] button'),
  ];
  expect(sourceProjects.map((item) => item.textContent)).toEqual([
    "Staff Engineer1",
    "Product Designer1",
  ]);
  await act(async () => sourceProjects[0]!.click());
  expect(onOpenRole).toHaveBeenLastCalledWith("g1", "shortlist");
});

it("rejects a late overview response from the previous account scope and resets its project filter", async () => {
  let release: ((value: unknown) => void) | undefined;
  listCandidates.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await render({ groups: [groups[0]!], readCacheScope: "old-account" });
  await select("Project", "g1");
  listCandidates.mockResolvedValue({ items: [], total: 2 });
  await render({ groups: [groups[1]!], readCacheScope: "new-account" });
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Project"]')?.value).toBe(
    "",
  );
  expect(container.querySelector('[aria-label="Outreach funnel"] li')?.textContent).toBe(
    "Shortlisted2 ",
  );
  await act(async () => release?.({ items: [], total: 99 }));
  expect(container.querySelector('[aria-label="Outreach funnel"] li')?.textContent).toBe(
    "Shortlisted2 ",
  );
  expect(text()).not.toContain("Staff Engineer");
});

it.each([
  ["Shortlisted", "shortlist"],
  ["Contacted", "sequence"],
  ["Replied", "inbox"],
  ["Interested", "contacts"],
])("opens %s evidence in the same role's %s tab", async (label, view) => {
  await render();
  const funnel = container.querySelector<HTMLElement>('[aria-label="Outreach funnel"]')!;
  await act(async () =>
    funnel.querySelector<HTMLButtonElement>(`button[aria-label="Inspect ${label}"]`)!.click(),
  );
  const projects = funnel.querySelectorAll<HTMLButtonElement>('ul[aria-label="Projects"] button');
  await act(async () => projects[1]!.click());
  expect(onOpenRole).toHaveBeenLastCalledWith("g2", view);
  expect(funnel.textContent).toContain(
    "The destination is not filtered to this metric’s exact candidates.",
  );
});

it.each(["confirmed", "accepted"])(
  "shows future %s recorded bookings and opens their exact role Interview",
  async (bookingStatus) => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    correspondence.mockImplementation(async ({ groupId }: { groupId: string }) => ({
      roleId: `role-thread-${groupId}`,
      status: "ready",
      partial: groupId === "g2",
      events: [
        {
          id: "confirmed",
          kind: "event",
          status: bookingStatus,
          start: future,
          title: `Confirmed ${groupId}`,
        },
        { id: "cancelled", kind: "event", status: "cancelled", start: future, title: "Cancelled" },
        { id: "pending", kind: "event", status: "pending", start: future, title: "Pending" },
        {
          id: "availability",
          kind: "availability",
          status: "confirmed",
          start: future,
          title: "Free slot",
        },
        { id: "unknown", kind: "event", status: null, start: future, title: "Unknown status" },
        {
          id: "past",
          kind: "event",
          status: "confirmed",
          start: "2000-01-01T00:00:00Z",
          title: "Past",
        },
      ],
    }));
    await render();
    const list = container.querySelector('[aria-label="Upcoming recorded bookings"]')!;
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list.textContent).not.toMatch(/Cancelled|Pending|Free slot|Unknown status|Past/);
    await act(async () => list.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
    expect(onOpenRole).toHaveBeenLastCalledWith("g2", "interview");
    expect(text()).toContain("Some role calendar records are unavailable or partial.");
    await select("Project", "g1");
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(text()).not.toContain("Some role calendar records are unavailable or partial.");
  },
);
it("does not present another role's retained calendar events as this role's bookings", async () => {
  correspondence.mockResolvedValue({
    roleId: "other-role",
    status: "ready",
    partial: false,
    events: [
      {
        id: "wrong",
        kind: "event",
        status: "confirmed",
        title: "Wrong role",
        start: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ],
  });
  await render();
  expect(
    container.querySelector('[aria-label="Upcoming recorded bookings"]')!.textContent,
  ).not.toContain("Wrong role");
  expect(text()).toContain("Some role calendar records are unavailable or partial.");
});
