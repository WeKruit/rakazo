import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { callClientNonce } from "@rakazo/core";
import type * as MessageQuoteModule from "@rakazo/core/message-quote";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import {
  cancelSupersededQueuedRuns,
  reactToThreadMessage,
  sendThreadMessage,
  stopThreadRuns,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";

// Passthrough mock: every hint derives for real except the sentinel that
// exercises the "derivation must never cost the send" path.
vi.mock("@rakazo/core/message-quote", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageQuoteModule>();
  return {
    ...actual,
    deriveMessageQuote: (
      blocks: MessageBlock[],
      hint: string,
      format: "markdown" | "plain-text",
    ) => {
      if (hint === "explode derivation") throw new Error("derivation blew up");
      return actual.deriveMessageQuote(blocks, hint, format);
    },
  };
});

describe("threadHead", () => {
  it("returns the durable cursor without loading a snapshot", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const prisma = { event: { findFirst } } as unknown as PrismaClient;
    const target = { threadId: "thread-1" } as ThreadTarget;

    await expect(threadHead(prisma, target)).resolves.toEqual({
      threadId: "thread-1",
      cursor: 12,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
  });
});

describe("queued run supersession", () => {
  it("only cancels queued runs started by user messages or reactions", async () => {
    const tx = {
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-old", taskId: "task-old" }]),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    await cancelSupersededQueuedRuns(tx as never, {
      threadId: "thread-1",
      botIds: ["bot-1"],
      keepRunIds: ["run-new"],
    });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["run-old"] } } }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-old"] } },
      data: { status: "cancelled" },
    });
  });
});

describe("reaction messages", () => {
  it("appends repeated reactions as quiet replies and deduplicates retries", async () => {
    const messages = new Map<string, { id: string }>();
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: "parent" }),
        findUnique: vi.fn(
          async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
            messages.get(where.threadId_clientNonce.clientNonce) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: { clientNonce: string } }) => {
          const message = { id: `reaction-${messages.size}`, ...data };
          messages.set(data.clientNonce, message);
          return message;
        }),
      },
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `event-${eventSeq}`,
          createdAt: new Date(),
          ...data,
        })),
      },
      task: { create: vi.fn() },
      run: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;
    for (const [clientNonce, reaction] of [
      ["first", "❤️"],
      ["second", "👍"],
      ["third", "❤️"],
      ["third", "❤️"],
    ] as const) {
      await reactToThreadMessage({ prisma }, actor, target, {
        messageId: "parent",
        reaction,
        clientNonce,
      });
    }
    expect(tx.message.create).toHaveBeenCalledTimes(3);
    expect(tx.event.create).toHaveBeenCalledTimes(3);
    expect(tx.message.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        role: "user",
        blocks: [{ kind: "text", text: "❤️" }],
        replyToMessageId: "parent",
        clientNonce: "third",
      }),
    });
    expect(tx.event.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: {
          messageId: "reaction-2",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "parent",
        },
      }),
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true },
    });
    tx.message.findFirst.mockResolvedValueOnce(null);
    await expect(
      reactToThreadMessage({ prisma }, actor, target, {
        messageId: "elsewhere",
        reaction: "❤️",
        clientNonce: "fourth",
      }),
    ).rejects.toThrow();
    expect(tx.message.create).toHaveBeenCalledTimes(3);
  });
});

