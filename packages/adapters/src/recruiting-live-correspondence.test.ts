import type { ConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_FRESH_MS,
  CALENDAR_KEEP_MS,
  refreshRecruitingCorrespondence,
} from "./recruiting-live-correspondence.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  listRecruitingSchedulingPlans: vi.fn(async () => ({ plans: [], slots: [], partial: false })),
}));
const actor: Actor = {
  userId: "live-user",
  spaceId: "live-space",
  email: "recruiter@example.test",
  isDeploymentOwner: false,
};
const source = (kind: "calendar" | "instantly") => ({
  id: kind,
  name: kind,
  revision: 1,
  enabled: true,
  secretId: "secret",
  endpoint: null,
  transport: "streamable_http",
  provider: { kind, tools: [] },
  assignments: [{ botId: "main", allowAllTools: true, allowedTools: [] }],
});
const empty = (): RecruitingCorrespondence => ({
  roleId: "role",
  status: "not_checked",
  checkedAt: null,
  connectionChanged: false,
  connections: [{ name: "calendar", status: "configured", checkIssue: null }],
  emails: [],
  events: [],
  contacts: [],
  partial: false,
  nextCursor: null,
});
const campaignId = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const assignment = vi.fn(async () => ({ botId: "main", allowAllTools: true, allowedTools: [] }));
  const prisma = {
    externalEffect: {
      findMany: vi.fn(async () => [
        {
          idempotencyKey: "instantly-role-campaign:instantly:role",
          result: { campaignId, leads: { person: { email: "candidate@example.test" } } },
        },
      ]),
    },
    botMcpServer: { findFirst: assignment },
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
  } as unknown as PrismaClient;
  return { prisma, assignment };
}
afterEach(() => vi.useRealTimers());
describe("live role correspondence", () => {
  it("reads calendar on open, matches role contacts and caches without caching access", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const { prisma, assignment } = fixture();
    const execute = vi.fn(async function* () {
      yield {
        type: "result",
        data: {
          structuredContent: {
            events: [
              {
                id: "owned",
                summary: "Candidate interview",
                start: { dateTime: "2026-10-31T12:00:00Z" },
                end: { dateTime: "2026-10-31T13:00:00Z" },
                attendees: [{ email: "candidate@example.test" }],
              },
              {
                id: "other",
                summary: "Other role interview",
                start: { dateTime: "2026-10-31T15:00:00Z" },
                end: { dateTime: "2026-10-31T16:00:00Z" },
                attendees: [{ email: "other@example.test" }],
              },
            ],
          },
        },
      } as const;
    });
    const deps = { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> };
    const first = empty();
    await refreshRecruitingCorrespondence(
      deps,
      actor,
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      first,
    );
    expect(first.events.map((event) => event.id)).toEqual(["calendar:owned"]);
    expect(first.status).toBe("ready");
    vi.advanceTimersByTime(5000);
    const second = empty();
    await refreshRecruitingCorrespondence(
      deps,
      actor,
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      second,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.events).toEqual(first.events);
    vi.advanceTimersByTime(30_000);
    await refreshRecruitingCorrespondence(
      deps,
      actor,
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      empty(),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    assignment.mockResolvedValueOnce(null as never);
    await expect(
      refreshRecruitingCorrespondence(
        deps,
        actor,
        { roleId: "role", threadId: "thread", view: "interview" },
        [source("calendar")],
        empty(),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not read the calendar for a role with nobody to match", async () => {
    const { prisma } = fixture();
    vi.mocked(prisma.externalEffect.findMany).mockResolvedValue([] as never);
    const execute = vi.fn();
    const output = empty();
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> },
      actor,
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      output,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(output).toMatchObject({ status: "empty", events: [], partial: false });
  });
  it("serves an older calendar read at once and refreshes it in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const { prisma } = fixture();
    const page = (id: string) => ({
      type: "result",
      data: {
        structuredContent: {
          events: [
            {
              id,
              summary: "Candidate interview",
              start: { dateTime: "2026-10-31T12:00:00Z" },
              end: { dateTime: "2026-10-31T13:00:00Z" },
              attendees: [{ email: "candidate@example.test" }],
            },
          ],
        },
      },
    });
    let release: (() => void) | undefined;
    const execute = vi
      .fn()
      .mockImplementationOnce(async function* () {
        yield page("first");
      })
      .mockImplementationOnce(async function* () {
        // The provider is slow: the page must not wait for this read.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield page("second");
      });
    const deps = { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> };
    const open = async () => {
      const output = empty();
      await refreshRecruitingCorrespondence(
        deps,
        { ...actor, userId: "stale-while-refresh" },
        { roleId: "role", threadId: "thread", view: "interview" },
        [source("calendar")],
        output,
      );
      return output.events.map((event) => event.id);
    };
    expect(await open()).toEqual(["calendar:first"]);
    vi.advanceTimersByTime(CALENDAR_FRESH_MS + 1);
    expect(await open()).toEqual(["calendar:first"]);
    expect(execute).toHaveBeenCalledTimes(2);
    release?.();
    await vi.waitFor(async () => expect(await open()).toEqual(["calendar:second"]));
    expect(execute).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CALENDAR_KEEP_MS + 1);
    execute.mockImplementationOnce(async function* () {
      yield page("third");
    });
    expect(await open()).toEqual(["calendar:third"]);
  });
  it("looks up the role's mail campaigns by their exact keys", async () => {
    const { prisma } = fixture();
    const execute = vi.fn(async function* () {
      yield { type: "result", data: { structuredContent: { events: [] } } } as const;
    });
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> },
      { ...actor, userId: "exact-campaign-keys" },
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar"), source("instantly")],
      empty(),
    );
    expect(prisma.externalEffect.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        status: "completed",
        idempotencyKey: {
          in: ["instantly-role-campaign:calendar:role", "instantly-role-campaign:instantly:role"],
        },
      },
      select: { idempotencyKey: true, result: true },
    });
  });
  it("reads the account calendar once for all roles opened together", async () => {
    const { prisma, assignment } = fixture();
    const execute = vi.fn(async function* () {
      yield { type: "result", data: { structuredContent: { events: [] } } } as const;
    });
    const deps = { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> };
    const role = (roleId: string, botId: string) =>
      refreshRecruitingCorrespondence(
        deps,
        { ...actor, userId: "shared-calendar" },
        { roleId, threadId: `thread-${roleId}`, view: "interview" },
        [
          {
            ...source("calendar"),
            assignments: [{ botId, allowAllTools: true, allowedTools: [] }],
          },
        ],
        empty(),
      );
    await Promise.all([role("a", "main-a"), role("b", "main-b"), role("c", "main-c")]);
    expect(execute).toHaveBeenCalledTimes(1);
    // Each role's own access is still checked before and after it uses the shared read.
    expect(assignment.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
  it("does not share cached personal calendars across accounts", async () => {
    const { prisma } = fixture();
    const execute = vi.fn(async function* () {
      yield { type: "result", data: { structuredContent: { events: [] } } } as const;
    });
    const deps = { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> };
    await refreshRecruitingCorrespondence(
      deps,
      { ...actor, userId: "cache-a" },
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      empty(),
    );
    await refreshRecruitingCorrespondence(
      deps,
      { ...actor, userId: "cache-b" },
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      empty(),
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each(["calendar", "cal"] as const)(
    "follows %s calendar continuation when the role's interview is on a later provider page",
    async (kind) => {
      const { prisma } = fixture();
      const execute = vi.fn(async function* (call: { args: Record<string, unknown> }) {
        const later = kind === "calendar" ? call.args.pageToken === "next" : call.args.skip === 1;
        const row = {
          id: later ? "interview" : "unrelated",
          uid: later ? "interview" : "unrelated",
          summary: "Interview",
          title: "Interview",
          start:
            kind === "calendar" ? { dateTime: "2026-10-31T12:00:00Z" } : "2026-10-31T12:00:00Z",
          end: kind === "calendar" ? { dateTime: "2026-10-31T13:00:00Z" } : "2026-10-31T13:00:00Z",
          attendees: [{ email: later ? "candidate@example.test" : "unrelated@example.test" }],
        };
        yield {
          type: "result",
          data: {
            structuredContent:
              kind === "calendar"
                ? { events: later ? [row] : [], ...(later ? {} : { nextPageToken: "next" }) }
                : { status: "success", data: [row], pagination: { hasNextPage: !later } },
          },
        } as const;
      });
      const output = empty();
      const calendar = {
        ...source("calendar"),
        id: `pagination-${kind}`,
        provider: { kind, tools: [] },
      };
      await refreshRecruitingCorrespondence(
        { prisma, connectors: { execute } },
        actor,
        { roleId: "role", threadId: "thread", view: "interview" },
        [calendar],
        output,
      );
      expect(execute).toHaveBeenCalledTimes(2);
      expect(output.events.map((event) => event.id)).toEqual([
        kind === "calendar" ? `${calendar.id}:interview` : `${calendar.id}:booking:interview`,
      ]);
      expect(output.partial).toBe(false);
    },
  );
  it("follows campaign mail pagination and keeps definitive received direction", async () => {
    const { prisma } = fixture();
    const email = (index: number) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      timestamp_created: "2026-10-30T12:00:00Z",
      timestamp_email: "2026-10-30T12:00:00Z",
      message_id: `msg-${index}`,
      subject: `Reply ${index}`,
      from_address_email: "candidate@example.test",
      to_address_email_list: "recruiter@example.test",
      body: { text: "Interested" },
      organization_id: "00000000-0000-4000-8000-000000000002",
      campaign_id: campaignId,
      eaccount: "recruiter@example.test",
      ue_type: 2,
    });
    const execute = vi.fn(async function* (call: { args: Record<string, unknown> }) {
      const start = Number(call.args.starting_after ?? 0);
      const end = Math.min(start + 100, 205);
      yield {
        type: "result",
        data: {
          structuredContent: {
            items: Array.from({ length: end - start }, (_, index) => email(index + start)),
            ...(end < 205 ? { next_starting_after: String(end) } : {}),
          },
        },
      } as const;
    });
    const output = empty();
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> },
      actor,
      { roleId: "role", threadId: "thread", view: "inbox", pageEnd: 200 },
      [source("instantly")],
      output,
    );
    expect(output.emails).toHaveLength(205);
    expect(output.emails.every((email) => email.direction === "received")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[1]?.[0].args.starting_after).toBe("100");
  });
  it.each(["calendar", "cal"] as const)(
    "rejects malformed %s provider identities before generating event keys",
    async (provider) => {
      const { prisma } = fixture();
      const identity = provider === "calendar" ? "id" : "uid";
      const base = {
        title: "Interview",
        summary: "Interview",
        start:
          provider === "calendar" ? { dateTime: "2026-10-31T12:00:00Z" } : "2026-10-31T12:00:00Z",
        end:
          provider === "calendar" ? { dateTime: "2026-10-31T13:00:00Z" } : "2026-10-31T13:00:00Z",
        attendees: [{ email: "candidate@example.test" }],
      };
      const rows = [undefined, null, 17, {}, "", "   ", "valid-a", "valid-b"].map((id) => ({
        ...base,
        [identity]: id,
      }));
      const execute = async function* () {
        yield {
          type: "result",
          data: {
            structuredContent:
              provider === "calendar"
                ? { events: rows }
                : { status: "success", data: rows, pagination: { hasNextPage: false } },
          },
        } as const;
      };
      const calendar = {
        ...source("calendar"),
        id: `malformed-${provider}`,
        provider: { kind: provider, tools: [] },
      };
      const output = empty();
      await refreshRecruitingCorrespondence(
        { prisma, connectors: { execute } },
        actor,
        { roleId: "role", threadId: "thread", view: "interview" },
        [calendar],
        output,
      );
      const prefix = provider === "calendar" ? calendar.id : `${calendar.id}:booking`;
      expect(output.events.map((event) => event.id)).toEqual([
        `${prefix}:valid-a`,
        `${prefix}:valid-b`,
      ]);
      expect(output.partial).toBe(true);
    },
  );
  it("reports provider failures instead of a fabricated connection requirement", async () => {
    const { prisma } = fixture();
    const execute = async function* () {
      yield { type: "error", message: "provider unavailable" } as const;
    };
    const output = empty();
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } },
      actor,
      { roleId: "role", threadId: "thread", view: "interview" },
      [source("calendar")],
      output,
    );
    expect(output.status).toBe("failed");
    expect(output.connections[0]?.status).toBe("configured");
    expect(output.partial).toBe(true);
  });
  it("shows no replies for a role without a campaign instead of an unknown count", async () => {
    const { prisma } = fixture();
    vi.mocked(prisma.externalEffect.findMany).mockResolvedValueOnce([] as never);
    const execute = vi.fn(async function* () {});
    const output = empty();
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } as Pick<ConnectorProvider, "execute"> },
      actor,
      { roleId: "role", threadId: "thread", view: "inbox" },
      [source("instantly")],
      output,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(output.status).toBe("empty");
    expect(output.partial).toBe(false);
  });
  it("does not read a calendar that has no connection yet", async () => {
    const { prisma } = fixture();
    const execute = vi.fn(async function* () {
      yield { type: "error", message: "unauthenticated" } as const;
    });
    const output = empty();
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } },
      actor,
      { roleId: "role", threadId: "thread", view: "interview" },
      [{ ...source("calendar"), secretId: null }],
      output,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(output.status).not.toBe("failed");
  });
});

