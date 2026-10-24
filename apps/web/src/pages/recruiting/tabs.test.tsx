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
  Plural: ({ value }: { value: number }) => `${value} candidates`,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { RecruitingChatContextProvider } from "../shell/recruiting-chat-context";
import type { RecruitingDetailController } from "./detail";
import { RecruitingDetailProvider } from "./detail";
import { InboxWithReply, replyStatus } from "./InboxTab";
import { ContactsTab, InboxTab, InterviewTab, SequenceTab } from "./index";
import { RoleCampaignCard } from "./SequenceTab";

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
  return Object.assign(container, {
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next));
      await settle();
    },
  });
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
  expect(view.textContent).toContain("No candidate records for this role yet.");
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
  // Contact fields and lookups belong to the person's panel, not the row.
  expect(ada?.textContent).not.toContain("ada@example.com");
  expect(view.textContent).not.toContain("crm-source");
  expect(view.textContent).not.toContain(ADA);
});

it("shows only exact role campaign associations and withholds unscoped messages", async () => {
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
              leadCampaigns: [
                {
                  leadId: "exact",
                  campaignId: "exact",
                  campaign: {
                    id: "exact",
                    name: "Exact role association",
                    crmRoleId: ROLE,
                    clientId: CLIENT,
                    status: 1,
                    syncedAt: checkedAt,
                  },
                },
                {
                  leadId: "other-role",
                  campaignId: "other-role",
                  campaign: {
                    id: "other-role",
                    name: "Other role association",
                    crmRoleId: BEN,
                    clientId: CLIENT,
                    status: 1,
                    syncedAt: checkedAt,
                  },
                },
                {
                  leadId: "other-client",
                  campaignId: "other-client",
                  campaign: {
                    id: "other-client",
                    name: "Other client association",
                    crmRoleId: ROLE,
                    clientId: BEN,
                    status: 1,
                    syncedAt: checkedAt,
                  },
                },
                { leadId: "unknown", campaignId: null, campaign: null },
              ],
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
  expect(view.querySelector('section[aria-label="Role campaigns"]')?.textContent).not.toContain(
    "Active",
  );
  expect(view.textContent).toContain("Replied · 1");
  const ada = [...view.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Ada"),
  )!;
  await act(async () => ada.click());
  await settle();
  expect(view.textContent).toContain("Exact role association");
  expect(view.textContent).not.toContain("Other role association");
  expect(view.textContent).not.toContain("Other client association");
  expect(view.textContent).not.toContain("Campaign not synced");
  expect(view.textContent).not.toContain("Hi Ada");
  expect(view.textContent).toContain("Recruiter messages are unavailable for this role.");
  const sendActivity = view.querySelector('[aria-label="Recorded send activity"]')!;
  expect(sendActivity.querySelector("ol")).toBeNull();
  expect(sendActivity.textContent).not.toContain("No dated sends");
  expect([...view.querySelectorAll("button")].some((b) => /send/i.test(b.textContent ?? ""))).toBe(
    false,
  );
});

it.each([
  { complete: true, leads: [], active: "0", interested: "0" },
  {
    complete: true,
    leads: [{ email: "ada@example.com", status: 1, interestStatus: 2 }],
    active: "1",
    interested: "1",
  },
  {
    complete: false,
    leads: [{ email: "ada@example.com", status: 1, interestStatus: 2 }],
    active: "≥ 1",
    interested: "≥ 1",
  },
  { complete: false, leads: [], active: "—Not reported", interested: "—Not reported" },
])(
  "renders Sequence lead counts with honest coverage: $complete $active",
  async ({ complete, leads, active, interested }) => {
    roleCampaign.mockResolvedValue({
      status: "ready",
      serverId: "source",
      leadsComplete: complete,
      campaign: { id: "c", name: "Campaign", status: 1 },
      leads,
    });
    crmData.mockImplementation(async ({ operation }: { operation: string }) =>
      operation === "candidates"
        ? candidatesPage
        : { operation, source, checkedAt, items: [], offset: 0, nextOffset: null },
    );
    const view = await mount(<SequenceTab {...props} />);
    const values = new Map(
      [...view.querySelectorAll("dl > div")].map((metric) => [
        metric.querySelector("dt")?.textContent,
        metric.querySelector("dd")?.textContent,
      ]),
    );
    expect(values.get("Active")).toBe(active);
    expect(values.get("Interested")).toBe(interested);
    expect(values.get("Contacted")).toBe("—Not reported");
  },
);

