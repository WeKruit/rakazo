import { describe, expect, it, vi } from "vitest";
import { backgroundToolRun, backgroundToolSourceTrigger } from "./background-tool.js";
import type { PrismaClient } from "./client.js";

const input = {
  runId: "run",
  threadId: "thread",
  botId: "main",
  spaceId: "space",
  userId: "user",
  leaseOwner: "worker",
  leaseFence: 3,
  executionId: "slow-tool",
  toolName: "web_fetch",
  durationMs: 10_000,
};

function database(trigger = "user") {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ trigger, clientNonce: null })
        .mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
    },
    thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 4, userId: "user" }) },
    event: {
      findFirst: vi.fn().mockResolvedValue({ payload: { trigger } }),
      create: vi.fn(async ({ data }: { data: { seq: number } }) => data),
    },
    steeringMessage: { updateMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    tx,
    prisma: {
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient,
  };
}

describe("slow tool background promotion", () => {
  it("preserves the executing run and lease, moving only unread steers to the native continuation", async () => {
    const { tx, prisma } = database();
    expect(await backgroundToolRun(prisma, input)).toEqual({
      promoted: true,
      continuationRunId: null,
      eventSeq: 3,
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run", status: "running", leaseOwner: "worker", leaseFence: 3 },
      data: { trigger: "tool_background" },
    });
    const detached = tx.steeringMessage.updateMany.mock.calls[0]![0];
    expect(detached.where).toMatchObject({ runId: "run", claimedAt: null });
    expect(detached.where.OR).toEqual([{ originTrigger: null }, { originTrigger: "interrupt" }]);
    expect(detached.data).toEqual({ runId: null, originTrigger: null });
    expect(tx.run.findFirst.mock.calls[1]![0].where.trigger).toEqual({ not: "tool_background" });
    expect(tx.event.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      tx.run.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "run.started",
          runId: "run",
          payload: {
            trigger: "tool_background",
            sourceTrigger: "user",
            backgrounded: true,
            executionId: "slow-tool",
            toolName: "web_fetch",
            durationMs: 10_000,
          },
        }),
      }),
    );
  });

  it("never promotes existing automation or takes another lease's run", async () => {
    const { tx, prisma } = database("routine");
    expect(await backgroundToolRun(prisma, input)).toEqual({
      promoted: false,
      continuationRunId: null,
      eventSeq: null,
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
    const {
      runId,
      executionId: _executionId,
      toolName: _toolName,
      durationMs: _durationMs,
      ...scope
    } = input;
    expect(tx.run.findFirst.mock.calls[0]![0].where).toMatchObject({ id: runId, ...scope });
  });

  it("does not detach messages after Stop wins the update race", async () => {
    const { tx, prisma } = database();
    tx.run.updateMany.mockResolvedValue({ count: 0 });
    expect(await backgroundToolRun(prisma, input)).toEqual({
      promoted: false,
      continuationRunId: null,
      eventSeq: null,
    });
    expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
  });

  it("never promotes a run without its exact original source event", async () => {
    const { tx, prisma } = database();
    tx.event.findFirst.mockResolvedValue(null as never);
    await expect(backgroundToolRun(prisma, input)).rejects.toThrow(
      "original turn could not be restored",
    );
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it.each(["user", "follow_up", "messaging"])(
    "restores %s identity after promotion from the first durable started event",
    async (trigger) => {
      const findFirst = vi.fn().mockResolvedValue({ payload: { trigger } });
      const prisma = { event: { findFirst } } as unknown as Pick<PrismaClient, "event">;
      expect(
        await backgroundToolSourceTrigger(prisma, {
          id: "run",
          spaceId: "space",
          threadId: "thread",
          botId: "main",
          trigger: "tool_background",
        }),
      ).toBe(trigger);
      expect(findFirst).toHaveBeenCalledExactlyOnceWith({
        where: {
          runId: "run",
          spaceId: "space",
          threadId: "thread",
          botId: "main",
          type: "run.started",
        },
        orderBy: { seq: "asc" },
        select: { payload: true },
      });
    },
  );

  it.each([undefined, "tool_background", "routine", "not-a-trigger"])(
    "never guesses a missing or invalid original source (%s)",
    async (trigger) => {
      const prisma = {
        event: { findFirst: vi.fn().mockResolvedValue(trigger ? { payload: { trigger } } : null) },
      } as unknown as Pick<PrismaClient, "event">;
      await expect(
        backgroundToolSourceTrigger(prisma, {
          id: "run",
          spaceId: "space",
          threadId: "thread",
          botId: "main",
          trigger: "tool_background",
        }),
      ).rejects.toThrow("original turn could not be restored");
    },
  );
});
