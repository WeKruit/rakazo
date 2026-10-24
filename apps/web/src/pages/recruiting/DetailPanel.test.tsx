// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const listCandidates = vi.hoisted(() => vi.fn());
const crmData = vi.hoisted(() => vi.fn());
const correspondence = vi.hoisted(() => vi.fn());
const roleCampaign = vi.hoisted(() => vi.fn());
const recordView = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: {
      listCandidates,
      crmData,
      correspondence,
      roleCampaign,
      profileActivity: { recordView },
    },
  },
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

import { RecruitingChatContextProvider } from "../shell/recruiting-chat-context";
import {
  ContactsTab,
  RecruitingDetailPanel,
  RecruitingDetailProvider,
  SequenceTab,
  useRecruitingDetailController,
} from "./index";

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
const checkedAt = "2026-10-22T10:00:00Z";
const ada = {
  candidateId: ADA,
  name: "Ada",
  email: "ada@example.com",
  phone: null,
  linkedinUrl: null,
  location: "Remote",
  title: "Engineer",
  stage: "screening",
  contactStatus: "email_found",
  outreachStatus: "replied",
  roleSpecId: ROLE,
  legacyClientLabel: "Acme",
  legacyRoleLabel: "Staff Engineer",
};
const page = (operation: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
  operation,
  source,
  checkedAt,
  items,
  total: items.length,
  offset: 0,
  nextOffset: null,
  ...extra,
});

let cleanup: (() => Promise<void>) | undefined;
let location = "";
let goBack: () => void = () => undefined;
const setSelectedContact = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  roleCampaign.mockResolvedValue({ status: "none" });
  recordView.mockResolvedValue({ recorded: true });
  listCandidates.mockResolvedValue({ crmTarget: { bindingEffectId: "binding", target } });
  correspondence.mockResolvedValue({
    roleId: "role-1",
    status: "ready",
    checkedAt,
    connectionChanged: false,
    connections: [],
    emails: [],
    events: [],
    contacts: [],
    partial: false,
  });
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidates"
      ? page("candidates", [ada], { scope: "organization", selectedRole: null })
      : input.operation === "mail"
        ? {
            ...page("mail", [
              {
                id: "m1",
                providerMessageId: "p1",
                sender: "ada@example.com",
                recipients: ["me@example.com"],
                subject: "Re: Staff role",
                body: "Happy to talk",
                date: checkedAt,
                direction: "received",
                partial: false,
              },
            ]),
            candidateId: ADA,
            nativeCorrespondence: [],
            nextCursor: null,
          }
        : page(input.operation, [], { supported: true, crmRoleId: ROLE }),
  );
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function Probe() {
  const current = useLocation();
  const navigate = useNavigate();
  location = `${current.pathname}${current.search}`;
  goBack = () => navigate(-1);
  return null;
}

function Workbench({
  onAskChat,
  tab = "contacts",
}: {
  onAskChat?: (text: string) => void;
  tab?: "contacts" | "sequence";
}) {
  const detail = useRecruitingDetailController("thread-1");
  return (
    <RecruitingChatContextProvider
      value={{ setSelectedContact, setSelectedEmail: () => undefined }}
    >
      <RecruitingDetailProvider value={detail}>
        <main>
          {tab === "sequence" ? (
            <SequenceTab roleId="role-1" spaceId="space-1" conversation={{ groupId: "group-1" }} />
          ) : (
            <ContactsTab roleId="role-1" spaceId="space-1" conversation={{ groupId: "group-1" }} />
          )}
        </main>
        <aside>
          <RecruitingDetailPanel controller={detail} onAskChat={onAskChat} />
        </aside>
        <Probe />
      </RecruitingDetailProvider>
    </RecruitingChatContextProvider>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(node: ReactNode, path = "/app/g/group-1?view=contacts") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  await settle();
  await settle();
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

const button = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll("button")].find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name,
  );
const panel = (view: HTMLElement) =>
  view.querySelector<HTMLElement>('[data-testid="recruiting-detail-panel"]');

it("opens a person beside the current view and tells the chat who is open", async () => {
  const view = await mount(<Workbench />);
  const opener = button(view, "Ada")!;
  opener.focus();
  await act(async () => opener.click());
  await settle();
  expect(panel(view)?.querySelector("h2")?.textContent).toBe("Ada");
  expect(panel(view)?.textContent).toContain("Email found");
  // The page underneath stays mounted on the same view; only a detail entry was pushed.
  expect(view.querySelector('section[aria-label="Contacts"]')).not.toBeNull();
  expect(location).toBe(`/app/g/group-1?view=contacts&detail=contact.${ADA}`);
  expect(setSelectedContact).toHaveBeenLastCalledWith({ name: "Ada", reference: ADA });
});

