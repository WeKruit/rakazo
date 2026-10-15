import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createRunExecutor } from "../../adapters/src/executor.js";
import { NoneSandboxProvider } from "../../adapters/src/none-sandbox.js";
import { MarkdownMemoryStore } from "../../memory/src/index.js";

it("runs text, Markdown memory, connectors and questions without a computer", async () => {
  const sandbox = new NoneSandboxProvider();
  const provision = vi.spyOn(sandbox, "provision");
  const writeFile = vi.spyOn(sandbox, "writeFile");
  const exportWorkspace = vi.spyOn(sandbox, "exportWorkspace");
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const blocks: MessageBlock[] = [
    { kind: "text", text: "Remember this and read the connected service." },
    { kind: "image", artifactId: "image-1", name: "photo.png", mimeType: "image/png" },
    { kind: "file", artifactId: "file-1", name: "notes.txt", mimeType: "text/plain", size: 4 },
  ];
  const documents: Array<Record<string, unknown>> = [];
  const effects: Array<Record<string, unknown>> = [];
  let hasComputer = true;
  const memoryDocument = {
    findMany: vi.fn(async () => documents),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const doc = { id: "memory-1", revision: 1, updatedAt: new Date(0), ...data };
      documents.push(doc);
      return doc;
    }),
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: hasComputer ? "unused-computer" : null,
        computerSwitching: true,
        computer: hasComputer ? { id: "unused-computer", scope: "team" } : null,
      })),
      findMany: vi.fn(async () => []),
    },
    computer: {
      findUniqueOrThrow: vi.fn(async () => {
        throw new Error("No computer may be leased");
      }),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        nextMessageSeq: 2,
      })),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: { threadId?: string } }) =>
        where.threadId
          ? [
              {
                id: "message-1",
                threadId: run.threadId,
                seq: 1,
                role: "user",
                runId: run.id,
                blocks,
                replyToMessageId: null,
                replyQuote: null,
                replyTo: null,
              },
            ]
          : [],
      ),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Remember my preference" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const effect = { id: `effect-${effects.length}`, ...data };
        effects.push(effect);
        return effect;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    artifact: {
      findMany: vi.fn(async () => [
        {
          id: "image-1",
          storageKey: "photo.png",
          size: 4,
          name: "photo.png",
          mimeType: "image/png",
        },
      ]),
    },
    memoryDocument,
    memoryRevision: { create: vi.fn(async () => ({})) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const connectorExecute = vi.fn(async function* () {
    yield { type: "result" as const, data: { value: "connected" } };
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const pauseRunForInput = vi.fn(async () => true);
  const append = vi.fn(async () => undefined);
  let ask = false;
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
    context: AdapterContext,
  ): AsyncIterable<AgentRuntimeEvent> {
    expect(context.screenLeaseId).toBeUndefined();
    const names = request.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "remember",
        "ask_user",
        "run_subagent",
        "schedule_create",
        "connected_read",
      ]),
    );
    for (const name of [
      "computer_observe",
      "computer_act",
      "browser_navigate",
      "browser_snapshot",
      "browser_act",
      "list_files",
      "read_file",
      "write_file",
      "attach_file",
      "shell",
      "render_plot",
      "open_path",
      "launch_app",
      "request_takeover",
    ])
      expect(names).not.toContain(name);
    expect(request.instructions).toContain("No computer is available");
    expect(request.instructions).not.toContain("persistent computer");
    expect(request.instructions).not.toContain("workspace is your private home");
    expect(request.prompt).toContain("Attached files cannot be read without a computer");
    expect(request.currentTurnImages?.[0]).toMatchObject({
      name: "photo.png",
      mimeType: "image/png",
    });
    expect(
      await request.executeTool!("shell", { command: "pwd" }, "unoffered-shell"),
    ).toMatchObject({ error: expect.stringContaining("computer") });
    const steering = await request.claimSteering!([]);
    expect(steering[0]?.text).toContain("Attached files cannot be read without a computer");
    expect(steering[0]?.images?.[0]).toMatchObject({ name: "photo.png" });
    if (ask) {
      expect(request.instructions).toContain("Prefers concise answers");
      // Pi handles ask_user in the runtime and emits this pause event.
      yield {
        type: "ask",
        text: "Which next?",
        actions: [
          { id: "a", label: "Review" },
          { id: "b", label: "Stop" },
        ],
      };
      return;
    }
    expect(
      await request.executeTool!("remember", { content: "Prefers concise answers" }, "remember-1"),
    ).toEqual({ ok: true });
    expect(await request.executeTool!("connected_read", {}, "read-1")).toEqual({
      value: "connected",
    });
    yield { type: "text", text: "Remembered and read." };
    yield { type: "done", text: "Remembered and read." };
  });
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const executor = createRunExecutor({
    prisma: prisma as unknown as PrismaClient,
    sandbox,
    memory: new MarkdownMemoryStore(prisma as unknown as PrismaClient),
    memoryProviders: { resolve: async () => null },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [
        {
          name: "connected_read",
          description: "Read connected data",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      resolveCall: async () => undefined,
      execute: connectorExecute,
    },
    artifacts: { get: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) },
    events: {
      append,
      finalizeRun,
      pauseRunForInput,
      claimSteering: async () => [
        { id: "steer-1", messageId: "steer-message-1", text: "Check this too", blocks },
      ],
    },
    jobs,
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalledOnce();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  expect(connectorExecute).toHaveBeenCalledOnce();
  expect(documents).toEqual([
    expect.objectContaining({
      scope: "bot",
      botId: run.botId,
      path: "MEMORY.md",
      content: "Prefers concise answers",
    }),
  ]);
  expect(prisma.memoryRevision.create).toHaveBeenCalledOnce();
  expect(finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "completed",
      blocks: expect.arrayContaining([{ kind: "text", text: "Remembered and read." }]),
    }),
  );
  ask = true;
  hasComputer = false;
  run.status = "queued";
  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalledTimes(2);
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  expect(pauseRunForInput).toHaveBeenCalledWith(
    expect.objectContaining({
      blocks: [expect.objectContaining({ kind: "ask", text: "Which next?" })],
    }),
  );
  expect(finalizeRun).toHaveBeenCalledOnce();
  expect(provision).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(exportWorkspace).not.toHaveBeenCalled();
  expect(prisma.computer.findUniqueOrThrow).not.toHaveBeenCalled();
  expect(jobs.enqueue).not.toHaveBeenCalled();
  expect(prisma.attempt.update).not.toHaveBeenCalled();
});
