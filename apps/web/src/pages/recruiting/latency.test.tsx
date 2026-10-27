// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listCandidates = vi.hoisted(() => vi.fn());
const crmData = vi.hoisted(() => vi.fn());
const correspondence = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { listCandidates, crmData, correspondence } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, _1, other }: { value: number; _1: string; other: string }) =>
    (value === 1 ? _1 : other).replace("#", String(value)),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { ContactsTab } from "./ContactsTab";
import { InterviewTab } from "./InterviewTab";
import { InboxTab, SequenceTab } from "./index";

const LATENCY = 300;
const ORG = "00000000-0000-4000-8000-000000000001";
const ROLE = "00000000-0000-4000-8000-000000000002";
const target = {
  mcpServerId: "crm-source",
  serverRevision: 3,
  organizationId: ORG,
  crmRoleId: ROLE,
  crmClientId: "00000000-0000-4000-8000-000000000003",
  clientLabel: "Acme",
  roleLabel: "Staff Engineer",
};
const source = { serverId: "crm-source", serverRevision: 3, name: "CRM", organizationId: ORG };
const checkedAt = "2026-10-22T10:00:00Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (n: number) => ({
  candidateId: uuid(1000 + n),
  name: `Person ${n}`,
  email: null,
  phone: null,
  linkedinUrl: null,
  location: null,
  title: null,
  stage: "Interview",
  contactStatus: "email_found",
  outreachStatus: "replied",
  roleSpecId: ROLE,
  legacyClientLabel: "Acme",
  legacyRoleLabel: "Staff Engineer",
});
const TOTAL = 120;
type Input = { operation: string; offset?: number; limit?: number };
function respond(input: Input) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  const end = Math.min(offset + limit, TOTAL);
  const base = { source, checkedAt, offset, total: TOTAL };
  if (input.operation === "candidates")
    return {
      ...base,
      operation: "candidates",
      scope: "organization",
      selectedRole: null,
      items: Array.from({ length: end - offset }, (_, i) => person(offset + i)),
      nextOffset: end < TOTAL ? end : null,
    };
  if (input.operation === "roleCampaigns")
    return {
      ...base,
      operation: "roleCampaigns",
      scope: "stored_role_campaigns",
      crmRoleId: ROLE,
      items: [],
      nextOffset: null,
    };
  if (input.operation === "roleMail")
    return {
      ...base,
      operation: "roleMail",
      scope: "stored_role_correspondence",
      crmRoleId: ROLE,
      supported: true,
      items: [],
      nextOffset: null,
    };
  throw new Error(`unexpected ${input.operation}`);
}
const delayed = <T,>(value: () => T) =>
  new Promise<T>((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(value());
      } catch (error) {
        reject(error);
      }
    }, LATENCY),
  );

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listCandidates.mockImplementation(() =>
    delayed(() => ({ crmTarget: { bindingEffectId: "binding", target } })),
  );
  crmData.mockImplementation((input: Input) => delayed(() => respond(input)));
  correspondence.mockImplementation(() =>
    delayed(() => ({
      roleId: "role-1",
      status: "ready",
      checkedAt,
      connectionChanged: false,
      connections: [],
      emails: [],
      events: [],
      contacts: [],
      partial: false,
    })),
  );
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const hasRows = (view: HTMLElement) => view.textContent?.includes("Person 0") ?? false;

/** Virtual ms until the first CRM row renders, with every RPC taking LATENCY ms. */
async function timeToFirstRows(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  let elapsed = 0;
  while (!hasRows(container) && elapsed < LATENCY * 10) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LATENCY);
    });
    elapsed += LATENCY;
  }
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { elapsed, container };
}
const props = { roleId: "role-1", spaceId: "space-1", conversation: { groupId: "group-1" } };

const requested = () =>
  crmData.mock.calls.reduce((sum, [input]) => sum + ((input as Input).limit ?? 0), 0);
const report = (label: string, elapsed: number) =>
  console.info(
    `[latency] ${label}: ${elapsed}ms, listCandidates ${listCandidates.mock.calls.length}, crmData ${crmData.mock.calls.length}, rows requested ${requested()}`,
  );