describe("threadSnapshot", () => {
  it.each(["group", "bot"] as const)(
    "restores the original waiting %s cards beyond the latest page without moving its cursor",
    async (kind) => {
      const run = (id: string, botId: string) => ({
        id,
        botId,
        threadId: "thread-1",
        spaceId: "space-1",
        userId: "user-1",
        taskId: `task-${id}`,
        status: "waiting_input",
        trigger: "user",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date(0),
      });
      const runs = [run("main", "bot-1"), ...(kind === "group" ? [run("sourcer", "bot-2")] : [])];
      const row = (id: string, seq: number, runId: string | null, blocks: MessageBlock[]) => ({
        id,
        seq,
        threadId: "thread-1",
        runId,
        role: runId ? "bot" : "user",
        botId: runs.find((item) => item.id === runId)?.botId ?? null,
        blocks,
        replyToMessageId: null,
        replyQuote: null,
        createdAt: new Date(seq * 1000),
      });
      const cards = runs.map((item, index) =>
        row(`ask-${item.id}`, index + 3, item.id, [
          {
            kind: "ask",
            text: `Original ${item.id} question`,
            status: "pending",
            ...(item.id === "sourcer"
              ? {
                  approvalEffectId: "original-effect",
                  actions: [
                    { id: "allow", label: "Allow once" },
                    { id: "deny", label: "Deny" },
                  ],
                }
              : {}),
          },
        ]),
      );
      const rows = [
        row("older-main-card", 1, "main", [{ kind: "ask", text: "Older", status: "pending" }]),
        ...cards,
        ...Array.from({ length: 101 }, (_, index) =>
          row(`later-${index}`, index + 100, null, [{ kind: "text", text: "Later reply" }]),
        ),
      ];
      const findManyMessages = vi.fn(
        async ({
          where,
          take,
        }: {
          where: { threadId: string; runId?: string; role?: string };
          take: number;
        }) =>
          rows
            .filter(
              (item) =>
                item.threadId === where.threadId &&
                (!where.runId || item.runId === where.runId) &&
                (!where.role || item.role === where.role),
            )
            .sort((left, right) => right.seq - left.seq)
            .slice(0, take),
      );
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: { findMany: findManyMessages },
        event: {
          findFirst: vi.fn().mockResolvedValue({ seq: 300 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        run: { findFirst: botRunFindFirst(runs), findMany: groupRunFindMany({ active: runs }) },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const target =
        kind === "group"
          ? groupTarget()
          : ({
              kind: "bot",
              botId: "bot-1",
              threadId: "thread-1",
              bot: { computer: null },
            } as ThreadTarget);
      const snapshot = await threadSnapshot({ prisma }, target);

      // Only the newest 30 rows (seq 171..200) form the window; the cards are older.
      expect(snapshot.olderCursor).toBe(171);
      expect(snapshot.messagesCursor).toBe(171);
      expect(snapshot.hasOlder).toBe(true);
      expect(snapshot.cursor).toBe(300);
      expect(snapshot.messages).toHaveLength(30 + cards.length);
      expect(new Set(snapshot.messages.map((item) => item.id)).size).toBe(snapshot.messages.length);
      expect(snapshot.messages.slice(0, cards.length)).toEqual(
        cards.map((card) =>
          expect.objectContaining({
            id: card.id,
            seq: card.seq,
            runId: card.runId,
            botId: card.botId,
            blocks: card.blocks,
          }),
        ),
      );
      expect(snapshot.messages.some((item) => item.id === "older-main-card")).toBe(false);
      for (const item of runs)
        expect(findManyMessages).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              threadId: "thread-1",
              runId: item.id,
              botId: item.botId,
              role: "bot",
              thread: {
                id: "thread-1",
                userId: "user-1",
                spaceId: "space-1",
              },
            }),
          }),
        );
    },
  );

  it.each([
    { total: 45, length: 30, messagesCursor: 16, hasOlder: true },
    { total: 12, length: 12, messagesCursor: 1, hasOlder: false },
    { total: 0, length: 0, messagesCursor: null, hasOlder: false },
  ])(
    "returns the newest window of $total messages with cursor and hasOlder",
    async ({ total, length, messagesCursor, hasOlder }) => {
      const rows = Array.from({ length: total }, (_, index) => ({
        id: `m-${index + 1}`,
        seq: index + 1,
        threadId: "thread-1",
        runId: null,
        role: "user",
        botId: null,
        blocks: [{ kind: "text", text: "hi" }],
        replyToMessageId: null,
        replyQuote: null,
        createdAt: new Date((index + 1) * 1000),
      }));
      const findMany = vi.fn(async ({ take }: { take: number }) =>
        [...rows].sort((left, right) => right.seq - left.seq).slice(0, take),
      );
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: { findMany },
        event: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
        run: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      // Any read outside thread/messages/events/runs (routines, skills, workspace…) throws.
      const strictTx = new Proxy(tx, {
        get: (object, key) => {
          if (key in object || typeof key === "symbol" || key === "then")
            return object[key as keyof typeof object];
          throw new Error(`threads.get must not read ${String(key)}`);
        },
      });
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(strictTx)),
      } as unknown as PrismaClient;
      const snapshot = await threadSnapshot({ prisma }, {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { seq: "desc" }, take: 31 }),
      );
      expect(snapshot.messages.map((message) => message.seq)).toEqual(
        rows.slice(-length).map((row) => row.seq),
      );
      expect(snapshot.messagesCursor).toBe(messagesCursor);
      expect(snapshot.hasOlder).toBe(hasOlder);
      expect(snapshot.olderCursor).toBe(hasOlder ? messagesCursor : null);
      expect(tx.event.findMany).not.toHaveBeenCalled();
    },
  );

  it("starts the window, cursor and run reads concurrently", async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const gated = <T>(name: string, value: T) =>
      vi.fn(() => {
        started.push(name);
        return new Promise<T>((resolve) => gates.push(() => resolve(value)));
      });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: gated("messages", [] as unknown[]) },
      event: { findFirst: gated("cursor", { seq: 7 }), findMany: vi.fn() },
      run: { findFirst: gated("run", null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const pending = threadSnapshot({ prisma }, {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    // All four reads were issued before any of them resolved.
    expect([...started].sort()).toEqual(["cursor", "messages", "run", "run"]);
    for (const open of gates) open();
    await expect(pending).resolves.toMatchObject({ cursor: 7, messagesCursor: null });
  });

  it("reloads tool-only live messages for an active run", async () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn().mockResolvedValue([
      {
        id: "event-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 4,
        type: "agent.tool.called",
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: new Date("2026-08-23T00:00:00.000Z"),
      },
    ]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
        findMany: findManyEvents,
      },
      run: { findFirst: botRunFindFirst([run]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(findManyEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: {
            in: [
              "thread.progress",
              "thread.subagent",
              "agent.tool.called",
              "agent.tool.completed",
              "run.requeued",
            ],
          },
        }),
      }),
    );
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        botId: "bot-1",
        blocks: [
          {
            kind: "steps",
            steps: [{ label: "Slack find channels", count: 1 }],
          },
        ],
      }),
    ]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
      maxWait: 5_000,
    });
  });

  it("returns the latest failed run so the client can show its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "Provider is not configured: openrouter",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn();
    const findFirstRun = botRunFindFirst([run]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          trigger: { notIn: ["bot_message", "tickets"] },
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId: "bot-1",
          threadId: "thread-1",
          status: { in: ["waiting_input", "waiting_takeover"] },
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: "Provider is not configured: openrouter",
      }),
    );
    expect(findManyEvents).not.toHaveBeenCalled();
  });

  it("prefers a waiting peer ask over a concurrent user run", async () => {
    const waitingPeer = {
      id: "run-peer-waiting",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const olderUser = {
      id: "run-user",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-user",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: {
          $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
            callback({
              $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
              message: { findMany: vi.fn().mockResolvedValue([]) },
              event: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
              },
              run: { findFirst: botRunFindFirst([waitingPeer, olderUser]) },
            }),
          ),
        } as unknown as PrismaClient,
      },
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    );
  });

  it.each(["waiting_input", "running"])(
    "only exposes ticket runs waiting for input (%s)",
    async (status) => {
      const waitingTicket = {
        id: "run-ticket-waiting",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-ticket",
        status,
        trigger: "tickets",
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: new Date("2026-08-23T00:00:02.000Z"),
        completedAt: null,
        createdAt: new Date("2026-08-23T00:00:02.000Z"),
      };
      const snapshot = await threadSnapshot(
        {
          prisma: {
            $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
              callback({
                $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
                message: { findMany: vi.fn().mockResolvedValue([]) },
                event: {
                  findFirst: vi.fn().mockResolvedValue(null),
                  findMany: vi.fn().mockResolvedValue([]),
                },
                run: { findFirst: botRunFindFirst([waitingTicket]) },
              }),
            ),
          } as unknown as PrismaClient,
        },
        {
          kind: "bot",
          botId: "bot-1",
          threadId: "thread-1",
          bot: { computer: null },
        } as ThreadTarget,
      );

      if (status === "waiting_input") {
        expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-ticket-waiting", status }));
      } else {
        expect(snapshot.run).toBeNull();
      }
    },
  );

  it("drops a failed run once a newer run has finished", async () => {
    const failed = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "This operation was aborted",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:03.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const findFirstRun = botRunFindFirst([failed, completed]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { notIn: ["bot_message", "tickets"] },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(snapshot.run).toBeNull();
  });

  it("does not return a cancelled or completed run", async () => {
    const findManyEvents = vi.fn();
    const findFirstRun = botRunFindFirst([]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.run).toBeNull();
    expect(findManyEvents).not.toHaveBeenCalled();
  });
  it("returns a group's latest failed run so a refresh keeps its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "member exploded",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyRuns = groupRunFindMany({ terminals: [run] });
    const prisma = groupPrisma(findManyRuns);
    const snapshot = await threadSnapshot({ prisma }, groupTarget());

    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          trigger: { notIn: ["bot_message", "tickets"] },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          OR: [
            { trigger: { notIn: ["bot_message", "tickets"] } },
            { status: { in: ["waiting_input", "waiting_takeover"] } },
          ],
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
      maxWait: 5_000,
    });
  });

  it("omits peer bot_message runs from group activeRuns and displayed terminal run", async () => {
    const peerActive = {
      id: "run-peer-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-peer-fail",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const findManyRuns = groupRunFindMany({
      active: [peerActive],
      terminals: [peerFailed],
    });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.run).toBeNull();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { trigger: { notIn: ["bot_message", "tickets"] } },
            { status: { in: ["waiting_input", "waiting_takeover"] } },
          ],
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        }),
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { notIn: ["bot_message", "tickets"] },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
      }),
    );
  });

  it("includes waiting peer bot_message runs in group activeRuns", async () => {
    const peerWaiting = {
      id: "run-peer-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [peerWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    ]);
  });

  it("keeps a waiting peer ask as the primary run even when a newer busy run exists", async () => {
    // Real DB order is createdAt desc, so the newer busy run for bot-b comes
    // first here, ahead of the older waiting peer run for bot-a.
    const newerBusy = {
      id: "run-newer-busy",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-busy",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:10.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:10.000Z"),
    };
    const olderWaiting = {
      id: "run-older-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [newerBusy, olderWaiting] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-older-waiting" }));
    // activeRuns is unaffected by which one is chosen as primary.
    expect(snapshot.activeRuns.map((run) => run.id)).toEqual([
      "run-newer-busy",
      "run-older-waiting",
    ]);
  });

  it("does not revive an older group failure after a newer run completed", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-newer-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [completed, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("does not revive a failure when a newer cancelled run has null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const cancelled = {
      id: "run-newer-cancelled",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "cancelled",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [cancelled, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("prefers a timestamped terminal over an older failure with null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [failed, completed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("clamps a long persisted group failure error on refresh", async () => {
    const longError = "x".repeat(400);
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: longError,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [run] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: `${"x".repeat(300)}…`,
      }),
    );
  });

  it("keeps a concurrent member failure in run while another member is still active", async () => {
    const active = {
      id: "run-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ active: [active], terminals: [failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-active", status: "running" }),
    ]);
  });

  it("keeps a failure on refresh when another member starts after it", async () => {
    const lateActive = {
      id: "run-late",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:03.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: groupPrisma(groupRunFindMany({ active: [lateActive], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-late", status: "running" }),
    ]);
  });
});

