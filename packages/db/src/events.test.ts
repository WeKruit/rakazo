import { createHash } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { encodeLoginSecret, ProductEventSchema } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  answerRunInput,
  answerWaitingRunWithTextInTransaction,
  appendEvent,
  appendEventsInTransaction,
  claimSteering,
  clearThread,
  completedRunBlocks,
  discardAnsweredSteering,
  finalizeComputerControlRelease,
  finalizeRun,
  followThreadEvents,
  pauseRunForInput,
  pauseRunForTakeover,
  sendUserMessage,
} from "./events.js";
import { RunHistoryWriteError } from "./messages.js";
import { IsolationError } from "./scope.js";

afterEach(() => {
  installLogger(createLogger({ service: "rakazo-test", level: "off", sinks: [] }));
});

class TestFanout implements RealtimeFanout {
  subscriber: ((payload: string) => void) | undefined;
  unsubscribed = false;

  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(_topic: string, payload: string) {
    this.subscriber?.(payload);
  }

  async subscribe(_topic: string, subscriber: (payload: string) => void) {
    this.subscriber = subscriber;
    return async () => {
      this.unsubscribed = true;
      this.subscriber = undefined;
    };
  }

  async close() {}
}

function event(seq: number) {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "run.started",
    payload: {},
    runId: null,
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
  };
}

function ordinaryAnswerFixture(
  blocks: MessageBlock[] = [{ kind: "ask", text: "Which city?", status: "pending" }],
) {
  const run = {
    id: "run-1",
    status: "waiting_input",
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    userId: "user-1",
    trigger: "user",
    checkpoint: null,
  };
  const rows: Array<{
    id: string;
    threadId: string;
    role: string;
    botId: string | null;
    runId: string;
    blocks: MessageBlock[];
    externalTranscriptFor?: object | null;
  }> = [
    { id: "ask-card", threadId: "thread-1", role: "bot", botId: "bot-1", runId: "run-1", blocks },
  ];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    run: {
      findFirst: vi.fn(async () => (run.status === "waiting_input" ? run : null)),
      findUnique: vi.fn(async () => run),
      updateMany: vi.fn(async () => {
        if (run.status !== "waiting_input") return { count: 0 };
        run.status = "queued";
        return { count: 1 };
      }),
    },
    message: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; threadId?: string } }) =>
          rows.find(
            (row) => row.id === where.id && (!where.threadId || row.threadId === where.threadId),
          ) ?? null,
      ),
      findMany: vi.fn(async () => rows.filter((row) => row.role === "bot")),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            threadId: string;
            role: string;
            botId?: string;
            runId: string;
            blocks: MessageBlock[];
          };
        }) => {
          const row = { ...data, id: "created-human", botId: data.botId ?? null };
          rows.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) =>
          Object.assign(rows.find((row) => row.id === where.id)!, data),
      ),
    },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 4 }) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...event(3),
        ...data,
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const input = {
    spaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    messageId: "ask-card",
    answeredByUserId: "user-1",
    answer: "Paris",
  };
  return { tx, prisma, input, rows, run };
}

const persistedApprovalRequest = [
  "__rakazoCatalogTool",
  "direct",
  {
    route: {
      toolName: "destination.write",
      resourceRevision: 2,
      resourceId: "server-synthetic",
      connectorId: "mcp",
    },
    args: {
      text: "synthetic-private-request",
      rows: [{ value: null, id: "row-synthetic" }],
    },
  },
];

function approvalAnswerFixture(request: unknown = persistedApprovalRequest) {
  const f = ordinaryAnswerFixture([
    { kind: "text", text: "Review this action" },
    {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Write [redacted] to destination?",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    },
  ]);
  const effect = {
    id: "effect-1",
    spaceId: f.input.spaceId,
    runId: f.input.runId,
    status: "intended",
    kind: "destination.write",
    request,
  };
  let seq = 10;
  f.tx.thread.update.mockImplementation(async () => ({
    nextEventSeq: ++seq,
    nextMessageSeq: 3,
  }));
  const tx = {
    ...f.tx,
    externalEffect: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) =>
        Object.entries(where).every(([key, value]) => effect[key as keyof typeof effect] === value)
          ? effect
          : null,
      ),
      update: vi.fn(async ({ data }: { data: { status: string } }) => Object.assign(effect, data)),
    },
    actionApprovalRule: { upsert: vi.fn().mockResolvedValue({ id: "rule-synthetic" }) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const fanout = new TestFanout();
  const publish = vi.spyOn(fanout, "publish");
  return { ...f, tx, prisma, effect, fanout, publish };
}

