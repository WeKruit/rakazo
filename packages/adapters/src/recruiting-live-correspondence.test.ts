import type { ConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor, RecruitingCorrespondence } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshRecruitingCorrespondence } from "./recruiting-live-correspondence.js";

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
            items: [
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
  it("does not share cached personal calendars across accounts", async () => {
    const { prisma } = fixture();
    const execute = vi.fn(async function* () {
      yield { type: "result", data: { structuredContent: { items: [] } } } as const;
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
                ? { items: later ? [row] : [], ...(later ? {} : { nextPageToken: "next" }) }
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
                ? { items: rows }
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