function isTerminalRunQuery(where: { status?: { in?: string[] } } | undefined) {
  const statuses = where?.status?.in;
  return Array.isArray(statuses) && statuses.includes("failed") && statuses.includes("completed");
}

type TriggerFilter = { not?: string; notIn?: string[] };

function matchesTriggerFilter(trigger: string | undefined, filter: TriggerFilter | undefined) {
  if (!filter) return true;
  if (filter.not !== undefined && trigger === filter.not) return false;
  if (filter.notIn !== undefined && trigger !== undefined && filter.notIn.includes(trigger)) {
    return false;
  }
  return true;
}

function matchesPeerActiveFilter(
  row: { trigger?: string; status?: string },
  where:
    | {
        trigger?: TriggerFilter;
        OR?: Array<{ trigger?: TriggerFilter; status?: { in?: string[] } }>;
      }
    | undefined,
) {
  if (where?.trigger) return matchesTriggerFilter(row.trigger, where.trigger);
  if (!where?.OR) return true;
  return where.OR.some((clause) => {
    if (!matchesTriggerFilter(row.trigger, clause.trigger)) return false;
    if (clause.status?.in) return clause.status.in.includes(row.status ?? "");
    return true;
  });
}

function botRunFindFirst(
  rows: Array<{
    id: string;
    status: string;
    trigger?: string;
    createdAt?: Date;
  }>,
) {
  return vi.fn().mockImplementation(
    async (args: {
      where?: {
        status?: { in?: string[] };
        trigger?: TriggerFilter;
      };
      select?: { id?: boolean };
    }) => {
      const statuses = args.where?.status?.in;
      const matched = rows
        .filter((row) => !statuses || statuses.includes(row.status))
        .filter((row) => matchesTriggerFilter(row.trigger, args.where?.trigger))
        .sort((a, b) => {
          const byCreated = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
        });
      const row = matched[0] ?? null;
      if (!row) return null;
      return args.select?.id ? { id: row.id } : row;
    },
  );
}

function groupRunFindMany(input: { active?: unknown[]; terminals?: unknown[] }) {
  return vi.fn().mockImplementation(
    async (args: {
      where?: {
        status?: { in?: string[] };
        trigger?: { not?: string };
        OR?: Array<{ trigger?: { not?: string }; status?: { in?: string[] } }>;
      };
    }) => {
      const rows = isTerminalRunQuery(args.where) ? (input.terminals ?? []) : (input.active ?? []);
      return rows.filter((row) =>
        matchesPeerActiveFilter(row as { trigger?: string; status?: string }, args.where),
      );
    },
  );
}

function groupPrisma(findManyRuns: ReturnType<typeof groupRunFindMany>) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    message: { findMany: vi.fn().mockResolvedValue([]) },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    run: { findMany: findManyRuns },
  };
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
}

function groupTarget() {
  return {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    members: [],
    threadId: "thread-1",
  } as unknown as ThreadTarget;
}

