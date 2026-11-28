import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, Prisma } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecruitingRoleReply } from "./recruiting-tools.js";

const listRecruitingCandidates = vi.fn();
const readRecruitingRoleRepliesSince = vi.fn();
const getRecruitingCorrespondence = vi.fn();
const projectRecruitingInboxMessages = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  listRecruitingCandidates: (...args: unknown[]) => listRecruitingCandidates(...args),
  projectRecruitingInboxMessages: (...args: unknown[]) => projectRecruitingInboxMessages(...args),
}));
vi.mock("./recruiting-tools.js", () => ({
  readRecruitingRoleRepliesSince: (...args: unknown[]) => readRecruitingRoleRepliesSince(...args),
}));
vi.mock("./recruiting-reads.js", () => ({
  getRecruitingCorrespondence: (...args: unknown[]) => getRecruitingCorrespondence(...args),
}));

const {
  RECRUITING_CHECKIN_NONCE_PREFIX,
  RECRUITING_CHECKIN_RETRY_MS,
  startRecruitingCheckin,
  sweepRecruitingCheckins,
} = await import("./recruiting-checkin.js");

const now = Date.parse("2026-10-30T12:00:00Z");
const target = {
  mcpServerId: "crm-server",
  serverRevision: 1,
  organizationId: "org",
  crmRoleId: "crm-role",
  clientLabel: "Northwind",
  roleLabel: "Platform lead",
};
const reply = (id: string, body: string, subject = "Re: Platform lead"): RecruitingRoleReply => ({
  id,
  crmCandidateId: `candidate-${id}`,
  name: `Person ${id}`,
  email: `${id}@example.test`,
  at: "2026-10-30T11:00:00Z",
  from: `${id}@example.test`,
  subject,
  body,
});

function fixture(options: {
  busy?: boolean;
  replies?: RecruitingRoleReply[];
  earlier?: Array<{ createdAt: Date; checkinReplyIds: unknown }>;
  /** A conversation with no role that emailed people from its own one-off campaigns. */
  direct?: Array<{ request: unknown; result: unknown }>;
  /** Saved tool calls of the conversation: Gmail sends and reads by id. */
  calls?: Array<{ request: unknown; result: unknown }>;
}) {
  const runCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
    id: "checkin-run",
  }));
  const taskCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "task" }));
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    run: { findFirst: vi.fn(async () => null), create: runCreate },
    task: { create: taskCreate },
  };
  const prisma = {
    thread: {
      findUnique: vi.fn(async () => ({
        id: "thread",
        spaceId: "space",
        userId: "user",
        botId: null,
        groupId: "group",
        activeRecruitingRole: options.direct
          ? null
          : { id: "role", userId: "user", archivedAt: null },
      })),
    },
    externalEffect: {
      // Saved tool calls are matched by their catalog marker.
      findMany: vi.fn(async (args: { where: { request?: { path?: string[] } } }) =>
        args.where.request?.path?.[0] === "0" ? (options.calls ?? []) : (options.direct ?? []),
      ),
    },
    mcpServer: {
      findMany: vi.fn(async () => [
        { id: "gmail-server", name: "Gmail" },
        { id: "mail-server", name: "Mail" },
      ]),
    },
    run: {
      findFirst: vi.fn(async () => (options.busy ? { id: "busy" } : null)),
      findMany: vi.fn(async () => options.earlier ?? []),
    },
    chatGroupMember: {
      findMany: vi.fn(async () => [
        {
          botId: "outreach",
          bot: { name: "Outreach", spawnKey: "recruiting:x:outreach", archivedAt: null },
        },
        { botId: "main", bot: { name: "Main", spawnKey: "recruiting:x:main", archivedAt: null } },
      ]),
    },
    botMcpServer: {
      findMany: vi.fn(async () => [{ botId: "outreach" }]),
      findFirst: vi.fn(async () => ({ botId: "outreach", server: { revision: 3 } })),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
  const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher & {
    enqueue: ReturnType<typeof vi.fn>;
  };
  readRecruitingRoleRepliesSince.mockResolvedValue({
    replies: options.replies ?? [],
    complete: true,
  });
  return { prisma, jobs, runCreate, taskCreate };
}

const start = (deps: ReturnType<typeof fixture>) =>
  startRecruitingCheckin(
    {
      prisma: deps.prisma,
      jobs: deps.jobs,
      events: { wakeSessions: vi.fn(async () => undefined) },
      connector: { execute: vi.fn() },
    },
    { threadId: "thread" },
    now,
  );

beforeEach(() => {
  listRecruitingCandidates.mockReset();
  listRecruitingCandidates.mockResolvedValue({ crmTarget: { target } });
  readRecruitingRoleRepliesSince.mockReset();
  getRecruitingCorrespondence.mockReset();
  projectRecruitingInboxMessages.mockClear();
});

describe("startRecruitingCheckin", () => {
  it("waits while the conversation is busy, never reads the CRM, and looks again shortly", async () => {
    const deps = fixture({ busy: true, replies: [reply("a", "Interested!")] });
    await start(deps);
    expect(readRecruitingRoleRepliesSince).not.toHaveBeenCalled();
    expect(deps.runCreate).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recruiting_checkin.start",
        availableAt: new Date(now + RECRUITING_CHECKIN_RETRY_MS),
      }),
    );
  });
});

