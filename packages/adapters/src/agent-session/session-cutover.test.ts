import type * as DbModule from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { cutoverToSessions, UPGRADED_RUN_ERROR } from "./session-cutover.js";

// The session and input storage have their own tests in @rakazo/db; here each write is recorded.
const store = vi.hoisted(() => ({
  inputs: [] as Array<{ sessionId: string; kind: string; trigger: string; messageId?: string }>,
  events: [] as Array<{ type: string; runId?: string }>,
}));
vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    ensureConversationSession: vi.fn(
      async (_tx: unknown, key: { threadId: string; botId: string }) => ({
        id: `${key.threadId}:${key.botId}`,
        created: false,
      }),
    ),
    submitSessionInput: vi.fn(async (_tx: unknown, input: (typeof store.inputs)[number]) => {
      store.inputs.push(input);
      return { id: `input-${store.inputs.length}`, seq: store.inputs.length };
    }),
    appendEventInTransaction: vi.fn(
      async (_tx: unknown, event: { type: string; runId?: string }) => {
        store.events.push(event);
        return { seq: store.events.length };
      },
    ),
  };
});

function fakeDatabase() {
  const runs = [
    {
      id: "run-live",
      taskId: "task-live",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      botId: "bot-1",
      status: "running",
      error: null as string | null,
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      modelPinned: false,
      createdAt: new Date(1),
      task: { prompt: "Find ten engineers" },
      sourceMessage: { id: "message-1", seq: 1 },
    },
    {
      id: "run-routine",
      taskId: "task-routine",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      botId: "bot-1",
      status: "queued",
      error: null as string | null,
      trigger: "routine",
      routineId: "routine-1",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      modelPinned: false,
      createdAt: new Date(2),
      task: { prompt: "Check the inbox" },
      sourceMessage: null,
    },
  ];
  let steering = [
    {
      id: "steer-1",
      originTrigger: null,
      message: {
        id: "message-2",
        seq: 2,
        role: "user",
        blocks: [{ kind: "text", text: "Only Berlin" }],
      },
    },
  ];
  const live = (where: { status: { in: string[] }; threadId?: string; botId?: string }) =>
    runs.filter(
      (run) =>
        where.status.in.includes(run.status) &&
        (where.threadId === undefined || run.threadId === where.threadId) &&
        (where.botId === undefined || run.botId === where.botId),
    );
  const run = {
    findMany: vi.fn(async ({ where }: { where: Parameters<typeof live>[0] }) => live(where)),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        for (const row of runs.filter((row) => where.id.in.includes(row.id)))
          Object.assign(row, data);
        return { count: where.id.in.length };
      },
    ),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run,
    attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
    task: { updateMany: vi.fn(async () => ({ count: 0 })) },
    // No reply followed the live run's message.
    message: { findFirst: vi.fn(async () => null) },
    steeringMessage: {
      findMany: vi.fn(async () => steering),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        steering = steering.filter((row) => !where.id.in.includes(row.id));
        return { count: where.id.in.length };
      }),
    },
    sessionInput: {
      findMany: vi.fn(async () =>
        store.inputs
          .filter((input) => input.messageId)
          .map((input) => ({ messageId: input.messageId })),
      ),
    },
  };
  const prisma = {
    run,
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, runs };
}

describe("session cutover", () => {
  it("cutover turns live runs into inputs once", async () => {
    const { prisma, runs } = fakeDatabase();
    const events = {
      notify: vi.fn(async () => undefined),
      wakeSessions: vi.fn(async () => undefined),
    };

    expect(await cutoverToSessions({ prisma, events })).toEqual({ runs: 2, inputs: 3 });
    // What the runs had not answered, in message order; the never-started routine last.
    expect(store.inputs).toEqual([
      expect.objectContaining({
        sessionId: "thread-1:bot-1",
        messageId: "message-1",
        trigger: "user",
      }),
      expect.objectContaining({
        sessionId: "thread-1:bot-1",
        messageId: "message-2",
        kind: "message",
      }),
      expect.objectContaining({ sessionId: "thread-1:bot-1", trigger: "routine", kind: "message" }),
    ]);
    expect(runs.map((run) => [run.status, run.error])).toEqual([
      ["cancelled", UPGRADED_RUN_ERROR],
      ["cancelled", UPGRADED_RUN_ERROR],
    ]);
    expect(store.events.map((event) => event.type)).toEqual(["run.cancelled", "run.cancelled"]);
    expect(events.wakeSessions).toHaveBeenCalledExactlyOnceWith(["thread-1:bot-1"]);

    // Run again (a retried release job): no live run remains, so nothing is added.
    expect(await cutoverToSessions({ prisma, events })).toEqual({ runs: 0, inputs: 0 });
    expect(store.inputs).toHaveLength(3);
    expect(events.wakeSessions).toHaveBeenCalledOnce();
  });
});
