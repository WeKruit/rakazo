import type { AgentRunRequest, MemorySnapshot } from "@rakazo/adapter-kit";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import type { RecruitingRoleToolResult, ThreadEvents } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import { loadRecruitingRunContext } from "./recruiting-context.js";
import { executeRecruitingRoleTool } from "./recruiting-tools.js";

vi.mock("./recruiting-context.js", () => ({ loadRecruitingRunContext: vi.fn() }));
vi.mock("./recruiting-tools.js", () => ({ executeRecruitingRoleTool: vi.fn() }));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  spaceId: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(runId = "run-1", secrets: string[] = []) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    sourceMessageId: null as string | null,
  };
  const thread = { id: run.threadId, groupId: null, activeRecruitingRoleId: null as string | null };
  const memoryCommit = vi.fn(async () => ({ path: "MEMORY.md", revision: 1 }));
  const memoryRead = vi.fn(
    async (_request: { scope: "bot" | "user" }): Promise<MemorySnapshot> => ({ documents: [] }),
  );
  const artifacts = {
    describe: () => ({ capabilities: { stream: false } }),
    put: vi.fn(async () => ({ id: "stored-context", hash: "a".repeat(64) })),
    get: vi.fn(async () => new Uint8Array()),
    remove: vi.fn(async () => undefined),
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; spaceId?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.spaceId && effect.spaceId !== where.spaceId) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
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
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => thread) },
    message: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
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
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const claimSteering = vi.fn<ThreadEvents["claimSteering"]>(async () => []);
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: memoryRead,
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    artifacts,
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun, claimSteering },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    scratchpadRows,
    memoryCommit,
    memoryRead,
    artifacts,
    prisma,
    runData: run,
    thread,
    runtimeRun,
    claimSteering,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run(expectedError?: string) {
      run.status = "queued";
      finalizeRun.mockClear();
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      if (expectedError) {
        expect(finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed", error: expectedError }),
        );
      } else {
        expect(finalizeRun).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed" }),
        );
      }
    },
  };
}

describe("mutating tool effect idempotency keys", () => {
  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference", expectedRevision: 0 },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
        expectedRevision: 0,
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note", expectedRevision: 0 },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note", expectedRevision: 0 },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).toHaveBeenCalledOnce();
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
        expectedRevision: 0,
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
        expectedRevision: 0,
      }),
    ]);
    expect(second.results[0]).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact", expectedRevision: 0 },
        executionId: "call_0",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact", expectedRevision: 0 },
        executionId: "call_0",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
        expectedRevision: 0,
      }),
    );
    expect(f.results[1]).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact", expectedRevision: 0 },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact", expectedRevision: 0 },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
        expectedRevision: 0,
      }),
    );
    expect(f.results[1]).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact", expectedRevision: 0 },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact", expectedRevision: 0 },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([
      { ok: true, path: "MEMORY.md", revision: 1 },
      { ok: true, path: "MEMORY.md", revision: 1 },
    ]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      spaceId: "space-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      spaceId: "space-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      spaceId: "space-1",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact", expectedRevision: 0 },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
        expectedRevision: 0,
      }),
    );
    expect(f.results[0]).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("executes two identical-args mutating calls in one live run", async () => {
    const args = { path: "MEMORY.md", content: "same fact", expectedRevision: 0 };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([
      { ok: true, path: "MEMORY.md", revision: 1 },
      { ok: true, path: "MEMORY.md", revision: 1 },
    ]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      spaceId: "space-1",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });
});