it("selects an exact campaign from its actual loaded page and resets on role changes", async () => {
  const selectionRequired = {
    status: "unavailable",
    selectionRequired: true,
    serverId: null,
    campaign: null,
    leads: [],
  };
  let finishOld!: (value: unknown) => void;
  roleCampaign.mockImplementation(async (input: { campaignId?: string }) => {
    if (input.campaignId === "first-campaign")
      return {
        status: "ready",
        leadsComplete: true,
        campaign: { id: "first-campaign", name: "First outreach", status: 1 },
        leads: [{ email: "ada@example.test", status: 1, interestStatus: 2 }],
      };
    if (input.campaignId)
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    return selectionRequired;
  });
  crmData.mockImplementation(
    async (input: { operation: string; offset?: number; cursor?: string; crmRoleId?: string }) => {
      if (input.operation === "candidates") return { ...candidatesPage, items: [], total: 0 };
      const later = input.cursor === "opaque-next";
      return {
        operation: "roleCampaigns",
        source,
        checkedAt,
        scope: "stored_role_campaigns",
        crmRoleId: input.crmRoleId,
        items: [
          {
            id: later ? "later-campaign" : "first-campaign",
            name: later ? "Later outreach" : "First outreach",
            status: 1,
            syncedAt: checkedAt,
          },
        ],
        offset: later ? 25 : 0,
        nextOffset: later ? null : 25,
        nextCursor: later ? null : "opaque-next",
      };
    },
  );
  const view = await mount(<SequenceTab {...props} crmTarget={target} />);
  expect(roleCampaign).toHaveBeenLastCalledWith({ groupId: "group-1" });
  expect(view.textContent).not.toContain("Could not read this campaign.");
  const selector = () => view.querySelector<HTMLSelectElement>('select[aria-label="Campaign"]')!;
  expect(selector().value).toBe("");
  await act(async () => {
    selector().value = "first-campaign";
    selector().dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(roleCampaign).toHaveBeenLastCalledWith({
    groupId: "group-1",
    campaignId: "first-campaign",
    campaignOffset: 0,
  });
  expect(
    [...view.querySelectorAll("dl > div")].map((node) => node.textContent).join(" "),
  ).toContain("Active1");
  const loadMore = view.querySelector<HTMLButtonElement>('[aria-label="Role campaigns"] button')!;
  await act(async () => loadMore.click());
  await settle();
  expect([...selector().options].map((option) => option.textContent)).toContain("Later outreach");
  await act(async () => {
    selector().value = "later-campaign";
    selector().dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(roleCampaign).toHaveBeenLastCalledWith({
    groupId: "group-1",
    campaignId: "later-campaign",
    campaignOffset: 25,
  });
  // Same conversation, different role/source scope must not retain selected provider data.
  await view.rerender(
    <SequenceTab {...props} roleId="role-2" crmTarget={{ ...target, crmRoleId: BEN }} />,
  );
  expect(selector().value).toBe("");
  expect([...selector().options].some((option) => option.value === "later-campaign")).toBe(false);
  expect(roleCampaign).toHaveBeenLastCalledWith({ groupId: "group-1" });
  await act(async () =>
    finishOld({
      status: "ready",
      leadsComplete: true,
      campaign: { id: "later-campaign", name: "Old selected", status: 1 },
      leads: [{ email: "old@example.test", status: 1, interestStatus: 2 }],
    }),
  );
  const metrics = () =>
    [...view.querySelectorAll("dl > div")].map((node) => node.textContent).join(" ");
  expect(metrics()).toContain("Active—Not reported");
  await view.rerender(<SequenceTab {...props} crmTarget={target} />);
  expect(selector().value).toBe("");
  expect(roleCampaign).toHaveBeenLastCalledWith({ groupId: "group-1" });
  expect(
    crmData.mock.calls.filter(([input]) => input.operation === "roleCampaigns" && input.cursor),
  ).toHaveLength(1);
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
  eaccount: "recruiter@example.com",
  campaignId: null,
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
  expect(view.querySelectorAll('ul[aria-label="Candidates"] > li')).toHaveLength(2);
  expect(view.querySelector('section[aria-label="Emails"]')).toBeNull();
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
  const ada = view.querySelector('button[aria-label="Ada"]') as HTMLButtonElement;
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
  expect(view.textContent).not.toContain("Could not load candidate records");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1_100)));
  expect(view.textContent).toContain("Ada");
  expect(view.textContent).not.toContain("Could not load candidate records");
  await cleanup?.();
  crmData.mockReset();
  crmData.mockRejectedValue(new ORPCError("FORBIDDEN"));
  const denied = await mount(<ContactsTab {...props} />);
  await settle();
  expect(denied.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load candidate records",
  );
  expect(crmData).toHaveBeenCalledTimes(1);
});

it("shows an error instead of falling back when the role-wide mail read fails", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates" ? candidatesPage : Promise.reject(new Error("denied")),
  );
  const view = await mount(<InboxTab {...props} />);
  await settle();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load candidate records",
  );
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
            nativeCorrespondence: [
              {
                status: "sent_recorded",
                email: {
                  id: "receipt-1",
                  sourceId: "native-source",
                  eaccount: "other@example.com",
                  campaignId: null,
                  providerMessageId: "p1",
                  sender: "recruiter@example.com",
                  recipients: ["ada@example.com"],
                  subject: "Staff role",
                  body: "Would you like to talk?",
                  date: "2026-10-20T10:00:00Z",
                  snippet: false,
                },
              },
            ],
            items: [
              {
                id: "m1",
                providerMessageId: "p1",
                threadId: "source-thread",
                eaccount: "recruiter@example.com",
                campaignId: null,
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
                threadId: "source-thread",
                eaccount: "recruiter@example.com",
                campaignId: null,
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
  // Equal provider IDs across sources are distinct; no thread is borrowed from CRM.
  expect(
    view.querySelector<HTMLSelectElement>('select[aria-label="Email thread or message"]')?.options,
  ).toHaveLength(2);
  const first = view.querySelector("details")!;
  await act(async () => {
    first.open = true;
    first.dispatchEvent(new Event("toggle"));
  });
  expect(view.textContent).toContain("Would you like to talk?");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      email: expect.objectContaining({
        id: "crm:m1",
        subject: "Staff role",
        threadId: "source-thread",
        eaccount: "recruiter@example.com",
        campaignId: null,
      }),
    }),
  );
  const selector = view.querySelector<HTMLSelectElement>(
    'select[aria-label="Email thread or message"]',
  )!;
  await act(async () => {
    selector.value = selector.options[1]!.value;
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      email: expect.objectContaining({
        id: JSON.stringify([
          "native",
          "receipt-1",
          "native-source",
          "other@example.com",
          null,
          null,
        ]),
        sourceId: "native-source",
        eaccount: "other@example.com",
        threadId: undefined,
      }),
    }),
  );
});

