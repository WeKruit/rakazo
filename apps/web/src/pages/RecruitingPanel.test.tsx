// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { ORPCError } from "@orpc/client";
import type {
  RecruitingAssessment,
  RecruitingAssessmentSnapshot,
  RecruitingAssessmentSourceRef,
  RecruitingCandidate,
  RecruitingCrmCandidateSync,
  RecruitingCrmDataOutput,
  RecruitingCrmTarget,
  RecruitingEmploymentRule,
  RecruitingQuestion,
  RecruitingRole,
  RecruitingRoleRevision,
} from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readRecruitingPanelState,
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "../lib/right-panel-state";

const api = vi.hoisted(() => ({
  session: { data: { user: { id: "actor-1" } } },
  getWorkspace: vi.fn(),
  correspondence: vi.fn(),
  crmData: vi.fn(),
  readSource: vi.fn(),
  listAssessments: vi.fn(),
  listCandidates: vi.fn(),
  listFeedback: vi.fn(),
  listCandidateSources: vi.fn(),
  setCandidateShortlist: vi.fn(),
  getAssessment: vi.fn(),
  listResearch: vi.fn(),
  listQuestions: vi.fn(),
  answer: vi.fn(),
  createRole: vi.fn(),
  bindRole: vi.fn(),
  reviseRole: vi.fn(),
  confirmBrief: vi.fn(),
  editCriteria: vi.fn(),
  list: vi.fn(),
  history: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  getById: vi.fn(),
  search: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ authClient: { useSession: () => api.session } }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    recruiting: api,
    memory: api,
    artifacts: api,
    threads: { answer: api.answer },
    search: { query: api.search },
  },
}));
vi.mock("./recruiting", () => {
  const tab = (name: string) => (props: object) => (
    <span data-role-tab={name}>{JSON.stringify(props)}</span>
  );
  return {
    ContactsTab: tab("contacts"),
    SequenceTab: tab("sequence"),
    InboxWithReply: ({ onDraftReply: _, ...props }: { onDraftReply?: unknown }) =>
      tab("inbox")(props),
    InterviewTab: tab("interview"),
  };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ _1, other, value }: { _1: string; other: string; value: number }) =>
    (value === 1 ? _1 : other).replace("#", String(value)),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("../components/ArtifactFileCard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ArtifactFileCard: ({
    name,
    artifactId,
    target,
  }: {
    name: string;
    artifactId: string;
    target: { botId?: string; groupId?: string };
  }) => (
    <span data-artifact-id={artifactId} data-bot-id={target.botId} data-group-id={target.groupId}>
      {name}
    </span>
  ),
}));

import { RecruitingPanel } from "./RecruitingPanel";

it("browses scoped CRM contacts and stored mail without inventing a native recruiting workspace", async () => {
  const source = {
    serverId: "crm-source",
    serverRevision: 2,
    organizationId: "org-1",
    name: "CRM",
  };
  const selection = { ...source, crmRoleId: "crm-role" };
  api.crmData.mockImplementation(async (input) =>
    input.operation === "mail"
      ? {
          operation: "mail",
          nativeCorrespondence: [],
          outbox: ["pending", "processing", "failed", "sent"].map((status) => ({
            id: status,
            status,
            body: `Original ${status}`,
            polishedBody: status === "sent" ? "Polished actual reply" : null,
            providerMessageId: status === "sent" ? "actual-linked-mail" : null,
            error:
              status === "failed" ? "Missing inbound anchor run_private_123 p_org=internal" : null,
            createdAt: "2026-10-21T00:00:00Z",
            sentAt: status === "sent" ? "2026-10-21T01:00:00Z" : null,
          })),
          source,
          checkedAt: "2026-10-22T00:00:00Z",
          scope: "stored_candidate_correspondence",
          candidateId: input.candidateId,
          items: [
            {
              id: "stored-mail",
              providerMessageId: "provider-mail",
              threadId: "original-thread",
              direction: "received",
              sender: "person@example.test",
              recipients: ["team@example.test"],
              subject: "Original reply",
              body: "Full stored reply\nSecond line",
              date: "2026-10-21T00:00:00Z",
              partial: false,
            },
          ],
          nextCursor:
            input.candidateId === "crm-person" && !input.cursor
              ? { p_org: "org-1", p_candidate: "crm-person", linked_offset: 30, unlinked_offset: 0 }
              : null,
        }
      : {
          operation: "candidates",
          source,
          checkedAt: "2026-10-22T00:00:00Z",
          scope: "legacy_role_labels",
          selectedRole: {
            crmRoleId: "crm-role",
            clientId: "client-1",
            clientLabel: "Example client",
            roleLabel: "Engineering",
            summary: "Stored role",
            jdText: "Original job description",
          },
          items: [
            {
              candidateId: "crm-person",
              name: "Existing CRM person",
              email: "person@example.test",
              phone: null,
              linkedinUrl: "https://www.linkedin.com/in/example",
              location: "California",
              title: "Engineer",
              stage: "Contacted",
              contactStatus: "available",
              outreachStatus: "replied",
              roleSpecId: null,
              legacyClientLabel: "Example client",
              legacyRoleLabel: "Engineering",
            },
          ],
          total: 1,
          offset: 0,
          nextOffset: null,
        },
  );
  const onSelectCandidate = vi.fn();
  const onDraftReply = vi.fn();
  const crmBrowse = { selection, view: "contacts" as const, onSelectCandidate, onDraftReply };
  const view = await mounted("thread-1", undefined, false, undefined, {
    groupId: "group-1",
    crmBrowse,
  });
  expect(view.container.textContent).toContain("Existing CRM person");
  expect(view.container.textContent).toContain("person@example.test");
  expect(api.getWorkspace).not.toHaveBeenCalled();
  expect(api.listCandidates).not.toHaveBeenCalled();
  expect(view.container.querySelector('[role="checkbox"]')).toBeNull();
  await view.click("View messages");
  expect(onSelectCandidate).toHaveBeenCalledWith("crm-person");
  await view.render("thread-1", 0, false, undefined, {
    groupId: "group-1",
    crmBrowse: { ...crmBrowse, view: "inbox", candidateId: "crm-person" },
  });
  expect(view.container.textContent).toContain("Full stored reply");
  expect(api.crmData).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "mail", crmRoleId: "crm-role" }),
  );
  await view.click("Draft reply");
  expect(onDraftReply).toHaveBeenCalledWith({
    threadId: "thread-1",
    candidateId: "crm-person",
    candidateName: "Existing CRM person",
    candidateEmail: "person@example.test",
    email: {
      sender: "person@example.test",
      recipients: ["team@example.test"],
      subject: "Original reply",
      date: "2026-10-21T00:00:00Z",
    },
    source: { serverId: "crm-source", serverRevision: 2, organizationId: "org-1" },
    crmRoleId: "crm-role",
  });
  expect(JSON.stringify(onDraftReply.mock.calls)).not.toMatch(
    /stored-mail|provider-mail|original-thread|Full stored reply/,
  );
  expect(view.container.textContent).toContain("Recruiter messages");
  for (const status of [
    "Saved, not sent",
    "Previously processing",
    "Marked as sent",
    "Send failed",
  ])
    expect(view.container.textContent).toContain(status);
  expect(view.container.textContent).toContain("Original pending");
  expect(view.container.textContent).toContain("Original sent");
  expect(view.container.textContent).toContain("Polished actual reply");
  expect(view.container.textContent).toContain("There was a problem sending this message.");
  expect(view.container.textContent).not.toContain("run_private_123");
  expect(view.container.textContent).not.toContain("p_org=internal");
  expect(view.container.textContent).not.toContain("Queue status");
  await view.render("thread-1", 0, true, undefined, {
    groupId: "group-1",
    crmBrowse: { ...crmBrowse, view: "inbox", candidateId: "crm-person" },
  });
  expect(view.container.textContent).toContain(
    "Missing inbound anchor run_private_123 p_org=internal",
  );
  await view.render("thread-1", 0, false, undefined, {
    groupId: "group-1",
    crmBrowse: { ...crmBrowse, view: "inbox", candidateId: "crm-person" },
  });
  expect(view.container.textContent).toContain("Sent at");
  expect(view.container.textContent).not.toContain("actual-linked-mail");
  expect(view.container.textContent).not.toContain("provider-mail");
  expect(view.container.textContent).not.toContain("original-thread");
  await view.click("Older messages");
  await view.render("thread-1", 0, false, undefined, {
    groupId: "group-1",
    crmBrowse: { ...crmBrowse, view: "inbox", candidateId: "another-person" },
  });
  expect(
    api.crmData.mock.calls
      .filter(([input]) => input.operation === "mail" && input.candidateId === "another-person")
      .every(([input]) => input.cursor === undefined),
  ).toBe(true);
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it("shows exact candidate native correspondence with CRM history without treating unknown or scheduled replies as sent", async () => {
  const selection = {
    serverId: "crm-source",
    serverRevision: 2,
    organizationId: "org-1",
    crmRoleId: "crm-role",
  };
  const source = { ...selection, name: "CRM" };
  const email = (subject: string) => ({
    id: `instantly-source:${subject}`,
    sourceName: "Instantly account",
    sourceId: "instantly-source",
    providerMessageId: subject,
    savedRead: { messageId: "source-message", linkedRunId: "run", effectId: "read" },
    sender: "team@example.test",
    recipients: ["person@example.test"],
    subject,
    body: `${subject} full body`,
    snippet: false,
    date: "2026-10-22T00:00:00Z",
    url: null,
  });
  const native: Extract<RecruitingCrmDataOutput, { operation: "mail" }>["nativeCorrespondence"] = (
    ["read", "sent_recorded", "scheduled", "unknown"] as const
  ).map((status) => ({
    id: status,
    roleId: "native-role",
    bindingEffectId: "binding",
    crmRoleId: "crm-role",
    candidateId: "person",
    status,
    checkedAt: "2026-10-22T00:00:00Z",
    email: status === "unknown" ? null : email(status),
  }));
  api.crmData.mockImplementation(async (input) =>
    input.operation === "mail"
      ? {
          operation: "mail",
          source,
          checkedAt: "2026-10-22T00:00:00Z",
          scope: "stored_candidate_correspondence",
          candidateId: input.candidateId,
          outbox: [],
          nativeCorrespondence: native,
          items: [
            {
              id: "instantly-source:read",
              providerMessageId: "legacy-id",
              threadId: "legacy-thread",
              direction: "received",
              sender: "person@example.test",
              recipients: ["team@example.test"],
              subject: "Historical email",
              body: "Historical original body",
              date: "2026-10-21T00:00:00Z",
              partial: false,
            },
          ],
          nextCursor: null,
        }
      : {
          operation: "candidates",
          source,
          checkedAt: "2026-10-22T00:00:00Z",
          scope: "legacy_role_labels",
          selectedRole: {
            crmRoleId: "crm-role",
            clientId: "client",
            clientLabel: "Client",
            roleLabel: "Role",
            summary: null,
          },
          items: [],
          total: 0,
          offset: 0,
          nextOffset: null,
        },
  );
  const onDraftReply = vi.fn();
  const browse = {
    selection,
    view: "inbox" as const,
    candidateId: "person",
    onSelectCandidate: vi.fn(),
    onDraftReply,
  };
  const view = await mounted("thread-1", undefined, false, undefined, {
    groupId: "group-1",
    crmBrowse: browse,
  });
  expect(view.container.textContent).toContain("read full body");
  expect(view.container.textContent).toContain("Instantly account");
  expect(view.container.textContent).toContain("Send outcome unknown");
  expect(view.container.querySelectorAll('[aria-label="Saved emails"] button')).toHaveLength(4);
  await view.click("sent_recorded");
  expect(view.container.textContent).toContain("Send recorded");
  expect(view.container.textContent).toContain("sent_recorded full body");
  native.push({
    ...native[0]!,
    id: "fresh-readback",
    checkedAt: "2026-10-22T00:01:00Z",
    email: {
      ...email("sent_recorded"),
      subject: "Fresh sent readback",
      body: "Latest readback full body",
    },
  });
  native.push({ ...native[1]!, id: "older-replayed-receipt" });
  await view.render("thread-1", 1, false, undefined, { groupId: "group-1", crmBrowse: browse });
  expect(view.container.querySelectorAll('[aria-label="Saved emails"] button')).toHaveLength(4);
  expect(view.container.textContent).toContain("Latest readback full body");
  expect(view.container.textContent).not.toContain("sent_recorded full body");
  expect(view.container.textContent).not.toContain("Send recorded");
  expect(onDraftReply).not.toHaveBeenCalled();
  await view.click("Draft reply");
  expect(onDraftReply).toHaveBeenCalledWith(
    expect.objectContaining({
      candidateId: "person",
      email: expect.objectContaining({ subject: "Fresh sent readback" }),
    }),
  );
  expect(JSON.stringify(onDraftReply.mock.calls)).not.toMatch(
    /instantly-source|source-message|native:|stored-mail/,
  );
  await view.click("scheduled");
  expect(view.container.textContent).toContain("Scheduled");
  expect(view.container.textContent).not.toContain("Send recorded");
  await view.click("Historical email");
  expect(view.container.textContent).toContain("Historical original body");
  expect(onDraftReply).toHaveBeenCalledOnce();
  const originalRead = api.crmData.getMockImplementation()!;
  let finishLate!: (value: unknown) => void;
  api.crmData.mockImplementation((input) =>
    input.operation === "mail" && input.candidateId === "person"
      ? new Promise((resolve) => {
          finishLate = resolve;
        })
      : originalRead(input),
  );
  await view.render("thread-1", 2, false, undefined, { groupId: "group-1", crmBrowse: browse });
  // A response for another canonical person cannot be rendered just because the email matches.
  await view.render("thread-1", 2, false, undefined, {
    groupId: "group-1",
    crmBrowse: { ...browse, candidateId: "other-person" },
  });
  await act(async () =>
    finishLate(await originalRead({ operation: "mail", candidateId: "person" })),
  );
  expect(view.container.textContent).toContain("Could not load stored messages");
  expect(view.container.textContent).not.toContain("Historical original body");
  expect(view.container.textContent).not.toContain("sent_recorded full body");
});

it("reveals selected CRM mail from contact clicks and Inbox navigation without stealing focus on background refresh", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  try {
    const selection = {
      serverId: "crm-source",
      serverRevision: 2,
      organizationId: "org-1",
      crmRoleId: "crm-role",
    };
    const source = { ...selection, name: "CRM" };
    type MailPage = Extract<RecruitingCrmDataOutput, { operation: "mail" }>;
    const pending = new Map<string, (value: MailPage) => void>();
    const mail = (candidateId: string, body: string): MailPage => ({
      operation: "mail",
      outbox: [],
      nativeCorrespondence: [],
      source,
      checkedAt: "2026-10-22T00:00:00Z",
      scope: "stored_candidate_correspondence",
      candidateId,
      items: [
        {
          id: `mail-${candidateId}`,
          providerMessageId: `original-${candidateId}`,
          threadId: "original-thread",
          direction: "received",
          sender: "person@example.test",
          recipients: [],
          subject: "Stored reply",
          body,
          date: null,
          partial: false,
        },
      ],
      nextCursor: null,
    });
    api.crmData.mockImplementation(async (input) =>
      input.operation === "mail"
        ? new Promise<MailPage>((resolve) => pending.set(input.candidateId, resolve))
        : {
            operation: "candidates",
            source,
            checkedAt: "2026-10-22T00:00:00Z",
            scope: "legacy_role_labels",
            selectedRole: {
              crmRoleId: "crm-role",
              clientId: "client",
              clientLabel: "Client",
              roleLabel: "Role",
              summary: null,
            },
            items: Array.from({ length: 30 }, (_, index) => ({
              candidateId: `person-${index + 1}`,
              name: `Person ${index + 1}`,
              email: null,
              phone: null,
              linkedinUrl: null,
              location: null,
              title: "Engineer",
              stage: null,
              contactStatus: "",
              outreachStatus: "",
              roleSpecId: null,
              legacyClientLabel: "Client",
              legacyRoleLabel: "Role",
            })),
            total: 60,
            offset: input.offset ?? 0,
            nextOffset: 30,
          },
    );
    let selected: string | undefined;
    const onSelectCandidate = (id: string) => {
      selected = id;
    };
    const browse = { selection, view: "contacts" as const, onSelectCandidate };
    const view = await mounted("thread-1", undefined, false, undefined, {
      groupId: "group-1",
      crmBrowse: browse,
    });
    await changeInput(view.container, "Search CRM contacts", "Engineer");
    const search = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Search CRM contacts"]',
    )!;
    await act(async () =>
      search
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const selectPerson = async (index: number) =>
      act(async () => {
        view.container.querySelectorAll<HTMLButtonElement>("tbody tr button")[index]!.click();
      });
    const inbox = () =>
      view.render("thread-1", 0, false, undefined, {
        groupId: "group-1",
        crmBrowse: { ...browse, view: "inbox", candidateId: selected },
      });
    const frame = () =>
      act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
    await selectPerson(0);
    await inbox();
    expect(selected).toBe("person-1");
    expect(scroll).not.toHaveBeenCalled();
    await selectPerson(1);
    await inbox();
    expect(selected).toBe("person-2");
    await act(async () => pending.get("person-1")!(mail("person-1", "Late old private body")));
    await frame();
    expect(scroll).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Late old private body");
    await act(async () => pending.get("person-2")!(mail("person-2", "Selected current full body")));
    await frame();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(document.activeElement).toBe(scroll.mock.instances[0]);
    expect(document.activeElement?.textContent).toContain("Selected current full body");
    expect(search.value).toBe("Engineer");
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(30);
    expect(
      [...view.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Next",
      ),
    ).toBe(true);
    await view.render("thread-1", 1, false, undefined, {
      groupId: "group-1",
      crmBrowse: { ...browse, view: "inbox", candidateId: selected },
    });
    await act(async () =>
      pending.get("person-2")!(mail("person-2", "Background refreshed full body")),
    );
    await frame();
    expect(scroll).toHaveBeenCalledTimes(1);
    await selectPerson(1);
    expect(scroll).toHaveBeenCalledTimes(2);
    // A direct Inbox entry with a selected contact uses the same ready-body path.
    await view.render("thread-2", 0, false, undefined, {
      groupId: "group-1",
      crmBrowse: { ...browse, view: "inbox", candidateId: "person-3" },
    });
    await act(async () =>
      pending.get("person-3")!(mail("person-3", "Inbox URL selected full body")),
    );
    await frame();
    expect(scroll).toHaveBeenCalledTimes(3);
    expect(document.activeElement?.textContent).toContain("Inbox URL selected full body");
  } finally {
    scroll.mockRestore();
  }
});

it.each(["feedback", "sequence"] as const)(
  "reveals the selected CRM %s details using the same scoped navigation",
  async (detailView) => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      const selection = {
        serverId: "crm-source",
        serverRevision: 2,
        organizationId: "org-1",
        crmRoleId: "crm-role",
      };
      const source = { ...selection, name: "CRM" };
      const common = { source, checkedAt: "2026-10-22T00:00:00Z" };
      api.crmData.mockImplementation(async (input) =>
        input.operation === "candidateDetails"
          ? {
              ...common,
              operation: "candidateDetails",
              outbox: [],
              scope: "stored_candidate_details",
              candidateId: input.candidateId,
              review: {
                id: "review",
                crmRoleId: "crm-role",
                stage: null,
                reviewed: true,
                result: null,
                notes: "Actual internal review note",
                updatedAt: common.checkedAt,
                candidateName: "Person",
                roleTitle: "Role",
              },
              roleTracking: [],
              roleInterests: [],
              campaignAssociations: {
                leadCampaigns: [
                  {
                    leadId: "lead",
                    campaignId: "campaign",
                    campaign: {
                      id: "campaign",
                      name: "Actual saved campaign",
                      status: 2,
                      crmRoleId: "crm-role",
                      clientId: "client",
                      syncedAt: common.checkedAt,
                    },
                  },
                ],
                pipelineCampaign: null,
                offset: 0,
                nextOffset: null,
              },
            }
          : input.operation === "roleCampaigns"
            ? {
                ...common,
                operation: "roleCampaigns",
                scope: "stored_role_campaigns",
                crmRoleId: "crm-role",
                items: [],
                offset: 0,
                nextOffset: null,
              }
            : {
                ...common,
                operation: "candidates",
                scope: "legacy_role_labels",
                selectedRole: {
                  crmRoleId: "crm-role",
                  clientId: "client",
                  clientLabel: "Client",
                  roleLabel: "Role",
                  summary: null,
                },
                items: [
                  {
                    candidateId: "person",
                    name: "Person",
                    email: null,
                    phone: null,
                    linkedinUrl: null,
                    title: null,
                    location: null,
                    stage: null,
                    contactStatus: "",
                    outreachStatus: "",
                    roleSpecId: null,
                    legacyClientLabel: "Client",
                    legacyRoleLabel: "Role",
                  },
                ],
                total: 1,
                offset: 0,
                nextOffset: null,
              },
      );
      const onSelectCandidate = vi.fn();
      const browse = { selection, view: detailView, onSelectCandidate };
      const view = await mounted("thread-1", undefined, false, undefined, {
        groupId: "group-1",
        crmBrowse: browse,
      });
      await view.click("View details");
      expect(onSelectCandidate).toHaveBeenCalledExactlyOnceWith("person", detailView);
      const options = { groupId: "group-1", crmBrowse: { ...browse, candidateId: "person" } };
      await view.render("thread-1", 0, false, undefined, options);
      await act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "start" });
      expect(document.activeElement).toBe(scroll.mock.instances[0]);
      expect(document.activeElement?.textContent).toContain(
        detailView === "feedback" ? "Actual internal review note" : "Actual saved campaign",
      );
      await view.render("thread-1", 1, false, undefined, options);
      await act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
      expect(scroll).toHaveBeenCalledTimes(1);
      await view.click("View details");
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      scroll.mockRestore();
    }
  },
);

it.each([null, "not-a-link"])(
  "shows an honest CRM Job Brief empty state without a renderable description (%s)",
  async (jdUrl) => {
    const selection = {
      serverId: "crm-source",
      serverRevision: 2,
      organizationId: "org-1",
      crmRoleId: "crm-role",
    };
    api.crmData.mockResolvedValue({
      operation: "candidates",
      source: { ...selection, name: "CRM" },
      checkedAt: "2026-10-22T00:00:00Z",
      scope: "legacy_role_labels",
      selectedRole: {
        crmRoleId: "crm-role",
        clientId: "client",
        clientLabel: "Client",
        roleLabel: "Role",
        summary: null,
        description: null,
        jdText: null,
        jdUrl,
      },
      items: [],
      total: 0,
      offset: 0,
      nextOffset: null,
    });
    const start = vi.fn();
    const view = await mounted("thread-1", undefined, false, undefined, {
      groupId: "group-1",
      crmBrowse: { selection, view: "brief", onSelectCandidate: vi.fn(), onStartRecruiting: start },
    });
    expect(view.container.textContent).toContain(
      "No job description is saved for this role. Add a JD or link when starting recruiting.",
    );
    expect(
      [...view.container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Start recruiting",
      ),
    ).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
    expect(api.crmData.mock.calls.every(([input]) => input.operation === "candidates")).toBe(true);
  },
);

it("discards late CRM role reads and rejects a mismatched returned organization", async () => {
  const selection = {
    serverId: "crm-source",
    serverRevision: 2,
    organizationId: "org-1",
    crmRoleId: "first-role",
  };
  const result = (roleId: string, name: string, organizationId = "org-1") => ({
    operation: "candidates",
    source: { serverId: "crm-source", serverRevision: 2, organizationId, name: "CRM" },
    checkedAt: "2026-10-22T00:00:00Z",
    scope: "legacy_role_labels",
    selectedRole: {
      crmRoleId: roleId,
      clientId: "client",
      clientLabel: "Client",
      roleLabel: roleId,
      summary: null,
    },
    items: [
      {
        candidateId: name,
        name,
        email: null,
        phone: null,
        linkedinUrl: null,
        location: null,
        title: null,
        stage: null,
        contactStatus: "",
        outreachStatus: "",
        roleSpecId: null,
        legacyClientLabel: "Client",
        legacyRoleLabel: roleId,
      },
    ],
    total: 1,
    offset: 0,
    nextOffset: null,
  });
  let finish!: (value: ReturnType<typeof result>) => void;
  api.crmData
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(result("second-role", "Current person"));
  const options = {
    groupId: "group-1",
    crmBrowse: { selection, view: "contacts" as const, onSelectCandidate: vi.fn() },
  };
  const view = await mounted("thread-1", undefined, false, undefined, options);
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...options.crmBrowse, selection: { ...selection, crmRoleId: "second-role" } },
  });
  await act(async () => finish(result("first-role", "Late private person")));
  expect(view.container.textContent).toContain("Current person");
  expect(view.container.textContent).not.toContain("Late private person");
  api.crmData.mockResolvedValue(result("third-role", "Foreign organization person", "other-org"));
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...options.crmBrowse, selection: { ...selection, crmRoleId: "third-role" } },
  });
  expect(view.container.textContent).toContain("Could not load CRM records");
  expect(view.container.textContent).not.toContain("Foreign organization person");
});

it("restarts an invalidated pending CRM read using the existing refresh signal", async () => {
  const selection = {
    serverId: "crm-source",
    serverRevision: 2,
    organizationId: "org-1",
    crmRoleId: "crm-role",
  };
  const page = {
    operation: "candidates",
    source: { ...selection, name: "CRM" },
    checkedAt: "2026-10-22T00:00:00Z",
    scope: "legacy_role_labels",
    selectedRole: {
      crmRoleId: "crm-role",
      clientId: "client",
      clientLabel: "Client",
      roleLabel: "Role",
      summary: null,
    },
    items: [],
    total: 0,
    offset: 0,
    nextOffset: null,
  };
  let finish!: (value: unknown) => void;
  api.crmData
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(page);
  const cache = { epoch: 0, entries: new Map<string, unknown>() };
  const options = {
    groupId: "group-1",
    readCache: cache,
    readCacheScope: "actor:space:thread",
    crmBrowse: { selection, view: "contacts" as const, onSelectCandidate: vi.fn() },
  };
  const view = await mounted("thread-1", undefined, false, undefined, options);
  cache.epoch++;
  await view.render("thread-1", 1, false, undefined, options);
  expect(api.crmData).toHaveBeenCalledTimes(2);
  await act(async () => finish(page));
  expect(view.container.textContent).not.toContain("Loading CRM records");
  expect(view.container.textContent).toContain("No CRM records matched");
});

it("shows Important role rows, sourced interest, internal notes and stored campaigns without inventing bookings or sequence steps", async () => {
  const selection = {
    serverId: "crm-source",
    serverRevision: 2,
    organizationId: "org-1",
    crmRoleId: "crm-role",
  };
  const source = { ...selection, name: "CRM" };
  const checkedAt = "2026-10-22T00:00:00Z";
  const person = {
    candidateId: "crm-person",
    name: "Existing person",
    email: null,
    phone: null,
    linkedinUrl: null,
    location: null,
    title: "Engineer",
    stage: "Passed",
    contactStatus: "",
    outreachStatus: "",
    roleSpecId: null,
    legacyClientLabel: "Client",
    legacyRoleLabel: "Stored role",
  };
  const tracking = {
    roleKey: "tracking-a",
    clientLabel: "Client",
    roleLabel: "Stored role",
    highSignal: true,
    workflowStatus: "needs_scheduling",
    highSignalAt: checkedAt,
    statusChangedAt: checkedAt,
    updatedAt: checkedAt,
  };
  const campaign = {
    id: "campaign-a",
    name: "Stored campaign",
    status: 2,
    crmRoleId: "crm-role",
    clientId: "client",
    syncedAt: checkedAt,
  };
  api.crmData.mockImplementation(async (input) => {
    const common = { operation: input.operation, source, checkedAt };
    if (input.operation === "important")
      return {
        ...common,
        scope: "organization_candidate_roles",
        items: [
          { ...person, ...tracking },
          {
            ...person,
            ...tracking,
            roleKey: "tracking-b",
            roleLabel: "Another role",
            workflowStatus: "scheduled",
          },
        ],
        total: 2,
        offset: 0,
        nextOffset: null,
      };
    if (input.operation === "candidateDetails")
      return {
        ...common,
        scope: "stored_candidate_details",
        outbox: [
          {
            id: "failed-request",
            status: "failed",
            body: "Original recruiter request",
            polishedBody: null,
            providerMessageId: null,
            error: "Original send failure",
            createdAt: checkedAt,
            sentAt: null,
          },
        ],
        candidateId: input.candidateId,
        review: {
          id: "review",
          crmRoleId: null,
          stage: "Reviewed",
          reviewed: true,
          result: "approved",
          notes: "Internal review note",
          updatedAt: checkedAt,
          candidateName: person.name,
          roleTitle: "Stored role",
        },
        roleTracking: [tracking],
        roleInterests: [
          {
            roleKey: "tracking-a",
            clientLabel: "Client",
            roleLabel: "Stored role",
            interest: "declined",
            source: "manual",
          },
          {
            roleKey: "tracking-b",
            clientLabel: "Client",
            roleLabel: "Another role",
            interest: "interested",
            source: "ai",
          },
          {
            roleKey: "tracking-c",
            clientLabel: "Client",
            roleLabel: "Third role",
            interest: "unknown",
            source: "instantly",
          },
        ],
        campaignAssociations: {
          leadCampaigns: [{ leadId: "private-lead", campaignId: campaign.id, campaign }],
          pipelineCampaign: null,
          offset: 0,
          nextOffset: null,
        },
      };
    if (input.operation === "roleCampaigns")
      return {
        ...common,
        scope: "stored_role_campaigns",
        crmRoleId: "crm-role",
        items: [
          {
            id: input.offset ? "campaign-b" : campaign.id,
            name: input.offset ? "Next stored campaign" : campaign.name,
            status: campaign.status,
            syncedAt: checkedAt,
          },
        ],
        offset: input.offset ?? 0,
        nextOffset: input.offset ? null : 30,
      };
    return {
      ...common,
      scope: "legacy_role_labels",
      selectedRole: {
        crmRoleId: "crm-role",
        clientId: "client",
        clientLabel: "Client",
        roleLabel: "Stored role",
        summary: null,
      },
      items: [person],
      total: 1,
      offset: 0,
      nextOffset: null,
    };
  });
  const onSelectCandidate = vi.fn();
  const browse = { selection, onSelectCandidate, view: "shortlist" as const };
  const options = { groupId: "group-1", crmBrowse: browse };
  const view = await mounted("thread-1", undefined, false, undefined, options);
  expect(api.crmData).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "important", status: "high_signal" }),
  );
  expect(view.container.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(view.container.textContent).toContain("Another role");
  expect(view.container.textContent).not.toContain("Passed");
  expect(view.container.textContent).toContain("2 candidate-role records");
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...browse, view: "interview" },
  });
  expect(api.crmData).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "important", status: "needs_scheduling" }),
  );
  expect(view.container.textContent).toContain("Needs scheduling");
  expect(view.container.textContent).toContain("Scheduled");
  expect(view.container.textContent).toContain("Calendar booking details are not included");
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...browse, view: "feedback", candidateId: "crm-person" },
  });
  expect(view.container.textContent).toContain("Internal review note");
  expect(view.container.textContent).toContain("Original recruiter request");
  expect(view.container.textContent).toContain("There was a problem sending this message.");
  expect(view.container.textContent).not.toContain("Original send failure");
  expect(view.container.textContent).toContain("Human-entered");
  expect(view.container.textContent).toContain("AI interpretation");
  expect(view.container.textContent).toContain("Instantly");
  expect(view.container.textContent).not.toContain("Client approved");
  await view.click("View details");
  expect(onSelectCandidate).toHaveBeenCalledWith("crm-person", "feedback");
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...browse, view: "sequence", candidateId: "crm-person" },
  });
  expect(view.container.textContent).toContain("Stored campaign");
  expect(view.container.textContent).toContain(
    "Sequence steps and delivery status are not included",
  );
  expect(view.container.textContent).not.toContain("private-lead");
  await view.click("Next campaigns");
  expect(api.crmData).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "roleCampaigns", crmRoleId: "crm-role", offset: 30 }),
  );
  expect(view.container.textContent).toContain("Next stored campaign");
  expect(api.getWorkspace).not.toHaveBeenCalled();
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it("keeps CRM detail reads scoped to the selected person and rejects a mismatched detail response", async () => {
  const selection = {
    serverId: "crm-source",
    serverRevision: 2,
    organizationId: "org-1",
    crmRoleId: "crm-role",
  };
  const common = { source: { ...selection, name: "CRM" }, checkedAt: "2026-10-22T00:00:00Z" };
  const detail = (candidateId: string, notes: string) => ({
    ...common,
    operation: "candidateDetails",
    outbox: [],
    scope: "stored_candidate_details",
    candidateId,
    review: {
      id: "review",
      crmRoleId: null,
      stage: null,
      reviewed: true,
      result: null,
      notes,
      updatedAt: common.checkedAt,
      candidateName: candidateId,
      roleTitle: null,
    },
    roleInterests: [],
    roleTracking: [],
    campaignAssociations: {
      leadCampaigns: [],
      pipelineCampaign: null,
      offset: 0,
      nextOffset: null,
    },
  });
  let finish!: (value: unknown) => void;
  api.crmData.mockImplementation(async (input) => {
    if (input.operation === "candidateDetails") {
      if (input.candidateId === "old-person")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return detail("current-person", "Current private review");
    }
    return {
      ...common,
      operation: "candidates",
      scope: "legacy_role_labels",
      selectedRole: {
        crmRoleId: "crm-role",
        clientId: "client",
        clientLabel: "Client",
        roleLabel: "Role",
        summary: null,
      },
      items: [],
      total: 0,
      offset: 0,
      nextOffset: null,
    };
  });
  const browse = {
    selection,
    view: "feedback" as const,
    candidateId: "old-person",
    onSelectCandidate: vi.fn(),
  };
  const options = { groupId: "group-1", crmBrowse: browse };
  const view = await mounted("thread-1", undefined, false, undefined, options);
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...browse, candidateId: "current-person" },
  });
  await act(async () => finish(detail("old-person", "Late private review")));
  expect(view.container.textContent).toContain("Current private review");
  expect(view.container.textContent).not.toContain("Late private review");
  await view.render("thread-1", 0, false, undefined, {
    ...options,
    crmBrowse: { ...browse, candidateId: "other-person" },
  });
  expect(view.container.textContent).toContain("Could not load CRM records");
  expect(view.container.textContent).not.toContain("Current private review");
});

