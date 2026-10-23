// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listCandidates = vi.hoisted(() => vi.fn());
const crmData = vi.hoisted(() => vi.fn());
const correspondence = vi.hoisted(() => vi.fn());
const roleCampaign = vi.hoisted(() => vi.fn());
const reminders = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("../../lib/read-retry", () => ({
  retryTransientRead: <T,>(read: () => Promise<T>) => read(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { listCandidates, crmData, correspondence, roleCampaign, reminders } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import type { RecruitingReminder } from "@rakazo/contracts";
import { RecruitingChatContextProvider } from "../shell/recruiting-chat-context";
import { ActivityTab } from "./ActivityTab";
import { RecruitingDetailPanel } from "./DetailPanel";
import type { RecruitingDetailController, RecruitingDetailTarget } from "./detail";
import { reminderCandidateKey, TasksTab } from "./TasksTab";

const ORG = "00000000-0000-4000-8000-000000000001";
const ROLE = "00000000-0000-4000-8000-000000000002";
const ADA = "00000000-0000-4000-8000-00000000000a";
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
const person = {
  candidateId: ADA,
  name: "Ada",
  email: "ada@example.com",
  stage: "screening",
  outreachStatus: "replied",
};
const role = { roleId: "role-1", spaceId: "space-1", conversation: { groupId: "group-1" } };
const day = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();

const mailPage = (items: unknown[]) => ({
  operation: "mail",
  source,
  checkedAt: ago(0),
  scope: "stored_candidate_correspondence",
  outbox: [],
  candidateId: ADA,
  nativeCorrespondence: [],
  items,
  nextCursor: null,
});
const detailsPage = (extra: Record<string, unknown> = {}) => ({
  operation: "candidateDetails",
  source,
  checkedAt: ago(0),
  scope: "stored_candidate_details",
  outbox: [],
  candidateId: ADA,
  review: null,
  roleTracking: [],
  roleInterests: [],
  campaignAssociations: { leadCampaigns: [], pipelineCampaign: null, offset: 0, nextOffset: null },
  ...extra,
});
const empty = {
  roleId: "role-1",
  status: "ready",
  checkedAt: null,
  connectionChanged: false,
  connections: [],
  emails: [],
  events: [],
  contacts: [],
  partial: false,
  nextCursor: null,
};

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listCandidates.mockResolvedValue({ crmTarget: { bindingEffectId: "binding", target } });
  correspondence.mockResolvedValue(empty);
  roleCampaign.mockResolvedValue({
    status: "ready",
    serverId: "s",
    campaign: {
      id: "c",
      name: "Staff outreach [role x]",
      eaccount: null,
      status: 1,
      stopOnReply: true,
    },
    leads: [{ candidateKey: null, email: "ada@example.com", status: 1, interestStatus: null }],
  });
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "mail"
      ? mailPage([
          {
            id: "m1",
            providerMessageId: "p1",
            threadId: null,
            direction: "sent",
            sender: "me@example.com",
            recipients: ["ada@example.com"],
            subject: "Staff role",
            body: "Hello",
            date: ago(3),
            partial: false,
          },
          {
            id: "m2",
            providerMessageId: "p2",
            threadId: null,
            direction: "received",
            sender: "ada@example.com",
            recipients: ["me@example.com"],
            subject: "Re: Staff role",
            body: "Happy to talk",
            date: ago(2),
            partial: false,
          },
        ])
      : detailsPage({
          roleTracking: [
            {
              roleKey: "Staff Engineer (Acme)",
              clientLabel: "Acme",
              roleLabel: "Staff Engineer",
              highSignal: false,
              workflowStatus: "needs_scheduling",
              highSignalAt: null,
              statusChangedAt: ago(1),
              updatedAt: ago(1),
            },
          ],
          roleInterests: [
            {
              roleKey: "Staff Engineer (Acme)",
              clientLabel: "Acme",
              roleLabel: "Staff Engineer",
              interest: "declined",
              source: "ai",
            },
          ],
        }),
  );
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await settle();
  await settle();
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const button = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll("button")].find((item) => item.textContent === name);
const entries = (view: HTMLElement) =>
  [...view.querySelectorAll("ol > li")].map((item) => item.textContent);

it("shows the person's stored activity newest first with current status and sequence", async () => {
  const view = await mount(<ActivityTab {...role} person={person} />);
  const items = entries(view);
  expect(items[0]).toContain("Status changed to “Needs scheduling”");
  expect(items[0]).toContain("yesterday");
  expect(items[1]).toContain("Ada replied");
  expect(items[1]).toContain("Re: Staff role");
  expect(items[1]).toContain("2 days ago");
  expect(items[2]).toContain("Email sent");
  expect(items).toHaveLength(3);
  expect(view.textContent).toContain("Not interested");
  expect(view.textContent).toContain("Staff outreach · Active");
  expect(view.textContent).not.toContain("[role");
  expect(view.textContent).not.toContain("Viewed");
});

it("shows loading, then a retry that re-reads after a failure", async () => {
  let fail = true;
  const base = crmData.getMockImplementation()!;
  crmData.mockImplementation(async (input: { operation: string }) => {
    if (fail && input.operation === "mail") throw new Error("down");
    return base(input);
  });
  let release: () => void = () => undefined;
  correspondence.mockImplementation(
    () => new Promise((resolve) => (release = () => resolve(empty))),
  );
  const view = await mount(<ActivityTab {...role} person={person} />);
  expect(view.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => release());
  await settle();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load all activity.",
  );
  // What did load stays on screen.
  expect(entries(view)[0]).toContain("Status changed");
  fail = false;
  correspondence.mockResolvedValue(empty);
  await act(async () => button(view, "Retry")!.click());
  await settle();
  await settle();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(entries(view).some((text) => text?.includes("Ada replied"))).toBe(true);
});

it("says so in one line when nothing is stored", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "mail" ? mailPage([]) : detailsPage(),
  );
  roleCampaign.mockResolvedValue({ status: "none", serverId: null, campaign: null, leads: [] });
  const view = await mount(<ActivityTab {...role} person={{ candidateId: ADA, name: "Ada" }} />);
  expect(view.textContent).toBe("No activity yet.");
});