it("keeps the role inbox conversation scoped to one candidate and drafts the exact older selected message", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? candidatesPage
      : roleMailPage(true, [
          {
            ...stored(
              "b-new",
              BEN,
              "Latest Ben message",
              "Ben current body",
              "2026-10-22T10:00:00Z",
            ),
            threadId: "ben-thread",
          },
          stored("a-new", ADA, "Latest Ada message", "Ada private body", "2026-10-21T10:00:00Z"),
          {
            ...stored(
              "b-old",
              BEN,
              "Original Ben message",
              "Ben original body",
              "2026-10-20T10:00:00Z",
            ),
            direction: "sent",
            threadId: "ben-thread",
          },
        ]),
  );
  const open = vi.fn();
  const onDraftReply = vi.fn();
  const setSelectedContact = vi.fn();
  const controller = { open } as unknown as RecruitingDetailController;
  const view = await mount(
    <RecruitingDetailProvider value={controller}>
      <RecruitingChatContextProvider value={{ setSelectedContact, setSelectedEmail: vi.fn() }}>
        <InboxWithReply {...props} onDraftReply={onDraftReply} />
      </RecruitingChatContextProvider>
    </RecruitingDetailProvider>,
  );
  await settle();
  const conversation = () => view.querySelector('[data-testid="email-conversation"]')!;
  expect(conversation().textContent).toContain("Ben current body");
  expect(conversation().textContent).not.toContain("Ada private body");
  const older = conversation().querySelector("details")!;
  expect(older.open).toBe(false);
  await act(async () => {
    older.open = true;
    older.dispatchEvent(new Event("toggle"));
  });
  expect(conversation().querySelector("article")?.textContent).toContain("Ben original body");
  const draft = [...view.querySelectorAll("button")].filter(
    (button) => button.textContent === "Draft reply",
  );
  expect(draft).toHaveLength(1);
  await act(async () => draft[0]!.click());
  expect(onDraftReply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      candidateId: BEN,
      crmRoleId: ROLE,
      source: { serverId: "crm-source", serverRevision: 3, organizationId: ORG },
      email: expect.objectContaining({
        id: "crm:b-old",
        body: "Ben original body",
        direction: "sent",
        threadId: "ben-thread",
      }),
    }),
  );
  await act(async () =>
    [...conversation().querySelectorAll("button")]
      .find((button) => button.textContent === "Profile")!
      .click(),
  );
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      view: "contact",
      person: expect.objectContaining({ candidateId: BEN }),
    }),
  );
  await act(async () => view.querySelector<HTMLButtonElement>('button[aria-label="Ada"]')!.click());
  expect(conversation().textContent).toContain("Ada private body");
  expect(conversation().textContent).not.toContain("Ben original body");
  expect(setSelectedContact).toHaveBeenLastCalledWith({ name: "Ada", reference: ADA });
});

