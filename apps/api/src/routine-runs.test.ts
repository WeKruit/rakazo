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
  const prisma = {
    routine: { findFirst: routine },
    run: { findMany: runs },
    $queryRaw: messages,
  } as unknown as PrismaClient;
  return { prisma, routine, runs, messages };
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
        id: `run-${i}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: i === 1 ? "group-1" : null },
        status,
        createdAt: at,
        startedAt: status === "queued" ? null : at,
        completedAt: status === "queued" ? null : new Date(at.getTime() + 82_000),
      })),
    );
    messages.mockResolvedValue([{ id: "reply-new", runId: "run-1", threadId: "thread-1" }]);
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
    ]);
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
        id: `run-${String(30 - i).padStart(2, "0")}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
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
        id: "group-run",
        botId: "bot-1",
        threadId: "group-thread",
        thread: { groupId: "group-1" },
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
