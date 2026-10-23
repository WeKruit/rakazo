import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { listRoutineRuns } from "./routine-runs.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const at = new Date("2026-01-02T12:00:00Z");
function fixture() {
  const routine = vi.fn().mockResolvedValue({ botId: "bot-1" });
  const runs = vi.fn().mockResolvedValue([]);
  const messages = vi.fn().mockResolvedValue([]);
  const outbound = vi.fn().mockResolvedValue([]);
  const prisma = {
    routine: { findFirst: routine },
    run: { findMany: runs },
    $queryRaw: messages,
    message: { findMany: outbound },
  } as unknown as PrismaClient;
  return { prisma, routine, runs, messages, outbound };
}
function historyRun(id: string, botId = "bot-1", groupId: string | null = null) {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const threadId = groupId ? "group-thread" : `${botId}-thread`;
  return {
    id,
    ...owner,
    botId,
    threadId,
    bot: { id: botId, ...owner, name: botId, archivedAt: null },
    thread: {
      id: threadId,
      ...owner,
      botId: groupId ? null : botId,
      groupId,
      group: groupId ? { id: groupId, ...owner, archivedAt: null } : null,
      externalConversationId: null,
      externalConversation: null,
    },
    status: "completed",
    trigger: "routine",
    sourceMessageId: null as string | null,
    sourceMessage: null as unknown,
    createdAt: at,
    startedAt: at as Date | null,
    completedAt: at as Date | null,
  };
}
describe("routine history", () => {
  it("refuses missing, foreign or archived routines before reading runs", async () => {
    const { prisma, routine, runs, messages } = fixture();
    routine.mockResolvedValue(null);
    await expect(listRoutineRuns(prisma, actor, "routine-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(routine).toHaveBeenCalledWith({
      where: {
        id: "routine-1",
        spaceId: actor.spaceId,
        userId: actor.userId,
        bot: { archivedAt: null },
      },
      select: { botId: true },
    });
    expect(runs).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });
  it("returns a bounded, newest-first history including silent, failed and queued runs", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockResolvedValue(
      ["completed", "failed", "queued"].map((status, i) => ({
        ...historyRun(`run-${i}`, "bot-1", i === 1 ? "group-1" : null),
        status,
        createdAt: at,
        startedAt: status === "queued" ? null : at,
        completedAt: status === "queued" ? null : new Date(at.getTime() + 82_000),
      })),
    );
    messages.mockResolvedValue([{ id: "reply-new", runId: "run-1", threadId: "group-thread" }]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history)).toEqual(history);
    expect(history.runs.map((row) => row.messageId)).toEqual([null, "reply-new", null]);
    expect(history.runs.map((row) => row.groupId)).toEqual([null, "group-1", null]);
    expect(history.runs[2]?.startedAt).toBeNull();
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          routineId: "routine-1",
          botId: "bot-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        take: 21,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    const sql = messages.mock.calls[0]?.[0];
    expect(sql.sql).toContain('DISTINCT ON (m."runId")');
    expect(sql.sql).toContain('r."threadId" = m."threadId"');
    expect(sql.values).toEqual([
      "run-0",
      "run-1",
      "run-2",
      actor.spaceId,
      actor.userId,
      actor.spaceId,
      actor.userId,
      3,
    ]);
  });
  it("follows real group and DM requests across multiple specialist runs without inheriting root completion", async () => {
    const f = fixture();
    const root = historyRun("root", "main", "group");
    const handoff = {
      id: "handoff",
      threadId: root.threadId,
      runId: root.id,
      botId: root.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [
        {
          kind: "handoff",
          fromBotId: "main",
          toBotId: "sourcer",
          text: "Research the saved role",
          hop: 1,
        },
      ],
    };
    const child = {
      ...historyRun("child", "sourcer", "group"),
      trigger: "follow_up",
      sourceMessageId: handoff.id,
      sourceMessage: handoff,
      status: "failed",
      bot: { ...historyRun("child", "sourcer", "group").bot, name: "Sourcer" },
    };
    const sent = {
      id: "sent",
      threadId: child.threadId,
      runId: child.id,
      botId: child.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: "helper",
          toBotName: "Old name",
          intent: "question",
          text: "Check the source",
        },
      ],
    };
    const inbound = {
      id: "inbound",
      threadId: "helper-thread",
      runId: "grandchild",
      botId: null,
      role: "user",
      externalTranscriptFor: null,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "sourcer",
          fromBotName: "Sourcer",
          intent: "question",
          text: "Check the source",
          returnToMessageId: sent.id,
          hop: 1,
        },
      ],
    };
    const grandchild = {
      ...historyRun("grandchild", "helper"),
      trigger: "bot_message",
      sourceMessageId: inbound.id,
      sourceMessage: inbound,
      status: "running",
      completedAt: null,
      bot: { ...historyRun("grandchild", "helper").bot, name: "Research helper" },
    };
    f.runs
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([child])
      .mockResolvedValueOnce([grandchild]);
    f.outbound
      .mockResolvedValueOnce([handoff])
      .mockResolvedValueOnce([sent])
      .mockResolvedValueOnce([]);
    const history = await listRoutineRuns(f.prisma, actor, "routine-1");
    expect(history.runs[0]).toMatchObject({
      id: root.id,
      status: "completed",
      delegations: [
        {
          id: child.id,
          parentRunId: root.id,
          botName: "Sourcer",
          status: "failed",
          messageId: handoff.id,
          groupId: "group",
        },
        {
          id: grandchild.id,
          parentRunId: child.id,
          botName: "Research helper",
          status: "running",
          completedAt: null,
          messageId: inbound.id,
          groupId: null,
        },
      ],
    });
    for (const [query] of f.runs.mock.calls) expect(query).toHaveProperty("take");
    for (const [query] of f.outbound.mock.calls) expect(query).toHaveProperty("take");
    expect(RoutineHistorySchema.parse(history)).toEqual(history);
  });

  it.each(["request", "question", "result", "status", "fyi", undefined])(
    "includes only explicitly task-bearing DM intent %s",
    async (intent) => {
      const f = fixture();
      const root = historyRun("root");
      const sent = {
        id: "sent",
        threadId: root.threadId,
        runId: root.id,
        botId: root.botId,
        role: "bot",
        externalTranscriptFor: null,
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "helper",
            toBotName: "Helper",
            text: "Check",
            intent,
          },
        ],
      };
      const source = {
        id: "received",
        threadId: "helper-thread",
        runId: "child",
        botId: null,
        role: "user",
        externalTranscriptFor: null,
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: root.botId,
            fromBotName: "Main",
            text: "Check",
            intent,
            returnToMessageId: sent.id,
          },
        ],
      };
      const child = {
        ...historyRun("child", "helper"),
        trigger: "bot_message",
        sourceMessageId: source.id,
        sourceMessage: source,
      };
      f.runs.mockResolvedValueOnce([root]).mockResolvedValueOnce([child]);
      f.outbound.mockResolvedValueOnce([sent]);
      const history = await listRoutineRuns(f.prisma, actor, "routine-1");
      expect(history.runs[0]?.delegations.map((run) => run.id)).toEqual(
        intent === "request" || intent === "question" ? [child.id] : [],
      );
      if (intent !== "request" && intent !== "question") expect(f.runs).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "foreign run",
    "foreign bot",
    "foreign thread",
    "foreign group",
    "wrong source",
    "wrong author",
    "wrong target",
    "wrong thread",
    "missing source",
  ])("does not expose a group child through %s", async (invalid) => {
    const f = fixture();
    const root = historyRun("root", "main", "group");
    const source = {
      id: "handoff",
      threadId: root.threadId,
      runId: root.id,
      botId: root.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [{ kind: "handoff", fromBotId: root.botId, toBotId: "helper", text: "Check" }],
    };
    const child = {
      ...historyRun("child", "helper", "group"),
      trigger: "follow_up",
      sourceMessageId: source.id,
      sourceMessage: { ...source, blocks: source.blocks.map((block) => ({ ...block })) } as
        | typeof source
        | null,
    };
    if (invalid === "foreign run") child.userId = "other";
    if (invalid === "foreign bot") child.bot.spaceId = "other";
    if (invalid === "foreign thread") child.thread.userId = "other";
    if (invalid === "foreign group") child.thread.group!.spaceId = "other";
    if (invalid === "wrong source") child.sourceMessageId = "different";
    if (invalid === "wrong author") child.sourceMessage!.botId = "other";
    if (invalid === "wrong target") child.sourceMessage!.blocks[0]!.toBotId = "other";
    if (invalid === "wrong thread") child.threadId = "different";
    if (invalid === "missing source") child.sourceMessage = null;
    f.runs.mockResolvedValueOnce([root]).mockResolvedValueOnce([child]);
    f.outbound.mockResolvedValueOnce([source]);
    const history = await listRoutineRuns(f.prisma, actor, "routine-1");
    expect(history.runs[0]?.delegations).toEqual([]);
    expect(f.messages.mock.calls[0]?.[0].values).not.toContain(child.id);
  });

  it("reuses fetched runs while preserving each root's own overlapping chain", async () => {
    const f = fixture();
    const root = historyRun("root", "main", "group");
    const first = {
      id: "first",
      threadId: root.threadId,
      runId: root.id,
      botId: root.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [{ kind: "handoff", fromBotId: "main", toBotId: "helper", text: "First" }],
    };
    const secondRoot = {
      ...historyRun("second-root", "helper", "group"),
      trigger: "follow_up",
      sourceMessageId: first.id,
      sourceMessage: first,
    };
    const second = {
      id: "second",
      threadId: root.threadId,
      runId: secondRoot.id,
      botId: secondRoot.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [{ kind: "handoff", fromBotId: "helper", toBotId: "third", text: "Second" }],
    };
    const leaf = {
      ...historyRun("leaf", "third", "group"),
      trigger: "follow_up",
      sourceMessageId: second.id,
      sourceMessage: second,
    };
    f.runs
      .mockResolvedValueOnce([root, secondRoot])
      .mockResolvedValueOnce([secondRoot, leaf, leaf]);
    f.outbound.mockResolvedValueOnce([first, second]);
    const history = await listRoutineRuns(f.prisma, actor, "routine-1");
    expect(
      history.runs.map((run) => run.delegations.map((child) => [child.id, child.parentRunId])),
    ).toEqual([
      [
        [secondRoot.id, root.id],
        [leaf.id, secondRoot.id],
      ],
      [[leaf.id, secondRoot.id]],
    ]);
    expect(f.outbound).toHaveBeenCalledTimes(2);
    expect(f.outbound.mock.calls[1]?.[0].where.runId.in).toEqual([leaf.id]);
  });

  it.each([6, 7])(
    "enforces the existing native message depth boundary at %i hops",
    async (hops) => {
      const f = fixture();
      const chain = Array.from({ length: hops + 1 }, (_, index) =>
        historyRun(`run-${index}`, `bot-${index}`, "group"),
      );
      f.runs.mockResolvedValueOnce([chain[0]]);
      for (let index = 1; index < chain.length; index += 1) {
        const parent = chain[index - 1]!;
        const child = chain[index]!;
        const message = {
          id: `handoff-${index}`,
          threadId: parent.threadId,
          runId: parent.id,
          botId: parent.botId,
          role: "bot",
          externalTranscriptFor: null,
          blocks: [
            {
              kind: "handoff",
              fromBotId: parent.botId,
              toBotId: child.botId,
              text: "Check",
              hop: index,
            },
          ],
        };
        child.trigger = "follow_up";
        child.sourceMessageId = message.id;
        child.sourceMessage = message;
        f.outbound.mockResolvedValueOnce([message]);
        f.runs.mockResolvedValueOnce([child]);
      }
      if (hops === 7) {
        await expect(listRoutineRuns(f.prisma, actor, "routine-1")).rejects.toMatchObject({
          code: "PAYLOAD_TOO_LARGE",
        });
      } else {
        const history = await listRoutineRuns(f.prisma, actor, "routine-1");
        expect(history.runs[0]?.delegations).toHaveLength(hops);
      }
    },
  );

  it("does not follow or render a repeated cycle", async () => {
    const f = fixture();
    const root = historyRun("root", "main", "group");
    const child = historyRun("child", "helper", "group");
    const toChild = {
      id: "to-child",
      threadId: root.threadId,
      runId: root.id,
      botId: root.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [{ kind: "handoff", fromBotId: root.botId, toBotId: child.botId, text: "Check" }],
    };
    const toRoot = {
      id: "to-root",
      threadId: child.threadId,
      runId: child.id,
      botId: child.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [{ kind: "handoff", fromBotId: child.botId, toBotId: root.botId, text: "Check" }],
    };
    Object.assign(child, {
      trigger: "follow_up",
      sourceMessageId: toChild.id,
      sourceMessage: toChild,
    });
    Object.assign(root, {
      trigger: "follow_up",
      sourceMessageId: toRoot.id,
      sourceMessage: toRoot,
    });
    f.runs
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([child, child])
      .mockResolvedValueOnce([root]);
    f.outbound.mockResolvedValueOnce([toChild]).mockResolvedValueOnce([toRoot]);
    const history = await listRoutineRuns(f.prisma, actor, "routine-1");
    expect(history.runs[0]?.delegations.map((run) => run.id)).toEqual([child.id]);
    expect(f.outbound).toHaveBeenCalledTimes(2);
  });

  it("limits total graph runs even when each individual query is within its bound", async () => {
    const f = fixture();
    const root = historyRun("root", "main", "group");
    const source = {
      id: "handoff",
      threadId: root.threadId,
      runId: root.id,
      botId: root.botId,
      role: "bot",
      externalTranscriptFor: null,
      blocks: [{ kind: "handoff", fromBotId: root.botId, toBotId: "helper", text: "Check" }],
    };
    f.runs.mockResolvedValueOnce([root]).mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, index) => ({
        ...historyRun(`child-${index}`, "helper", "group"),
        trigger: "follow_up",
        sourceMessageId: source.id,
        sourceMessage: source,
      })),
    );
    f.outbound.mockResolvedValueOnce([source]);
    await expect(listRoutineRuns(f.prisma, actor, "routine-1")).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(f.messages).not.toHaveBeenCalled();
  });

  it("rejects an overflowing graph query instead of returning a truncated chain", async () => {
    const f = fixture();
    f.runs.mockResolvedValueOnce([historyRun("root")]);
    f.outbound.mockResolvedValueOnce(Array.from({ length: 201 }, () => ({})));
    await expect(listRoutineRuns(f.prisma, actor, "routine-1")).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(f.outbound.mock.calls[0]?.[0].take).toBe(201);
    expect(f.messages).not.toHaveBeenCalled();
  });

  it("does not confuse a database failure with an empty history", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockRejectedValue(new Error("database unavailable"));
    await expect(listRoutineRuns(prisma, actor, "routine-1")).rejects.toThrow(
      "database unavailable",
    );
    expect(messages).not.toHaveBeenCalled();
  });
  it("skips the message query when the routine has never run", async () => {
    const { prisma, messages } = fixture();
    await expect(listRoutineRuns(prisma, actor, "routine-1")).resolves.toEqual({
      runs: [],
      nextCursor: null,
    });
    expect(messages).not.toHaveBeenCalled();
  });
  it("pages all history using stable timestamp/id boundaries without including the lookahead row", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({
        ...historyRun(`run-${String(30 - i).padStart(2, "0")}`),
        status: "completed",
        createdAt: at,
        startedAt: at,
        completedAt: at,
      })),
    );
    const first = await listRoutineRuns(prisma, actor, "routine-1");
    expect(first.runs).toHaveLength(20);
    expect(first.nextCursor).toEqual({ id: "run-11", createdAt: at.toISOString() });
    runs.mockResolvedValue([]);
    const next = await listRoutineRuns(prisma, actor, "routine-1", first.nextCursor!);
    expect(next).toEqual({ runs: [], nextCursor: null });
    expect(runs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          routineId: "routine-1",
          botId: "bot-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
          OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: "run-11" } }],
        },
      }),
    );
  });
  it("keeps the group destination of a routine execution", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockResolvedValue([
      {
        ...historyRun("group-run", "bot-1", "group-1"),
        status: "completed",
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    messages.mockResolvedValue([
      { id: "group-reply", runId: "group-run", threadId: "group-thread" },
    ]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history).runs[0]).toMatchObject({
      groupId: "group-1",
      messageId: "group-reply",
    });
  });
});