describe("sendThreadMessage", () => {
  it.each(["bot", "group"] as const)(
    "preserves selected mail in %s initial messages and active steering while rejecting a changed role",
    async (kind) => {
      const reference = {
        threadId: "thread-1",
        roleId: "role-1",
        emailId: "email-1",
        sourceId: "mailbox-1",
        providerMessageId: "provider-message-1",
        savedRead: null,
        sourceName: "Mailbox",
        sender: null,
        subject: "A reply",
        date: null,
        snippet: true,
      };
      let seq = 0;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
        thread: {
          findFirst: vi.fn().mockResolvedValue({ id: "thread-1" }),
          update: vi.fn(async () => ({ nextMessageSeq: ++seq, nextEventSeq: seq })),
        },
        chatGroup: {
          findFirst: vi.fn().mockResolvedValue({
            id: "group-1",
            members: [
              { bot: { id: "bot-1", name: "Main", color: null } },
              { bot: { id: "bot-2", name: "Sourcer", color: null } },
            ],
          }),
          update: vi.fn(),
        },
        message: {
          create: vi.fn(async ({ data }) => ({ ...data, id: "message-1", seq: 1 })),
          update: vi.fn(),
        },
        task: { create: vi.fn(async ({ data }) => ({ ...data, id: "task-1" })) },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          create: vi.fn(async ({ data }) => ({ ...data, id: "run-1" })),
        },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn(async ({ data }) => ({ ...data, seq })) },
      };
      const deps = {
        prisma: {
          message: { findUnique: vi.fn().mockResolvedValue(null) },
          $transaction: vi.fn(async (fn) => fn(tx)),
        } as unknown as PrismaClient,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      };
      const target = (
        kind === "bot"
          ? { kind, botId: "bot-1", threadId: "thread-1" }
          : {
              kind,
              groupId: "group-1",
              groupName: "Role",
              threadId: "thread-1",
              members: [],
              memberBotIds: ["bot-1"],
            }
      ) as ThreadTarget;
      const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
      for (const status of [undefined, "queued", "running"] as const) {
        tx.run.findMany.mockResolvedValue(
          status
            ? [{ id: "run-1", taskId: "task-1", botId: "bot-1", trigger: "user", status }]
            : [],
        );
        await sendThreadMessage(deps, actor, target, {
          text: "Read, don't send.",
          correspondenceReference: reference,
        });
        const blocks = tx.message.create.mock.lastCall![0].data.blocks;
        expect(blocks).toEqual([
          { kind: "text", text: "Read, don't send.", correspondenceReference: reference },
        ]);
        expect(tx.event.create.mock.lastCall![0].data.payload.blocks).toEqual(blocks);
      }
      expect(tx.task.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          prompt: expect.stringContaining(JSON.stringify(reference)),
        }),
      });
      expect(tx.steeringMessage.create).toHaveBeenCalledTimes(2);
      expect(tx.thread.findFirst).toHaveBeenLastCalledWith({
        where: {
          id: "thread-1",
          spaceId: actor.spaceId,
          activeRecruitingRoleId: reference.roleId,
          activeRecruitingRole: { userId: actor.userId, spaceId: actor.spaceId },
        },
        select: { id: true },
      });
      tx.thread.findFirst.mockResolvedValue(null);
      const eventCount = tx.event.create.mock.calls.length;
      await expect(
        sendThreadMessage(deps, actor, target, {
          text: "Read, don't send.",
          correspondenceReference: reference,
        }),
      ).rejects.toThrow("Open the current role");
      expect(tx.event.create).toHaveBeenCalledTimes(eventCount);
      tx.thread.findFirst.mockResolvedValue({ id: "thread-1" });
      await expect(
        sendThreadMessage(deps, actor, target, {
          text: "Read, don't send.",
          correspondenceReference: { ...reference, threadId: "other-thread" },
        }),
      ).rejects.toThrow("Open the current role");
      expect(tx.event.create).toHaveBeenCalledTimes(eventCount);
    },
  );
  it.each([
    {
      addressing: "coordinator",
      text: "Find candidates for this role.",
      mentions: undefined,
      expected: ["bot-a"],
    },
    {
      addressing: "coordinator",
      text: "Read this exact email.",
      mentions: undefined,
      expected: ["bot-a"],
    },
    {
      addressing: "coordinator",
      text: "@Sourcer please review the saved evidence.",
      mentions: ["bot-b"],
      expected: ["bot-a"],
    },
    {
      addressing: "coordinator",
      text: "@everyone compare these candidates.",
      mentions: undefined,
      expected: ["bot-a"],
    },
    {
      addressing: "coordinator",
      text: "Draft a reply to recruiter@Sourcer.example, not a send.",
      mentions: undefined,
      expected: ["bot-a"],
    },
    {
      addressing: undefined,
      text: "@Sourcer please review the saved evidence.",
      mentions: ["bot-b"],
      expected: ["bot-b"],
    },
    {
      addressing: "mentions",
      text: "@everyone compare these candidates.",
      mentions: undefined,
      expected: ["bot-a", "bot-b"],
    },
  ] as const)(
    "routes a group message using $addressing while preserving $text",
    async ({ addressing, text, mentions, expected }) => {
      const correspondenceReference =
        text === "Read this exact email."
          ? {
              threadId: "thread-1",
              roleId: "role-1",
              emailId: "email-1",
              sourceId: "mailbox-1",
              providerMessageId: "provider-message-1",
              savedRead: null,
              sourceName: "Mailbox",
              sender: null,
              subject: "A reply",
              date: null,
              snippet: true,
            }
          : undefined;
      let sequence = 0;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
        thread: {
          findFirst: vi.fn().mockResolvedValue({ id: "thread-1" }),
          update: vi.fn(async () => ({ nextMessageSeq: ++sequence, nextEventSeq: sequence })),
        },
        chatGroup: {
          findFirst: vi.fn().mockResolvedValue({
            id: "group-1",
            members: [
              { bot: { id: "bot-a", name: "Main", color: null } },
              { bot: { id: "bot-b", name: "Sourcer", color: null } },
            ],
          }),
          update: vi.fn(),
        },
        message: {
          create: vi.fn(
            async ({ data }: { data: { threadId: string; blocks: MessageBlock[] } }) => ({
              ...data,
              id: "message-1",
              seq: 1,
            }),
          ),
          update: vi.fn(),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(
            async ({ data }: { data: { botId: string; taskId: string; status: string } }) => ({
              ...data,
              id: `run-${data.botId}`,
            }),
          ),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        },
        task: {
          create: vi.fn(async ({ data }: { data: { botId: string; prompt: string } }) => ({
            ...data,
            id: `task-${data.botId}`,
          })),
        },
        event: {
          create: vi.fn(async ({ data }: { data: { threadId: string } }) => ({ ...data, seq: 2 })),
        },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
      const target = {
        kind: "group",
        groupId: "group-1",
        groupName: "Role",
        threadId: "thread-1",
        members: [],
        memberBotIds: ["bot-b", "bot-a"],
      } satisfies ThreadTarget;
      const enqueue = vi.fn().mockResolvedValue(undefined);

      const result = await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text,
          correspondenceReference,
          addressing,
          mentions: mentions ? [...mentions] : undefined,
          clientNonce: "send-1",
        },
      );

      expect(result.runIds).toEqual(expected.map((id) => `run-${id}`));
      expect(tx.task.create.mock.calls.map(([{ data }]) => data.botId)).toEqual(expected);
      expect(tx.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          prompt: correspondenceReference
            ? expect.stringContaining(JSON.stringify(correspondenceReference))
            : text,
        }),
      });
      expect(tx.message.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          threadId: "thread-1",
          blocks: [
            { kind: "text", text, ...(correspondenceReference ? { correspondenceReference } : {}) },
          ],
        }),
      });
      expect(tx.chatGroup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "group-1",
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
            thread: { id: "thread-1" },
          },
        }),
      );
      expect(tx.run.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ botId: { in: [...expected] } }),
        }),
      );
      expect(enqueue).toHaveBeenCalledTimes(expected.length);
    },
  );

  it("does not route coordinator messages into a group outside the actor scope", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      chatGroup: { findFirst: vi.fn() },
      message: { create: vi.fn() },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    await expect(
      sendThreadMessage(
        { prisma, events: { notify: vi.fn() } as never, jobs: { enqueue: vi.fn() } as never },
        { spaceId: "other-space", userId: "other-user" } as Actor,
        {
          kind: "group",
          groupId: "group-1",
          groupName: "Role",
          threadId: "thread-1",
          members: [],
          memberBotIds: ["bot-a", "bot-b"],
        },
        { text: "@everyone review the saved evidence", addressing: "coordinator" },
      ),
    ).rejects.toThrow();
    expect(tx.$queryRaw).toHaveBeenCalledWith(
      expect.anything(),
      "group-1",
      "other-space",
      "other-user",
    );
    expect(tx.chatGroup.findFirst).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  const composerAnswer = {
    id: "msg-1",
    threadId: "thread-1",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "Paris" }],
  };
  it.each([false, true])(
    "answers a waiting question with original free text (email context: %s)",
    async (withContext) => {
      const rawAnswer = " \n  Paris evidence 😀\n  ";
      const correspondenceReference = withContext
        ? {
            threadId: "thread-1",
            roleId: "role-1",
            emailId: "email-1",
            sourceId: "mailbox-1",
            providerMessageId: "provider-message-1",
            savedRead: null,
            sourceName: "Mailbox",
            sender: null,
            subject: "Send immediately",
            date: null,
            snippet: true,
          }
        : undefined;
      const blocks = [
        {
          kind: "text",
          text: rawAnswer,
          ...(correspondenceReference ? { correspondenceReference } : {}),
        },
      ];
      const rawComposerAnswer = { ...composerAnswer, blocks };
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        thread: {
          findFirst: vi.fn().mockResolvedValue({ id: "thread-1" }),
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
          ),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks,
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date(),
          }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "ask-1",
              blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
            },
          ]),
          findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
            where.id === composerAnswer.id
              ? rawComposerAnswer
              : {
                  id: "ask-1",
                  blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
                },
          ),
          update: vi.fn(),
        },
        run: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "run-waiting", taskId: "task-1", status: "waiting_input", trigger: "user" },
            ]),
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
        task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;
      const enqueue = vi.fn().mockResolvedValue(undefined);

      await expect(
        sendThreadMessage(
          {
            prisma,
            events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
            jobs: { enqueue } as never,
          },
          actor,
          target,
          {
            text: rawAnswer,
            correspondenceReference,
            clientNonce: "nonce-ask",
          },
        ),
      ).resolves.toMatchObject({
        runId: "run-waiting",
        taskId: "task-1",
        seq: 1,
        runIds: ["run-waiting"],
      });
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-waiting" } } },
        data: {
          prompt: `Which city should I use?\nAnswer: ${rawAnswer}`,
        },
      });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ blocks }),
      });
      expect(tx.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            prompt: `Which city should I use?\nAnswer: ${rawAnswer}`,
          },
        }),
      );
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "waiting_input" }),
          data: { status: "queued" },
        }),
      );
      expect(tx.steeringMessage.create).not.toHaveBeenCalled();
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({ runIds: ["run-waiting"] }),
        }),
      });
    },
  );

  it("continues every waiting run a free-text answer satisfies", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === composerAnswer.id ? composerAnswer : waitingAsk,
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting-1", taskId: "task-1", status: "waiting_input" },
          { id: "run-waiting-2", taskId: "task-2", status: "waiting_input" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-multi",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting-1",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting-1", "run-waiting-2"],
    });
    expect(tx.run.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ runIds: ["run-waiting-1", "run-waiting-2"] }),
      }),
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
    );
  });

  it("replays every answered waiting run from a free-text send receipt", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          id: "msg-1",
          seq: 4,
          runId: "run-waiting-1",
          sourceRuns: [],
        }),
      },
      event: {
        findFirst: vi.fn(async ({ select }: { select?: { seq?: boolean } }) =>
          select?.seq
            ? { seq: 9 }
            : {
                payload: {
                  messageId: "msg-1",
                  role: "user",
                  runIds: ["run-waiting-1", "run-waiting-2"],
                },
              },
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting-1", taskId: "task-1", status: "queued" },
          { id: "run-waiting-2", taskId: "task-2", status: "queued" },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: "run-waiting-1",
          taskId: "task-1",
          status: "queued",
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Paris",
          clientNonce: "nonce-ask-replay",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting-1",
      taskId: "task-1",
      seq: 4,
      runIds: ["run-waiting-1", "run-waiting-2"],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-waiting-1", "run-waiting-2"] } },
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
    );
  });

  it("continues every waiting run for the coordinator after an authored free-text answer", async () => {
    const rawAnswer = " \n  Paris evidence 😀 @Beta @everyone\n  ";
    const rawComposerAnswer = { ...composerAnswer, blocks: [{ kind: "text", text: rawAnswer }] };
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: rawAnswer }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === composerAnswer.id ? rawComposerAnswer : waitingAsk,
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting-1", taskId: "task-1", botId: "bot-a", status: "waiting_input" },
          { id: "run-waiting-2", taskId: "task-2", botId: "bot-a", status: "waiting_input" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn().mockResolvedValue({
          id: "unexpected-run",
          taskId: "unexpected-task",
          botId: "bot-b",
          status: "queued",
        }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: {
        create: vi.fn().mockResolvedValue({ id: "unexpected-task" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: rawAnswer,
          addressing: "coordinator",
          clientNonce: "nonce-ask-group-multi",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting-1",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting-1", "run-waiting-2"],
    });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ blocks: [{ kind: "text", text: rawAnswer }] }),
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          prompt: `Which city should I use?\nAnswer: ${rawAnswer}`,
        },
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ botId: { in: ["bot-a"] } }) }),
    );
    expect(tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ask-1" },
        data: expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({ kind: "ask", status: "answered" }),
          ]),
        }),
      }),
    );
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ runIds: ["run-waiting-1", "run-waiting-2"] }),
      }),
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-1" } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-waiting-2" } }),
    );
  });

  it.each(["bot", "group"] as const)("keeps native %s approval cards", async (kind) => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-1", name: "Main", color: null } },
            { bot: { id: "bot-2", name: "Sourcer", color: null } },
          ],
        }),
      },
      thread: {
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 2 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "allow" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ask-1",
            blocks: [
              {
                kind: "ask",
                approvalEffectId: "effect-1",
                text: "Review before writing",
                status: "pending",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        ]),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-waiting", taskId: "task-1", botId: "bot-1", status: "waiting_input" },
          ]),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn() },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target =
      kind === "group"
        ? ({
            kind: "group",
            groupId: "group-1",
            groupName: "Role",
            threadId: "thread-1",
            members: [],
            memberBotIds: ["bot-1", "bot-2"],
          } as ThreadTarget)
        : ({
            kind: "bot",
            botId: "bot-1",
            threadId: "thread-1",
            bot: { computer: null },
          } as ThreadTarget);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        {
          text: kind === "group" ? "@Sourcer @everyone allow" : "allow",
          addressing: kind === "group" ? "coordinator" : undefined,
          clientNonce: "nonce-1",
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it.each(["created", "bot_message"] as const)(
    "keeps human input for its own reply while a %s turn is active",
    async (trigger) => {
      const tx = {
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
          ),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "Check the inbox" }],
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date(),
          }),
          update: vi.fn(),
        },
        run: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "intro-run", taskId: "intro-task", status: "running", trigger },
            ]),
          create: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
          updateMany: vi.fn(),
        },
        task: { create: vi.fn(), updateMany: vi.fn() },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;
      const enqueue = vi.fn().mockResolvedValue(undefined);

      await expect(
        sendThreadMessage(
          {
            prisma,
            events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
            jobs: { enqueue } as never,
          },
          actor,
          target,
          { text: "Check the inbox", clientNonce: "nonce-during-intro" },
        ),
      ).resolves.toMatchObject({
        runId: "intro-run",
        taskId: "intro-task",
        runIds: ["intro-run"],
      });
      // The existing background or peer turn cannot consume the human's message.
      // Its durable continuation answers the person after that turn releases it.
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
      });
      expect(tx.run.create).not.toHaveBeenCalled();
      expect(tx.task.create).not.toHaveBeenCalled();
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: "msg-1" },
        data: { runId: "intro-run" },
      });
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("steers a waiting-takeover run instead of refusing the message", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "skip that" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_takeover" }]),
        findUnique: vi.fn().mockResolvedValue({
          status: "waiting_takeover",
          startedAt: new Date(),
        }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2 }) },
      task: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "skip that",
          clientNonce: "nonce-takeover",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      seq: 1,
      runIds: ["run-waiting"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "msg-1",
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });
  it.each([true, false])(
    "stores the interject marker only on a steering row bound to a live run (interrupt: %s)",
    async (interrupt) => {
      const tx = {
        thread: {
          update: vi
            .fn()
            .mockResolvedValueOnce({ nextMessageSeq: 2 })
            .mockResolvedValueOnce({ nextEventSeq: 3 }),
        },
        message: {
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "skip that" }],
            botId: null,
            replyToMessageId: null,
            runId: null,
            createdAt: new Date(),
          }),
          update: vi.fn(),
        },
        run: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "run-live", taskId: "task-1", status: "running", trigger: "user" },
            ]),
          findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn().mockResolvedValue({ seq: 2 }) },
        task: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;

      await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text: "skip that", clientNonce: `nonce-interject-${interrupt}`, interrupt },
      );
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: {
          messageId: "msg-1",
          botId: "bot-1",
          userId: "user-1",
          runId: "run-live",
          ...(interrupt ? { originTrigger: "interrupt" } : {}),
        },
      });
    },
  );

  it("keeps an interject pending without the marker when the active run cannot take it", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 2 })
          .mockResolvedValueOnce({ nextEventSeq: 3 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "skip that" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "intro-run", taskId: "intro-task", status: "running", trigger: "created" },
          ]),
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      { text: "skip that", clientNonce: "nonce-interject-pending", interrupt: true },
    );
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
    });
  });

  it("keeps a message pending instead of steering into an active routine run", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what are the alternatives?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: "run-routine", taskId: "task-routine", status: "running", trigger: "routine" },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-user", taskId: "task-user", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-user" }) },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 2, createdAt: new Date() }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what are the alternatives?", clientNonce: "nonce-routine" },
      ),
    ).resolves.toMatchObject({
      runId: "run-routine",
      taskId: "task-routine",
      runIds: ["run-routine"],
    });
    // Pending steering (no run): the routine's turn never claims it, and the continuation
    // that starts when the routine finishes answers with the full thread.
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: null },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-routine" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("keeps a group message pending instead of steering into a member's webhook run", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "status?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-webhook",
              taskId: "task-webhook",
              botId: "bot-a",
              status: "running",
              trigger: "webhook",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-a", taskId: "task-a", botId: "bot-a", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-a" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      { text: "status?", clientNonce: "nonce-group-webhook" },
    );

    expect(result).toMatchObject({ runId: "run-webhook", taskId: "task-webhook" });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-a", userId: "user-1", runId: null },
    });
    expect(tx.run.create).not.toHaveBeenCalled();
  });
  it("answers a routine run waiting for input from the composer", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === composerAnswer.id ? composerAnswer : waitingAsk,
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-routine",
            taskId: "task-routine",
            status: "waiting_input",
            trigger: "routine",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Paris", clientNonce: "nonce-routine-waiting" },
      ),
    ).resolves.toMatchObject({
      runId: "run-routine",
      taskId: "task-routine",
      runIds: ["run-routine"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-routine" } } },
      data: {
        prompt: "Which city should I use?\nAnswer: Paris",
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-routine", status: "waiting_input" }),
        data: { status: "queued" },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.choice",
        runId: "run-routine",
        payload: {
          messageId: "ask-1",
          askIndex: 0,
          answerMessageId: "msg-1",
          answeredByUserId: "user-1",
        },
      }),
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-routine" } }),
    );
  });
  it("answers a group webhook run waiting for input from the composer", async () => {
    const waitingAsk = {
      id: "ask-1",
      blocks: [{ kind: "ask", text: "Which city should I use?", status: "pending" }],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 3 },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Paris" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        findMany: vi.fn().mockResolvedValue([waitingAsk]),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === composerAnswer.id ? composerAnswer : waitingAsk,
        ),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-webhook",
            taskId: "task-webhook",
            botId: "bot-a",
            status: "waiting_input",
            trigger: "webhook",
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2, threadId: "thread-1" }) },
      task: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "Paris", clientNonce: "nonce-group-webhook-waiting" },
      ),
    ).resolves.toMatchObject({
      runId: "run-webhook",
      taskId: "task-webhook",
      runIds: ["run-webhook"],
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-webhook" } } },
      data: {
        prompt: "Which city should I use?\nAnswer: Paris",
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-webhook", status: "waiting_input" }),
        data: { status: "queued" },
      }),
    );
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.choice",
        runId: "run-webhook",
        payload: {
          messageId: "ask-1",
          askIndex: 0,
          answerMessageId: "msg-1",
          answeredByUserId: "user-1",
        },
      }),
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-webhook" } }),
    );
  });
  it("steers a conversational run instead of answering a waiting routine", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what about the watch?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-routine",
              taskId: "task-routine",
              status: "waiting_input",
              trigger: "routine",
            },
            { id: "run-user", taskId: "task-user", status: "running", trigger: "user" },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 2, createdAt: new Date() }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what about the watch?", clientNonce: "nonce-routine-and-chat" },
      ),
    ).resolves.toMatchObject({
      runId: "run-user",
      taskId: "task-user",
      runIds: ["run-user"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-1", userId: "user-1", runId: "run-user" },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-user" },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("steers a group conversational run instead of answering a waiting webhook", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "what about the watch?" }],
          botId: null,
          replyToMessageId: null,
          runId: null,
          createdAt: new Date(),
        }),
        update: vi.fn(),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "run-webhook",
              taskId: "task-webhook",
              botId: "bot-a",
              status: "waiting_input",
              trigger: "webhook",
            },
            {
              id: "run-user",
              taskId: "task-user",
              botId: "bot-a",
              status: "running",
              trigger: "user",
            },
          ])
          .mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        { text: "what about the watch?", clientNonce: "nonce-group-webhook-and-chat" },
      ),
    ).resolves.toMatchObject({
      runId: "run-user",
      taskId: "task-user",
      runIds: ["run-user"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "msg-1", botId: "bot-a", userId: "user-1", runId: "run-user" },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("rejects a quote excerpt without a reply target", async () => {
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "hi", replyQuote: "just this span", clientNonce: "nonce-1" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists the quote excerpt alongside the reply target", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread-1" },
      select: { id: true, blocks: true, role: true, botId: true },
    });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });

  it("stamps the call id on the live event so the bubble joins the call card at once", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const clientNonce = callClientNonce("call-7");
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "book the flight" }],
          botId: null,
          runId: null,
          clientNonce,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
      { text: "book the flight", clientNonce },
    );

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ callId: "call-7" }),
      }),
    });
  });

  it.each([undefined, "words the parent never said"])(
    "sends an unavailable reply to malformed blocks (quote: %s)",
    async (quote) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: [null],
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: null,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: quote,
          clientNonce: "nonce-1",
        },
      );

      // The send still lands as a plain reply — the fabricated excerpt is dropped.
      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          replyToMessageId: "parent",
          replyQuote: undefined,
        }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyPreview: null, replyToMessageId: "parent" }),
        }),
      });
    },
  );

  it("sends a plain reply when the reply target no longer exists", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        // The parent was deleted (or paged out) between arming and send.
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: null,
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "deleted-parent",
        replyQuote: "the span that was quoted",
        clientNonce: "nonce-1",
      },
    );

    // The send lands with an unavailable marker and no dangling target.
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: undefined,
        replyQuote: "",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.not.objectContaining({ replyToMessageId: expect.anything() }),
      }),
    });
  });

  it("accepts a quote excerpt that matches formatted parent text", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          // Rendered as "42% growth", stored with markdown source.
          blocks: [{ kind: "text", text: "we saw **42%** growth last week" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "42% growth",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "42% growth",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyQuote: "42% growth" }),
    });
  });

  it.each([
    ["table cells", "| Name | Value |\n|:-----|------:|\n| Alice | 5 |", "Alice 5", "Alice 5"],
    ["indented code", "    2. restart()", "2. restart()", "2. restart()"],
    ["fenced code", "```text\n2. restart()\n```", "2. restart()", "2. restart()"],
    [
      "lists after code fences",
      "```text\n1. code\n```\n1. First\n2. Second",
      "First\nSecond",
      "First\nSecond",
    ],
    ["tab-indented code", "\t2. restart()", "2. restart()", "2. restart()"],
    ["three-space lists", "   1. First\n   2. Second", "First\nSecond", "First\nSecond"],
    [
      "ordered list items",
      "1. Review the diff\n2. Run the tests",
      "Review the diff Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "parenthesized list items",
      "1) Review the diff\n2) Run the tests",
      "Review the diff\nRun the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "quoted list items",
      "> 1. Review the diff\n> 2. Run the tests",
      "Review the diff\nRun the tests",
      "Review the diff\nRun the tests",
    ],
  ])(
    "derives a quote excerpt spanning rendered %s",
    async (_name, parentText, requestedQuote, expectedQuote) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: [
              {
                kind: "text",
                text: parentText,
              },
            ],
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: expectedQuote,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: requestedQuote,
          clientNonce: "nonce-1",
        },
      );

      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ replyQuote: expectedQuote }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyQuote: expectedQuote }),
        }),
      });
    },
  );

  it.each([
    [
      "image only",
      [{ kind: "image", artifactId: "photo", name: "", mimeType: "image/png" }],
      undefined,
      undefined,
      "",
      { kind: "image", artifactId: "photo", name: "", mimeType: "image/png" },
    ],
    [
      "file only",
      [{ kind: "file", artifactId: "file", name: "notes.txt", mimeType: "text/plain", size: 12 }],
      undefined,
      undefined,
      "notes.txt",
      { kind: "file", artifactId: "file", name: "notes.txt", mimeType: "text/plain" },
    ],
    [
      "caption and selection",
      [
        { kind: "image", artifactId: "photo", name: "photo.png", mimeType: "image/png" },
        { kind: "text", text: "Caption selected text" },
      ],
      "selected text",
      "selected text",
      "Caption selected text",
      { kind: "image", artifactId: "photo", name: "photo.png", mimeType: "image/png" },
    ],
  ])(
    "derives live reply metadata for %s from the same-thread parent",
    async (_name, parentBlocks, requestedQuote, expectedQuote, expectedText, expectedAttachment) => {
      let messageSeq = 0;
      let eventSeq = 0;
      const tx = {
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
          ),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "parent",
            role: "bot",
            blocks: parentBlocks,
          }),
          update: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: "msg-1",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "why this?" }],
            botId: null,
            replyToMessageId: "parent",
            replyQuote: expectedQuote,
            runId: null,
            createdAt: new Date(),
          }),
        },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
        event: {
          create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
        },
        steeringMessage: { create: vi.fn() },
      };
      const prisma = {
        message: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
      const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

      const result = await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "why this?",
          replyToMessageId: "parent",
          replyQuote: requestedQuote,
          clientNonce: "nonce-1",
        },
      );

      expect(tx.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "parent", threadId: "thread-1" } }),
      );
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            replyPreview: { role: "bot", text: expectedText, attachment: expectedAttachment },
          }),
        }),
      });
      expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ replyQuote: expectedQuote }),
      });
      expect(tx.event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ replyQuote: expectedQuote }),
        }),
      });
    },
  );

  it("drops a quote excerpt that only matches after stripping punctuation", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [
            {
              kind: "text",
              text: "C++ is fast and key:value pairs; version 1.2 and 2. items\n    2. restart()\n```text\n1. alpha\n2. beta\n```\n~~~text\n1. gamma\n2. delta\n~~~\n```text\n> ```\n1. epsilon\n2. zeta\n```\n> ```text\n> > ```\n> 1. eta\n> 2. theta\n> ```\n```text\nalpha\n---\nomega\n```\nRead [docs](https://example.test/private)\nAlice\n# 1. heading\n# 2. another heading\n\n    > 1. literal\n    > 2. another literal",
            },
          ],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    for (const replyQuote of [
      "C is fast",
      "key value pairs",
      "version 12",
      "and items",
      "3. restart()",
      "    3. restart()",
      "99. C++ is fast",
      "alpha\nbeta",
      "gamma\ndelta",
      "epsilon\nzeta",
      "eta\ntheta",
      "alpha\nomega",
      "text",
      "https://example.test/private",
      "alice",
      "heading\nanother heading",
      "literal\nanother literal",
    ]) {
      await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text: "why this?", replyToMessageId: "parent", replyQuote },
      );
    }

    for (const call of tx.message.create.mock.calls) {
      expect(call[0].data.replyQuote).toBeUndefined();
    }
  });

  it("still sends a plain reply when quote derivation throws", async () => {
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: null,
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "explode derivation",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ replyToMessageId: "parent" }),
    });
    expect(tx.message.create.mock.calls[0][0].data.replyQuote).toBeUndefined();
  });

  it("commits a directed group send beyond the default transaction deadline", async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const completionOrder: string[] = [];
    let messageSeq = 0;
    let eventSeq = 0;
    const tx = {
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++messageSeq } : { nextEventSeq: ++eventSeq },
        ),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "parent",
          role: "bot",
          blocks: [{ kind: "text", text: "the parent says just this span inside it" }],
        }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          botId: null,
          replyToMessageId: "parent",
          replyQuote: "just this span",
          runId: null,
          createdAt: new Date(),
        }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn(async () => {
          // Virtual elapsed DB work, not a claim about any one production query.
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          return { id: "run-1", taskId: "task-1", botId: "bot-a", status: "queued" };
        }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      event: {
        create: vi.fn().mockResolvedValue({ id: "event-1", seq: 1, createdAt: new Date() }),
      },
      steeringMessage: { create: vi.fn() },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(
        async (
          callback: (client: typeof tx) => Promise<unknown>,
          options?: { timeout?: number; maxWait?: number },
        ) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              callback(tx),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(Object.assign(new Error("Transaction expired"), { code: "P2028" })),
                  options?.timeout ?? 5_000,
                );
              }),
            ]);
            completionOrder.push("commit");
            return result;
          } finally {
            clearTimeout(timer);
          }
        },
      ),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const notify = vi.fn(async () => {
      completionOrder.push("notify");
    });
    const enqueue = vi.fn(async () => {
      completionOrder.push("enqueue");
    });
    const sending = sendThreadMessage(
      {
        prisma,
        events: { notify } as never,
        jobs: { enqueue } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        mentions: ["bot-a"],
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(notify).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const [result] = await Promise.all([sending, vi.advanceTimersByTimeAsync(6_000)]);

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1", runIds: ["run-1"] });
    expect(prisma.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      timeout: 15_000,
      maxWait: 5_000,
    });
    expect(tx.run.create).toHaveBeenCalledTimes(1);
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ botId: "bot-a" }),
    });
    expect(completionOrder).toEqual(["commit", "notify", "enqueue"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        replyToMessageId: "parent",
        replyQuote: "just this span",
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ replyQuote: "just this span" }),
      }),
    });
  });
});