function rawResultsFixture(actionId = "raw-action", name = "Synthetic raw candidate") {
  const rows = [{ name, label: "Strong Match", _sources: { s1: "https://example.test/profile" } }];
  const snapshot = {
    version: 1,
    taskId: "raw-task",
    actionId,
    operation: "rows",
    effectId: `read-${actionId}`,
    request: { task_id: "raw-provider-task", cursor: "  real-cursor==  " },
    providerResult: { rows },
    observation: {
      deliveryState: "accepted",
      providerTaskId: "raw-provider-task",
      observedProviderState: null,
      done: null,
      providerApplicationConfirmed: false,
      automaticRetry: false,
      usage: null,
      rows,
      nextCursor: null,
    },
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const reference = {
    artifactId: `artifact-${actionId}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const task = {
    id: "raw-task",
    roleId: "role-1",
    providerTaskId: "raw-provider-task",
    state: "completed",
  };
  const action = {
    id: actionId,
    taskId: task.id,
    roleRevisionId: "old-revision",
    kind: "continue",
    deliveryState: "accepted",
    observedProviderState: "completed",
    runId: "original-run",
    sourceMessageId: "original-message",
    clientNonce: `nonce-${actionId}`,
    requestArtifact: { artifactId: `request-${actionId}`, sha256: "b".repeat(64) },
    contextArtifact: { artifactId: `context-${actionId}`, sha256: "c".repeat(64) },
    receiptArtifact: null,
    recallScope: null,
    cursor: null,
    effectId: "mutation-effect",
    usage: null,
    outputArtifacts: [reference],
  };
  const artifact = {
    id: reference.artifactId,
    botId: "original-bot",
    groupId: "original-group",
    runId: "capture-run",
    name: "raw-results.json",
    mimeType: "application/json",
    size: bytes.length,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    contentBase64: bytes.toString("base64"),
  };
  return { snapshot, reference, task, action, artifact };
}

function nativeOutput(f: ReturnType<typeof rawResultsFixture>, snapshot: unknown, id: string) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  return {
    reference: { artifactId: id, sha256: createHash("sha256").update(bytes).digest("hex") },
    artifact: { ...f.artifact, id, size: bytes.length, contentBase64: bytes.toString("base64") },
  };
}

function artifactSourceFixture(
  content: string | Uint8Array = "Before\nBuilt a compiler\nAfter",
  mimeType = "text/plain",
  artifactId = "artifact-source",
) {
  const bytes = Buffer.from(content);
  const reference = { artifactId, sha256: createHash("sha256").update(bytes).digest("hex") };
  return {
    reference,
    artifact: {
      id: artifactId,
      botId: "material-bot",
      groupId: null,
      name: "original-material.txt",
      mimeType,
      size: bytes.length,
      contentBase64: bytes.toString("base64"),
    },
    source: {
      ...source,
      anchor: { kind: "artifact", artifact: reference, locator: "Source excerpt" },
      quote: "Built a compiler",
      selection: { kind: "artifact_text", start: 7, end: 23 },
    } satisfies RecruitingAssessmentSourceRef,
  };
}

const source = {
  id: "source-1",
  kind: "original_material" as const,
  anchor: { kind: "message" as const, messageId: "message-1", locator: "Role brief" },
  readState: "read" as const,
  readAt: "2026-01-01T00:00:00Z",
  quote: "Build systems",
};
const role: RecruitingRole = {
  id: "role-1",
  spaceId: "space-1",
  userId: "user-1",
  sourceThreadId: "thread-1",
  title: "Systems engineer",
  revision: 2,
  currentRevisionId: "revision-2",
};
const revision: RecruitingRoleRevision = {
  id: "revision-2",
  roleId: role.id,
  revision: 2,
  sourceRefs: [source],
  preferences: ["Small teams"],
  definitionQuestions: ["Which location?"],
  criteria: [
    {
      id: "criterion-1",
      priority: "hard",
      expression: { kind: "atom", id: "atom-1", statement: "Build systems" },
      sourceRefs: [source],
      definitionQuestions: ["What scale?"],
    },
  ],
  createdAt: "2026-01-01T00:00:00Z",
};
const savedObservation = {
  effectId: "native-read-1",
  providerTaskId: "native-provider-task",
  roleRevisionId: revision.id,
  runId: "native-run",
  rowCount: 15,
  observedAt: "2026-10-16T00:00:00.000Z",
  requestCursor: null,
  artifactRef: { artifactId: "native-results", sha256: "a".repeat(64) },
};
const assessmentSource = {
  ...source,
  selection: { kind: "message_text", blockIndex: 0, start: 0, end: source.quote.length },
} satisfies RecruitingAssessmentSourceRef;
const assessment = {
  assessment: {
    roleId: role.id,
    candidateKey: "candidate-1",
    roleRevisionId: "revision-1",
    version: 1,
    basedOnVersion: null,
    createdByRunId: "run-1",
    createdAt: "2026-01-01T00:00:00Z",
    facts: [
      { kind: "statement", id: "fact-1", statement: "Built a compiler", sourceRefIds: [source.id] },
    ],
    sourceRefs: [assessmentSource],
    judgments: {
      atoms: [
        {
          atomId: "atom-1",
          verdict: "unknown",
          factIds: ["fact-1"],
          evidence: [source.id],
          missing: ["Which component?"],
        },
      ],
      employment: [],
      hardGate: "unknown",
      criteria: [
        {
          criterionId: "criterion-1",
          verdict: "unknown",
          factIds: ["fact-1"],
          evidence: [source.id],
          missing: ["Which component?"],
        },
      ],
    },
    questions: ["How long?"],
  } satisfies RecruitingAssessment,
  isCurrent: false,
  roleRevision: {
    ...revision,
    id: "revision-1",
    revision: 1,
    criteria: [
      {
        ...revision.criteria[0]!,
        expression: { kind: "atom", id: "atom-1", statement: "Original systems requirement" },
      },
    ],
  },
  sourceMessageTargets: [
    {
      messageId: source.anchor.messageId,
      threadId: "material-thread",
      target: { groupId: "material-group" },
    },
  ],
} satisfies RecruitingAssessmentSnapshot;
let cleanup: (() => Promise<void>) | undefined;
const crmTarget: RecruitingCrmTarget = {
  mcpServerId: "crm-server",
  serverRevision: 1,
  organizationId: "00000000-0000-4000-8000-000000000001",
  crmRoleId: "00000000-0000-4000-8000-000000000002",
  crmClientId: "00000000-0000-4000-8000-000000000003",
  clientLabel: "Example Robotics",
  roleLabel: "Geometry engineer",
};
function crmSync(status: RecruitingCrmCandidateSync["status"]): RecruitingCrmCandidateSync {
  return {
    effectId: `crm-${status}`,
    bindingEffectId: "crm-binding",
    sourceEffectId: "read-effect",
    rowIndex: 0,
    target: crmTarget,
    status,
    receipt:
      status === "synced"
        ? {
            candidate_id: "10000000-0000-4000-8000-000000000001",
            source_id: "10000000-0000-4000-8000-000000000002",
            membership_id: "10000000-0000-4000-8000-000000000003",
            organization_id: crmTarget.organizationId,
            role_spec_id: crmTarget.crmRoleId,
            linkedin_identity: "/in/synthetic-candidate",
            source_file: "artifact:synthetic:row:0",
          }
        : null,
  };
}
function candidatePage(items = [candidateFixture()]) {
  return {
    sortAvailability: { rank: true, tier: true, score: true },
    roleId: role.id,
    roleRevisionId: revision.id,
    crmTarget: null as { bindingEffectId: string; target: RecruitingCrmTarget } | null,
    items,
    nextCursor: null as string | null,
    total: items.length,
    counts: {
      sourceRows: 19,
      candidates: 12,
      identifiedCandidates: 10,
      unassessed: 9,
      assessed: 3,
      shortlisted: 2,
    },
  };
}
function candidateFixture(candidateKey = "candidate-1", assessed = true) {
  return {
    roleId: role.id,
    candidateKey,
    name: null as string | null,
    title: null as string | null,
    company: null as string | null,
    location: null as string | null,
    linkedinUrl: null as string | null,
    resumeUrl: null as string | null,
    evidenceUrls: null as string[] | null,
    issues: [] as string[],
    shortlisted: false,
    decision: null as RecruitingCandidate["decision"],
    revision: 0,
    discoveryCount: 2,
    firstDiscoveredAt: "2026-01-01T00:00:00Z",
    lastDiscoveredAt: "2026-01-02T00:00:00Z",
    latestAssessment: assessed
      ? {
          version: 1,
          roleRevisionId: "revision-1",
          createdAt: "2026-01-01T00:00:00Z",
          isCurrent: false,
          hardGate: "unknown" as const,
        }
      : null,
    crm: null as RecruitingCrmCandidateSync | null,
    latestSource: undefined as RecruitingCandidate["latestSource"],
  };
}
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  api.session.data.user.id = "actor-1";
  const request = artifactSourceFixture("{}", "application/json", "artifact-request");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  api.getWorkspace.mockResolvedValue({ role, revision });
  api.correspondence.mockResolvedValue({
    status: "not_checked",
    checkedAt: null,
    connections: [],
    emails: [],
    events: [],
    contacts: [],
    partial: false,
  });
  api.listFeedback.mockResolvedValue({ feedback: [], nextCursor: null });
  api.readSource.mockRejectedValue(new Error("Source unavailable"));
  api.listAssessments.mockResolvedValue([assessment]);
  api.listCandidates.mockImplementation(async ({ roleId }: { roleId: string }) => {
    const assessments = (await api.listAssessments.mock.results.at(-1)?.value) ?? [assessment];
    const workspace = await api.getWorkspace.mock.results.at(-1)?.value;
    return {
      ...candidatePage(
        assessments
          .filter((item: RecruitingAssessmentSnapshot) => item.assessment.roleId === roleId)
          .map((item: RecruitingAssessmentSnapshot) => ({
            ...candidateFixture(item.assessment.candidateKey),
            roleId: item.assessment.roleId,
            latestAssessment: {
              version: item.assessment.version,
              roleRevisionId: item.assessment.roleRevisionId,
              createdAt: item.assessment.createdAt,
              isCurrent: item.isCurrent,
              hardGate: item.assessment.judgments.hardGate,
            },
          })),
      ),
      roleId,
      roleRevisionId: workspace?.revision.id ?? revision.id,
    };
  });
  api.getAssessment.mockImplementation(
    async ({ roleId, candidateKey }: { roleId: string; candidateKey: string }) => {
      const assessments = (await api.listAssessments.mock.results.at(-1)?.value) ?? [assessment];
      return (
        assessments.find(
          (item: RecruitingAssessmentSnapshot) =>
            item.assessment.roleId === roleId && item.assessment.candidateKey === candidateKey,
        ) ?? null
      );
    },
  );
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: "candidate-1",
    items: [],
    nextCursor: null,
    total: 0,
  });
  api.listQuestions.mockResolvedValue({ questions: [] });
  api.answer.mockResolvedValue({ ok: true });
  api.listResearch.mockResolvedValue({
    observations: [],
    tasks: [{ id: "task-1", roleId: role.id, state: "active", providerTaskId: "provider-task-1" }],
    actions: [
      {
        id: "action-1",
        taskId: "task-1",
        kind: "create",
        roleRevisionId: revision.id,
        deliveryState: "accepted",
        observedProviderState: "running",
        recallScope: "Compiler teams",
        requestArtifact: request.reference,
        contextArtifact: { artifactId: "artifact-context", sha256: "b".repeat(64) },
        receiptArtifact: null,
        outputArtifacts: [],
        usage: null,
      },
    ],
  });
  api.list.mockResolvedValue([
    {
      id: "doc-1",
      scope: "user",
      botId: null,
      path: "preferences.md",
      content: "Remote teams",
      revision: 3,
      updatedAt: "2026-01-01",
    },
  ]);
  api.history.mockResolvedValue([
    {
      id: "history-1",
      documentId: "doc-1",
      revision: 2,
      content: "Earlier preference",
      sourceThreadId: "thread-1",
      sourceRunId: "run-1",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  api.getById.mockResolvedValue({
    ...request.artifact,
    botId: "source-bot",
    name: "request.json",
  });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
// Existing receipt/recovery cases explicitly exercise developer diagnostics; product mode is tested below.
async function mounted(
  threadId = "thread-1",
  botId?: string,
  showDiagnostics = true,
  recipients?: ComponentProps<typeof RecruitingPanel>["candidateFeedbackRecipients"],
  navigation: Pick<
    ComponentProps<typeof RecruitingPanel>,
    | "tab"
    | "onTabChange"
    | "presentation"
    | "view"
    | "summary"
    | "onBrowseCandidates"
    | "groupId"
    | "readCache"
    | "readCacheScope"
    | "crmBrowse"
    | "roleConversation"
  > = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reveal = vi.fn();
  const discuss = vi.fn();
  const feedback = vi.fn().mockResolvedValue(true);
  const render = async (
    id: string,
    refreshSignal = 0,
    diagnostics = showDiagnostics,
    feedbackRecipients = recipients,
    tabNavigation = navigation,
  ) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <RecruitingPanel
            {...tabNavigation}
            threadId={id}
            botId={botId}
            showDiagnostics={diagnostics}
            refreshSignal={refreshSignal}
            onClose={() => {}}
            onRevealMessage={reveal}
            onDiscussCandidate={discuss}
            onCandidateFeedback={feedback}
            candidateFeedbackRecipients={feedbackRecipients}
          />
        </MemoryRouter>,
      ),
    );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await render(threadId);
  const click = async (name: string) => {
    const button = [
      ...document.body.querySelectorAll<HTMLElement>('button,[role="checkbox"]'),
    ].find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
    expect(button, name).toBeDefined();
    await act(async () => button!.click());
  };
  const expand = async (name: string, exact = false) => {
    const details = [...document.body.querySelectorAll("details")].find((item) =>
      exact
        ? item.querySelector("summary")?.textContent === name
        : item.querySelector("summary")?.textContent?.includes(name),
    );
    expect(details, name).toBeDefined();
    await act(async () => {
      details!.open = true;
      details!.dispatchEvent(new Event("toggle"));
    });
    return details!;
  };
  return { container: document.body, render, click, expand, reveal, discuss, feedback };
}

it("debounces candidate typing and aborts superseded query and role reads without publishing late rows", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const view = await mounted("thread-1", undefined, false, undefined, {
      presentation: "workspace",
    });
    api.listCandidates.mockClear();
    let finishOld!: (page: ReturnType<typeof candidatePage>) => void;
    api.listCandidates.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    await changeInput(view.container, "Search candidates", "A");
    await changeInput(view.container, "Search candidates", "Av");
    await changeInput(view.container, "Search candidates", "Avery");
    expect(
      view.container.querySelector<HTMLInputElement>('[aria-label="Search candidates"]')!.value,
    ).toBe("Avery");
    expect(api.listCandidates).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(api.listCandidates).toHaveBeenCalledTimes(1);
    expect(api.listCandidates.mock.lastCall?.[0]).toMatchObject({
      query: "Avery",
      roleId: role.id,
    });
    const oldSignal = api.listCandidates.mock.lastCall?.[1]?.signal as AbortSignal;
    expect(oldSignal?.aborted).toBe(false);
    await changeInput(view.container, "Search candidates", "Other");
    expect(oldSignal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(api.listCandidates).toHaveBeenCalledTimes(2);
    const otherSignal = api.listCandidates.mock.lastCall?.[1]?.signal as AbortSignal;
    expect(otherSignal.aborted).toBe(false);
    api.getWorkspace.mockResolvedValue({
      role: { ...role, id: "other-role", sourceThreadId: "other-thread" },
      revision: { ...revision, id: "other-revision", roleId: "other-role" },
    });
    api.listCandidates.mockReturnValue(new Promise(() => {}));
    await view.render("other-thread");
    expect(otherSignal.aborted).toBe(true);
    expect(api.listCandidates.mock.lastCall?.[0]).toMatchObject({ roleId: "other-role" });
    await act(async () =>
      finishOld(candidatePage([{ ...candidateFixture(), name: "Late old person" }])),
    );
    expect(view.container.textContent).not.toContain("Late old person");
    expect(view.container.textContent).not.toContain("Could not load candidates");
  } finally {
    await cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
  }
});

it.each(["results", "shortlist", "contacts"] as const)(
  "loads %s candidates without unrelated assessment, question or memory history and keeps native evidence and feedback",
  async (viewName) => {
    const candidate = { ...candidateFixture(), shortlisted: viewName === "shortlist" };
    if (viewName === "contacts") {
      candidate.name = "Saved candidate";
      api.correspondence.mockResolvedValue({
        status: "ready",
        checkedAt: "2026-01-02T00:00:00Z",
        connections: [],
        emails: [],
        events: [],
        partial: false,
        contacts: [
          {
            candidateKey: candidate.candidateKey,
            linkedinUrl: "https://linkedin.com/in/saved-candidate",
            emails: [{ address: "enriched@example.test", status: "HIGH_PROBABILITY" }],
            phones: [{ number: "+15550001000", type: "work" }],
            source: "Connected contact service",
            checkedAt: "2026-01-02T00:00:00Z",
          },
          {
            candidateKey: "different-person",
            linkedinUrl: "https://linkedin.com/in/different",
            emails: [{ address: "other@example.test", status: null }],
            phones: [],
            source: "Connected contact service",
            checkedAt: "2026-01-02T00:00:00Z",
          },
        ],
      });
      candidate.latestSource = {
        taskId: null,
        actionId: null,
        roleRevisionId: revision.id,
        effectId: "source-effect",
        providerTaskId: "provider-task",
        rowIndex: 0,
        artifactRef: { artifactId: "source-artifact", sha256: "a".repeat(64) },
        requestCursor: null,
        outputId: null,
        observedAt: "2026-01-01T00:00:00Z",
        report: {
          fields: [
            {
              label: "Work email",
              value: "saved@example.test",
              sourceUrls: ["https://evidence.example.test/contact"],
            },
            { label: "Email status", value: "Not verified", sourceUrls: [] },
          ],
          sourceUrls: [],
        },
      };
    }
    api.listCandidates.mockResolvedValue(candidatePage([candidate]));
    const view = await mounted("thread-1", undefined, false, undefined, {
      presentation: "workspace",
      groupId: "group-1",
      view: viewName,
      tab: "evidence",
    });
    if (viewName !== "results")
      expect(view.container.querySelector("h1")?.textContent).toBe(
        viewName === "shortlist" ? "Shortlist" : "Contacts",
      );
    if (viewName === "contacts") {
      expect(
        [...view.container.querySelectorAll("thead th")].map((cell) => cell.textContent),
      ).toContain("Email");
      expect(api.correspondence).toHaveBeenCalledExactlyOnceWith({
        groupId: "group-1",
        view: "contacts",
      });
      expect(view.container.querySelector("tbody")?.textContent).toContain("enriched@example.test");
      expect(view.container.querySelector("tbody")?.textContent).toContain("+15550001000");
      expect(view.container.querySelector("tbody")?.textContent).toContain("High probability");
      expect((await api.correspondence.mock.results[0]!.value).contacts[0].emails[0].status).toBe(
        "HIGH_PROBABILITY",
      );
      expect(
        [...view.container.querySelectorAll("thead th")].map((cell) => cell.textContent),
      ).toContain("Provider status");
      expect(view.container.querySelector("tbody")?.textContent).not.toContain(
        "Verified by provider",
      );
      expect(view.container.querySelector("tbody")?.textContent).toContain(
        "Connected contact service",
      );
      expect(view.container.querySelector("tbody")?.textContent).not.toContain(
        "other@example.test",
      );
      expect(view.container.querySelector("tbody")?.textContent).toContain("saved@example.test");
      expect(view.container.querySelector("tbody")?.textContent).toContain("Not verified");
      expect(
        view.container.querySelector('tbody a[href="https://evidence.example.test/contact"]'),
      ).not.toBeNull();
      await view.click("Find email");
      expect(view.discuss).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          roleId: role.id,
          candidateKey: candidate.candidateKey,
          intent: "contact_lookup",
        }),
      );
    }
    if (viewName !== "contacts") expect(api.correspondence).not.toHaveBeenCalled();
    expect(api.listAssessments).not.toHaveBeenCalled();
    expect(api.listQuestions).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
    expect(api.listResearch).toHaveBeenCalledExactlyOnceWith({ roleId: role.id });
    expect(api.listCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: role.id,
        ...(viewName === "shortlist" ? { shortlisted: true } : {}),
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(view.container.querySelector('select[aria-label="Internal assessment"]')).not.toBeNull();
    expect(
      view.container.querySelector('select[aria-label="Research round"]')?.textContent,
    ).toContain("Search update");
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>(
          ".hire-candidate-identity, .hire-table button[aria-haspopup='dialog']",
        )!
        .click(),
    );
    expect(api.getAssessment).toHaveBeenCalledWith({
      roleId: role.id,
      candidateKey: "candidate-1",
      version: 1,
    });
    expect(api.listCandidateSources).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: role.id, candidateKey: "candidate-1" }),
    );
    expect(api.listFeedback).toHaveBeenCalledWith({
      roleId: role.id,
      candidateKey: "candidate-1",
      limit: 20,
    });
    await view.click("Give feedback");
    await changeSelect(view.container, "Feedback", "good_example");
    await changeFeedbackReason(view.container, "Prefer this background for the next search.");
    await view.click("Send feedback");
    expect(view.feedback).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: role.id, candidateKey: "candidate-1" }),
      expect.objectContaining({
        choice: "good_example",
        reason: "Prefer this background for the next search.",
      }),
      expect.any(String),
    );
    expect(api.answer).not.toHaveBeenCalled();
  },
);

it("shows a warm scoped pool read-only until current validation and evicts it on denial without restoring late rows", async () => {
  const cache = { entries: new Map<string, unknown>(), epoch: 0 };
  const scope = JSON.stringify(["actor-1", role.spaceId, "thread-1"]);
  const options = {
    presentation: "workspace" as const,
    view: "results" as const,
    readCache: cache,
    readCacheScope: scope,
  };
  const candidate = { ...candidateFixture("warm-person", false), name: "Saved person" };
  const page = candidatePage([candidate]);
  api.listCandidates.mockResolvedValue(page);
  await mounted("thread-1", undefined, false, undefined, options);
  await cleanup?.();
  cleanup = undefined;
  cache.entries.set("another-role:workspace", { title: "Other role" });
  let finishWorkspace!: (value: unknown) => void;
  let finishRows!: (value: unknown) => void;
  api.getWorkspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finishWorkspace = resolve;
    }),
  );
  api.listCandidates.mockClear();
  api.listCandidates.mockReturnValueOnce(
    new Promise((resolve) => {
      finishRows = resolve;
    }),
  );
  const view = await mounted("thread-1", undefined, false, undefined, options);
  expect(view.container.querySelector(".hire-table-wrap")?.textContent).toContain(candidate.name);
  expect(api.listCandidates).not.toHaveBeenCalled();
  const shortlist = view.container.querySelector<HTMLElement>(
    '.hire-table-wrap [role="checkbox"]',
  )!;
  expect(shortlist.hasAttribute("data-disabled")).toBe(true);
  await act(async () => shortlist.click());
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  await act(async () => finishWorkspace({ role, revision }));
  expect(api.listCandidates).toHaveBeenCalledOnce();
  api.getWorkspace.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
  await view.render("thread-1", 1);
  expect(view.container.querySelector(".hire-table-wrap")).toBeNull();
  expect([...cache.entries.keys()].some((key) => key.startsWith(`${scope}:`))).toBe(false);
  expect(cache.entries.has("another-role:workspace")).toBe(true);
  await act(async () => finishRows(page));
  expect(view.container.querySelector(".hire-table-wrap")).toBeNull();
  expect([...cache.entries.keys()].some((key) => key.startsWith(`${scope}:`))).toBe(false);
});

it("preserves an explicit workspace assessment filter when a refreshed pool has no assessments", async () => {
  api.listCandidates.mockResolvedValue(candidatePage());
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    tab: "evidence",
  });
  await changeSelect(view.container, "Internal assessment", "current");
  const empty = candidatePage([]);
  empty.counts.assessed = 0;
  api.listCandidates.mockResolvedValue(empty);
  await view.render("thread-1", 1);
  expect(
    view.container.querySelector<HTMLSelectElement>('select[aria-label="Internal assessment"]')
      ?.value,
  ).toBe("current");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ roleId: role.id, assessmentState: "current" }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.listAssessments).not.toHaveBeenCalled();
});

it("refreshes contacts from native receipts and ignores a late response from another role", async () => {
  const empty = {
    status: "not_checked",
    checkedAt: null,
    connections: [],
    emails: [],
    events: [],
    contacts: [],
    partial: false,
  };
  const saved = {
    ...empty,
    status: "ready",
    contacts: [
      {
        candidateKey: "candidate-1",
        linkedinUrl: "https://linkedin.com/in/saved",
        emails: [{ address: "current@example.test", status: null }],
        phones: [],
        source: "Connected service",
        checkedAt: "2026-01-02T00:00:00Z",
      },
    ],
  };
  let finish!: (value: unknown) => void;
  api.correspondence
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(empty);
  api.listCandidates.mockResolvedValue(candidatePage([candidateFixture()]));
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    view: "contacts",
    groupId: "group-1",
  });
  expect(view.container.textContent).toContain("Loading contact details…");
  const nextRole = {
    ...role,
    id: "role-2",
    sourceThreadId: "thread-2",
    title: "Simulation engineer",
  };
  api.getWorkspace.mockResolvedValue({
    role: nextRole,
    revision: { ...revision, roleId: nextRole.id },
  });
  api.listCandidates.mockResolvedValue({
    ...candidatePage([{ ...candidateFixture(), roleId: nextRole.id }]),
    roleId: nextRole.id,
  });
  await view.render("thread-2", 0, false, undefined, {
    presentation: "workspace",
    view: "contacts",
    groupId: "group-2",
  });
  expect(api.correspondence).toHaveBeenLastCalledWith({ groupId: "group-2", view: "contacts" });
  await act(async () => finish(saved));
  expect(view.container.textContent).not.toContain("current@example.test");
  expect(view.container.textContent).toContain("Contact details have not been checked yet.");
  api.correspondence.mockResolvedValueOnce(saved);
  await view.render("thread-2", 1, false, undefined, {
    presentation: "workspace",
    view: "contacts",
    groupId: "group-2",
  });
  expect(view.container.querySelector("tbody")?.textContent).toContain("current@example.test");
  expect(api.correspondence).toHaveBeenCalledTimes(3);
  api.correspondence.mockResolvedValueOnce({
    ...saved,
    contacts: saved.contacts.map((contact) => ({ ...contact, emails: [] })),
  });
  await view.render("thread-2", 2, false, undefined, {
    presentation: "workspace",
    view: "contacts",
    groupId: "group-2",
  });
  expect(view.container.querySelector("tbody")?.textContent).not.toContain("current@example.test");
  expect(view.container.querySelector("tbody")?.textContent).toContain("Not returned");
  api.correspondence.mockRejectedValueOnce(new Error("Read unavailable"));
  await view.render("thread-2", 3, false, undefined, {
    presentation: "workspace",
    view: "contacts",
    groupId: "group-2",
  });
  expect(view.container.textContent).toContain(
    "Could not load contact details. Refresh to try again.",
  );
  expect(view.container.querySelector("tbody")?.textContent).not.toContain("current@example.test");
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  expect(api.answer).not.toHaveBeenCalled();
});

it("shows actual saved brief criteria without exposing internal field keys or fetching unrelated views", async () => {
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief: {
        fields: [
          {
            key: "location",
            value: "Bay Area, no remote",
            state: "known",
            origin: "user_instruction",
            consequential: true,
            sourceRefIds: [source.id],
          },
          {
            key: "salary_range",
            value: "Not disclosed",
            state: "unknown",
            origin: "jd",
            consequential: true,
            sourceRefIds: [source.id],
          },
          {
            key: "private_internal_scope_key",
            value: "Robotics-company experience is a preference",
            state: "known",
            origin: "inferred",
            consequential: false,
            sourceRefIds: [source.id],
          },
        ],
        searchFilters: [
          {
            id: "filter-internal",
            mode: "prefer",
            statement: "Previous robotics-company employment",
            origin: "user_instruction",
            sourceRefIds: [source.id],
          },
        ],
        rules: [],
        questions: [],
        confirmation: null,
      },
    },
  });
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    summary: "brief",
  });
  expect(view.container.textContent).toContain("Systems engineer");
  expect(view.container.textContent).toContain("Bay Area, no remote");
  expect(view.container.textContent).toContain("Not disclosed");
  expect(view.container.textContent).toContain("Assumption");
  expect(view.container.textContent).toContain("Previous robotics-company employment");
  expect(view.container.textContent).toContain("Build systems");
  expect(view.container.textContent).not.toContain("private_internal_scope_key");
  expect(view.container.textContent).not.toContain("salary_range");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  expect(api.listCandidates).not.toHaveBeenCalled();
  expect(api.listAssessments).not.toHaveBeenCalled();
  expect(api.listResearch).not.toHaveBeenCalled();
  expect(api.listQuestions).not.toHaveBeenCalled();
  expect(api.list).not.toHaveBeenCalled();
  expect(api.confirmBrief).not.toHaveBeenCalled();
  expect(api.editCriteria).not.toHaveBeenCalled();
});

it("keeps feedback summaries scoped to the current role and ignores a late previous-role response", async () => {
  let finish!: (value: { feedback: unknown[]; nextCursor: null }) => void;
  api.listFeedback.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    summary: "feedback",
  });
  expect(api.listFeedback).toHaveBeenCalledExactlyOnceWith({ roleId: role.id, limit: 20 });
  const history = view.container.querySelector(".hire-live-criteria section")!;
  const criteria = view.container.querySelector<HTMLDetailsElement>(
    ".hire-live-criteria > details",
  )!;
  expect(criteria).not.toBeNull();
  expect(criteria.open).toBe(false);
  expect(history.compareDocumentPosition(criteria) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const nextRole = {
    ...role,
    id: "other-role",
    sourceThreadId: "thread-2",
    title: "Simulation engineer",
  };
  api.getWorkspace.mockResolvedValue({
    role: nextRole,
    revision: {
      ...revision,
      roleId: nextRole.id,
      preferences: ["Simulation experience"],
      criteria: [],
    },
  });
  await view.render("thread-2");
  expect(api.listFeedback).toHaveBeenLastCalledWith({ roleId: nextRole.id, limit: 20 });
  await act(async () =>
    finish({
      feedback: [
        {
          id: "old-feedback",
          feedback: { target: "role", expectedRoleRevision: 2 },
          source: { quote: "Old role feedback must stay behind" },
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      nextCursor: null,
    }),
  );
  expect(view.container.textContent).toContain("Simulation engineer");
  expect(view.container.textContent).toContain("Simulation experience");
  expect(view.container.textContent).toContain("No saved feedback yet.");
  expect(view.container.textContent).not.toContain("Old role feedback must stay behind");
  expect(view.container.textContent).not.toContain("Small teams");
  expect(api.answer).not.toHaveBeenCalled();
  expect(api.editCriteria).not.toHaveBeenCalled();
});

async function changeStatement(container: HTMLElement, statement: string, index = 0) {
  const input = container.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Statement"]')[
    index
  ]!;
  expect(input).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      statement,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeInput(container: HTMLElement, name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  expect(input, name).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (name === "Search candidates" && !vi.isFakeTimers()) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
  }
}

async function changeSelect(container: HTMLElement, name: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  expect(select, name).not.toBeNull();
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function changeFeedbackReason(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const feedbackRecipients = [
  { id: "coordinator", name: "Coordinator" },
  { id: "researcher", name: "Research specialist" },
];

it("shows group feedback recipients with the first member selected and captures the intended recipient across an uncertain retry", async () => {
  const view = await mounted("thread-1", undefined, false, feedbackRecipients);
  view.feedback
    .mockRejectedValueOnce(new Error("Outcome unknown"))
    .mockRejectedValueOnce(new Error("Still unknown"));
  await view.click("Evidence");
  await view.click("Unnamed candidate");
  await view.click("Give feedback");
  const recipient = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Send to"]',
  )!;
  expect(recipient).not.toBeNull();
  expect(recipient.value).toBe("coordinator");
  expect(recipient.selectedOptions[0]!.textContent).toBe("Coordinator");
  await changeSelect(view.container, "Send to", "researcher");
  await changeSelect(view.container, "Feedback", "good_example");
  await changeFeedbackReason(view.container, "  Exact authored reason\n  ");
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[0]![1]).toEqual({
    choice: "good_example",
    reason: "  Exact authored reason\n  ",
    recipientBotId: "researcher",
  });
  await view.render("thread-1", 0, false, [...feedbackRecipients].reverse());
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[1]).toEqual(view.feedback.mock.calls[0]);
  await changeSelect(view.container, "Send to", "coordinator");
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[2]![1]).toEqual({
    choice: "good_example",
    reason: "  Exact authored reason\n  ",
    recipientBotId: "coordinator",
  });
  expect(view.feedback.mock.calls[2]![2]).not.toBe(view.feedback.mock.calls[1]![2]);
});

it("uses a new nonce after changing the feedback recipient and ignores an earlier recipient's late acceptance", async () => {
  const view = await mounted("thread-1", undefined, false, feedbackRecipients);
  let finish!: (accepted: boolean) => void;
  view.feedback.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await view.click("Evidence");
  await view.click("Unnamed candidate");
  await view.click("Give feedback");
  await changeSelect(view.container, "Feedback", "skip");
  await view.click("Send feedback");
  await changeSelect(view.container, "Send to", "researcher");
  await act(async () => finish(true));
  expect(view.container.querySelector('[role="dialog"]')!.textContent).not.toContain(
    "Feedback sent",
  );
  expect(
    view.container.querySelector<HTMLSelectElement>('select[aria-label="Feedback"]')!.value,
  ).toBe("skip");
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[1]![1]).toEqual({
    choice: "skip",
    reason: "",
    recipientBotId: "researcher",
  });
  expect(view.feedback.mock.calls[1]![2]).not.toBe(view.feedback.mock.calls[0]![2]);
});

it("keeps a removed feedback recipient unavailable instead of silently sending to another member", async () => {
  const view = await mounted("thread-1", undefined, false, feedbackRecipients);
  let finish!: (accepted: boolean) => void;
  view.feedback.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await view.click("Evidence");
  await view.click("Unnamed candidate");
  await view.click("Give feedback");
  await changeSelect(view.container, "Send to", "researcher");
  await changeSelect(view.container, "Feedback", "not_fit");
  await changeFeedbackReason(view.container, "Keep this draft");
  await view.click("Send feedback");
  await view.render("thread-1", 0, false, [
    feedbackRecipients[0]!,
    { id: "other", name: "Other specialist" },
  ]);
  await act(async () => finish(true));
  const recipient = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Send to"]',
  )!;
  expect(recipient.value).toBe("researcher");
  expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain(
    "Selected recipient unavailable",
  );
  expect(view.container.querySelector('[role="dialog"]')!.textContent).not.toContain(
    "Feedback sent",
  );
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]')!.value,
  ).toBe("Keep this draft");
  await view.click("Send feedback");
  expect(view.feedback).toHaveBeenCalledTimes(1);
  await changeSelect(view.container, "Send to", "other");
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[1]![1]).toEqual({
    choice: "not_fit",
    reason: "Keep this draft",
    recipientBotId: "other",
  });
});

it.each([undefined, [feedbackRecipients[0]!]])(
  "does not add a recipient selector when no group choice is needed (%j)",
  async (recipients) => {
    const view = await mounted("thread-1", recipients ? undefined : "bot-1", false, recipients);
    await view.click("Evidence");
    await view.click("Unnamed candidate");
    await view.click("Give feedback");
    expect(view.container.querySelector('select[aria-label="Send to"]')).toBeNull();
    await changeSelect(view.container, "Feedback", "skip");
    await view.click("Send feedback");
    expect(view.feedback.mock.calls[0]![1]).toEqual({
      choice: "skip",
      reason: "",
      ...(recipients ? { recipientBotId: "coordinator" } : {}),
    });
  },
);

it("requires an explicit feedback choice and preserves the authored reason without changing qualification or shortlist", async () => {
  const candidate = { ...candidateFixture(), name: "Synthetic Avery" };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(candidate.name);
  expect(view.container.querySelector('textarea[aria-label="Reason"]')).toBeNull();
  await view.click("Give feedback");
  const send = () =>
    [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Send feedback",
    )!;
  expect(send().disabled).toBe(true);
  await changeSelect(view.container, "Feedback", "good_example");
  await changeFeedbackReason(view.container, "  ");
  expect(send().disabled).toBe(true);
  const reason = "  Built the whole compiler.\nKeep this exact wording.  ";
  await changeFeedbackReason(view.container, reason);
  await view.click("Send feedback");
  expect(view.feedback).toHaveBeenCalledExactlyOnceWith(
    {
      threadId: "thread-1",
      roleTitle: role.title,
      roleVersion: revision.revision,
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      candidateRevision: candidate.revision,
      roleRevisionId: revision.id,
      name: candidate.name,
      title: null,
      company: null,
      linkedinUrl: null,
      resumeUrl: null,
    },
    { choice: "good_example", reason },
    expect.any(String),
  );
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]')!.value,
  ).toBe("");
  expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain("Feedback sent");
  expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain(
    "Hard criteriaUnknown",
  );
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  expect(api.editCriteria).not.toHaveBeenCalled();
  expect(api.reviseRole).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
});

it.each([
  { choice: "hold", label: "Pause consideration" },
  { choice: "pass", label: "Stop considering" },
  { choice: "resume", label: "Resume consideration" },
] as const)(
  "sends explicit $label with the current candidate revision and no required reason",
  async ({ choice, label }) => {
    const candidate = { ...candidateFixture(), name: "Synthetic Avery", revision: 7 };
    api.listCandidates.mockResolvedValue(candidatePage([candidate]));
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(candidate.name);
    await view.click("Give feedback");
    expect(
      view.container.querySelector(`select[aria-label="Feedback"] option[value="${choice}"]`)
        ?.textContent,
    ).toBe(label);
    await changeSelect(view.container, "Feedback", choice);
    expect(
      view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]')!.required,
    ).toBe(false);
    await view.click("Send feedback");
    expect(view.feedback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        roleId: role.id,
        roleRevisionId: revision.id,
        roleVersion: revision.revision,
        candidateKey: candidate.candidateKey,
        candidateRevision: 7,
      }),
      { choice, reason: "" },
      expect.any(String),
    );
    expect(api.setCandidateShortlist).not.toHaveBeenCalled();
    expect(api.editCriteria).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  },
);

it.each([
  { decision: "hold", label: "On hold" },
  { decision: "pass", label: "Not pursuing" },
  { decision: "resume", label: "Consideration resumed" },
] as const)(
  "shows saved $label in the existing Cards, Table and detail metadata",
  async ({ decision, label }) => {
    const candidate = { ...candidateFixture(), name: "Synthetic Avery", decision };
    api.listCandidates.mockResolvedValue(candidatePage([candidate]));
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click("Cards");
    expect(view.container.querySelector("li")?.textContent).toContain(`${role.title} · ${label}`);
    await view.click("Table");
    expect(view.container.querySelector("tbody td")?.textContent).toBe(`${role.title} · ${label}`);
    await view.click(candidate.name);
    expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(label);
    expect(view.feedback).not.toHaveBeenCalled();
  },
);

it("reads the saved decision and revision after hold before resuming without an external refresh", async () => {
  const candidate = {
    ...candidateFixture("candidate-1", false),
    name: "Synthetic Avery",
    revision: 7,
  };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(candidate.name);
  await view.click("Give feedback");
  const reads = api.listCandidates.mock.calls.length;
  const historyReads = api.listFeedback.mock.calls.length;
  let finishRead!: (page: ReturnType<typeof candidatePage>) => void;
  api.listCandidates.mockReturnValueOnce(
    new Promise((resolve) => {
      finishRead = resolve;
    }),
  );
  await changeSelect(view.container, "Feedback", "hold");
  await view.click("Send feedback");
  expect(api.listCandidates).toHaveBeenCalledTimes(reads + 1);
  expect(api.listFeedback.mock.calls.length).toBeGreaterThan(historyReads);
  expect(view.container.querySelector('[role="dialog"]')?.textContent).not.toContain("On hold");
  const held = { ...candidate, decision: "hold" as const, revision: 8 };
  await act(async () => finishRead(candidatePage([held])));
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("On hold");
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...held, decision: "resume", revision: 9 }]),
  );
  await changeSelect(view.container, "Feedback", "resume");
  await view.click("Send feedback");
  expect(
    view.feedback.mock.calls.map(([context, feedback]) => [
      context.candidateRevision,
      feedback.choice,
    ]),
  ).toEqual([
    [7, "hold"],
    [8, "resume"],
  ]);
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(
    "Consideration resumed",
  );
});

it("reads durable candidate feedback after reopening, including the exact human quote and choice", async () => {
  const candidate = { ...candidateFixture(), name: "Synthetic Avery" };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  api.listFeedback.mockResolvedValue({
    feedback: [
      {
        id: "native-feedback",
        createdAt: "2026-10-18T00:00:00.000Z",
        roleRevisionId: revision.id,
        choice: "not_fit",
        feedback: {
          target: "candidate",
          expectedRoleRevision: 1,
          candidateKeys: [candidate.candidateKey],
        },
        source: { quote: "No systems ownership. Keep this exact wording." },
      },
    ],
    nextCursor: null,
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(candidate.name);
  expect(api.listFeedback).toHaveBeenCalledWith({
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    limit: 20,
  });
  const dialog = view.container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("No systems ownership. Keep this exact wording.");
  expect(dialog.textContent).toContain("Not a fit");
  expect(dialog.textContent).not.toContain("native-feedback");
  expect(view.feedback).not.toHaveBeenCalled();
});

it("allows skipping without a reason and retains the same nonce and unchanged draft after an unknown outcome", async () => {
  const view = await mounted();
  view.feedback.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(true);
  await view.click("Evidence");
  await view.click("candidate-1");
  await view.click("Give feedback");
  await changeSelect(view.container, "Feedback", "skip");
  await view.click("Send feedback");
  expect(view.container.querySelector('[role="dialog"]')!.textContent).not.toContain(
    "Feedback sent",
  );
  expect(
    view.container.querySelector<HTMLSelectElement>('select[aria-label="Feedback"]')!.value,
  ).toBe("skip");
  await view.click("Send feedback");
  expect(view.feedback).toHaveBeenCalledTimes(2);
  expect(view.feedback.mock.calls[1]).toEqual(view.feedback.mock.calls[0]);
  expect(view.feedback.mock.calls[0]![1]).toEqual({ choice: "skip", reason: "" });
  expect(view.container.querySelector('[role="dialog"]')!.textContent).toContain("Feedback sent");
});

it("prevents duplicate submissions and keeps newer edits when the earlier feedback is accepted", async () => {
  let finish!: (accepted: boolean) => void;
  const view = await mounted();
  view.feedback.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await view.click("Evidence");
  await view.click("candidate-1");
  await view.click("Give feedback");
  await changeSelect(view.container, "Feedback", "not_fit");
  await changeFeedbackReason(view.container, "First reason");
  await view.click("Send feedback");
  await view.click("Sending…");
  expect(view.feedback).toHaveBeenCalledTimes(1);
  await changeFeedbackReason(view.container, "New reason");
  await act(async () => finish(true));
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]')!.value,
  ).toBe("New reason");
  expect(view.container.querySelector('[role="dialog"]')!.textContent).not.toContain(
    "Feedback sent",
  );
  await changeFeedbackReason(view.container, "First reason");
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[1]![2]).not.toBe(view.feedback.mock.calls[0]![2]);
});

it("retries the original candidate reference when saved profile fields refresh after an uncertain outcome", async () => {
  const candidate = { ...candidateFixture("stable-candidate", false), name: "Original candidate" };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  const view = await mounted();
  view.feedback.mockRejectedValueOnce(new Error("Outcome unknown"));
  await view.click("Evidence");
  await view.click(candidate.name);
  await view.click("Give feedback");
  await changeSelect(view.container, "Feedback", "good_example");
  await changeFeedbackReason(view.container, "Original reason");
  await view.click("Send feedback");
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidate, name: "Refreshed candidate" }]),
  );
  await view.render("thread-1", 1);
  await view.click("Send feedback");
  expect(view.feedback.mock.calls[1]).toEqual(view.feedback.mock.calls[0]);
});

it.each(["candidate", "role", "role version", "thread", "access denial"])(
  "discards feedback and late acceptance after changing %s",
  async (change) => {
    const first = { ...candidateFixture("first", false), name: "First candidate" };
    const second = { ...candidateFixture("second", false), name: "Second candidate" };
    api.listCandidates.mockImplementation(async () => {
      const workspace = await api.getWorkspace.mock.results.at(-1)?.value;
      return {
        ...candidatePage([first, second]),
        roleId: workspace.role.id,
        roleRevisionId: workspace.revision.id,
      };
    });
    const view = await mounted();
    let finish!: (accepted: boolean) => void;
    view.feedback.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await view.click("Evidence");
    await view.click(first.name);
    await view.click("Give feedback");
    await changeSelect(view.container, "Feedback", "not_fit");
    await changeFeedbackReason(view.container, "Private first draft");
    await view.click("Send feedback");
    if (change === "candidate") {
      await view.click("Close");
      await view.click(second.name);
    } else {
      if (change === "access denial")
        api.getWorkspace.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
      if (change === "role" || change === "role version") {
        const nextRole = change === "role" ? { ...role, id: "next-role" } : role;
        api.getWorkspace.mockResolvedValue({
          role: nextRole,
          revision: { ...revision, id: "next-revision", roleId: nextRole.id, revision: 3 },
        });
      }
      await view.render(change === "thread" ? "next-thread" : "thread-1", 1);
    }
    await act(async () => finish(true));
    expect(view.container.textContent).not.toContain("Private first draft");
    expect(view.container.querySelector('[role="dialog"]')?.textContent ?? "").not.toContain(
      "Feedback sent",
    );
    if (change === "candidate" || change === "role version") {
      await view.click("Give feedback");
      expect(
        view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]')!.value,
      ).toBe("");
      expect(
        view.container.querySelector<HTMLSelectElement>('select[aria-label="Feedback"]')!.value,
      ).toBe("");
    }
  },
);

it.each(["Cards", "Table"])(
  "opens candidate evidence from %s without moving the list and returns focus on Escape and Close",
  async (viewName) => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      ...candidateFixture(`person-${index}`, false),
      name: `Synthetic person ${index}`,
    }));
    api.listCandidates.mockResolvedValue(candidatePage(candidates));
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(viewName);
    await changeInput(view.container, "Search candidates", "Synthetic");
    await changeSelect(view.container, "Candidate sort", "recent");
    const list = view.container.querySelector(viewName === "Cards" ? "ul" : "table")!;
    const panel = view.container.querySelector<HTMLElement>('section[aria-label="Recruiting"]')!;
    panel.scrollTop = 480;
    const trigger = [...list.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === candidates[14]!.name,
    )!;
    trigger.focus();
    await view.click(candidates[14]!.name);
    let dialog = view.container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog!.getAttribute("aria-labelledby")!)?.textContent).toBe(
      candidates[14]!.name,
    );
    expect(dialog!.textContent).not.toContain("Unassessed");
    expect(dialog!.textContent).toContain("Saved candidate sources");
    expect(dialog!.textContent).not.toContain("Unknown");
    expect(view.container.querySelector(viewName === "Cards" ? "ul" : "table")).toBe(list);
    expect(panel.scrollTop).toBe(480);
    expect(
      view.container.querySelector<HTMLInputElement>('[aria-label="Search candidates"]')?.value,
    ).toBe("Synthetic");
    expect(api.getAssessment).not.toHaveBeenCalled();
    expect(api.listCandidateSources).toHaveBeenCalledTimes(1);
    const close = dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(close));
    await act(async () => {
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(view.container.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    await view.click(candidates[14]!.name);
    dialog = view.container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await view.click("Close");
    await vi.waitFor(() => expect(view.container.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(panel.scrollTop).toBe(480);
    expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  },
);

it("does not reopen candidate evidence or steal focus when closed reads and refreshes finish", async () => {
  let finish!: (value: typeof assessment) => void;
  api.getAssessment.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  const trigger = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "candidate-1",
  )!;
  trigger.focus();
  await view.click("candidate-1");
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("Loading…");
  await view.click("Close");
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  const panelClose = view.container.querySelector<HTMLButtonElement>('[aria-label="Close panel"]')!;
  panelClose.focus();
  await act(async () => finish(assessment));
  expect(document.activeElement).toBe(panelClose);
  await view.render("thread-1", 1);
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(panelClose);
  expect(view.container.textContent).not.toContain("Built a compiler");
});

it("updates an open candidate dialog across role revisions without refocusing and returns to its refreshed trigger", async () => {
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  const dialog = view.container.querySelector('[role="dialog"]')!;
  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
  await vi.waitFor(() => expect(document.activeElement).toBe(close));
  api.getWorkspace.mockResolvedValue({
    role: { ...role, currentRevisionId: "revision-3", revision: 3 },
    revision: { ...revision, id: "revision-3", revision: 3 },
  });
  await view.render("thread-1", 1);
  expect(view.container.querySelector('[role="dialog"]')).toBe(dialog);
  expect(document.activeElement).toBe(close);
  expect(dialog.textContent).toContain("Built a compiler");
  const trigger = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "candidate-1",
  )!;
  await view.click("Close");
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it.each(["Discuss candidate", "Message"])(
  "finishes closing before %s transfers focus to the native chat",
  async (action) => {
    const view = await mounted();
    const composer = document.createElement("textarea");
    view.container.append(composer);
    try {
      const callback = action === "Discuss candidate" ? view.discuss : view.reveal;
      const dialogAtHandoff = vi.fn();
      callback.mockImplementation(() => {
        dialogAtHandoff(view.container.querySelector('[role="dialog"]'));
        composer.focus();
      });
      await view.click("Evidence");
      await view.click("candidate-1");
      await view.click(action);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      expect(dialogAtHandoff).toHaveBeenCalledWith(null);
      expect(document.activeElement).toBe(composer);
    } finally {
      composer.remove();
    }
  },
);

it.each(["role change", "access denial", "thread change"])(
  "discards a pending native chat handoff when %s occurs during dialog close",
  async (change) => {
    const view = await mounted();
    await view.click("Evidence");
    await view.click("candidate-1");
    const dialog = view.container.querySelector('[role="dialog"]')!;
    let finishClose!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const getAnimations = vi.fn(() => [{ finished }]);
    Object.defineProperty(dialog, "getAnimations", { value: getAnimations });
    await view.click("Discuss candidate");
    await vi.waitFor(() => expect(getAnimations).toHaveBeenCalled());
    expect(view.discuss).not.toHaveBeenCalled();
    if (change === "access denial") {
      api.getWorkspace.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
    } else if (change === "role change") {
      const nextRole = { ...role, id: "role-next", currentRevisionId: "revision-next" };
      api.getWorkspace.mockResolvedValue({
        role: nextRole,
        revision: { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id },
      });
    }
    await view.render(change === "thread change" ? "thread-next" : "thread-1", 1);
    await act(async () => finishClose());
    expect(view.discuss).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  },
);

it("switches candidate evidence without publishing a delayed previous assessment", async () => {
  const second = {
    ...assessment,
    assessment: {
      ...assessment.assessment,
      candidateKey: "candidate-2",
      facts: [{ ...assessment.assessment.facts[0]!, statement: "Second candidate evidence" }],
    },
  };
  api.listAssessments.mockResolvedValue([assessment, second]);
  let finish!: (value: typeof assessment) => void;
  api.getAssessment.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  await view.click("Close");
  await view.click("candidate-2");
  await act(async () => finish(assessment));
  const dialog = view.container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Second candidate evidence");
  expect(dialog.textContent).not.toContain("Built a compiler");
  expect(api.listCandidateSources).toHaveBeenCalledTimes(2);
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it.each(["role change", "access denial"])(
  "dismisses candidate evidence after %s and never restores it on refresh",
  async (change) => {
    const view = await mounted();
    await view.click("Evidence");
    await view.click("candidate-1");
    expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Built a compiler",
    );
    if (change === "access denial") {
      api.getWorkspace.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
    } else {
      const nextRole = { ...role, id: "role-next", currentRevisionId: "revision-next" };
      api.getWorkspace.mockResolvedValue({
        role: nextRole,
        revision: { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id },
      });
    }
    await view.render("thread-1", 1);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.textContent).not.toContain("Built a compiler");
    await view.render("thread-1", 2);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  },
);

it("defaults to a table with authoritative score ordering and leaves unknown scores last", async () => {
  const people = (
    [
      ["highest", "Zoe", "95"],
      ["lower", "Avery", "72.5"],
      ["unknown", "Unknown score", null],
    ] as const
  ).map(([key, name, score]) => ({
    ...candidateFixture(key!, false),
    name,
    latestSource: {
      providerTaskId: "provider-task-1",
      taskId: "task-1",
      actionId: "action-1",
      roleRevisionId: revision.id,
      effectId: "source-1",
      rowIndex: 0,
      artifactRef: { artifactId: "source-artifact", sha256: "a".repeat(64) },
      requestCursor: null,
      outputId: null,
      observedAt: "2026-01-01T00:00:00Z",
      report: { fields: [{ label: "Match score", value: score, sourceUrls: [] }], sourceUrls: [] },
    },
  }));
  api.listCandidates.mockResolvedValue(candidatePage(people));
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    view: "results",
  });
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    { roleId: role.id, limit: 30, sort: "score" },
    { signal: expect.any(AbortSignal) },
  );
  expect(view.container.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Table");
  expect(
    [...view.container.querySelectorAll("tbody th button")].map((item) => item.textContent),
  ).toEqual(["Zoe", "Avery", "Unknown score"]);
  expect(view.container.querySelector("tbody tr:last-child")?.textContent).toContain("Unknown");
});

it.each([
  ["met", "Met", "text-success"],
  ["unknown", "Unknown", "text-warning"],
  ["unmet", "Unmet", "text-destructive"],
] as const)(
  "shows the saved %s evidence verdict in a distinct accessible status color",
  async (verdict, label, color) => {
    api.getAssessment.mockResolvedValue({
      ...assessment,
      assessment: {
        ...assessment.assessment,
        judgments: {
          ...assessment.assessment.judgments,
          hardGate: verdict,
          criteria: assessment.assessment.judgments.criteria.map((item) => ({ ...item, verdict })),
        },
      },
    });
    const view = await mounted();
    await view.click("Evidence");
    await view.click("candidate-1");
    const details = view.container.querySelector('[role="dialog"] [aria-label="candidate-1"]')!;
    const status = [...details.querySelectorAll("span")].find((item) => item.textContent === label);
    expect(status?.classList.contains(color)).toBe(true);
    expect(status?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(details.textContent).toContain("Built a compiler");
    expect(api.reviseRole).not.toHaveBeenCalled();
  },
);

it("shows saved unassessed profiles and authoritative totals in Cards and Table", async () => {
  api.listCandidates.mockResolvedValue(
    candidatePage([
      {
        ...candidateFixture("raw-person", false),
        name: "Synthetic Avery",
        title: "Systems engineer",
        company: "Example Tools",
        location: "Remote",
        linkedinUrl: "https://example.test/avery",
      },
    ]),
  );
  const view = await mounted();
  expect(view.container.textContent).toContain("19");
  expect(view.container.textContent).toContain("12");
  await view.click("Evidence");
  await view.click("Cards");
  expect(view.container.textContent).toContain("Synthetic Avery");
  expect(view.container.textContent).toContain("Example Tools");
  expect(view.container.textContent).toContain("Remote");
  expect(view.container.textContent).not.toContain("Unassessed");
  expect(view.container.querySelector("li")?.textContent).not.toContain("Unknown");
  expect(view.container.querySelector('a[href="https://example.test/avery"]')).not.toBeNull();
  await view.click("Table");
  expect(view.container.querySelector("tbody")?.textContent).toContain("Synthetic Avery");
  expect(view.container.querySelector("tbody")?.textContent).toContain("Systems engineer");
  expect(view.container.querySelector("tbody")?.textContent).toContain("Example Tools");
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it("omits unused internal assessment controls without applying stored diagnostic filters", async () => {
  api.listAssessments.mockResolvedValue([]);
  const first = { ...candidateFixture("first-person", false), name: "Synthetic first" };
  const second = { ...candidateFixture("second-person", false), name: "Synthetic second" };
  api.listCandidates.mockImplementation(async ({ cursor, assessmentState, verdict }) => ({
    ...candidatePage(assessmentState || verdict ? [] : [cursor ? second : first]),
    nextCursor: assessmentState || verdict || cursor ? null : "page-2",
    counts: { ...candidatePage().counts, candidates: 2, assessed: 0, unassessed: 2 },
  }));
  const diagnostic = await mounted();
  await diagnostic.click("Evidence");
  await diagnostic.click("Table");
  await changeSelect(diagnostic.container, "Internal assessment", "current");
  await changeSelect(diagnostic.container, "Internal verdict", "met");
  await changeSelect(diagnostic.container, "Candidate sort", "recent");
  await cleanup?.();
  api.listCandidates.mockClear();

  const view = await mounted("thread-1", undefined, false);
  expect(view.container.querySelector('select[aria-label="Internal assessment"]')).toBeNull();
  expect(view.container.querySelector('select[aria-label="Internal verdict"]')).toBeNull();
  expect(view.container.querySelector("thead")?.textContent).not.toContain("Internal assessment");
  expect(view.container.querySelector("tbody")?.textContent).toContain(first.name);
  expect(view.container.querySelector('select[aria-label="Candidate sort"]')).toHaveProperty(
    "value",
    "recent",
  );
  expect(api.listCandidates).toHaveBeenCalledExactlyOnceWith(
    {
      roleId: role.id,
      limit: 30,
      sort: "recent",
    },
    { signal: expect.any(AbortSignal) },
  );
  await view.click("Load more");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      roleId: role.id,
      limit: 30,
      sort: "recent",
      cursor: "page-2",
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(view.container.querySelector("tbody")?.textContent).toContain(second.name);
  await cleanup?.();
  api.listCandidates.mockClear();
  const reopened = await mounted("thread-1", undefined, false);
  expect(api.listCandidates).toHaveBeenCalledTimes(2);
  expect(api.listCandidates).toHaveBeenNthCalledWith(
    1,
    {
      roleId: role.id,
      limit: 30,
      sort: "recent",
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(api.listCandidates).toHaveBeenNthCalledWith(
    2,
    {
      roleId: role.id,
      limit: 30,
      sort: "recent",
      cursor: "page-2",
    },
    { signal: expect.any(AbortSignal) },
  );

  api.listAssessments.mockRejectedValueOnce(new Error("Assessment refresh failed"));
  await reopened.render("thread-1", 1);
  expect(reopened.container.textContent).toContain("Could not load recruiting");
  expect(reopened.container.querySelector('select[aria-label="Internal assessment"]')).toBeNull();
  expect(reopened.container.querySelector("tbody")?.textContent).toContain(second.name);

  await reopened.render("thread-1", 1, true);
  expect(
    reopened.container.querySelector('select[aria-label="Internal assessment"]'),
  ).toHaveProperty("value", "current");
  expect(reopened.container.querySelector('select[aria-label="Internal verdict"]')).toHaveProperty(
    "value",
    "met",
  );
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      roleId: role.id,
      limit: 30,
      assessmentState: "current",
      verdict: "met",
      sort: "recent",
    },
    { signal: expect.any(AbortSignal) },
  );
});

it.each([false, true])(
  "loads candidates while auxiliary reads hang and rechecks the thread binding (changed: %s)",
  async (changed) => {
    const pending = new Promise<never>(() => {});
    api.listAssessments.mockReturnValue(pending);
    api.listResearch.mockReturnValue(pending);
    api.listQuestions.mockReturnValue(pending);
    api.list.mockReturnValue(pending);
    const candidate = {
      ...candidateFixture("candidate-before-rebind", false),
      name: "Before rebind",
    };
    const next = {
      role: { ...role, id: "role-next", title: "Next role", currentRevisionId: "revision-next" },
      revision: { ...revision, id: "revision-next", roleId: "role-next" },
    };
    let finishVerification!: (value: {
      role: RecruitingRole;
      revision: RecruitingRoleRevision;
    }) => void;
    api.getWorkspace
      .mockResolvedValueOnce({ role, revision })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishVerification = resolve;
          }),
      )
      .mockResolvedValue(changed ? next : { role, revision });
    api.listCandidates.mockImplementation(async ({ roleId }: { roleId: string }) =>
      roleId === role.id
        ? candidatePage([candidate])
        : { ...candidatePage([]), roleId: next.role.id, roleRevisionId: next.revision.id },
    );
    const view = await mounted();
    expect(api.listCandidates).toHaveBeenCalled();
    expect(api.getWorkspace).toHaveBeenCalledTimes(2);
    await view.click("Evidence");
    expect(view.container.textContent).not.toContain(candidate.name);
    await act(async () => finishVerification(changed ? next : { role, revision }));
    if (changed) {
      expect(view.container.textContent).not.toContain(candidate.name);
      await view.click("Role");
      expect(view.container.textContent).toContain(next.role.title);
    } else {
      expect(view.container.textContent).toContain(candidate.name);
      await view.click("Memory");
      expect(view.container.textContent).toContain("Loading…");
      expect(view.container.textContent).not.toContain("No saved memory in these scopes");
      api.listCandidates.mockResolvedValue(
        candidatePage([{ ...candidate, name: "After refresh" }]),
      );
      await view.click("Refresh");
      await view.click("Evidence");
      expect(view.container.textContent).toContain("After refresh");
      expect(api.listCandidates).toHaveBeenCalledTimes(2);
    }
  },
);

it("keeps the candidate page when empty auxiliary assessments finish without changing filters", async () => {
  let finish!: (value: RecruitingAssessmentSnapshot[]) => void;
  api.listAssessments.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const candidate = { ...candidateFixture("saved-candidate", false), name: "Saved candidate" };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  expect(view.container.textContent).toContain(candidate.name);
  expect(api.listCandidates).toHaveBeenCalledExactlyOnceWith(
    {
      roleId: role.id,
      limit: 30,
      sort: "score",
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(view.container.querySelector('select[aria-label="Internal assessment"]')).toBeNull();
  expect(view.container.querySelector('select[aria-label="Internal verdict"]')).toBeNull();
  expect(view.container.textContent).not.toContain("Internal assessment");
  await act(async () => finish([]));
  expect(view.container.textContent).toContain(candidate.name);
  expect(api.listCandidates).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('select[aria-label="Internal assessment"]')).toBeNull();
  expect(view.container.querySelector('select[aria-label="Internal verdict"]')).toBeNull();
});

it("keeps a pending or failed assessment read distinct from an empty assessment list", async () => {
  let fail!: (error: Error) => void;
  api.listAssessments.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  api.listCandidates.mockResolvedValue(candidatePage());
  const view = await mounted("thread-1", undefined, false);
  await view.click("Missing info");
  expect(view.container.textContent).toContain("Loading…");
  expect(api.listCandidates).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("Assessment read failed")));
  expect(view.container.textContent).toContain("Could not load recruiting");
  expect(api.listCandidates).toHaveBeenCalledTimes(1);

  await view.render("thread-1", 1);
  await view.click("Evidence");
  expect(view.container.querySelector('select[aria-label="Internal assessment"]')).not.toBeNull();
  expect(view.container.querySelector('select[aria-label="Internal verdict"]')).not.toBeNull();
  await view.click("Table");
  expect(view.container.querySelector("thead")?.textContent).toContain("Internal assessment");
  expect(view.container.querySelector("tbody")?.textContent).toContain("Internal assessment");
});

it.each([
  { viewName: "Cards", identified: true },
  { viewName: "Table", identified: true },
  { viewName: "Cards", identified: false },
  { viewName: "Table", identified: false },
])(
  "discusses the selected persisted candidate from $viewName (identified: $identified)",
  async ({ viewName, identified }) => {
    const candidate = {
      ...candidateFixture("internal-candidate-key", false),
      name: identified ? "Synthetic Avery" : null,
      title: identified ? "Compiler engineer" : null,
      company: identified ? "Example Tools" : null,
      linkedinUrl: identified ? "https://example.test/avery" : null,
      resumeUrl: identified ? "https://example.test/resume.pdf" : null,
    };
    api.listCandidates.mockResolvedValue(candidatePage([candidate]));
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(viewName);
    expect(view.container.textContent).not.toContain("Discuss candidate");
    await view.click(candidate.name ?? "Unnamed candidate");
    if (identified)
      expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(
        `${candidate.title} · ${candidate.company}`,
      );
    await view.click("Discuss candidate");
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(view.discuss).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
      roleTitle: role.title,
      name: candidate.name,
      title: candidate.title,
      company: candidate.company,
      linkedinUrl: candidate.linkedinUrl,
      resumeUrl: candidate.resumeUrl,
    });
    expect(view.container.textContent).not.toContain(candidate.candidateKey);
    expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  },
);

it("shows CRM states in Cards and Table only when a target or import exists", async () => {
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.textContent).not.toContain("CRM");
  await view.click("Table");
  expect(
    [...view.container.querySelectorAll("th")].some((item) => item.textContent === "CRM"),
  ).toBe(false);
  const statuses = [
    "pending",
    "approved",
    "syncing",
    "synced",
    "unknown",
    "denied",
    "stopped",
  ] as const;
  api.listCandidates.mockResolvedValue({
    ...candidatePage([
      ...statuses.map((status) => ({ ...candidateFixture(status, false), crm: crmSync(status) })),
      candidateFixture("no-receipt", false),
    ]),
    crmTarget: { bindingEffectId: "crm-binding", target: crmTarget },
  });
  await view.click("Refresh");
  expect(view.container.textContent).toContain("Example Robotics · Geometry engineer");
  expect(
    [...view.container.querySelectorAll("th")].some((item) => item.textContent === "CRM"),
  ).toBe(true);
  for (const label of [
    "Pending approval",
    "Approved",
    "Syncing",
    "Synced",
    "Outcome unknown",
    "Denied",
    "Stopped",
    "Sync not confirmed",
  ]) {
    expect(view.container.querySelector("tbody")?.textContent).toContain(label);
  }
  await view.click("Cards");
  for (const label of [
    "Pending approval",
    "Approved",
    "Syncing",
    "Synced",
    "Outcome unknown",
    "Denied",
    "Stopped",
    "Sync not confirmed",
  ]) {
    expect(view.container.querySelector("ul")?.textContent).toContain(label);
  }
  await view.click("Dashboard");
  expect(
    view.container.querySelector('[aria-label="Saved candidate totals"]')?.textContent,
  ).not.toContain("CRM");
  expect(view.container.querySelector(`a[href*="${crmTarget.organizationId}"]`)).toBeNull();
});

it("shows only the selected candidate's verified CRM receipt and never infers success from a status", async () => {
  const synced = { ...candidateFixture("synced-person", false), crm: crmSync("synced") };
  api.listCandidates.mockResolvedValue(
    candidatePage([
      synced,
      { ...candidateFixture("unknown-person", false), crm: crmSync("unknown") },
      {
        ...candidateFixture("unverified-person", false),
        crm: { ...crmSync("synced"), receipt: null },
      },
    ]),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("synced-person");
  const receipt = await view.expand("CRM receipt");
  expect(receipt.textContent).toContain(synced.crm.receipt!.candidate_id);
  expect(receipt.textContent).toContain(synced.crm.receipt!.source_file);
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')?.textContent).toContain(
    "Example Robotics · Geometry engineer",
  );
  await view.click("unknown-person");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')?.textContent).toContain(
    "Outcome unknown",
  );
  expect(view.container.textContent).not.toContain(synced.crm.receipt!.candidate_id);
  await view.click("unverified-person");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')?.textContent).not.toContain(
    "Synced",
  );
  expect(
    [...view.container.querySelectorAll("summary")].some(
      (item) => item.textContent === "CRM receipt",
    ),
  ).toBe(false);
});

it("keeps a historical CRM receipt on its exact source with its original target after rebinding", async () => {
  const historical = {
    ...crmSync("synced"),
    target: { ...crmTarget, clientLabel: "Previous client", roleLabel: "Previous role" },
  };
  const f = rawResultsFixture();
  api.listCandidates.mockResolvedValue({
    ...candidatePage([candidateFixture("raw-person", false)]),
    crmTarget: {
      bindingEffectId: "new-binding",
      target: { ...crmTarget, clientLabel: "Current client" },
    },
  });
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: "raw-person",
    total: 1,
    nextCursor: null,
    items: [
      {
        providerTaskId: f.task.providerTaskId,
        taskId: f.task.id,
        actionId: f.action.id,
        roleRevisionId: "old-revision",
        effectId: historical.sourceEffectId,
        rowIndex: historical.rowIndex,
        artifactRef: f.reference,
        requestCursor: null,
        outputId: "output-1",
        observedAt: "2026-01-01T00:00:00Z",
        crmImports: [historical],
      },
    ],
  });
  const view = await mounted();
  await view.click("Evidence");
  await view.click("raw-person");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')?.textContent).toContain(
    "Sync not confirmed",
  );
  const details = await view.expand("Discovery details");
  expect(details.textContent).toContain("Previous client · Previous role");
  expect(details.textContent).not.toContain("Current client");
  expect(details.querySelector("details")?.textContent).toContain(
    historical.receipt!.membership_id,
  );
});

it("clears the selected CRM receipt when a new binding replaces a filtered-out candidate", async () => {
  const synced = { ...candidateFixture("synced-person", false), crm: crmSync("synced") };
  api.listCandidates.mockResolvedValue({
    ...candidatePage([synced]),
    crmTarget: { bindingEffectId: "crm-binding", target: crmTarget },
  });
  const view = await mounted();
  await view.click("Evidence");
  await view.click("synced-person");
  expect((await view.expand("CRM receipt")).textContent).toContain(
    synced.crm.receipt!.candidate_id,
  );
  api.listCandidates.mockResolvedValue({
    ...candidatePage([candidateFixture("another-person", false)]),
    crmTarget: {
      bindingEffectId: "new-binding",
      target: { ...crmTarget, clientLabel: "New client" },
    },
  });
  await changeInput(view.container, "Search candidates", "another");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')).toBeNull();
  expect(view.container.textContent).not.toContain(synced.crm.receipt!.candidate_id);
});

it("refreshes CRM source receipts without new discoveries and ignores a late older refresh", async () => {
  const f = rawResultsFixture();
  const pending = { ...crmSync("pending"), effectId: "crm-import" };
  const synced = { ...crmSync("synced"), effectId: pending.effectId };
  const sourcePage = {
    roleId: role.id,
    candidateKey: "raw-person",
    total: 1,
    nextCursor: null,
    items: [
      {
        taskId: f.task.id,
        actionId: f.action.id,
        roleRevisionId: revision.id,
        effectId: pending.sourceEffectId,
        providerTaskId: f.task.providerTaskId,
        rowIndex: pending.rowIndex,
        artifactRef: f.reference,
        requestCursor: null,
        outputId: "output-1",
        observedAt: "2026-01-01T00:00:00Z",
        crmImports: [pending],
      },
    ],
  };
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidateFixture("raw-person", false), crm: pending }]),
  );
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.listCandidateSources.mockResolvedValueOnce(sourcePage);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("raw-person");
  const details = await view.expand("Discovery details");
  expect(details.textContent).toContain("Pending approval");
  let finishOlder!: (value: unknown) => void;
  api.listCandidateSources.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOlder = resolve;
    }),
  );
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidateFixture("raw-person", false), crm: synced }]),
  );
  await view.click("Refresh");
  expect(api.listCandidateSources).toHaveBeenCalledTimes(2);
  expect(details.textContent).toContain("Pending approval");
  expect(details.textContent).not.toContain(synced.receipt!.candidate_id);
  api.listCandidateSources.mockResolvedValueOnce({
    ...sourcePage,
    items: [{ ...sourcePage.items[0]!, crmImports: [synced] }],
  });
  await view.click("Refresh");
  expect(api.listCandidateSources).toHaveBeenCalledTimes(3);
  expect(details.isConnected).toBe(true);
  expect(details.open).toBe(true);
  expect(details.textContent).toContain("Synced");
  expect(details.textContent).toContain(synced.receipt!.candidate_id);
  await act(async () => finishOlder(sourcePage));
  expect(details.textContent).toContain(synced.receipt!.membership_id);
  expect(details.textContent).not.toContain("Pending approval");
});

it("omits stale current CRM details for an excluded selection while refreshing its source history", async () => {
  const f = rawResultsFixture();
  const pending = { ...candidateFixture("pending-person", false), crm: crmSync("pending") };
  const synced = { ...pending, crm: { ...crmSync("synced"), effectId: pending.crm.effectId } };
  const target = { bindingEffectId: "crm-binding", target: crmTarget };
  const filtered = {
    ...candidatePage([candidateFixture("another-person", false)]),
    crmTarget: target,
  };
  api.listCandidates
    .mockResolvedValueOnce({ ...candidatePage([pending]), crmTarget: target })
    .mockResolvedValue(filtered);
  const sources = {
    roleId: role.id,
    candidateKey: pending.candidateKey,
    total: 1,
    nextCursor: null,
    items: [
      {
        taskId: f.task.id,
        actionId: f.action.id,
        roleRevisionId: revision.id,
        effectId: pending.crm.sourceEffectId,
        providerTaskId: f.task.providerTaskId,
        rowIndex: pending.crm.rowIndex,
        artifactRef: f.reference,
        requestCursor: null,
        outputId: "output-1",
        observedAt: "2026-01-01T00:00:00Z",
        crmImports: [pending.crm],
      },
    ],
  };
  let finishOlder!: (value: unknown) => void;
  const freshSources = { ...sources, items: [{ ...sources.items[0]!, crmImports: [synced.crm] }] };
  api.listCandidateSources
    .mockResolvedValueOnce(sources)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOlder = resolve;
      }),
    )
    .mockResolvedValue(freshSources);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  const view = await mounted();
  await view.click("Evidence");
  await view.click(pending.candidateKey);
  const details = await view.expand("Discovery details");
  await changeInput(view.container, "Search candidates", "another");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')).toBeNull();
  await view.click("Refresh");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')).toBeNull();
  expect(
    [...view.container.querySelectorAll('[data-slot="dialog-title"]')].some(
      (item) => item.textContent === pending.candidateKey,
    ),
  ).toBe(true);
  expect(details.isConnected && details.open).toBe(true);
  expect(details.textContent).toContain(synced.crm.receipt!.membership_id);
  await act(async () => finishOlder(sources));
  expect(details.textContent).not.toContain("Pending approval");
  expect(view.container.querySelector('[aria-label="Candidate CRM"]')).toBeNull();
  api.listCandidates.mockResolvedValue({ ...candidatePage([synced]), crmTarget: target });
  await changeInput(view.container, "Search candidates", "");
  const current = view.container.querySelector('[aria-label="Candidate CRM"]')!;
  expect(current.textContent).toContain(synced.crm.receipt!.candidate_id);
  expect(current.textContent).not.toContain("Pending approval");
  expect(api.listCandidates).not.toHaveBeenCalledWith(
    expect.objectContaining({ query: pending.candidateKey }),
    { signal: expect.any(AbortSignal) },
  );
});

it("reloads candidate pages when the CRM binding changes during pagination", async () => {
  const synced = { ...candidateFixture("synced-person", false), crm: crmSync("synced") };
  api.listCandidates
    .mockResolvedValueOnce({
      ...candidatePage([synced]),
      nextCursor: "next-page",
      crmTarget: { bindingEffectId: "crm-binding", target: crmTarget },
    })
    .mockResolvedValue({
      ...candidatePage([candidateFixture("new-person", false)]),
      crmTarget: {
        bindingEffectId: "new-binding",
        target: { ...crmTarget, clientLabel: "New client" },
      },
    });
  const view = await mounted();
  await view.click("Evidence");
  await view.click("synced-person");
  await view.expand("CRM receipt");
  await view.click("Load more");
  expect(api.listCandidates.mock.lastCall?.[0].cursor).toBeUndefined();
  expect(view.container.querySelector("tbody")?.textContent).not.toContain("synced-person");
  expect(view.container.textContent).not.toContain(synced.crm.receipt!.candidate_id);
});

it("reveals the selected recruiting tab horizontally on selection and restore without moving focus", async () => {
  const scrollBy = vi.fn();
  const priorScrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollBy");
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: scrollBy });
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (
        this.getAttribute("role") === "tablist" &&
        this.getAttribute("aria-label") === "Recruiting views"
      )
        return new DOMRect(0, 0, 320, 32);
      if (this.getAttribute("role") === "tab" && this.textContent === "Evidence")
        return new DOMRect(-24, 0, 80, 32);
      return originalBounds.call(this);
    });
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  try {
    const view = await mounted();
    await view.click("Evidence");
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -24 });
    expect(scrollBy.mock.contexts.at(-1)).toBe(
      view.container.querySelector('[role="tablist"][aria-label="Recruiting views"]'),
    );
    expect(document.activeElement).toBe(composer);

    await cleanup?.();
    scrollBy.mockClear();
    const reopened = await mounted();
    expect(
      reopened.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Evidence");
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -24 });
    expect(document.activeElement).toBe(composer);

    scrollBy.mockClear();
    const list = reopened.container.querySelector<HTMLElement>('[role="tablist"]')!;
    list.scrollLeft = 240;
    await reopened.render("thread-1", 1);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(list.scrollLeft).toBe(240);
  } finally {
    composer.remove();
    bounds.mockRestore();
    if (priorScrollBy) Object.defineProperty(HTMLElement.prototype, "scrollBy", priorScrollBy);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollBy");
  }
});

it("keeps an explicit Dashboard selection through delayed native hydration and preserves the saved list when changing tabs", async () => {
  const storageKey = `${rightPanelStorageKey("actor-1", role.spaceId, "group", "thread-1")}:recruiting:${role.id}`;
  const selected = {
    ...candidateFixture("selected-candidate", false),
    name: "Synthetic saved candidate",
  };
  const saved = {
    ...readRecruitingPanelState(null),
    tab: "role",
    candidateView: "table",
    filters: { sort: "recent", query: "Synthetic" },
    selectedCandidateKey: selected.candidateKey,
    detailOpen: true,
  };
  localStorage.setItem(storageKey, JSON.stringify(saved));
  api.listCandidates.mockResolvedValue(candidatePage([selected]));
  let finishWorkspace!: (value: { role: RecruitingRole; revision: RecruitingRoleRevision }) => void;
  api.getWorkspace.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWorkspace = resolve;
      }),
  );
  const onTabChange = vi.fn();
  const view = await mounted("thread-1", undefined, false, undefined, {
    tab: "dashboard",
    onTabChange,
  });
  await act(async () => {
    finishWorkspace({ role, revision });
  });
  expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Dashboard",
  );
  expect(onTabChange).toHaveBeenLastCalledWith("dashboard");
  const stored = readRecruitingPanelState(storageKey);
  expect(stored).toEqual({ ...saved, tab: "dashboard" });
  const dialog = view.container.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain(selected.name);
  const workspaceReads = api.getWorkspace.mock.calls.length;
  await view.render("thread-1", 0, false, undefined, { tab: "evidence", onTabChange });
  expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Evidence",
  );
  expect(readRecruitingPanelState(storageKey)).toEqual({ ...saved, tab: "evidence" });
  expect(view.container.querySelector('[role="dialog"]')).toBe(dialog);
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "Synthetic",
  );
  expect(api.getWorkspace.mock.calls.length).toBe(workspaceReads);
  expect(api.answer).not.toHaveBeenCalled();
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it("restores the recruiting list and selected candidate from fresh pages after closing and reopening", async () => {
  const first = { ...candidateFixture("first-person", false), name: "Synthetic first" };
  let second = { ...candidateFixture("second-person", false), name: "Synthetic second" };
  api.listCandidates.mockImplementation(async ({ cursor }) => ({
    ...candidatePage([cursor ? second : first]),
    nextCursor: cursor ? null : "page-2",
  }));
  api.listResearch.mockResolvedValue({ tasks: [], actions: [], observations: [savedObservation] });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click("Table");
  await changeInput(view.container, "Search candidates", "Synthetic");
  await changeSelect(view.container, "Internal assessment", "unassessed");
  await changeSelect(view.container, "Internal verdict", "unknown");
  await changeSelect(view.container, "Candidate sort", "recent");
  await changeSelect(view.container, "Research round", `source:${savedObservation.effectId}`);
  await act(async () => {
    [...view.container.querySelectorAll("label")]
      .find((label) => label.textContent === "Shortlisted only")!
      .click();
  });
  await view.click("Load more");
  await view.click(second.name);
  await cleanup?.();
  second = { ...second, name: "Synthetic refreshed second" };
  api.listCandidates.mockClear();
  const reopened = await mounted("thread-1", undefined, false);
  expect(reopened.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Evidence",
  );
  expect(reopened.container.querySelector("table")?.textContent).toContain(first.name);
  expect(reopened.container.querySelector("table")?.textContent).toContain(second.name);
  expect(reopened.container.querySelector('[role="dialog"]')?.textContent).toContain(second.name);
  expect(reopened.container.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "Synthetic second",
  );
  expect(api.listCandidates).toHaveBeenNthCalledWith(
    1,
    {
      roleId: role.id,
      limit: 30,
      query: "Synthetic",
      assessmentState: "unassessed",
      verdict: "unknown",
      sort: "recent",
      sourceEffectId: savedObservation.effectId,
      shortlisted: true,
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(api.listCandidates).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ cursor: "page-2" }),
    { signal: expect.any(AbortSignal) },
  );
  expect(reopened.container.querySelector('select[aria-label="Research round"]')).toHaveProperty(
    "value",
    `source:${savedObservation.effectId}`,
  );
  expect(reopened.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "Synthetic",
  );
  expect(
    [...Array(localStorage.length)]
      .map((_, index) => localStorage.getItem(localStorage.key(index)!))
      .join(""),
  ).not.toContain("Synthetic second");
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  expect(api.search).not.toHaveBeenCalled();
});

it("restores an excluded selected candidate through the existing saved-candidate read", async () => {
  const selected = { ...candidateFixture("chosen-person", false), name: "Synthetic chosen" };
  const other = { ...candidateFixture("other-person", false), name: "Synthetic other" };
  api.listCandidates.mockImplementation(async ({ query }) =>
    candidatePage(query === "Other" ? [other] : [selected]),
  );
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(selected.name);
  await changeInput(view.container, "Search candidates", "Other");
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(selected.name);
  await cleanup?.();
  const reopened = await mounted("thread-1", undefined, false);
  expect(reopened.container.querySelector("tbody")?.textContent).toContain(other.name);
  expect(reopened.container.querySelector("tbody")?.textContent).not.toContain(selected.name);
  expect(reopened.container.querySelector('[role="dialog"]')?.textContent).toContain(selected.name);
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      roleId: role.id,
      query: selected.candidateKey,
      limit: 30,
    },
    { signal: expect.any(AbortSignal) },
  );
});

it.each(["source", "action"])(
  "refreshes an excluded open candidate within the selected %s and closes an absent detail",
  async (kind) => {
    const f = rawResultsFixture("action-1");
    api.listResearch.mockResolvedValue({
      tasks: [f.task],
      actions: [f.action],
      observations: [savedObservation, { ...savedObservation, effectId: "absent-page" }],
    });
    const selected = { ...candidateFixture("chosen-person", false), name: "Current profile" };
    const historical = { ...selected, name: "Historical profile" };
    const other = { ...candidateFixture("other-person", false), name: "Other profile" };
    api.listCandidates.mockImplementation(async ({ query, sourceEffectId, actionId }) => {
      if (sourceEffectId === "absent-page") return candidatePage(query ? [] : [other]);
      if (sourceEffectId || actionId) return candidatePage(query ? [historical] : [other]);
      return candidatePage([selected]);
    });
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(selected.name);
    const scope =
      kind === "source" ? { sourceEffectId: savedObservation.effectId } : { actionId: f.action.id };
    await changeSelect(view.container, "Research round", `${kind}:${Object.values(scope)[0]}`);
    expect(api.listCandidates).toHaveBeenLastCalledWith(
      {
        roleId: role.id,
        limit: 30,
        query: selected.candidateKey,
        ...scope,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(historical.name);
    expect(view.container.querySelector('[role="dialog"]')?.textContent).not.toContain(
      selected.name,
    );
    await changeSelect(view.container, "Research round", "source:absent-page");
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  },
);

it("ignores an old-round selected-candidate response after the source changes", async () => {
  const selected = { ...candidateFixture("chosen-person", false), name: "Current profile" };
  const historical = { ...selected, name: "Historical profile" };
  const fresh = { ...selected, name: "Fresh profile" };
  const other = { ...candidateFixture("other-person", false), name: "Other profile" };
  api.listResearch.mockResolvedValue({
    tasks: [],
    actions: [],
    observations: [savedObservation, { ...savedObservation, effectId: "fresh-page" }],
  });
  let finish!: (page: ReturnType<typeof candidatePage>) => void;
  api.listCandidates.mockImplementation(({ query, sourceEffectId }) => {
    if (!sourceEffectId) return Promise.resolve(candidatePage([selected]));
    if (!query) return Promise.resolve(candidatePage([other]));
    if (sourceEffectId === "fresh-page") return Promise.resolve(candidatePage([fresh]));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(selected.name);
  await changeSelect(view.container, "Research round", `source:${savedObservation.effectId}`);
  expect(finish).toBeDefined();
  await changeSelect(view.container, "Research round", "source:fresh-page");
  await act(async () => finish(candidatePage([historical])));
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(fresh.name);
  expect(view.container.querySelector('[role="dialog"]')?.textContent).not.toContain(
    historical.name,
  );
});

it("ignores a late restored page after filters change and keeps the new depth on reopen", async () => {
  const first = { ...candidateFixture("first-person", false), name: "Synthetic first" };
  const second = { ...candidateFixture("second-person", false), name: "Synthetic second" };
  const fresh = { ...candidateFixture("fresh-person", false), name: "Synthetic fresh" };
  let hold = false;
  let finish!: (page: ReturnType<typeof candidatePage>) => void;
  api.listCandidates.mockImplementation(({ cursor, sort }) => {
    if (sort === "recent") return Promise.resolve(candidatePage([fresh]));
    if (cursor && hold)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve({
      ...candidatePage([cursor ? second : first]),
      nextCursor: cursor ? null : "page-2",
    });
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click("Load more");
  await cleanup?.();
  hold = true;
  const reopened = await mounted("thread-1", undefined, false);
  expect(finish).toBeDefined();
  expect(reopened.container.querySelector("tbody")?.textContent).toContain(first.name);
  expect(reopened.container.querySelector("tbody")?.textContent).not.toContain(second.name);
  expect(
    [...reopened.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more",
    ),
  ).toHaveProperty("disabled", true);
  await changeSelect(reopened.container, "Candidate sort", "recent");
  await act(async () => finish(candidatePage([second])));
  expect(reopened.container.querySelector("tbody")?.textContent).toContain(fresh.name);
  expect(reopened.container.textContent).not.toContain(second.name);
  await cleanup?.();
  api.listCandidates.mockClear();
  const again = await mounted("thread-1", undefined, false);
  expect(again.container.querySelector("tbody")?.textContent).toContain(fresh.name);
  expect(api.listCandidates).toHaveBeenCalledExactlyOnceWith(
    {
      roleId: role.id,
      limit: 30,
      sort: "recent",
    },
    { signal: expect.any(AbortSignal) },
  );
});

it("keeps the displayed page depth after a restored page fails and is loaded manually", async () => {
  const people = ["first", "second", "third"].map((name) => ({
    ...candidateFixture(`${name}-person`, false),
    name: `Synthetic ${name}`,
  }));
  let rejectNextPage = false;
  api.listCandidates.mockImplementation(({ cursor }) => {
    if (cursor && rejectNextPage) {
      rejectNextPage = false;
      return Promise.reject(new Error("Page unavailable"));
    }
    const index = cursor === "page-3" ? 2 : cursor === "page-2" ? 1 : 0;
    return Promise.resolve({
      ...candidatePage([people[index]!]),
      nextCursor: index < 2 ? `page-${index + 2}` : null,
    });
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click("Load more");
  await cleanup?.();
  rejectNextPage = true;
  const reopened = await mounted("thread-1", undefined, false);
  expect(reopened.container.textContent).toContain("Could not load candidates");
  expect(reopened.container.querySelector("tbody")?.textContent).toContain(people[0]!.name);
  await reopened.click("Load more");
  expect(reopened.container.querySelector("tbody")?.textContent).toContain(people[1]!.name);
  await cleanup?.();
  api.listCandidates.mockClear();
  const again = await mounted("thread-1", undefined, false);
  expect(again.container.querySelector("tbody")?.textContent).toContain(people[1]!.name);
  expect(again.container.textContent).not.toContain(people[2]!.name);
  expect(api.listCandidates).toHaveBeenCalledTimes(2);
});

it("isolates saved recruiting list preferences by actor, thread and actual role", async () => {
  const original = { role, revision };
  const other = {
    role: { ...role, id: "role-other", currentRevisionId: "revision-other" },
    revision: { ...revision, id: "revision-other", roleId: "role-other" },
  };
  const view = await mounted();
  await view.click("Evidence");
  await view.click("Cards");
  await changeInput(view.container, "Search candidates", "Original scope");
  await view.click("candidate-1");
  api.getWorkspace.mockResolvedValue(other);
  await view.render("thread-1", 1);
  await view.click("Evidence");
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "",
  );
  expect(view.container.querySelector("table")).toBeNull();
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  api.getWorkspace.mockResolvedValue(original);
  await view.render("thread-1", 2);
  expect(view.container.querySelector("table")).toBeNull();
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "Original scope",
  );
  await view.render("thread-other");
  await view.click("Evidence");
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "",
  );
  api.session.data.user.id = "actor-other";
  await view.render("thread-1");
  await view.click("Evidence");
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "",
  );
  expect(view.container.querySelector("table")).not.toBeNull();
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  api.session.data.user.id = "actor-1";
  await view.render("thread-1");
  expect(view.container.querySelector("table")).toBeNull();
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).toHaveProperty(
    "value",
    "Original scope",
  );
});

it.each([false, true])(
  "keeps candidate sort values with diagnostics=%s",
  async (showDiagnostics) => {
    const view = await mounted("thread-1", undefined, showDiagnostics);
    await view.click("Evidence");
    const select = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Candidate sort"]',
    )!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      showDiagnostics ? "Autumn rank" : "Rank",
      "Match tier",
      "Match score",
      "Name",
      "Recently discovered",
    ]);
    expect(select.value).toBe("score");
    await changeInput(view.container, "Search candidates", "Synthetic");
    for (const sort of ["tier", "rank", "score"]) {
      await changeSelect(view.container, "Candidate sort", sort);
      expect(api.listCandidates).toHaveBeenLastCalledWith(
        {
          roleId: role.id,
          limit: 30,
          query: "Synthetic",
          sort,
        },
        { signal: expect.any(AbortSignal) },
      );
    }
  },
);

it.each(["rank", "tier", "score"])(
  "normalizes a saved unavailable %s sort to Name from the authoritative scope signal",
  async (sort) => {
    api.listCandidates.mockResolvedValue({
      ...candidatePage(),
      sortAvailability: { rank: true, tier: true, score: true },
    });
    const saved = await mounted("thread-1", undefined, false);
    await saved.click("Evidence");
    await changeSelect(saved.container, "Candidate sort", sort);
    await cleanup?.();
    const person = { ...candidateFixture("unranked", false), name: "Synthetic Avery" };
    api.listCandidates.mockClear().mockResolvedValue({
      ...candidatePage([person]),
      sortAvailability: { rank: false, tier: false, score: false },
    });
    const view = await mounted("thread-1", undefined, false);
    const select = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Candidate sort"]',
    )!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Name",
      "Recently discovered",
    ]);
    expect(select.value).toBe("name");
    expect(api.listCandidates).toHaveBeenLastCalledWith(
      {
        roleId: role.id,
        limit: 30,
        sort: "name",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(view.container.textContent).toContain("Score / tier not returned");
    expect(view.container.textContent).toContain(person.name);
  },
);

it.each(["tier", "score"])(
  "ignores %s availability from a late previous search scope",
  async (sort) => {
    let finish!: (page: ReturnType<typeof candidatePage>) => void;
    api.listCandidates.mockImplementation(({ query }) =>
      query === "Previous"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(candidatePage()),
    );
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await changeSelect(view.container, "Candidate sort", sort);
    await changeInput(view.container, "Search candidates", "Previous");
    expect(view.container.querySelector('select[aria-label="Candidate sort"]')).toBeNull();
    await changeInput(view.container, "Search candidates", "Current");
    await act(async () =>
      finish({ ...candidatePage(), sortAvailability: { rank: false, tier: false, score: false } }),
    );
    expect(view.container.querySelector('select[aria-label="Candidate sort"]')).toHaveProperty(
      "value",
      sort,
    );
    expect(api.listCandidates).toHaveBeenLastCalledWith(
      {
        roleId: role.id,
        limit: 30,
        query: "Current",
        sort,
      },
      { signal: expect.any(AbortSignal) },
    );
  },
);

it("requests server pages and filters while keeping selected evidence outside the visible page", async () => {
  api.listCandidates
    .mockResolvedValueOnce({ ...candidatePage(), nextCursor: "page-2", total: 12 })
    .mockResolvedValue(candidatePage([candidateFixture("candidate-2", false)]));
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  expect(api.getAssessment).toHaveBeenCalledExactlyOnceWith({
    roleId: role.id,
    candidateKey: "candidate-1",
    version: 1,
  });
  expect(view.container.textContent).toContain("Original systems requirement");
  await view.click("Load more");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ roleId: role.id, cursor: "page-2" }),
    { signal: expect.any(AbortSignal) },
  );
  await changeInput(view.container, "Search candidates", "Synthetic");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: "Synthetic" }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.listCandidates.mock.lastCall?.[0].cursor).toBeUndefined();
  expect(view.container.textContent).toContain("Original systems requirement");
  await changeSelect(view.container, "Internal assessment", "unassessed");
  await changeSelect(view.container, "Candidate sort", "recent");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: "Synthetic", assessmentState: "unassessed", sort: "recent" }),
    { signal: expect.any(AbortSignal) },
  );
  expect(view.container.textContent).toContain("Built a compiler");
});

it("filters saved result pages alongside search updates and preserves the other candidate filters", async () => {
  const f = rawResultsFixture("action-1");
  const observations = [
    savedObservation,
    { ...savedObservation, effectId: "native-read-2", observedAt: "2026-10-16T01:00:00.000Z" },
  ];
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations });
  api.listCandidates.mockResolvedValue({ ...candidatePage(), nextCursor: "page-2" });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  const select = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Research round"]',
  )!;
  expect([...select.options].map((option) => option.textContent)).toEqual([
    "All rounds",
    "Search update 1",
    ...observations.map(
      (item) =>
        `Saved results · ${new Date(item.observedAt).toLocaleString(undefined, {
          timeZone: "America/Los_Angeles",
          timeZoneName: "short",
        })}`,
    ),
  ]);
  const savedOptions = [...select.options].filter((option) =>
    option.textContent?.startsWith("Saved results"),
  );
  expect(savedOptions).toHaveLength(2);
  expect(new Set(savedOptions.map((option) => option.value)).size).toBe(2);
  expect(savedOptions[0]!.textContent).toContain("PDT");
  for (const id of [savedObservation.effectId, savedObservation.providerTaskId, f.action.id])
    expect(select.textContent).not.toContain(id);

  await changeInput(view.container, "Search candidates", "Synthetic");
  await changeSelect(view.container, "Internal assessment", "unassessed");
  await changeSelect(view.container, "Internal verdict", "unknown");
  await changeSelect(view.container, "Candidate sort", "recent");
  const filters = {
    roleId: role.id,
    limit: 30,
    query: "Synthetic",
    assessmentState: "unassessed",
    verdict: "unknown",
    sort: "recent",
  };
  await changeSelect(view.container, "Research round", `action:${f.action.id}`);
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      ...filters,
      actionId: f.action.id,
      sourceEffectId: undefined,
    },
    { signal: expect.any(AbortSignal) },
  );
  await changeSelect(view.container, "Research round", savedOptions[0]!.value);
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      ...filters,
      actionId: undefined,
      sourceEffectId: savedObservation.effectId,
    },
    { signal: expect.any(AbortSignal) },
  );
  await view.click("Load more");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      ...filters,
      actionId: undefined,
      sourceEffectId: savedObservation.effectId,
      cursor: "page-2",
    },
    { signal: expect.any(AbortSignal) },
  );
  await changeSelect(view.container, "Research round", `action:${f.action.id}`);
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      ...filters,
      actionId: f.action.id,
      sourceEffectId: undefined,
    },
    { signal: expect.any(AbortSignal) },
  );
  await changeSelect(view.container, "Research round", savedOptions[1]!.value);
  await changeSelect(view.container, "Research round", "all");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      ...filters,
      actionId: undefined,
      sourceEffectId: undefined,
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(select.value).toBe("all");
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  expect(api.getById).not.toHaveBeenCalled();
});

it("ignores late saved-result pages while retaining the original candidate discussion context", async () => {
  const f = rawResultsFixture("source:native-read-1");
  api.listResearch.mockResolvedValue({
    tasks: [f.task],
    actions: [f.action],
    observations: [savedObservation],
  });
  const candidate = { ...candidateFixture(), name: "Synthetic Avery" };
  api.listCandidates.mockResolvedValue({ ...candidatePage([candidate]), nextCursor: "page-2" });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await changeSelect(view.container, "Research round", `source:${savedObservation.effectId}`);
  await view.click(candidate.name);
  let finish!: (value: unknown) => void;
  api.listCandidates.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await view.click("Load more");
  await changeSelect(view.container, "Research round", `action:${f.action.id}`);
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    {
      roleId: role.id,
      limit: 30,
      sort: "score",
      actionId: f.action.id,
      sourceEffectId: undefined,
    },
    { signal: expect.any(AbortSignal) },
  );
  await act(async () =>
    finish(candidatePage([{ ...candidateFixture("late-person", false), name: "Late candidate" }])),
  );
  expect(view.container.textContent).not.toContain("Late candidate");
  await view.click("Discuss candidate");
  expect(view.discuss).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleTitle: role.title,
    name: candidate.name,
    title: candidate.title,
    company: candidate.company,
    linkedinUrl: candidate.linkedinUrl,
    resumeUrl: candidate.resumeUrl,
  });
});

it("shows saved source rounds with their exact original revision and Artifact", async () => {
  const f = rawResultsFixture();
  api.listCandidates.mockResolvedValue(candidatePage([candidateFixture("raw-person", false)]));
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: "raw-person",
    total: 1,
    nextCursor: null,
    items: [
      {
        taskId: f.task.id,
        actionId: f.action.id,
        roleRevisionId: "old-revision",
        effectId: "read-effect",
        providerTaskId: f.task.providerTaskId,
        rowIndex: 0,
        crmImports: [],
        artifactRef: f.reference,
        requestCursor: "  real-cursor==  ",
        outputId: "output-1",
        observedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("raw-person");
  expect(api.getAssessment).not.toHaveBeenCalled();
  expect(api.listCandidateSources).toHaveBeenCalledWith(
    expect.objectContaining({ roleId: role.id, candidateKey: "raw-person" }),
  );
  const sources = view.container.querySelector('[aria-label="Saved candidate sources"]')!;
  expect(sources.textContent).toContain("old-revision");
  expect(sources.textContent).toContain("read-effect");
  expect(sources.textContent).toContain("output-1");
  expect(sources.textContent).toContain("provider_report");
  await view.expand("Source Artifact");
  expect(api.getById).toHaveBeenCalledWith({
    artifactId: f.reference.artifactId,
    includeDiagnostics: true,
  });
  expect(
    view.container.querySelector(`[data-artifact-id="${f.reference.artifactId}"]`),
  ).not.toBeNull();
});

it("shows a native candidate source Artifact without an empty custom-action heading", async () => {
  const f = rawResultsFixture();
  api.listCandidates.mockResolvedValue(candidatePage([candidateFixture("native-person", false)]));
  api.listResearch.mockResolvedValue({ tasks: [], actions: [], observations: [] });
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: "native-person",
    total: 1,
    nextCursor: null,
    items: [
      {
        providerTaskId: f.task.providerTaskId,
        taskId: null,
        actionId: null,
        roleRevisionId: revision.id,
        effectId: "native-read-effect",
        rowIndex: 0,
        crmImports: [],
        artifactRef: f.reference,
        requestCursor: null,
        outputId: null,
        observedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("native-person");
  const sources = view.container.querySelector('[aria-label="Saved candidate sources"]')!;
  expect(sources.querySelector("p")?.textContent).toBe("provider_report · 2026-01-01T00:00:00Z");
  expect(sources.textContent).toContain("native-read-effect");
  await view.expand("Source Artifact");
  expect(api.getById).toHaveBeenCalledWith({
    artifactId: f.reference.artifactId,
    includeDiagnostics: true,
  });
  expect(sources.querySelector(`[data-artifact-id="${f.reference.artifactId}"]`)).not.toBeNull();
});

it("persists shortlist with the candidate revision and leaves conflicts visibly unsaved", async () => {
  api.listCandidates.mockResolvedValue(candidatePage([candidateFixture("candidate-1", false)]));
  let finish!: (value: unknown) => void;
  api.setCandidateShortlist.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted("thread-1", undefined, true, undefined, {
    readCache: { entries: new Map(), epoch: 0 },
    readCacheScope: JSON.stringify(["actor-1", role.spaceId, "thread-1"]),
  });
  await view.click("Evidence");
  await view.click("Shortlist candidate-1");
  expect(api.setCandidateShortlist).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    candidateKey: "candidate-1",
    expectedRevision: 0,
    shortlisted: true,
  });
  expect(
    view.container
      .querySelector('[aria-label="Shortlist candidate-1"]')
      ?.getAttribute("aria-checked"),
  ).toBe("false");
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidateFixture("candidate-1", false), shortlisted: true, revision: 1 }]),
  );
  await act(async () =>
    finish({ roleId: role.id, candidateKey: "candidate-1", shortlisted: true, revision: 1 }),
  );
  expect(
    view.container
      .querySelector('[aria-label="Shortlist candidate-1"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  api.setCandidateShortlist.mockRejectedValueOnce(new ORPCError("CONFLICT"));
  await view.click("Shortlist candidate-1");
  expect(api.setCandidateShortlist).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedRevision: 1, shortlisted: false }),
  );
  expect(view.container.textContent).toContain("Could not save shortlist");
  expect(
    view.container
      .querySelector('[aria-label="Shortlist candidate-1"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
});

it("distinguishes candidate index failures from an empty result and clears denied cached data", async () => {
  api.listCandidates.mockRejectedValueOnce(new Error("offline"));
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("Could not load candidates");
  expect(view.container.textContent).not.toContain("No saved candidates");
  api.listCandidates.mockResolvedValue(candidatePage());
  await view.click("Refresh");
  expect(view.container.textContent).toContain("candidate-1");
  api.getAssessment.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
  await view.click("candidate-1");
  expect(view.container.textContent).not.toContain("candidate-1");
  expect(view.container.textContent).not.toContain(role.title);
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
});

it("renders Dashboard totals for the linked role and actual research delivery states", async () => {
  const view = await mounted();
  await view.click("Dashboard");
  expect(view.container.textContent).toContain(role.title);
  const totals = view.container.querySelector('dl[aria-label="Saved candidate totals"]')!;
  expect([...totals.querySelectorAll("dd")].map((item) => item.textContent)).toEqual([
    "19",
    "12",
    "10",
    "2",
  ]);
  expect(view.container.textContent).toContain("task-1 · active");
  expect(view.container.textContent).toContain("create · accepted · running");
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it("keeps recruiting diagnostics out of product views while opening verified evidence", async () => {
  const material = artifactSourceFixture();
  const botMemory = {
    id: "internal-memory-document",
    scope: "bot",
    botId: "internal-memory-bot",
    path: "preferences.md",
    content: "Remote teams",
    revision: 3,
    updatedAt: "2026-01-01",
  };
  api.list.mockImplementation(async ({ scope }: { scope: string }) =>
    scope === "bot" ? [botMemory] : [],
  );
  api.readSource.mockResolvedValue({
    kind: "text",
    text: "Before\nBuilt a compiler\nAfter",
    start: 7,
    end: 23,
  });
  api.listResearch.mockResolvedValue({
    tasks: [
      {
        id: "internal-search-task",
        roleId: role.id,
        state: "active",
        providerTaskId: "provider-task-secret",
      },
    ],
    actions: [],
    observations: [
      {
        effectId: "internal-effect",
        providerTaskId: "provider-task-secret",
        roleRevisionId: "internal-role-revision",
        runId: "internal-run",
        rowCount: 15,
        observedAt: "2026-10-16T00:00:00.000Z",
        requestCursor: "opaque-cursor",
        artifactRef: material.reference,
      },
    ],
  });
  api.getById.mockResolvedValue(material.artifact);
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, sourceRefs: [material.source] },
  });
  const view = await mounted("thread-1", botMemory.botId, false);
  for (const tab of ["Dashboard", "Activity"]) {
    await view.click(tab);
    for (const diagnostic of [
      "internal-search-task",
      "provider-task-secret",
      "internal-effect",
      "internal-role-revision",
      "internal-run",
      "opaque-cursor",
      "SHA-256",
    ])
      expect(view.container.textContent).not.toContain(diagnostic);
  }
  const savedResearch = await api.listResearch.mock.results[0]!.value;
  api.listResearch.mockResolvedValue({ ...savedResearch, tasks: [] });
  await view.click("Refresh");
  expect(view.container.textContent).toContain("Results saved");
  expect(view.container.textContent).not.toContain("No research tasks");
  await view.click("Role");
  expect(api.getById).not.toHaveBeenCalled();
  const evidence = await view.expand("Source", true);
  await vi.waitFor(() =>
    expect(evidence.querySelector("mark")?.textContent).toBe(material.source.quote),
  );
  expect(api.readSource).toHaveBeenCalledExactlyOnceWith({
    kind: "role",
    threadId: "thread-1",
    roleRevisionId: revision.id,
    sourceRefId: material.source.id,
  });
  expect(api.getById).not.toHaveBeenCalled();
  expect(evidence.querySelector("[data-artifact-id]")).toBeNull();
  expect(evidence.querySelector('[role="document"]')?.textContent).toBe(
    "Before\nBuilt a compiler\nAfter",
  );
  expect(evidence.textContent).not.toContain(material.reference.artifactId);
  expect(evidence.textContent).not.toContain(material.reference.sha256);
  expect(evidence.textContent).not.toContain("SHA-256");
  await view.click("Memory");
  const memory = await view.expand(botMemory.path);
  await view.click("History");
  expect(memory.textContent).toContain(botMemory.content);
  expect(memory.textContent).toContain("Earlier preference");
  for (const diagnostic of [botMemory.botId, "thread-1", "run-1"])
    expect(memory.textContent).not.toContain(diagnostic);
  await view.render("thread-1", 0, true);
  for (const diagnostic of [botMemory.botId, "thread-1", "run-1"])
    expect(memory.textContent).toContain(diagnostic);
});

it("reads candidate evidence through its saved assessment version without fetching raw files", async () => {
  const material = artifactSourceFixture();
  api.listAssessments.mockResolvedValue([
    { ...assessment, assessment: { ...assessment.assessment, sourceRefs: [material.source] } },
  ]);
  api.readSource.mockResolvedValue({
    kind: "text",
    text: "Before\nBuilt a compiler\nAfter",
    start: 7,
    end: 23,
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click("Unnamed candidate");
  expect(view.container.querySelector("blockquote")).toBeNull();
  expect(api.readSource).not.toHaveBeenCalled();
  const evidence = await view.expand("Source", true);
  await vi.waitFor(() =>
    expect(evidence.querySelector("mark")?.textContent).toBe(material.source.quote),
  );
  expect(api.readSource).toHaveBeenCalledWith({
    kind: "assessment",
    roleId: assessment.assessment.roleId,
    candidateKey: assessment.assessment.candidateKey,
    version: assessment.assessment.version,
    sourceRefId: material.source.id,
  });
  expect(api.getById).not.toHaveBeenCalled();
  expect(evidence.querySelector("[data-artifact-id]")).toBeNull();
});

it("does not fall back to raw file access when a product source cannot be verified", async () => {
  const material = artifactSourceFixture();
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, sourceRefs: [material.source] },
  });
  api.readSource.mockRejectedValue(new Error("Source changed"));
  const view = await mounted("thread-1", undefined, false);
  await view.click("Role");
  const evidence = await view.expand("Source", true);
  await vi.waitFor(() =>
    expect(evidence.querySelector('[role="alert"]')?.textContent).toBe("Source unavailable"),
  );
  expect(api.getById).not.toHaveBeenCalled();
  expect(evidence.querySelector("[data-artifact-id]")).toBeNull();
});

it("keeps current findings ahead of collapsed feedback and source-specific evidence in the profile drawer", async () => {
  const candidate = {
    ...candidateFixture("profile-overview", false),
    name: "Profile Example",
    title: "Software engineer",
    company: "Example company",
    location: "Example city",
    linkedinUrl: "https://www.linkedin.com/in/profile-example",
    latestSource: {
      ...savedObservation,
      taskId: null,
      actionId: null,
      rowIndex: 0,
      outputId: null,
      report: {
        fields: [{ label: "Score", value: "4/6", sourceUrls: [] }],
        sourceUrls: [],
      },
    },
  };
  const quote = "Keep this exact earlier feedback. ".repeat(30);
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  api.listFeedback.mockResolvedValue({
    feedback: [
      {
        id: "earlier-feedback",
        createdAt: "2026-01-01T00:00:00Z",
        roleRevisionId: "revision-1",
        choice: "not_fit",
        feedback: {
          target: "candidate",
          expectedRoleRevision: 1,
          candidateKeys: [candidate.candidateKey],
        },
        source: { quote },
      },
    ],
    nextCursor: null,
  });
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    total: 1,
    nextCursor: null,
    items: [
      {
        ...candidate.latestSource,
        roleRevisionId: "revision-1",
        crmImports: [],
        report: {
          fields: [
            {
              label: "Biography",
              value: "Original long provider profile. ".repeat(30),
              sourceUrls: [],
            },
            {
              label: "Geometry",
              value: "miss",
              providerStatus: "miss",
              evidence: "Exact saved project evidence.",
              reasoning: "Original provider explanation.",
              sourceUrls: ["https://example.test/evidence"],
            },
          ],
          sourceUrls: ["https://example.test/evidence"],
        },
      },
    ],
  });
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    tab: "evidence",
  });
  await view.click("Table");
  await view.click(candidate.name);
  const dialog = view.container.querySelector('[role="dialog"]')!;
  const match = dialog.querySelector('[aria-label="Research match"]')!;
  const history = [...dialog.querySelectorAll("details")].find(
    (item) => item.querySelector(":scope > summary")?.textContent === "Feedback history",
  );
  expect(history).toBeDefined();
  expect(match.compareDocumentPosition(history!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(history!.open).toBe(false);
  expect(match.textContent).toContain("Score4/6");
  expect(match.textContent).not.toContain("Geometry");
  expect(dialog.textContent).toContain(candidate.location);
  const sources = dialog.querySelector('[aria-label="Saved candidate sources"]')!;
  const findings = [...sources.querySelectorAll("details")].filter((item) =>
    item.querySelector(":scope > summary")?.textContent?.includes("Geometry"),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]!.open).toBe(false);
  expect(findings[0]!.querySelector("summary")?.textContent).toContain("Does not match");
  expect(findings[0]!.textContent).toContain("Exact saved project evidence.");
  expect(sources.textContent).toContain("Saved before latest role update");
  await act(async () => {
    history!.open = true;
    findings[0]!.open = true;
  });
  expect(history!.textContent).toContain(quote);
  expect(findings[0]!.querySelector('a[href="https://example.test/evidence"]')).not.toBeNull();
  expect(view.feedback).not.toHaveBeenCalled();
  expect(api.getById).not.toHaveBeenCalled();
});

it("shows exact Autumn rule states from the latest report before source history loads without classifying prose", async () => {
  const candidate = {
    ...candidateFixture("provider-status", false),
    name: "Provider-status person",
  };
  const report = {
    fields: [
      ...(["match", "miss", "unclear"] as const).map((value, index) => ({
        label: `Requirement ${index + 1}`,
        value,
        providerStatus: value,
        evidence: "Saved evidence.",
        reasoning: "Original reasoning.",
        sourceUrls: [],
      })),
      {
        label: "Fit reasons",
        value: "MET here and PARTIAL there remain plain provider prose.",
        sourceUrls: [],
      },
    ],
    sourceUrls: [],
  };
  const saved = {
    taskId: null,
    actionId: null,
    providerTaskId: "provider-task",
    roleRevisionId: revision.id,
    effectId: "provider-read",
    rowIndex: 0,
    artifactRef: { artifactId: "provider-artifact", sha256: "a".repeat(64) },
    requestCursor: null,
    outputId: null,
    observedAt: "2026-01-01T00:00:00Z",
    report,
  };
  candidate.latestSource = saved;
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  let resolveSources!: (value: Awaited<ReturnType<typeof api.listCandidateSources>>) => void;
  api.listCandidateSources.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSources = resolve;
      }),
  );
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(candidate.name);
  const summary = view.container.querySelector('[role="dialog"] [aria-label="Research match"]')!;
  const labels = ["Match", "Does not match", "Unclear"];
  const states = [...summary.querySelectorAll("span")].filter((node) =>
    labels.includes(node.textContent ?? ""),
  );
  expect(states.map((node) => node.textContent)).toEqual(labels);
  expect(summary.textContent).not.toContain("Autumn finding:");
  expect(states.map((node) => node.className)).toEqual([
    expect.stringContaining("text-success"),
    expect.stringContaining("text-destructive"),
    expect.stringContaining("text-warning"),
  ]);
  expect(summary.textContent).toContain(report.fields[3]!.value);
  await act(async () =>
    resolveSources({
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      total: 1,
      nextCursor: null,
      items: [{ ...saved, crmImports: [] }],
    }),
  );
  const history = view.container.querySelector('[aria-label="Saved candidate sources"]')!;
  expect(
    [...history.querySelectorAll("span")].filter((node) => labels.includes(node.textContent ?? "")),
  ).toHaveLength(3);
  expect(api.getById).not.toHaveBeenCalled();
});

it("shows unnamed candidates and real profile links without exposing their storage keys", async () => {
  const candidate = {
    ...candidateFixture("internal-candidate-key", false),
    name: null,
    linkedinUrl: "https://www.linkedin.com/in/example-profile",
  };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    total: 1,
    nextCursor: null,
    items: [
      {
        providerTaskId: "provider-task",
        taskId: null,
        actionId: null,
        roleRevisionId: revision.id,
        effectId: "internal-source-effect",
        rowIndex: 0,
        artifactRef: { artifactId: "internal-native-snapshot", sha256: "a".repeat(64) },
        requestCursor: null,
        outputId: null,
        observedAt: "2026-01-01T00:00:00Z",
        crmImports: [],
      },
    ],
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  expect(
    [...view.container.querySelectorAll("p")].some((item) => item.textContent === "1 candidate"),
  ).toBe(true);
  await view.click("Unnamed candidate");
  expect(view.container.querySelector(`a[href="${candidate.linkedinUrl}"]`)).not.toBeNull();
  expect(view.container.textContent).toContain("Research findings");
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(
    "Source unavailable",
  );
  expect(view.container.querySelector('[role="dialog"] pre')).toBeNull();
  for (const key of [
    candidate.candidateKey,
    "internal-source-effect",
    "internal-native-snapshot",
    "provider_report",
    "missing_name",
    "Discovery details",
    "Raw search results",
  ])
    expect(view.container.textContent).not.toContain(key);
  expect(api.listCandidateSources).toHaveBeenCalledWith(
    expect.objectContaining({ candidateKey: candidate.candidateKey }),
  );
  expect(api.getById).not.toHaveBeenCalled();
});

it("uses business gate labels only in explicit match-summary expressions while preserving diagnostics and sources", async () => {
  const candidate = {
    ...candidateFixture("summary-candidate", false),
    name: "G2 Researcher",
    company: "G2",
  };
  const source = {
    taskId: "summary-task",
    actionId: "summary-action",
    roleRevisionId: revision.id,
    effectId: "summary-effect",
    providerTaskId: "summary-provider-task",
    rowIndex: 0,
    artifactRef: { artifactId: "summary-artifact", sha256: "a".repeat(64) },
    requestCursor: null,
    outputId: "summary-output",
    observedAt: "2026-01-01T00:00:00Z",
    crmImports: [],
    report: {
      fields: [
        {
          label: "Recommendation",
          value:
            "not qualification, not G2; G2 approval pending. Managed G2 approval workflows at G2. https://example.test/G2 approval guide",
          evidence: "Original quote: not qualification, not G2.",
          sourceUrls: ["https://example.test/G2"],
        },
        {
          label: "Match judgment",
          value: "gate G0 is pending; playbook gate G1 is pending. requires G2. G2 is a product.",
          sourceUrls: [],
        },
        {
          label: "Fit reasons",
          value: "gate G3 is pending; gate G4 is pending. Studied G2 signals.",
          sourceUrls: [],
        },
        { label: "Rank", value: "2", sourceUrls: [] },
        { label: "Score", value: "5/6", sourceUrls: [] },
      ],
      sourceUrls: ["https://example.test/G2"],
    },
  };
  candidate.latestSource = source;
  const original = JSON.stringify(source);
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    total: 1,
    nextCursor: null,
    items: [source],
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  for (const layout of ["Cards", "Table"]) {
    await view.click(layout);
    const summary = view.container.querySelector('[aria-label="Research match"]')!;
    expect(summary.textContent).toContain("not qualification, not Review of the ten candidates");
    expect(summary.textContent).toContain("G2 approval pending");
    expect(summary.textContent).toContain("Managed G2 approval workflows at G2.");
    expect(summary.textContent).toContain("gate Recruiting brief");
    expect(summary.textContent).toContain("playbook gate Job description and company materials");
    expect(summary.textContent).toContain("requires G2.");
    expect(summary.textContent).toContain("G2 is a product");
    expect(summary.textContent).toContain("https://example.test/G2 approval guide");
    expect(summary.textContent).toContain("Rank2");
    expect(summary.textContent).toContain("Score5/6");
  }
  await view.click(candidate.name);
  const summary = view.container.querySelector('[role="dialog"] [aria-label="Research match"]')!;
  expect(summary.textContent).toContain("gate Campaign and lead list");
  expect(summary.textContent).toContain("gate Individual message or scheduling action");
  expect(summary.textContent).toContain("Studied G2 signals");
  const sources = view.container.querySelector('[aria-label="Saved candidate sources"]')!;
  for (const field of source.report.fields) expect(sources.textContent).toContain(field.value);
  expect(sources.textContent).toContain(source.report.fields[0]!.evidence);
  expect(sources.querySelector('a[href="https://example.test/G2"]')).not.toBeNull();
  await view.render("thread-1", 0, true);
  const diagnostics = view.container.querySelector(
    '[role="dialog"] [aria-label="Research match"]',
  )!;
  for (const field of source.report.fields) expect(diagnostics.textContent).toContain(field.value);
  expect(JSON.stringify(source)).toBe(original);
});

it.each([
  ["not_checked", "Not checked"],
  ["inaccessible", "Could not access"],
  ["available", "Available"],
  ["missing", "Missing"],
  ["unknown", "Unknown"],
  [
    "Candidate supplied a CV through the recruiter",
    "Candidate supplied a CV through the recruiter",
  ],
])("shows readable resume status %s while preserving provider evidence", async (status, label) => {
  const candidate = {
    ...candidateFixture("resume-person", false),
    name: "Resume Example",
    resumeUrl: status === "available" ? "https://example.test/resume.pdf" : null,
    latestSource: {
      ...savedObservation,
      taskId: null,
      actionId: null,
      rowIndex: 0,
      outputId: null,
      report: {
        fields: [{ label: "Resume status", value: status, sourceUrls: [] }],
        sourceUrls: [],
      },
    },
  };
  const original = JSON.stringify(candidate);
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    total: 1,
    nextCursor: null,
    items: [{ ...candidate.latestSource, crmImports: [] }],
  });
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    tab: "evidence",
  });
  await view.click("Cards");
  const card = view.container.querySelector(".hire-candidate-card")!;
  expect(card.textContent).toContain(
    status === "available" ? `Resume (${label})` : `Resume: ${label}`,
  );
  await view.click("View Resume Example");
  const dialog = view.container.querySelector('[role="dialog"]')!;
  const sources = dialog.querySelector('[aria-label="Saved candidate sources"]')!;
  expect(sources.textContent).toContain(label);
  if (status !== label) expect(dialog.textContent).not.toContain(`Resume: ${status}`);
  await view.render("thread-1", 0, true);
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(status);
  expect(JSON.stringify(candidate)).toBe(original);
});

it.each(["Cards", "Table"])(
  "shows provider match directly in %s while preserving retained reports and gaps",
  async (viewName) => {
    async function toggleDescription(parent: Element, label: string, value: string) {
      const trigger = parent.querySelector<HTMLElement>(`summary[aria-label="${label}: Details"]`);
      expect(trigger).not.toBeNull();
      const disclosure = trigger!.parentElement as HTMLDetailsElement;
      expect(disclosure.open).toBe(false);
      const fullText = disclosure.querySelector(":scope > p")!;
      expect(fullText.textContent).toBe(value);
      expect(fullText.closest(".line-clamp-2")).toBeNull();
      await act(async () => trigger!.click());
      expect(disclosure.open).toBe(true);
      await act(async () => trigger!.click());
      expect(disclosure.open).toBe(false);
    }
    const fitReasons = "  Built the requested systems.\nRelevant project evidence.  ".repeat(80);
    const matchJudgment =
      "  Unresolved lead: employment scope is unconfirmed.\nReview the gap.  ".repeat(80);
    const recommendation = "Review the supplied evidence and unresolved employment scope. ".repeat(
      20,
    );
    const candidate = { ...candidateFixture("internal-person", false), name: "Synthetic Engineer" };
    api.listCandidates.mockResolvedValue(candidatePage([candidate]));
    const source = {
      taskId: "internal-task",
      actionId: "internal-action",
      roleRevisionId: revision.id,
      effectId: "internal-effect",
      providerTaskId: "internal-provider-task",
      rowIndex: 4,
      artifactRef: { artifactId: "internal-artifact", sha256: "a".repeat(64) },
      requestCursor: null,
      outputId: "internal-output",
      observedAt: "2026-01-01T00:00:00Z",
      crmImports: [crmSync("synced")],
      report: {
        fields: [
          {
            label: "Geometry work",
            value: "  Built a mesh compiler.\nMaintained geometry tools.  ",
            evidence: "Provider cites a project description.",
            reasoning: "Provider reports relevant geometry work; dates are unconfirmed.",
            sourceUrls: ["https://projects.example.test/mesh"],
          },
          {
            label: "Full-time years",
            value: null,
            evidence: "Employment dates were not supplied.",
            sourceUrls: [],
          },
          { label: "Provider tier", value: "Tier 1", sourceUrls: [] },
          { label: "Provider rule", value: "true", sourceUrls: [] },
          { label: "Resume status", value: "inaccessible", sourceUrls: [] },
          {
            label: "Fit reasons",
            value: fitReasons,
            sourceUrls: [],
          },
        ],
        sourceUrls: ["https://projects.example.test/mesh", "https://profile.example.test/engineer"],
      },
    };
    api.listCandidateSources.mockResolvedValue({
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      total: 2,
      nextCursor: null,
      items: [
        source,
        {
          ...source,
          effectId: "earlier-effect",
          artifactRef: { artifactId: "earlier-artifact", sha256: "b".repeat(64) },
          observedAt: "2025-12-31T00:00:00Z",
          report: {
            fields: [{ label: "Grade", value: "Earlier round grade", sourceUrls: [] }],
            sourceUrls: [],
          },
        },
      ],
    });
    source.report.fields.push(
      { label: "Match score", value: "0", sourceUrls: [] },
      { label: "Match tier", value: "Provider possible", sourceUrls: [] },
    );
    candidate.latestSource = source;
    const retainedSource = JSON.stringify(source);
    const noMatch = {
      ...candidateFixture("missing", false),
      name: "Provider graded match",
      latestSource: {
        ...source,
        report: {
          fields: [
            { label: "Grade", value: "Provider strong", sourceUrls: [] },
            { label: "Rank", value: "3", sourceUrls: [] },
            { label: "Overall rank", value: "3", sourceUrls: [] },
            { label: "Original pool rank", value: "12", sourceUrls: [] },
            { label: "Recommendation", value: "Review this profile", sourceUrls: [] },
            {
              label: "Fit reasons",
              value: "  Built the requested systems.\nRelevant project evidence.  ",
              sourceUrls: [],
            },
          ],
          sourceUrls: [],
        },
      },
    };
    const unknown = {
      ...candidateFixture("unknown", false),
      name: "Unknown match",
      latestSource: {
        ...source,
        report: {
          fields: [
            { label: "Match score", value: null, sourceUrls: [] },
            { label: "Score", value: null, sourceUrls: [] },
            { label: "Match judgment", value: null, sourceUrls: [] },
            { label: "Original pool rank", value: null, sourceUrls: [] },
          ],
          sourceUrls: [],
        },
      },
    };
    const unavailable = {
      ...candidateFixture("unavailable", false),
      name: "Unavailable report",
      latestSource: { ...source, report: undefined },
    };
    const nativeScore = {
      ...candidateFixture("native-score", false),
      name: "Synthetic unresolved lead",
      latestSource: {
        ...source,
        report: {
          fields: [
            { label: "Score", value: "5/6", sourceUrls: [] },
            { label: "Match judgment", value: matchJudgment, sourceUrls: [] },
            { label: "Recommendation", value: recommendation, sourceUrls: [] },
          ],
          sourceUrls: [],
        },
      },
    };
    api.listCandidates.mockResolvedValue(
      candidatePage([candidate, noMatch, unknown, unavailable, nativeScore]),
    );
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(viewName);
    const list = view.container.querySelector(viewName === "Cards" ? "ul" : "tbody")!;
    const matches = [...list.querySelectorAll('[aria-label="Research match"]')];
    expect(matches).toHaveLength(5);
    expect(matches[0]?.textContent).toContain("Match score0");
    expect(matches[0]?.textContent).toContain("Match tierProvider possible");
    expect([...matches[0]!.querySelectorAll("dd dt")].map((item) => item.textContent)).toEqual([
      "Match score",
      "Match tier",
      ...(viewName === "Cards" ? ["Fit reasons"] : []),
    ]);
    if (viewName === "Cards") expect(matches[0]?.textContent).toContain(fitReasons);
    else expect(matches[0]?.textContent).not.toContain(fitReasons);
    expect([...matches[1]!.querySelectorAll("dd dd")].map((item) => item.textContent)).toEqual([
      "Provider strong",
      "3",
      "3",
      "12",
      "Review this profile",
      ...(viewName === "Cards"
        ? ["  Built the requested systems.\nRelevant project evidence.  "]
        : []),
    ]);
    expect([...matches[1]!.querySelectorAll("dd dt")].map((item) => item.textContent)).toEqual([
      "Grade",
      "Rank",
      "Overall rank",
      "Original pool rank",
      "Recommendation",
      ...(viewName === "Cards" ? ["Fit reasons"] : []),
    ]);
    expect(matches[1]?.textContent).not.toContain("Score / tier not returned");
    if (viewName === "Table") {
      const recommendation = [...matches[1]!.querySelectorAll("dt")].find(
        (field) => field.textContent === "Recommendation",
      )!.nextElementSibling!;
      expect(
        recommendation.matches(".line-clamp-2") ||
          Boolean(recommendation.querySelector(".line-clamp-2")),
      ).toBe(true);
      expect(recommendation.querySelector("details")).toBeNull();
      expect(matches[1]?.textContent).not.toContain("Fit reasons");
    }
    expect(matches[2]?.textContent).toContain("Unknown");
    expect(matches[2]?.textContent).toContain("ScoreUnknown");
    expect(matches[2]?.textContent).toContain("Match judgmentUnknown");
    expect(matches[2]?.textContent).toContain("Original pool rankUnknown");
    expect(matches[2]?.querySelector("details")).toBeNull();
    expect(matches[3]?.textContent).toContain("Source unavailable");
    expect(matches[4]?.textContent).toContain("Score5/6");
    expect(matches[4]?.textContent).not.toContain("Score / tier not returned");
    const judgment = [...matches[4]!.querySelectorAll("dt")].find(
      (field) => field.textContent === "Match judgment",
    )!.nextElementSibling!;
    const candidateReads = api.listCandidates.mock.calls.length;
    await toggleDescription(judgment, "Match judgment", matchJudgment);
    await toggleDescription(matches[4]!, "Recommendation", recommendation);
    if (viewName === "Cards") await toggleDescription(matches[0]!, "Fit reasons", fitReasons);
    expect(api.listCandidates).toHaveBeenCalledTimes(candidateReads);
    expect(list.textContent).not.toContain("Unassessed");
    expect(list.textContent).toContain("Resume: Could not access");
    expect(api.listCandidateSources).not.toHaveBeenCalled();
    await view.click(candidate.name);
    const dialog = view.container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Resume: Could not access");
    expect(dialog.textContent).not.toContain("Resume missing");
    const sources = dialog.querySelector('[aria-label="Saved candidate sources"]')!;
    const summary = dialog.querySelector('[aria-label="Research match"]')!;
    expect([...summary.querySelectorAll("dd dt")].map((item) => item.textContent)).toEqual([
      "Match score",
      "Match tier",
      "Fit reasons",
    ]);
    expect(summary.textContent).toContain("Match score0");
    expect(summary.textContent).toContain(fitReasons);
    await toggleDescription(summary, "Fit reasons", fitReasons);
    expect(summary.textContent).not.toContain("Earlier round grade");
    expect(sources.textContent).toContain("Earlier round grade");
    const report = sources.querySelector(".hire-candidate-report")!;
    expect(report).not.toBeNull();
    expect(
      [...report.querySelectorAll(".hire-candidate-finding-heading > .font-medium")].map(
        (item) => item.textContent,
      ),
    ).toEqual([
      "Geometry work",
      "Full-time years",
      "Provider tier",
      "Provider rule",
      "Resume status",
      "Fit reasons",
      "Match score",
      "Match tier",
    ]);
    const findings = [...report.querySelectorAll<HTMLDetailsElement>(".hire-candidate-finding")];
    expect(findings[0]!.open).toBe(false);
    await act(async () => {
      findings[0]!.open = true;
    });
    expect(findings[0]!.querySelector(":scope > div > p")?.textContent).toBe(
      "  Built a mesh compiler.\nMaintained geometry tools.  ",
    );
    expect(findings[1]?.querySelector("p")?.textContent).toBe("Unknown");
    expect(report.textContent).toContain("Provider cites a project description.");
    expect(report.textContent).toContain(
      "Provider reports relevant geometry work; dates are unconfirmed.",
    );
    expect(report.textContent).toContain("Employment dates were not supplied.");
    expect(report.textContent).toContain("Tier 1");
    expect(report.textContent).toContain("true");
    expect(report.textContent).toContain(fitReasons);
    await toggleDescription(report, "Fit reasons", fitReasons);
    expect(dialog.querySelector("h2")?.textContent).toBe(candidate.name);
    expect(api.listCandidates).toHaveBeenCalledTimes(candidateReads);
    for (const url of [
      "https://projects.example.test/mesh",
      "https://profile.example.test/engineer",
    ]) {
      expect(sources.querySelectorAll(`a[href="${url}"]`)).toHaveLength(1);
      const link = sources.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)!;
      expect(link).not.toBeNull();
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noreferrer");
    }
    expect(sources.querySelector("time")?.dateTime).toBe("2026-01-01T00:00:00Z");
    expect(sources.textContent).toContain("Example Robotics · Geometry engineer");
    expect(sources.textContent).toContain("CRM · Synced");
    expect(dialog.textContent).not.toContain("Unassessed");
    for (const hidden of [
      "internal-person",
      "internal-task",
      "internal-action",
      "internal-effect",
      "internal-artifact",
      "internal-output",
      "provider_report",
      "Hard criteria",
      "Not met",
      '{"fields"',
    ])
      expect(dialog.textContent).not.toContain(hidden);
    expect(sources.querySelector("pre, mark, [role=status]")).toBeNull();
    expect(api.getAssessment).not.toHaveBeenCalled();
    expect(api.getById).not.toHaveBeenCalled();
    expect(api.readSource).not.toHaveBeenCalled();
    await view.click("Close");
    await view.click(noMatch.name);
    const match = view.container.querySelector('[role="dialog"] [aria-label="Research match"]')!;
    expect(match.textContent).toContain("GradeProvider strong");
    expect(match.textContent).toContain("Rank3");
    expect(match.textContent).toContain("Overall rank3");
    expect(match.textContent).toContain("Original pool rank12");
    expect(match.textContent).toContain("RecommendationReview this profile");
    expect(match.textContent).toContain(
      "Fit reasons  Built the requested systems.\nRelevant project evidence.  ",
    );
    expect(match.textContent).not.toContain("Score / tier not returned");
    await view.click("Close");
    await view.click(nativeScore.name);
    const nativeMatch = view.container.querySelector(
      '[role="dialog"] [aria-label="Research match"]',
    )!;
    expect(nativeMatch.textContent).toContain("Score5/6");
    expect(nativeMatch.textContent).toContain(`Match judgment${matchJudgment}`);
    expect(nativeMatch.textContent).not.toContain("Score / tier not returned");
    await toggleDescription(nativeMatch, "Match judgment", matchJudgment);
    await view.render("thread-1", 0, true);
    const diagnostics = view.container.querySelector(
      '[role="dialog"] [aria-label="Research match"]',
    )!;
    expect(diagnostics.querySelector("details")).toBeNull();
    expect(diagnostics.textContent).toContain(`Match judgment${matchJudgment}`);
    expect(diagnostics.textContent).toContain(`Recommendation${recommendation}`);
    expect(JSON.stringify(source)).toBe(retainedSource);
  },
);

it.each(["Cards", "Table"])(
  "shows batch ranks only without a higher-priority rank field in %s and details",
  async (viewName) => {
    const cases = [
      { fields: [{ label: "Batch rank", value: "2" }], expected: ["Batch rank2"] },
      ...["Updated rank", "Overall rank", "Rank"].flatMap((label) =>
        ["4", null].map((value) => ({
          fields: [
            { label, value },
            { label: "Batch rank", value: "2" },
          ],
          expected: [`${label}${value ?? "Unknown"}`],
        })),
      ),
      { fields: [], expected: [] },
    ];
    const candidates = cases.map(({ fields }, index) => ({
      ...candidateFixture(`rank-person-${index}`, false),
      name: `Synthetic rank person ${index}`,
      latestSource: {
        providerTaskId: "native-task",
        taskId: null,
        actionId: null,
        roleRevisionId: revision.id,
        effectId: "saved-page",
        rowIndex: index,
        artifactRef: { artifactId: "saved-artifact", sha256: "a".repeat(64) },
        requestCursor: "saved-batch-cursor",
        outputId: null,
        observedAt: "2026-01-01T00:00:00Z",
        report: {
          fields: fields.map((field) => ({ ...field, sourceUrls: [] })),
          sourceUrls: [],
        },
      },
    }));
    const originals = structuredClone(candidates);
    api.listCandidates.mockResolvedValue(candidatePage(candidates));
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(viewName);
    const list = view.container.querySelector(viewName === "Cards" ? "ul" : "tbody")!;
    const matches = [...list.querySelectorAll('[aria-label="Research match"]')];
    expect(matches).toHaveLength(cases.length);
    for (const [index, { expected }] of cases.entries()) {
      expect(
        [...matches[index]!.querySelectorAll("dd dl > div")].map((field) => field.textContent),
      ).toEqual(expected);
      expect(matches[index]!.textContent).toContain("Score / tier not returned");
    }
    await view.click(candidates[0]!.name);
    const detail = view.container.querySelector('[role="dialog"] [aria-label="Research match"]')!;
    expect(detail.textContent).toContain("Batch rank2");
    expect(detail.textContent).not.toContain("Overall rank");
    expect(detail.textContent).toContain("Score / tier not returned");
    expect(candidates).toEqual(originals);
  },
);

it.each(["Cards", "Table"])(
  "marks sources saved before the latest role update in %s and details",
  async (viewName) => {
    const currentSource = {
      providerTaskId: "native-task",
      taskId: null,
      actionId: null,
      roleRevisionId: revision.id,
      effectId: "current-source",
      rowIndex: 0,
      artifactRef: { artifactId: "current-artifact", sha256: "a".repeat(64) },
      requestCursor: null,
      outputId: null,
      observedAt: "2026-01-02T00:00:00Z",
      crmImports: [],
      report: { fields: [{ label: "Rank", value: "1", sourceUrls: [] }], sourceUrls: [] },
    };
    const earlierSource = {
      ...currentSource,
      roleRevisionId: "revision-1",
      effectId: "earlier-source",
      artifactRef: { artifactId: "earlier-artifact", sha256: "b".repeat(64) },
      observedAt: "2026-01-01T00:00:00Z",
    };
    const current = {
      ...candidateFixture("current-person", false),
      name: "Current source person",
      latestSource: currentSource,
    };
    const earlier = {
      ...candidateFixture("earlier-person", false),
      name: "Earlier source person",
      latestSource: earlierSource,
    };
    api.listCandidates.mockResolvedValue(candidatePage([current, earlier]));
    api.listCandidateSources.mockResolvedValue({
      roleId: role.id,
      candidateKey: current.candidateKey,
      items: [currentSource, earlierSource],
      nextCursor: null,
      total: 2,
    });
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(viewName);
    const list = view.container.querySelector(viewName === "Cards" ? "ul" : "tbody")!;
    const matches = list.querySelectorAll('[aria-label="Research match"]');
    const earlierLabel = "Saved before latest role update";
    expect(matches).toHaveLength(2);
    expect(matches[0]?.textContent).not.toContain(earlierLabel);
    expect(matches[0]?.textContent).not.toMatch(/verified|reassessed|Current/i);
    expect(matches[1]?.textContent).toContain(earlierLabel);
    await view.click(current.name);
    const dialog = view.container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[aria-label="Research match"]')?.textContent).not.toContain(
      earlierLabel,
    );
    const sources = dialog.querySelectorAll('[aria-label="Saved candidate sources"] > div');
    expect(sources).toHaveLength(2);
    expect(sources[0]?.textContent).not.toContain(earlierLabel);
    expect(sources[1]?.textContent).toContain(earlierLabel);
    expect(sources[0]?.textContent).not.toMatch(/verified|reassessed|Current/i);
    await view.click("Close");
    await view.click(earlier.name);
    expect(
      view.container.querySelector('[role="dialog"] [aria-label="Research match"]')?.textContent,
    ).toContain(earlierLabel);
  },
);

it("opens retained candidate report fields through the native saved assessment source", async () => {
  const material = artifactSourceFixture(
    '{"task_id":"internal-task","rows":[]}',
    "application/json",
  );
  const reportSource = { ...material.source, kind: "provider_report" };
  api.listAssessments.mockResolvedValue([
    { ...assessment, assessment: { ...assessment.assessment, sourceRefs: [reportSource] } },
  ]);
  api.readSource.mockResolvedValue({
    kind: "report",
    report: {
      fields: [
        {
          label: "Geometry work",
          value: "Built a mesh compiler",
          evidence: "Provider cites project documentation.",
          reasoning: "Full-time duration is unconfirmed.",
          sourceUrls: ["https://projects.example.test/mesh"],
        },
        { label: "Full-time years", value: null, sourceUrls: [] },
      ],
      sourceUrls: ["https://profile.example.test/engineer"],
    },
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click("Unnamed candidate");
  expect(api.readSource).not.toHaveBeenCalled();
  const evidence = await view.expand("Source", true);
  await vi.waitFor(() =>
    expect(evidence.querySelector("dl dt")?.textContent).toBe("Geometry work"),
  );
  expect(evidence.textContent).toContain("Built a mesh compiler");
  expect(evidence.textContent).toContain("Unknown");
  expect(evidence.textContent).toContain("Provider cites project documentation.");
  expect(evidence.textContent).toContain("Full-time duration is unconfirmed.");
  expect(evidence.querySelector('a[href="https://projects.example.test/mesh"]')).not.toBeNull();
  expect(evidence.querySelector('a[href="https://profile.example.test/engineer"]')).not.toBeNull();
  expect(evidence.querySelector("pre, mark, [data-artifact-id]")).toBeNull();
  for (const hidden of [
    "internal-task",
    material.reference.artifactId,
    material.reference.sha256,
    "Source text",
  ])
    expect(evidence.textContent).not.toContain(hidden);
  expect(api.readSource).toHaveBeenCalledExactlyOnceWith({
    kind: "assessment",
    roleId: assessment.assessment.roleId,
    candidateKey: assessment.assessment.candidateKey,
    version: assessment.assessment.version,
    sourceRefId: reportSource.id,
  });
  expect(api.getById).not.toHaveBeenCalled();
});

it("opens the newest saved source while preserving dated findings and source pagination", async () => {
  const candidate = { ...candidateFixture("repeated-person", false), name: "Synthetic Engineer" };
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  const page = {
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    total: 3,
    nextCursor: "more-sources",
    items: [1, 0].map((index) => ({
      providerTaskId: "provider-task",
      taskId: null,
      actionId: null,
      roleRevisionId: revision.id,
      effectId: `internal-read-${index}`,
      rowIndex: 0,
      artifactRef: { artifactId: `internal-artifact-${index}`, sha256: "a".repeat(64) },
      requestCursor: null,
      outputId: null,
      observedAt: `2026-01-0${index + 1}T00:00:00Z`,
      crmImports: [],
      report: {
        fields: [{ label: "Geometry work", value: "Built a mesh compiler", sourceUrls: [] }],
        sourceUrls: [],
      },
    })),
  };
  api.listCandidateSources.mockResolvedValueOnce(page).mockResolvedValueOnce({
    ...page,
    nextCursor: null,
    items: [{ ...page.items[0]!, effectId: "older-read", observedAt: "2025-12-31T00:00:00Z" }],
  });
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click(candidate.name);
  const sources = view.container.querySelector('[aria-label="Saved candidate sources"]')!;
  let disclosures = [...sources.querySelectorAll<HTMLDetailsElement>(":scope > div > details")];
  expect(disclosures).toHaveLength(2);
  expect(disclosures.map((item) => item.open)).toEqual([true, false]);
  expect(
    disclosures.map((item) => item.querySelector("summary time")?.getAttribute("datetime")),
  ).toEqual(["2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"]);
  expect(
    disclosures.every(
      (item) =>
        item.querySelector(".hire-candidate-finding summary")?.textContent === "Geometry work",
    ),
  ).toBe(true);
  expect(sources.textContent).toContain("More sources");
  await view.click("More sources");
  expect(api.listCandidateSources).toHaveBeenLastCalledWith({
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    limit: 20,
    cursor: "more-sources",
  });
  disclosures = [...sources.querySelectorAll<HTMLDetailsElement>(":scope > div > details")];
  expect(disclosures.map((item) => item.open)).toEqual([true, false, false]);
  expect(
    disclosures.map((item) => item.querySelector("summary time")?.getAttribute("datetime")),
  ).toEqual(["2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", "2025-12-31T00:00:00Z"]);
  expect(sources.textContent).not.toContain("More sources");
  expect(sources.textContent).not.toContain("Latest");
  expect(api.getById).not.toHaveBeenCalled();
});

it.each(["source", "revision", "role", "thread", "denial"])(
  "discards a late retained report after a product %s change",
  async (boundary) => {
    const material = artifactSourceFixture();
    const originalRevision = { ...revision, criteria: [], sourceRefs: [material.source] };
    api.getWorkspace.mockResolvedValue({ role, revision: originalRevision });
    const lateReport = {
      kind: "report",
      report: {
        fields: [{ label: "Geometry work", value: "Late retained report", sourceUrls: [] }],
        sourceUrls: [],
      },
    };
    let finish!: (value: typeof lateReport) => void;
    api.readSource
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue({
        ...lateReport,
        report: {
          ...lateReport.report,
          fields: [{ ...lateReport.report.fields[0], value: "Current retained report" }],
        },
      });
    const view = await mounted("thread-1", undefined, false);
    await view.expand("Source", true);
    if (boundary === "thread") {
      api.getWorkspace.mockResolvedValue(null);
      await view.render("thread-2");
    } else if (boundary === "denial") {
      api.getWorkspace.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
      await view.click("Refresh");
      expect(view.container.textContent).toContain("Could not load recruiting");
    } else {
      const nextRole = boundary === "role" ? { ...role, id: "next-role" } : role;
      const nextRevision = {
        ...originalRevision,
        roleId: nextRole.id,
        id: boundary === "source" ? revision.id : "next-revision",
        sourceRefs: [
          boundary === "source" ? { ...material.source, id: "next-source" } : material.source,
        ],
      };
      api.getWorkspace.mockResolvedValue({ role: nextRole, revision: nextRevision });
      await view.click("Refresh");
      await view.expand("Source", true);
      await vi.waitFor(() =>
        expect(view.container.textContent).toContain("Current retained report"),
      );
    }
    await act(async () => finish(lateReport));
    expect(view.container.textContent).not.toContain("Late retained report");
    expect(api.getById).not.toHaveBeenCalled();
  },
);

it("discards a late retained assessment report when selecting another candidate", async () => {
  const material = artifactSourceFixture();
  const first = {
    ...assessment,
    assessment: { ...assessment.assessment, sourceRefs: [material.source] },
  };
  const second = { ...first, assessment: { ...first.assessment, candidateKey: "candidate-2" } };
  api.listAssessments.mockResolvedValue([first, second]);
  api.listCandidates.mockResolvedValue(
    candidatePage([
      { ...candidateFixture(), name: "First engineer" },
      { ...candidateFixture("candidate-2"), name: "Second engineer" },
    ]),
  );
  let finish!: (value: unknown) => void;
  api.readSource.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted("thread-1", undefined, false);
  await view.click("Evidence");
  await view.click("First engineer");
  await view.expand("Source", true);
  await view.click("Close");
  await view.click("Second engineer");
  await act(async () =>
    finish({
      kind: "report",
      report: {
        fields: [
          { label: "Geometry work", value: "First candidate retained report", sourceUrls: [] },
        ],
        sourceUrls: [],
      },
    }),
  );
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("Second engineer");
  expect(view.container.textContent).not.toContain("First candidate retained report");
  expect(api.getById).not.toHaveBeenCalled();
});

it.each(["candidate", "role", "denial"])(
  "discards a late unassessed source report after a %s change",
  async (boundary) => {
    const first = { ...candidateFixture("first-person", false), name: "First engineer" };
    const second = { ...candidateFixture("second-person", false), name: "Second engineer" };
    api.listCandidates.mockResolvedValue(candidatePage([first, second]));
    let finish!: (value: unknown) => void;
    api.listCandidateSources.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = await mounted("thread-1", undefined, false);
    await view.click("Evidence");
    await view.click(first.name);
    if (boundary === "candidate") {
      await view.click("Close");
      await view.click(second.name);
    } else if (boundary === "role") {
      const nextRole = { ...role, id: "next-role", currentRevisionId: "next-revision" };
      api.getWorkspace.mockResolvedValue({
        role: nextRole,
        revision: { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id },
      });
      api.listCandidates.mockResolvedValue({
        ...candidatePage([{ ...second, roleId: nextRole.id }]),
        roleId: nextRole.id,
        roleRevisionId: nextRole.currentRevisionId,
      });
      await view.click("Refresh");
    } else {
      api.listResearch.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
      await view.click("Refresh");
      expect(view.container.textContent).toContain("Could not load recruiting");
    }
    await act(async () =>
      finish({
        roleId: role.id,
        candidateKey: first.candidateKey,
        total: 1,
        nextCursor: null,
        items: [
          {
            providerTaskId: "provider-task",
            taskId: null,
            actionId: null,
            roleRevisionId: revision.id,
            effectId: "first-read",
            rowIndex: 0,
            artifactRef: { artifactId: "first-artifact", sha256: "a".repeat(64) },
            requestCursor: null,
            outputId: null,
            observedAt: "2026-01-01T00:00:00Z",
            crmImports: [],
            report: {
              fields: [
                { label: "Geometry work", value: "Late unassessed source report", sourceUrls: [] },
              ],
              sourceUrls: [],
            },
          },
        ],
      }),
    );
    expect(view.container.textContent).not.toContain("Late unassessed source report");
    if (boundary === "candidate")
      expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(second.name);
    else expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(api.getById).not.toHaveBeenCalled();
  },
);

it("keeps exact research evidence readable while its routing snapshot stays diagnostic-only", async () => {
  const text = "Before\nBuilt a compiler\nAfter";
  const material = artifactSourceFixture(
    JSON.stringify({
      request: { task_id: "internal-provider-task" },
      candidate: { evidence: text },
    }),
    "application/json",
  );
  const report = {
    ...material.source,
    kind: "provider_report",
    selection: { kind: "artifact_json_string", path: ["candidate", "evidence"], start: 7, end: 23 },
  };
  api.getWorkspace.mockResolvedValue({ role, revision: { ...revision, sourceRefs: [report] } });
  api.getById.mockResolvedValue(material.artifact);
  api.readSource.mockResolvedValue({ kind: "text", text, start: 7, end: 23 });
  const view = await mounted("thread-1", undefined, false);
  const evidence = await view.expand("Source", true);
  await vi.waitFor(() =>
    expect(evidence.querySelector("mark")?.textContent).toBe("Built a compiler"),
  );
  expect(evidence.querySelector('[role="document"]')?.textContent).toBe(text);
  expect(evidence.querySelector("[data-artifact-id]")).toBeNull();
  expect(view.container.textContent).not.toContain("internal-provider-task");
  expect(view.container.textContent).not.toContain(material.reference.artifactId);
  expect(view.container.textContent).not.toContain(material.reference.sha256);
});

it("renders native saved research history without inventing new search rounds", async () => {
  const observations = ["read-1", "read-2", "read-3"].map((effectId, index) => ({
    effectId,
    providerTaskId: index === 1 ? "provider-b" : "provider-a",
    roleRevisionId: revision.id,
    runId: `run-${effectId}`,
    rowCount: 15,
    observedAt: `2026-10-16T0${index}:00:00.000Z`,
    requestCursor: null,
    artifactRef: { artifactId: `artifact-${effectId}`, sha256: "a".repeat(64) },
  }));
  api.listResearch.mockResolvedValue({ tasks: [], actions: [], observations });
  api.listCandidates.mockResolvedValue({
    ...candidatePage(),
    counts: {
      sourceRows: 45,
      candidates: 30,
      identifiedCandidates: 30,
      unassessed: 30,
      assessed: 0,
      shortlisted: 0,
    },
  });
  const view = await mounted();
  await view.click("Dashboard");
  expect(view.container.textContent).not.toContain("No saved research");
  const history = view.container.querySelector('[aria-label="Saved research results"]')!;
  expect(history).not.toBeNull();
  expect(history.querySelectorAll("li")).toHaveLength(3);
  expect(history.querySelector("time")?.textContent).toContain("PDT");
  expect([...history.querySelectorAll("time")].map((item) => item.dateTime)).toEqual(
    observations.map((item) => item.observedAt),
  );
  expect(history.textContent?.match(/15 saved source rows/g)).toHaveLength(3);
  expect(history.textContent?.match(/provider-a/g)).toHaveLength(2);
  expect(history.textContent?.match(/provider-b/g)).toHaveLength(1);
  expect(api.listResearch).toHaveBeenCalledWith({ roleId: role.id });
  expect(api.getById).not.toHaveBeenCalled();
  const sourceLinks = [...history.querySelectorAll("summary")].filter(
    (summary) => summary.textContent === "Source Artifact",
  );
  expect(sourceLinks).toHaveLength(3);
});

it("retains missing identity and exposes saved profile issues without inventing profile facts", async () => {
  api.listCandidates.mockResolvedValue(
    candidatePage([
      {
        ...candidateFixture("saved-row-4", false),
        issues: ["missing_name"],
        evidenceUrls: ["https://example.test/evidence"],
        resumeUrl: "https://example.test/resume.pdf",
      },
    ]),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("Cards");
  const card = view.container.querySelector("li")!;
  expect(card.textContent).toContain("Name missing");
  expect(card.textContent).toContain("saved-row-4");
  expect(card.textContent).toContain("LinkedIn missing");
  expect(card.textContent).toContain("provider_report");
  expect(card.textContent).toContain("missing_name");
  expect(card.querySelector('a[href="https://example.test/resume.pdf"]')).not.toBeNull();
  expect(card.querySelector('a[href="https://example.test/evidence"]')).not.toBeNull();
});

it("ignores a late candidate page and denial from the old thread", async () => {
  let finish!: (value: unknown) => void;
  let deny!: (reason: unknown) => void;
  api.listCandidates.mockReturnValueOnce(
    new Promise((resolve, reject) => {
      finish = resolve;
      deny = reject;
    }),
  );
  const view = await mounted();
  const next = {
    role: { ...role, id: "role-2", title: "Synthetic Designer", currentRevisionId: "rev-2" },
    revision: { ...revision, roleId: "role-2", id: "rev-2" },
  };
  api.getWorkspace.mockResolvedValue(next);
  api.listCandidates.mockResolvedValue({
    ...candidatePage([{ ...candidateFixture("new-person", false), roleId: "role-2" }]),
    roleId: "role-2",
    roleRevisionId: "rev-2",
  });
  await view.render("thread-2");
  await act(async () =>
    finish({
      ...candidatePage([{ ...candidateFixture(), crm: crmSync("synced") }]),
      crmTarget: { bindingEffectId: "crm-binding", target: crmTarget },
    }),
  );
  await view.click("Evidence");
  expect(view.container.textContent).toContain("new-person");
  expect(view.container.textContent).not.toContain("candidate-1");
  expect(view.container.textContent).not.toContain("Geometry engineer");
  expect(view.container.textContent).not.toContain(crmSync("synced").receipt!.candidate_id);
  api.listCandidates.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      deny = reject;
    }),
  );
  await view.click("Refresh");
  api.getWorkspace.mockResolvedValue({ role, revision });
  api.listCandidates.mockResolvedValue(candidatePage());
  await view.render("thread-3");
  await act(async () => deny(new ORPCError("FORBIDDEN")));
  await view.click("Evidence");
  expect(view.container.textContent).toContain("candidate-1");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps a confirmed shortlist receipt when refreshing the candidate counts fails", async () => {
  api.listCandidates
    .mockResolvedValueOnce(candidatePage([candidateFixture("candidate-1", false)]))
    .mockRejectedValue(new Error("offline"));
  api.setCandidateShortlist.mockResolvedValue({
    roleId: role.id,
    candidateKey: "candidate-1",
    shortlisted: true,
    revision: 1,
  });
  const view = await mounted();
  await view.click("Evidence");
  await view.click("Shortlist candidate-1");
  expect(
    view.container
      .querySelector('[aria-label="Shortlist candidate-1"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(view.container.textContent).toContain("Could not load candidates");
  expect(view.container.textContent).not.toContain("Could not save shortlist");
  await view.click("Dashboard");
  expect(view.container.textContent).toContain("Could not load candidates");
  expect(view.container.querySelector('[aria-label="Saved candidate totals"]')).toBeNull();
});

it("keeps a pending shortlist and its receipt across candidate filter changes", async () => {
  const candidate = candidateFixture("candidate-1", false);
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  let finish!: (value: unknown) => void;
  api.setCandidateShortlist.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("Shortlist candidate-1");
  await changeInput(view.container, "Search candidates", "candidate");
  const checkbox = () =>
    view.container.querySelector<HTMLButtonElement>('[aria-label="Shortlist candidate-1"]')!;
  expect(checkbox().getAttribute("aria-disabled")).toBe("true");
  expect(api.setCandidateShortlist).toHaveBeenCalledTimes(1);
  const saved = { ...candidate, shortlisted: true, revision: 1 };
  api.listCandidates.mockResolvedValue(candidatePage([saved]));
  await act(async () =>
    finish({
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      shortlisted: true,
      revision: 1,
    }),
  );
  expect(checkbox().getAttribute("aria-checked")).toBe("true");
  expect(checkbox().getAttribute("aria-disabled")).not.toBe("true");
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: "candidate" }),
    { signal: expect.any(AbortSignal) },
  );
});

it("ignores a superseded candidate read denial after a fresh shortlist receipt and read", async () => {
  const candidate = candidateFixture("candidate-1", false);
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  let finish!: (value: unknown) => void;
  api.setCandidateShortlist.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("Shortlist candidate-1");
  let deny!: (error: unknown) => void;
  api.listCandidates.mockReturnValueOnce(
    new Promise((_, reject) => {
      deny = reject;
    }),
  );
  await changeInput(view.container, "Search candidates", "candidate");
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidate, shortlisted: true, revision: 1 }]),
  );
  await act(async () =>
    finish({
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      shortlisted: true,
      revision: 1,
    }),
  );
  await act(async () => deny(new ORPCError("FORBIDDEN")));
  expect(
    view.container
      .querySelector('[aria-label="Shortlist candidate-1"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(view.container.textContent).not.toContain("Could not load recruiting workspace");
});

it("preserves null and primitive provider rows in the exact raw Artifact viewer", async () => {
  const f = rawResultsFixture();
  const snapshot = {
    ...f.snapshot,
    observation: {
      ...f.snapshot.observation,
      rows: [null, 42, "unstructured", ["raw"], { name: "Synthetic Person" }],
    },
  };
  const saved = nativeOutput(f, snapshot, f.reference.artifactId);
  api.listResearch.mockResolvedValue({
    observations: [],
    tasks: [f.task],
    actions: [{ ...f.action, outputArtifacts: [saved.reference] }],
  });
  api.getById.mockResolvedValue(saved.artifact);
  const view = await mounted();
  await view.click("Evidence");
  const results = await view.expand("Raw search results");
  await vi.waitFor(() => expect(results.textContent).toContain('"unstructured"'));
  expect(results.textContent).toContain("null");
  expect(results.textContent).toContain("42");
  expect(results.textContent).toContain('"raw"');
  expect(results.textContent).toContain("Synthetic Person");
});

it("refreshes saved sources when new discoveries arrive and ignores the replaced source denial", async () => {
  api.listCandidates.mockResolvedValue(candidatePage([candidateFixture("raw-person", false)]));
  let deny!: (error: unknown) => void;
  api.listCandidateSources.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      deny = reject;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("raw-person");
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidateFixture("raw-person", false), discoveryCount: 3 }]),
  );
  api.listCandidateSources.mockResolvedValue({
    roleId: role.id,
    candidateKey: "raw-person",
    items: [],
    total: 0,
    nextCursor: null,
  });
  await view.click("Refresh");
  expect(api.listCandidateSources).toHaveBeenCalledTimes(2);
  await act(async () => deny(new ORPCError("FORBIDDEN")));
  expect(view.container.textContent).toContain("raw-person");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});

it("rechecks the workspace when the candidate index belongs to a newer role revision", async () => {
  const next = {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: { ...revision, id: "revision-3", revision: 3 },
  };
  api.getWorkspace
    .mockResolvedValueOnce({ role, revision })
    .mockResolvedValueOnce({ role, revision })
    .mockResolvedValue(next);
  api.listCandidates.mockResolvedValue({ ...candidatePage(), roleRevisionId: "revision-3" });
  const view = await mounted();
  expect(view.container.textContent).toContain("Version 3");
  expect(api.listCandidates).toHaveBeenCalledTimes(2);
});

it.each(["action:action-1", "source:native-read-1"])(
  "clears the previous role's %s result filter when the thread binds another role",
  async (filter) => {
    const f = rawResultsFixture("action-1");
    api.listResearch.mockResolvedValue({
      tasks: [f.task],
      actions: [f.action],
      observations: [savedObservation],
    });
    const view = await mounted();
    await view.click("Evidence");
    await changeSelect(view.container, "Research round", filter);
    expect(api.listCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining(
        filter === "action:action-1"
          ? { actionId: f.action.id }
          : { sourceEffectId: savedObservation.effectId },
      ),
      { signal: expect.any(AbortSignal) },
    );
    const next = {
      role: { ...role, id: "role-next", currentRevisionId: "revision-next" },
      revision: { ...revision, roleId: "role-next", id: "revision-next" },
    };
    api.getWorkspace.mockResolvedValue(next);
    await view.render("thread-1", 1);
    expect(api.listCandidates.mock.lastCall?.[0]).toEqual({
      roleId: "role-next",
      sort: "score",
      limit: 30,
    });
    expect(
      view.container.querySelector<HTMLSelectElement>('select[aria-label="Research round"]')?.value,
    ).toBe("all");
  },
);

const employmentRule: RecruitingEmploymentRule = {
  minimumMonths: 60,
  countingRule: "complete_calendar_months",
  qualificationDefinition: "Full-time systems work",
  cutoff: { kind: "assessment_date" },
};

function typedCriteria(rule = employmentRule) {
  return {
    role,
    revision: {
      ...revision,
      criteria: [
        {
          ...revision.criteria[0]!,
          expression: {
            kind: "atom" as const,
            id: "atom-1",
            statement: "Five years of systems work",
            employmentRule: rule,
          },
        },
      ],
    },
  };
}

it("edits the executed employment rule from 60 to 84 months with an exact fixed cutoff", async () => {
  api.getWorkspace.mockResolvedValue(typedCriteria());
  const view = await mounted();
  expect(view.container.textContent).toContain("Minimum 60 complete calendar months");
  await view.click("Edit criteria");
  expect(
    view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Minimum complete calendar months"]',
    )?.value,
  ).toBe("60");
  expect(view.container.querySelector('textarea[aria-label="Statement"]')).toBeNull();
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Qualifying work"]')
      ?.value,
  ).toBe("Full-time systems work");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeInput(view.container, "Minimum complete calendar months", "84");
  const cutoff = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Count through"]',
  )!;
  await act(async () => {
    cutoff.value = "fixed";
    cutoff.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeInput(view.container, "Cutoff date", "2026-10-16");
  const rule = {
    ...employmentRule,
    minimumMonths: 84,
    cutoff: {
      kind: "fixed" as const,
      date: { precision: "day" as const, year: 2026, month: 10, day: 16 },
    },
  };
  const typed = typedCriteria(rule);
  const saved = {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: {
      ...typed.revision,
      id: "revision-3",
      revision: 3,
      criteria: [
        {
          ...typed.revision.criteria[0]!,
          expression: {
            ...typed.revision.criteria[0]!.expression,
            statement:
              "At least 84 complete calendar months of Full-time systems work; cutoff: 2026-10-16 (UTC).",
          },
        },
      ],
    },
  };
  api.editCriteria.mockResolvedValue(saved);
  api.getWorkspace.mockResolvedValue(saved);
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", employmentRule: rule }],
      },
    ],
  });
  expect(view.container.textContent).toContain("Minimum 84 complete calendar months");
  expect(view.container.textContent).toContain("2026-10-16");
  expect(view.container.textContent).not.toContain("Five years of systems work");
});

it("validates employment months and qualification, and can use the assessment date", async () => {
  api.getWorkspace.mockResolvedValue(
    typedCriteria({
      ...employmentRule,
      cutoff: { kind: "fixed", date: { precision: "day", year: 2026, month: 10, day: 16 } },
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  for (const value of ["", "-1", "1.5"]) {
    await changeInput(view.container, "Minimum complete calendar months", value);
    await view.click("Save");
    expect(api.editCriteria).not.toHaveBeenCalled();
  }
  await changeInput(view.container, "Minimum complete calendar months", "84");
  const definition = view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Qualifying work"]',
  )!;
  const changeDefinition = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        definition,
        value,
      );
      definition.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await changeDefinition("  ");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeDefinition("  Full-time compiler work  ");
  const cutoff = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Count through"]',
  )!;
  await act(async () => {
    cutoff.value = "assessment_date";
    cutoff.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.container.querySelector('input[aria-label="Cutoff date"]')).toBeNull();
  api.editCriteria.mockRejectedValue(new Error("offline"));
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [
          {
            atomId: "atom-1",
            employmentRule: {
              ...employmentRule,
              minimumMonths: 84,
              qualificationDefinition: "Full-time compiler work",
            },
          },
        ],
      },
    ],
  });
  expect(
    view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Minimum complete calendar months"]',
    )?.value,
  ).toBe("84");
  expect(definition.value).toBe("  Full-time compiler work  ");
});

it("keeps shared typed rules and newer month edits while a save is pending", async () => {
  const initial = typedCriteria();
  const shared = initial.revision.criteria[0]!;
  const criteria = [shared, { ...shared, id: "criterion-2", priority: "preferred" as const }];
  api.getWorkspace.mockResolvedValue({ ...initial, revision: { ...initial.revision, criteria } });
  let finish!: (value: unknown) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  await changeInput(view.container, "Minimum complete calendar months", "84");
  const monthValues = () =>
    [
      ...view.container.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Minimum complete calendar months"]',
      ),
    ].map((input) => input.value);
  expect(monthValues()).toEqual(["84", "84"]);
  await view.click("Save");
  await changeInput(view.container, "Minimum complete calendar months", "96");
  const saved = {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: {
      ...initial.revision,
      id: "revision-3",
      revision: 3,
      criteria: criteria.map((criterion) => ({
        ...criterion,
        expression: {
          ...criterion.expression,
          statement:
            "At least 84 complete calendar months of Full-time systems work; cutoff: assessment date (UTC).",
          employmentRule: { ...employmentRule, minimumMonths: 84 },
        },
      })),
    },
  };
  api.getWorkspace.mockResolvedValue(saved);
  await act(async () => finish(saved));
  expect(monthValues()).toEqual(["96", "96"]);
  api.editCriteria.mockRejectedValueOnce(new Error("offline"));
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 3,
    criteria: criteria.map((criterion) => ({
      criterionId: criterion.id,
      priority: criterion.priority,
      atoms: [{ atomId: "atom-1", employmentRule: { ...employmentRule, minimumMonths: 96 } }],
    })),
  });
  expect(monthValues()).toEqual(["96", "96"]);
});

function savedCriteria(statement = "Build reliable systems") {
  return {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: {
      ...revision,
      id: "revision-3",
      revision: 3,
      criteria: [
        {
          ...revision.criteria[0]!,
          expression: { kind: "atom" as const, id: "atom-1", statement },
        },
      ],
    },
  };
}

it("edits exact existing atoms and priority while preserving compound groups", async () => {
  const compound = {
    ...revision.criteria[0]!,
    expression: {
      kind: "all",
      items: [
        { kind: "atom", id: "atom-1", statement: "Build systems" },
        {
          kind: "any",
          items: [
            { kind: "atom", id: "atom-2", statement: "Use compilers" },
            { kind: "not", item: { kind: "atom", id: "atom-3", statement: "Only manage teams" } },
          ],
        },
      ],
    },
  } satisfies RecruitingRoleRevision["criteria"][number];
  const unchanged = {
    ...revision.criteria[0]!,
    id: "criterion-2",
    priority: "preferred" as const,
    expression: { kind: "atom" as const, id: "atom-4", statement: "Write documentation" },
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [compound, unchanged] },
  });
  const saved = savedCriteria();
  const next = {
    ...saved,
    revision: {
      ...saved.revision,
      criteria: [
        {
          ...compound,
          priority: "preferred" as const,
          expression: {
            ...compound.expression,
            items: [
              { kind: "atom" as const, id: "atom-1", statement: "Build reliable systems" },
              compound.expression.items[1]!,
            ],
          },
        },
        unchanged,
      ],
    },
  };
  api.editCriteria.mockResolvedValue(next);
  const view = await mounted();
  await view.click("Edit criteria");
  expect(
    [...view.container.querySelectorAll("fieldset legend")].map((item) => item.textContent),
  ).toEqual(expect.arrayContaining(["AND", "OR", "NOT"]));
  const groups = [...view.container.querySelectorAll("fieldset")].filter(
    (item) => item.querySelector(":scope > legend")?.textContent === "AND",
  );
  expect(groups[0]?.querySelectorAll("textarea")).toHaveLength(3);
  await changeStatement(view.container, "  Build reliable systems  ");
  const priority = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Priority"]',
  )!;
  await act(async () => {
    priority.value = "preferred";
    priority.dispatchEvent(new Event("change", { bubbles: true }));
  });
  api.getWorkspace.mockResolvedValue(next);
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "preferred",
        atoms: [
          { atomId: "atom-1", statement: "Build reliable systems" },
          { atomId: "atom-2", statement: "Use compilers" },
          { atomId: "atom-3", statement: "Only manage teams" },
        ],
      },
    ],
  });
  expect(view.container.textContent).toContain(
    "All ofBuild reliable systemsAny ofUse compilersMust notOnly manage teams",
  );
});

it("does not save unchanged or blank criteria and Cancel discards the draft", async () => {
  const view = await mounted();
  await view.click("Edit criteria");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeStatement(view.container, "  Build systems  ");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeStatement(view.container, "  ");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await view.click("Cancel");
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(view.container.textContent).toContain("Build systems");
});

function searchFilterWorkspace() {
  const filterSource = {
    ...source,
    id: "filter-source",
    quote: "Include Bay Area. Exclude staffing agencies.",
    url: "https://example.test/jd",
  };
  return {
    role,
    revision: {
      ...revision,
      sourceRefs: [...revision.sourceRefs, filterSource],
      brief: {
        fields: [],
        questions: [],
        rules: [
          {
            criterionId: "criterion-1",
            origin: "jd" as const,
            effect: "reject" as const,
            sourceRefIds: [source.id],
          },
        ],
        searchFilters: [
          {
            id: "region",
            statement: "Bay Area",
            mode: "include" as const,
            origin: "jd" as const,
            sourceRefIds: [filterSource.id],
          },
          {
            id: "agency",
            statement: "Staffing agencies",
            mode: "exclude" as const,
            origin: "user_instruction" as const,
            sourceRefIds: [filterSource.id],
          },
          {
            id: "startup",
            statement: "Small teams",
            mode: "prefer" as const,
            origin: "inferred" as const,
            sourceRefIds: [],
          },
        ],
        confirmation: null,
      },
    },
  };
}

async function changeSearchFilter(container: HTMLElement, value: string, index = 0) {
  const input = container.querySelectorAll<HTMLTextAreaElement>(
    'textarea[aria-label="Search filter"]',
  )[index]!;
  expect(input).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows sourced retrieval filters separately from hard and preferred qualification", async () => {
  api.getWorkspace.mockResolvedValue(searchFilterWorkspace());
  const view = await mounted();
  const filters = view.container.querySelector('[aria-label="Search filters"]')!;
  expect(filters).not.toBeNull();
  expect(filters.textContent).toContain("Include");
  expect(filters.textContent).toContain("Bay Area");
  expect(filters.textContent).toContain("Exclude");
  expect(filters.textContent).toContain("Staffing agencies");
  expect(filters.textContent).toContain("Prefer");
  expect(filters.textContent).toContain("Assumption");
  expect(filters.textContent).not.toContain("Build systems");
  expect(view.container.textContent).toContain("Hard criteria");
  expect(
    filters.querySelector<HTMLAnchorElement>('a[href="https://example.test/jd"]'),
  ).not.toBeNull();
  await view.click("Edit search filters");
  expect(view.container.querySelectorAll('textarea[aria-label="Search filter"]')).toHaveLength(3);
  await view.click("Cancel");
  expect(api.editCriteria).not.toHaveBeenCalled();
});

it("saves filter changes with the loaded version and unchanged complete qualification", async () => {
  const initial = searchFilterWorkspace();
  initial.revision.criteria = [
    {
      ...revision.criteria[0]!,
      expression: { kind: "atom", id: "atom-1", statement: "  Build systems  " },
    },
  ];
  api.getWorkspace.mockResolvedValue(initial);
  api.editCriteria.mockResolvedValue(initial);
  const view = await mounted();
  await view.click("Edit search filters");
  await changeSearchFilter(view.container, "United States");
  const select = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Search filter mode"]',
  )!;
  await act(async () => {
    select.value = "prefer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", statement: "  Build systems  " }],
      },
    ],
    searchFilters: [
      { id: "region", statement: "United States", mode: "prefer" },
      { id: "agency", statement: "Staffing agencies", mode: "exclude" },
      { id: "startup", statement: "Small teams", mode: "prefer" },
    ],
  });
});

it("adds and removes filters, rejects blank statements, and can save no additional filters", async () => {
  const initial = searchFilterWorkspace();
  api.getWorkspace.mockResolvedValue(initial);
  api.editCriteria.mockResolvedValue(initial);
  const view = await mounted();
  await view.click("Edit search filters");
  await view.click("Add filter");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeSearchFilter(view.container, "Public robotics projects", 3);
  await view.click("Save");
  expect(api.editCriteria.mock.calls[0]?.[0].searchFilters.at(-1)).toEqual({
    id: expect.any(String),
    statement: "Public robotics projects",
    mode: "include",
  });
  await view.click("Edit search filters");
  while (view.container.querySelector('textarea[aria-label="Search filter"]'))
    await view.click("Remove filter");
  await view.click("Save");
  expect(api.editCriteria.mock.calls.at(-1)?.[0].searchFilters).toEqual([]);
});

it("retains failed filter edits across refresh without silently adopting a newer version", async () => {
  const initial = searchFilterWorkspace();
  api.getWorkspace.mockResolvedValue(initial);
  api.editCriteria.mockRejectedValue(new ORPCError("CONFLICT"));
  const view = await mounted();
  await view.click("Edit search filters");
  await changeSearchFilter(view.container, "Keep this filter draft");
  await view.click("Save");
  api.getWorkspace.mockResolvedValue({
    ...initial,
    revision: { ...initial.revision, revision: 3, id: "revision-3" },
  });
  await view.click("Refresh");
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search filter"]')
      ?.value,
  ).toBe("Keep this filter draft");
  await view.click("Save");
  expect(api.editCriteria.mock.calls.at(-1)?.[0].expectedRevision).toBe(2);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be saved",
  );
});

it("keeps newer filter edits during save and advances only to the returned revision", async () => {
  const initial = searchFilterWorkspace();
  api.getWorkspace.mockResolvedValue(initial);
  let finish!: (value: typeof initial) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Edit search filters");
  await changeSearchFilter(view.container, "Submitted filter");
  await view.click("Save");
  await changeSearchFilter(view.container, "Newer filter draft");
  const saved = {
    ...initial,
    revision: {
      ...initial.revision,
      id: "revision-3",
      revision: 3,
      brief: {
        ...initial.revision.brief,
        searchFilters: initial.revision.brief.searchFilters.map((item, index) =>
          index ? item : { ...item, statement: "Submitted filter" },
        ),
      },
    },
  };
  api.getWorkspace.mockResolvedValue(saved);
  await act(async () => finish(saved));
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search filter"]')
      ?.value,
  ).toBe("Newer filter draft");
  api.editCriteria.mockResolvedValue(saved);
  await view.click("Save");
  expect(api.editCriteria.mock.calls.at(-1)?.[0]).toMatchObject({
    expectedRevision: 3,
    searchFilters: [
      { id: "region", statement: "Newer filter draft", mode: "include" },
      { id: "agency" },
      { id: "startup" },
    ],
  });
});

it("edits search filters without introducing a qualification prerequisite", async () => {
  const initial = searchFilterWorkspace();
  api.getWorkspace.mockResolvedValue({
    ...initial,
    revision: { ...initial.revision, criteria: [] },
  });
  api.editCriteria.mockResolvedValue(initial);
  const view = await mounted();
  await view.click("Edit search filters");
  await changeSearchFilter(view.container, "United States");
  await view.click("Save");
  expect(api.editCriteria.mock.calls[0]?.[0]).toMatchObject({
    criteria: [],
    searchFilters: [
      { id: "region", statement: "United States", mode: "include" },
      { id: "agency" },
      { id: "startup" },
    ],
  });
});

it.each(["success", "failure"])(
  "ignores a late filter save after switching thread (%s)",
  async (outcome) => {
    const initial = searchFilterWorkspace();
    api.getWorkspace.mockResolvedValue(initial);
    let finish!: (value: typeof initial) => void;
    let fail!: (reason: Error) => void;
    api.editCriteria.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    );
    const view = await mounted();
    await view.click("Edit search filters");
    await changeSearchFilter(view.container, "Previous role filter");
    await view.click("Save");
    const next = {
      role: {
        ...initial.role,
        id: "next-role",
        currentRevisionId: "next-revision",
        title: "Other role",
      },
      revision: { ...initial.revision, id: "next-revision", roleId: "next-role" },
    };
    api.getWorkspace.mockResolvedValue(next);
    await view.render("next-thread", 1);
    expect(view.container.querySelector('textarea[aria-label="Search filter"]')).toBeNull();
    await view.click("Edit search filters");
    await changeSearchFilter(view.container, "Next role filter");
    const reads = api.getWorkspace.mock.calls.length;
    await act(async () =>
      outcome === "success" ? finish(initial) : fail(new Error("Old save failed")),
    );
    expect(api.getWorkspace).toHaveBeenCalledTimes(reads);
    expect(
      view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search filter"]')
        ?.value,
    ).toBe("Next role filter");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  },
);

it("edits one shared atom definition across repeated leaves and criteria", async () => {
  const shared = revision.criteria[0]!;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      criteria: [
        { ...shared, expression: { kind: "any", items: [shared.expression, shared.expression] } },
        { ...shared, id: "criterion-2", priority: "preferred" },
      ],
    },
  });
  const view = await mounted();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Build shared systems");
  expect([...view.container.querySelectorAll("textarea")].map((item) => item.value)).toEqual([
    "Build shared systems",
    "Build shared systems",
    "Build shared systems",
  ]);
  api.editCriteria.mockResolvedValue(savedCriteria());
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", statement: "Build shared systems" }],
      },
      {
        criterionId: "criterion-2",
        priority: "preferred",
        atoms: [{ atomId: "atom-1", statement: "Build shared systems" }],
      },
    ],
  });
});

it.each([new Error("offline"), new ORPCError("CONFLICT")])(
  "keeps edited criteria after a save failure %s and same-role refresh",
  async (error) => {
    api.editCriteria.mockRejectedValue(error);
    const view = await mounted();
    await view.click("Edit criteria");
    await changeStatement(view.container, "Keep this draft");
    await view.click("Save");
    expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft",
    );
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be saved",
    );
    api.getWorkspace.mockResolvedValue(savedCriteria("Server edited systems"));
    await view.click("Refresh");
    expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft",
    );
    await view.click("Cancel");
    expect(view.container.textContent).toContain("Server edited systems");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  },
);

it("keeps newer edits made while saving and saves them against the returned revision", async () => {
  let finish!: (value: ReturnType<typeof savedCriteria>) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Build reliable systems");
  await view.click("Save");
  await changeStatement(view.container, "Build observable systems");
  const saved = savedCriteria();
  api.getWorkspace.mockResolvedValue(saved);
  await act(async () => finish(saved));
  expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "Build observable systems",
  );
  api.editCriteria.mockResolvedValue(saved);
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 3,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", statement: "Build observable systems" }],
      },
    ],
  });
});

it.each([
  ["role", "success"],
  ["role", "failure"],
  ["thread", "success"],
  ["thread", "failure"],
])("discards a late criteria save after switching %s (%s)", async (scope, outcome) => {
  let finish!: (value: ReturnType<typeof savedCriteria>) => void;
  let fail!: (reason: Error) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Old role draft");
  await view.click("Save");
  const next = {
    role: {
      ...role,
      id: "role-next",
      title: "Compiler engineer",
      currentRevisionId: "revision-next",
    },
    revision: { ...revision, roleId: "role-next", id: "revision-next" },
  };
  api.getWorkspace.mockResolvedValue(next);
  await view.render(scope === "thread" ? "thread-next" : "thread-1", 1);
  expect(view.container.querySelector("textarea")).toBeNull();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Next role draft");
  const reads = api.getWorkspace.mock.calls.length;
  await act(async () =>
    outcome === "success" ? finish(savedCriteria()) : fail(new Error("Old save failed")),
  );
  expect(api.getWorkspace).toHaveBeenCalledTimes(reads);
  expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "Next role draft",
  );
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});

it("refreshes brief confirmation and saved assessments after editing criteria", async () => {
  const brief = {
    fields: [],
    questions: [],
    rules: [],
    searchFilters: [],
    confirmation: {
      revision: 2,
      userId: "user-1",
      messageId: "confirmation-message",
      confirmedAt: "2026-01-01T00:00:00Z",
    },
  };
  api.getWorkspace.mockResolvedValue({ role, revision: { ...revision, brief } });
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      isCurrent: true,
      roleRevision: revision,
      assessment: { ...assessment.assessment, roleRevisionId: revision.id },
    },
  ]);
  const view = await mounted();
  expect(view.container.textContent).toContain("Brief confirmed");
  await view.click("Edit criteria");
  await changeStatement(view.container, "Build reliable systems");
  const saved = savedCriteria();
  const next = {
    ...saved,
    revision: { ...saved.revision, brief: { ...brief, confirmation: null } },
  };
  api.editCriteria.mockResolvedValue(next);
  api.getWorkspace.mockResolvedValue(next);
  api.listAssessments.mockResolvedValue([{ ...assessment, isCurrent: false }]);
  await view.click("Save");
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(view.container.textContent).toContain("Build reliable systems");
  expect(view.container.textContent).not.toContain("Brief confirmed");
  await view.click("Evidence");
  expect(view.container.textContent).toContain("Outdated");
});

it.each(["text/plain", "text/html", "application/json"])(
  "opens attested legacy %s source text with the exact quote highlighted and reads only",
  async (mimeType) => {
    const text = "  Before\r\nBuilt a compiler 😀\n<script>window.bad = true</script>  ";
    const quote = "Built a compiler 😀";
    const f = artifactSourceFixture(
      mimeType === "application/json" ? JSON.stringify({ text }) : text,
      mimeType,
    );
    const { selection: _, ...legacy } = f.source;
    api.getWorkspace.mockResolvedValue({
      role,
      revision: {
        ...revision,
        criteria: [],
        sourceRefs: [{ ...legacy, quote, anchor: { ...legacy.anchor, locator: "text" } }],
      },
    });
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted();
    expect(api.getById).not.toHaveBeenCalled();
    const details = await view.expand("text");
    await vi.waitFor(() => expect(details.querySelector("pre mark")?.textContent).toBe(quote));
    expect(details.querySelector("pre")?.textContent).toBe(text);
    expect(details.querySelector('pre[role="document"][aria-label="Source text"]')).not.toBeNull();
    expect(details.querySelector("mark")?.className).toBe("bg-accent text-accent-foreground");
    const metadata = details.querySelector("details");
    expect(metadata?.open).toBe(false);
    expect(metadata?.querySelector("summary")?.textContent).toBe("Details");
    expect(metadata?.textContent).toContain(f.reference.artifactId);
    expect(metadata?.textContent).toContain(f.reference.sha256);
    expect(details.textContent).toContain("Source text");
    expect(details.querySelector("script")).toBeNull();
    expect(details.querySelector('[data-artifact-id="artifact-source"]')).not.toBeNull();
    expect(api.getById).toHaveBeenCalledExactlyOnceWith({
      artifactId: f.reference.artifactId,
      includeDiagnostics: true,
    });
    for (const method of [
      api.createRole,
      api.bindRole,
      api.reviseRole,
      api.update,
      api.search,
      api.answer,
    ])
      expect(method).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(view.reveal).not.toHaveBeenCalled();
    await view.click("Refresh");
    expect(api.getById).toHaveBeenCalledTimes(1);
  },
);

it("projects a nested JSON string at exact UTF-16 offsets without normalizing escaped text", async () => {
  const quote = 'same\t"quoted"\\path 😀';
  const text = `  Prefix 😀\r\n${quote}\n${quote} trailing  `;
  const start = text.lastIndexOf(quote);
  const f = artifactSourceFixture(JSON.stringify({ rows: [{ detail: text }] }), "application/json");
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      assessment: {
        ...assessment.assessment,
        sourceRefs: [
          {
            ...f.source,
            kind: "provider_report",
            quote,
            selection: {
              kind: "artifact_json_string",
              path: ["rows", 0, "detail"],
              start,
              end: start + quote.length,
            },
          },
        ],
      },
    },
  ]);
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  expect(api.getById).not.toHaveBeenCalled();
  const details = await view.expand("Source excerpt");
  await vi.waitFor(() => expect(details.querySelector("mark")?.textContent).toBe(quote));
  expect(details.querySelector("pre")?.textContent).toBe(text);
  expect(details.querySelector("mark")?.previousSibling?.textContent).toBe(text.slice(0, start));
  expect(view.container.textContent).toContain("provider_report · read");
  expect(view.container.textContent).toContain("Unknown");
});

it.each(["id", "hash", "size", "access"])(
  "withholds source files and text when Artifact %s verification fails",
  async (failure) => {
    const f = artifactSourceFixture();
    api.getWorkspace.mockResolvedValue({
      role,
      revision: { ...revision, criteria: [], sourceRefs: [f.source] },
    });
    if (failure === "access")
      api.getById.mockRejectedValue(new Error("Private unrelated artifact details"));
    else
      api.getById.mockResolvedValue({
        ...f.artifact,
        ...(failure === "id" ? { id: "foreign-artifact" } : {}),
        ...(failure === "hash"
          ? { contentBase64: Buffer.from("Different source bytes").toString("base64"), size: 22 }
          : {}),
        ...(failure === "size" ? { size: f.artifact.size + 1 } : {}),
      });
    const view = await mounted();
    const details = await view.expand("Source excerpt");
    await vi.waitFor(() => expect(details.textContent).toContain("Source unavailable"));
    expect(details.querySelector("[data-artifact-id]")).toBeNull();
    expect(details.querySelector("pre")).toBeNull();
    expect(details.textContent).not.toContain("Private unrelated artifact details");
    expect(details.textContent).not.toContain("foreign-artifact");
  },
);

it.each(["quote", "range", "surrogate", "path", "utf8", "binary", "legacy locator"])(
  "keeps the original file available without inventing text for an invalid %s source",
  async (failure) => {
    const text = "Before\nBuilt a compiler 😀\nAfter";
    const f = artifactSourceFixture(
      failure === "path"
        ? JSON.stringify({ rows: [{ detail: text }] })
        : failure === "utf8"
          ? new Uint8Array([0xc3, 0x28])
          : text,
      failure === "path"
        ? "application/json"
        : failure === "binary"
          ? "application/pdf"
          : "text/plain",
    );
    const source: RecruitingAssessmentSourceRef = {
      ...f.source,
      ...(failure === "quote" ? { quote: "A different quote" } : {}),
      ...(failure === "range"
        ? { selection: { kind: "artifact_text", start: -1, end: text.length } }
        : {}),
      ...(failure === "surrogate"
        ? {
            quote: "\ude00",
            selection: {
              kind: "artifact_text",
              start: text.indexOf("😀") + 1,
              end: text.indexOf("😀") + 2,
            },
          }
        : {}),
      ...(failure === "path"
        ? {
            selection: {
              kind: "artifact_json_string",
              path: ["rows", "0", "detail"],
              start: 7,
              end: 23,
            },
          }
        : {}),
      ...(failure === "legacy locator" ? { selection: undefined } : {}),
    };
    api.getWorkspace.mockResolvedValue({
      role,
      revision: { ...revision, criteria: [], sourceRefs: [source] },
    });
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted();
    const details = await view.expand("Source excerpt");
    await vi.waitFor(() => expect(details.textContent).toContain("Source unavailable"));
    expect(details.querySelector('[data-artifact-id="artifact-source"]')).not.toBeNull();
    expect(details.querySelector("pre")).toBeNull();
    expect(details.querySelector("mark")).toBeNull();
  },
);

it("replaces the excerpt when selection changes and ignores the late old selection read", async () => {
  const text = "First excerpt\nSecond excerpt";
  const f = artifactSourceFixture(text);
  const first = {
    ...f.source,
    quote: "First excerpt",
    selection: { kind: "artifact_text" as const, start: 0, end: 13 },
  };
  const second = {
    ...f.source,
    quote: "Second excerpt",
    selection: { kind: "artifact_text" as const, start: 14, end: text.length },
  };
  let finish!: (artifact: typeof f.artifact) => void;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [], sourceRefs: [first] },
  });
  api.getById
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.expand("Source excerpt");
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [], sourceRefs: [second] },
  });
  await view.click("Refresh");
  await vi.waitFor(() =>
    expect(view.container.querySelector("pre mark")?.textContent).toBe("Second excerpt"),
  );
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.querySelector("pre mark")?.textContent).toBe("Second excerpt");
});

it("does not carry expanded evidence or a late source response into another thread", async () => {
  const f = artifactSourceFixture();
  let finish!: (artifact: typeof f.artifact) => void;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [], sourceRefs: [f.source] },
  });
  api.getById.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.expand("Source excerpt");
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-2");
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.textContent).not.toContain("original-material.txt");
  expect(view.container.textContent).not.toContain("Source excerpt");
});

it("does not carry expanded evidence or a late source response into another candidate", async () => {
  const f = artifactSourceFixture();
  const original = {
    ...assessment,
    assessment: { ...assessment.assessment, sourceRefs: [f.source] },
  };
  const second = {
    ...original,
    assessment: { ...original.assessment, candidateKey: "candidate-2" },
  };
  let finish!: (artifact: typeof f.artifact) => void;
  api.listAssessments.mockResolvedValue([original, second]);
  api.getById.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  await view.expand("Source excerpt");
  await view.click("candidate-2");
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
  expect(api.getById).toHaveBeenCalledTimes(1);
});

it("does not carry expanded evidence into another role with the same source reference", async () => {
  const f = artifactSourceFixture();
  const original = { ...revision, criteria: [], sourceRefs: [f.source] };
  api.getWorkspace.mockResolvedValue({ role, revision: original });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.expand("Source excerpt");
  await vi.waitFor(() =>
    expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
  );
  const nextRole = { ...role, id: "role-next", currentRevisionId: "revision-next" };
  api.getWorkspace.mockResolvedValue({
    role: nextRole,
    revision: { ...original, id: nextRole.currentRevisionId, roleId: nextRole.id },
  });
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [], actions: [], observations: [] });
  await view.click("Refresh");
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
});

it.each(["thread", "assessment sources", "research", "questions", "user memory", "bot memory"])(
  "logs only error metadata when %s access is revoked and clears previously opened evidence",
  async (boundary) => {
    const f = artifactSourceFixture();
    api.listAssessments.mockResolvedValue([
      { ...assessment, assessment: { ...assessment.assessment, sourceRefs: [f.source] } },
    ]);
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted("thread-1", "owner-bot");
    await view.click("Evidence");
    await view.click("candidate-1");
    await view.expand("Source excerpt");
    await vi.waitFor(() =>
      expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
    );
    const error = new ORPCError(
      boundary === "thread"
        ? "UNAUTHORIZED"
        : boundary === "bot memory"
          ? "FORBIDDEN"
          : "NOT_FOUND",
      { message: "Read denied", data: { payload: "private source payload" } },
    );
    if (boundary === "thread") api.getWorkspace.mockRejectedValueOnce(error);
    else if (boundary === "assessment sources") api.listAssessments.mockRejectedValueOnce(error);
    else if (boundary === "research") api.listResearch.mockRejectedValueOnce(error);
    else if (boundary === "questions") api.listQuestions.mockRejectedValueOnce(error);
    else if (boundary === "user memory") api.list.mockRejectedValueOnce(error);
    else api.list.mockImplementationOnce(async () => []).mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await view.click("Refresh");
    const calls = log.mock.calls;
    log.mockRestore();
    expect(calls).toEqual([
      [
        "Recruiting request failed",
        JSON.stringify({ name: error.name, code: error.code, message: error.message }),
      ],
    ]);
    expect(view.container.textContent).toContain("Could not load recruiting");
    expect(view.container.textContent).not.toContain("candidate-1");
    expect(view.container.textContent).not.toContain(f.source.quote);
    expect(view.container.querySelector("mark")).toBeNull();
    expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
    await view.click("Refresh");
    await view.click("Evidence");
    expect(view.container.textContent).toContain("candidate-1");
    expect(view.container.querySelector('section[aria-label="candidate-1"]')).toBeNull();
    await view.click("candidate-1");
    await view.expand("Source excerpt");
    await vi.waitFor(() =>
      expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
    );
    expect(api.getById).toHaveBeenCalledTimes(2);
  },
);

it.each(["recruiting reads", "memory reads"])(
  "clears opened evidence when %s deny access after a sibling already failed offline",
  async (boundary) => {
    const f = artifactSourceFixture();
    api.listAssessments.mockResolvedValue([
      { ...assessment, assessment: { ...assessment.assessment, sourceRefs: [f.source] } },
    ]);
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted("thread-1", "owner-bot");
    await view.click("Evidence");
    await view.click("candidate-1");
    await view.expand("Source excerpt");
    await vi.waitFor(() =>
      expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
    );
    let deny!: (error: ORPCError<"NOT_FOUND", unknown>) => void;
    const laterDenial = new Promise((_, reject) => {
      deny = reject;
    });
    if (boundary === "recruiting reads") {
      api.listResearch.mockRejectedValueOnce(new Error("offline"));
      api.listAssessments.mockReturnValueOnce(laterDenial);
    } else {
      api.list.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(laterDenial);
    }
    await view.click("Refresh");
    expect(view.container.textContent).toContain("Could not load recruiting");
    expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote);
    await act(async () => {
      deny(new ORPCError("NOT_FOUND"));
    });
    expect(view.container.querySelector("mark")).toBeNull();
    expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
    expect(view.container.textContent).not.toContain("candidate-1");
    expect(view.container.textContent).not.toContain(f.source.quote);
  },
);

it("shows unassessed raw provider rows from saved Artifacts without creating an assessment or search", async () => {
  const f = rawResultsFixture();
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  expect(api.getById).not.toHaveBeenCalled();
  await view.click("Evidence");
  await view.expand("Raw search results");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Synthetic raw candidate"));
  expect(
    view.container.querySelector('[data-research-action="raw-action"] > summary')?.textContent,
  ).toBe("Raw search results · continue · Role · Outdated");
  expect(view.container.textContent).not.toContain("Unassessed");
  expect(view.container.textContent).toContain("Research findings");
  expect(view.container.textContent).toContain("Strong Match");
  expect(view.container.textContent).toContain("https://example.test/profile");
  expect(view.container.textContent).toContain("Outdated");
  expect(api.getById).toHaveBeenCalledExactlyOnceWith({
    artifactId: f.reference.artifactId,
    includeDiagnostics: true,
  });
  for (const method of [api.createRole, api.bindRole, api.reviseRole, api.update, api.search])
    expect(method).not.toHaveBeenCalled();
});

it("keeps saved assessments visible when no domain research tasks exist", async () => {
  api.listResearch.mockResolvedValue({ tasks: [], actions: [], observations: [] });
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("candidate-1");
  expect(view.container.textContent).not.toContain("Raw search results");
  expect(api.getById).not.toHaveBeenCalled();
});

it("does not reload immutable result bytes when refresh returns the same source references", async () => {
  const f = rawResultsFixture();
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Synthetic raw candidate"));
  api.listResearch.mockResolvedValue({
    observations: [],
    tasks: [{ ...f.task }],
    actions: [{ ...f.action, outputArtifacts: [{ ...f.reference }] }],
  });
  await view.click("Refresh");
  expect(api.listResearch).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toContain("Synthetic raw candidate");
  expect(api.getById).toHaveBeenCalledTimes(1);
});

it("discards a pending result when refresh replaces that action's output references", async () => {
  const f = rawResultsFixture();
  const next = nativeOutput(
    f,
    rawResultsFixture(f.action.id, "Current raw snapshot").snapshot,
    "current-output",
  );
  let finish!: (artifact: typeof f.artifact) => void;
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.getById.mockImplementation(({ artifactId }) =>
    artifactId === f.artifact.id
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(next.artifact),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  api.listResearch.mockResolvedValue({
    observations: [],
    tasks: [f.task],
    actions: [{ ...f.action, outputArtifacts: [next.reference] }],
  });
  await view.click("Refresh");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Current raw snapshot"));
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.textContent).not.toContain("Synthetic raw candidate");
  expect(view.container.textContent).toContain("Current raw snapshot");
});

it("keeps different rows snapshots at the same cursor while excluding status receipts", async () => {
  const f = rawResultsFixture();
  const second = rawResultsFixture(f.action.id, "Changed raw candidate");
  const changed = nativeOutput(f, { ...second.snapshot, effectId: "second-read" }, "changed-page");
  const { rows: _, nextCursor: __, ...observation } = f.snapshot.observation;
  const status = nativeOutput(
    f,
    {
      ...f.snapshot,
      operation: "status",
      providerResult: { state: "completed", done: true },
      observation: { ...observation, observedProviderState: "completed", done: true },
    },
    "status-output",
  );
  const outputs = [f, changed, status];
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({
    observations: [],
    tasks: [f.task],
    actions: [{ ...f.action, outputArtifacts: outputs.map((output) => output.reference) }],
  });
  api.getById.mockImplementation(
    async ({ artifactId }) => outputs.find((output) => output.artifact.id === artifactId)!.artifact,
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Changed raw candidate"));
  expect(
    view.container.querySelectorAll(
      'section[aria-label="artifact-raw-action"], section[aria-label="changed-page"]',
    ),
  ).toHaveLength(2);
  expect(view.container.querySelector('section[aria-label="status-output"]')).toBeNull();
  expect(view.container.textContent).toContain("Synthetic raw candidate");
  expect(view.container.textContent).toContain("  real-cursor==  ");
  expect(view.container.textContent).toContain('"nextCursor": null');
  expect(view.container.textContent).toContain("second-read");
  expect(view.container.textContent).not.toContain('"effectId": "mutation-effect"');
});

it.each(["hash", "action", "artifact", "access"])(
  "does not display raw rows after %s validation fails",
  async (boundary) => {
    const f = rawResultsFixture();
    let artifact = f.artifact;
    if (boundary === "hash")
      artifact = { ...artifact, contentBase64: Buffer.from("{}").toString("base64") };
    if (boundary === "action") {
      const foreign = nativeOutput(
        f,
        { ...f.snapshot, actionId: "foreign-action" },
        f.reference.artifactId,
      );
      f.reference.sha256 = foreign.reference.sha256;
      artifact = foreign.artifact;
    }
    if (boundary === "artifact") artifact = { ...artifact, id: "foreign-artifact" };
    api.listAssessments.mockResolvedValue([]);
    api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
    if (boundary === "access") api.getById.mockRejectedValue(new Error("Private source details"));
    else api.getById.mockResolvedValue(artifact);
    const view = await mounted();
    await view.click("Evidence");
    await view.expand("Raw search results");
    await vi.waitFor(() =>
      expect(view.container.textContent).toContain("Could not load search results"),
    );
    expect(view.container.textContent).not.toContain("Synthetic raw candidate");
    expect(view.container.textContent).not.toContain("Private source details");
  },
);

it("discards a late original action Artifact after navigation to another thread", async () => {
  const f = rawResultsFixture();
  let finish!: (artifact: typeof f.artifact) => void;
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action], observations: [] });
  api.getById.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-2");
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.textContent).not.toContain("Synthetic raw candidate");
  expect(view.container.textContent).not.toContain("Raw search results");
});

const nativeQuestion = {
  effectId: "question-effect",
  roleId: role.id,
  roleRevisionId: revision.id,
  target: {
    kind: "candidate",
    candidateKey: "candidate-1",
    assessmentVersion: 1,
    criterionIds: ["criterion-1"],
  },
  threadId: "origin-thread",
  botId: "origin-bot",
  groupId: "origin-group",
  runId: "origin-run",
  messageId: "origin-question",
  askIndex: 0,
  block: {
    kind: "ask",
    text: "Which component did the candidate implement?",
    status: "pending",
    actions: [
      { id: "choice-1", label: "Coordinate transforms" },
      { id: "choice-2", label: "Need more evidence" },
    ],
  },
  runStatus: "waiting_input",
  isCurrent: true,
  canAnswer: true,
} satisfies RecruitingQuestion;

it("answers the original native group question and reloads its persisted answered state", async () => {
  api.listQuestions.mockResolvedValue({ questions: [nativeQuestion] });
  const view = await mounted("thread-1", "current-bot");
  expect(api.listQuestions).toHaveBeenCalledWith({ threadId: "thread-1", roleId: role.id });
  await view.click("Missing info");
  expect(view.container.textContent).toContain(nativeQuestion.block.text);
  expect(view.container.textContent).toContain("candidate-1");
  api.listQuestions.mockResolvedValue({
    questions: [
      {
        ...nativeQuestion,
        block: { ...nativeQuestion.block, status: "answered", answer: "choice-1" },
        runStatus: "queued",
        canAnswer: false,
      },
    ],
  });
  await view.click("Coordinate transforms");
  expect(api.answer).toHaveBeenCalledExactlyOnceWith({
    groupId: "origin-group",
    runId: "origin-run",
    messageId: "origin-question",
    answer: "choice-1",
  });
  expect(api.listQuestions).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toContain("Answered: Coordinate transforms");
  await view.click("Open original question");
  expect(view.reveal).toHaveBeenCalledExactlyOnceWith({
    groupId: "origin-group",
    messageId: "origin-question",
  });
});

it("submits custom input to the native originating bot without creating a new task", async () => {
  api.listQuestions.mockResolvedValue({ questions: [{ ...nativeQuestion, groupId: null }] });
  const view = await mounted();
  await view.click("Missing info");
  const answer = " \n  Implemented the geometry library in C++ 😀\n  ";
  const input = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      answer,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await view.click("Send answer");
  expect(api.answer).toHaveBeenCalledExactlyOnceWith({
    botId: "origin-bot",
    runId: "origin-run",
    messageId: "origin-question",
    answer,
  });
  expect(api.createRole).not.toHaveBeenCalled();
  expect(api.bindRole).not.toHaveBeenCalled();
  expect(api.search).not.toHaveBeenCalled();
});

it("keeps answered native questions visible and leaves stale cancelled cards inactive", async () => {
  api.listQuestions.mockResolvedValue({
    questions: [
      {
        ...nativeQuestion,
        isCurrent: false,
        canAnswer: false,
        runStatus: "cancelled",
      },
      {
        ...nativeQuestion,
        effectId: "answered-effect",
        messageId: "answered-question",
        block: { ...nativeQuestion.block, status: "answered", answer: "choice-2" },
        isCurrent: false,
        canAnswer: false,
        runStatus: "completed",
      },
    ],
  });
  const view = await mounted();
  await view.click("Missing info");
  expect(view.container.textContent).toContain("No longer active");
  expect(view.container.textContent).toContain("Answered: Need more evidence");
  expect(view.container.textContent).toContain("Outdated");
  expect(
    [...view.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Coordinate transforms",
    ),
  ).toBe(false);
  expect(api.answer).not.toHaveBeenCalled();
});

it("distinguishes an empty shortlist from the saved pool and browses all candidates without selecting anyone", async () => {
  const page = candidatePage([]);
  page.counts.shortlisted = 0;
  api.listCandidates.mockResolvedValue(page);
  const browse = vi.fn();
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    view: "shortlist",
    tab: "evidence",
    onBrowseCandidates: browse,
  });
  expect(view.container.textContent).toContain("No shortlisted candidates yet.");
  expect(view.container.textContent).not.toContain("No saved candidates");
  expect(view.container.textContent).toContain("12");
  await view.click("Browse all candidates");
  expect(browse).toHaveBeenCalledOnce();
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  expect(api.answer).not.toHaveBeenCalled();
});

it("shows native answer failures without marking a question answered", async () => {
  api.listQuestions.mockResolvedValue({ questions: [nativeQuestion] });
  api.answer.mockRejectedValueOnce(new Error("This prompt is no longer awaiting an answer"));
  const view = await mounted();
  await view.click("Missing info");
  await view.click("Need more evidence");
  expect(view.container.textContent).toContain("This prompt is no longer awaiting an answer");
  expect(view.container.textContent).not.toContain("Answered: Need more evidence");
  expect(api.listQuestions).toHaveBeenCalledOnce();
});

it("does not publish questions from a role changed while the read was pending", async () => {
  let finish!: (value: { questions: (typeof nativeQuestion)[] }) => void;
  api.listQuestions.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  const nextRole = { ...role, id: "role-2", currentRevisionId: "revision-next" };
  api.getWorkspace.mockResolvedValue({
    role: nextRole,
    revision: { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id },
  });
  await act(async () => finish({ questions: [nativeQuestion] }));
  await view.click("Missing info");
  expect(view.container.textContent).not.toContain(nativeQuestion.block.text);
  expect(api.listQuestions).toHaveBeenLastCalledWith({ threadId: "thread-1", roleId: nextRole.id });
});
it("reads the native five views and lazily resolves memory history and Artifact references", async () => {
  const view = await mounted();
  expect(view.container.textContent).toContain("Systems engineer");
  expect(view.container.textContent).toContain("Version 2");
  expect(api.getWorkspace).toHaveBeenCalledWith({ threadId: "thread-1" });
  expect(api.listAssessments).toHaveBeenCalledWith({ roleId: role.id });
  expect(api.listResearch).toHaveBeenCalledWith({ roleId: role.id });
  expect(api.list).toHaveBeenCalledExactlyOnceWith({ scope: "user" });
  expect(api.history).not.toHaveBeenCalled();
  expect(api.getById).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("Outdated");
  await view.click("candidate-1");
  expect(view.container.textContent).toContain("Unknown");
  expect(view.container.textContent).toContain("Built a compiler");
  await view.click("Missing info");
  expect(view.container.textContent).toContain("Which location?");
  expect(view.container.textContent).toContain("Which component?");
  await view.click("Memory");
  await view.expand("preferences.md");
  await view.click("History");
  expect(api.history).toHaveBeenCalledWith({ documentId: "doc-1" });
  expect(view.container.textContent).toContain("Earlier preference");
  await view.click("Activity");
  expect(view.container.textContent).toContain("Compiler teams");
  await view.expand("Request");
  expect(api.getById).toHaveBeenCalledWith({
    artifactId: "artifact-request",
    includeDiagnostics: true,
  });
  expect(
    view.container
      .querySelector('[data-artifact-id="artifact-request"]')
      ?.getAttribute("data-bot-id"),
  ).toBe("source-bot");
  expect(view.container.textContent).toContain("request.json");
  for (const method of [api.createRole, api.bindRole, api.reviseRole, api.update, api.search])
    expect(method).not.toHaveBeenCalled();
});
it("discards the old thread response and does not carry its role into the next thread", async () => {
  let finish!: (value: { role: RecruitingRole; revision: RecruitingRoleRevision }) => void;
  api.getWorkspace
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(null);
  const view = await mounted();
  await view.render("thread-2");
  await act(async () => finish({ role, revision }));
  expect(view.container.textContent).not.toContain(role.title);
  expect(view.container.textContent).toContain("No role linked");
  expect(api.listResearch).not.toHaveBeenCalled();
});
it("keeps known results when a refresh fails and recovers on explicit refresh", async () => {
  const view = await mounted();
  api.getWorkspace.mockRejectedValueOnce(new Error("offline"));
  await view.click("Refresh");
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.textContent).toContain(role.title);
  api.getWorkspace.mockResolvedValue(null);
  await view.click("Refresh");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.textContent).toContain("No role linked");
});
it("restores only the native panel preference and still performs reads only", async () => {
  writeRightPanelState("layout", "recruiting");
  expect(readRightPanelState("layout")).toEqual({ panel: "recruiting" });
  const view = await mounted("thread-1", "bot-1");
  expect(api.list).toHaveBeenCalledWith({ scope: "bot", botId: "bot-1" });
  for (const name of ["Evidence", "Missing info", "Memory", "Activity", "Role"])
    await view.click(name);
  expect(api.getWorkspace).toHaveBeenCalledTimes(3);
  for (const method of [api.createRole, api.bindRole, api.reviseRole, api.update, api.search])
    expect(method).not.toHaveBeenCalled();
  expect(localStorage.getItem("layout")).toBe('{"panel":"recruiting"}');
});
it("distinguishes empty saved assessments from a successful candidate search", async () => {
  api.listAssessments.mockResolvedValue([]);
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("No saved candidates");
  expect(api.search).not.toHaveBeenCalled();
});
it("keeps saved facts and sources inspectable even before a criterion judgment exists", async () => {
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      assessment: {
        ...assessment.assessment,
        judgments: { ...assessment.assessment.judgments, atoms: [], criteria: [] },
        sourceRefs: [
          assessmentSource,
          {
            ...assessmentSource,
            id: "source-2",
            quote: "Additional material",
            selection: {
              kind: "message_text",
              blockIndex: 1,
              start: 0,
              end: "Additional material".length,
            },
          },
        ],
      },
    },
  ]);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  expect(view.container.textContent).toContain("Built a compiler");
  expect(view.container.textContent).toContain("Additional material");
});
it("discards late evidence reads from a previously selected thread", async () => {
  let finish!: (value: (typeof assessment)[]) => void;
  api.listAssessments.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-2");
  await act(async () => finish([assessment]));
  expect(view.container.textContent).toContain("No role linked");
  await view.click("Evidence");
  expect(view.container.textContent).toContain("No role linked");
  expect(view.container.textContent).not.toContain("candidate-1");
});
it("preserves saved evidence when a later research read fails", async () => {
  const view = await mounted();
  api.listResearch.mockRejectedValueOnce(new Error("offline"));
  await view.click("Refresh");
  await view.click("Evidence");
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.textContent).toContain("candidate-1");
});

it("never guesses a native message route for material from another chat", async () => {
  const view = await mounted();
  const roleSources = [...view.container.querySelectorAll("details")].find(
    (item) => item.querySelector("summary")?.textContent === "Role sources",
  )!;
  expect(roleSources.textContent).toContain("Message");
  expect(roleSources.textContent).toContain(source.quote);
  expect(roleSources.textContent).not.toContain("message-1");
  expect(roleSources.querySelector("button")).toBeNull();
  expect(roleSources.querySelector('a[href*="?m="]')).toBeNull();
});
it("reloads the same thread on native invalidation and rejects its old delayed assessments", async () => {
  let finish!: (value: (typeof assessment)[]) => void;
  const pending = new Promise<(typeof assessment)[]>((resolve) => {
    finish = resolve;
  });
  api.listAssessments.mockImplementation(({ roleId }: { roleId: string }) =>
    roleId === role.id ? pending : Promise.resolve([]),
  );
  const view = await mounted();
  const next = {
    role: { ...role, id: "role-2", title: "Hardware engineer", currentRevisionId: "revision-b" },
    revision: { ...revision, id: "revision-b", roleId: "role-2" },
  };
  api.getWorkspace.mockResolvedValue(next);
  await view.render("thread-1", 1);
  expect(view.container.textContent).toContain("Hardware engineer");
  await act(async () => finish([assessment]));
  expect(view.container.textContent).not.toContain(role.title);
  await view.click("Evidence");
  expect(view.container.textContent).not.toContain("candidate-1");
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-1", 2);
  await view.click("Role");
  expect(view.container.textContent).toContain("No role linked");
});
it("rechecks the binding and revision after reading lists before publishing them", async () => {
  const next = {
    role: { ...role, currentRevisionId: "revision-3", revision: 3 },
    revision: { ...revision, id: "revision-3", revision: 3 },
  };
  api.getWorkspace.mockResolvedValueOnce({ role, revision }).mockResolvedValue(next);
  api.listAssessments.mockResolvedValueOnce([assessment]).mockResolvedValue([]);
  const view = await mounted();
  expect(view.container.textContent).toContain("Version 3");
  await view.click("Evidence");
  expect(view.container.textContent).toContain("No saved candidates");
  expect(api.listAssessments).toHaveBeenCalledTimes(2);
});
it("drops cached Artifact metadata when its exact reference changes", async () => {
  const next = artifactSourceFixture('{"next":true}', "application/json", "request-2");
  const view = await mounted();
  await view.click("Activity");
  await view.expand("Request");
  expect(view.container.textContent).toContain("request.json");
  const research = await api.listResearch.mock.results[0]!.value;
  api.listResearch.mockResolvedValue({
    ...research,
    actions: [
      {
        ...research.actions[0],
        requestArtifact: next.reference,
      },
    ],
  });
  api.getById.mockResolvedValue({
    ...next.artifact,
    botId: null,
    groupId: "source-group",
    name: "request-2.json",
  });
  await view.click("Refresh");
  expect(view.container.textContent).not.toContain("request.json");
  await view.expand("Request");
  expect(api.getById).toHaveBeenCalledWith({
    artifactId: "request-2",
    includeDiagnostics: true,
  });
  expect(
    view.container.querySelector('[data-artifact-id="request-2"]')?.getAttribute("data-group-id"),
  ).toBe("source-group");
});
it("states which memory scopes a group actually queries", async () => {
  api.list.mockResolvedValue([]);
  const view = await mounted();
  await view.click("Memory");
  expect(view.container.textContent).toContain("User memory");
  expect(view.container.textContent).toContain("Group bot memory is not included");
  expect(view.container.textContent).toContain("No saved memory in these scopes");
  expect(api.list).toHaveBeenCalledExactlyOnceWith({ scope: "user" });
});

it.each([60, null])(
  "renders the saved unknown hard gate, preferred verdict and employment upper bound %s without recomputing qualification",
  async (upperMonths) => {
    const qualificationDefinition = "Full-time relevant systems work";
    const preferred = {
      ...revision.criteria[0]!,
      id: "preferred-criterion",
      priority: "preferred" as const,
      expression: { kind: "atom" as const, id: "preferred-atom", statement: "Compiler experience" },
      definitionQuestions: [],
    };
    api.getWorkspace.mockResolvedValue({
      role,
      revision: { ...revision, criteria: [...revision.criteria, preferred] },
    });
    const quote = "  Built a compiler.\r\n";
    const saved = {
      ...assessment.assessment,
      roleRevisionId: revision.id,
      facts: [
        ...assessment.assessment.facts,
        {
          kind: "employment",
          id: "job-1",
          statement: "Worked on infrastructure",
          sourceRefIds: [source.id],
          employmentType: "full-time",
          start: { precision: "year", year: 2020 },
          end: "present",
        },
      ],
      sourceRefs: [
        {
          ...assessmentSource,
          quote,
          selection: { kind: "message_text", blockIndex: 0, start: 3, end: 3 + quote.length },
        },
      ],
      judgments: {
        atoms: [
          ...assessment.assessment.judgments.atoms,
          {
            atomId: "preferred-atom",
            verdict: "met",
            factIds: ["fact-1"],
            evidence: [source.id],
            missing: [],
          },
        ],
        employment: [
          {
            atomId: "atom-1",
            intervals: [
              {
                factId: "job-1",
                qualifyingFullTime: "unknown",
                evidence: [source.id],
                missing: ["Confirm full-time work"],
              },
            ],
            historyCompletenessFactId: null,
            evidence: [source.id],
            missing: ["Complete the work history"],
            cutoff: { precision: "day", year: 2026, month: 10, day: 16 },
            minimumMonths: 84,
            countingRule: "complete_calendar_months",
            qualificationDefinition,
            lowerMonths: 36,
            upperMonths,
            verdict: "unknown",
            factIds: ["job-1"],
          },
        ],
        criteria: [
          ...assessment.assessment.judgments.criteria,
          {
            criterionId: preferred.id,
            verdict: "met",
            factIds: ["fact-1"],
            evidence: [source.id],
            missing: [],
          },
        ],
        hardGate: "unknown",
      },
    } satisfies RecruitingAssessment;
    api.listAssessments.mockResolvedValue([
      {
        ...assessment,
        assessment: saved,
        isCurrent: true,
        roleRevision: { ...revision, criteria: [...revision.criteria, preferred] },
      },
    ]);
    const view = await mounted();
    await view.click("Evidence");
    await view.click("candidate-1");
    const gate = [...view.container.querySelectorAll("p")].find(
      (item) => item.textContent === "Hard criteriaUnknown",
    );
    expect(gate).toBeDefined();
    const preferredSummary = [...view.container.querySelectorAll("summary")].find((item) =>
      item.textContent?.includes(preferred.expression.statement),
    );
    expect(preferredSummary?.textContent).toContain("Met");
    expect(view.container.textContent).toContain(`${36}–${upperMonths ?? "?"} months`);
    expect(view.container.textContent).toContain("≥ 84");
    expect(view.container.textContent).toContain("2026-10-16");
    expect(view.container.textContent).toContain(qualificationDefinition);
    expect(
      [...view.container.querySelectorAll("blockquote")].some((item) => item.textContent === quote),
    ).toBe(true);
    await view.click("Missing info");
    expect(view.container.textContent).toContain("Which component?");
  },
);

it("switches Cards/Table with one original-revision detail, preserves a refreshed candidate and rejects late data from another role", async () => {
  const additionalSource = {
    ...assessmentSource,
    id: "source-2",
    anchor: { ...source.anchor, messageId: "message-2", locator: "Additional evidence" },
    quote: "Independent source",
    selection: { ...assessmentSource.selection, end: "Independent source".length },
  };
  const original = {
    ...assessment,
    assessment: {
      ...assessment.assessment,
      facts: [
        ...assessment.assessment.facts,
        {
          kind: "statement",
          id: "fact-2",
          statement: "Maintained a compiler",
          sourceRefIds: [additionalSource.id],
        },
      ],
      sourceRefs: [...assessment.assessment.sourceRefs, additionalSource],
      judgments: {
        ...assessment.assessment.judgments,
        criteria: [
          {
            ...assessment.assessment.judgments.criteria[0]!,
            factIds: ["fact-1", "fact-2"],
            evidence: [source.id, additionalSource.id],
          },
        ],
      },
    },
    roleRevision: {
      ...assessment.roleRevision,
      criteria: [{ ...assessment.roleRevision.criteria[0]!, priority: "hard" as const }],
    },
  } satisfies RecruitingAssessmentSnapshot;
  const second = {
    ...assessment,
    assessment: {
      ...assessment.assessment,
      candidateKey: "candidate-2",
      facts: [{ ...assessment.assessment.facts[0]!, statement: "Second candidate evidence" }],
    },
    sourceMessageTargets: [
      {
        messageId: source.anchor.messageId,
        threadId: "second-material-thread",
        target: { botId: "second-material-bot" },
      },
    ],
  };
  api.listAssessments.mockResolvedValue([original, second]);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("Cards");
  expect(view.container.querySelector("table")).toBeNull();
  await view.click("candidate-1");
  const condition = [...view.container.querySelectorAll("details")].find((element) =>
    element.querySelector("summary")?.textContent?.includes("Original systems requirement"),
  );
  expect(condition).toBeDefined();
  expect(condition?.querySelector("summary")?.textContent).toContain("Hard criteria");
  expect([...condition!.querySelectorAll("blockquote")].map((item) => item.textContent)).toEqual([
    source.quote,
    additionalSource.quote,
  ]);
  expect(condition?.textContent).toContain("Built a compiler");
  expect(condition?.textContent).toContain("Maintained a compiler");
  expect(view.container.textContent).not.toContain("revision-1");
  expect(view.container.textContent).toContain("Role · Version 1");
  await view.click("Message");
  expect(view.reveal).toHaveBeenCalledExactlyOnceWith({
    groupId: "material-group",
    messageId: source.anchor.messageId,
  });
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  await view.click("Table");
  expect(view.container.querySelector("table caption")?.textContent).toBe("Saved candidates");
  expect(
    [...view.container.querySelectorAll("th[scope=col]")].map((element) => element.textContent),
  ).toEqual([
    "Candidate",
    "Role",
    "Title",
    "Company",
    "Location",
    "Profile",
    "Research match",
    "Internal assessment",
    "Discoveries",
    "Shortlist",
  ]);
  await view.click("candidate-1");
  expect(view.container.textContent).toContain("Original systems requirement");
  await view.click("Close");
  await view.click("candidate-2");
  expect(view.container.textContent).toContain("Second candidate evidence");
  expect(view.container.textContent).not.toContain("Built a compiler");
  const refreshed = {
    ...second,
    assessment: {
      ...second.assessment,
      version: 2,
      basedOnVersion: 1,
      facts: [{ ...second.assessment.facts[0]!, statement: "Second candidate updated evidence" }],
    },
  };
  api.listAssessments.mockResolvedValue([original, refreshed]);
  await view.click("Refresh");
  expect(view.container.querySelector("table")).not.toBeNull();
  expect(view.container.textContent).toContain("Second candidate updated evidence");
  await view.click("Close");
  await view.click("Cards");
  expect(view.container.querySelector("table")).toBeNull();
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  await view.click("candidate-2");
  expect(view.container.textContent).toContain("Second candidate updated evidence");
  await view.click("Message");
  expect(view.reveal).toHaveBeenLastCalledWith({
    botId: "second-material-bot",
    messageId: source.anchor.messageId,
  });
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  let finish!: (value: (typeof assessment)[]) => void;
  const pending = new Promise<(typeof assessment)[]>((resolve) => {
    finish = resolve;
  });
  api.listAssessments.mockReturnValueOnce(pending);
  await view.click("Refresh");
  const nextRole = { ...role, id: "role-next", currentRevisionId: "revision-next" };
  const nextRevision = { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id };
  api.getWorkspace.mockResolvedValue({ role: nextRole, revision: nextRevision });
  api.listAssessments.mockResolvedValue([
    {
      ...second,
      assessment: {
        ...second.assessment,
        roleId: nextRole.id,
        roleRevisionId: nextRevision.id,
        facts: [{ ...second.assessment.facts[0]!, statement: "Different role evidence" }],
      },
      roleRevision: nextRevision,
      isCurrent: true,
    },
  ]);
  await view.render("thread-1", 1);
  await act(async () => finish([original]));
  expect(view.container.textContent).not.toContain("Second candidate updated evidence");
  expect(view.container.textContent).not.toContain("Different role evidence");
  await view.click("candidate-2");
  expect(view.container.textContent).toContain("Different role evidence");
  expect(view.container.textContent).not.toContain("Built a compiler");
});

it("shows sourced brief prose and unresolved confirmation questions in Role and Missing info", async () => {
  const brief = {
    fields: [
      {
        key: "python_stack",
        value: "  Hands-on Python work\nwith production services.  ",
        origin: "jd" as const,
        state: "known" as const,
        consequential: true,
        sourceRefIds: [source.id],
      },
      {
        key: "ideal_background",
        value: "Research and platform teams both mentioned.",
        origin: "inferred" as const,
        state: "conflict" as const,
        consequential: true,
        sourceRefIds: [],
      },
      {
        key: "sourcing_quantity_scope",
        value: null,
        origin: "user_instruction" as const,
        state: "missing" as const,
        consequential: true,
        sourceRefIds: [],
      },
    ],
    questions: [
      {
        id: "background-question",
        fieldKey: "ideal_background",
        question: "Which background should guide this search?",
        answeredBySourceRefId: null,
      },
      {
        id: "quantity-question",
        fieldKey: "sourcing_quantity_scope",
        question: "How many candidates should we review?",
        answeredBySourceRefId: null,
      },
    ],
    rules: [],
    searchFilters: [],
    confirmation: null,
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      definitionQuestions: [brief.questions[0]!.question],
      criteria: revision.criteria.map((criterion) => ({
        ...criterion,
        definitionQuestions: [brief.questions[0]!.question],
      })),
    },
  });
  const view = await mounted("thread-1", undefined, false);
  expect(view.container.textContent).not.toContain("python stack");
  expect(view.container.textContent).not.toContain("ideal background");
  expect(view.container.textContent).not.toContain("sourcing quantity scope");
  const prose = [...view.container.querySelectorAll("p")].find(
    (item) => item.textContent === brief.fields[0]!.value,
  );
  expect(prose).toBeDefined();
  expect(prose?.className).toContain("whitespace-pre-wrap");
  expect(prose?.closest("li")?.querySelector("summary")?.textContent).toBe("Sources");
  expect(prose?.closest("li")?.textContent).toContain(source.quote);
  expect(view.container.textContent).toContain("Conflicting information");
  expect(view.container.textContent).toContain("Assumption");
  expect(view.container.textContent).toContain(brief.questions[0]!.question);
  expect(view.container.textContent).toContain(brief.questions[1]!.question);
  expect(
    [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm brief",
    )?.disabled,
  ).toBe(true);
  await view.click("Missing info");
  const definition = [...view.container.querySelectorAll("h3")].find(
    (item) => item.textContent === "Role definition",
  )!.parentElement!;
  expect([...definition.querySelectorAll("p")].map((item) => item.textContent)).toEqual([
    "What salary range may be stated in outreach?",
    brief.questions[0]!.question,
    brief.questions[1]!.question,
    "What location or remote work scope applies?",
  ]);
  await view.click("Role");
  await view.render("thread-1", 0, true);
  expect(view.container.textContent).toContain("python_stack");
  expect(view.container.textContent).toContain("sourcing_quantity_scope");
  expect(api.confirmBrief).not.toHaveBeenCalled();
});

it("names known brief details and asks their missing question without requesting another question", async () => {
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      definitionQuestions: [],
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
      brief: {
        fields: [
          {
            key: "salary_range",
            value: "GBP 90,000 to 120,000",
            state: "known",
            origin: "jd",
            consequential: true,
            sourceRefIds: [source.id],
          },
          {
            key: "location",
            value: "Remote in the United Kingdom",
            state: "known",
            origin: "jd",
            consequential: true,
            sourceRefIds: [source.id],
          },
          {
            key: "company_deck",
            value: null,
            state: "missing",
            origin: "jd",
            consequential: true,
            sourceRefIds: [],
          },
        ],
        questions: [],
        rules: [],
        searchFilters: [],
        confirmation: null,
      },
    },
  });
  const view = await mounted("thread-1", undefined, false);
  expect(view.container.textContent).toContain("Salary range");
  expect(view.container.textContent).toContain("Location");
  expect(view.container.textContent).toContain("GBP 90,000 to 120,000");
  await view.click("Missing info");
  const definition = [...view.container.querySelectorAll("h3")].find(
    (item) => item.textContent === "Role definition",
  )!.parentElement!;
  expect(definition.textContent).toContain("Is a company deck available?");
  expect(definition.textContent).not.toContain("Ask an agent to clarify in chat.");
  expect(definition.textContent).not.toContain("company_deck");
  expect(definition.textContent).not.toContain("salary_range");
  expect(definition.textContent).not.toContain("What salary range may be stated in outreach?");
  expect(api.confirmBrief).not.toHaveBeenCalled();
});

it.each(["missing", "conflict", "known"] as const)(
  "keeps an unphrased consequential %s field visible as unresolved without exposing its key",
  async (state) => {
    const key = "private_arbitrary_field_key";
    const value = state === "known" ? "Exact tentative scope" : null;
    api.getWorkspace.mockResolvedValue({
      role,
      revision: {
        ...revision,
        definitionQuestions: [],
        criteria: revision.criteria.map((criterion) => ({
          ...criterion,
          definitionQuestions: [],
        })),
        brief: {
          fields: [
            {
              key: "location",
              value: "Remote",
              origin: "jd",
              state: "known",
              consequential: true,
              sourceRefIds: [source.id],
            },
            {
              key: "salary_range",
              value: "GBP 90,000 to 120,000",
              origin: "jd",
              state: "known",
              consequential: true,
              sourceRefIds: [source.id],
            },
            {
              key,
              value,
              state,
              origin: state === "known" ? "inferred" : "jd",
              consequential: true,
              sourceRefIds: [source.id],
            },
          ],
          questions: [],
          rules: [],
          searchFilters: [],
          confirmation: null,
        },
      },
    });
    const view = await mounted("thread-1", undefined, false);
    expect(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Confirm brief",
      )?.disabled,
    ).toBe(true);
    await view.click("Missing info");
    const definition = [...view.container.querySelectorAll("h3")].find(
      (item) => item.textContent === "Role definition",
    )!.parentElement!;
    expect(definition.querySelector('[role="status"]')?.textContent).toBe(
      "Role details needing clarification: 1",
    );
    expect(definition.textContent).toContain("Ask an agent to clarify in chat.");
    expect(definition.textContent).toContain(
      state === "conflict"
        ? "Conflicting information"
        : state === "missing"
          ? "Missing info"
          : "Assumption",
    );
    if (value) expect(definition.textContent).toContain(value);
    expect(definition.textContent).toContain(source.quote);
    expect(definition.textContent).not.toContain("No saved questions");
    expect(definition.textContent).not.toContain(key);
    expect(definition.textContent).not.toContain(key.replaceAll("_", " "));
    expect(api.confirmBrief).not.toHaveBeenCalled();
  },
);

it("renders saved compound requirements with the same nested groups in Role and assessment", async () => {
  const expression = {
    kind: "all" as const,
    items: [
      { kind: "atom" as const, id: "atom-1", statement: "Build systems" },
      {
        kind: "any" as const,
        items: [
          { kind: "atom" as const, id: "atom-2", statement: "Use compilers" },
          {
            kind: "not" as const,
            item: { kind: "atom" as const, id: "atom-3", statement: "Only manage teams" },
          },
        ],
      },
    ],
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      criteria: [{ ...revision.criteria[0]!, expression }],
    },
  });
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      roleRevision: {
        ...assessment.roleRevision,
        criteria: [{ ...assessment.roleRevision.criteria[0]!, expression }],
      },
    },
  ]);
  const view = await mounted();
  function check(container: Element) {
    const groups = [...container.querySelectorAll("ul")].filter((list) =>
      ["All of", "Any of", "Must not"].includes(list.previousElementSibling?.textContent ?? ""),
    );
    expect(groups).toHaveLength(3);
    expect(groups[0]!.previousElementSibling?.textContent).toBe("All of");
    expect(groups[1]!.previousElementSibling?.textContent).toBe("Any of");
    expect(groups[2]!.previousElementSibling?.textContent).toBe("Must not");
    expect(groups[0]!.children).toHaveLength(2);
    expect(groups[1]!.children).toHaveLength(2);
    expect(groups[2]!.children).toHaveLength(1);
    expect(groups[0]!.children[1]!.contains(groups[1]!)).toBe(true);
    expect(groups[1]!.children[1]!.contains(groups[2]!)).toBe(true);
    expect(groups[2]!.textContent).toBe("Only manage teams");
    expect(container.textContent).not.toContain(" AND ");
    expect(container.textContent).not.toContain(" OR ");
    expect(container.textContent).not.toContain("NOT (");
  }
  check(view.container);
  await view.click("Evidence");
  await view.click("candidate-1");
  check(view.container.querySelector('[role="dialog"]')!);
  expect(api.editCriteria).not.toHaveBeenCalled();
});

it("shows the required salary question beside disabled confirmation when saved questions are empty", async () => {
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      definitionQuestions: [],
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
      brief: {
        fields: [
          {
            key: "location",
            value: "Remote in the United Kingdom",
            origin: "jd",
            state: "known",
            consequential: true,
            sourceRefIds: [source.id],
          },
        ],
        questions: [],
        rules: [],
        searchFilters: [],
        confirmation: null,
      },
    },
  });
  const view = await mounted("thread-1", undefined, false);
  const confirm = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Confirm brief",
  )!;
  expect(confirm.disabled).toBe(true);
  expect(confirm.parentElement!.textContent).toContain(
    "What salary range may be stated in outreach?",
  );
  expect(view.container.textContent).not.toContain("salary_range");
  expect(api.confirmBrief).not.toHaveBeenCalled();
});

it("confirms only the reviewed brief revision through the human API", async () => {
  const brief = {
    fields: [
      {
        key: "location",
        value: "Remote in the United Kingdom",
        origin: "jd",
        state: "known",
        consequential: true,
        sourceRefIds: [source.id],
      },
      {
        key: "salary_range",
        value: "GBP 90,000 to 120,000",
        origin: "jd",
        state: "known",
        consequential: true,
        sourceRefIds: [source.id],
      },
    ],
    questions: [],
    rules: [],
    searchFilters: [],
    confirmation: null,
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
    },
  });
  api.confirmBrief.mockResolvedValue({ role, revision });
  const view = await mounted();
  expect(api.confirmBrief).not.toHaveBeenCalled();
  await view.click("Confirm brief");
  expect(api.confirmBrief).toHaveBeenCalledWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
  });
});

it("keeps an unresolved brief unconfirmed and preserves its view after a conflict", async () => {
  const brief = {
    fields: [
      {
        key: "salary_range",
        value: null,
        origin: "jd",
        state: "conflict",
        consequential: true,
        sourceRefIds: [],
      },
      {
        key: "location",
        value: "Remote in the United Kingdom",
        origin: "jd",
        state: "known",
        consequential: true,
        sourceRefIds: [source.id],
      },
    ],
    questions: [],
    rules: [],
    searchFilters: [],
    confirmation: null,
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
    },
  });
  const view = await mounted();
  const button = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Confirm brief",
  );
  expect(button?.disabled).toBe(true);
  brief.fields[0] = {
    ...brief.fields[0]!,
    state: "known",
    value: "GBP 90,000 to 120,000",
  } as never;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
    },
  });
  await view.render("thread-1", 1);
  api.confirmBrief.mockRejectedValueOnce(new Error("Revision changed"));
  await view.click("Confirm brief");
  expect(view.container.textContent).toContain("Brief changed or could not be confirmed");
  expect(view.container.textContent).toContain("GBP 90,000 to 120,000");
  expect(view.container.textContent).not.toContain("Brief confirmed");
});

it("renders the sourcing workspace from saved findings and uses native draft, shortlist and detail actions", async () => {
  const candidate = {
    ...candidateFixture("workspace-person", false),
    name: "Taylor Example",
    title: "Robotics engineer",
    company: "Example Robotics",
    location: "Bay Area",
    linkedinUrl: "https://example.test/taylor",
    latestSource: {
      providerTaskId: "native-task",
      taskId: null,
      actionId: null,
      roleRevisionId: revision.id,
      effectId: "saved-page",
      rowIndex: 0,
      artifactRef: { artifactId: "saved-artifact", sha256: "a".repeat(64) },
      requestCursor: null,
      outputId: null,
      observedAt: "2026-01-01T00:00:00Z",
      report: {
        fields: [
          { label: "Match score", value: "5/6", sourceUrls: [] },
          {
            label: "Fit reasons",
            value: "Built robot data tools; database ownership is unknown.",
            sourceUrls: ["https://example.test/work"],
          },
          {
            label: "Company context",
            value: "Makes warehouse robots; this does not establish personal implementation.",
            sourceUrls: ["https://example.test/company"],
          },
        ],
        sourceUrls: ["https://example.test/work", "https://example.test/company"],
      },
    },
  };
  api.listAssessments.mockResolvedValue([]);
  api.listCandidates.mockResolvedValue(candidatePage([candidate]));
  api.setCandidateShortlist.mockResolvedValue({ ...candidate, shortlisted: true, revision: 1 });
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
  });
  await view.click("Cards");
  const card = view.container.querySelector(".hire-candidate-card");
  expect(card?.textContent).toContain("Taylor Example");
  expect(card?.textContent).toContain("Bay Area");
  expect(card?.querySelector(".hire-match-score")?.textContent).toBe("Match score: 5/6");
  expect(card?.textContent).not.toContain("% match");
  expect(card?.textContent).toContain("database ownership is unknown");
  expect(card?.textContent).toContain("does not establish personal implementation");
  expect(card?.textContent).toContain("Resume missing");
  expect(card?.querySelector('a[href="https://example.test/work"]')).not.toBeNull();
  expect(card?.querySelector('a[href="https://example.test/company"]')).not.toBeNull();
  await view.click("Email draft");
  expect(view.discuss).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      threadId: "thread-1",
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      roleTitle: role.title,
      name: candidate.name,
      intent: "email_draft",
    }),
  );
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  await view.click("Shortlist Taylor Example");
  expect(api.setCandidateShortlist).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    expectedRevision: 0,
    shortlisted: true,
  });
  await view.click("View Taylor Example");
  expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(
    view.container.querySelector(".hire-profile-drawer")?.getAttribute("data-product-view"),
  ).toBe("recruiting");
});

it("keeps workspace shortlist and contacts navigation out of saved filters and candidate mutations", async () => {
  api.listAssessments.mockResolvedValue([]);
  const page = candidatePage([{ ...candidateFixture("nav-person", false), name: "Nav Person" }]);
  page.counts.assessed = 0;
  api.listCandidates.mockResolvedValue(page);
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    view: "shortlist",
  });
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ roleId: role.id, shortlisted: true }),
    { signal: expect.any(AbortSignal) },
  );
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  api.listCandidates.mockClear();
  await view.render("thread-1", 0, false, undefined, {
    presentation: "workspace",
    view: "contacts",
  });
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ shortlisted: true }),
    { signal: expect.any(AbortSignal) },
  );
  expect(view.container.querySelector("tbody")?.textContent).toContain("Nav Person");
  expect([...view.container.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "Candidate",
    "Current role",
    "Company",
    "Location",
    "Email",
    "Phone",
    "Provider status",
    "Shortlist",
    "Actions",
  ]);
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
  await view.render("thread-1", 0, false, undefined, {
    presentation: "workspace",
    view: "results",
  });
  expect(view.container.querySelector(".hire-table-wrap")).not.toBeNull();
  expect(view.container.querySelector('input[aria-label="Search candidates"]')).not.toBeNull();
});

it("does not display the Contacts pool as a pending Shortlist query and retains only an identical warm query", async () => {
  const candidate = { ...candidateFixture("contact-person", false), name: "Saved contact person" };
  const page = candidatePage([candidate]);
  api.listCandidates.mockResolvedValue(page);
  const navigation = {
    presentation: "workspace" as const,
    groupId: "group-1",
    readCache: { entries: new Map<string, unknown>(), epoch: 0 },
    readCacheScope: JSON.stringify(["actor-1", role.spaceId, "thread-1"]),
  };
  const view = await mounted("thread-1", undefined, false, undefined, {
    ...navigation,
    view: "contacts",
  });
  expect(view.container.querySelector("tbody")?.textContent).toContain(candidate.name);
  let finishShortlist!: (value: ReturnType<typeof candidatePage>) => void;
  api.listCandidates.mockReturnValueOnce(
    new Promise((resolve) => {
      finishShortlist = resolve;
    }),
  );
  await view.render("thread-1", 0, false, undefined, { ...navigation, view: "shortlist" });
  expect(api.listCandidates).toHaveBeenLastCalledWith(
    expect.objectContaining({ roleId: role.id, shortlisted: true }),
    { signal: expect.any(AbortSignal) },
  );
  expect(view.container.querySelector(".hire-card-grid")?.textContent ?? "").not.toContain(
    candidate.name,
  );
  expect(view.container.textContent).not.toContain(candidate.name);
  await act(async () => finishShortlist(candidatePage([])));
  api.listCandidates.mockReturnValueOnce(new Promise(() => {}));
  await view.render("thread-1", 0, false, undefined, { ...navigation, view: "contacts" });
  expect(view.container.querySelector("tbody")?.textContent).toContain(candidate.name);
  api.listCandidates.mockReturnValueOnce(new Promise(() => {}));
  await view.render("thread-1", 1, false, undefined, { ...navigation, view: "contacts" });
  expect(view.container.querySelector("tbody")?.textContent).toContain(candidate.name);
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

const linkedSelection = {
  serverId: "crm-source",
  serverRevision: 2,
  organizationId: "org-1",
  crmRoleId: "crm-role",
};
function mockLinkedCrmRole() {
  api.crmData.mockImplementation(async (input) => ({
    operation: input.operation,
    source: { ...linkedSelection, name: "CRM" },
    checkedAt: "2026-10-22T00:00:00Z",
    scope: input.operation === "important" ? "organization_candidate_roles" : "legacy_role_labels",
    selectedRole: {
      crmRoleId: "crm-role",
      clientId: "client",
      clientLabel: "Client",
      roleLabel: "Stored role",
      summary: null,
      description: null,
      jdText: "Stored CRM job description",
      jdUrl: null,
    },
    items:
      input.operation === "candidates"
        ? [
            {
              candidateId: "crm-person",
              name: "Stored CRM person",
              email: null,
              phone: null,
              linkedinUrl: null,
              location: null,
              title: null,
              stage: null,
              contactStatus: "",
              outreachStatus: "",
              roleSpecId: null,
              legacyClientLabel: "Client",
              legacyRoleLabel: "Stored role",
            },
          ]
        : [],
    total: input.operation === "candidates" ? 1 : 0,
    offset: 0,
    nextOffset: null,
  }));
}

it("shows a linked role's agent results and its stored CRM records in one workbench", async () => {
  mockLinkedCrmRole();
  api.listCandidates.mockResolvedValue(
    candidatePage([{ ...candidateFixture("agent-person", false), name: "Agent candidate" }]),
  );
  const browse = {
    selection: linkedSelection,
    view: "results" as const,
    onSelectCandidate: vi.fn(),
  };
  const view = await mounted("thread-1", undefined, false, undefined, {
    groupId: "group-1",
    crmBrowse: browse,
  });
  // A CRM role without its own conversation keeps reading only the CRM.
  expect(api.getWorkspace).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("Agent candidate");
  await view.render("thread-1", 0, false, undefined, {
    groupId: "group-1",
    crmBrowse: browse,
    roleConversation: true,
  });
  expect(view.container.querySelector("h1")?.textContent).toBe("Stored role");
  expect(view.container.textContent).toContain("Agent candidate");
  expect(view.container.textContent).toContain("Stored CRM history");
  await view.render("thread-1", 0, false, undefined, {
    groupId: "group-1",
    crmBrowse: { ...browse, view: "brief" },
    roleConversation: true,
  });
  expect(view.container.textContent).toContain("Build systems");
  expect(view.container.textContent).toContain("Stored CRM job description");
  expect(api.setCandidateShortlist).not.toHaveBeenCalled();
});

it("mounts the role tabs for a CRM-bound conversation and keeps stored CRM views otherwise", async () => {
  mockLinkedCrmRole();
  const crmTarget = {
    bindingEffectId: "binding",
    target: {
      mcpServerId: "crm-source",
      serverRevision: 2,
      organizationId: "org-1",
      crmRoleId: "crm-role",
      clientLabel: "Client",
      roleLabel: "Stored role",
    },
  };
  const browse = {
    selection: linkedSelection,
    view: "contacts" as const,
    onSelectCandidate: vi.fn(),
  };
  const view = await mounted("thread-1", undefined, false, undefined, {
    groupId: "group-1",
    crmBrowse: browse,
    roleConversation: true,
  });
  expect(view.container.querySelector("[data-role-tab]")).toBeNull();
  expect(view.container.textContent).toContain("Stored CRM person");
  api.getWorkspace.mockResolvedValue({ role, revision, crmTarget });
  api.crmData.mockClear();
  for (const tab of ["contacts", "sequence", "inbox", "interview"] as const) {
    await view.render("thread-1", 1, false, undefined, {
      groupId: "group-1",
      crmBrowse: { ...browse, view: tab },
      roleConversation: true,
    });
    const roleTab = view.container.querySelector("[data-role-tab]");
    expect(roleTab?.getAttribute("data-role-tab")).toBe(tab);
    expect(JSON.parse(roleTab!.textContent!)).toEqual({
      roleId: role.id,
      spaceId: role.spaceId,
      conversation: { groupId: "group-1" },
      refreshSignal: 1,
    });
  }
  // The role tabs own their CRM reads; the hidden stored CRM views read nothing.
  expect(api.crmData).not.toHaveBeenCalled();
});

it("shows Autumn's criterion states, evidence, source round and saved decision for every returned candidate", async () => {
  api.listAssessments.mockResolvedValue([]);
  api.listCandidates.mockResolvedValue(
    candidatePage(
      Array.from({ length: 12 }, (_, index) => ({
        ...candidateFixture(`person-${index}`, false),
        name: `Person ${index}`,
        decision: index === 0 ? ("hold" as const) : null,
        decisionReason: index === 0 ? "Wait for the client" : null,
        latestSource: {
          providerTaskId: "provider-task-1",
          taskId: "task-1",
          actionId: "action-1",
          roleRevisionId: revision.id,
          effectId: "source-1",
          rowIndex: index,
          artifactRef: { artifactId: "source-artifact", sha256: "a".repeat(64) },
          requestCursor: null,
          outputId: null,
          observedAt: "2026-01-01T00:00:00Z",
          report: {
            fields: [
              { label: "Rank", value: String(index + 1), sourceUrls: [] },
              {
                label: "Compiler depth",
                value: index === 1 ? "miss" : "match",
                providerStatus: index === 1 ? ("miss" as const) : ("match" as const),
                evidence: `Evidence ${index}`,
                sourceUrls: ["https://evidence.example.test/profile"],
              },
              { label: "Email status", value: "verified", sourceUrls: [] },
            ],
            sourceUrls: [],
          },
        },
      })),
    ),
  );
  const page = await api.listCandidates();
  page.counts.assessed = 0;
  api.listCandidates.mockResolvedValue(page);
  const view = await mounted("thread-1", undefined, false, undefined, {
    presentation: "workspace",
    view: "results",
  });
  expect([...view.container.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "Candidate",
    "Current role",
    "Company",
    "Location",
    "Research match",
    "Criteria",
    "Research round",
    "Feedback",
    "Provider status",
    "Shortlist",
  ]);
  const rows = [...view.container.querySelectorAll("tbody tr")];
  expect(rows).toHaveLength(12);
  expect(rows.map((row) => row.querySelector("th button")?.textContent)).toEqual(
    Array.from({ length: 12 }, (_, index) => `Person ${index}`),
  );
  expect(rows[0]!.textContent).toContain("Compiler depth");
  expect(rows[0]!.textContent).toContain("Match");
  expect(rows[0]!.textContent).toContain("Evidence 0");
  expect(rows[0]!.textContent).toContain("evidence.example.test");
  expect(rows[0]!.textContent).toContain("Search update 1");
  expect(rows[0]!.textContent).toContain("On hold");
  expect(rows[0]!.textContent).toContain("Wait for the client");
  expect(rows[0]!.textContent).toContain("verified");
  expect(rows[1]!.textContent).toContain("Does not match");
  expect(api.correspondence).not.toHaveBeenCalled();
});
