// @vitest-environment jsdom

import { ORPCError } from "@orpc/client";
import type {
  GlobalRecruitingInboxOutput,
  RecruitingAccountViewOutput,
  RecruitingCorrespondence,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
const read = vi.hoisted(() => vi.fn());
const globalRead = vi.hoisted(() => vi.fn());
const updateReminder = vi.hoisted(() => vi.fn());
const listContacts = vi.hoisted(() => vi.fn());
const contactFacets = vi.hoisted(() => vi.fn());
const updateTags = vi.hoisted(() => vi.fn());
vi.mock("../../lib/auth", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: {
      accountView: read,
      globalInbox: globalRead,
      reminders: { update: updateReminder },
      contacts: { list: listContacts, facets: contactFacets, updateTags },
    },
  },
}));
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
const indexPage = (
  emails: RecruitingCorrespondence["emails"],
  partial = false,
): GlobalRecruitingInboxOutput => ({
  roles,
  items: emails.map((email) => ({
    roleId: "one",
    key: `message:${email.id}`,
    email,
    person: null,
    latestIncomingAt: email.direction === "received" ? email.date : null,
  })),
  nextCursor: null,
  total: emails.length,
  unread: {
    count: 0,
    unknownThreads: emails.filter((email) => !email.direction || !email.date).length,
    scope: "indexed_stored_mail",
  },
  coverage: {
    importsComplete: !partial,
    crmComplete: true,
    native: "observed",
    providerComplete: false,
    checkedAt: "2026-10-30T12:00:00Z",
  },
});
const mockIndex = (page: GlobalRecruitingInboxOutput) =>
  globalRead.mockImplementation(async (input: { thread?: { key: string; roleId: string } }) => ({
    ...page,
    items: input.thread
      ? page.items.filter(
          (row) => row.roleId === input.thread!.roleId && row.key === input.thread!.key,
        )
      : page.items,
  }));