describe("native approval answer provenance", () => {
  it("never stores an always-allow rule for recruiting gate approvals", async () => {
    const f = approvalAnswerFixture();
    f.effect.kind = "recruiting_request_approval";
    await expect(answerRunInput(f.prisma, { ...f.input, answer: "always" })).resolves.toBe(false);
    expect(f.tx.externalEffect.update).not.toHaveBeenCalled();
    expect(f.tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
  });

  it.each(["brief", "documents"])(
    "rejects an invalid %s allow but leaves stale cards usable for deny",
    async (stage) => {
      const f = approvalAnswerFixture({ stage, roleId: "missing-role" });
      f.effect.kind = "recruiting_request_approval";
      await expect(answerRunInput(f.prisma, { ...f.input, answer: "allow" })).resolves.toBe(false);
      expect(f.tx.externalEffect.update).not.toHaveBeenCalled();
      await expect(answerRunInput(f.prisma, { ...f.input, answer: "deny" })).resolves.toBe(true);
      expect(f.effect.status).toBe("denied");
    },
  );

  it.each(["allow", "always", "deny"])(
    "records one exact %s decision with the authenticated approver and canonical persisted request hash",
    async (answer) => {
      const f = approvalAnswerFixture();
      const answeredByUserId = answer === "always" ? f.run.userId : "teammate-approver";
      const input = { ...f.input, answer, answeredByUserId };
      await expect(answerRunInput(f.prisma, input, f.fanout)).resolves.toBe(true);
      const proofs = f.tx.event.create.mock.calls
        .map(([{ data }]) => data)
        .filter((data) => data.type === "effect.approval.answered");
      expect(proofs).toEqual([
        {
          spaceId: f.input.spaceId,
          threadId: f.input.threadId,
          botId: f.run.botId,
          runId: f.input.runId,
          seq: 11,
          type: "effect.approval.answered",
          payload: {
            effectId: f.effect.id,
            messageId: f.input.messageId,
            askIndex: 1,
            answeredByUserId,
            answer,
            requestHash: createHash("sha256")
              .update(stableJsonValue(persistedApprovalRequest))
              .digest("hex"),
          },
        },
      ]);
      expect(
        ProductEventSchema.safeParse({
          ...event(11),
          ...proofs[0],
          createdAt: event(11).createdAt.toISOString(),
        }).success,
      ).toBe(true);
      expect(f.effect.status).toBe(answer === "deny" ? "denied" : "approved");
      expect(f.tx.message.create).not.toHaveBeenCalled();
      expect(f.tx.task.updateMany).not.toHaveBeenCalled();
      expect(f.tx.event.create.mock.calls.map(([{ data }]) => data.type)).toEqual([
        "thread.message.updated",
        "effect.approval.answered",
      ]);
      expect(JSON.stringify(proofs)).not.toContain("synthetic-private-request");
      expect(f.publish).toHaveBeenCalledExactlyOnceWith("thread:thread-1", '{"cursor":11}');
      await expect(answerRunInput(f.prisma, input, f.fanout)).resolves.toBe(false);
      expect(f.tx.event.create).toHaveBeenCalledTimes(2);
      expect(f.publish).toHaveBeenCalledTimes(1);
    },
  );

  it("hashes persisted plain JSON canonically rather than the redacted card or property order", async () => {
    const request = { z: [2, { b: false, a: null }], a: "synthetic-private-request" };
    const canonical = '{"a":"synthetic-private-request","z":[2,{"a":null,"b":false}]}';
    const f = approvalAnswerFixture(request);
    await expect(answerRunInput(f.prisma, { ...f.input, answer: "allow" })).resolves.toBe(true);
    expect(f.tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "effect.approval.answered",
        payload: expect.objectContaining({
          requestHash: createHash("sha256").update(canonical).digest("hex"),
        }),
      }),
    });
    expect(createHash("sha256").update(JSON.stringify(request)).digest("hex")).not.toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it.each([
    ["id", "different-effect"],
    ["spaceId", "different-space"],
    ["runId", "different-run"],
    ["status", "approved"],
  ])("writes no proof when the persisted effect has a mismatched %s", async (key, value) => {
    const f = approvalAnswerFixture();
    Object.assign(f.effect, { [key]: value });
    await expect(answerRunInput(f.prisma, { ...f.input, answer: "allow" }, f.fanout)).resolves.toBe(
      false,
    );
    expect(f.tx.externalEffect.findFirst).toHaveBeenCalledWith({
      where: { id: "effect-1", spaceId: f.input.spaceId, runId: f.input.runId, status: "intended" },
    });
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("writes no proof for an absent effect", async () => {
    const f = approvalAnswerFixture();
    f.tx.externalEffect.findFirst.mockResolvedValue(null);
    await expect(answerRunInput(f.prisma, { ...f.input, answer: "allow" }, f.fanout)).resolves.toBe(
      false,
    );
    expect(f.tx.event.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("writes no proof for an unoffered answer", async () => {
    const f = approvalAnswerFixture();
    await expect(
      answerRunInput(f.prisma, { ...f.input, answer: "accept" }, f.fanout),
    ).resolves.toBe(false);
    expect(f.tx.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("writes no proof when a teammate tries to always-allow for the run owner", async () => {
    const f = approvalAnswerFixture();
    await expect(
      answerRunInput(
        f.prisma,
        { ...f.input, answer: "always", answeredByUserId: "teammate-approver" },
        f.fanout,
      ),
    ).resolves.toBe(false);
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
    expect(f.tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("writes no proof when the waiting-run claim is lost", async () => {
    const f = approvalAnswerFixture();
    f.tx.run.updateMany.mockResolvedValue({ count: 0 });
    await expect(answerRunInput(f.prisma, { ...f.input, answer: "allow" }, f.fanout)).resolves.toBe(
      false,
    );
    expect(f.tx.externalEffect.update).not.toHaveBeenCalled();
    expect(f.tx.message.update).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("rejects the answer call and publishes nothing when appending its proof fails", async () => {
    const f = approvalAnswerFixture();
    f.tx.event.create.mockImplementation(async ({ data }) => {
      if (data.type === "effect.approval.answered") throw new Error("proof append failed");
      return { ...event(10), ...data };
    });
    await expect(
      answerRunInput(f.prisma, { ...f.input, answer: "allow" }, f.fanout),
    ).rejects.toThrow("proof append failed");
    expect(f.tx.event.create).toHaveBeenCalledTimes(2);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("validates an exact approval proof payload without raw requests or application timestamps", () => {
    const payload = {
      effectId: "effect-1",
      messageId: "ask-card",
      askIndex: 1,
      answeredByUserId: "teammate-approver",
      answer: "allow",
      requestHash: "a".repeat(64),
    };
    const proof = {
      ...event(11),
      runId: "run-1",
      createdAt: event(11).createdAt.toISOString(),
      type: "effect.approval.answered",
      payload,
    };
    expect(ProductEventSchema.safeParse(proof).success).toBe(true);
    for (const invalid of [
      {},
      { ...payload, effectId: "" },
      { ...payload, messageId: "" },
      { ...payload, askIndex: -1 },
      { ...payload, askIndex: 0.5 },
      { ...payload, answeredByUserId: "" },
      { ...payload, answer: "unoffered" },
      { ...payload, requestHash: "wrong" },
      { ...payload, request: persistedApprovalRequest },
      { ...payload, approvedAt: proof.createdAt },
    ]) {
      expect(ProductEventSchema.safeParse({ ...proof, payload: invalid }).success).toBe(false);
    }
  });
});

describe("ordinary native Ask answer provenance", () => {
  it("does not turn a structured form response into approval or secret input", async () => {
    for (const block of [
      {
        kind: "ask" as const,
        text: "Approve?",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      },
      { kind: "ask" as const, text: "Code?", input: "secret" as const },
    ]) {
      const f = ordinaryAnswerFixture([block]);
      const store = vi.fn();
      expect(
        await answerRunInput(
          f.prisma,
          { ...f.input, answer: { action: "accept", content: { decision: "allow" } } },
          undefined,
          { store },
        ),
      ).toBe(false);
      expect(f.tx.run.updateMany).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
    }
  });

  it("validates the persisted form before resuming the same run and original card", async () => {
    const requestedSchema = {
      type: "object" as const,
      properties: {
        website: { type: "string" as const, format: "uri" as const },
        regions: {
          type: "array" as const,
          minItems: 1,
          items: { type: "string" as const, enum: ["north", "south"] },
        },
      },
      required: ["website", "regions"],
    };
    const f = ordinaryAnswerFixture([
      { kind: "ask", text: "Details?", requestedSchema, status: "pending" },
    ]);
    for (const answer of [
      "plain text",
      { action: "accept", content: { website: "invalid", regions: ["north"] } },
      { action: "accept", content: { website: "https://example.com", regions: ["unknown"] } },
    ]) {
      expect(await answerRunInput(f.prisma, { ...f.input, answer } as never)).toBe(false);
    }
    expect(await answerWaitingRunWithTextInTransaction(f.tx as never, f.input)).toBeNull();
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
    const response = {
      action: "accept" as const,
      content: { website: "https://example.com", regions: ["north", "south"] },
    };
    expect(await answerRunInput(f.prisma, { ...f.input, answer: response } as never)).toBe(true);
    expect(f.rows[0]).toMatchObject({
      id: "ask-card",
      runId: "run-1",
      blocks: [{ kind: "ask", status: "answered", requestedSchema, formResponse: response }],
    });
    expect(f.tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { prompt: expect.stringContaining(JSON.stringify(response)) },
      }),
    );
    expect(await answerRunInput(f.prisma, { ...f.input, answer: response } as never)).toBe(false);
  });

  it.each(["cancel", "decline"] as const)(
    "records form %s without approving an effect",
    async (action) => {
      const f = ordinaryAnswerFixture([
        {
          kind: "ask",
          text: "Details?",
          status: "pending",
          requestedSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      ]);
      expect(await answerRunInput(f.prisma, { ...f.input, answer: { action } } as never)).toBe(
        true,
      );
      expect(f.rows[0]?.blocks[0]).toMatchObject({ status: "answered", formResponse: { action } });
      expect(f.tx.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { prompt: expect.stringContaining(JSON.stringify({ action })) },
        }),
      );
    },
  );
  it("records the visible selected label as a human message and links the exact answered Ask block", async () => {
    const f = ordinaryAnswerFixture([
      { kind: "text", text: "Choose a location" },
      {
        kind: "ask",
        text: "Which city?",
        status: "pending",
        actions: [
          { id: "one", label: "Paris" },
          { id: "two", label: "Berlin" },
        ],
      },
    ]);
    await expect(answerRunInput(f.prisma, { ...f.input, answer: "one" })).resolves.toBe(true);
    expect(f.rows.find((row) => row.id === "created-human")).toMatchObject({
      role: "user",
      botId: null,
      runId: "run-1",
      blocks: [{ kind: "text", text: "Paris" }],
    });
    expect(f.tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        botId: "bot-1",
        type: "thread.choice",
        payload: {
          messageId: "ask-card",
          askIndex: 1,
          answerMessageId: "created-human",
          answeredByUserId: "user-1",
        },
      }),
    });
    await expect(answerRunInput(f.prisma, f.input)).resolves.toBe(false);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
  });

  it("reuses a composer human message without changing its bytes or original run link", async () => {
    const f = ordinaryAnswerFixture();
    const answer = {
      id: "composer-human",
      threadId: "thread-1",
      role: "user",
      botId: null,
      runId: "primary-run",
      blocks: [{ kind: "text" as const, text: "  Paris  " }],
      externalTranscriptFor: null,
    };
    f.rows.push(answer);
    await expect(
      answerWaitingRunWithTextInTransaction(f.tx as never, {
        ...f.input,
        answer: "  Paris  ",
        answerMessageId: answer.id,
      }),
    ).resolves.toBeTruthy();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(answer.runId).toBe("primary-run");
    expect(answer.blocks).toEqual([{ kind: "text", text: "  Paris  " }]);
    expect(f.tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          prompt: "Which city?\nAnswer:   Paris  ",
        },
      }),
    );
    expect(f.tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.choice",
        payload: {
          messageId: "ask-card",
          askIndex: 0,
          answerMessageId: answer.id,
          answeredByUserId: "user-1",
        },
      }),
    });
  });

  it("preserves a custom answer's raw text in the human message", async () => {
    const f = ordinaryAnswerFixture();
    const answer = "  Paris\nwith the local team  ";
    await expect(answerRunInput(f.prisma, { ...f.input, answer })).resolves.toBe(true);
    expect(f.rows.find((row) => row.id === "created-human")?.blocks).toEqual([
      { kind: "text", text: answer },
    ]);
    expect(f.rows[0]?.blocks).toEqual([
      { kind: "ask", text: "Which city?", status: "answered", answer },
    ]);
    expect(f.tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          prompt: `Which city?\nAnswer: ${answer}`,
        },
      }),
    );
  });

  it("rejects a supplied human message whose whitespace differs from its answer", async () => {
    const f = ordinaryAnswerFixture();
    f.rows.push({
      id: "composer-human",
      threadId: "thread-1",
      role: "user",
      botId: null,
      runId: "primary-run",
      blocks: [{ kind: "text", text: "  Paris  " }],
      externalTranscriptFor: null,
    });
    expect(
      await answerWaitingRunWithTextInTransaction(f.tx as never, {
        ...f.input,
        answer: "Paris",
        answerMessageId: "composer-human",
      }),
    ).toBeNull();
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each([" ", "\n\t"])("rejects an ordinary blank-only answer %j", async (answer) => {
    const f = ordinaryAnswerFixture();
    expect(await answerRunInput(f.prisma, { ...f.input, answer })).toBe(false);
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });

  it("preserves earlier raw answers in a background run's resumed prompt", async () => {
    const f = ordinaryAnswerFixture();
    Object.assign(f.run, {
      trigger: "routine",
      task: { prompt: "Original instructions\n\nAnswer: first answer  \n " },
    });
    const answer = " \n  second answer 😀\n ";
    expect(await answerRunInput(f.prisma, { ...f.input, answer })).toBe(true);
    expect(f.tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          prompt: `Original instructions\n\nAnswer: first answer  \n \n\nWhich city?\nAnswer: ${answer}`,
        },
      }),
    );
  });

  it("creates no answer message or proof when the waiting-run claim loses", async () => {
    const f = ordinaryAnswerFixture();
    f.tx.run.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(answerRunInput(f.prisma, f.input)).resolves.toBe(false);
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.message.update).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });

  it.each(["", "missing-message"])(
    "rejects an unavailable supplied answer message %j",
    async (answerMessageId) => {
      const f = ordinaryAnswerFixture();
      await expect(answerRunInput(f.prisma, { ...f.input, answerMessageId })).resolves.toBe(false);
      expect(f.tx.run.updateMany).not.toHaveBeenCalled();
      expect(f.tx.message.create).not.toHaveBeenCalled();
      expect(f.tx.event.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { threadId: "foreign-thread" },
    { role: "bot" },
    { botId: "peer-bot" },
    { externalTranscriptFor: { id: "external-message" } },
    { blocks: [{ kind: "text", text: "Different answer" }] },
    {
      blocks: [
        { kind: "bot_message_received", fromBotId: "peer", fromBotName: "Peer", text: "Paris" },
      ],
    },
  ])("rejects a supplied answer message with invalid native provenance %j", async (invalid) => {
    const f = ordinaryAnswerFixture();
    f.rows.push({
      id: "composer-human",
      threadId: "thread-1",
      role: "user",
      botId: null,
      runId: "primary-run",
      blocks: [{ kind: "text", text: "Paris" }],
      externalTranscriptFor: null,
      ...invalid,
    } as (typeof f.rows)[number]);
    await expect(
      answerRunInput(f.prisma, { ...f.input, answerMessageId: "composer-human" }),
    ).resolves.toBe(false);
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.message.update).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });
});