function testRunFixture(threadId: string | null, destinationExists = true) {
  const runs: Array<{ id: string; spaceId: string; threadId: string; clientNonce?: string }> = [];
  const tasks: Array<{ id: string; threadId: string }> = [];
  const groupId = threadId && threadId !== "bot-thread" ? "group-1" : null;
  const routine = { id: "routine-1", botId: "bot-1", threadId, prompt: "Review the role" };
  const prisma = {
    routine: {
      findFirst: vi.fn(async () => routine),
      findUnique: vi.fn(async () => ({ modelProvider: null, modelId: null, thinkingLevel: null })),
    },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", thread: { id: "bot-thread" } })) },
    thread: {
      findFirst: vi.fn(async () => (destinationExists ? { id: threadId, groupId } : null)),
    },
    chatGroup: { findFirst: vi.fn(async () => ({ id: groupId })) },
    $queryRaw: vi.fn(async () => [{ id: groupId }]),
    agentSkill: { findMany: vi.fn(async () => []) },
    task: {
      create: vi.fn(async ({ data }: { data: { threadId: string } }) => {
        const task = { id: `task-${tasks.length + 1}`, ...data };
        tasks.push(task);
        return task;
      }),
    },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { threadId: string; clientNonce: string } }) =>
        runs.find(
          (run) => run.threadId === where.threadId && run.clientNonce === where.clientNonce,
        ),
      ),
      create: vi.fn(
        async ({ data }: { data: { spaceId: string; threadId: string; clientNonce?: string } }) => {
          if (
            data.clientNonce &&
            runs.some((run) => run.spaceId === data.spaceId && run.clientNonce === data.clientNonce)
          )
            throw Object.assign(new Error("Run nonce already exists"), { code: "P2002" });
          const run = { ...data, id: `run-${runs.length + 1}` };
          runs.push(run);
          return run;
        },
      ),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
    const runCount = runs.length;
    const taskCount = tasks.length;
    try {
      return await fn(prisma);
    } catch (error) {
      runs.splice(runCount);
      tasks.splice(taskCount);
      throw error;
    }
  });
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const client = createRouterClient(createRouter({ prisma, jobs } as unknown as RouterDeps), {
    context: { actor },
  });
  return { client, prisma, jobs, runs, tasks };
}

