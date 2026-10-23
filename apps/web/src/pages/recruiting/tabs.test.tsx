// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listCandidates = vi.hoisted(() => vi.fn());
const crmData = vi.hoisted(() => vi.fn());
const correspondence = vi.hoisted(() => vi.fn());
const roleCampaign = vi.hoisted(() => vi.fn());
// A failure here stands for exhausted retries unless a test turns real retries on.
const readRetries = vi.hoisted(() => ({ real: false }));
vi.mock("../../lib/read-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/read-retry")>();
  return {
    ...actual,
    retryTransientRead: async <T,>(read: () => Promise<T>, signal?: AbortSignal) =>
      readRetries.real ? actual.retryTransientRead(read, signal) : read(),
  };
});
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { listCandidates, crmData, correspondence, roleCampaign } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { replyStatus } from "./InboxTab";
import { ContactsTab, InboxTab, InterviewTab, SequenceTab } from "./index";

const ORG = "00000000-0000-4000-8000-000000000001";
const ROLE = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-000000000003";
const ADA = "00000000-0000-4000-8000-00000000000a";
const BEN = "00000000-0000-4000-8000-00000000000b";
const target = {
  mcpServerId: "crm-source",
  serverRevision: 3,
  organizationId: ORG,
  crmRoleId: ROLE,
  crmClientId: CLIENT,
  clientLabel: "Acme",
  roleLabel: "Staff Engineer",
};
const source = { serverId: "crm-source", serverRevision: 3, name: "CRM", organizationId: ORG };
const checkedAt = "2026-10-22T10:00:00Z";
function person(candidateId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    candidateId,
    name,
    email: `${name.toLowerCase()}@example.com`,
    phone: null,
    linkedinUrl: `https://www.linkedin.com/in/${name.toLowerCase()}/`,
    location: "Remote",
    title: "Engineer",
    stage: "screening",
    contactStatus: "email_found",
    outreachStatus: "replied",
    roleSpecId: ROLE,
    legacyClientLabel: "Acme",
    legacyRoleLabel: "Staff Engineer",
    ...extra,
  };
}
const candidatesPage = {
  operation: "candidates",
  source,
  checkedAt,
  scope: "organization",
  selectedRole: null,
  items: [person(ADA, "Ada"), person(BEN, "Ben", { outreachStatus: "not_contacted" })],
  total: 2,
  offset: 0,
  nextOffset: null,
};
const savedCorrespondence = {
  roleId: "role-1",
  status: "ready",
  checkedAt,
  connectionChanged: false,
  connections: [],
  emails: [],
  events: [],
  contacts: [],
  partial: false,
};

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listCandidates.mockResolvedValue({ crmTarget: { bindingEffectId: "binding", target } });
  correspondence.mockResolvedValue(savedCorrespondence);
});
afterEach(async () => {
  readRetries.real = false;
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const props = { roleId: "role-1", spaceId: "space-1", conversation: { groupId: "group-1" } };

it("shows a loading indicator while the role binding is read", async () => {
  listCandidates.mockReturnValue(new Promise(() => {}));
  const view = await mount(<ContactsTab {...props} />);
  expect(view.querySelector('[role="status"]')?.textContent).toContain("Loading");
});

it("says the role is not linked instead of inventing CRM contacts", async () => {
  listCandidates.mockResolvedValue({ crmTarget: null });
  const view = await mount(<ContactsTab {...props} />);
  expect(view.textContent).toContain("This role is not linked to a CRM role yet.");
  expect(crmData).not.toHaveBeenCalled();
});

it("lists the role's CRM contacts with stage and saved email status", async () => {
  crmData.mockResolvedValue(candidatesPage);
  correspondence.mockResolvedValue({
    ...savedCorrespondence,
    contacts: [
      {
        candidateKey: "ada-key",
        linkedinUrl: "https://linkedin.com/in/ada",
        emails: [{ address: "ada@work.example.com", status: "valid" }],
        phones: [],
        source: "Lookup",
        checkedAt,
      },
    ],
  });
  const view = await mount(<ContactsTab {...props} />);
  expect(crmData).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "group-1",
      operation: "candidates",
      serverId: "crm-source",
      organizationId: ORG,
      crmRoleId: ROLE,
    }),
  );
  const ada = [...view.querySelectorAll("tbody tr")].find((row) =>
    row.textContent?.includes("Ada"),
  );
  expect(ada?.textContent).toContain("Screening");
  expect(ada?.textContent).toContain("Email found");
  expect(ada?.textContent).toContain("ada@work.example.com · Valid");
  expect(view.textContent).not.toContain("crm-source");
  expect(view.textContent).not.toContain(ADA);
});