describe("native recruiting role effect delivery", () => {
  const source: NonNullable<RecruitingRoleToolResult["source"]> = {
    id: "human-source",
    kind: "original_material",
    anchor: { kind: "message", messageId: "human-message", locator: "text" },
    readState: "read",
    readAt: "2026-10-15T00:00:00.000Z",
    quote: "Create a role requiring personal geometry implementation",
  };
  const workspace: NonNullable<RecruitingRoleToolResult["workspace"]> = {
    role: {
      id: "role-1",
      spaceId: "space-1",
      userId: "user-1",
      sourceThreadId: "thread-1",
      title: "Geometry engineer",
      revision: 1,
      currentRevisionId: "role-revision-1",
    },
    revision: {
      id: "role-revision-1",
      roleId: "role-1",
      revision: 1,
      sourceRefs: [source],
      criteria: [
        {
          id: "geometry",
          priority: "hard",
          expression: {
            kind: "atom",
            id: "geometry",
            statement: "Must personally implement geometry calculations",
          },
          sourceRefs: [source],
          definitionQuestions: [],
        },
      ],
      preferences: [],
      definitionQuestions: [],
      createdAt: "2026-10-15T00:00:00.000Z",
    },
  };
  const receipt: RecruitingRoleToolResult = {
    status: "saved",
    workspace,
    source,
    changed: true,
  };
  const adopted: LoadedRecruitingRunContext = {
    workspace,
    text: `<recruiting_role>\n${JSON.stringify(workspace)}\n</recruiting_role>`,
    contextArtifact: { artifactId: "context-artifact-1", sha256: "a".repeat(64) },
    manifest: {
      version: 1,
      roleId: workspace.role.id,
      roleRevisionId: workspace.revision.id,
      roleRevision: 1,
      actor: { spaceId: "space-1", userId: "user-1" },
      runId: "run-role",
      threadId: "thread-1",
      botId: "bot-1",
      roleText: JSON.stringify(workspace),
      memory: { documents: [] },
      text: JSON.stringify(workspace),
      recallScope: null,
      placement: "tool_result",
      reason: "role_tool",
      sourceMessageId: "human-message",
    },
  };
  const args = {
    operation: "create",
    expectedRevision: 0,
    title: workspace.role.title,
    sourceRefs: [],
    criteria: workspace.revision.criteria,
    preferences: [],
    definitionQuestions: [],
    intent: { basis: "direct", quote: source.quote },
  };
  const delivered = {
    ...receipt,
    roleContext: adopted.text,
    contextArtifact: adopted.contextArtifact,
  };

  beforeEach(() => {
    vi.mocked(executeRecruitingRoleTool).mockReset();
    vi.mocked(loadRecruitingRunContext).mockReset();
  });

  it("claims the native effect before creating a role and persists its receipt before context delivery", async () => {
    const f = fixture("run-role");
    f.runData.sourceMessageId = "human-message";
    vi.mocked(executeRecruitingRoleTool).mockImplementation(async (prisma, trusted, input) => {
      expect(prisma).toBe(f.prisma);
      expect(trusted).toEqual({
        actor: { spaceId: "space-1", userId: "user-1", email: "", isDeploymentOwner: false },
        runId: "run-role",
        sourceMessageId: "human-message",
      });
      expect(input).toEqual(args);
      expect(f.effects).toEqual([
        expect.objectContaining({ kind: "recruiting_role", status: "executing", request: args }),
      ]);
      return receipt;
    });
    vi.mocked(loadRecruitingRunContext).mockImplementation(
      async (deps, run, memory, context, options) => {
        expect(deps.artifacts).toBe(f.artifacts);
        expect(run).toBe(f.runData);
        expect(memory).toEqual({ documents: [] });
        expect(context).toEqual(expect.objectContaining({ runId: "run-role", userId: "user-1" }));
        expect(options).toEqual(
          expect.objectContaining({
            reason: "role_tool",
            placement: "tool_result",
            sourceMessageId: "human-message",
          }),
        );
        expect(f.effects[0]).toEqual(
          expect.objectContaining({ status: "completed", result: receipt }),
        );
        return adopted;
      },
    );
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-create" }]);

    await f.run();

    expect(f.results).toEqual([delivered]);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.result).toEqual(delivered);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-role", "recruiting_role", args),
    );

    // A completed replay can refresh context, but must preserve the same domain receipt.
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-after-restart" }]);
    await f.run();

    expect(executeRecruitingRoleTool).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.results).toEqual([delivered, delivered]);
    expect(f.effects[0]?.result).toEqual(delivered);
  });

  it("rebuilds context from a completed base receipt after materialization fails without creating again", async () => {
    const f = fixture("run-role-recovery");
    vi.mocked(executeRecruitingRoleTool).mockResolvedValue(receipt);
    vi.mocked(loadRecruitingRunContext)
      .mockImplementationOnce(async () => {
        expect(f.effects[0]).toEqual(
          expect.objectContaining({ status: "completed", result: receipt }),
        );
        throw new Error("context materialization interrupted");
      })
      .mockResolvedValue(adopted);
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-before-crash" }]);

    await f.run("context materialization interrupted");

    expect(f.results).toEqual([]);
    expect(f.effects[0]).toEqual(expect.objectContaining({ status: "completed", result: receipt }));
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-after-crash" }]);

    await f.run();

    expect(executeRecruitingRoleTool).toHaveBeenCalledOnce();
    expect(loadRecruitingRunContext).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(1);
    expect(f.results).toEqual([delivered]);
    expect(f.effects[0]).toEqual(
      expect.objectContaining({ status: "completed", result: delivered }),
    );
  });

  it("drops the stale context artifact when a completed role receipt replays after the role is cleared", async () => {
    const f = fixture("run-cleared-role-replay");
    f.effects.push({
      id: "completed-role-effect",
      spaceId: "space-1",
      runId: f.runData.id,
      kind: "recruiting_role",
      idempotencyKey: toolEffectIdempotencyKey(f.runData.id, "recruiting_role", args),
      status: "completed",
      request: args,
      result: delivered,
    });
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(undefined);
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-after-role-cleared" }]);

    await f.run();

    expect(executeRecruitingRoleTool).not.toHaveBeenCalled();
    expect(loadRecruitingRunContext).toHaveBeenCalledOnce();
    expect(f.results[0]).toEqual(
      expect.objectContaining({
        roleContext: expect.stringContaining("No recruiting role is selected"),
      }),
    );
    expect(f.results[0]).not.toHaveProperty("contextArtifact");
    expect(f.effects[0]?.result).toEqual(f.results[0]);
    expect(f.effects[0]?.result).not.toHaveProperty("contextArtifact");
  });

  it("delivers context from the completed base receipt when another worker wins the effect claim", async () => {
    const f = fixture("run-role-claim-race");
    f.prisma.externalEffect.updateMany.mockImplementationOnce(async ({ where, data }) => {
      expect(where.status).toBe("intended");
      expect(data.status).toBe("executing");
      const effect = f.effects.find((item) => item.id === where.id)!;
      Object.assign(effect, { status: "completed", result: receipt });
      return { count: 0 };
    });
    vi.mocked(executeRecruitingRoleTool).mockResolvedValue(receipt);
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-lost-claim" }]);

    await f.run();

    expect(executeRecruitingRoleTool).not.toHaveBeenCalled();
    expect(f.results).toEqual([delivered]);
    expect(loadRecruitingRunContext).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]).toEqual(
      expect.objectContaining({ status: "completed", result: delivered }),
    );
  });

  it("injects the bound role and structured memory text exactly once into runtime instructions", async () => {
    const f = fixture("run-bound-role");
    f.thread.activeRecruitingRoleId = workspace.role.id;
    const fact = "Durable preference for supplied candidate material";
    f.memoryRead.mockImplementation(async ({ scope }) => ({
      documents:
        scope === "bot" ? [{ id: "memory-1", path: "MEMORY.md", content: fact, revision: 1 }] : [],
    }));
    let fullContext = "";
    vi.mocked(loadRecruitingRunContext).mockImplementation(
      async (_deps, _run, memory, _context, options) => {
        expect(memory.text).toContain(fact);
        expect(memory.documents).toEqual([
          expect.objectContaining({
            id: "memory-1",
            includedContent: fact,
            disposition: "included",
          }),
        ]);
        expect(options).toEqual(
          expect.objectContaining({ reason: "run", placement: "instructions" }),
        );
        fullContext = `${adopted.text}\n\n${memory.text}`;
        return { ...adopted, text: fullContext };
      },
    );

    await f.run();

    expect(loadRecruitingRunContext).toHaveBeenCalledOnce();
    expect(executeRecruitingRoleTool).not.toHaveBeenCalled();
    const request = f.runtimeRun.mock.calls[0]![0];
    expect(request.instructions?.split(fullContext)).toHaveLength(2);
    expect(request.instructions?.split(fact)).toHaveLength(2);
    expect(request.instructions).toContain("Must personally implement geometry calculations");
    expect(request.instructions).not.toContain("[object Object]");
  });

  it("redacts secrets in the delivered role snapshot and the completed full receipt", async () => {
    const secret = 'configured-role-secret-"quoted"\nsecond-line';
    const f = fixture("run-role-secret", [secret]);
    const rawReceipt = {
      ...receipt,
      workspace: { ...workspace, role: { ...workspace.role, title: `Role ${secret}` } },
      source: { ...source, quote: `Human quote ${secret}` },
    };
    vi.mocked(executeRecruitingRoleTool).mockResolvedValue(rawReceipt);
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    f.setCalls([{ name: "recruiting_role", args, executionId: "call-secret-role" }]);

    await f.run();

    const redacted = {
      ...delivered,
      workspace: { ...workspace, role: { ...workspace.role, title: "Role [redacted]" } },
      source: { ...source, quote: "Human quote [redacted]" },
    };
    expect(f.results).toEqual([redacted]);
    expect(f.effects[0]?.result).toEqual(redacted);
    expect(JSON.stringify(f.effects[0]?.result)).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it("adopts steering context once on the latest human item while preserving original history text", async () => {
    const f = fixture("run-role-steering");
    const steering = [
      {
        id: "steering-1",
        messageId: "human-first",
        text: "Use the current role",
        blocks: [{ kind: "text" as const, text: "Use the current role" }],
      },
      {
        id: "steering-2",
        messageId: "human-latest",
        text: "Keep the geometry criterion",
        blocks: [{ kind: "text" as const, text: "Keep the geometry criterion" }],
      },
      {
        id: "steering-3",
        messageId: "peer-message",
        text: "Peer status update",
        blocks: [
          {
            kind: "bot_message_received" as const,
            fromBotId: "peer-bot",
            fromBotName: "Peer",
            text: "Peer status update",
          },
        ],
      },
    ];
    f.claimSteering.mockImplementation(async () => {
      f.thread.activeRecruitingRoleId = workspace.role.id;
      return steering;
    });
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    f.runtimeRun.mockImplementation(async function* (request) {
      const claimed = await request.claimSteering!([]);
      expect(claimed).toEqual([
        expect.objectContaining({
          messageId: "human-first",
          text: steering[0]!.text,
          historyText: steering[0]!.text,
        }),
        expect.objectContaining({
          messageId: "human-latest",
          text: `${steering[1]!.text}\n\n${adopted.text}`,
          historyText: steering[1]!.text,
        }),
        expect.objectContaining({
          messageId: "peer-message",
          text: steering[2]!.text,
          historyText: steering[2]!.text,
        }),
      ]);
      expect(
        claimed
          .map((item) => item.text)
          .join("\n")
          .split(adopted.text),
      ).toHaveLength(2);
      yield { type: "done" as const, text: "Done" };
    });

    await f.run();

    expect(f.claimSteering).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-role-steering", seenIds: [] }),
    );
    expect(loadRecruitingRunContext).toHaveBeenCalledOnce();
    expect(loadRecruitingRunContext).toHaveBeenCalledWith(
      expect.anything(),
      f.runData,
      { documents: [] },
      expect.anything(),
      expect.objectContaining({
        reason: "steering",
        placement: "steering",
        sourceMessageId: "human-latest",
      }),
    );
  });

  it("delivers role context on nonhuman steering without replacing the trusted human source", async () => {
    const f = fixture("run-peer-only-steering");
    f.thread.activeRecruitingRoleId = workspace.role.id;
    f.runData.sourceMessageId = "human-message";
    const peer = {
      id: "peer-steering",
      messageId: "peer-message",
      text: "Peer status update",
      blocks: [
        {
          kind: "bot_message_received" as const,
          fromBotId: "peer-bot",
          fromBotName: "Peer",
          text: "Peer status update",
        },
      ],
    };
    f.claimSteering.mockResolvedValue([peer]);
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    vi.mocked(executeRecruitingRoleTool).mockResolvedValue(receipt);
    let claimed: Awaited<ReturnType<NonNullable<AgentRunRequest["claimSteering"]>>> = [];
    f.runtimeRun.mockImplementation(async function* (request) {
      claimed = await request.claimSteering!([]);
      f.results.push(
        await request.executeTool!("recruiting_role", args, "call-after-peer-steering"),
      );
      yield { type: "done" as const, text: "Done" };
    });

    await f.run();

    expect(executeRecruitingRoleTool).toHaveBeenCalledWith(
      f.prisma,
      expect.objectContaining({ sourceMessageId: "human-message" }),
      args,
    );
    expect(loadRecruitingRunContext).toHaveBeenCalledWith(
      expect.anything(),
      f.runData,
      { documents: [] },
      expect.anything(),
      expect.objectContaining({
        reason: "steering",
        placement: "steering",
        sourceMessageId: peer.messageId,
      }),
    );
    expect(claimed).toEqual([
      expect.objectContaining({
        messageId: peer.messageId,
        text: `${peer.text}\n\n${adopted.text}`,
        historyText: peer.text,
      }),
    ]);
  });
});
