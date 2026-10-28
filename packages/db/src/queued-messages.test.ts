import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import type { QueuedMessageChange } from "./queued-messages.js";
import { QueuedMessageError, updateQueuedMessage } from "./queued-messages.js";
import { IsolationError } from "./scope.js";

type Row = {
  id: string;
  botId: string;
  userId: string;
  runId: string | null;
  run: { status: string; trigger: string } | null;
};

function harness(options: { queued?: boolean; exists?: boolean; rows?: Row[] } = {}) {
  const rows = options.rows ?? [
    {
      id: "steer-1",
      botId: "bot-1",
      userId: "user-1",
      runId: "run-1",
      run: { status: "running", trigger: "user" },
    },
  ];
  const queued = {
    id: "message-1",
    blocks: [{ kind: "text", text: "Only senior people" }],
    replyToMessageId: null,
    replyQuote: null,
    steeringMessages: rows,
  };
  const tx = {
    $queryRaw: vi.fn(),
    message: {
      // The first read applies the queued filter; the second only asks whether it exists.
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(options.queued === false ? null : queued)
        .mockResolvedValueOnce(options.exists === false ? null : { id: "message-1" }),
      update: vi.fn(),
      delete: vi.fn(),
    },
    thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 42, userId: "user-1" }) },
    event: { create: vi.fn(async ({ data }: { data: { seq: number } }) => data) },
    steeringMessage: {
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    task: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const update = (change: QueuedMessageChange) =>
    updateQueuedMessage(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      userId: "user-1",
      messageId: "message-1",
      change,
    });
  return { tx, update };
}

describe("updateQueuedMessage", () => {
  it("rewrites a queued message under the thread lock and publishes the edit", async () => {
    const { tx, update } = harness();

    await expect(update({ action: "edit", text: "  Only staff engineers  " })).resolves.toEqual({
      eventSeq: 41,
      startedRunIds: [],
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // Only a message whose steering is all unclaimed and that no run started from qualifies.
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "message-1",
          threadId: "thread-1",
          role: "user",
          steeringMessages: expect.objectContaining({
            some: {},
            every: expect.objectContaining({ claimedAt: null }),
          }),
          sourceRuns: { none: {} },
        }),
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { blocks: [{ kind: "text", text: "Only staff engineers" }] },
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.updated",
        botId: "bot-1",
        payload: {
          messageId: "message-1",
          role: "user",
          blocks: [{ kind: "text", text: "Only staff engineers" }],
          queued: true,
        },
      }),
    });
  });

  it("removes a queued message so no run can claim it", async () => {
    const { tx, update } = harness();

    await expect(update({ action: "remove" })).resolves.toEqual({
      eventSeq: 41,
      startedRunIds: [],
    });

    expect(tx.message.delete).toHaveBeenCalledWith({ where: { id: "message-1" } });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.deleted",
        payload: { messageId: "message-1" },
      }),
    });
  });

  it("sends now by marking the live reply's steering as an interjection", async () => {
    const { tx, update } = harness();

    await expect(update({ action: "send_now" })).resolves.toEqual({
      eventSeq: null,
      startedRunIds: [],
    });

    expect(tx.steeringMessage.update).toHaveBeenCalledWith({
      where: { id: "steer-1" },
      data: { originTrigger: "interrupt" },
    });
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("sends now by starting the continuation for input left without a run", async () => {
    const { tx, update } = harness({
      rows: [{ id: "steer-1", botId: "bot-1", userId: "user-1", runId: null, run: null }],
    });
    tx.steeringMessage.findMany.mockResolvedValue([
      {
        id: "steer-1",
        userId: "user-1",
        originTrigger: null,
        message: { id: "message-1", blocks: [], seq: 3 },
      },
    ]);
    tx.task.create.mockResolvedValue({ id: "task-2" });
    tx.run.create.mockResolvedValue({ id: "run-2" });

    await expect(update({ action: "send_now" })).resolves.toEqual({
      eventSeq: null,
      startedRunIds: ["run-2"],
    });
    expect(tx.steeringMessage.update).not.toHaveBeenCalled();
  });

  it.each<QueuedMessageChange>([
    { action: "edit", text: "Too late" },
    { action: "remove" },
    { action: "send_now" },
  ])("is a conflict once the reply read the message ($action)", async (change) => {
    const { tx, update } = harness({ queued: false });

    const error = await update(change).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QueuedMessageError);
    expect((error as QueuedMessageError).code).toBe("applied");
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.message.delete).not.toHaveBeenCalled();
    expect(tx.steeringMessage.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("does not reveal a message outside this thread", async () => {
    const { update } = harness({ queued: false, exists: false });

    await expect(update({ action: "remove" })).rejects.toBeInstanceOf(IsolationError);
  });

  it("keeps a feedback selection intact instead of rewriting it", async () => {
    const { tx, update } = harness();
    tx.message.findFirst.mockReset().mockResolvedValueOnce({
      id: "message-1",
      blocks: [
        {
          kind: "text",
          text: "Not this one",
          recruitingFeedback: { candidateIds: ["c-1"] },
        },
      ],
      replyToMessageId: null,
      replyQuote: null,
      steeringMessages: [
        { id: "steer-1", botId: "bot-1", userId: "user-1", runId: "run-1", run: null },
      ],
    });

    await expect(update({ action: "edit", text: "Rewritten" })).rejects.toMatchObject({
      code: "not_editable",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});
