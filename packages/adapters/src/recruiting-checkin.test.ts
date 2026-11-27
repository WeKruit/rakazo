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
    { prisma: deps.prisma, jobs: deps.jobs, connector: { execute: vi.fn() } },
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
  it("opens one turn for the lead when a candidate replied", async () => {
    const deps = fixture({
      replies: [
        reply("a", "Happy to talk. Does Thursday work?"),
        reply("b", "Not for me, thanks."),
      ],
    });
    await start(deps);
    expect(deps.runCreate).toHaveBeenCalledTimes(1);
    const run = deps.runCreate.mock.calls[0]![0].data;
    expect(run).toMatchObject({
      botId: "main",
      trigger: "recruiting_checkin",
      status: "queued",
      checkinReplyIds: ["a", "b"],
    });
    expect(String(run.clientNonce)).toMatch(
      new RegExp(`^${RECRUITING_CHECKIN_NONCE_PREFIX}thread:`),
    );
    const prompt = String(deps.taskCreate.mock.calls[0]![0].data.prompt);
    expect(prompt).toContain("2 candidates replied");
    expect(prompt).toContain("(reply id: a)");
    expect(prompt).toContain("(reply id: b)");
    // The bot that holds the CRM reads it; the first check-in looks back one day.
    const [, , context, since] = readRecruitingRoleRepliesSince.mock.calls[0]!;
    expect(context).toMatchObject({ botId: "outreach", spaceId: "space", userId: "user" });
    expect(since).toBe("2026-10-29T12:00:00.000Z");
    // The run starts, and the conversation is checked again once that run is done.
    expect(deps.jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "checkin-run" } }),
    );
  });

  it("checks again right after its own run, so a second reply that lands meanwhile is not left for the next sweep", async () => {
    // Branch play 11-26 (candidate-conversation #2): Ada replied four seconds after the run
    // that answered Ethan began; nothing read the mailbox again for five minutes.
    const deps = fixture({ replies: [reply("ethan", "Interested.")] });
    await start(deps);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recruiting_checkin.start",
        payload: { threadId: "thread" },
        availableAt: new Date(now + RECRUITING_CHECKIN_RETRY_MS),
      }),
    );
  });

  it("stays quiet when nothing is new", async () => {
    const deps = fixture({ replies: [] });
    await start(deps);
    expect(deps.runCreate).not.toHaveBeenCalled();
  });

  it("sets automatic replies aside without a model call", async () => {
    const deps = fixture({
      replies: [
        reply("ooo", "Back Monday.", "Automatic reply: Platform lead"),
        reply("bounce", "Address not found.", "Undeliverable: Platform lead"),
      ],
    });
    await start(deps);
    expect(deps.runCreate).not.toHaveBeenCalled();
  });

  it("counts automatic replies but lists only the ones that need sorting", async () => {
    const deps = fixture({
      replies: [reply("ooo", "Back Monday.", "Out of Office"), reply("a", "Interested!")],
    });
    await start(deps);
    const prompt = String(deps.taskCreate.mock.calls[0]![0].data.prompt);
    expect(prompt).toContain("a candidate replied");
    expect(prompt).toContain("1 automatic reply");
    expect(prompt).not.toContain("(reply id: ooo)");
  });

  it("never reports a reply an earlier check-in reported", async () => {
    const deps = fixture({
      replies: [reply("a", "Interested!")],
      earlier: [
        {
          createdAt: new Date(now - 30 * 60_000),
          checkinReplyIds: ["a"],
        },
      ],
    });
    await start(deps);
    expect(deps.runCreate).not.toHaveBeenCalled();
    // Later check-ins re-read six hours before the last one.
    expect(readRecruitingRoleRepliesSince.mock.calls[0]![3]).toBe("2026-10-30T05:30:00.000Z");
  });

  it("never reports a reply the conversation's agent already read", async () => {
    // A reply the agent had read when the recruiter asked about it was announced again as new.
    const route = (resourceId: string, toolName: string) => ({
      connectorId: "mcp",
      resourceId,
      resourceRevision: 3,
      toolName,
    });
    const deps = fixture({
      replies: [reply("a", "Interested."), reply("b", "Call me."), reply("c", "Not now.")],
      calls: [
        // Read through the bound tool, and through the catalog's generic execute tool.
        {
          request: [
            "__rakazoCatalogTool",
            "direct",
            { route: route("mail", "native_instantly_get_email"), args: { id: "a" } },
          ],
          result: { structuredContent: { id: "a" } },
        },
        {
          request: [
            "__rakazoCatalogTool",
            "gmail_execute_tool",
            { id: "get_message", arguments: { messageId: "b" } },
            route("gmail-server", "get_message"),
          ],
          result: { structuredContent: { id: "b" } },
        },
      ],
    });
    await start(deps);
    expect(deps.runCreate.mock.calls[0]![0].data.checkinReplyIds).toEqual(["c"]);
  });

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

  it("wakes the conversation that emailed someone outside a role when they reply", async () => {
    // Branch play 11-26 (candidate-conversation #3): the first emails were sent from the main
    // conversation, so no role held them and neither candidate's reply woke anyone.
    const email = (id: string, ue_type: 1 | 2, from: string) => ({
      id,
      timestamp_created: "2026-10-30T11:30:00.000Z",
      timestamp_email: "2026-10-30T11:30:00.000Z",
      message_id: `<${id}@mail.test>`,
      subject: "Re: Data role",
      from_address_email: from,
      to_address_email_list: ue_type === 2 ? "me@mail.test" : "ada@example.test",
      body: { text: ue_type === 2 ? "Not looking, please stop." : "Hi Ada" },
      organization_id: "00000000-0000-4000-8000-000000000001",
      campaign_id: "00000000-0000-4000-8000-0000000000c1",
      lead: "ada@example.test",
      eaccount: "me@mail.test",
      ue_type,
    });
    const execute = vi.fn(async function* () {
      yield {
        type: "result" as const,
        data: {
          structuredContent: {
            result: {
              items: [
                email("00000000-0000-4000-8000-0000000000a2", 2, "ada@example.test"),
                email("00000000-0000-4000-8000-0000000000a1", 1, "me@mail.test"),
              ],
            },
          },
        },
      };
    });
    const deps = fixture({
      direct: [
        {
          request: { serverId: "mail-server", direct: true },
          result: { campaignId: "00000000-0000-4000-8000-0000000000c1" },
        },
      ],
    });
    await startRecruitingCheckin(
      { prisma: deps.prisma, jobs: deps.jobs, connector: { execute } },
      { threadId: "thread" },
      now,
    );
    expect(listRecruitingCandidates).not.toHaveBeenCalled();
    const [call, context] = execute.mock.calls[0] as unknown as [
      { route: Record<string, unknown>; args: unknown },
      { botId: string },
    ];
    expect(call.route).toMatchObject({ resourceId: "mail-server", toolName: "list_emails" });
    expect(call.args).toEqual({ campaign_id: "00000000-0000-4000-8000-0000000000c1", limit: 50 });
    expect(context.botId).toBe("outreach");
    expect(deps.runCreate).toHaveBeenCalledTimes(1);
    expect(deps.runCreate.mock.calls[0]![0].data.checkinReplyIds).toEqual([
      "00000000-0000-4000-8000-0000000000a2",
    ]);
    const prompt = String(deps.taskCreate.mock.calls[0]![0].data.prompt);
    expect(prompt).toContain("ada@example.test");
    // The email and its answer are kept under this conversation for the account Inbox.
    const [, owner, stored] = projectRecruitingInboxMessages.mock.calls[0] as unknown as [
      unknown,
      { userId: string; spaceId: string },
      {
        conversationId?: string;
        roleId?: string;
        emails: { direction: string; sourceName: string }[];
      },
    ];
    expect(owner).toMatchObject({ userId: "user", spaceId: "space" });
    expect(stored.conversationId).toBe("thread");
    expect(stored.roleId).toBeUndefined();
    expect(stored.emails.map((row) => [row.direction, row.sourceName])).toEqual([
      ["received", "Mail"],
      ["sent", "Mail"],
    ]);
  });

  it("reads a role without a CRM link from its own mailbox, and wakes it once per reply", async () => {
    listRecruitingCandidates.mockResolvedValue({ crmTarget: null });
    const mail = (id: string, direction: "sent" | "received") => ({
      id: `source:${id}`,
      providerMessageId: id,
      direction,
      sender: direction === "received" ? "ethan@example.test" : "me@mail.test",
      recipients: [],
      subject: "Re: Data role",
      body: "What is the pay?",
      date: "2026-10-30T11:30:00Z",
    });
    getRecruitingCorrespondence.mockResolvedValue({
      status: "ready",
      emails: [mail("sent-1", "sent"), mail("reply-1", "received")],
    });
    const deps = fixture({});
    await start(deps);
    expect(readRecruitingRoleRepliesSince).not.toHaveBeenCalled();
    const [, , readTarget, view] = getRecruitingCorrespondence.mock.calls[0]!;
    expect(readTarget).toMatchObject({ kind: "group", groupId: "group", threadId: "thread" });
    expect(view).toBe("inbox");
    expect(deps.runCreate).toHaveBeenCalledTimes(1);
    expect(deps.runCreate.mock.calls[0]![0].data).toMatchObject({ botId: "main" });
    const prompt = String(deps.taskCreate.mock.calls[0]![0].data.prompt);
    expect(prompt).toContain("(reply id: reply-1)");
    expect(prompt).not.toContain("sent-1");
    // The same reply on the next sweep wakes nobody.
    const again = fixture({
      earlier: [
        {
          createdAt: new Date(now - 5 * 60_000),
          checkinReplyIds: deps.runCreate.mock.calls[0]![0].data.checkinReplyIds,
        },
      ],
    });
    await start(again);
    expect(again.runCreate).not.toHaveBeenCalled();
  });

  it("wakes the conversation when someone it emailed from Gmail answers in that thread", async () => {
    // A Gmail one-off was never read again, so its answer reached nobody.
    listRecruitingCandidates.mockResolvedValue({ crmTarget: null });
    getRecruitingCorrespondence.mockResolvedValue({ status: "ready", emails: [] });
    const route = {
      connectorId: "mcp",
      resourceId: "gmail-server",
      resourceRevision: 2,
      toolName: "send_message",
    };
    const execute = vi.fn(async function* () {
      yield {
        type: "result" as const,
        data: {
          structuredContent: {
            id: "t1",
            messages: [
              {
                id: "sent-1",
                sender: "Recruiter <me@mail.test>",
                date: "2026-10-30T11:00:00Z",
                subject: "Data role",
              },
              {
                id: "other",
                sender: "someone@else.test",
                date: "2026-10-30T11:20:00Z",
                subject: "Re: Data role",
              },
              {
                id: "reply-1",
                sender: "Ethan Park <Ethan@Example.test>",
                date: "2026-10-30T11:30:00Z",
                subject: "Re: Data role",
                plaintextBody: "What is the pay?",
              },
            ],
          },
        },
      };
    });
    const deps = fixture({
      calls: [
        {
          request: [
            "__rakazoCatalogTool",
            "direct",
            { route, args: { to: ["ethan@example.test"], subject: "Data role", body: "Hi" } },
          ],
          result: {
            structuredContent: {
              sent: true,
              to: "ethan@example.test",
              messageId: "sent-1",
              threadId: "t1",
            },
          },
        },
      ],
    });
    await startRecruitingCheckin(
      { prisma: deps.prisma, jobs: deps.jobs, connector: { execute } },
      { threadId: "thread" },
      now,
    );
    const [call] = execute.mock.calls[0] as unknown as [{ route: unknown; args: unknown }];
    expect(call.route).toMatchObject({ resourceId: "gmail-server", toolName: "get_thread" });
    expect(call.args).toEqual({ threadId: "t1", messageFormat: "FULL_CONTENT" });
    expect(deps.runCreate).toHaveBeenCalledTimes(1);
    expect(deps.runCreate.mock.calls[0]![0].data.checkinReplyIds).toEqual(["reply-1"]);
    const prompt = String(deps.taskCreate.mock.calls[0]![0].data.prompt);
    expect(prompt).toContain("(reply id: reply-1)");
    expect(prompt).toContain("What is the pay?");
    // The thread's own email and the answer are stored for the account Inbox; nobody else's.
    const stored = projectRecruitingInboxMessages.mock.calls[0]![2] as {
      roleId?: string;
      emails: { id: string; direction: string; eaccount?: string }[];
    };
    expect(stored.roleId).toBe("role");
    expect(stored.emails.map((row) => [row.id, row.direction, row.eaccount])).toEqual([
      ["gmail-server:sent-1", "sent", "me@mail.test"],
      ["gmail-server:reply-1", "received", "me@mail.test"],
    ]);
  });

  it("treats a failed read as unknown, not as no replies", async () => {
    const deps = fixture({});
    readRecruitingRoleRepliesSince.mockRejectedValue(new Error("CRM unavailable"));
    await expect(start(deps)).resolves.toBeUndefined();
    expect(deps.runCreate).not.toHaveBeenCalled();
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
      call({ recipients: ["Ada Lin <Ada@x.test>"] }),
      call({ recipients: ["Ada Park <ada@x.test>", "ethan@x.test"] }),
      call({ leads: [{ email: "mia@x.test", first_name: "Mia", last_name: "Chen" }] }),
    ]);
    expect(names.get("ada@x.test")).toBe("Ada Lin");
    expect(names.has("ethan@x.test")).toBe(false);
    expect(names.get("mia@x.test")).toBe("Mia Chen");
  });
});