it("uses one rich candidate rail with local search and exact recorded-status filtering", async () => {
  const rich = {
    ...candidatesPage,
    items: [
      person(ADA, "Ada", {
        company: "Example Labs",
        location: "London",
        lastReplyAt: "2026-10-22T10:00:00Z",
        profile: {
          history: [
            { title: "Staff engineer", company: "Earlier Labs", start: "2019", end: "2022" },
          ],
          summary: "Saved summary",
          skills: ["Go"],
          sources: [],
        },
      }),
      person(BEN, "Ben", { outreachStatus: "not_contacted", location: "Remote" }),
    ],
  };
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? rich
      : roleMailPage(true, [
          stored("a-1", ADA, "Latest Ada subject", "Ada body", "2026-10-22T10:00:00Z"),
          stored("a-2", ADA, "Older Ada subject", "Ada history", "2026-10-21T10:00:00Z"),
          stored("a-3", ADA, "Oldest Ada subject", "Ada earlier history", "2026-10-20T10:00:00Z"),
        ]),
  );
  const view = await mount(<InboxTab {...props} />);
  await settle();
  const rail = view.querySelector('section[aria-label="Candidate conversations"]')!;
  expect(rail.querySelectorAll('ul[aria-label="Candidates"] > li')).toHaveLength(2);
  expect(rail.querySelectorAll('button[aria-label="Ada"]')).toHaveLength(1);
  expect(rail.textContent).toContain("Engineer · Example Labs");
  expect(rail.textContent).toContain("London");
  expect(rail.textContent).toContain("Staff engineer · Earlier Labs · 2019 – 2022");
  expect(rail.textContent).toContain("Last reply");
  expect(rail.textContent).not.toContain("Unread");
  expect(rail.textContent).not.toContain("Older Ada subject");
  expect(rail.querySelectorAll("img")).toHaveLength(0);
  const input = rail.querySelector<HTMLInputElement>(
    'input[aria-label="Search loaded candidates"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Earlier Labs",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rail.querySelectorAll('ul[aria-label="Candidates"] > li')).toHaveLength(1);
  const filter = rail.querySelector<HTMLSelectElement>('select[aria-label="Outreach status"]')!;
  await act(async () => {
    filter.value = "status:not_contacted";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(rail.textContent).toContain("No loaded candidates match these filters.");
  await act(async () => {
    filter.value = "all";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => rail.querySelector<HTMLButtonElement>('button[aria-label="Ada"]')!.click());
  expect(rail.className).toContain("hidden lg:block");
  const back = [...view.querySelectorAll("button")].find(
    (button) => button.textContent === "Back to inbox",
  )!;
  await act(async () => back.click());
  expect(rail.className).not.toContain("hidden lg:block");
});

it("does not name an unloaded candidate after the recruiter who sent their latest email", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? { ...candidatesPage, items: [person(ADA, "Ada")] }
      : roleMailPage(true, [
          {
            ...stored("ben-sent", BEN, "Outreach subject", "Stored body", "2026-10-22T10:00:00Z"),
            direction: "sent",
            sender: "recruiter@example.test",
          },
        ]),
  );
  const view = await mount(<InboxTab {...props} />);
  await settle();
  const rail = view.querySelector('ul[aria-label="Candidates"]')!;
  expect(
    rail.querySelector('button[aria-label="Candidate details unavailable"]')?.textContent,
  ).toContain("Outreach subject");
  expect(rail.querySelector('button[aria-label="recruiter@example.test"]')).toBeNull();
});

it("keeps a late candidate mail response out of the newly selected conversation and draft", async () => {
  let resolveAda!: (page: unknown) => void;
  let resolveBen!: (page: unknown) => void;
  const mailPage = (id: string, body: string) => ({
    operation: "mail",
    source,
    checkedAt,
    scope: "stored_candidate_correspondence",
    outbox: [],
    candidateId: id,
    nativeCorrespondence: [],
    nextCursor: null,
    items: [stored("same-message-id", id, "Stored message", body, "2026-10-22T10:00:00Z")],
  });
  crmData.mockImplementation((input: { operation: string; candidateId?: string }) => {
    if (input.operation === "candidates") return Promise.resolve(candidatesPage);
    if (input.operation === "roleMail") return Promise.resolve(roleMailPage(false));
    return new Promise((resolve) => {
      if (input.candidateId === ADA) resolveAda = resolve;
      else resolveBen = resolve;
    });
  });
  const onSelectEmail = vi.fn();
  const onDraftReply = vi.fn();
  const view = await mount(
    <InboxTab {...props} onSelectEmail={onSelectEmail} onDraftReply={onDraftReply} />,
  );
  await settle();
  const ben = [
    ...view.querySelectorAll<HTMLButtonElement>('ul[aria-label="Candidates"] button'),
  ].find((button) => button.querySelector("strong")?.textContent === "Ben");
  await act(async () => ben!.click());
  await settle();
  await act(async () => resolveBen(mailPage(BEN, "Current Ben message")));
  await act(async () => resolveAda(mailPage(ADA, "Late Ada message")));
  expect(view.textContent).toContain("Current Ben message");
  expect(view.textContent).not.toContain("Late Ada message");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      candidateId: BEN,
      email: expect.objectContaining({ body: "Current Ben message" }),
    }),
  );
  await act(async () =>
    [...view.querySelectorAll("button")]
      .find((button) => button.textContent === "Draft reply")!
      .click(),
  );
  expect(onDraftReply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      candidateId: BEN,
      email: expect.objectContaining({ body: "Current Ben message" }),
    }),
  );
});

