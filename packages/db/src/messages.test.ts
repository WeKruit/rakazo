import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  createThreadMessage,
  createThreadMessageInTransaction,
  isNativeHumanMessage,
  loadRunHistoryMessages,
  loadRunHumanSources,
  RunHistoryWriteError,
  validateRunHumanSourceRows,
} from "./messages.js";

function humanSources() {
  const actor = {
    spaceId: "space",
    userId: "human",
    email: "human@example.test",
    isDeploymentOwner: false,
  };
  const run = {
    id: "run",
    botId: "bot",
    threadId: "thread",
    sourceMessageId: "goal",
    trigger: "user",
  };
  const raw = " \r\n same answer 😀  ";
  const row = (id: string, seq: number, role: string, blocks: MessageBlock[]) => ({
    id,
    seq,
    role,
    blocks,
    threadId: run.threadId,
    botId: role === "bot" ? run.botId : null,
    runId: role === "bot" ? run.id : "shared-primary-run",
    externalTranscriptFor: null as object | null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const rows = [
    row("goal", 1, "user", [{ kind: "text", text: "Ask twice, then quote the answer and stop." }]),
    row("card-1", 2, "bot", [
      { kind: "ask", text: "First question?", status: "answered", answer: raw },
    ]),
    row("answer-1", 3, "user", [{ kind: "text", text: raw }]),
    row("card-2", 1001, "bot", [
      { kind: "ask", text: "Second question?", status: "answered", answer: raw },
    ]),
    row("answer-2", 1002, "user", [{ kind: "text", text: raw }]),
  ];
  const proof = (messageId: string, answerMessageId: string) => ({
    messageId,
    askIndex: 0,
    answerMessageId,
    answeredByUserId: actor.userId,
  });
  const events = [
    { seq: 10, type: "run.waiting_input", payload: {} },
    { seq: 11, type: "thread.choice", payload: proof("card-1", "answer-1") },
    { seq: 12, type: "run.waiting_input", payload: {} },
    { seq: 13, type: "thread.choice", payload: proof("card-2", "answer-2") },
  ];
  const tx = {
    steeringMessage: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findMany: vi.fn(async () => events) },
    message: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        rows.filter((message) => where.id.in.includes(message.id)),
      ),
    },
  };
  return {
    actor,
    run,
    raw,
    rows,
    events,
    tx,
    load: () => loadRunHumanSources(tx as unknown as Prisma.TransactionClient, actor, run),
  };
}

