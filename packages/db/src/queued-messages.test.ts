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
  it("does not reveal a message outside this thread", async () => {
    const { update } = harness({ queued: false, exists: false });

    await expect(update({ action: "remove" })).rejects.toBeInstanceOf(IsolationError);
  });
});