it.each(["pending", "failed"])(
  "queues the actual live page without awaiting %s persistence or re-dating cached rows",
  async (publisher) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const { prisma } = fixture();
    const finishes: Array<() => void> = [];
    const enqueue = vi.fn((_job: unknown) =>
      publisher === "failed"
        ? Promise.reject(new Error("private test publisher failure"))
        : new Promise<void>((resolve) => finishes.push(resolve)),
    );
    const execute = vi.fn(async function* () {
      vi.advanceTimersByTime(5000);
      yield {
        type: "result" as const,
        data: {
          structuredContent: {
            items: [
              {
                id: "00000000-0000-4000-8000-000000000003",
                campaign_id: campaignId,
                timestamp_created: "2026-10-30T10:00:00Z",
                timestamp_email: "2026-10-30T10:00:00Z",
                message_id: "message-3",
                subject: "Actual provider reply",
                from_address_email: "candidate@example.test",
                to_address_email_list: "recruiter@example.test",
                body: { text: "Interested" },
                organization_id: "00000000-0000-4000-8000-000000000002",
                eaccount: "recruiter@example.test",
                ue_type: 2,
              },
            ],
          },
        },
      };
    });
    const output = empty();
    output.emails = [
      {
        id: "old",
        sourceId: "old-source",
        sourceName: "old",
        providerMessageId: "old",
        savedRead: null,
        sender: null,
        recipients: [],
        subject: "old",
        body: "Cached older body",
        snippet: false,
        date: null,
        url: null,
      },
    ];
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute }, jobs: { enqueue } as never },
      actor,
      { roleId: "role", threadId: "thread", view: "inbox" },
      [source("instantly")],
      output,
    );
    expect(output.emails).toHaveLength(2);
    expect(output.status).toBe("ready");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      name: "recruiting_inbox.project",
      payload: {
        observation: {
          threadId: "thread",
          roleId: "role",
          sourceId: "instantly",
          sourceRevision: 1,
          botId: "main",
          campaignId,
          observedAt: "2026-10-30T12:00:00.000Z",
          emails: [
            expect.objectContaining({ body: "Interested", eaccount: "recruiter@example.test" }),
          ],
        },
      },
    });
    for (const finish of finishes) finish();
  },
);