beforeEach(() => {
  mockIndex(indexPage([]));
});
const host = document.createElement("div");
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.clearAllMocks());
it("reads each role on its own, shows one calendar, role labels and a picker that filters without opening chat", async () => {
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
            spaceId="space"
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
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map(([input]) => input)).toEqual([
      { view: "roles", limit: 5 },
      { view: "interview", roleId: "one", limit: 1 },
      { view: "interview", roleId: "two", limit: 1 },
    ]);
    expect(host.querySelectorAll('[aria-label="Calendar"]').length).toBe(1);
    expect(host.textContent).toContain("Role one / Role two · Candidate interview");
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')!;
    await act(async () => {
      picker.value = "two";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls[3]![0]).toEqual({
      view: "interview",
      roleId: "two",
      cursor: undefined,
      limit: 5,
    });
    expect(host.querySelectorAll('select[aria-label="Role"] option').length).toBe(3);
    expect(host.textContent).not.toContain("Role one / Role two · Candidate interview");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("lists sibling sequences and routes to exact role detail without expanding lead pages globally", async () => {
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
          ? [{ ...first, leads: [lead("new@example.test")], nextLeadCursor: null }]
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
            spaceId="space"
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
    const links = [...container.querySelectorAll("a")];
    expect(
      links.find((link) => link.textContent === "Campaign one")?.getAttribute("href"),
    ).toContain("campaign=one&campaignServer=mail-source");
    expect(
      links.find((link) => link.textContent === "Campaign two")?.getAttribute("href"),
    ).toContain("campaign=two&campaignServer=mail-source");
    expect(
      read.mock.calls.every(
        ([input]) => input.sequenceSummary === true && !input.campaignLeadCursor,
      ),
    ).toBe(true);
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it.each([
  { partial: false, nextCursor: null, count: 0, empty: true, retry: false, label: null },
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
  async ({ partial, nextCursor, count, empty, retry }) => {
    const emails = Array.from({ length: count }, (_, index) => ({
      id: `reply-${index}`,
      sourceName: "Mailbox",
      sourceId: "mail-source",
      providerMessageId: `mail-${index}`,
      savedRead: null,
      direction: "received" as const,
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
    // A transient failure keeps loading and retries; a definite answer shows the error.
    if (retry)
      globalRead.mockRejectedValue(new ORPCError("BAD_REQUEST", { message: "unavailable" }));
    else mockIndex(indexPage(emails, partial || !!nextCursor));
    const container = document.createElement("div");
    const pageRoot = createRoot(container);
    try {
      await act(async () =>
        pageRoot.render(
          <MemoryRouter initialEntries={["/app?view=inbox&role=all"]}>
            <AccountRecruitingView
              spaceId="space"
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
      expect(container.textContent?.includes("No indexed mail matches this view.")).toBe(empty);
      expect(container.textContent?.includes("Could not load recruiting records.")).toBe(retry);
      expect(container.textContent).not.toContain("0 replies");
      expect(container.textContent).not.toContain("0 unread");
      expect(container.textContent?.includes("Saved mail is indexing in the background.")).toBe(
        !retry && (partial || !!nextCursor),
      );
      if (!retry) expect(container.textContent).toContain("Saved mail · partial source coverage");
    } finally {
      await act(async () => pageRoot.unmount());
    }
  },
);

it("pages saved mail by number and reads only the chosen page", async () => {
  mockIndex({ ...indexPage([]), total: 75 });
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=inbox&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(globalRead).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ offset: expect.anything() }),
      expect.anything(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Page 3"]')!.click(),
    );
    expect(globalRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 60, limit: 30 }),
      expect.anything(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')!.click(),
    );
    expect(globalRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 30 }),
      expect.anything(),
    );
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("keeps the Inbox loading through a failed read right after a deploy, then shows it", async () => {
  vi.useFakeTimers();
  read.mockResolvedValue({ roles, items: [], nextCursor: null });
  globalRead.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=inbox&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.textContent).not.toContain("Could not load recruiting records.");
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(globalRead).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Could not load recruiting records.");
    expect(container.textContent).toContain("No indexed mail matches this view.");
  } finally {
    await act(async () => pageRoot.unmount());
    vi.useRealTimers();
  }
});

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
            spaceId="space"
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

it.each(["missing", "failed", "unsupported", "not_checked"])(
  "shows a true calendar %s state and the connection action only when needed",
  async (state) => {
    read.mockResolvedValue({
      roles,
      items: [
        {
          roleId: "one",
          correspondence: {
            ...correspondence("one"),
            events: [],
            status: state === "missing" ? "not_checked" : state,
            connections: [
              {
                name: "Calendar",
                status: state === "missing" ? "needs_connection" : "configured",
                checkIssue: null,
              },
            ],
          },
        },
      ],
      nextCursor: null,
    });
    const container = document.createElement("div");
    const pageRoot = createRoot(container);
    const connect = vi.fn();
    try {
      await act(async () =>
        pageRoot.render(
          <MemoryRouter initialEntries={["/app?view=interview&role=all"]}>
            <AccountRecruitingView
              spaceId="space"
              accountKey="user-space"
              groups={[]}
              bots={[]}
              refreshSignal={0}
              onOpenNavigation={() => {}}
              onOpenConnections={connect}
            />
          </MemoryRouter>,
        ),
      );
      const action = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect calendar",
      );
      expect(Boolean(action)).toBe(state === "missing");
      if (action) {
        await act(async () => action.click());
        expect(connect).toHaveBeenCalledOnce();
      }
      expect(container.textContent?.includes("Could not load calendar records.")).toBe(
        state !== "missing",
      );
      expect(container.querySelector('[aria-label="Calendar"]')).toBeNull();
    } finally {
      await act(async () => pageRoot.unmount());
    }
  },
);

it("names the calendar that could not be read and still shows the others", async () => {
  read.mockResolvedValue({
    roles,
    items: [
      {
        roleId: "one",
        correspondence: {
          ...correspondence("one"),
          events: [],
          status: "empty",
          partial: true,
          connections: [
            {
              name: "Google Calendar",
              status: "configured",
              checkIssue: { status: "failed", checkedAt: "2026-11-01T00:00:00.000Z" },
            },
            { name: "Cal.com", status: "configured", checkIssue: null },
          ],
        },
      },
    ],
    nextCursor: null,
  });
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=interview&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.textContent).toContain("Could not read Google Calendar.");
    expect(container.textContent).not.toContain("Could not load calendar records.");
    expect(container.querySelector('[aria-label="Calendar"]')).not.toBeNull();
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("loads the next interview page into the calendar without losing previous events or sibling roles", async () => {
  const event = correspondence("one").events[0]!;
  read.mockImplementation(async (input: { itemCursor?: string; roleId?: string }) => ({
    roles,
    items: (input.itemCursor
      ? [
          {
            roleId: "one",
            correspondence: {
              ...correspondence("one"),
              events: [event, { ...event, id: "next-event", title: "Next candidate interview" }],
            },
          },
        ]
      : [
          {
            roleId: "one",
            correspondence: {
              ...correspondence("one"),
              nextCursor: "calendar-page-two",
              partial: true,
            },
          },
          {
            roleId: "two",
            correspondence: {
              ...correspondence("two"),
              events: [{ ...event, id: "sibling-event", title: "Other role interview" }],
            },
          },
        ]
    ).filter((item) => !input.roleId || item.roleId === input.roleId),
    nextCursor: null,
  }));
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=interview&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.textContent).not.toContain("Could not load calendar records.");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Load more")!
        .click(),
    );
    expect(read).toHaveBeenLastCalledWith({
      view: "interview",
      roleId: "one",
      itemCursor: "calendar-page-two",
      limit: 20,
    });
    expect(container.textContent).toContain("Next candidate interview");
    expect(container.textContent).toContain("Other role interview");
    expect(container.textContent).toContain("Candidate interview");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Load more",
      ),
    ).toBe(false);
  } finally {
    await act(async () => pageRoot.unmount());
    vi.useRealTimers();
  }
});

