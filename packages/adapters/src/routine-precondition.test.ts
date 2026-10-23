import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import {
  parseRoutinePrecondition,
  routinePreconditionMet,
  skipRoutineWithoutNewActivity,
} from "./routine-precondition.js";

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
