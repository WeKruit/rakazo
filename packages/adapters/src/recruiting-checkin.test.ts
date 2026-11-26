import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, Prisma } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecruitingRoleReply } from "./recruiting-tools.js";

const listRecruitingCandidates = vi.fn();
const readRecruitingRoleRepliesSince = vi.fn();
const getRecruitingCorrespondence = vi.fn();
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  listRecruitingCandidates: (...args: unknown[]) => listRecruitingCandidates(...args),
}));
vi.mock("./recruiting-tools.js", () => ({
  readRecruitingRoleRepliesSince: (...args: unknown[]) => readRecruitingRoleRepliesSince(...args),
}));
vi.mock("./recruiting-reads.js", () => ({
  getRecruitingCorrespondence: (...args: unknown[]) => getRecruitingCorrespondence(...args),
}));

const { RECRUITING_CHECKIN_NONCE_PREFIX, startRecruitingCheckin, sweepRecruitingCheckins } =
  await import("./recruiting-checkin.js");

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
  earlier?: Array<{ createdAt: Date; task: { prompt: string } }>;
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
        activeRecruitingRole: { id: "role", userId: "user", archivedAt: null },
      })),
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
    botMcpServer: { findMany: vi.fn(async () => [{ botId: "outreach" }]) },
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
    expect(run).toMatchObject({ botId: "main", trigger: "recruiting_checkin", status: "queued" });
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
    expect(deps.jobs.enqueue).toHaveBeenCalledTimes(1);
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
          task: {
            prompt: '- Person a <a@example.test>, x, subject "y" (reply id: a)\n  > Interested!',
          },
        },
      ],
    });
    await start(deps);
    expect(deps.runCreate).not.toHaveBeenCalled();
    // Later check-ins re-read six hours before the last one.
    expect(readRecruitingRoleRepliesSince.mock.calls[0]![3]).toBe("2026-10-30T05:30:00.000Z");
  });

  it("waits while the conversation is busy and never reads the CRM", async () => {
    const deps = fixture({ busy: true, replies: [reply("a", "Interested!")] });
    await start(deps);
    expect(readRecruitingRoleRepliesSince).not.toHaveBeenCalled();
    expect(deps.runCreate).not.toHaveBeenCalled();
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
      earlier: [{ createdAt: new Date(now - 5 * 60_000), task: { prompt } }],
    });
    await start(again);
    expect(again.runCreate).not.toHaveBeenCalled();
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
        findMany: vi.fn(async () => [{ request: { roleId: "sending-role" } }, { request: null }]),
      },
      thread: {
        findMany: vi.fn(async () => [
          { id: "source", activeRecruitingRole: { sourceThreadId: "source" } },
          { id: "other", activeRecruitingRole: { sourceThreadId: "source" } },
        ]),
      },
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) };
    expect(await sweepRecruitingCheckins({ prisma, jobs, now: new Date(now), batchSize: 10 })).toBe(
      1,
    );
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recruiting_checkin.start",
        payload: { threadId: "source" },
      }),
    );
    // Roles that email people are offered too, not only CRM-linked ones.
    const where = (prisma.thread.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0].where;
    expect(where.activeRecruitingRole.OR).toContainEqual({ id: { in: ["sending-role"] } });
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
