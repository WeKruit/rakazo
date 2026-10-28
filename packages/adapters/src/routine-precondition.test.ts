import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import {
  parseRoutinePrecondition,
  routinePreconditionMet,
  skipRoutineWithoutNewActivity,
} from "./routine-precondition.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  createThreadMessage: vi.fn(async () => ({ id: "note", seq: 7 })),
}));

const scheduledAt = new Date(Date.now() - 5_000);
const lastRunAt = new Date(Date.now() - 3_600_000);

function fakePrisma(input: {
  prompt: string;
  counts?: { messages?: number; inbound?: number; recruiting?: number };
  lastRunAt?: Date | null;
  claimCount?: number;
}) {
  const counts = { messages: 0, inbound: 0, recruiting: 0, ...input.counts };
  const updateMany = vi.fn(async () => ({ count: input.claimCount ?? 1 }));
  const prisma = {
    routine: {
      findUnique: vi.fn(async () => ({
        id: "routine-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        threadId: null,
        prompt: input.prompt,
        crons: ["0 * * * *"],
        timezone: "UTC",
        active: true,
        nextRunAt: scheduledAt,
        lastRunAt: input.lastRunAt === undefined ? lastRunAt : input.lastRunAt,
      })),
      updateMany,
    },
    bot: {
      findUnique: vi.fn(async () => ({ archivedAt: null, thread: { id: "thread-1" } })),
    },
    message: { count: vi.fn(async () => counts.messages) },
    externalMessage: { count: vi.fn(async () => counts.inbound) },
    recruitingRoleRevision: { count: vi.fn(async () => counts.recruiting) },
  };
  return { prisma: prisma as unknown as PrismaClient, updateMany, raw: prisma };
}

function fakeDeps(prisma: PrismaClient) {
  const wakeRoutine = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const append = vi.fn(async () => undefined);
  const deps = {
    executor: { wakeRoutine },
    prisma,
    jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn() },
    events: { append },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0];
  return { deps, wakeRoutine, enqueue, append };
}

describe("parseRoutinePrecondition", () => {
  it("reads the directive line from the prompt and ignores everything else", () => {
    expect(parseRoutinePrecondition("Check inbox.\nprecondition: new_activity\nReply.")).toBe(
      "new_activity",
    );
    expect(parseRoutinePrecondition("  Precondition: NEW_ACTIVITY  ")).toBe("new_activity");
    expect(parseRoutinePrecondition("Check inbox every hour.")).toBeUndefined();
    expect(parseRoutinePrecondition("precondition: something_else")).toBeUndefined();
    expect(
      parseRoutinePrecondition("the precondition: new_activity is not a line"),
    ).toBeUndefined();
  });
});

describe("routinePreconditionMet", () => {
  const routine = {
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: null,
    lastRunAt,
  };

  it("is met on the first trigger and whenever any source changed since the last run", async () => {
    const never = fakePrisma({ prompt: "", lastRunAt: null });
    expect(
      await routinePreconditionMet(
        never.prisma,
        { ...routine, lastRunAt: null },
        "new_activity",
        "t",
      ),
    ).toBe(true);
    for (const counts of [{ messages: 1 }, { inbound: 2 }, { recruiting: 1 }]) {
      const { prisma } = fakePrisma({ prompt: "", counts });
      expect(await routinePreconditionMet(prisma, routine, "new_activity", "thread-1")).toBe(true);
    }
  });

  it("is unmet when nothing changed, scoping each probe to the routine's owner", async () => {
    const { prisma, raw } = fakePrisma({ prompt: "" });
    expect(await routinePreconditionMet(prisma, routine, "new_activity", "thread-1")).toBe(false);
    expect(raw.message.count).toHaveBeenCalledWith({
      where: { threadId: "thread-1", role: "user", createdAt: { gt: lastRunAt } },
    });
    expect(raw.externalMessage.count).toHaveBeenCalledWith({
      where: {
        senderIsBot: false,
        createdAt: { gt: lastRunAt },
        externalConversation: { spaceId: "space-1", userId: "user-1", botId: "bot-1" },
      },
    });
    expect(raw.recruitingRoleRevision.count).toHaveBeenCalledWith({
      where: { createdAt: { gt: lastRunAt }, role: { spaceId: "space-1", userId: "user-1" } },
    });
  });
});