describe("sweepRecruitingCheckins", () => {
  it("offers each role once, from the conversation it was set up in", async () => {
    const prisma = {
      externalEffect: {
        findMany: vi.fn(async (args: { where: { kind: unknown } }) =>
          typeof args.where.kind === "string"
            ? [
                { request: { roleId: "sending-role" }, run: { threadId: "source" } },
                { request: null, run: { threadId: "x" } },
                { request: { serverId: "mail", direct: true }, run: { threadId: "main" } },
              ]
            : // Emails sent from a recruiter's own Gmail, here through the catalog's execute
              // tool; another connection's send_message is not Gmail.
              [
                {
                  request: [
                    "__rakazoCatalogTool",
                    "gmail_execute_tool",
                    { id: "send_message", arguments: { to: ["ethan@example.test"] } },
                    {
                      connectorId: "mcp",
                      resourceId: "gmail-id",
                      resourceRevision: 1,
                      toolName: "send_message",
                    },
                  ],
                  result: {
                    structuredContent: {
                      sent: true,
                      to: "ethan@example.test",
                      messageId: "m1",
                      threadId: "t1",
                    },
                  },
                  run: { threadId: "gmail-thread" },
                },
                {
                  request: [
                    "__rakazoCatalogTool",
                    "direct",
                    {
                      route: {
                        connectorId: "mcp",
                        resourceId: "chat-id",
                        resourceRevision: 1,
                        toolName: "send_message",
                      },
                      args: { text: "hi" },
                    },
                  ],
                  result: {
                    structuredContent: { sent: true, to: "x", messageId: "m2", threadId: "t2" },
                  },
                  run: { threadId: "chat-thread" },
                },
              ],
        ),
      },
      mcpServer: { findMany: vi.fn(async () => [{ id: "gmail-id" }]) },
      thread: {
        findMany: vi.fn(async () => [
          { id: "source", activeRecruitingRole: { sourceThreadId: "source" } },
          { id: "other", activeRecruitingRole: { sourceThreadId: "source" } },
          { id: "main", activeRecruitingRole: null },
        ]),
      },
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    expect(await sweepRecruitingCheckins({ prisma, jobs, now: new Date(now), batchSize: 10 })).toBe(
      2,
    );
    // The conversation that emailed someone outside a role is checked too.
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { threadId: "main" } }),
    );
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recruiting_checkin.start",
        payload: { threadId: "source" },
      }),
    );
    // Roles that email people are offered too, not only CRM-linked ones.
    const where = (prisma.thread.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0].where;
    expect(where.OR[0].activeRecruitingRole.OR).toContainEqual({ id: { in: ["sending-role"] } });
    expect(where.OR[1]).toEqual({ id: { in: ["main", "gmail-thread"] } });
  });
});

describe("check-in queries", () => {
  it("are valid for the real schema", async () => {
    // Nothing listens on port 1: a valid query fails only on the connection, never on its shape.
    const { prisma, pool } = createDb("postgres://user:pass@127.0.0.1:1/db");
    try {
      const jobs = { enqueue: vi.fn(async () => undefined) };
      const error = await sweepRecruitingCheckins({
        prisma,
        jobs,
        now: new Date(now),
        batchSize: 1,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeDefined();
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientValidationError);
    } finally {
      await pool.end();
    }
  });
});

describe("recipientNames", () => {
  it("names a reply's sender from the recipients this conversation emailed, newest send first", async () => {
    const { recipientNames } = await import("./recruiting-checkin-mail.js");
    const call = (args: Record<string, unknown>) =>
      ({ route: { toolName: "native_instantly_ensure_role_campaign" }, args }) as never;
    const names = recipientNames([
      // A draft that was never sent names nobody.
      { route: { toolName: "create_draft" }, args: { to: "Ada Park <ada@x.test>" } } as never,
      call({ recipients: ["Ada Lin <Ada@x.test>"] }),
      call({ recipients: ["Ada Park <ada@x.test>", "ethan@x.test"] }),
      call({ leads: [{ email: "mia@x.test", first_name: "Mia", last_name: "Chen" }] }),
    ]);
    expect(names.get("ada@x.test")).toBe("Ada Lin");
    expect(names.has("ethan@x.test")).toBe(false);
    expect(names.get("mia@x.test")).toBe("Mia Chen");
  });
});