describe("finalizeRun", () => {
  it("stamps the final steps block with wall-clock run duration", () => {
    const blocks = [
      { kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] },
      { kind: "text" as const, text: "Then I checked it." },
      { kind: "steps" as const, steps: [{ label: "Run tests", count: 1 }] },
    ];

    expect(
      completedRunBlocks(
        blocks,
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T12:01:43.000Z"),
      ),
    ).toEqual([blocks[0], blocks[1], { ...blocks[2], durationMs: 103_000 }]);
    expect(completedRunBlocks(blocks, null, new Date())).toBe(blocks);
  });

  it("retries a transaction conflict without duplicating the terminal event or notification", async () => {
    const conflict = Object.assign(new Error("serialization conflict"), { code: "P2034" });
    const createEvent = vi.fn(async () => ({ threadId: "thread-1", seq: 0 }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: createEvent, deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (operation: (client: typeof tx) => unknown) => operation(tx));
    const publish = vi.fn(async () => undefined);

    await expect(
      finalizeRun(
        { $transaction: transaction } as unknown as PrismaClient,
        {
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 1,
          outcome: "failed",
          error: "failed",
        },
        { publish } as never,
      ),
    ).resolves.toEqual({ continuationRunId: null });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(createEvent).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("resumes a held messaging inbound as a messaging run", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "run-reply" })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "task-reply" })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: {
        findMany: vi.fn(async () => [
          {
            id: "steer-1",
            userId: "user-1",
            originTrigger: "messaging",
            message: {
              id: "message-slack",
              seq: 4,
              blocks: [{ kind: "text", text: "Check the inbox" }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeRun(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "intro-run",
        taskId: "intro-task",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "failed",
        error: "intro failed",
      }),
    ).resolves.toEqual({ continuationRunId: "run-reply" });

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "messaging",
        sourceMessageId: "message-slack",
        status: "queued",
      }),
    });
  });

  it("pins the continuation when every waited message chose the same model", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "run-reply" })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "task-reply" })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: {
        findMany: vi.fn(async () => [
          {
            id: "steer-1",
            userId: "user-1",
            originTrigger: null,
            modelProvider: "openai-compatible",
            modelId: "private-model",
            thinkingLevel: "low",
            message: {
              id: "message-hook",
              seq: 4,
              blocks: [{ kind: "text", text: "Run the routine" }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await finalizeRun(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "routine-run",
      taskId: "routine-task",
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "failed",
      error: "stopped",
    });

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "follow_up",
        sourceMessageId: "message-hook",
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
        modelPinned: true,
      }),
    });
  });

  it("resumes a held group-channel message without taking a later direct message", async () => {
    const channel = {
      kind: "channel_message" as const,
      provider: "slack",
      channelId: "channel-1",
      fromAddress: "U1",
      fromLabel: "Pat",
      text: "What is the status?",
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "run-reply" })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "task-reply" })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: {
        create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      steeringMessage: {
        findMany: vi.fn(async () => [
          {
            id: "steer-channel",
            userId: "user-1",
            originTrigger: "messaging",
            message: { id: "message-channel", seq: 4, blocks: [channel] },
          },
          {
            id: "steer-dm",
            userId: "user-1",
            originTrigger: "messaging",
            message: {
              id: "message-dm",
              seq: 5,
              blocks: [{ kind: "text", text: "And privately?" }],
            },
          },
          {
            id: "steer-app",
            userId: "user-2",
            originTrigger: null,
            message: {
              id: "message-app",
              seq: 6,
              blocks: [{ kind: "text", text: "From the app" }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      message: { findFirst: vi.fn(async () => null) },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeRun(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "routine-run",
        taskId: "routine-task",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "failed",
        error: "routine failed",
      }),
    ).resolves.toEqual({ continuationRunId: "run-reply" });

    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "messaging",
        sourceMessageId: "message-channel",
        userId: "user-1",
        status: "queued",
      }),
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["steer-channel"] }, runId: null },
      data: { runId: "run-reply", claimedAt: null },
    });
  });
});

describe("followThreadEvents", () => {
  it("does not lose a notification that arrives while querying", async () => {
    const fanout = new TestFanout();
    const findMany = vi
      .fn()
      .mockImplementationOnce(async () => {
        await fanout.publish("thread:thread-1", "wake");
        return [];
      })
      .mockResolvedValueOnce([event(0)])
      .mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, fanout, abort.signal, 10_000);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    expect(findMany).toHaveBeenCalledTimes(2);
    abort.abort();
    await stream.return(undefined);
    expect(fanout.unsubscribed).toBe(true);
  });

  it("periodically catches up when a signal is missed", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event(0)]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const abort = new AbortController();
    const stream = followThreadEvents(prisma, "thread-1", -1, undefined, abort.signal, 1);

    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    abort.abort();
    await stream.return(undefined);
  });
});

describe("finalizeComputerControlRelease", () => {
  it("clears the matching lease and appends its release event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          computerId: "computer-1",
          thread: { id: "thread-1" },
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn().mockResolvedValue({
          ...event(7),
          type: "computer.takeover.released",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(
        prisma,
        {
          spaceId: "workspace-1",
          computerId: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          leaseId: "lease-1",
          holder: "none",
          reason: "expired",
        },
        fanout,
      ),
    ).resolves.toEqual({ runId: "run-1" });

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        spaceId: "workspace-1",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
        controlRunId: "run-1",
      },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        status: "waiting_takeover",
      },
      data: { status: "queued", checkpoint: "takeover-skipped" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          runId: "run-1",
          payload: { holder: "none", leaseId: "lease-1", reason: "expired" },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("stamps a takeover checkpoint on a steered running run without clearing its lease", async () => {
    const tx = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          computerId: "computer-1",
          thread: { id: "thread-1" },
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn().mockResolvedValue({
          ...event(7),
          type: "computer.takeover.released",
          payload: { holder: "bot", leaseId: "lease-1", reason: "released" },
        }),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(prisma, {
        spaceId: "workspace-1",
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        leaseId: "lease-1",
        holder: "bot",
        reason: "released",
      }),
    ).resolves.toEqual({ runId: "run-1" });

    expect(tx.run.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "run-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        status: "waiting_takeover",
      },
      data: { status: "queued", checkpoint: "takeover" },
    });
    expect(tx.run.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "run-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        status: { in: ["leased", "running"] },
      },
      data: { checkpoint: "takeover" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.released",
          runId: "run-1",
        }),
      }),
    );
  });

  it("clears the lease even if its controlling bot was deleted", async () => {
    const tx = {
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bot: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      finalizeComputerControlRelease(prisma, {
        spaceId: "workspace-1",
        computerId: "computer-1",
        botId: "deleted-bot",
        runId: null,
        leaseId: "lease-1",
        holder: "none",
        reason: "expired",
      }),
    ).resolves.toEqual({ runId: null });

    expect(tx.computer.updateMany).toHaveBeenCalledOnce();
  });
});