it("does not borrow the first candidate's identity for a locked candidate outside the loaded page", async () => {
  crmData.mockImplementation(async (input: { operation: string }) => {
    if (input.operation === "candidates") return { ...candidatesPage, items: [person(ADA, "Ada")] };
    if (input.operation === "roleMail") return roleMailPage(false);
    return {
      operation: "mail",
      source,
      checkedAt,
      scope: "stored_candidate_correspondence",
      candidateId: BEN,
      nativeCorrespondence: [],
      outbox: [],
      nextCursor: null,
      items: [stored("ben-only", BEN, "Ben saved message", "Ben body", "2026-10-22T10:00:00Z")],
    };
  });
  const onSelectEmail = vi.fn();
  const view = await mount(<InboxTab {...props} candidateId={BEN} onSelectEmail={onSelectEmail} />);
  await settle();
  expect(view.querySelector('[data-testid="email-conversation"]')?.textContent).toContain(
    "Ben body",
  );
  expect(view.textContent).not.toContain("Ada");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      candidateId: BEN,
      candidateName: undefined,
      candidateEmail: undefined,
    }),
  );
});

it("refreshes selected email context when the saved body changes under the same message ID", async () => {
  let body = "Original saved body";
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? candidatesPage
      : roleMailPage(true, [stored("same-id", ADA, "Same subject", body, "2026-10-22T10:00:00Z")]),
  );
  const onSelectEmail = vi.fn();
  const view = await mount(<InboxTab {...props} onSelectEmail={onSelectEmail} />);
  await settle();
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({ email: expect.objectContaining({ body: "Original saved body" }) }),
  );
  body = "Updated saved body";
  await view.rerender(<InboxTab {...props} onSelectEmail={onSelectEmail} refreshSignal={1} />);
  expect(view.querySelector("article")?.textContent).toContain("Updated saved body");
  expect(onSelectEmail).toHaveBeenLastCalledWith(
    expect.objectContaining({ email: expect.objectContaining({ body: "Updated saved body" }) }),
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
  const view = await mount(
    <>
      <RoleCampaignCard {...props} />
      <SequenceTab {...props} />
    </>,
  );
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
  const view = await mount(
    <>
      <RoleCampaignCard {...props} />
      <SequenceTab {...props} />
    </>,
  );
  await settle();
  expect(view.textContent).toContain("Replied · 1");
  expect(view.textContent).toContain("Not contacted · 1");
  expect(view.textContent).toContain("Staff Engineer outreach");
  expect(view.textContent).not.toContain("[role");
});