it("recognizes a shortened provider list as a preview and reads only the selected email's actual full body", async () => {
  const { prisma } = fixture();
  const id = "00000000-0000-4000-8000-000000000009";
  const fullBody = "Complete actual body. ".repeat(3000);
  let preview = "Preview [truncated — use get_email for full content]";
  const provider = {
    id,
    timestamp_created: "2026-10-30T12:00:00Z",
    timestamp_email: "2026-10-30T12:00:00Z",
    message_id: "message",
    subject: "Reply",
    from_address_email: "candidate@example.test",
    to_address_email_list: "recruiter@example.test",
    organization_id: "00000000-0000-4000-8000-000000000002",
    campaign_id: campaignId,
    eaccount: "recruiter@example.test",
    thread_id: "provider-thread",
    ue_type: 2,
  };
  const execute = vi.fn(async function* (call: {
    route?: { toolName: string };
    args: Record<string, unknown>;
  }) {
    yield {
      type: "result" as const,
      data: {
        structuredContent:
          call.route?.toolName === "native_instantly_get_email"
            ? { ...provider, body: { text: fullBody } }
            : {
                items: [
                  {
                    ...provider,
                    body: { text: preview },
                  },
                ],
              },
      },
    };
  });
  const output = empty();
  await refreshRecruitingCorrespondence(
    { prisma, connectors: { execute } as never },
    actor,
    { roleId: "role", threadId: "thread", view: "inbox" },
    [source("instantly")],
    output,
  );
  expect(output.emails[0]).toMatchObject({ body: "Preview ", snippet: true });
  const selected = output.emails[0]!;
  const complete = empty();
  const enqueue = vi.fn(async () => {});
  await refreshRecruitingCorrespondence(
    { prisma, connectors: { execute } as never, jobs: { enqueue } as never },
    actor,
    { roleId: "role", threadId: "thread", view: "inbox", message: selected },
    [source("instantly")],
    complete,
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]![0]).toMatchObject({
    route: { toolName: "native_instantly_get_email" },
    args: { id },
  });
  expect(complete.emails[0]).toMatchObject({ body: fullBody, snippet: false });
  preview = fullBody;
  const bounded = empty();
  await refreshRecruitingCorrespondence(
    { prisma, connectors: { execute } as never },
    actor,
    { roleId: "role", threadId: "thread", view: "inbox" },
    [source("instantly")],
    bounded,
  );
  expect(bounded.emails[0]).toMatchObject({ body: fullBody.slice(0, 50000), snippet: true });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: {
        observation: expect.objectContaining({
          emails: [expect.objectContaining({ body: fullBody })],
        }),
      },
    }),
  );
});