describe("pauseRunForInput", () => {
  function pendingApprovalFixture() {
    const run = {
      id: "run-1",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      status: "running",
      leaseOwner: "worker-1",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      checkpoint: "original-checkpoint",
    };
    const effect = {
      id: "effect-1",
      runId: run.id,
      spaceId: run.spaceId,
      status: "intended",
      request: { draft: "original" },
    };
    const card = {
      id: "message-1",
      threadId: run.threadId,
      runId: run.id,
      botId: run.botId,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Approve the original draft",
          approvalEffectId: effect.id,
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    };
    const attempt = { status: "running" };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: run.threadId }]),
      externalEffect: { findFirst: vi.fn(async () => effect), updateMany: vi.fn() },
      message: {
        findMany: vi.fn(async () => [card]),
        create: vi.fn(async () => ({ id: "new-card" })),
        update: vi.fn(),
      },
      run: {
        updateMany: vi.fn(async ({ where, data }) => {
          if (
            Object.entries(where).some(([key, value]) => {
              if (key === "leaseExpiresAt")
                return run.leaseExpiresAt.getTime() <= (value as { gt: Date }).gt.getTime();
              return run[key as keyof typeof run] !== value;
            })
          )
            return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        }),
        findUnique: vi.fn(async () => run),
      },
      attempt: {
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(attempt, data);
          return { count: 1 };
        }),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 9, nextMessageSeq: 4 })) },
      event: {
        create: vi.fn(async ({ data }) => ({ ...event(data.seq), ...data })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findFirst: vi.fn(async () => null as object | null),
      },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
    const input = {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      attemptId: "attempt-1",
      leaseOwner: "worker-1",
      leaseFence: 3,
      blocks: [] as MessageBlock[],
      existingApprovalEffectId: effect.id,
    };
    return { prisma, tx, run, effect, card, attempt, input };
  }
  it("reuses an original pending approval card and durably pauses its run and attempt", async () => {
    const f = pendingApprovalFixture();
    const original = structuredClone({ card: f.card, effect: f.effect });
    await expect(pauseRunForInput(f.prisma, f.input)).resolves.toBe(true);
    expect(f.run.status).toBe("waiting_input");
    expect(f.attempt.status).toBe("waiting_input");
    expect(f.run.checkpoint).toBe("original-checkpoint");
    expect({ card: f.card, effect: f.effect }).toEqual(original);
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.message.update).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(f.tx.event.create.mock.calls.map(([input]) => input.data.type)).toEqual([
      "run.waiting_input",
    ]);
  });
  it.each([
    "space",
    "thread",
    "bot",
    "effect-run",
    "effect-status",
    "answered",
    "answer-event",
    "lease",
    "card-actions",
  ])("does not reuse a pending approval across the %s boundary", async (boundary) => {
    const f = pendingApprovalFixture();
    if (boundary === "space") f.effect.spaceId = "another-space";
    if (boundary === "thread") f.card.threadId = "another-thread";
    if (boundary === "bot") f.card.botId = "another-bot";
    if (boundary === "effect-run") f.effect.runId = "another-run";
    if (boundary === "effect-status") f.effect.status = "denied";
    if (boundary === "answered") f.card.blocks[0]!.status = "answered";
    if (boundary === "answer-event") f.tx.event.findFirst.mockResolvedValue({ id: "answer" });
    if (boundary === "lease") f.input.leaseFence += 1;
    if (boundary === "card-actions")
      f.card.blocks[0]!.actions = [{ id: "continue", label: "Continue" }];
    await expect(pauseRunForInput(f.prisma, f.input)).resolves.toBe(false);
    expect(f.run.status).toBe("running");
    expect(f.attempt.status).toBe("running");
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.message.update).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });
  it("stores the paused run, prompt, and status event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 4 })
          .mockResolvedValueOnce({ nextEventSeq: 8 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          blocks: [{ kind: "ask", text: "Which city?" }],
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-1",
          runId: "run-1",
          role: "bot",
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
      }),
    );
    expect(tx.event.create.mock.calls.map(([input]) => input.data.type)).toEqual([
      "thread.message.created",
      "run.waiting_input",
    ]);
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });

  it("stores offered choice actions on the run checkpoint for resume", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 4 })
          .mockResolvedValueOnce({ nextEventSeq: 8 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          blocks: [
            {
              kind: "ask",
              text: "Which token?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "use [redacted]" },
                { id: "choice-2", label: "use plain" },
              ],
            },
          ],
          offeredActions: [
            { id: "choice-1", label: "use sk-live-choice-secret" },
            { id: "choice-2", label: "use plain" },
          ],
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "waiting_input",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: JSON.stringify({
            kind: "choice_ask_v1",
            actions: [
              { id: "choice-1", label: "use sk-live-choice-secret" },
              { id: "choice-2", label: "use plain" },
            ],
          }),
        },
      }),
    );
  });
});

describe("pauseRunForTakeover", () => {
  it("stores the paused run, attempt, computer takeover mark, and event in one transaction", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: {
        findFirst: vi.fn().mockResolvedValue({
          controlHolder: "none",
          controlBotId: null,
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 3,
          reason: "Sign in",
          computerId: "computer-1",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running", leaseFence: 3 }),
        data: {
          status: "waiting_takeover",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: null,
        },
      }),
    );
    expect(tx.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "waiting_takeover" }) }),
    );
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1" },
      data: {
        state: "running",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: "run-1",
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "computer.takeover.requested",
          payload: {
            reason: "Sign in",
            takeoverRequested: true,
            retainedControl: false,
          },
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("keeps an active user control lease and only binds controlRunId", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: {
        findFirst: vi.fn().mockResolvedValue({
          controlHolder: "user",
          controlBotId: "bot-1",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: expiresAt,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 3,
        reason: "Sign in",
        computerId: "computer-1",
      }),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1" },
      data: { state: "running", controlRunId: "run-1" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ retainedControl: true, takeoverRequested: true }),
        }),
      }),
    );
  });

  it("preserves another bot's active user lease without binding this run to it", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "computer-1" }]),
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "waiting_takeover" }),
      },
      attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computer: {
        findFirst: vi.fn().mockResolvedValue({
          controlHolder: "user",
          controlBotId: "other-bot",
          controlLeaseId: "lease-other",
          controlLeaseExpiresAt: expiresAt,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      pauseRunForTakeover(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 3,
        reason: "Sign in",
        computerId: "computer-1",
      }),
    ).resolves.toBe(true);

    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", spaceId: "workspace-1" },
      data: { state: "running" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ retainedControl: false, takeoverRequested: true }),
        }),
      }),
    );
  });
});

describe("answerRunInput", () => {
  it("keeps a cancelled run's pending card from answering a new run and rejects repeat answers", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const runs = [
      { id: "run-old", status: "cancelled" },
      { id: "run-new", status: "waiting_input" },
    ].map((run) => ({
      ...run,
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
    }));
    const messages = runs.map((run) => ({
      id: run.id === "run-old" ? "message-old" : "message-new",
      runId: run.id,
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "ask", text: "Which city?", status: "pending" }] as MessageBlock[],
    }));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, string> }) =>
            runs.find((run) =>
              Object.entries(where).every(([key, value]) => Reflect.get(run, key) === value),
            ) ?? null,
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          runs.find((run) => run.id === where.id),
        ),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, string>; data: { status: string } }) => {
            const run = runs.find((row) =>
              Object.entries(where).every(([key, value]) => Reflect.get(row, key) === value),
            );
            if (!run) return { count: 0 };
            Object.assign(run, data);
            return { count: 1 };
          },
        ),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "human-answer" }),
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, string> }) =>
            messages.find((message) =>
              Object.entries(where).every(([key, value]) => Reflect.get(message, key) === value),
            ) ?? null,
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) => {
            const message = messages.find((row) => row.id === where.id)!;
            Object.assign(message, data);
            return message;
          },
        ),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10, nextMessageSeq: 3 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          ...data,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const input = {
      spaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-old",
      messageId: "message-old",
      answeredByUserId: "user-1",
      answer: "Paris",
    };

    await expect(answerRunInput(prisma, input, fanout)).resolves.toBe(false);
    await expect(answerRunInput(prisma, { ...input, runId: "run-new" }, fanout)).resolves.toBe(
      false,
    );
    expect(runs.map((run) => run.status)).toEqual(["cancelled", "waiting_input"]);
    expect(messages.map((message) => message.blocks[0])).toEqual([
      { kind: "ask", text: "Which city?", status: "pending" },
      { kind: "ask", text: "Which city?", status: "pending" },
    ]);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    const current = { ...input, runId: "run-new", messageId: "message-new" };
    await expect(answerRunInput(prisma, current, fanout)).resolves.toBe(true);
    await expect(answerRunInput(prisma, current, fanout)).resolves.toBe(false);
    expect(runs.map((run) => run.status)).toEqual(["cancelled", "queued"]);
    expect(messages[0]!.blocks[0]).toEqual({ kind: "ask", text: "Which city?", status: "pending" });
    expect(messages[1]!.blocks[0]).toEqual({
      kind: "ask",
      text: "Which city?",
      status: "answered",
      answer: "Paris",
    });
    expect(tx.run.updateMany).toHaveBeenCalledOnce();
    expect(tx.message.update).toHaveBeenCalledOnce();
    expect(tx.task.updateMany).toHaveBeenCalledOnce();
    expect(tx.event.create).toHaveBeenCalledTimes(3);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.message.updated",
        runId: "run-new",
        payload: expect.objectContaining({ messageId: "message-new" }),
      }),
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("answers only the selected pending prompt and publishes its update", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-test", sinks: [sink] }));
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    publish.mockRejectedValueOnce(new Error("realtime unavailable"));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        create: vi.fn().mockResolvedValue({ id: "human-answer" }),
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Paris" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10, nextMessageSeq: 3 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "choice-2",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "waiting_input" }),
        data: { status: "queued", checkpoint: null },
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "choice-2",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Paris" },
            ],
          },
        ],
      },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: "Which city?\nAnswer: Selected choice choice-2: Paris",
      },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.updated", botId: "bot-2" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 9 }));
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "error",
        message: "thread.realtime.publish.failed",
        threadId: "thread-1",
        cursor: 9,
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("Paris");
  });

  it.each(["routine", "user"])(
    "keeps one %s goal and each raw answer across two resumes",
    async (trigger) => {
      const answerChoice = async (prompt: string, question: string, answer: string) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
          message: {
            create: vi.fn().mockResolvedValue({ id: "human-answer" }),
            findFirst: vi.fn().mockResolvedValue({
              id: "message-1",
              blocks: [
                {
                  kind: "ask",
                  text: question,
                  status: "pending",
                  actions: [
                    { id: "choice-1", label: "Two people" },
                    { id: "choice-2", label: "Italian" },
                  ],
                },
              ],
            }),
            update: vi.fn().mockResolvedValue({ id: "message-1" }),
          },
          run: {
            findFirst: vi.fn().mockResolvedValue({
              botId: "bot-2",
              trigger,
              task: { prompt },
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            findUnique: vi.fn().mockResolvedValue({
              status: "queued",
              createdAt: new Date("2026-08-16T12:00:00.000Z"),
              threadId: "thread-1",
            }),
          },
          task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10, nextMessageSeq: 3 }) },
          event: {
            create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
              ...event(data.seq),
              type: data.type,
            })),
            findFirst: vi.fn().mockResolvedValue(null),
          },
        };
        const prisma = {
          $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        } as unknown as PrismaClient;
        await expect(
          answerRunInput(prisma, {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer,
          }),
        ).resolves.toBe(true);
        return (tx.task.updateMany.mock.calls[0]![0] as { data: { prompt: string } }).data.prompt;
      };

      const goal = "Plan tonight's dinner, then stop.";
      const first = " \r\n  Two people 😀  ";
      const second = "  Italian dishes\n  ";
      const afterFirst = await answerChoice(goal, "Who is eating?", first);
      expect(afterFirst).toBe(`${goal}\n\nWho is eating?\nAnswer: ${first}`);
      const afterSecond = await answerChoice(afterFirst, "Which cuisine?", second);
      expect(afterSecond).toBe(
        [goal, `Who is eating?\nAnswer: ${first}`, `Which cuisine?\nAnswer: ${second}`].join(
          "\n\n",
        ),
      );
      for (const text of [goal, first, second, "Who is eating?", "Which cuisine?"])
        expect(afterSecond.split(text)).toHaveLength(2);
    },
  );

  it("records a spoken call answer as a user utterance with the call identity", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
        }),
        create: vi.fn().mockResolvedValue({ id: "user-answer" }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          startedAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 5 }) },
      event: {
        create: vi.fn(
          async ({ data }: { data: { seq: number; type: string; payload: unknown } }) => ({
            ...event(data.seq),
            type: data.type,
            payload: data.payload,
          }),
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "Toronto",
          clientNonce: "call:call-1:answer-1",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "thread-1",
        role: "user",
        botId: undefined,
        runId: "run-1",
        clientNonce: "call:call-1:answer-1",
        blocks: [{ kind: "text", text: "Toronto" }],
      }),
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({
            messageId: "user-answer",
            role: "user",
            callId: "call-1",
          }),
        }),
      }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: "Which city?\nAnswer: Toronto",
      },
    });
  });

  it.each([undefined, "call:call-1:choice-1"])(
    "resumes with the full offered choice label (call nonce: %s)",
    async (clientNonce) => {
      const fanout = new TestFanout();
      const secret = "sk-live-choice-secret";
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: "Which token?",
                status: "pending",
                actions: [
                  { id: "choice-1", label: `use [redacted]` },
                  { id: "choice-2", label: "use plain" },
                ],
              },
            ],
          }),
          create: vi.fn().mockResolvedValue({ id: "spoken-choice" }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({
            botId: "bot-2",
            userId: "user-1",
            checkpoint: JSON.stringify({
              kind: "choice_ask_v1",
              actions: [
                { id: "choice-1", label: `use ${secret}` },
                { id: "choice-2", label: "use plain" },
              ],
            }),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            status: "queued",
            createdAt: new Date("2026-08-16T12:00:00.000Z"),
            threadId: "thread-1",
          }),
        },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 11 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;

      await expect(
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer: "choice-1",
            clientNonce,
          },
          fanout,
        ),
      ).resolves.toBe(true);

      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-1" } } },
        data: {
          prompt: `Which token?\nAnswer: Selected choice choice-1: use ${secret}`,
        },
      });
      expect(tx.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: "user",
          botId: undefined,
          runId: "run-1",
          clientNonce,
          blocks: [{ kind: "text", text: "use [redacted]" }],
        }),
      });
      expect(tx.message.update).toHaveBeenCalledWith({
        where: { id: "message-1" },
        data: {
          blocks: [
            {
              kind: "ask",
              text: "Which token?",
              status: "answered",
              answer: "choice-1",
              actions: [
                { id: "choice-1", label: "use [redacted]" },
                { id: "choice-2", label: "use plain" },
              ],
            },
          ],
        },
      });
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "queued", checkpoint: null },
        }),
      );
    },
  );

  it("answers a custom free-text reply that is not an offered choice", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        create: vi.fn().mockResolvedValue({ id: "human-answer" }),
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Seoul" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 12, nextMessageSeq: 3 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "Toronto",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", checkpoint: null },
      }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: "Which city?\nAnswer: Toronto",
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "Toronto",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Seoul" },
            ],
          },
        ],
      },
    });
  });

  it("treats a typed choice label as selecting that option", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        create: vi.fn().mockResolvedValue({ id: "human-answer" }),
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Seoul" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          status: "queued",
          createdAt: new Date("2026-08-16T12:00:00.000Z"),
          threadId: "thread-1",
        }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 13, nextMessageSeq: 3 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "Seoul",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: "Which city?\nAnswer: Selected choice choice-2: Seoul",
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which city?",
            status: "answered",
            answer: "choice-2",
            actions: [
              { id: "choice-1", label: "Berlin" },
              { id: "choice-2", label: "Seoul" },
            ],
          },
        ],
      },
    });
  });
});