describe("native ordinary Ask continuation", () => {
  it("validates preloaded native rows identically without querying storage", async () => {
    const f = humanSources();
    const preloaded = validateRunHumanSourceRows(
      f.actor,
      f.run,
      f.events as never,
      f.rows as never,
    );
    expect(f.tx.event.findMany).not.toHaveBeenCalled();
    expect(f.tx.message.findMany).not.toHaveBeenCalled();
    const { steering: _steering, ...loaded } = await f.load();
    expect(preloaded).toEqual(loaded);
  });
  it("loads original goal and ordered cards outside recent history, including shared-run composer answers", async () => {
    const f = humanSources();
    const result = await f.load();
    expect(result.originalSource?.id).toBe("goal");
    expect(result.answeredAsks.map((turn) => [turn.card.id, turn.answer.id])).toEqual([
      ["card-1", "answer-1"],
      ["card-2", "answer-2"],
    ]);
    expect(result.currentAnswer?.id).toBe("answer-2");
    expect(result.currentAnswer?.blocks).toEqual([{ kind: "text", text: f.raw }]);
    expect(f.tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: expect.arrayContaining(["goal", "card-1", "answer-1", "card-2", "answer-2"]) },
        }),
      }),
    );
  });

  it("rejects an ordinary receipt with no authoritative pause", async () => {
    const f = humanSources();
    f.events.splice(2, 1);
    f.events.splice(0, 1);
    await expect(
      loadRunHumanSources(f.tx as unknown as Prisma.TransactionClient, f.actor, f.run, {
        continuationOnly: true,
      }),
    ).rejects.toThrow("Resource not found");
  });

  it("rejects an incomplete older question chain before using the latest answer", async () => {
    const f = humanSources();
    f.rows[2]!.blocks = [{ kind: "text", text: "changed previous answer" }];
    await expect(
      loadRunHumanSources(f.tx as unknown as Prisma.TransactionClient, f.actor, f.run, {
        continuationOnly: true,
      }),
    ).rejects.toThrow("Resource not found");
  });

  it("keeps raw composer choice text while validating its canonical recorded option", async () => {
    const f = humanSources();
    Object.assign(f.rows[3]!.blocks[0]!, {
      actions: [
        { id: "seoul", label: "Seoul" },
        { id: "paris", label: "Paris" },
      ],
      answer: "seoul",
    });
    f.rows[4]!.blocks = [{ kind: "text", text: " seoul " }];
    expect((await f.load()).currentAnswer?.blocks).toEqual([{ kind: "text", text: " seoul " }]);
  });

  it("does not query original sources or steering on an initial continuation probe", async () => {
    const f = humanSources();
    f.events.length = 0;
    const result = await loadRunHumanSources(
      f.tx as unknown as Prisma.TransactionClient,
      f.actor,
      f.run,
      { continuationOnly: true },
    );
    expect(result.currentAnswer).toBeNull();
    expect(f.tx.message.findMany).not.toHaveBeenCalled();
    expect(f.tx.steeringMessage.findMany).not.toHaveBeenCalled();
  });

  it.each(["run.waiting_input", "computer.takeover.requested"])(
    "does not reuse an old ordinary answer after later %s",
    async (type) => {
      const f = humanSources();
      f.events.push({ seq: 14, type, payload: {} });
      expect((await f.load()).currentAnswer).toBeNull();
    },
  );

  it.each([
    "actor",
    "card",
    "answer",
    "index",
    "malformed",
    "approval",
    "secret",
    "blank",
    "mismatch",
  ])(
    "rejects an invalid latest %s proof instead of selecting the previous answer",
    async (boundary) => {
      const f = humanSources();
      const latest = f.events[3]!;
      if (boundary === "actor") Object.assign(latest.payload, { answeredByUserId: "other-human" });
      if (boundary === "card") f.rows[3]!.botId = "other-bot";
      if (boundary === "answer") f.rows[4]!.externalTranscriptFor = {};
      if (boundary === "index") Object.assign(latest.payload, { askIndex: 9 });
      if (boundary === "malformed") latest.payload = {};
      if (boundary === "approval")
        Object.assign(f.rows[3]!.blocks[0]!, { approvalEffectId: "effect" });
      if (boundary === "secret")
        Object.assign(f.rows[3]!.blocks[0]!, { input: "secret", purpose: "password" });
      if (boundary === "blank") f.rows[4]!.blocks = [{ kind: "text", text: " \n " }];
      if (boundary === "mismatch") f.rows[4]!.blocks = [{ kind: "text", text: "edited answer" }];
      await expect(f.load()).rejects.toThrow("Resource not found");
      expect(() =>
        validateRunHumanSourceRows(f.actor, f.run, f.events as never, f.rows as never),
      ).toThrow("Resource not found");
    },
  );
});

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });

  it("rejects a cancelled run unless the terminal echo opts in", async () => {
    const tx = transaction();
    tx.run.findUnique.mockResolvedValue({ status: "cancelled", startedAt: new Date() });
    const input = {
      threadId: "thread-1",
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Stopped. This stayed queued without starting." }],
      runId: "run-1",
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      ...input,
      allowCancelledRun: true,
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("run history isolation", () => {
  it("keeps a follow-up out of model history until the continuation releases it", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await loadRunHistoryMessages(
      { message: { findMany } } as never,
      { id: "run", threadId: "thread" },
      10,
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          steeringMessages: { none: { originTrigger: "follow_up" } },
        }),
      }),
    );
  });
  it("only reads the run's own thread, so two users' threads never merge", async () => {
    const table = [
      { id: "m-a", threadId: "thread-a", role: "user", seq: 1 },
      { id: "m-b", threadId: "thread-b", role: "user", seq: 1 },
      { id: "m-b2", threadId: "thread-b", role: "bot", seq: 2 },
    ];
    const findMany = vi.fn(async ({ where }: { where: { threadId: string } }) =>
      table.filter((row) => row.threadId === where.threadId),
    );
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    const seenA = await loadRunHistoryMessages(prisma, { id: "run-a", threadId: "thread-a" }, 10);
    const seenB = await loadRunHistoryMessages(prisma, { id: "run-b", threadId: "thread-b" }, 10);
    expect(seenA.map((row) => row.id)).toEqual(["m-a"]);
    expect(seenB.map((row) => row.id)).toEqual(["m-b", "m-b2"]);
    for (const call of findMany.mock.calls) {
      expect(call[0].where.threadId).toEqual(expect.any(String));
    }
  });
});

it("never treats a synthetic continuation as human approval evidence", () => {
  const row = {
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "Continue" }],
  };
  expect(isNativeHumanMessage(row as never)).toBe(true);
  expect(isNativeHumanMessage({ ...row, clientNonce: "autocontinue:run:1" } as never)).toBe(false);
  expect(isNativeHumanMessage({ ...row, role: "system" } as never)).toBe(false);
});
