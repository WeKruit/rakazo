// @vitest-environment jsdom
import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("../../lib/auth", () => ({ authClient: { useSession: () => ({ data: null }) } }));

import { AccountInbox, accountInboxThreads } from "./AccountInbox";

type Item = RecruitingAccountViewOutput["items"][number];
const email = (id: string, sourceId: string, mailbox = "recruiter@example.test") => ({
  id,
  sourceName: sourceId === "source-one" ? "Work mail" : "Team mail",
  sourceId,
  providerMessageId: id,
  providerThreadId: "same-provider-thread",
  campaignId: null,
  eaccount: mailbox,
  savedRead: null,
  direction: "received" as const,
  sender: `${id}@example.test`,
  recipients: [mailbox],
  subject: "Same subject",
  body: `Full message belonging to ${id}`,
  snippet: false,
  date: "2026-10-30T12:00:00Z",
  url: null,
});
const item = (roleId: string, emails: ReturnType<typeof email>[]): Item => ({
  roleId,
  correspondence: {
    roleId,
    status: "ready",
    checkedAt: null,
    connectionChanged: false,
    connections: [],
    contacts: [],
    emails,
    events: [],
    partial: false,
    nextCursor: null,
  },
});
const roles = ["one", "two"].map((id) => ({
  id,
  title: `Role ${id}`,
  groupId: `group-${id}`,
  threadId: `native-${id}`,
  stage: "outreach",
}));

it("keeps identical provider thread IDs separate across roles, sources and mailboxes", () => {
  const rows = accountInboxThreads([
    item("one", [
      email("first", "source-one"),
      email("second", "source-two"),
      email("third", "source-one", "other@example.test"),
    ]),
    item("two", [email("fourth", "source-one")]),
  ]);
  expect(rows).toHaveLength(4);
  expect(
    accountInboxThreads([
      item("one", [email("first", "source-one"), email("second", "source-one")]),
    ]),
  ).toHaveLength(1);
});

