// @vitest-environment jsdom
import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { accountView: read } } }));
vi.mock("./RecruitingRoutines", () => ({ RecruitingRoutines: () => null }));

import { AccountRecruitingView } from "./AccountRecruitingView";

const roles = ["one", "two"].map((id) => ({
  id,
  title: `Role ${id}`,
  threadId: `thread-${id}`,
  groupId: `group-${id}`,
  stage: "interview",
}));
const correspondence = (id: string) => ({
  roleId: id,
  status: "ready" as const,
  checkedAt: "2026-10-30T12:00:00Z",
  connectionChanged: false,
  connections: [{ name: "Calendar", status: "configured" as const, checkIssue: null }],
  emails: [],
  contacts: [],
  partial: false,
  nextCursor: null,
  events: [
    {
      id: "same-provider-id",
      kind: "event" as const,
      title: "Candidate interview",
      start: "2026-10-30T14:00:00Z",
      end: "2026-10-30T15:00:00Z",
      timeZone: "UTC",
      attendees: [],
      status: "confirmed",
      location: null,
      url: null,
    },
  ],
});
const data: RecruitingAccountViewOutput = {
  roles,
  items: roles.map((role) => ({ roleId: role.id, correspondence: correspondence(role.id) })),
  nextCursor: null,
};
const host = document.createElement("div");
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.clearAllMocks());
it("uses one account read, one calendar, role labels and a picker that filters without opening chat", async () => {
  read.mockImplementation(async (input: { roleId?: string }) =>
    input.roleId
      ? { ...data, items: data.items.filter((item) => item.roleId === input.roleId) }
      : data,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/app?view=interview&role=all"]}>
          <AccountRecruitingView
            accountKey="user-space"
            groups={[]}
            bots={[]}
            refreshSignal={0}
            onOpenNavigation={() => {}}
            onOpenConnections={() => {}}
          />
        </MemoryRouter>,
      ),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual({ view: "interview", cursor: undefined, limit: 20 });
    expect(host.querySelectorAll('[aria-label="Calendar"]').length).toBe(1);
    expect(host.textContent).toContain("Role one / Role two · Candidate interview");
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')!;
    await act(async () => {
      picker.value = "two";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![0]).toEqual({
      view: "interview",
      roleId: "two",
      cursor: undefined,
      limit: 20,
    });
    expect(host.querySelectorAll('select[aria-label="Role"] option').length).toBe(3);
    expect(host.textContent).not.toContain("Role one / Role two · Candidate interview");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("loads the next campaign lead page without losing sibling campaigns or repeating a person", async () => {
  const lead = (email: string) => ({ candidateKey: null, email, status: 1, interestStatus: null });
  const campaign = (id: string) => ({
    status: "ready" as const,
    serverId: "mail-source",
    campaign: { id, name: `Campaign ${id}`, eaccount: null, status: 1, stopOnReply: true },
    leads: [lead(`${id}@example.test`)],
    nextLeadCursor: id === "one" ? "lead-page-two" : null,
  });
  const first = campaign("one");
  const second = campaign("two");
  read.mockImplementation(async (input: { campaignId?: string }) => ({
    roles,
    items: [
      {
        roleId: "one",
        campaigns: input.campaignId
          ? [{ ...first, leads: [...first.leads, lead("new@example.test")], nextLeadCursor: null }]
          : [first, second],
      },
    ],
    nextCursor: null,
  }));
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=sequence&role=all"]}>
          <AccountRecruitingView
            accountKey="user-space"
            groups={[]}
            bots={[]}
            refreshSignal={0}
            onOpenNavigation={() => {}}
            onOpenConnections={() => {}}
          />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Load more")!
        .click(),
    );
    expect(read).toHaveBeenLastCalledWith({
      view: "sequence",
      roleId: "one",
      campaignId: "one",
      campaignServerId: "mail-source",
      campaignLeadCursor: "lead-page-two",
      limit: 20,
    });
    expect(container.textContent?.match(/one@example.test/g)).toHaveLength(1);
    expect(container.textContent).toContain("new@example.test");
    expect(container.textContent).toContain("Campaign two");
    expect(container.textContent).toContain("two@example.test");
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it.each([
  { partial: false, nextCursor: null, count: 0, empty: true, retry: false, label: "0 replies" },
  { partial: true, nextCursor: null, count: 0, empty: false, retry: true, label: null },
  {
    partial: true,
    nextCursor: "next-mail",
    count: 0,
    empty: false,
    retry: false,
    label: "0+ replies",
  },
  { partial: true, nextCursor: null, count: 2, empty: false, retry: false, label: "2+ replies" },
  {
    partial: false,
    nextCursor: "next-mail",
    count: 2,
    empty: false,
    retry: false,
    label: "2+ replies",
  },
])(
  "distinguishes known Inbox zero from partial reads ($partial/$nextCursor/$count)",
  async ({ partial, nextCursor, count, empty, retry, label }) => {
    const emails = Array.from({ length: count }, (_, index) => ({
      id: `reply-${index}`,
      sourceName: "Mailbox",
      sourceId: "mail-source",
      providerMessageId: `mail-${index}`,
      savedRead: null,
      direction: "received",
      sender: "candidate@example.test",
      recipients: [],
      subject: `Reply ${index}`,
      body: "Candidate reply",
      snippet: false,
      date: null,
      url: null,
    }));
    read.mockResolvedValue({
      roles,
      items: [
        {
          roleId: "one",
          correspondence: { ...correspondence("one"), emails, partial, nextCursor },
        },
      ],
      nextCursor: null,
    });
    const container = document.createElement("div");
    const pageRoot = createRoot(container);
    try {
      await act(async () =>
        pageRoot.render(
          <MemoryRouter initialEntries={["/app?view=inbox&role=all"]}>
            <AccountRecruitingView
              accountKey="user-space"
              groups={[]}
              bots={[]}
              refreshSignal={0}
              onOpenNavigation={() => {}}
              onOpenConnections={() => {}}
            />
          </MemoryRouter>,
        ),
      );
      expect(container.textContent?.includes("No replies yet.")).toBe(empty);
      expect(container.textContent?.includes("Could not load replies.")).toBe(retry);
      if (label) expect(container.textContent).toContain(label);
      else expect(container.textContent).not.toContain("0 replies");
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Load more",
        ),
      ).toBe(Boolean(nextCursor));
    } finally {
      await act(async () => pageRoot.unmount());
    }
  },
);

it("reports an unavailable campaign read without claiming that there is no campaign", async () => {
  read.mockResolvedValue({
    roles,
    items: [
      {
        roleId: "one",
        campaign: { status: "unavailable", serverId: "mail-source", campaign: null, leads: [] },
        campaigns: [],
      },
    ],
    nextCursor: null,
  });
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=sequence&role=all"]}>
          <AccountRecruitingView
            accountKey="user-space"
            groups={[]}
            bots={[]}
            refreshSignal={0}
            onOpenNavigation={() => {}}
            onOpenConnections={() => {}}
          />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toContain("Could not read this campaign.");
    expect(container.textContent).not.toContain("No campaign yet.");
  } finally {
    await act(async () => pageRoot.unmount());
  }
});