describe("memory tidy preconditions", () => {
  const day = 24 * 60 * 60 * 1000;
  const routine = {
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: null,
    lastRunAt: new Date(Date.now() - day),
  };
  const withLatest = (updatedAt: Date | null) => {
    const findFirst = vi.fn(async () => (updatedAt ? { updatedAt } : null));
    return { prisma: { memoryDocument: { findFirst } } as unknown as PrismaClient, findFirst };
  };

  it("reads the memory directives", () => {
    expect(parseRoutinePrecondition("/Tidy memory\nprecondition: memory")).toBe("memory");
    expect(parseRoutinePrecondition("/Tidy memory\nprecondition: bot_memory")).toBe("bot_memory");
  });

  it("runs only when saved memory changed since the last tidy or a week has passed", async () => {
    const changed = withLatest(new Date());
    expect(await routinePreconditionMet(changed.prisma, routine, "memory", undefined)).toBe(true);
    const unchanged = withLatest(new Date(Date.now() - 2 * day));
    expect(await routinePreconditionMet(unchanged.prisma, routine, "memory", undefined)).toBe(
      false,
    );
    const weekOld = { ...routine, lastRunAt: new Date(Date.now() - 7 * day) };
    expect(await routinePreconditionMet(unchanged.prisma, weekOld, "memory", undefined)).toBe(true);
    const first = { ...routine, lastRunAt: null };
    expect(await routinePreconditionMet(unchanged.prisma, first, "bot_memory", undefined)).toBe(
      true,
    );
    const empty = withLatest(null);
    expect(await routinePreconditionMet(empty.prisma, first, "memory", undefined)).toBe(false);
  });

  it("counts shared memory only for the routine that tidies it, within the owner's scope", async () => {
    const { prisma, findFirst } = withLatest(null);
    await routinePreconditionMet(prisma, routine, "bot_memory", undefined);
    await routinePreconditionMet(prisma, routine, "memory", undefined);
    const where = (call: number) =>
      (findFirst.mock.calls[call] as unknown as [{ where: unknown }])[0].where;
    expect(where(0)).toEqual({
      spaceId: "space-1",
      userId: "user-1",
      content: { not: "" },
      OR: [{ scope: "bot", botId: "bot-1" }],
    });
    expect(where(1)).toEqual({
      spaceId: "space-1",
      userId: "user-1",
      content: { not: "" },
      OR: [{ scope: "bot", botId: "bot-1" }, { scope: "user" }],
    });
  });
});