it.each(["id", "campaign_id", "thread_id", "eaccount"])(
  "refuses a full-body response with a changed %s",
  async (field) => {
    const { prisma } = fixture();
    const selected = {
      id: "instantly:00000000-0000-4000-8000-000000000009",
      providerMessageId: "00000000-0000-4000-8000-000000000009",
      providerThreadId: "thread",
      sourceId: "instantly",
      sourceName: "Mail",
      campaignId,
      eaccount: "recruiter@example.test",
      savedRead: null,
      sender: null,
      recipients: [],
      subject: "Reply",
      body: "Preview",
      snippet: true,
      date: null,
      url: null,
    };
    const row = {
      id: selected.providerMessageId,
      campaign_id: campaignId,
      thread_id: "thread",
      eaccount: selected.eaccount,
      timestamp_created: "2026-10-30T12:00:00Z",
      timestamp_email: "2026-10-30T12:00:00Z",
      message_id: "message",
      subject: "Reply",
      from_address_email: "candidate@example.test",
      to_address_email_list: "recruiter@example.test",
      organization_id: "00000000-0000-4000-8000-000000000002",
      body: { text: "Foreign body" },
      [field]:
        field === "eaccount" ? "foreign@example.test" : "00000000-0000-4000-8000-000000000099",
    };
    const execute = vi.fn(async function* () {
      yield { type: "result" as const, data: { structuredContent: row } };
    });
    const output = empty();
    const enqueue = vi.fn(async () => {});
    await refreshRecruitingCorrespondence(
      { prisma, connectors: { execute } as never, jobs: { enqueue } as never },
      actor,
      { roleId: "role", threadId: "thread", view: "inbox", message: selected },
      [source("instantly")],
      output,
    );
    expect(output.emails).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  },
);