describe("answerWaitingRunWithTextInTransaction", () => {
  it("answers a pending question ask with composer text", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        create: vi.fn().mockResolvedValue({ id: "human-answer" }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message-1",
            blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-2", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 4, nextMessageSeq: 3 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };

    await expect(
      answerWaitingRunWithTextInTransaction(tx as never, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        answeredByUserId: "user-1",
        answer: "Paris",
      }),
    ).resolves.toMatchObject({ threadId: "thread-1" });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-1" } } },
      data: {
        prompt: "Which city?\nAnswer: Paris",
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued" },
      }),
    );
  });

  it("leaves approval and secret cards on the dedicated answer path", async () => {
    const tx = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message-1",
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
      },
      run: { findFirst: vi.fn(), updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
    };

    await expect(
      answerWaitingRunWithTextInTransaction(tx as never, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        answeredByUserId: "user-1",
        answer: "allow",
      }),
    ).resolves.toBeNull();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("answerRunInput", () => {
  it("approves consequential actions without overwriting the task prompt", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
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
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({
          id: "effect-1",
          status: "intended",
          request: persistedApprovalRequest,
        }),
        update: vi.fn().mockResolvedValue({ id: "effect-1" }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "allow",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.findFirst).toHaveBeenCalledWith({
      where: {
        id: "effect-1",
        spaceId: "workspace-1",
        runId: "run-1",
        status: "intended",
      },
    });
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved" },
    });
    expect(tx.event.create.mock.calls.map(([input]) => input.data.type)).not.toContain(
      "thread.choice",
    );
  });

  it("approves and upserts always-allow without overwriting the task prompt", async () => {
    const fanout = new TestFanout();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "always", label: "Always allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ userId: "user-1", status: "queued" }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({
          id: "effect-1",
          status: "intended",
          kind: "destination.write",
          request: persistedApprovalRequest,
        }),
        update: vi.fn().mockResolvedValue({ id: "effect-1" }),
      },
      actionApprovalRule: {
        upsert: vi.fn().mockResolvedValue({ id: "rule-1" }),
      },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "always",
        },
        fanout,
      ),
    ).resolves.toBe(true);

    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved" },
    });
    expect(tx.actionApprovalRule.upsert).toHaveBeenCalledWith({
      where: {
        spaceId_createdByUserId_effect_matchKind_matchValue: {
          spaceId: "workspace-1",
          createdByUserId: "user-1",
          effect: "always_allow",
          matchKind: "tool",
          matchValue: "destination.write",
        },
      },
      create: {
        spaceId: "workspace-1",
        createdByUserId: "user-1",
        effect: "always_allow",
        matchKind: "tool",
        matchValue: "destination.write",
      },
      update: {},
    });
  });

  it("does not let another workspace member create an always-allow rule for the run owner", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "effect-1",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "always", label: "Always allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "run-owner" }),
        findUnique: vi.fn().mockResolvedValue({ userId: "run-owner" }),
        updateMany: vi.fn(),
      },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue({
          id: "effect-1",
          status: "intended",
          kind: "destination.write",
          request: persistedApprovalRequest,
        }),
      },
      actionApprovalRule: { upsert: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "other-member",
        answer: "always",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.actionApprovalRule.upsert).not.toHaveBeenCalled();
  });

  it("does not queue a run when an approval card has no matching effect", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: "missing-effect",
              text: "Review before writing",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "allow",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("does not queue a run for an action that the approval card did not offer", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
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
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
      externalEffect: { findFirst: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "always",
      }),
    ).resolves.toBe(false);
    expect(tx.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an already answered prompt without queuing the run", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [{ kind: "ask", text: "Which city?", status: "answered", answer: "Paris" }],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "Rome",
      }),
    ).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } },
  ])("stores secret asks without writing plaintext to the task prompt (%j)", async (credential) => {
    const fanout = new TestFanout();
    const store = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your code",
              input: "secret",
              purpose: "api_key",
              ...(credential ? { credential } : {}),
              status: "pending",
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn() },
      externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "123456",
        },
        fanout,
        { store },
      ),
    ).resolves.toBe(true);

    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        plaintext: "123456",
        botId: "bot-1",
        userId: "user-1",
        spaceId: "workspace-1",
        credential,
      }),
    );
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(tx.event.create.mock.calls)).not.toContain("123456");
    expect(tx.event.create.mock.calls.map(([input]) => input.data.type)).not.toContain(
      "thread.choice",
    );
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        spaceId: "workspace-1",
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(credential ? { result: { credentialSaved: credential } } : {}),
      },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Enter your code",
            input: "secret",
            purpose: "api_key",
            ...(credential ? { credential } : {}),
            status: "answered",
            answer: "",
          },
        ],
      },
    });
  });

  it("does not let another workspace member save a credential as the run owner", async () => {
    const store = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "owner" }),
        updateMany: vi.fn(),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "API key",
              input: "secret",
              status: "pending",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          ],
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    expect(
      await answerRunInput(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "other-member",
          answer: "fake-key",
        },
        new TestFanout(),
        { store },
      ),
    ).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  describe("login cards", () => {
    const login = {
      name: "site_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    };
    function loginFixture(credential: object = login) {
      const store = vi.fn().mockResolvedValue(undefined);
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: "message-1",
            blocks: [
              {
                kind: "ask",
                text: "Sign in",
                input: "secret",
                purpose: "password",
                credential,
                status: "pending",
              },
            ],
          }),
          update: vi.fn().mockResolvedValue({ id: "message-1" }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        task: { updateMany: vi.fn() },
        externalEffect: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 10 }) },
        event: {
          create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
            ...event(data.seq),
            type: data.type,
          })),
        },
      };
      const prisma = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const answer = (username?: string, password = "fake-password-1") =>
        answerRunInput(
          prisma,
          {
            spaceId: "workspace-1",
            threadId: "thread-1",
            runId: "run-1",
            messageId: "message-1",
            answeredByUserId: "user-1",
            answer: password,
            ...(username !== undefined ? { username } : {}),
          },
          new TestFanout(),
          { store },
        );
      return { store, tx, answer };
    }

    it("stores the username and password together and records neither", async () => {
      const { store, tx, answer } = loginFixture();
      await expect(answer("  fake-user@example.test ")).resolves.toBe(true);
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: login,
          plaintext: encodeLoginSecret({
            username: "fake-user@example.test",
            password: "fake-password-1",
          }),
        }),
      );
      const recorded = JSON.stringify([tx.event.create.mock.calls, tx.message.update.mock.calls]);
      expect(recorded).not.toContain("fake-user@example.test");
      expect(recorded).not.toContain("fake-password-1");
    });

    it.each(["", "   "])("requires a username (%j)", async (username) => {
      const { store, tx, answer } = loginFixture();
      await expect(answer(username)).resolves.toBe(false);
      await expect(answer()).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(tx.run.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an oversized password before queueing, not with an internal error", async () => {
      const { store, tx, answer } = loginFixture();
      await expect(answer("fake-user", "x".repeat(4097))).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(tx.run.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a username on a card that is not a login", async () => {
      const { store, answer } = loginFixture({ ...login, auth: { type: "bearer" } });
      await expect(answer("fake-user")).resolves.toBe(false);
      expect(store).not.toHaveBeenCalled();
    });
  });

  it("rejects secret asks when no run secret writer is configured", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: "message-1",
          blocks: [
            {
              kind: "ask",
              text: "Enter your code",
              input: "secret",
              status: "pending",
            },
          ],
        }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1", userId: "user-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      answerRunInput(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "123456",
      }),
    ).resolves.toBe(false);

    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("sendUserMessage", () => {
  function routineDeliveryFixture(admitted = true) {
    const tx = {
      $queryRaw: vi.fn(),
      thread: {
        findFirst: vi.fn().mockResolvedValue({ id: "crew-1" }),
        update: vi.fn().mockResolvedValue({ nextMessageSeq: 5, nextEventSeq: 9 }),
      },
      routine: {
        updateMany: vi.fn().mockResolvedValue({ count: admitted ? 1 : 0 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          modelProvider: "openai-compatible",
          modelId: "saved-model",
          thinkingLevel: "high",
        }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findMany: vi.fn().mockResolvedValue([{ id: "chat-run", trigger: "user" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue(event(8)) },
    };
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const input = {
      spaceId: "workspace-1",
      threadId: "crew-1",
      botId: "bot-1",
      userId: "owner-1",
      blocks: [{ kind: "text" as const, text: "Review the event" }],
      prompt: "Review the event",
      trigger: "webhook" as const,
      clientNonce: "webhook:bot-1:event-1:routine:routine-1",
      routineEvent: {
        routineId: "routine-1",
        source: "webhook" as const,
        webhookSecretId: "secret-1",
      },
    };
    return { tx, prisma, input };
  }

  it("persists authored candidate feedback in the native message transaction and rejects stale metadata before steering", async () => {
    const { tx, prisma, input } = routineDeliveryFixture();
    const owner = { spaceId: input.spaceId, userId: input.userId };
    tx.thread.findFirst.mockResolvedValue({
      ...owner,
      id: input.threadId,
      botId: input.botId,
      activeRecruitingRoleId: "role",
    } as never);
    Object.assign(tx, {
      bot: { findFirst: vi.fn(async () => owner) },
      recruitingRole: {
        findFirst: vi.fn(async () => ({
          ...owner,
          id: "role",
          sourceThreadId: input.threadId,
          revision: 1,
          currentRevisionId: "revision",
        })),
      },
      recruitingCandidate: { findMany: vi.fn(async () => [{ candidateKey: "candidate" }]) },
    });
    const recruitingFeedback = {
      roleId: "role",
      roleRevisionId: "revision",
      expectedRoleRevision: 1,
      candidateKeys: ["candidate"],
      choice: "not_fit" as const,
    };
    const feedback = {
      ...input,
      routineEvent: undefined,
      trigger: "follow_up" as const,
      blocks: [
        { kind: "text" as const, text: "Not a fit: no systems ownership", recruitingFeedback },
      ],
    };
    await sendUserMessage(prisma as unknown as PrismaClient, feedback);
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ blocks: feedback.blocks }) }),
    );
    tx.steeringMessage.create.mockClear();
    await expect(
      sendUserMessage(prisma as unknown as PrismaClient, {
        ...feedback,
        blocks: [
          {
            ...feedback.blocks[0]!,
            recruitingFeedback: { ...recruitingFeedback, expectedRoleRevision: 2 },
          },
        ],
      }),
    ).rejects.toThrow("Recruiting revision changed");
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  it("atomically admits an event routine and attributes a distinct run even while chat is busy", async () => {
    const { tx, prisma, input } = routineDeliveryFixture();
    await sendUserMessage(prisma as unknown as PrismaClient, {
      ...input,
      modelPin: { modelProvider: "stale-provider", modelId: "stale-model", thinkingLevel: "low" },
    });
    expect(tx.routine.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "routine-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        userId: "owner-1",
        active: true,
        webhookEnabled: true,
        bot: expect.objectContaining({ archivedAt: null, webhookSecretId: "secret-1" }),
        OR: [{ threadId: "crew-1" }, { threadId: null, bot: { thread: { id: "crew-1" } } }],
      }),
      data: { lastRunAt: expect.any(Date) },
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        routineId: "routine-1",
        userId: "owner-1",
        threadId: "crew-1",
        trigger: "webhook",
        modelProvider: "openai-compatible",
        modelId: "saved-model",
        thinkingLevel: "high",
        modelPinned: true,
      }),
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.thread.findFirst).toHaveBeenCalledWith({
      where: {
        id: "crew-1",
        spaceId: "workspace-1",
        userId: "owner-1",
        OR: [
          { botId: "bot-1" },
          { group: { archivedAt: null, members: { some: { botId: "bot-1" } } } },
          { externalConversation: { botId: "bot-1", spaceId: "workspace-1", userId: "owner-1" } },
        ],
      },
      select: { id: true },
    });
  });

  it.each(["github", "messaging"] as const)(
    "rechecks the exact %s source at durable admission",
    async (source) => {
      const { tx, prisma, input } = routineDeliveryFixture();
      await sendUserMessage(prisma as unknown as PrismaClient, {
        ...input,
        routineEvent: { ...input.routineEvent, source, provider: "slack" },
      });
      const where = tx.routine.updateMany.mock.calls[0]?.[0].where;
      expect(where).toMatchObject(
        source === "github" ? { githubEnabled: true } : { messageProvider: "slack" },
      );
      if (source === "messaging") expect(where.bot).not.toHaveProperty("webhookSecretId");
      else expect(where.bot).toHaveProperty("webhookSecretId", "secret-1");
    },
  );

  it("keeps a message routine in its owned native external conversation", async () => {
    const { tx, prisma, input } = routineDeliveryFixture();
    tx.thread.findFirst.mockImplementation(
      async ({
        where,
      }: {
        where: {
          OR: Array<{ externalConversation?: { botId: string; spaceId: string; userId: string } }>;
        };
      }) =>
        where.OR.some(
          (target) =>
            target.externalConversation?.botId === input.botId &&
            target.externalConversation.spaceId === input.spaceId &&
            target.externalConversation.userId === input.userId,
        )
          ? { id: input.threadId }
          : null,
    );
    await sendUserMessage(prisma as unknown as PrismaClient, {
      ...input,
      routineEvent: { routineId: "routine-1", source: "messaging", provider: "slack" },
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: input.threadId, routineId: "routine-1" }),
    });
    expect(tx.routine.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: [{ threadId: input.threadId }, { threadId: null }] }),
      data: { lastRunAt: expect.any(Date) },
    });
  });

  it("rejects a paused, revoked or changed event routine before writing history", async () => {
    const { tx, prisma, input } = routineDeliveryFixture(false);
    await expect(sendUserMessage(prisma as unknown as PrismaClient, input)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("rejects a stale saved room instead of redirecting to the bot's room", async () => {
    const { tx, prisma, input } = routineDeliveryFixture();
    tx.thread.findFirst.mockResolvedValue(null);
    await expect(sendUserMessage(prisma as unknown as PrismaClient, input)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
  });

  it("replays the persisted event receipt without advancing lastRunAt or creating another run", async () => {
    const { tx, prisma, input } = routineDeliveryFixture();
    prisma.message.findFirst.mockResolvedValue({
      id: "message-1",
      seq: 4,
      threadId: "old-crew",
      sourceRuns: [{ id: "run-1", taskId: "task-1" }],
    });
    await expect(sendUserMessage(prisma as unknown as PrismaClient, input)).resolves.toEqual({
      messageId: "message-1",
      seq: 4,
      taskId: "task-1",
      runId: "run-1",
      replayed: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientNonce: input.clientNonce,
          sourceRuns: {
            some: {
              routineId: "routine-1",
              spaceId: "workspace-1",
              botId: "bot-1",
              userId: "owner-1",
            },
          },
        },
      }),
    );
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
  });

  it("rechecks a raced receipt under the routine lock before updating lastRunAt", async () => {
    const { tx, prisma, input } = routineDeliveryFixture();
    tx.message.findFirst.mockResolvedValue({
      id: "old-message",
      seq: 2,
      sourceRuns: [{ id: "old-run", taskId: "old-task" }],
    });
    await expect(sendUserMessage(prisma as unknown as PrismaClient, input)).resolves.toMatchObject({
      messageId: "old-message",
      runId: "old-run",
      replayed: true,
    });
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("creates the message, run, and event in one transaction and publishes once", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
          runId: "run-1",
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          userId: "user-1",
          blocks: [{ kind: "text", text: "hello" }],
          prompt: "hello",
          trigger: "user",
          clientNonce: "nonce-1",
          linkMessageToRun: true,
        },
        fanout,
      ),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: "task-1", runId: "run-1" });

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "user",
          clientNonce: "send:message-1",
          sourceMessageId: "message-1",
        }),
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-1" },
    });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.created", runId: "run-1" }),
      }),
    );
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 8 }));
  });

  it("pins an agreed inbound model onto the run it creates", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
          runId: "run-1",
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendUserMessage(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "ping" }],
      prompt: "ping",
      trigger: "webhook",
      modelPin: {
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
      },
    });

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "webhook",
          modelProvider: "openai-compatible",
          modelId: "private-model",
          thinkingLevel: "low",
          modelPinned: true,
        }),
      }),
    );
  });

  it("persists steering instead of starting a parallel run when the bot is busy", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-0", taskId: "task-0", trigger: "user" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "follow_up",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-0" });

    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { runId: "run-0" },
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: "run-0" },
    });
  });

  it("keeps an agreed inbound model on steering while a routine run is busy", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-routine", taskId: "task-routine", trigger: "routine" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await sendUserMessage(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "ping" }],
      prompt: "ping",
      trigger: "webhook",
      modelPin: {
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
      },
    });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: null,
        modelProvider: "openai-compatible",
        modelId: "private-model",
        thinkingLevel: "low",
      },
    });
  });

  it("keeps an inbound message pending while the creation intro is active", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "intro-run", taskId: "intro-task", trigger: "created" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "Check the inbox" }],
        prompt: "Check the inbox",
        trigger: "user",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "intro-run" });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: null },
    });
  });

  it("keeps a messaging inbound's origin on the hold behind the creation intro", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn(),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "intro-run", taskId: "intro-task", trigger: "created" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date() }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "Check the inbox" }],
        prompt: "Check the inbox",
        trigger: "messaging",
        clientNonce: "messaging:slack:handle-1",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "intro-run" });

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: null,
        originTrigger: "messaging",
      },
    });
  });

  it("keeps the message pending when the busy run is a routine turn", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-routine", taskId: "task-routine", trigger: "routine" }]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "messaging",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-routine" });

    expect(tx.run.create).not.toHaveBeenCalled();
    // No run on the steering row: the routine never claims it; its continuation does.
    // The inbound stays messaging so that continuation is mirrored back to the app.
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: "message-1",
        botId: "bot-1",
        userId: "user-1",
        runId: null,
        originTrigger: "messaging",
      },
    });
  });

  it("steers the conversational run when a parallel webhook turn is also active", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 5 })
          .mockResolvedValueOnce({ nextEventSeq: 9 }),
      },
      message: {
        create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
        update: vi.fn().mockResolvedValue({ id: "message-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-webhook", taskId: "task-webhook", trigger: "webhook" },
          { id: "run-user", taskId: "task-user", trigger: "user" },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "running" }),
        create: vi.fn(),
      },
      event: {
        create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
          ...event(data.seq),
          type: data.type,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      sendUserMessage(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "messaging",
      }),
    ).resolves.toEqual({ messageId: "message-1", seq: 4, taskId: null, runId: "run-user" });

    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "message-1", botId: "bot-1", userId: "user-1", runId: "run-user" },
    });
  });
});