function panelFor(current: RecruitingDetailTarget) {
  const controller: RecruitingDetailController = {
    stack: [current],
    current,
    open: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    close: vi.fn(),
    pending: null,
    restore: vi.fn(),
  };
  return (
    <RecruitingChatContextProvider
      value={{ setSelectedContact: () => undefined, setSelectedEmail: () => undefined }}
    >
      <RecruitingDetailPanel controller={controller} />
    </RecruitingChatContextProvider>
  );
}

it("adds Activity and Tasks to the detail tabs", async () => {
  const view = await mount(panelFor({ view: "activity", person, role }));
  expect(button(view, "Activity")?.getAttribute("aria-pressed")).toBe("true");
  expect(button(view, "Tasks")).toBeDefined();
  expect(view.querySelector('section[aria-label="Activity"]')).not.toBeNull();
});

it("keys reminders by search result first, then CRM record", async () => {
  expect(reminderCandidateKey("k1", ADA)).toBe("autumn:k1");
  expect(reminderCandidateKey(undefined, ADA)).toBe(`crm:${ADA}`);
  expect(reminderCandidateKey(undefined, false)).toBeNull();
  expect(reminderCandidateKey("has space", false)).toBeNull();
  remindersMock([]);
  const view = await mount(panelFor({ view: "tasks", person, role }));
  expect(reminders.list).toHaveBeenCalledWith({
    roleId: "role-1",
    candidateKey: `crm:${ADA}`,
    status: "open",
  });
  expect(view.textContent).toContain("Create reminder");
});

it("hides Tasks for a person with no reminder key", async () => {
  const view = await mount(
    panelFor({ view: "tasks", person: { candidateId: "x", name: "Ada" }, role, crm: false }),
  );
  expect(button(view, "Tasks")).toBeUndefined();
  expect(button(view, "Profile")?.getAttribute("aria-pressed")).toBe("true");
});