describe("routine test run destination", () => {
  it.each([null, "bot-thread", "group-thread"])(
    "preserves the saved destination %s",
    async (saved) => {
      const { client, prisma } = testRunFixture(saved);
      await client.routines.testRun({ routineId: "routine-1" });
      const threadId = saved ?? "bot-thread";
      expect(prisma.task.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ threadId }) }),
      );
      expect(prisma.run.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ threadId, botId: "bot-1" }) }),
      );
      if (saved) {
        expect(prisma.thread.findFirst).toHaveBeenCalledWith({
          where: {
            id: saved,
            spaceId: actor.spaceId,
            OR: [
              { botId: "bot-1" },
              { group: { archivedAt: null, members: { some: { botId: "bot-1" } } } },
            ],
          },
          select: { id: true, groupId: true },
        });
      } else {
        expect(prisma.thread.findFirst).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses a missing, foreign, archived or no-longer-member destination before writing", async () => {
    const { client, prisma, jobs } = testRunFixture("unavailable-group-thread", false);
    await expect(client.routines.testRun({ routineId: "routine-1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(prisma.run.create).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each(["archive", "membership removal"])("rechecks the Crew after concurrent %s", async () => {
    const { client, prisma, jobs } = testRunFixture("group-thread");
    prisma.chatGroup.findFirst.mockResolvedValue(null as never);
    await expect(client.routines.testRun({ routineId: "routine-1" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.chatGroup.findFirst).toHaveBeenCalledWith({
      where: {
        id: "group-1",
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        thread: { id: "group-thread" },
        members: { some: { botId: "bot-1", bot: { archivedAt: null } } },
      },
      select: { id: true },
    });
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.chatGroup.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(prisma.run.create).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("replays the same group nonce without creating another task or run", async () => {
    const { client, prisma } = testRunFixture("group-thread");
    const first = await client.routines.testRun({ routineId: "routine-1", clientNonce: "same" });
    const replay = await client.routines.testRun({ routineId: "routine-1", clientNonce: "same" });
    expect(replay).toEqual(first);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    expect(prisma.run.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a different-thread nonce collision and rolls back the queued task", async () => {
    const { client, jobs, runs, tasks } = testRunFixture("group-thread");
    const existing = {
      id: "other-run",
      spaceId: actor.spaceId,
      threadId: "bot-thread",
      clientNonce: "routine-test:same",
    };
    runs.push(existing);
    await expect(
      client.routines.testRun({ routineId: "routine-1", clientNonce: "same" }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(runs).toEqual([existing]);
    expect(tasks).toEqual([]);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