it("shows campaign state and stored messages without any send control", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "roleCampaigns"
      ? {
          operation: "roleCampaigns",
          source,
          checkedAt,
          scope: "stored_role_campaigns",
          crmRoleId: ROLE,
          items: [{ id: "c1", name: "Staff outreach", status: 1, syncedAt: checkedAt }],
          offset: 0,
          nextOffset: null,
        }
      : input.operation === "candidates"
        ? candidatesPage
        : {
            operation: "candidateDetails",
            source,
            checkedAt,
            scope: "stored_candidate_details",
            candidateId: ADA,
            review: null,
            roleTracking: [],
            roleInterests: [],
            campaignAssociations: {
              leadCampaigns: [],
              pipelineCampaign: null,
              offset: 0,
              nextOffset: null,
            },
            outbox: [
              {
                id: "00000000-0000-4000-8000-0000000000f1",
                body: "Hi Ada",
                status: "sent",
                polishedBody: null,
                providerMessageId: null,
                error: null,
                createdAt: checkedAt,
                sentAt: checkedAt,
              },
            ],
          },
  );
  const view = await mount(<SequenceTab {...props} />);
  expect(view.textContent).toContain("Staff outreach");
  expect(view.querySelector("tbody td")?.textContent).toBe("1");
  expect(view.textContent).not.toContain("Active");
  expect(view.textContent).toContain("Replied · 1");
  const ada = [...view.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Ada"),
  )!;
  await act(async () => ada.click());
  await settle();
  expect(view.textContent).toContain("Hi Ada");
  expect(view.textContent).toContain("Sent");
  expect([...view.querySelectorAll("button")].some((b) => /send/i.test(b.textContent ?? ""))).toBe(
    false,
  );
});

const roleMailPage = (supported: boolean, items: unknown[] = []) => ({
  operation: "roleMail",
  source,
  checkedAt,
  scope: "stored_role_correspondence",
  crmRoleId: ROLE,
  supported,
  items,
  offset: 0,
  nextOffset: null,
});
const stored = (id: string, candidateId: string, subject: string, body: string, date: string) => ({
  id,
  providerMessageId: id,
  threadId: null,
  direction: "received",
  sender: "someone@example.com",
  recipients: ["recruiter@example.com"],
  subject,
  body,
  date,
  partial: false,
  candidateId,
});

it("shows every candidate's stored mail for the role by default in one read", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? candidatesPage
      : input.operation === "roleMail"
        ? roleMailPage(true, [
            stored("b1", BEN, "From Ben", "Ben body", "2026-10-22T10:00:00Z"),
            stored("a1", ADA, "From Ada", "Ada body", "2026-10-21T10:00:00Z"),
          ])
        : Promise.reject(new Error("unexpected read")),
  );
  const onSelectEmail = vi.fn();
  const view = await mount(<InboxTab {...props} onSelectEmail={onSelectEmail} />);
  await settle();
  expect(crmData).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "roleMail", crmRoleId: ROLE, organizationId: ORG }),
  );
  expect(crmData.mock.calls.some(([input]) => input.operation === "mail")).toBe(false);
  expect(view.textContent).toContain("All candidates");
  expect(view.textContent).toContain("From Ada");
  expect(view.textContent).toContain("Ben body");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      candidateId: BEN,
      candidateName: "Ben",
      crmRoleId: ROLE,
      email: expect.objectContaining({ subject: "From Ben" }),
    }),
  );
  const ada = view.querySelector('[aria-label="From Ada"]') as HTMLButtonElement;
  await act(async () => ada.click());
  expect(view.textContent).toContain("Ada body");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({ candidateId: ADA, candidateName: "Ada" }),
  );
});

it("retries a transient CRM failure behind the loading state and reports a denial at once", async () => {
  readRetries.real = true;
  crmData.mockRejectedValueOnce(new ORPCError("SERVICE_UNAVAILABLE", { status: 503 }));
  crmData.mockResolvedValue(candidatesPage);
  const view = await mount(<ContactsTab {...props} />);
  expect(view.textContent).not.toContain("Could not load CRM records");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1_100)));
  expect(view.textContent).toContain("Ada");
  expect(view.textContent).not.toContain("Could not load CRM records");
  await cleanup?.();
  crmData.mockReset();
  crmData.mockRejectedValue(new ORPCError("FORBIDDEN"));
  const denied = await mount(<ContactsTab {...props} />);
  await settle();
  expect(denied.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load CRM records",
  );
  expect(crmData).toHaveBeenCalledTimes(1);
});

it("shows an error instead of falling back when the role-wide mail read fails", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates" ? candidatesPage : Promise.reject(new Error("denied")),
  );
  const view = await mount(<InboxTab {...props} />);
  await settle();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("Could not load CRM records");
  expect(crmData.mock.calls.some(([input]) => input.operation === "mail")).toBe(false);
});

