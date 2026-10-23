import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { RECRUITING_DISABLED_BUILTIN_TOOLS } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import {
  COMPUTER_TOOLS_DISABLED_ERROR,
  createRunExecutor,
  selectBuiltinToolsForRun,
} from "./executor.js";

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

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: acquireLease,
  renewComputerExecutionLease: renewComputerLease,
  releaseComputerExecutionLease: releaseComputerLease,
  holdComputerExecutionLeaseForTakeover: holdComputerLease,
  provisionComputer,
}));

vi.mock("./computer-workspace.js", async (importOriginal) => ({
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
    disabledBuiltinTools?: readonly string[];
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
        disabledBuiltinTools: [...(options.disabledBuiltinTools ?? [])],
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
  const append = vi.fn(
    async (_event: { type: string; payload: Record<string, unknown> }) => undefined,
  );
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
      append,
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
    append,
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

const managed = [...RECRUITING_DISABLED_BUILTIN_TOOLS];
const failures = (f: ReturnType<typeof fixture>) =>
  f.append.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === "agent.tool.completed" && event.payload.outcome === "error");

describe("managed recruiting computer boundary", () => {
  it("refuses a runtime takeover event without a computer, lease or takeover card", async () => {
    const f = fixture([], { takeover: true, disabledBuiltinTools: managed });
    await f.start();
    expect(f.pauseRunForTakeover).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(holdComputerLease).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(failures(f)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          name: "request_takeover",
          error: COMPUTER_TOOLS_DISABLED_ERROR,
        }),
      }),
    ]);
  });

  it("refuses request_secret and every catalog-disabled computer tool with the same error", async () => {
    const f = fixture(
      managed.map((name) => ({ name, args: { reason: "Sign in", url: "https://mail.example" } })),
      { disabledBuiltinTools: managed },
    );
    await f.start();
    expect(f.toolResults).toEqual(managed.map(() => ({ error: COMPUTER_TOOLS_DISABLED_ERROR })));
    expect(f.pauseRunForTakeover).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("keeps the takeover for a bot without the denylist", async () => {
    const f = fixture([], { takeover: true });
    await f.start();
    expect(f.pauseRunForTakeover).toHaveBeenCalledOnce();
    expect(holdComputerLease).toHaveBeenCalledOnce();
  });

  it("filters the catalog with the same set the event boundary refuses", () => {
    const offered = (disabledBuiltinTools?: readonly string[]) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: true,
        pageBrowserAllowed: true,
        groupId: null,
        trigger: "message",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        disabledBuiltinTools,
      }).map((tool) => tool.name);
    const exposed = offered().filter((name) => managed.includes(name as (typeof managed)[number]));
    expect(exposed.length).toBeGreaterThan(0);
    expect(
      offered(managed).filter((name) => managed.includes(name as (typeof managed)[number])),
    ).toEqual([]);
  });
});

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