it("does not invent zero replies from an email whose direction is unknown", async () => {
  read.mockResolvedValue({
    roles,
    items: [
      {
        roleId: "one",
        correspondence: {
          ...correspondence("one"),
          emails: [
            {
              id: "unknown-direction",
              direction: null,
              sender: "candidate@example.test",
              subject: "Saved email",
              body: "Saved correspondence",
              recipients: [],
              date: null,
              sourceName: "Mailbox",
              sourceId: "mail",
              providerMessageId: "message",
              savedRead: null,
              snippet: false,
              url: null,
            },
          ],
        },
      },
    ],
    nextCursor: null,
  });
  const observed = await read();
  mockIndex(indexPage(observed.items[0].correspondence.emails));
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=inbox&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.textContent).toContain("Saved email");
    expect(container.querySelector('[aria-label="Unread"]')).toBeNull();
    expect(container.textContent).not.toContain("0 replies");
    expect(container.textContent).not.toContain("No replies yet.");
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("continues feedback through the account read and keeps already displayed records", async () => {
  const feedback = (id: string) => ({ id, feedback: { summary: `Feedback ${id}` } });
  read.mockImplementation(async (input: { itemCursor?: string }) => ({
    roles,
    items: [
      {
        roleId: "one",
        feedback: input.itemCursor
          ? { feedback: [feedback("first"), feedback("older")], nextCursor: null }
          : { feedback: [feedback("first")], nextCursor: "feedback-before" },
      },
    ],
    nextCursor: null,
  }));
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=feedback&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
      view: "feedback",
      roleId: "one",
      itemCursor: "feedback-before",
      limit: 20,
    });
    expect(container.textContent?.match(/Feedback first/g)).toHaveLength(1);
    expect(container.textContent).toContain("Feedback older");
    expect(container.textContent).not.toContain("Load more");
  } finally {
    await act(async () => pageRoot.unmount());
  }
});
it("does not claim zero people when candidate records could not be read", async () => {
  read.mockResolvedValue({
    roles,
    items: [
      {
        roleId: "one",
        candidates: {
          items: [],
          total: 0,
          counts: { shortlisted: 0, replied: 0 },
          crmStatus: "unavailable",
          nextCursor: null,
        },
      },
    ],
    nextCursor: null,
  });
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=shortlist&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.textContent).toContain("Could not load recruiting records.");
    expect(container.textContent).not.toContain("0 people");
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("completes an open native reminder and does not offer Done on already completed work", async () => {
  let done = false;
  const reminder = (id: string, status: string) => ({
    id,
    title: `Task ${id}`,
    dueAt: "2026-10-31T12:00:00Z",
    status,
  });
  read.mockImplementation(async () => ({
    roles,
    items: [
      {
        roleId: "one",
        reminders: {
          items: [reminder("open", done ? "done" : "open"), reminder("already-done", "done")],
          overdueCount: 0,
        },
      },
    ],
    nextCursor: null,
  }));
  updateReminder.mockImplementation(async () => {
    done = true;
  });
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=tasks&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.textContent).toContain("Task open");
    expect(container.textContent).not.toContain("Task already-done");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Done")!
        .click(),
    );
    expect(updateReminder).toHaveBeenCalledWith({ id: "open", status: "done" });
    expect(container.textContent).not.toContain("Task open");
    expect(container.textContent).toContain("No open tasks.");
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Done"),
    ).toBe(false);
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("lists every role's people in one server-paged table", async () => {
  const person = (key: string, name: string) => ({
    personKey: key,
    name,
    title: "Engineer",
    company: "Acme",
    location: "Los Angeles",
    school: "UCLA",
    linkedinUrl: null,
    email: null,
    status: "shortlisted",
    noteKey: `autumn:${key}`,
    roles: [
      {
        id: "one",
        title: "Role one",
        groupId: "group-one",
        candidateKey: key,
        shortlisted: true,
        threadId: "thread-one",
        revision: 1,
      },
    ],
    tags: [],
    addedAt: "2026-10-01T00:00:00Z",
    lastContactedAt: null,
    lastRepliedAt: null,
  });
  listContacts.mockResolvedValue({
    items: [person("linkedin:/in/ada", "Ada Lovelace"), person("linkedin:/in/bob", "Bob Stone")],
    total: 120,
    nextCursor: "50",
  });
  contactFacets.mockResolvedValue({
    roles: [{ id: "one", title: "Role one" }],
    statuses: [],
    tags: [],
  });
  updateTags.mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  document.body.append(container);
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=contacts&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(read).not.toHaveBeenCalled();
    expect(listContacts).toHaveBeenCalledWith({ filters: {}, limit: 50 });
    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("UCLA");
    expect(container.textContent).toContain("1–2 of 120");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click(),
    );
    expect(listContacts).toHaveBeenLastCalledWith({ filters: {}, limit: 50, cursor: "50" });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Page 3"]')!.click(),
    );
    expect(listContacts).toHaveBeenLastCalledWith({ filters: {}, limit: 50, cursor: "100" });
  } finally {
    await act(async () => pageRoot.unmount());
    container.remove();
  }
});
it("shows the interview calendar for arrived roles and marks only the rest as loading", async () => {
  read.mockImplementation((input: { view: string; roleId?: string }) =>
    input.view === "roles"
      ? Promise.resolve({
          roles,
          items: roles.map((role) => ({ roleId: role.id })),
          nextCursor: null,
        })
      : input.roleId === "one"
        ? new Promise(() => {})
        : Promise.resolve({
            ...data,
            items: data.items.filter((item) => item.roleId === "two"),
          }),
  );
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=interview&role=all"]}>
          <AccountRecruitingView
            spaceId="space"
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
    expect(container.querySelectorAll('[aria-label="Calendar"]').length).toBe(1);
    const loading = [...container.querySelectorAll('[role="status"]')];
    expect(loading.length).toBeGreaterThan(0);
    expect(loading.every((node) => node.closest('[aria-busy="true"]'))).toBe(true);
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("groups Contacts and Shortlist under Candidates and keeps selected-role context links", async () => {
  read.mockResolvedValue(data);
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=shortlist&role=two"]}>
          <AccountRecruitingView
            spaceId="space"
            accountKey="account"
            groups={[]}
            bots={[]}
            refreshSignal={0}
            onOpenNavigation={() => {}}
            onOpenConnections={() => {}}
          />
        </MemoryRouter>,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Candidates");
    const links = [...container.querySelectorAll<HTMLAnchorElement>("nav a")];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Contacts", "/app?view=contacts&role=two"],
      ["Shortlist", "/app?view=shortlist&role=two"],
      ["Job brief", "/app?view=brief&role=two"],
      ["Client feedback", "/app?view=feedback&role=two"],
    ]);
    expect(
      links.find((link) => link.textContent === "Shortlist")?.getAttribute("aria-current"),
    ).toBe("page");
    await act(async () => links.find((link) => link.textContent === "Job brief")!.click());
    expect(container.querySelector("h1")?.textContent).toBe("Job Brief");
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "brief", roleId: "two" }),
    );
  } finally {
    await act(async () => pageRoot.unmount());
  }
});

it("keeps Work secondary links scoped and opens the existing global chat", async () => {
  read.mockResolvedValue(data);
  const container = document.createElement("div");
  const pageRoot = createRoot(container);
  try {
    await act(async () =>
      pageRoot.render(
        <MemoryRouter initialEntries={["/app?view=tasks&role=two"]}>
          <AccountRecruitingView
            spaceId="space"
            accountKey="account"
            groups={[{ id: "recruiting-global-fixture" } as never]}
            bots={[]}
            refreshSignal={0}
            onOpenNavigation={() => {}}
            onOpenConnections={() => {}}
          />
        </MemoryRouter>,
      ),
    );
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Work"] a')].map((link) => [
        link.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Chat", "/app/g/recruiting-global-fixture?view=conversation"],
      ["Tasks", "/app?view=tasks&role=two"],
      ["Routines", "/app?view=routines&role=two"],
    ]);
  } finally {
    await act(async () => pageRoot.unmount());
  }
});
