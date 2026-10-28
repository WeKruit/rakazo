import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "../../adapters/src/computer-lifecycle.js";
import { ComputerBusyError } from "../../adapters/src/computer-lifecycle.js";
import { createRunExecutor } from "../../adapters/src/executor.js";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import { startModelEmulator } from "./model-emulator.js";

const {
  acquireLease,
  provisionComputer,
  renewComputerLease,
  releaseComputerLease,
  holdComputerLease,
  checkpointWorkspace,
} = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  provisionComputer: vi.fn(),
  renewComputerLease: vi.fn(),
  releaseComputerLease: vi.fn(),
  holdComputerLease: vi.fn(),
  checkpointWorkspace: vi.fn(),
}));

vi.mock("../../adapters/src/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: acquireLease,
  renewComputerExecutionLease: renewComputerLease,
  releaseComputerExecutionLease: releaseComputerLease,
  holdComputerExecutionLeaseForTakeover: holdComputerLease,
  provisionComputer,
}));

vi.mock("../../adapters/src/computer-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkpointRunComputerWorkspace: checkpointWorkspace,
}));

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

/** A routine run whose model makes the given tool calls, then answers. */
function fixture(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: {
    takeover?: boolean;
    runId?: string;
    held?: boolean;
    checkpoint?: string;
    shutdownSignal?: AbortSignal;
    model?: (request: AgentRunRequest, context: AdapterContext) => Promise<void>;
  } = {},
) {
  const run = {
    id: options.runId ?? "run-1",
    botId: "bot-1",
    threadId: `thread-${options.runId ?? "1"}`,
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: options.held ? "waiting_takeover" : "queued",
    checkpoint: options.checkpoint ?? null,
    leaseOwner: null as string | null,
    trigger: "routine",
    routineId: "routine-1",
    retryOfRunId: null,
    leaseFence: 0,
    createdAt: new Date(),
  };
  const toolResults: unknown[] = [];
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
    context: AdapterContext,
  ): AsyncGenerator<AgentRuntimeEvent> {
    await options.model?.(request, context);
    for (const [index, call] of toolCalls.entries()) {
      toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
    }
    if (options.takeover) {
      yield { type: "takeover" as const, reason: "Sign in to the inbox." };
      return;
    }
    yield { type: "text" as const, text: "Inbox is clear." };
    yield { type: "done" as const, text: "Inbox is clear." };
  });
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: false },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            checkpoint?: string | null | { in: string[] };
            status?: string | { in: string[] };
            leaseOwner?: string;
            leaseFence?: number;
          };
          data: Record<string, unknown>;
        }) => {
          if (
            (where.checkpoint === null && run.checkpoint !== null) ||
            (typeof where.checkpoint === "string" && where.checkpoint !== run.checkpoint) ||
            (typeof where.checkpoint === "object" &&
              where.checkpoint &&
              !where.checkpoint.in.includes(run.checkpoint!)) ||
            (where.leaseOwner !== undefined && where.leaseOwner !== run.leaseOwner) ||
            (where.leaseFence !== undefined && where.leaseFence !== run.leaseFence)
          )
            return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
      // The thread lane: no other run in this thread is ahead of this one.
      count: vi.fn(async () => 0),
    },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, seq: 1 })),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "team", kind: "e2b", homeKey: "home-1" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "message-1", ...data })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: { findMany: vi.fn(async () => []) },
    usageRecord: { createMany: vi.fn(async () => ({ count: 1 })) },
  };
  const database = Object.assign(prisma, {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  });
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: false } }),
    listFiles: vi.fn(async () => [{ path: "notes.txt", kind: "file", size: 4 }]),
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    async *exportWorkspace() {
      yield* [];
    },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const pauseRunForTakeover = vi.fn(async () => true);
  const enqueue = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma: withEmptyModels(database),
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: {
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      publishTransient: vi.fn(async () => undefined),
      finalizeRun,
      pauseRunForTakeover,
      claimSteering: vi.fn(async () => []),
    },
    jobs: { enqueue },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
    shutdownSignal: options.shutdownSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const sleepJobs = () =>
    enqueue.mock.calls
      .map((call) => (call as unknown[])[0] as { name: string })
      .filter((job) => job.name === "computer.sleep");
  return {
    run,
    prisma,
    runtimeRun,
    finalizeRun,
    pauseRunForTakeover,
    sandbox,
    sleepJobs,
    toolResults,
    enqueue,
    executor,
    start: () => executor.continueRun(run.id, "worker-1"),
  };
}