it("switches one selected detail atomically while keeping role and mailbox attribution and role actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onOpenRole = vi.fn();
  const rootHost = document.createElement("div");
  const root = createRoot(rootHost);
  try {
    await act(async () =>
      root.render(
        <AccountInbox
          roles={roles}
          items={[
            item("one", [email("first", "source-one")]),
            item("two", [email("second", "source-two", "team@example.test")]),
          ]}
          pending={[]}
          onLoadMore={vi.fn()}
          onRetry={vi.fn()}
          onOpenRole={onOpenRole}
        />,
      ),
    );
    expect(rootHost.querySelectorAll('[data-testid="email-conversation"]')).toHaveLength(1);
    expect(rootHost.querySelector("article")?.textContent).toContain(
      "Full message belonging to first",
    );
    const next = rootHost.querySelector<HTMLButtonElement>(
      'button[aria-label="second@example.test · Role two · Same subject"]',
    )!;
    await act(async () => next.click());
    const detail = rootHost.querySelector('[data-testid="email-conversation"]')!;
    expect(detail.textContent).toContain("second@example.test");
    expect(detail.textContent).not.toContain("Full message belonging to first");
    expect(detail.parentElement?.parentElement?.textContent).toContain(
      "Role two · team@example.test",
    );
    // Connection names can be supplier names; customers see only the mailbox.
    expect(rootHost.textContent).not.toContain("Team mail");
    expect(rootHost.textContent).not.toContain("Work mail");
    await act(async () =>
      [...rootHost.querySelectorAll("button")]
        .find((button) => button.textContent === "Open role")!
        .click(),
    );
    expect(onOpenRole).toHaveBeenCalledWith("two");
    expect(next.closest("section")?.className).toContain("hidden lg:flex");
    await act(async () =>
      [...rootHost.querySelectorAll("button")]
        .find((button) => button.textContent === "Back to inbox")!
        .click(),
    );
    expect(next.closest("section")?.className).not.toContain("hidden lg:flex");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("joins one explicit email to saved summary facts and never joins mismatched CRM provenance", async () => {
  const message = email("first", "source-one");
  const person = {
    key: "saved-person",
    name: "Avery Example",
    title: "Platform engineer",
    location: "Austin",
    email: "first@example.test",
    linkedinUrl: null,
    autumn: {
      candidateKey: "person",
      score: 4,
      rank: 1,
      tier: "Strong",
      matchSummary: null,
      criteria: [],
      ranking: {
        source: "reviewer",
        state: "current",
        roleRevisionId: "revision",
        sourceEffectId: "review",
        grade: "Strong",
        score: 4,
        group: "strong_match",
      },
      savedProfile: {
        personKey: "person",
        provider: "test",
        fetchedAt: "2026-10-30T00:00:00Z",
        headline: "Engineer",
        profileImageUrl: "https://assets.example.test/photo.png",
        experience: [
          {
            title: "Senior engineer",
            company_name: "Example Labs",
            start_date: "2024",
            end_date: null,
            is_current: true,
            company_url: null,
            company_linkedin_url: null,
            company_logo_url: null,
            company_industry: null,
            company_size: null,
            location: null,
            description: null,
          },
        ],
        education: [
          {
            school_name: "Example University",
            degree: "BS",
            field_of_study: null,
            school_url: null,
            school_logo_url: null,
            start_date: null,
            end_date: null,
          },
        ],
      },
    },
    crm: null,
    shortlisted: false,
    shortlistedAt: null,
  } satisfies NonNullable<Item["candidates"]>["items"][number];
  const record = {
    ...item("one", [message]),
    candidates: {
      items: [person],
      nextCursor: null,
      total: 1,
      counts: { shortlisted: 0, replied: 1 },
      crmStatus: "not_bound" as const,
      crmCountsComplete: false,
    },
  };
  expect(accountInboxThreads([record])[0]?.person?.name).toBe("Avery Example");
  expect(
    accountInboxThreads([
      {
        ...record,
        candidates: { ...record.candidates, items: [person, { ...person, key: "duplicate" }] },
      },
    ])[0]?.person,
  ).toBeUndefined();
  expect(
    accountInboxThreads([
      {
        ...record,
        correspondence: {
          ...record.correspondence!,
          emails: [
            {
              ...message,
              crm: {
                serverRevision: 1,
                organizationId: "org",
                crmRoleId: "role",
                candidateId: "candidate",
                threadId: "thread",
                direction: "received",
              },
            },
          ],
        },
      },
    ])[0]?.person,
  ).toBeUndefined();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(
        <AccountInbox
          roles={roles}
          items={[record]}
          pending={[]}
          onLoadMore={vi.fn()}
          onRetry={vi.fn()}
          onOpenRole={vi.fn()}
          onOpenProfile={open}
        />,
      ),
    );
    const rail = host.querySelector('section[aria-label="Inbox conversations"]')!;
    expect(rail.textContent).toContain("Strong Match");
    expect(rail.textContent).toContain("Senior engineer · Example Labs · 2024");
    expect(rail.textContent).toContain("Example University · BS");
    expect(rail.querySelector("img")?.getAttribute("src")).toBe(
      "https://assets.example.test/photo.png",
    );
    expect(rail.textContent).not.toContain("Availability provided");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Profile")!
        .click(),
    );
    expect(open).toHaveBeenCalledWith("one", person);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the exact requested sent original without exposing other sent-only threads", async () => {
  const sent = { ...email("sent-original", "source-one"), direction: "sent" as const };
  const other = { ...email("other-sent", "source-two"), direction: "sent" as const };
  const records: Item[] = [item("one", []), item("two", [])];
  records[0]!.correspondence!.emails = [sent, other];
  records[1]!.correspondence!.emails = [sent];
  expect(accountInboxThreads(records)).toEqual([]);
  const rows = accountInboxThreads(records, {
    roleId: "one",
    emailId: sent.id,
    sourceId: sent.sourceId,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.roleId).toBe("one");
  expect(rows[0]?.emails.map((entry) => entry.id)).toEqual(["sent-original"]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AccountInbox
          roles={[]}
          items={records}
          pending={[]}
          requestedThread="exact-thread"
          requestedEmail="sent-original"
          serverThreads={[
            {
              key: "exact-thread",
              roleId: "one",
              emailId: sent.id,
              sourceId: sent.sourceId,
              organizationId: null,
              mailbox: sent.eaccount,
              latestIncomingAt: null,
            },
          ]}
          onLoadMore={vi.fn()}
          onRetry={vi.fn()}
          onOpenRole={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector("article")?.textContent).toContain(sent.body);
    expect(container.textContent).not.toContain(other.body);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