describe("stopThreadRuns", () => {
  it.each(["run-a", "run-foreign", "run-unknown"])(
    "stops only the requested run in the authorized thread: %s",
    async (runId) => {
      const rows = [
        { id: "run-a", botId: "bot-a", threadId: "thread-1" },
        { id: "run-b", botId: "bot-b", threadId: "thread-1" },
        { id: "run-foreign", botId: "bot-a", threadId: "other-thread" },
      ];
      const cancelled = runId === "run-a" ? ["run-a"] : [];
      const execute = vi.fn(async function* () {
        yield { type: "exit", code: 0 };
      });
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      const tx = {
        $queryRaw: vi.fn(),
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 2 }) },
        run: {
          updateManyAndReturn: vi.fn(
            async ({ where }: { where: { threadId: string; id?: string } }) =>
              rows.filter(
                (row) =>
                  row.threadId === where.threadId &&
                  (where.id === undefined || row.id === where.id),
              ),
          ),
          findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
        },
        steeringMessage: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        computerExecutionLease: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ computerId: "team", botId: "bot-a", runId: "run-a", fence: 2 }]),
        },
        computer: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "team",
              homeKey: "home",
              kind: "fake",
              providerRef: "team-provider",
              executionBotId: "bot-b",
              executionRunId: "run-b",
            },
          ]),
        },
        event: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
        ),
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      } as unknown as PrismaClient;
      const notify = vi.fn().mockResolvedValue(undefined);
      await stopThreadRuns(
        {
          prisma,
          sandbox: { execute, releaseScreen } as unknown as SandboxProvider,
          events: { notify } as never,
        },
        { spaceId: "space-1", userId: "user-1" } as Actor,
        {
          kind: "group",
          groupId: "group-1",
          groupName: "Crew",
          threadId: "thread-1",
          members: [],
          memberBotIds: ["bot-a", "bot-b"],
        },
        runId,
      );
      expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { threadId: "thread-1", id: runId, status: expect.anything() },
        }),
      );
      if (cancelled.length) {
        expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({
          where: { runId: { in: cancelled }, claimedAt: { not: null } },
        });
        expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
          where: { runId: { in: cancelled } },
          data: { runId: null },
        });
      } else {
        expect(tx.steeringMessage.deleteMany).not.toHaveBeenCalled();
        expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
      }
      expect(tx.event.create).toHaveBeenCalledTimes(cancelled.length);
      expect(execute).toHaveBeenCalledTimes(cancelled.length);
      if (cancelled.length) {
        expect(execute).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ runId: "run-a", botId: "bot-a", screenLeaseId: "run-a:2" }),
        );
        expect(tx.event.deleteMany).toHaveBeenCalledWith({
          where: { type: "thread.progress", runId: { in: cancelled } },
        });
      } else {
        expect(tx.computerExecutionLease.findMany).not.toHaveBeenCalled();
        expect(tx.event.deleteMany).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      }
      expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
        where: { runId: { in: cancelled } },
        data: { expiresAt: new Date(0) },
      });
      expect(prisma.computer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { executionRunId: { in: cancelled } },
        }),
      );
      expect(releaseScreen).toHaveBeenCalledTimes(cancelled.length);
    },
  );

  it("keeps unclaimed steering as pending input for the next run on a stop-all", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 2 }) },
      run: {
        updateManyAndReturn: vi.fn().mockResolvedValue([{ id: "run-a", botId: "bot-a" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
      computer: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "space-1", userId: "user-1" } as Actor,
      { kind: "bot", botId: "bot-a", threadId: "thread-1" } as ThreadTarget,
    );
    // Only steering the stopped run already read is gone; never the bot's pending rows.
    expect(tx.steeringMessage.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { runId: { in: ["run-a"] }, claimedAt: { not: null } },
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { runId: { in: ["run-a"] } },
      data: { runId: null },
    });
  });

  it("snapshots every lease when group members share a team computer", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    let nextEventSeq = 0;
    const transaction = {
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })),
      },
      run: {
        updateManyAndReturn: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computer: {
        // Production team ownership is lease-only: Computer.executionRunId stays null.
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { OR?: unknown[] } }) => {
          expect(where.OR).toEqual(
            expect.arrayContaining([
              { id: { in: ["computer-db-team"] } },
              { executionRunId: { in: ["run-a", "run-b"] } },
            ]),
          );
          return [
            {
              id: "computer-db-team",
              homeKey: "home-team",
              kind: "fake",
              providerRef: "computer-team",
              executionBotId: null,
              executionRunId: null,
            },
          ];
        }),
      },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([
          { computerId: "computer-db-team", botId: "bot-a", runId: "run-a", fence: 2 },
          { computerId: "computer-db-team", botId: "bot-b", runId: "run-b", fence: 4 },
        ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      // Simulate workers clearing leases / execution columns as soon as the
      // transaction commits. A post-commit lookup would now miss both sandboxes.
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(transaction.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      select: { computerId: true, botId: true, runId: true, fence: true },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-team", "run-b"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-b", botId: "bot-b" }),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-a",
        cancelRunWork: true,
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-b",
        cancelRunWork: true,
        runId: "run-b",
        screenLeaseId: "run-b:4",
      }),
    );
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionRunId: { in: ["run-a", "run-b"] } } }),
    );
  });

  it("does not tear down a stale legacy execution run when the lease owns a cancelled run", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }),
      },
      run: {
        updateManyAndReturn: vi.fn().mockResolvedValue([{ id: "run-a", botId: "bot-a" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computer: {
        // Selected via lease for cancelled run A, but legacy columns still name
        // unrelated live run B. Legacy teardown must not cancel/release B.
        findMany: vi.fn().mockResolvedValue([
          {
            id: "computer-db-a",
            homeKey: "home-a",
            kind: "fake",
            providerRef: "computer-a",
            executionBotId: "bot-b",
            executionRunId: "run-b",
          },
        ]),
      },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-db-a", botId: "bot-a", runId: "run-a", fence: 2 },
          ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-b"]),
      }),
      expect.anything(),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(1);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        botId: "bot-a",
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-b" }),
    );
  });

  it("writes a run.cancelled event per cancelled run ahead of the progress purge", async () => {
    // Two earlier progress events already hold seqs 0 and 1; a client may have
    // applied cursor 1 before Stop deletes those rows.
    let nextEventSeq = 2;
    const writes: string[] = [];
    const created: Array<Record<string, unknown>> = [];
    const transaction = {
      $queryRaw: vi.fn(),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })),
      },
      run: {
        updateManyAndReturn: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        // appendEventInTransaction re-reads the run after the flip.
        findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }),
      },
      steeringMessage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computer: { findMany: vi.fn().mockResolvedValue([]) },
      computerExecutionLease: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push("event.create");
          created.push(data);
          return data;
        }),
        deleteMany: vi.fn(async () => {
          writes.push("event.deleteMany");
          return { count: 4 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      // No event delegate: a post-commit progress delete would throw here.
    } as unknown as PrismaClient;
    const notify = vi.fn().mockResolvedValue(undefined);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify } as never,
      },
      actor,
      target,
    );

    expect(created).toEqual([
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-a",
        type: "run.cancelled",
        runId: "run-a",
        payload: {},
        seq: 2,
      }),
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-b",
        type: "run.cancelled",
        runId: "run-b",
        payload: {},
        seq: 3,
      }),
    ]);
    // The terminal seqs sit above every deleted progress seq, so max(seq) never
    // rewinds below an applied cursor — the freeze regression.
    expect(Math.max(...created.map((data) => data.seq as number))).toBeGreaterThan(1);
    expect(writes.lastIndexOf("event.create")).toBeLessThan(writes.indexOf("event.deleteMany"));
    expect(transaction.event.deleteMany).toHaveBeenCalledWith({
      where: { type: "thread.progress", runId: { in: ["run-a", "run-b"] } },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 3);
  });

  it("emits no event and skips the wake when nothing was running", async () => {
    const transaction = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn() },
      run: {
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
      steeringMessage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computer: { findMany: vi.fn() },
      computerExecutionLease: { findMany: vi.fn() },
      event: { create: vi.fn(), deleteMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const notify = vi.fn().mockResolvedValue(undefined);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await stopThreadRuns(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        events: { notify } as never,
      },
      actor,
      target,
    );

    expect(transaction.event.create).not.toHaveBeenCalled();
    expect(transaction.event.deleteMany).not.toHaveBeenCalled();
    expect(transaction.thread.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("send path round trips", () => {
  // Every Prisma model call is one database round trip; the count is the regression check.
  function countingPrisma() {
    const calls: string[] = [];
    let seq = 0;
    const impl: Record<string, Record<string, (args: never) => unknown>> = {
      message: {
        findUnique: async () => null,
        create: async ({ data }: { data: object }) => ({ ...data, id: "message-1", seq: 1 }),
        update: async () => ({}),
      },
      thread: { update: async () => ({ nextMessageSeq: ++seq, nextEventSeq: seq }) },
      run: {
        findMany: async () => [],
        findUnique: async () => ({ status: "queued" }),
        create: async ({ data }: { data: object }) => ({ ...data, id: "run-1" }),
      },
      task: { create: async ({ data }: { data: object }) => ({ ...data, id: "task-1" }) },
      event: { create: async ({ data }: { data: object }) => ({ ...data, seq }) },
    };
    const model = (name: string) =>
      new Proxy({} as Record<string, unknown>, {
        get: (_target, method: string) => (args: never) => {
          calls.push(`${name}.${method}`);
          const fn = impl[name]?.[method];
          if (!fn) throw new Error(`unexpected ${name}.${method}`);
          return fn(args);
        },
      });
    const tx = new Proxy({} as Record<string, unknown>, { get: (_t, name: string) => model(name) });
    const prisma = new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) =>
        name === "$transaction" ? async (fn: (tx: unknown) => unknown) => fn(tx) : model(name),
    });
    return { prisma: prisma as unknown as PrismaClient, calls };
  }

  it("acknowledges a bot send with the durable write, one wake and no extra lookups", async () => {
    const { prisma, calls } = countingPrisma();
    const order: string[] = [];
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => void order.push("notify")) } as never,
      jobs: { enqueue: vi.fn(async () => void order.push("enqueue")) } as never,
    };
    const result = await sendThreadMessage(
      deps,
      { spaceId: "space-1", userId: "user-1" } as Actor,
      { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
      { text: "hello", clientNonce: "nonce-1" },
    );
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1", runIds: ["run-1"] });
    expect(calls).toEqual([
      "message.findUnique",
      "thread.update",
      "message.create",
      "run.findMany",
      "task.create",
      "run.create",
      "message.update",
      "thread.update",
      "run.findUnique",
      "event.create",
    ]);
    expect(order).toEqual(["notify", "enqueue"]);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ runId: "run-1" }) }),
    );
  });
});