it("reopens the person a shared link names once the list shows them", async () => {
  const view = await mount(
    <Workbench />,
    `/app/g/group-1?view=contacts&detail=${encodeURIComponent(`contact.${ADA}`)}`,
  );
  await settle();
  expect(panel(view)?.querySelector("h2")?.textContent).toBe("Ada");
  expect(location).toBe(
    `/app/g/group-1?view=contacts&detail=${encodeURIComponent(`contact.${ADA}`)}`,
  );
});

it("opens a Sequence person's emails beside the tab", async () => {
  const base = crmData.getMockImplementation()!;
  crmData.mockImplementation(async (input: { operation: string }) =>
    input.operation === "candidateDetails"
      ? { ...page("candidateDetails", []), campaignAssociations: { leadCampaigns: [] }, outbox: [] }
      : base(input),
  );
  const view = await mount(<Workbench tab="sequence" />);
  const row = [...view.querySelectorAll("button[aria-pressed]")].find((item) =>
    item.textContent?.startsWith("Ada"),
  ) as HTMLButtonElement;
  await act(async () => row.click());
  await settle();
  const heading = view.querySelector('section[aria-label="Messages"] h4 button') as HTMLElement;
  await act(async () => heading.click());
  await settle();
  await settle();
  expect(panel(view)?.querySelector("h2")?.textContent).toBe("Ada");
  expect(location).toContain(`detail=thread.${ADA}`);
});

it("keeps a back stack and returns focus to the opener on Escape", async () => {
  const view = await mount(<Workbench />);
  const opener = button(view, "Ada")!;
  opener.focus();
  await act(async () => opener.click());
  await settle();
  expect(button(view, "Back")).toBeUndefined();
  await act(async () => button(panel(view)!, "Emails")!.click());
  await settle();
  await settle();
  expect(panel(view)?.textContent).toContain("Happy to talk");
  expect(location).toContain(`detail=thread.${ADA}`);
  await act(async () => button(view, "Back")!.click());
  await settle();
  expect(panel(view)?.textContent).toContain("Email found");
  expect(location).toContain(`detail=contact.${ADA}`);
  await act(async () => button(panel(view)!, "Interview")!.click());
  await settle();
  await act(async () => {
    panel(view)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await settle();
  expect(panel(view)).toBeNull();
  expect(location).toBe("/app/g/group-1?view=contacts");
  expect(document.activeElement).toBe(opener);
  expect(setSelectedContact).toHaveBeenLastCalledWith(null);
});

it("closes on browser Back instead of leaving the conversation", async () => {
  const view = await mount(<Workbench />);
  await act(async () => button(view, "Ada")!.click());
  await settle();
  await act(async () => goBack());
  await settle();
  expect(panel(view)).toBeNull();
  expect(location).toBe("/app/g/group-1?view=contacts");
});

it("asks the chat to schedule without sending anything", async () => {
  const onAskChat = vi.fn();
  const view = await mount(<Workbench onAskChat={onAskChat} />);
  await act(async () => button(view, "Ada")!.click());
  await settle();
  await act(async () => button(panel(view)!, "Interview")!.click());
  await settle();
  await act(async () => button(panel(view)!, "Schedule interview")!.click());
  expect(onAskChat).toHaveBeenCalledWith(expect.stringContaining("do not send it yet"));
  expect(crmData).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "send" }));
});

it("opens stored company and profile history without inventing education or assessment", async () => {
  crmData.mockImplementation(async (input: { operation: string }) =>
    page(
      input.operation,
      [
        {
          ...ada,
          company: "Stored Company",
          profile: {
            history: [
              { title: "Engineer", company: "Previous Company", start: "2020", end: "2022" },
              "Independent consulting",
              { unknown: "unstructured data" },
            ],
            summary: "Builds distributed systems",
            skills: ["Go", "PostgreSQL"],
            sources: [],
          },
        },
      ],
      { scope: "organization", selectedRole: null },
    ),
  );
  const view = await mount(<Workbench />);
  expect(view.textContent).toContain("Stored Company");
  await act(async () => button(view, "Ada")!.click());
  const panel = view.querySelector('[data-testid="recruiting-detail-panel"]')!;
  expect(panel.textContent).toContain("Engineer at Stored Company");
  expect(panel.textContent).toContain("Previous Company");
  expect(panel.textContent).toContain("Independent consulting");
  expect(panel.textContent).toContain("Builds distributed systems");
  expect(panel.textContent).toContain("PostgreSQL");
  expect(panel.textContent).not.toContain("Education");
  expect(panel.textContent).not.toContain("Agent assessment");
  expect([...panel.querySelectorAll("li")].map((row) => row.textContent).join(" ")).not.toContain(
    "unstructured data",
  );
  const original = [...panel.querySelectorAll("details")].find(
    (details) => details.querySelector("summary")?.textContent === "Source text",
  );
  expect(original?.open).toBe(false);
  expect(original?.textContent).toContain("unstructured data");
});