function autumnRead(overrides: Record<string, unknown> = {}) {
  return {
    items: [] as never[],
    loading: false,
    failed: false,
    retry: vi.fn(),
    total: null,
    hasMore: false,
    loadMore: vi.fn(),
    sortByScore: true,
    includeCrm: true,
    ready: true,
    shortlistFailedKey: null,
    setShortlist: vi.fn(),
    openEvidence: vi.fn(),
    ...overrides,
  };
}
const autumnAda = {
  candidateKey: "autumn-ada",
  name: "Ada",
  title: "Staff Engineer",
  company: "Acme",
  location: "Remote",
  linkedinUrl: "https://linkedin.com/in/ada",
  shortlisted: false,
  latestSource: {
    report: {
      fields: [
        { label: "Match score", value: "92", sourceUrls: [] },
        { label: "Rust", value: "match", providerStatus: "match", sourceUrls: [] },
      ],
      sourceUrls: [],
    },
  },
};

it("renders each source as it loads, with skeleton rows only while one is still loading", async () => {
  let finishCrm!: (value: unknown) => void;
  crmData.mockReturnValue(new Promise((resolve) => (finishCrm = resolve)));
  const view = await mount(
    <ContactsTab
      {...props}
      crmTarget={target}
      autumn={autumnRead({ items: [autumnAda], total: 1 })}
    />,
  );
  // Autumn's row is already on screen while the CRM read is still pending.
  expect(view.querySelector("tbody")?.textContent).toContain("Ada");
  expect(view.querySelector("tbody")?.textContent).toContain("92");
  expect(view.querySelector('[role="status"]')).not.toBeNull();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  await act(async () => finishCrm(candidatesPage));
  // Ada is one person in both sources; Ben is a CRM-only row below her.
  const rows = [...view.querySelectorAll("tbody tr")].map((row) => row.textContent);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Ada");
  expect(rows[0]).toContain("Screening");
  expect(rows[1]).toContain("Ben");
  expect(view.querySelector('[role="status"]')).toBeNull();
  expect(view.textContent).toContain("2 candidates");
});

it("shows a failed source as a compact Retry that re-reads only that source", async () => {
  crmData.mockRejectedValueOnce(new Error("CRM unavailable")).mockResolvedValue(candidatesPage);
  const view = await mount(
    <ContactsTab
      {...props}
      crmTarget={target}
      autumn={autumnRead({ items: [autumnAda], total: 1 })}
    />,
  );
  const alert = view.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Could not load candidate records");
  // Never an error and a loading state at once.
  expect(view.querySelector('[role="status"]')).toBeNull();
  expect(view.querySelector("tbody")?.textContent).toContain("Ada");
  const retry = [...alert!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
  const reads = correspondence.mock.calls.length;
  await act(async () => retry.click());
  await settle();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.querySelector("tbody")?.textContent).toContain("Ben");
  expect(crmData).toHaveBeenCalledTimes(2);
  expect(correspondence.mock.calls.length).toBe(reads);
});

it.each([
  ["ada@example.com", true],
  [" ADA@EXAMPLE.COM ", true],
  ["Ada Lovelace <ADA@example.com>", true],
  ["notada@example.com", false],
  ["ada@example.com.attacker.test", false],
  ["ada@example.com <other@example.com>", false],
  ["Ada <ada@example.com>, Other <other@example.com>", false],
  ["other@example.com", false],
])("matches candidate calendar attendee %s by exact address", async (attendee, matches) => {
  crmData.mockResolvedValue(candidatesPage);
  correspondence.mockResolvedValue({
    ...savedCorrespondence,
    events: [
      {
        id: "exact-event",
        title: "Candidate-specific appointment",
        kind: "event",
        status: "confirmed",
        start: checkedAt,
        end: null,
        timeZone: "UTC",
        attendees: [attendee],
        location: null,
        url: null,
      },
    ],
  });
  const view = await mount(
    <InterviewTab {...props} candidateId={ADA} candidateEmail="ada@example.com" />,
  );
  await settle();
  expect(view.textContent?.includes("Candidate-specific appointment")).toBe(matches);
});