describe("claimSteering", () => {
  it("claims pending messages for the fenced run in message order", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "run-1", spaceId: "space-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: null }),
      },
      thread: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ nextMessageSeq: 7 }),
        update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }),
      },
      event: { create: vi.fn() },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "steer-1",
            messageId: "message-1",
            message: {
              seq: 5,
              blocks: [
                { kind: "text", text: "First" },
                {
                  kind: "image",
                  artifactId: "artifact-1",
                  name: "chart.png",
                  mimeType: "image/png",
                },
              ],
            },
          },
          {
            id: "steer-2",
            messageId: "message-2",
            message: { seq: 6, blocks: [{ kind: "text", text: "Second" }] },
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        leaseOwner: "worker-1",
        leaseFence: 2,
        seenIds: [],
      }),
    ).resolves.toEqual([
      {
        id: "steer-1",
        messageId: "message-1",
        text: "First\n[image: chart.png]",
        blocks: [
          { kind: "text", text: "First" },
          {
            kind: "image",
            artifactId: "artifact-1",
            name: "chart.png",
            mimeType: "image/png",
          },
        ],
      },
      {
        id: "steer-2",
        messageId: "message-2",
        text: "Second",
        blocks: [{ kind: "text", text: "Second" }],
      },
    ]);
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseOwner: "worker-1", leaseFence: 2 }),
      }),
    );
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.steering.claimed",
        payload: { steeringIds: ["steer-1", "steer-2"], nextMessageSeq: 7 },
      }),
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["steer-1", "steer-2"] }, claimedAt: null },
      data: { runId: "run-1", claimedAt: expect.any(Date) },
    });
  });

  it("does not claim steering into a tool-free creation intro", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: { findFirst: vi.fn().mockResolvedValue({ id: "intro-run", trigger: "created" }) },
      steeringMessage: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "intro-run",
        leaseOwner: "worker-1",
        leaseFence: 2,
        seenIds: [],
      }),
    ).resolves.toEqual([]);
    expect(tx.steeringMessage.findMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
  });

  it("leaves pending user messages alone while a routine turn is running", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: { findFirst: vi.fn().mockResolvedValue({ id: "run-routine", trigger: "routine" }) },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimSteering(prisma, {
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-routine",
        leaseOwner: "worker-1",
        leaseFence: 1,
        seenIds: [],
      }),
    ).resolves.toEqual([]);
    // Only steering addressed to this run; unassigned (pending) rows wait for the continuation.
    expect(tx.steeringMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ runId: "run-routine" }] }),
      }),
    );
  });

  it("leaves channel and in-app pending rows for a direct-message run", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: {
        findFirst: vi.fn().mockResolvedValue({
          id: "run-dm",
          trigger: "messaging",
          sourceMessage: { blocks: [{ kind: "text", text: "And privately?" }] },
        }),
      },
      steeringMessage: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await claimSteering(prisma, {
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-dm",
      leaseOwner: "worker-1",
      leaseFence: 1,
      seenIds: [],
    });

    expect(tx.steeringMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ runId: null, originTrigger: "messaging" }, { runId: "run-dm" }],
          message: {
            threadId: "thread-1",
            NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } },
          },
        }),
      }),
    );
  });
});