beforeEach(() => {
  acquireLease.mockReset();
  acquireLease.mockImplementation(async (_prisma, input) => ({ ...input, fence: 7 }));
  renewComputerLease.mockReset();
  renewComputerLease.mockResolvedValue(true);
  holdComputerLease.mockReset();
  holdComputerLease.mockResolvedValue(true);
  releaseComputerLease.mockReset();
  releaseComputerLease.mockResolvedValue(undefined);
  checkpointWorkspace.mockReset();
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue(COMPUTER);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("native first-use computer admission", () => {
  it("runs two role conversations for the same Main without reserving its computer", async () => {
    let entered = 0;
    let continueModel!: () => void;
    const ready = new Promise<void>((resolve) => {
      continueModel = resolve;
    });
    const model = async () => {
      if (++entered === 2) continueModel();
      await ready;
    };
    const a = fixture([], { runId: "run-a", model });
    const b = fixture([], { runId: "run-b", model });
    await Promise.all([a.start(), b.start()]);
    expect(entered).toBe(2);
    expect(a.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(b.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(acquireLease).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(a.sleepJobs()).toEqual([]);
    expect(b.sleepJobs()).toEqual([]);
  });

  it("admits and starts once for parallel first file reads with the acquired screen fence", async () => {
    const f = fixture([], {
      model: async (request) => {
        expect(acquireLease).not.toHaveBeenCalled();
        await Promise.all([
          request.executeTool!("list_files", {}, "a"),
          request.executeTool!("list_files", {}, "b"),
        ]);
      },
    });
    await f.start();
    expect(acquireLease).toHaveBeenCalledOnce();
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(provisionComputer).toHaveBeenCalledWith(
      expect.anything(),
      "computer-1",
      expect.objectContaining({ screenLeaseId: "run-1:7" }),
      "bot",
    );
    expect(f.sandbox.listFiles).toHaveBeenCalledTimes(2);
    expect(f.sleepJobs()).toHaveLength(1);
    expect(releaseComputerLease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-1", fence: 7 }),
    );
  });

  it("requeues first-use contention durably and aborts further tool work", async () => {
    acquireLease.mockRejectedValue(new ComputerBusyError());
    const f = fixture([], {
      model: async (request, context) => {
        await expect(request.executeTool!("list_files", {}, "busy")).rejects.toBeInstanceOf(
          ComputerBusyError,
        );
        expect(context.signal.aborted).toBe(true);
        await expect(request.executeTool!("list_files", {}, "again")).rejects.toThrow();
      },
    });
    await f.start();
    expect(acquireLease).toHaveBeenCalledOnce();
    expect(f.run.status).toBe("queued");
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", availableAt: expect.any(Date) }),
    );
    expect(f.prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "run.requeued" }) }),
    );
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    expect(releaseComputerLease).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("does not acquire after the run fence is lost before first computer use", async () => {
    const f = fixture([], {
      model: async (request) => {
        f.prisma.run.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(request.executeTool!("list_files", {}, "stale")).rejects.toThrow();
      },
    });
    await f.start();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("does not provision if the run is reclaimed while admission is in flight", async () => {
    const f = fixture([{ name: "list_files", args: {} }]);
    acquireLease.mockImplementationOnce(async (_prisma, input) => {
      f.run.leaseFence += 1;
      return { ...input, fence: 7 };
    });
    await f.start();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(releaseComputerLease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: f.run.id, fence: 7 }),
    );
  });

  it("preserves worker shutdown recovery when shutdown interrupts first-use admission", async () => {
    const shutdown = new AbortController();
    const f = fixture([{ name: "list_files", args: {} }], { shutdownSignal: shutdown.signal });
    acquireLease.mockImplementationOnce(async (_prisma, input) => {
      shutdown.abort();
      return { ...input, fence: 7 };
    });
    await f.start();
    expect(f.run.status).toBe("queued");
    expect(f.prisma.attempt.update).not.toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each(["busy", "shutdown"] as const)(
    "stops real Pi after first-use %s without another model request or run failure",
    async (interruption) => {
      const server = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: { type: "tool", id: "first-file-read", name: "list_files", arguments: {} },
          },
        ],
      });
      try {
        const shutdown = new AbortController();
        const f = fixture([], { shutdownSignal: shutdown.signal });
        const runtime = new PiAgentRuntime();
        f.runtimeRun.mockImplementation(async function* (request, context) {
          // The native tool catalog alone exceeds the 32K default window for unknown models.
          yield* runtime.run(
            { ...request, model: { ...server.model, contextWindow: 272_000 } },
            context,
          );
        });
        acquireLease.mockImplementationOnce(async (_prisma, input) => {
          if (interruption === "busy") throw new ComputerBusyError();
          shutdown.abort();
          return { ...input, fence: 7 };
        });
        await f.start();
        expect(f.finalizeRun.mock.calls).toEqual([]);
        server.assertComplete();
        expect(server.requests).toHaveLength(1);
        expect(f.run.status).toBe("queued");
        expect(f.finalizeRun).not.toHaveBeenCalled();
        expect(f.sandbox.listFiles).not.toHaveBeenCalled();
        if (interruption === "shutdown") expect(f.prisma.attempt.update).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );

  it("keeps a null computer heartbeat valid before first use", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([], {
        model: async (_request, context) => {
          await vi.advanceTimersByTimeAsync(60_000);
          expect(context.signal.aborted).toBe(false);
          expect(renewComputerLease).toHaveBeenCalledWith(expect.anything(), null);
        },
      });
      await f.start();
      expect(acquireLease).not.toHaveBeenCalled();
      expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts on an admitted computer lease renewal failure", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([], {
        model: async (request, context) => {
          await request.executeTool!("list_files", {}, "first");
          renewComputerLease.mockResolvedValueOnce(false);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(context.signal.aborted).toBe(true);
        },
      });
      await f.start();
      expect(f.finalizeRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{ held: true }, { checkpoint: "takeover" }])(
    "reclaims retained takeover ownership before the model: %j",
    async (options) => {
      const f = fixture([], {
        ...options,
        model: async () => {
          expect(acquireLease).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ resumeHeldLease: true }),
          );
        },
      });
      await f.start();
      expect(acquireLease).toHaveBeenCalledOnce();
      expect(provisionComputer).not.toHaveBeenCalled();
    },
  );

  it("starts before a takeover and retains the acquired lease for the user", async () => {
    const f = fixture([], { takeover: true });
    await f.start();
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(holdComputerLease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: f.run.id, fence: 7 }),
    );
    expect(f.pauseRunForTakeover).toHaveBeenCalledOnce();
    expect(releaseComputerLease).not.toHaveBeenCalled();
    expect(f.sandbox.releaseScreen).not.toHaveBeenCalled();
  });

  it("keeps same-bot file work exclusive while another role waits in the native queue", async () => {
    let owner: string | null = null;
    acquireLease.mockImplementation(async (_prisma, input) => {
      if (owner) throw new ComputerBusyError();
      owner = input.runId;
      return { ...input, fence: 7 };
    });
    releaseComputerLease.mockImplementation(async (_prisma, lease) => {
      if (lease?.runId === owner) owner = null;
    });
    let finishRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const a = fixture([{ name: "list_files", args: {} }], { runId: "run-a" });
    a.sandbox.listFiles.mockImplementation(async () => {
      await reading;
      return [];
    });
    const active = a.start();
    await vi.waitFor(() => expect(a.sandbox.listFiles).toHaveBeenCalledOnce());
    const b = fixture([{ name: "list_files", args: {} }], { runId: "run-b" });
    await b.start();
    expect(b.run.status).toBe("queued");
    expect(b.sandbox.listFiles).not.toHaveBeenCalled();
    expect(b.finalizeRun).not.toHaveBeenCalled();
    expect(owner).toBe("run-a");
    finishRead();
    await active;
    expect(owner).toBeNull();
  });

  it("uses setup retry semantics if a computer cannot start", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));
    const f = fixture([{ name: "list_files", args: {} }]);
    await expect(f.start()).rejects.toThrow("Run setup failed; retrying");
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.run.status).toBe("queued");
  });
});

/** Models unrelated to computer admission behave as empty tables. */
function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}
