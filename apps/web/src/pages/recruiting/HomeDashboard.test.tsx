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
const listReminders = vi.hoisted(() => vi.fn());
const updateReminder = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: {
      getWorkspace,
      listCandidates,
      roleCandidates,
      roleCampaign,
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
  listCandidates.mockResolvedValue({
    items: [{ shortlisted: true, firstDiscoveredAt: new Date().toISOString() }],
    total: 3,
  });
  roleCandidates.mockResolvedValue({
    items: [],
    nextCursor: null,
    total: 0,
    counts: { shortlisted: 3, replied: 1 },
    crmStatus: "ok",
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
  const funnel = container.querySelector('[aria-label="Outreach conversion"]')!;
  const stages = [...funnel.querySelectorAll("li")].map((item) => item.textContent);
  expect(stages).toEqual(["Shortlisted6100%", "Contacted— ", "Replied233%", "Interested— "]);
  const weeks = [...container.querySelectorAll('[aria-label="Shortlisted profiles"] li')];
  expect(weeks).toHaveLength(5);
  expect(weeks.at(-1)!.getAttribute("aria-label")).toMatch(/: 2$/);
  expect(text()).not.toContain("could not be read");
});

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
  expect(container.querySelector('[aria-label="Outreach conversion"]')).not.toBeNull();
});

it("flags roles whose outreach could not be read and keeps the rest", async () => {
  roleCampaign.mockRejectedValueOnce(new Error("down"));
  await render();
  expect(text()).toContain("Some roles could not be read.");
  expect(container.querySelector('[aria-label="Outreach conversion"]')).not.toBeNull();
});

it("shows an empty overview when no role is bound yet", async () => {
  getWorkspace.mockResolvedValue(null);
  await render();
  expect(text()).toContain("No shortlisted profiles yet.");
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