describe("routine.wakeup precondition", () => {
  const payload = { routineId: "routine-1", scheduledFor: scheduledAt.toISOString() };

  it("skips the run, advances the schedule and records the skipped trigger when nothing changed", async () => {
    const { prisma, updateMany } = fakePrisma({ prompt: "precondition: new_activity\nTriage." });
    const { deps, wakeRoutine, enqueue, append } = fakeDeps(prisma);
    await createBackgroundJobHandlers(deps)["routine.wakeup"](payload);
    expect(wakeRoutine).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "routine-1", active: true, nextRunAt: scheduledAt },
      data: { nextRunAt: expect.any(Date) },
    });
    const nextRunAt = vi.mocked(updateMany).mock.calls[0]![0 as never]! as never as {
      data: { nextRunAt: Date };
    };
    expect(nextRunAt.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "routine.wakeup",
        payload: expect.objectContaining({ routineId: "routine-1" }),
      }),
    );
    expect(append).toHaveBeenCalledExactlyOnceWith({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "routine.fired",
      payload: {
        routineId: "routine-1",
        scheduledFor: payload.scheduledFor,
        skipped: true,
        reason: "no_new_activity",
        precondition: "new_activity",
      },
    });
  });

  it("opens the run as before when something changed", async () => {
    const { prisma, updateMany } = fakePrisma({
      prompt: "precondition: new_activity\nTriage.",
      counts: { messages: 1 },
    });
    const { deps, wakeRoutine, enqueue } = fakeDeps(prisma);
    await createBackgroundJobHandlers(deps)["routine.wakeup"](payload);
    expect(wakeRoutine).toHaveBeenCalledExactlyOnceWith("routine-1", payload.scheduledFor);
    expect(updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never evaluates anything for a routine without a precondition", async () => {
    const { prisma, raw } = fakePrisma({ prompt: "Triage." });
    const { deps, wakeRoutine } = fakeDeps(prisma);
    await createBackgroundJobHandlers(deps)["routine.wakeup"](payload);
    expect(wakeRoutine).toHaveBeenCalledOnce();
    expect(raw.message.count).not.toHaveBeenCalled();
  });

  it("does not double-handle an occurrence another worker already claimed", async () => {
    const { prisma } = fakePrisma({ prompt: "precondition: new_activity", claimCount: 0 });
    const { deps, enqueue, append } = fakeDeps(prisma);
    expect(await skipRoutineWithoutNewActivity(deps as never, payload)).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe("run.continue routine failure pause", () => {
  beforeEach(() => vi.mocked(createThreadMessage).mockClear());

  function failurePrisma(statuses: string[], options: { active?: boolean } = {}) {
    const updateMany = vi.fn(async () => ({ count: options.active === false ? 0 : 1 }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          routineId: "routine-1",
          status: statuses[0],
          threadId: "thread-1",
        })),
        findMany: vi.fn(async () => statuses.map((status) => ({ status }))),
      },
      routine: {
        findUnique: vi.fn(async () => ({ name: "Inbox triage" })),
        updateMany,
      },
    };
    return { prisma: prisma as unknown as PrismaClient, updateMany, raw: prisma };
  }

  function continueDeps(prisma: PrismaClient) {
    const continueRun = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const deps = {
      executor: { continueRun },
      prisma,
      jobs: { enqueue: vi.fn(async () => undefined), cancel, close: vi.fn() },
      events: { notify },
      workerId: "w",
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0];
    return { deps, continueRun, cancel, notify };
  }

  it("pauses the routine and posts one notice after five consecutive failed runs", async () => {
    const { prisma, updateMany, raw } = failurePrisma([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    const { deps, continueRun, cancel, notify } = continueDeps(prisma);
    await createBackgroundJobHandlers(deps)["run.continue"]({ runId: "run-5" });
    expect(continueRun).toHaveBeenCalledExactlyOnceWith("run-5", "w");
    expect(raw.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { routineId: "routine-1" }, take: 5 }),
    );
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "routine-1", active: true },
      data: { active: false, nextRunAt: null },
    });
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
    expect(createThreadMessage).toHaveBeenCalledExactlyOnceWith(prisma, {
      threadId: "thread-1",
      role: "system",
      blocks: [
        {
          kind: "meta",
          text: 'Routine "Inbox triage" was paused after 5 consecutive failed runs. Fix the cause, then resume it.',
        },
      ],
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 7);
  });

  it("does not post the notice again for a routine that is already paused", async () => {
    const { prisma } = failurePrisma(["failed", "failed", "failed", "failed", "failed"], {
      active: false,
    });
    const { deps, notify } = continueDeps(prisma);
    await createBackgroundJobHandlers(deps)["run.continue"]({ runId: "run-6" });
    expect(createThreadMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps running when a success broke the streak or fewer than five runs failed", async () => {
    for (const statuses of [
      ["failed", "failed", "completed", "failed", "failed"],
      ["failed", "failed", "failed", "failed"],
      ["completed", "failed", "failed", "failed", "failed"],
    ]) {
      const { prisma, updateMany } = failurePrisma(statuses);
      const { deps } = continueDeps(prisma);
      await createBackgroundJobHandlers(deps)["run.continue"]({ runId: "run-x" });
      expect(updateMany).not.toHaveBeenCalled();
    }
    expect(createThreadMessage).not.toHaveBeenCalled();
  });

  it("ignores runs that are not routine runs", async () => {
    const { prisma, raw } = failurePrisma(["failed"]);
    vi.mocked(raw.run.findUnique).mockResolvedValueOnce({
      routineId: null,
      status: "failed",
      threadId: "thread-1",
    } as never);
    const { deps } = continueDeps(prisma);
    await createBackgroundJobHandlers(deps)["run.continue"]({ runId: "run-user" });
    expect(raw.run.findMany).not.toHaveBeenCalled();
  });
});
