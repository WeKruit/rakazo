import type { AgentHarnessTool, AgentLane, HarnessEvent } from "@earendil-works/pi-agent-core";
import { AgentHarness, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents, createThreadMessageInTransaction } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RakazoUserMessage, RunProjectionContext } from "./run-projection.js";
import { createRunProjection } from "./run-projection.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const C = BACKGROUND_CONTEXT;

const HARNESS_EVENTS = [
  "run_start",
  "run_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_end",
  "entry_added",
  "usage",
] as const;

describePostgres("run projection (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `projection-user-${suffix}`;
  const organizationId = `projection-organization-${suffix}`;
  const spaceId = `projection-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Projection Org",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
  });

  afterAll(async () => {
    await prisma.space.deleteMany({ where: { id: spaceId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  /** A thread, its bot, a harness on an in-memory session and a projection fed every event. */
  async function setup(responses: FauxResponseStep[], tools: AgentHarnessTool<undefined>[] = []) {
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Agent", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const key = { spaceId, userId, threadId: thread.id, botId: bot.id };
    const projection = createRunProjection(
      { prisma, events: createThreadEvents(prisma), jobs: { enqueue: async () => {} } },
      key,
    );
    const faux = fauxProvider({ tokensPerSecond: 8, tokenSize: { min: 1, max: 2 } });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(responses);
    const session = await new MemorySessionRepo().create({}, C);
    const { harness } = await AgentHarness.create(
      { session, models, model: faux.getModel(), tools },
      C,
    );
    const starts = new Map<string, RunProjectionContext>();
    let projected = Promise.resolve();
    const errors: unknown[] = [];
    const listeners: ((event: HarnessEvent) => void)[] = [];
    for (const type of HARNESS_EVENTS)
      harness.events.on(type, (event: HarnessEvent) => {
        for (const listener of listeners) listener(event);
        const ctx = event.type === "run_start" ? starts.get(event.runId) : undefined;
        projected = projected
          .then(() => projection.onEvent(event, ctx ?? {}))
          .catch((error) => {
            errors.push(error);
          });
      });
    const lane = await harness.lane("main", C);
    const userMessage = async (text: string) => {
      const row = await prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: thread.id,
          role: "user",
          blocks: [{ kind: "text", text }],
        }),
      );
      const message: RakazoUserMessage = {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        rakazoMessageId: row.id,
      };
      return { id: row.id, message };
    };
    const run = async (operationId: string, text: string) => {
      const input = await userMessage(text);
      starts.set(operationId, { input: { trigger: "user", sourceMessageId: input.id } });
      const accepted = await lane.accept(
        { kind: "prompt", operationId, prompt: [input.message] },
        C,
      );
      expect(accepted.ok).toBe(true);
      return { input, driven: lane.drive({ operationId }, C) };
    };
    const settle = async () => {
      await projected;
      expect(errors).toEqual([]);
    };
    return { thread, lane, run, userMessage, settle, harness, on: listeners };
  }

  it("one run row per Pi operation", async () => {
    let echoes = 0;
    const echo: AgentHarnessTool<undefined> = {
      name: "echo",
      label: "echo",
      description: "Echo",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => {
        echoes += 1;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };
    const t = await setup(
      [
        fauxAssistantMessage([fauxText("Looking."), fauxToolCall("echo", { q: "x" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("First answer."),
        fauxAssistantMessage("Second answer."),
      ],
      [echo],
    );
    const first = await t.run("op-one-1", "hello");
    await first.driven;
    const second = await t.run("op-one-2", "again");
    await second.driven;
    await t.settle();

    expect(echoes).toBe(1);
    const runs = await prisma.run.findMany({
      where: { threadId: t.thread.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, trigger: true, sourceMessageId: true, taskId: true },
    });
    expect(runs).toEqual([
      expect.objectContaining({
        id: "op-one-1",
        status: "completed",
        trigger: "user",
        sourceMessageId: first.input.id,
      }),
      expect.objectContaining({
        id: "op-one-2",
        status: "completed",
        trigger: "user",
        sourceMessageId: second.input.id,
      }),
    ]);
    const tasks = await prisma.task.findMany({ where: { threadId: t.thread.id } });
    expect(tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    const events = await prisma.event.findMany({
      where: { threadId: t.thread.id },
      orderBy: { seq: "asc" },
      select: { type: true, runId: true },
    });
    const ofRun = (runId: string) =>
      events.filter((event) => event.runId === runId).map((event) => event.type);
    expect(ofRun("op-one-1").filter((type) => type.startsWith("run."))).toEqual([
      "run.started",
      "run.completed",
    ]);
    expect(ofRun("op-one-1")).toEqual(
      expect.arrayContaining(["agent.tool.called", "agent.tool.completed"]),
    );
    expect(ofRun("op-one-2").filter((type) => type.startsWith("run."))).toEqual([
      "run.started",
      "run.completed",
    ]);
    const replies = await prisma.message.findMany({
      where: { threadId: t.thread.id, role: "bot" },
      orderBy: { seq: "asc" },
      select: { runId: true, blocks: true },
    });
    const replyText = (blocks: unknown) =>
      (blocks as { kind: string; text?: string }[])
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("");
    expect(replies.map((reply) => [reply.runId, replyText(reply.blocks)])).toEqual([
      ["op-one-1", "Looking."],
      ["op-one-1", "First answer."],
      ["op-one-2", "Second answer."],
    ]);
    // The tool's step rides with the text that follows it.
    expect(replies[1]!.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "steps" })]),
    );
    const usage = await prisma.usageRecord.findMany({ where: { runId: "op-one-1" } });
    expect(usage).toHaveLength(2);
    expect(usage.every((row) => row.provider === "faux" && row.callId)).toBe(true);
    await t.harness.close(C);
  });

  it("steered message gets runId of the live run", async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const wait: AgentHarnessTool<undefined> = {
      name: "wait",
      label: "wait",
      description: "Wait",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => {
        toolStarted();
        await toolGate;
        return { content: [{ type: "text", text: "waited" }], details: {} };
      },
    };
    const t = await setup(
      [
        fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Took both into account."),
      ],
      [wait],
    );
    const live = await t.run("op-steer-1", "find people");
    await started;
    const steered = await t.userMessage("only in Berlin");
    const queued = await t.lane.steer(steered.message, undefined, C);
    expect(queued.ok).toBe(true);
    releaseTool();
    await live.driven;
    await t.settle();

    const runs = await prisma.run.findMany({ where: { threadId: t.thread.id } });
    expect(runs.map((run) => [run.id, run.status])).toEqual([["op-steer-1", "completed"]]);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: steered.id } });
    expect(message.runId).toBe("op-steer-1");
    await t.harness.close(C);
  });

  it("aborted run ends cancelled with its partial text saved", async () => {
    const t = await setup([
      fauxAssistantMessage(
        "Partial answer that streams slowly over many many tokens so the stop lands mid stream.",
      ),
    ]);
    let stopped = false;
    let lane: AgentLane | undefined;
    t.on.push((event) => {
      if (
        !stopped &&
        lane &&
        event.type === "message_update" &&
        event.message.role === "assistant" &&
        event.message.content.some((part) => part.type === "text" && part.text.length > 8)
      ) {
        stopped = true;
        void lane.abort(C);
      }
    });
    lane = t.lane;
    const live = await t.run("op-abort-1", "write me something long");
    await live.driven;
    await t.settle();

    expect(stopped).toBe(true);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: "op-abort-1" } });
    expect(run.status).toBe("cancelled");
    expect(run.completedAt).not.toBeNull();
    const task = await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.status).toBe("cancelled");
    const replies = await prisma.message.findMany({
      where: { threadId: t.thread.id, role: "bot", runId: "op-abort-1" },
    });
    expect(replies).toHaveLength(1);
    const text = (replies[0]!.blocks as { kind: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("");
    expect(text.length).toBeGreaterThan(0);
    expect(
      "Partial answer that streams slowly over many many tokens so the stop lands mid stream.".startsWith(
        text,
      ),
    ).toBe(true);
    const terminal = await prisma.event.findMany({
      where: { runId: "op-abort-1", type: { startsWith: "run." } },
      orderBy: { seq: "asc" },
      select: { type: true },
    });
    expect(terminal.map((event) => event.type)).toEqual(["run.started", "run.cancelled"]);
    await t.harness.close(C);
  });
});