const tabs = { ContactsTab, SequenceTab, InboxTab, InterviewTab };
for (const [name, Tab] of Object.entries(tabs)) {
  it(`${name}: a tab without the role binding still reads it first (one serial hop)`, async () => {
    const { elapsed } = await timeToFirstRows(<Tab {...props} />);
    report(`${name} without binding`, elapsed);
    expect(elapsed).toBe(2 * LATENCY);
    expect(listCandidates).toHaveBeenCalledTimes(1);
  });

  it(`${name}: the panel's known binding renders the first small page after one read`, async () => {
    const { elapsed } = await timeToFirstRows(<Tab {...props} crmTarget={target} />);
    report(`${name} with binding`, elapsed);
    expect(elapsed).toBe(LATENCY);
    expect(listCandidates).not.toHaveBeenCalled();
    // List pages are 25 rows; Sequence also totals statuses in 50-row reads.
    for (const [input] of crmData.mock.calls)
      if ((input as Input).operation !== "sequenceStats")
        expect([25, ...(name === "SequenceTab" ? [50] : [])]).toContain((input as Input).limit);
  });

  it(`${name}: a revisited tab renders cached rows at once and refreshes in the background`, async () => {
    const readCache = { entries: new Map<string, unknown>(), epoch: 0 };
    const cached = { ...props, crmTarget: target, readCache, readCacheScope: "user:space:thread" };
    await timeToFirstRows(<Tab {...cached} />);
    await cleanup?.();
    crmData.mockClear();
    const { elapsed, container } = await timeToFirstRows(<Tab {...cached} />);
    report(`${name} revisit`, elapsed);
    expect(elapsed).toBe(0);
    expect(container.querySelector('[role="status"]')).toBeNull();
    // The background refresh still runs.
    expect(crmData).toHaveBeenCalled();
  });
}

it("discards a response issued before the read cache was cleared", async () => {
  const readCache = { entries: new Map<string, unknown>(), epoch: 0 };
  const cached = { ...props, crmTarget: target, readCache, readCacheScope: "user:space:thread" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ContactsTab {...cached} />));
  readCache.epoch++;
  readCache.entries.clear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LATENCY);
  });
  expect(container.textContent).not.toContain("Person 0");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(readCache.entries.size).toBe(0);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
});

it("discards a stale page when the role changes before it returns", async () => {
  const other = { ...target, crmRoleId: "00000000-0000-4000-8000-000000000009" };
  crmData.mockImplementation((input: Input & { crmRoleId: string }) =>
    delayed(() => ({
      ...respond(input),
      items: [{ ...person(0), name: input.crmRoleId === ROLE ? "Old role" : "New role" }],
      nextOffset: null,
    })),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ContactsTab {...props} crmTarget={target} />));
  await act(async () => root.render(<ContactsTab {...props} crmTarget={other} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LATENCY);
  });
  expect(container.textContent).toContain("New role");
  expect(container.textContent).not.toContain("Old role");
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
});

it("prefers the API's cursor over the offset when one is returned", async () => {
  crmData.mockImplementation((input: Input & { cursor?: string }) =>
    delayed(() => {
      const offset = input.cursor ? Number(input.cursor.slice(1)) : 0;
      const page = respond({ ...input, offset });
      return {
        ...page,
        offset: 0,
        nextOffset: null,
        nextCursor: page.nextOffset === null ? null : `c${page.nextOffset}`,
      };
    }),
  );
  const { container } = await timeToFirstRows(<ContactsTab {...props} crmTarget={target} />);
  const more = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load more");
  await act(async () => more!.click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LATENCY);
  });
  expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
  expect(crmData.mock.calls[1]![0]).toMatchObject({ cursor: "c25" });
  expect(crmData.mock.calls[1]![0]).not.toHaveProperty("offset");
});

it("loads every CRM page while keeping the rendered window bounded", async () => {
  const { container } = await timeToFirstRows(<ContactsTab {...props} crmTarget={target} />);
  expect(container.querySelectorAll("tbody tr")).toHaveLength(25);
  const more = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Load more");
  for (let shown = 50; shown < TOTAL + 25; shown += 25) {
    await act(async () => more()!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LATENCY);
    });
    const loaded = Math.min(shown, TOTAL);
    expect(container.querySelector("table")?.getAttribute("aria-rowcount")).toBe(
      String(loaded + 1),
    );
    expect(container.querySelectorAll("tbody tr:has(th)").length).toBeLessThanOrEqual(80);
  }
  expect(container.querySelector("table")?.getAttribute("aria-rowcount")).toBe(String(TOTAL + 1));
  expect(more()).toBeUndefined();
  expect(crmData.mock.calls.map(([input]) => (input as Input).offset ?? 0)).toEqual([
    0, 25, 50, 75, 100,
  ]);
});