it("reads full stored email bodies and exposes the selected email to chat", async () => {
  // A CRM without the role-wide read falls back to one candidate's thread.
  crmData.mockImplementation(async (input: { operation: string; candidateId?: string }) =>
    input.operation === "candidates"
      ? candidatesPage
      : input.operation === "roleMail"
        ? roleMailPage(false)
        : {
            operation: "mail",
            source,
            checkedAt,
            scope: "stored_candidate_correspondence",
            outbox: [],
            candidateId: input.candidateId,
            nativeCorrespondence: [],
            items: [
              {
                id: "m1",
                providerMessageId: "p1",
                threadId: null,
                direction: "sent",
                sender: "recruiter@example.com",
                recipients: ["ada@example.com"],
                subject: "Staff role",
                body: "Would you like to talk?",
                date: "2026-10-20T10:00:00Z",
                partial: false,
              },
              {
                id: "m2",
                providerMessageId: "p2",
                threadId: null,
                direction: "received",
                sender: "ada@example.com",
                recipients: ["recruiter@example.com"],
                subject: "Re: Staff role",
                body: "Yes, next week works.\nThanks",
                date: "2026-10-21T10:00:00Z",
                partial: false,
              },
            ],
            nextCursor: null,
          },
  );
  const onSelectEmail = vi.fn();
  const view = await mount(<InboxTab {...props} onSelectEmail={onSelectEmail} />);
  await settle();
  expect(view.textContent).not.toContain("All candidates");
  expect(view.textContent).toContain("Replied");
  expect(view.textContent).toContain("Yes, next week works.");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      candidateId: ADA,
      candidateName: "Ada",
      crmRoleId: ROLE,
      source: { serverId: "crm-source", serverRevision: 3, organizationId: ORG },
      email: expect.objectContaining({
        subject: "Re: Staff role",
        body: "Yes, next week works.\nThanks",
      }),
    }),
  );
  const first = view.querySelector('[aria-label="Staff role"]') as HTMLButtonElement;
  await act(async () => first.click());
  expect(view.textContent).toContain("Would you like to talk?");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({ email: expect.objectContaining({ subject: "Staff role" }) }),
  );
});

it("shows the role's Instantly campaign, its stop-on-reply risk and each lead's status", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? candidatesPage
      : {
          operation: "roleCampaigns",
          source,
          checkedAt,
          scope: "stored_role_campaigns",
          crmRoleId: ROLE,
          items: [],
          offset: 0,
          nextOffset: null,
          nextCursor: null,
        },
  );
  roleCampaign.mockResolvedValue({
    status: "ready",
    campaign: { name: "Staff Engineer outreach", status: 2, stopOnReply: false },
    leads: [
      { candidateKey: "ada-key", email: "ADA@example.com", status: -1, interestStatus: null },
    ],
  });
  const view = await mount(<SequenceTab {...props} />);
  await settle();
  expect(roleCampaign).toHaveBeenCalledWith({ groupId: "group-1" });
  expect(view.textContent).toContain("Staff Engineer outreach");
  expect(view.textContent).toContain("Paused");
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("Stop on reply is off");
  const ada = [...view.querySelectorAll("button")].find((b) => b.textContent?.includes("Ada"));
  expect(ada?.textContent).toContain("Replied · Bounced");
  const ben = [...view.querySelectorAll("button")].find((b) => b.textContent?.includes("Ben"));
  expect(ben?.textContent).not.toContain("·");
});

it("shows no campaign section when the role has no bound campaign", async () => {
  crmData.mockResolvedValue(candidatesPage);
  roleCampaign.mockResolvedValue({ status: "none", campaign: null, leads: [] });
  const view = await mount(<SequenceTab {...props} />);
  await settle();
  expect(view.textContent).not.toContain("Stop on reply");
  expect(view.textContent).not.toContain("Paused");
});

it("derives reply status only from stored message directions", () => {
  expect(replyStatus([])).toBeNull();
  expect(replyStatus([{ direction: "sent", date: "2026-10-20T10:00:00Z" }])).toBe("awaiting");
  expect(
    replyStatus([
      { direction: "sent", date: "2026-10-20T10:00:00Z" },
      { direction: "received", date: "2026-10-21T10:00:00Z" },
    ]),
  ).toBe("replied");
  expect(
    replyStatus([
      { direction: "received", date: "2026-10-19T10:00:00Z" },
      { direction: "sent", date: "2026-10-20T10:00:00Z" },
    ]),
  ).toBe("awaiting");
});