describe("clearThread", () => {
  it("releases the computer execution lease without dropping the computer", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 42, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(prisma, { spaceId: "workspace-1", threadId: "thread-1", botId: "bot-1" }, fanout),
    ).resolves.toMatchObject({
      event: { type: "thread.cleared" },
      cancelledRunIds: ["run-1"],
    });
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    // Every deleted message counts as compacted, so compaction cannot summarize cleared history.
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        historyCompactedUpToSeq: 41,
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 0 }));
  });

  it("scopes group clear lease cleanup to cancelled run ids", async () => {
    const fanout = new TestFanout();
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 3, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "group-run-1", taskId: "task-1" },
          { id: "group-run-2", taskId: "task-2" },
        ]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: { updateMany: vi.fn() },
      computer: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          ...event(0),
          type: "thread.cleared",
        }),
      },
      chatGroup: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      clearThread(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-group",
          botId: "bot-1",
          groupId: "group-1",
        },
        fanout,
      ),
    ).resolves.toMatchObject({ cancelledRunIds: ["group-run-1", "group-run-2"] });

    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-group",
          spaceId: "workspace-1",
        }),
      }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["group-run-1", "group-run-2"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(tx.computer.updateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["group-run-1", "group-run-2"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(tx.computerExecutionLease.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ botId: expect.anything() }) }),
    );
  });
});