function reminder(id: string, extra: Partial<RecruitingReminder>): RecruitingReminder {
  return {
    id,
    roleId: "role-1",
    candidateKey: `crm:${ADA}`,
    title: id,
    note: null,
    dueAt: ago(-1),
    status: "open",
    completedAt: null,
    createdBy: "user",
    createdAt: ago(5),
    ...extra,
  };
}
function remindersMock(items: RecruitingReminder[]) {
  reminders.list.mockImplementation(async () => ({ items, overdueCount: 0 }));
  reminders.create.mockImplementation(async () => reminder("new", {}));
  reminders.update.mockImplementation(async () => reminder("x", {}));
  reminders.delete.mockImplementation(async () => ({ ok: true }));
  return reminders;
}
const tasks = () => <TasksTab roleId="role-1" candidateKey={`crm:${ADA}`} />;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("groups open reminders into Overdue and Upcoming with Edit, Done and Delete", async () => {
  const api = remindersMock([
    reminder("Check references", { dueAt: ago(-5) }),
    reminder("Call back", { dueAt: ago(2), note: "Ask about notice period" }),
    reminder("Send notes", { dueAt: ago(-2) }),
  ]);
  const view = await mount(tasks());
  const overdue = view.querySelector<HTMLElement>('section[aria-label="Overdue (1)"]')!;
  const upcoming = view.querySelector<HTMLElement>('section[aria-label="Upcoming (2)"]')!;
  expect(overdue.textContent).toContain("Call back");
  expect(overdue.textContent).toContain("2 days ago");
  expect(overdue.textContent).toContain("Ask about notice period");
  expect(upcoming.textContent).toMatch(/Send notes.*in 2 days.*Check references/);
  await act(async () => button(overdue, "Done")!.click());
  await settle();
  expect(api.update).toHaveBeenCalledWith({ id: "Call back", status: "done" });
  expect(api.list).toHaveBeenCalledTimes(2);
  await act(async () => button(view, "Delete")!.click());
  await settle();
  expect(api.delete).toHaveBeenCalledWith({ id: "Call back" });
  await act(async () => button(view, "Edit")!.click());
  const title = view.querySelector<HTMLInputElement>('input[aria-label="Reminder"]')!;
  expect(title.value).toBe("Call back");
  await type(title, "Call back Friday");
  await act(async () => button(view, "Save")!.click());
  await settle();
  expect(api.update).toHaveBeenCalledWith({
    id: "Call back",
    title: "Call back Friday",
    dueAt: expect.any(String),
  });
});

it("creates a reminder once it has a title and due time", async () => {
  const api = remindersMock([]);
  const view = await mount(tasks());
  expect(view.textContent).toContain("Overdue (0)");
  expect(view.textContent).toContain("Upcoming (0)");
  await act(async () => button(view, "Create reminder")!.click());
  await type(view.querySelector<HTMLInputElement>('input[aria-label="Reminder"]')!, "Follow up");
  expect(button(view, "Save")?.disabled).toBe(true);
  await type(view.querySelector<HTMLInputElement>('input[aria-label="Due"]')!, "2026-11-02T09:30");
  await act(async () => button(view, "Save")!.click());
  await settle();
  expect(api.create).toHaveBeenCalledWith({
    title: "Follow up",
    dueAt: new Date("2026-11-02T09:30").toISOString(),
    roleId: "role-1",
    candidateKey: `crm:${ADA}`,
  });
  expect(button(view, "Create reminder")).toBeDefined();
});

it("shows a retry when reminders fail to load and an alert when a change fails", async () => {
  const api = remindersMock([reminder("Call back", {})]);
  api.list.mockRejectedValueOnce(new Error("down"));
  const view = await mount(tasks());
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("Could not load reminders.");
  await act(async () => button(view, "Retry")!.click());
  await settle();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  api.update.mockRejectedValueOnce(new Error("down"));
  await act(async () => button(view, "Done")!.click());
  await settle();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not save the reminder.",
  );
});