it("reads the role's Interview stage from the CRM", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? { ...candidatesPage, items: [person(ADA, "Ada", { stage: "Interview" })], total: 1 }
      : Promise.reject(new Error("unexpected read")),
  );
  const view = await mount(<InterviewTab {...props} />);
  await settle();
  expect(crmData).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "candidates", crmRoleId: ROLE, stage: "Interview" }),
  );
  expect(crmData.mock.calls.some(([input]) => input.operation === "important")).toBe(false);
  expect(view.textContent).toContain("Ada");
  expect(view.textContent).toContain("Interview");
  expect(view.querySelector('[role="alert"]')).toBeNull();
});

it("falls back to this role's interview workflow rows without the stage filter", async () => {
  crmData.mockImplementation(async (input: { operation: string; status: string }) =>
    input.operation === "candidates"
      ? Promise.reject(new Error("unsupported"))
      : {
          operation: "important",
          source,
          checkedAt,
          scope: "organization_candidate_roles",
          items:
            input.status === "scheduled"
              ? [
                  {
                    ...person(ADA, "Ada"),
                    roleKey: "Staff Engineer (Acme)",
                    clientLabel: "Acme",
                    roleLabel: "Staff Engineer",
                    highSignal: false,
                    workflowStatus: "scheduled",
                    highSignalAt: null,
                    statusChangedAt: checkedAt,
                    updatedAt: checkedAt,
                  },
                  {
                    ...person(BEN, "Ben"),
                    roleKey: "Designer (Other)",
                    clientLabel: "Other",
                    roleLabel: "Designer",
                    highSignal: false,
                    workflowStatus: "scheduled",
                    highSignalAt: null,
                    statusChangedAt: checkedAt,
                    updatedAt: checkedAt,
                  },
                ]
              : [],
          total: 0,
          offset: 0,
          nextOffset: null,
        },
  );
  const view = await mount(<InterviewTab {...props} />);
  await settle();
  expect(view.textContent).toContain("Ada");
  expect(view.textContent).toContain("Scheduled");
  expect(view.textContent).not.toContain("Ben");
});

it("totals Sequence statuses over every CRM page, not only the loaded rows", async () => {
  const people = [
    ...Array.from({ length: 32 }, (_, i) => ["replied", i] as const),
    ...Array.from({ length: 9 }, (_, i) => ["reached_out", i] as const),
    ...Array.from({ length: 9 }, (_, i) => ["not_contacted", i] as const),
  ].map(([status, i]) =>
    person(
      `00000000-0000-4000-8000-${status.length}${String(i).padStart(11, "0")}`,
      `P${status}${i}`,
      {
        outreachStatus: status,
      },
    ),
  );
  roleCampaign.mockResolvedValue({ status: "none", campaign: null, leads: [] });
  crmData.mockImplementation(
    async (input: { operation: string; limit?: number; offset?: number }) => {
      if (input.operation !== "candidates")
        return {
          operation: input.operation,
          source,
          checkedAt,
          items: [],
          total: 0,
          offset: 0,
          nextOffset: null,
        };
      const offset = input.offset ?? 0;
      const items = people.slice(offset, offset + (input.limit ?? 25));
      const end = offset + items.length;
      return {
        ...candidatesPage,
        items,
        total: people.length,
        offset,
        nextOffset: end < people.length ? end : null,
      };
    },
  );
  const view = await mount(<SequenceTab {...props} />);
  await settle();
  await settle();
  expect(view.textContent).toContain("Replied · 32");
  expect(view.textContent).toContain("Reached out · 9");
  expect(view.textContent).toContain("Not contacted · 9");
  // The list itself still shows only its first page.
  expect(view.querySelectorAll("button[aria-pressed]")).toHaveLength(25);
});

it("keeps Sequence status chips from the loaded rows when totalling fails", async () => {
  roleCampaign.mockResolvedValue({
    status: "ready",
    campaign: {
      id: "c1",
      name: "Staff Engineer outreach [role 00000000-0000-4000-8000-000000000002]",
      status: 0,
      stopOnReply: true,
    },
    leads: [],
  });
  crmData.mockImplementation(async (input: { operation: string; limit?: number }) => {
    if (input.operation === "candidates" && input.limit === 50) throw new Error("503");
    return input.operation === "candidates"
      ? candidatesPage
      : {
          operation: input.operation,
          source,
          checkedAt,
          items: [],
          total: 0,
          offset: 0,
          nextOffset: null,
        };
  });
  const view = await mount(<SequenceTab {...props} />);
  await settle();
  expect(view.textContent).toContain("Replied · 1");
  expect(view.textContent).toContain("Not contacted · 1");
  expect(view.textContent).toContain("Staff Engineer outreach");
  expect(view.textContent).not.toContain("[role");
});