describe("appendEvent", () => {
  function appendFixture() {
    let nextEventSeq = 0;
    const tx = {
      thread: { update: vi.fn(async () => ({ nextEventSeq: ++nextEventSeq })) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> & { seq: number } }) => ({
          ...event(data.seq),
          ...data,
        })),
      },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );
    return { tx, transaction, prisma: { $transaction: transaction } as unknown as PrismaClient };
  }

  const progress = {
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    type: "thread.progress" as const,
    payload: {},
  };

  it("admits only one transaction for twelve concurrent appends in one client and thread", async () => {
    const f = appendFixture();
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    f.transaction.mockImplementation(async (callback) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await blocked;
        return await callback(f.tx);
      } finally {
        active -= 1;
      }
    });
    const writes = Array.from({ length: 12 }, (_, index) =>
      appendEvent(f.prisma, { ...progress, payload: { index } }, fanout),
    );
    try {
      await Promise.resolve();
      expect(f.transaction).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all(writes);
    }
    expect(maximum).toBe(1);
    expect((await Promise.all(writes)).map((item) => item.payload)).toEqual(
      Array.from({ length: 12 }, (_, index) => ({ index })),
    );
    expect(publish.mock.calls).toEqual(
      Array.from({ length: 12 }, (_, cursor) => ["thread:thread-1", JSON.stringify({ cursor })]),
    );
  });

  it("lets queued and later appends continue after a transaction rejects", async () => {
    const f = appendFixture();
    const failure = new Error("Transaction rejected");
    f.transaction.mockRejectedValueOnce(failure);
    const first = expect(appendEvent(f.prisma, progress)).rejects.toBe(failure);
    const second = appendEvent(f.prisma, progress);
    await first;
    await expect(second).resolves.toMatchObject({ seq: 0 });
    await expect(appendEvent(f.prisma, progress)).resolves.toMatchObject({ seq: 1 });
    expect(f.transaction).toHaveBeenCalledTimes(3);
  });

  it("keeps other threads and clients moving while one thread transaction is blocked", async () => {
    const first = appendFixture();
    const otherClient = appendFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.transaction.mockImplementationOnce(async (callback) => {
      await blocked;
      return callback(first.tx);
    });
    let firstFinished = false;
    const pending = appendEvent(first.prisma, progress).then(() => {
      firstFinished = true;
    });
    const independent = Promise.all([
      appendEvent(first.prisma, { ...progress, threadId: "other-thread" }),
      appendEvent(otherClient.prisma, progress),
    ]);
    let independentFinished = false;
    void independent.then(() => {
      independentFinished = true;
    });
    try {
      await vi.waitFor(() => expect(independentFinished).toBe(true));
      expect(firstFinished).toBe(false);
    } finally {
      release();
      await Promise.all([pending, independent]);
    }
  });

  it("does not persist output from a cancelled run after history was cleared", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }) },
      event: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-1",
          payload: { text: "stale" },
        },
        fanout,
      ),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reruns the whole transaction after a mid-write deadlock and publishes once", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const created = { ...event(4), type: "thread.progress", runId: "run-1" };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
      event: { create: vi.fn().mockRejectedValueOnce(deadlock).mockResolvedValue(created) },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      appendEvent(
        { $transaction: transaction } as unknown as PrismaClient,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-1",
          payload: { text: "progress" },
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "thread.progress", runId: "run-1" });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.event.create).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not retry a run that can no longer write history", async () => {
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 5 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }) },
      event: { create: vi.fn() },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      appendEvent({ $transaction: transaction } as unknown as PrismaClient, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "thread.progress",
        runId: "run-1",
        payload: { text: "stale" },
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("lets a new active run write after the thread was cleared", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const created = {
      ...event(8),
      type: "thread.progress",
      runId: "run-2",
    };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 9 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-2",
          payload: { text: "fresh" },
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "thread.progress", runId: "run-2" });
    expect(tx.event.create).toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it("does not persist a split-emoji high surrogate that would crash JSON insert", async () => {
    const fanout = new TestFanout();
    const created = {
      ...event(3),
      type: "thread.progress",
      runId: "run-3",
      payload: { delta: "hello \uFFFD", streaming: true },
    };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 4 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    // Orphaned UTF-16 high surrogate (e.g. 😀 split across stream chunks as \uD83D alone).
    const orphanedHigh = "hello \uD83D";
    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "thread.progress",
          runId: "run-3",
          payload: { delta: orphanedHigh, streaming: true },
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "thread.progress", runId: "run-3" });

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: { delta: "hello \uFFFD", streaming: true },
      }),
    });
    const persisted = tx.event.create.mock.calls[0]![0].data.payload as { delta: string };
    // Postgres rejects unpaired surrogates in json; the sanitized form must not contain any.
    expect(persisted.delta).not.toMatch(/[\uD800-\uDFFF]/);
    expect(() => JSON.stringify(persisted)).not.toThrow();
  });

  it("persists run.cancelled for a run that is already cancelled", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const created = { ...event(7), type: "run.cancelled", runId: "run-1" };
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "cancelled" }) },
      event: { create: vi.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(
        prisma,
        {
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          type: "run.cancelled",
          runId: "run-1",
          payload: {},
        },
        fanout,
      ),
    ).resolves.toMatchObject({ type: "run.cancelled", runId: "run-1" });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "run.cancelled", runId: "run-1", seq: 7 }),
    });
    expect(publish).toHaveBeenCalledWith("thread:thread-1", JSON.stringify({ cursor: 7 }));
  });

  it("rejects run.cancelled while the run is not cancelled", async () => {
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "run.cancelled",
        runId: "run-1",
        payload: {},
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("rejects run.cancelled without a run", async () => {
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 8 }) },
      run: { findUnique: vi.fn() },
      event: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      appendEvent(prisma, {
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "run.cancelled",
        payload: {},
      }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(tx.run.findUnique).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });
});

describe("discardAnsweredSteering", () => {
  function client(reply: { seq: number } | null, payloads: unknown[] = []) {
    return {
      message: { findFirst: vi.fn().mockResolvedValue(reply) },
      event: { findMany: vi.fn().mockResolvedValue(payloads.map((payload) => ({ payload }))) },
      steeringMessage: { deleteMany: vi.fn() },
    };
  }

  it("requires a text reply and a durable claim watermark", async () => {
    const tx = client(null);
    await discardAnsweredSteering(tx as never, { threadId: "thread-1", runId: "run-1" });
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: expect.arrayContaining([
            { blocks: { array_contains: [{ kind: "ask" }] } },
            { blocks: { array_contains: [{ kind: "steps" }] } },
          ]),
        }),
      }),
    );
    expect(tx.event.findMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.deleteMany).not.toHaveBeenCalled();
    tx.message.findFirst.mockResolvedValue({ seq: 8 });
    await discardAnsweredSteering(tx as never, { threadId: "thread-1", runId: "run-1" });
    expect(tx.steeringMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("only discards claims ordered before a reply, including the next sequence", async () => {
    const tx = client({ seq: 8 }, [
      { steeringIds: ["answered"], nextMessageSeq: 8 },
      { steeringIds: ["later"], nextMessageSeq: 9 },
      { steeringIds: ["legacy"] },
      null,
    ]);
    await discardAnsweredSteering(tx as never, { threadId: "thread-1", runId: "run-1" });
    expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        claimedAt: { not: null },
        id: { in: ["answered"] },
      },
    });
  });
});

describe("appendEventsInTransaction", () => {
  function countingTx() {
    const calls: string[] = [];
    const record =
      <T>(name: string, impl: (...args: never[]) => T) =>
      (...args: never[]) => {
        calls.push(name);
        return impl(...args);
      };
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const tx = {
      thread: {
        update: vi.fn(
          record(
            "thread.update",
            async ({ data }: { data: { nextEventSeq: { increment: number } } }) => ({
              nextEventSeq: 5 + data.nextEventSeq.increment,
            }),
          ),
        ),
      },
      run: {
        findUnique: vi.fn(
          record("run.findUnique", async () => ({ status: "running", startedAt: null })),
        ),
      },
      event: {
        create: vi.fn(record("event.create", async ({ data }: { data: { seq: number } }) => data)),
        createMany: vi.fn(record("event.createMany", createMany)),
      },
    };
    return { tx, calls, createMany };
  }
  const base = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", runId: "run-1" };

  it("reserves the sequence range once and inserts the rows in order with sanitized payloads", async () => {
    const { tx, calls } = countingTx();
    const rows = await appendEventsInTransaction(tx as never, [
      { ...base, type: "thread.message.created", payload: { messageId: "m-1", text: "a\ud83d" } },
      { ...base, type: "thread.progress", payload: { text: "b" } },
      { ...base, type: "run.completed", payload: {} },
    ]);
    expect(calls).toEqual(["thread.update", "run.findUnique", "event.createMany"]);
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { nextEventSeq: { increment: 3 } },
      select: { nextEventSeq: true },
    });
    expect(rows.map((row) => [row.seq, row.type])).toEqual([
      [5, "thread.message.created"],
      [6, "thread.progress"],
      [7, "run.completed"],
    ]);
    expect(tx.event.createMany).toHaveBeenCalledWith({ data: rows });
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("\\ud83d");
    expect((rows[0]!.payload as { messageId: string }).messageId).toBe("m-1");
  });

  it("takes the single-row path for one event and refuses mixed threads", async () => {
    const { tx, calls } = countingTx();
    const [row] = await appendEventsInTransaction(tx as never, [
      { ...base, type: "run.failed", payload: { error: "x" } },
    ]);
    expect(row!.seq).toBe(5);
    expect(calls).toEqual(["thread.update", "run.findUnique", "event.create"]);
    await expect(
      appendEventsInTransaction(tx as never, [
        { ...base, type: "run.failed", payload: {} },
        { ...base, threadId: "thread-2", type: "run.failed", payload: {} },
      ]),
    ).rejects.toThrow(/one thread/);
    expect(await appendEventsInTransaction(tx as never, [])).toEqual([]);
  });

  it("finalizes a completed run with one event reservation and one insert", async () => {
    const { tx, calls } = countingTx();
    const full = {
      ...tx,
      $queryRaw: vi.fn(async () => []),
      run: {
        ...tx.run,
        findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: {
        update: vi.fn(async ({ data }: { data: Record<string, { increment: number }> }) => {
          calls.push(data.nextEventSeq ? "thread.update:event" : "thread.update:message");
          return { nextMessageSeq: 2, nextEventSeq: 5 + (data.nextEventSeq?.increment ?? 0) };
        }),
      },
      event: { ...tx.event, deleteMany: vi.fn(async () => ({ count: 0 })) },
      message: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: object }) => ({ ...data, id: "message-1" })),
      },
      steeringMessage: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      bot: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof full) => unknown) => callback(full)),
    } as unknown as PrismaClient;
    const publish = vi.fn(async () => undefined);
    await expect(
      finalizeRun(
        prisma,
        {
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          runId: "run-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          leaseOwner: "worker-1",
          leaseFence: 1,
          outcome: "completed",
          blocks: [{ kind: "text", text: "done" }],
        },
        { publish } as never,
      ),
    ).resolves.toEqual({ continuationRunId: null });
    expect(calls.filter((name) => name.startsWith("thread.update:event"))).toHaveLength(1);
    expect(calls.filter((name) => name === "event.createMany")).toHaveLength(1);
    expect(calls.filter((name) => name === "event.create")).toHaveLength(0);
    const inserted = full.event.createMany.mock.calls[0]?.[0] as unknown as {
      data: Array<{ type: string }>;
    };
    expect(inserted.data.map((row) => row.type)).toEqual([
      "thread.message.created",
      "run.completed",
    ]);
    expect(publish).toHaveBeenCalledWith(expect.any(String), JSON.stringify({ cursor: 6 }));
  });
});
