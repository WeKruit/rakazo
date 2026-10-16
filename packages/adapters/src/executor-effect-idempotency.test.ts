import type {
  AgentRunRequest,
  ConnectorProvider,
  ConnectorTool,
  MemorySnapshot,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import type { RecruitingFeedbackInput, RecruitingSourceRef } from "@rakazo/contracts";
import { RecruitingRoleToolInputSchema } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import { RecruitingAssessmentValidationError } from "@rakazo/core";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import type * as DatabaseModule from "@rakazo/db";
import type { RecruitingRoleToolResult, ThreadEvents } from "@rakazo/db";
import {
  claimRecruitingResearchAction,
  claimRecruitingResearchReadEffect,
  IsolationError,
  RecruitingSourceValidationError,
  recruitingResearchSnapshot,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { boundDirectApprovalRequest } from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import { runAutoReviewJudge } from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor, selectBuiltinToolsForRun } from "./executor.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import {
  executeRecruitingAssessmentTool,
  retainRecruitingWebMaterial,
} from "./recruiting-assessment.js";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import { loadRecruitingRunContext } from "./recruiting-context.js";
import type * as RecruitingFeedbackModule from "./recruiting-feedback.js";
import { executeRecruitingFeedback } from "./recruiting-feedback.js";
import {
  admitRecruitingResearchCall,
  bindRecruitingResearchReadCall,
  completeRecruitingResearchCall,
  executeRecruitingRoleTool,
  prepareRecruitingResearchTool,
  resolveRecruitingResearchTool,
} from "./recruiting-tools.js";

vi.mock("./recruiting-context.js", () => ({ loadRecruitingRunContext: vi.fn() }));
vi.mock("./recruiting-assessment.js", () => ({
  executeRecruitingAssessmentTool: vi.fn(),
  retainRecruitingWebMaterial: vi.fn(),
}));
vi.mock("./recruiting-tools.js", () => ({
  executeRecruitingRoleTool: vi.fn(),
  prepareRecruitingResearchTool: vi.fn(),
  resolveRecruitingResearchTool: vi.fn(),
  admitRecruitingResearchCall: vi.fn(),
  bindRecruitingResearchReadCall: vi.fn(),
  completeRecruitingResearchCall: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  claimRecruitingResearchAction: vi.fn(),
  claimRecruitingResearchReadEffect: vi.fn(),
}));
vi.mock("./recruiting-feedback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RecruitingFeedbackModule>()),
  executeRecruitingFeedback: vi.fn(),
}));

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
  const sourceMessages: Array<{ id: string; seq: number }> = [];
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
  const thread = {
    id: run.threadId,
    spaceId: run.spaceId,
    userId: run.userId,
    groupId: null,
    activeRecruitingRoleId: null as string | null,
  };
  const memoryCommit = vi.fn(async () => ({ path: "MEMORY.md", revision: 1 }));
  const memoryRead = vi.fn(
    async (_request: { scope: "bot" | "user" }): Promise<MemorySnapshot> => ({ documents: [] }),
  );
  const semanticSave = vi.fn<SemanticMemoryProvider["save"]>(async () => ({
    ok: true,
    value: undefined,
  }));
  const semanticMemory: SemanticMemoryProvider = {
    describe: () => ({
      id: "test-memory",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
    }),
    recall: async () => ({ ok: true, value: [] }),
    save: semanticSave,
    purgeHistory: async () => ({ ok: true, value: undefined }),
  };
  const memoryProviderResolve = vi.fn<MemoryProviderResolver["resolve"]>(async () => null);
  const disabledBuiltinTools: string[] = [];
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
    event: {
      findMany: vi.fn(async () => [] as Array<{ seq: number; type: string; payload: unknown }>),
    },
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
        spaceId: run.spaceId,
        userId: run.userId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        disabledBuiltinTools,
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
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) =>
        select?.id && select.seq && Object.keys(select).length === 2 ? sourceMessages : [],
      ),
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
    actionApprovalRule: { findMany: vi.fn(async (): Promise<ActionApprovalRule[]> => []) },
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
  const connector = {
    discoverTools: vi.fn<ConnectorProvider["discoverTools"]>(async () => []),
    resolveCall: vi.fn<NonNullable<ConnectorProvider["resolveCall"]>>(async () => undefined),
    execute: vi.fn<ConnectorProvider["execute"]>(async function* () {}),
  };
  const web = {
    search: vi.fn(async () => []),
    fetch: vi.fn(async () => ({
      url: "https://example.org/profile",
      title: "Public profile",
      text: "Public evidence",
      truncated: false,
    })),
  };
  const executor = createRunExecutor({
    web,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector,
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: memoryRead,
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: memoryProviderResolve },
    artifacts,
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun, claimSteering },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    web,
    sourceMessages,
    scratchpadRows,
    memoryCommit,
    memoryRead,
    memoryProviderResolve,
    semanticMemory,
    semanticSave,
    artifacts,
    prisma,
    runData: run,
    thread,
    runtimeRun,
    claimSteering,
    pauseRunForInput,
    disabledBuiltinTools,
    connector,
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

describe("native recruiting validation feedback", () => {
  it.each([
    ["recruiting_role", "create", ["preferences", "intent"]],
    ["recruiting_research", "prepare", ["expectedRoleRevision", "instructions", "intent"]],
  ] as const)(
    "returns actionable schema fields for %s without dispatch",
    async (name, operation, fields) => {
      const f = fixture(`invalid-${name}`, ["private-input-value"]);
      vi.mocked(executeRecruitingRoleTool)
        .mockReset()
        .mockImplementation(async (_db, _actor, args) => {
          RecruitingRoleToolInputSchema.parse(args);
          throw new Error("Invalid fixture unexpectedly passed validation");
        });
      f.setCalls([
        {
          name,
          args: {
            operation,
            title: "Synthetic role",
            sourceRefs: [],
            criteria: [],
            definitionQuestions: [],
            "private-input-value": true,
          },
          executionId: "missing-branch-fields",
        },
      ]);

      await f.run();

      expect(f.results).toHaveLength(1);
      const result = f.results[0] as { error: string };
      for (const field of fields) expect(result.error).toContain(field);
      expect(result.error).not.toContain("private-input-value");
      expect(f.connector.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(prepareRecruitingResearchTool).not.toHaveBeenCalled();
    },
  );
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

  it.each(["quote", "scope"])(
    "settles native role source %s errors without repeating the mutation",
    async (kind) => {
      const f = fixture(`role-source-${kind}`);
      const failure =
        kind === "quote"
          ? new RecruitingSourceValidationError("jd", "text")
          : new IsolationError("Private source details");
      vi.mocked(executeRecruitingRoleTool).mockRejectedValue(failure);
      f.setCalls([{ name: "recruiting_role", args, executionId: `source-${kind}` }]);
      await f.run();
      const result = {
        error: kind === "quote" ? failure.message : "Recruiting role or source is unavailable",
      };
      expect(f.results).toEqual([result]);
      expect(f.effects[0]).toMatchObject({ status: "completed", result });
      expect(JSON.parse(JSON.stringify(f.effects[0]?.result))).toEqual(result);
      expect(JSON.stringify(result)).not.toContain("Private source details");
      await f.run();
      expect(executeRecruitingRoleTool).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.results).toEqual([result, result]);
      expect(loadRecruitingRunContext).not.toHaveBeenCalled();
    },
  );

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

  it.each(["fresh", "completed replay"])(
    "uses the verified native role answer for context adoption and subsequent tools on %s",
    async (mode) => {
      const f = fixture(`run-verified-role-answer-${mode}`);
      f.runData.sourceMessageId = "vague-trigger";
      f.sourceMessages.push({ id: "vague-trigger", seq: 1 }, { id: "native-role-answer", seq: 2 });
      const answerSource: RecruitingSourceRef = {
        ...source,
        anchor: { kind: "message", messageId: "native-role-answer", locator: "text" },
      };
      const answerReceipt = { ...receipt, source: answerSource };
      const followupFeedback = {
        target: "role" as const,
        operation: "revise" as const,
        roleId: workspace.role.id,
        expectedRoleRevision: 1,
        summary: "Keep personal geometry implementation explicit",
        intent: { basis: "direct" as const, quote: source.quote! },
        sourceRefs: [],
      } satisfies RecruitingFeedbackInput;
      vi.mocked(executeRecruitingFeedback).mockReset().mockResolvedValue({
        status: "proposed",
        feedback: followupFeedback,
        source: answerSource,
        workspace,
        nextTool: "recruiting_role",
      });
      vi.mocked(executeRecruitingRoleTool).mockResolvedValue({
        status: "current",
        workspace,
        source: null,
        changed: false,
      });
      if (mode === "fresh") {
        vi.mocked(executeRecruitingRoleTool).mockResolvedValueOnce(answerReceipt);
      } else {
        f.effects.push({
          id: "verified-role-effect",
          spaceId: "space-1",
          runId: f.runData.id,
          kind: "recruiting_role",
          idempotencyKey: toolEffectIdempotencyKey(f.runData.id, "recruiting_role", args),
          status: "completed",
          request: args,
          result: { ...delivered, source: answerSource },
        });
      }
      vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
      f.setCalls([
        { name: "recruiting_role", args, executionId: "role-answer-create" },
        { name: "recruiting_role", args: { operation: "read" }, executionId: "role-answer-read" },
        {
          name: "recruiting_feedback",
          args: followupFeedback,
          executionId: "role-answer-feedback",
        },
      ]);

      await f.run();

      expect(
        vi.mocked(loadRecruitingRunContext).mock.calls.map((call) => call[4].sourceMessageId),
      ).toEqual(["native-role-answer", "native-role-answer"]);
      const roleCalls = vi.mocked(executeRecruitingRoleTool).mock.calls;
      expect(roleCalls.map((call) => call[2])).toEqual(
        mode === "fresh" ? [args, { operation: "read" }] : [{ operation: "read" }],
      );
      if (mode === "fresh") expect(roleCalls[0]![1].sourceMessageId).toBe("vague-trigger");
      expect(roleCalls.at(-1)![1].sourceMessageId).toBe("native-role-answer");
      expect(vi.mocked(executeRecruitingFeedback).mock.calls[0]![1].sourceMessageId).toBe(
        "native-role-answer",
      );
      expect(f.results[0]).toEqual({ ...delivered, source: answerSource });
      expect(f.memoryCommit).not.toHaveBeenCalled();
    },
  );

  it("keeps newer human steering as the source when replaying an older completed role receipt", async () => {
    const f = fixture("run-role-source-no-regression");
    f.runData.sourceMessageId = "vague-trigger";
    f.sourceMessages.push({ id: "human-answer-1", seq: 2 }, { id: "human-answer-2", seq: 3 });
    const earlierSource: RecruitingSourceRef = {
      ...source,
      anchor: { kind: "message", messageId: "human-answer-1", locator: "text" },
    };
    const laterSource: RecruitingSourceRef = {
      ...source,
      anchor: { kind: "message", messageId: "human-answer-2", locator: "text" },
    };
    f.effects.push({
      id: "older-role-effect",
      spaceId: "space-1",
      runId: f.runData.id,
      kind: "recruiting_role",
      idempotencyKey: toolEffectIdempotencyKey(f.runData.id, "recruiting_role", args),
      status: "completed",
      request: args,
      result: { ...delivered, source: earlierSource },
    });
    f.claimSteering.mockResolvedValue([
      {
        id: "newer-human-steering",
        messageId: "human-answer-2",
        text: "Keep the newer role criteria",
        blocks: [{ kind: "text", text: "Keep the newer role criteria" }],
      },
    ]);
    const followupFeedback = {
      target: "role" as const,
      operation: "revise" as const,
      roleId: workspace.role.id,
      expectedRoleRevision: 1,
      summary: "Keep the newer role criteria",
      intent: { basis: "direct" as const, quote: "Keep the newer role criteria" },
      sourceRefs: [],
    } satisfies RecruitingFeedbackInput;
    vi.mocked(executeRecruitingFeedback).mockReset().mockResolvedValue({
      status: "proposed",
      feedback: followupFeedback,
      source: laterSource,
      workspace,
      nextTool: "recruiting_role",
    });
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    f.runtimeRun.mockImplementation(async function* (request) {
      await request.claimSteering!([]);
      f.results.push(await request.executeTool!("recruiting_role", args, "older-role-replay"));
      f.results.push(
        await request.executeTool!("recruiting_feedback", followupFeedback, "newer-feedback"),
      );
      yield { type: "done" as const, text: "Done" };
    });

    await f.run();

    expect(executeRecruitingRoleTool).not.toHaveBeenCalled();
    expect(vi.mocked(executeRecruitingFeedback).mock.calls[0]![1].sourceMessageId).toBe(
      "human-answer-2",
    );
    expect(f.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: f.runData.threadId }),
        select: { id: true, seq: true },
      }),
    );
    expect(loadRecruitingRunContext).toHaveBeenCalledWith(
      expect.anything(),
      f.runData,
      { documents: [] },
      expect.anything(),
      expect.objectContaining({ reason: "role_tool", sourceMessageId: "human-answer-2" }),
    );
    expect(f.results[0]).toEqual({ ...delivered, source: earlierSource });
    expect(f.effects.filter((effect) => effect.kind === "recruiting_role")).toHaveLength(1);
    expect(f.memoryCommit).not.toHaveBeenCalled();
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
          text: expect.stringContaining(steering[0]!.text),
          historyText: steering[0]!.text,
        }),
        expect.objectContaining({
          messageId: "human-latest",
          text: expect.stringContaining(`${steering[1]!.text}\n\n${adopted.text}`),
          historyText: steering[1]!.text,
        }),
        expect.objectContaining({
          messageId: "peer-message",
          text: steering[2]!.text,
          historyText: steering[2]!.text,
        }),
      ]);
      expect(claimed[0]?.text).toContain('"messageId":"human-first"');
      expect(claimed[1]?.text).toContain('"messageId":"human-latest"');
      expect(claimed[1]?.text).toContain(
        JSON.stringify({
          kind: "message_text",
          blockIndex: 0,
          start: 0,
          end: steering[1]!.text.length,
        }),
      );
      expect(claimed[2]?.text).not.toContain("Native message source reference");
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
      {
        artifacts: f.artifacts,
        context: expect.objectContaining({
          spaceId: f.runData.spaceId,
          userId: f.runData.userId,
          runId: f.runData.id,
        }),
      },
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

describe("native recruiting feedback effect dispatch", () => {
  const feedback = {
    target: "preference" as const,
    operation: "add" as const,
    scope: "bot" as const,
    path: "MEMORY.md",
    expectedRevision: 0,
    intent: { basis: "direct" as const, quote: "Remember to show the complete prompt" },
    sourceRefs: [],
    content: "Show the complete prompt",
  } satisfies RecruitingFeedbackInput;
  const source: RecruitingSourceRef = {
    id: "feedback-source",
    kind: "original_material",
    anchor: { kind: "message", messageId: "human-feedback", locator: "text" },
    readState: "read",
    readAt: "2026-10-15T00:00:00.000Z",
    quote: feedback.intent.quote,
  };
  const saved = {
    status: "saved" as const,
    feedback,
    source,
    workspace: null,
    document: {
      id: "feedback-document",
      scope: feedback.scope,
      path: feedback.path,
      revision: 1,
      anchor: { start: 0, end: feedback.content.length, quote: feedback.content },
    },
  };

  beforeEach(() => {
    vi.mocked(executeRecruitingFeedback).mockReset();
    vi.mocked(executeRecruitingRoleTool).mockReset();
    vi.mocked(loadRecruitingRunContext).mockReset();
  });

  it("offers feedback without graphical tools and keeps it private from messaging channels", () => {
    const options = {
      graphicalToolsAllowed: false,
      pageBrowserAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    for (const semanticMemoryEnabled of [false, true]) {
      expect(
        selectBuiltinToolsForRun({ ...options, semanticMemoryEnabled }).map((tool) => tool.name),
      ).toContain("recruiting_feedback");
    }
    expect(
      selectBuiltinToolsForRun({ ...options, trigger: "messaging", messagingChannelRun: true }).map(
        (tool) => tool.name,
      ),
    ).not.toContain("recruiting_feedback");
  });

  it("claims feedback before the helper and replays its completed receipt without saving twice", async () => {
    const f = fixture("run-feedback");
    f.runData.sourceMessageId = "human-feedback";
    vi.mocked(executeRecruitingFeedback).mockImplementation(
      async (deps, trusted, untrusted, context) => {
        expect(deps.prisma).toBe(f.prisma);
        expect(deps.memory.commit).toBe(f.memoryCommit);
        expect(trusted).toEqual({
          actor: { spaceId: "space-1", userId: "user-1", email: "", isDeploymentOwner: false },
          runId: "run-feedback",
          sourceMessageId: "human-feedback",
        });
        expect(untrusted).toEqual(feedback);
        expect(context).toEqual(expect.objectContaining({ runId: "run-feedback", botId: "bot-1" }));
        expect(f.effects).toEqual([
          expect.objectContaining({
            kind: "recruiting_feedback",
            status: "executing",
            request: feedback,
          }),
        ]);
        return saved;
      },
    );
    f.setCalls([
      { name: "recruiting_feedback", args: feedback, executionId: "feedback-before-restart" },
    ]);

    await f.run();
    f.setCalls([
      { name: "recruiting_feedback", args: feedback, executionId: "feedback-after-restart" },
    ]);
    await f.run();

    expect(executeRecruitingFeedback).toHaveBeenCalledOnce();
    expect(f.results).toEqual([saved, saved]);
    expect(f.effects).toEqual([expect.objectContaining({ status: "completed", result: saved })]);
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(loadRecruitingRunContext).not.toHaveBeenCalled();
  });

  it.each(["fresh", "completed replay"])(
    "uses the verified native feedback answer for subsequent tools on %s",
    async (mode) => {
      const f = fixture(`run-verified-feedback-answer-${mode}`);
      f.runData.sourceMessageId = "vague-trigger";
      f.sourceMessages.push(
        { id: "vague-trigger", seq: 1 },
        { id: "native-feedback-answer", seq: 2 },
      );
      const answerSource: RecruitingSourceRef = {
        ...source,
        anchor: { kind: "message", messageId: "native-feedback-answer", locator: "text" },
      };
      const answerReceipt = { ...saved, source: answerSource };
      vi.mocked(executeRecruitingFeedback).mockResolvedValue(answerReceipt);
      vi.mocked(executeRecruitingRoleTool).mockResolvedValue({
        status: "current",
        workspace: null,
        source: null,
        changed: false,
      });
      if (mode === "completed replay") {
        f.effects.push({
          id: "verified-feedback-effect",
          spaceId: "space-1",
          runId: f.runData.id,
          kind: "recruiting_feedback",
          idempotencyKey: toolEffectIdempotencyKey(f.runData.id, "recruiting_feedback", feedback),
          status: "completed",
          request: feedback,
          result: answerReceipt,
        });
      }
      f.setCalls([
        { name: "recruiting_feedback", args: feedback, executionId: "verified-answer-feedback" },
        {
          name: "recruiting_role",
          args: { operation: "read" },
          executionId: "verified-answer-role-read",
        },
      ]);

      await f.run();

      expect(executeRecruitingFeedback).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 0);
      if (mode === "fresh")
        expect(vi.mocked(executeRecruitingFeedback).mock.calls[0]![1].sourceMessageId).toBe(
          "vague-trigger",
        );
      expect(vi.mocked(executeRecruitingRoleTool).mock.calls[0]![1].sourceMessageId).toBe(
        "native-feedback-answer",
      );
      expect(loadRecruitingRunContext).toHaveBeenCalledWith(
        expect.anything(),
        f.runData,
        { documents: [] },
        expect.anything(),
        expect.objectContaining({ reason: "role_tool", sourceMessageId: "native-feedback-answer" }),
      );
      expect(f.results[0]).toEqual(answerReceipt);
      expect(f.effects.filter((effect) => effect.kind === "recruiting_feedback")).toEqual([
        expect.objectContaining({ status: "completed", result: answerReceipt }),
      ]);
      expect(f.memoryCommit).not.toHaveBeenCalled();
      expect(f.semanticSave).not.toHaveBeenCalled();
    },
  );

  it.each([
    { receiptOrder: "older", receiptSeq: 2, expectedSourceId: "human-answer-2" },
    { receiptOrder: "newer", receiptSeq: 4, expectedSourceId: "human-answer-1" },
  ])(
    "keeps the later source when replaying an $receiptOrder completed feedback receipt after steering",
    async ({ receiptSeq, expectedSourceId }) => {
      const f = fixture("run-feedback-source-no-regression");
      f.runData.sourceMessageId = "vague-trigger";
      f.sourceMessages.push(
        { id: "human-answer-1", seq: receiptSeq },
        { id: "human-answer-2", seq: 3 },
      );
      const receiptSource: RecruitingSourceRef = {
        ...source,
        anchor: { kind: "message", messageId: "human-answer-1", locator: "text" },
      };
      const replayedReceipt = { ...saved, source: receiptSource };
      f.effects.push({
        id: "older-feedback-effect",
        spaceId: "space-1",
        runId: f.runData.id,
        kind: "recruiting_feedback",
        idempotencyKey: toolEffectIdempotencyKey(f.runData.id, "recruiting_feedback", feedback),
        status: "completed",
        request: feedback,
        result: replayedReceipt,
      });
      f.claimSteering.mockResolvedValue([
        {
          id: "newer-human-steering",
          messageId: "human-answer-2",
          text: "Use the latest preference",
          blocks: [{ kind: "text", text: "Use the latest preference" }],
        },
      ]);
      vi.mocked(executeRecruitingRoleTool).mockResolvedValue({
        status: "current",
        workspace: null,
        source: null,
        changed: false,
      });
      f.runtimeRun.mockImplementation(async function* (request) {
        await request.claimSteering!([]);
        f.results.push(
          await request.executeTool!("recruiting_feedback", feedback, "older-feedback-replay"),
        );
        f.results.push(
          await request.executeTool!("recruiting_role", { operation: "read" }, "newer-role-read"),
        );
        yield { type: "done" as const, text: "Done" };
      });

      await f.run();

      expect(executeRecruitingFeedback).not.toHaveBeenCalled();
      expect(vi.mocked(executeRecruitingRoleTool).mock.calls[0]![1].sourceMessageId).toBe(
        expectedSourceId,
      );
      expect(f.prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ threadId: f.runData.threadId }),
          select: { id: true, seq: true },
        }),
      );
      expect(loadRecruitingRunContext).toHaveBeenCalledWith(
        expect.anything(),
        f.runData,
        { documents: [] },
        expect.anything(),
        expect.objectContaining({ reason: "role_tool", sourceMessageId: expectedSourceId }),
      );
      expect(f.results[0]).toEqual(replayedReceipt);
      expect(f.effects.filter((effect) => effect.kind === "recruiting_feedback")).toHaveLength(1);
      expect(f.memoryCommit).not.toHaveBeenCalled();
      expect(f.semanticSave).not.toHaveBeenCalled();
    },
  );

  it("returns inferred feedback for clarification without claiming a memory save", async () => {
    const f = fixture("run-inferred-feedback");
    const inferred = { ...feedback, intent: { ...feedback.intent, basis: "inferred" as const } };
    const result = {
      status: "needs_clarification" as const,
      feedback: inferred,
      source,
      workspace: null,
    };
    vi.mocked(executeRecruitingFeedback).mockResolvedValue(result);
    f.setCalls([{ name: "recruiting_feedback", args: inferred, executionId: "feedback-inferred" }]);

    await f.run();

    expect(f.results).toEqual([result]);
    expect(f.effects[0]?.result).toEqual(result);
    expect(f.results[0]).not.toHaveProperty("document");
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.semanticSave).not.toHaveBeenCalled();
  });

  it("leaves the claimed effect uncertain when feedback fails after native commit acknowledgement is lost", async () => {
    const f = fixture("run-feedback-unknown-commit");
    vi.mocked(executeRecruitingFeedback).mockRejectedValue(
      new Error("native commit acknowledgement lost"),
    );
    f.setCalls([
      { name: "recruiting_feedback", args: feedback, executionId: "feedback-unknown-commit" },
    ]);

    await f.run("native commit acknowledgement lost");

    expect(executeRecruitingFeedback).toHaveBeenCalledOnce();
    expect(f.results).toEqual([]);
    expect(f.effects).toEqual([
      expect.objectContaining({
        kind: "recruiting_feedback",
        status: "executing",
      }),
    ]);
    expect(f.effects[0]).not.toHaveProperty("result");
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.semanticSave).not.toHaveBeenCalled();
  });

  it("returns role feedback as a proposal without applying a role or memory mutation", async () => {
    const f = fixture("run-role-feedback-proposal");
    const proposal = {
      target: "role" as const,
      operation: "revise" as const,
      roleId: "role-1",
      expectedRoleRevision: 1,
      summary: "Clarify personal geometry implementation",
      intent: feedback.intent,
      sourceRefs: [],
    } satisfies RecruitingFeedbackInput;
    const result = {
      status: "proposed" as const,
      nextTool: "recruiting_role" as const,
      feedback: proposal,
      source,
      workspace: null,
    };
    vi.mocked(executeRecruitingFeedback).mockResolvedValue(result);
    f.setCalls([
      { name: "recruiting_feedback", args: proposal, executionId: "role-feedback-proposal" },
    ]);

    await f.run();

    expect(f.results).toEqual([result]);
    expect(f.effects[0]?.result).toEqual(result);
    expect(executeRecruitingRoleTool).not.toHaveBeenCalled();
    expect(loadRecruitingRunContext).not.toHaveBeenCalled();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.semanticSave).not.toHaveBeenCalled();
  });

  it.each([
    { name: "remember", scope: "bot" as const },
    { name: "save_shared_memory", scope: "user" as const },
  ])(
    "routes $name feedback through the helper with the exact native document proposal",
    async ({ name, scope }) => {
      const f = fixture(`run-feedback-${name}`);
      f.runData.sourceMessageId = "human-feedback";
      f.prisma.actionApprovalRule.findMany.mockResolvedValue([
        { effect: "always_allow", matchKind: "tool", matchValue: name },
      ]);
      const proposal = { ...feedback, scope, expectedRevision: 7 };
      const result = {
        ...saved,
        feedback: proposal,
        document: { ...saved.document, scope, revision: 8 },
      };
      const body = `Existing durable fact\n\n${feedback.content}`;
      const args = {
        path: "MEMORY.md",
        content: body,
        expectedRevision: 7,
        recruitingFeedback: proposal,
      };
      vi.mocked(executeRecruitingFeedback).mockImplementation(async () => {
        expect(f.effects).toEqual([
          expect.objectContaining({ kind: name, status: "executing", request: args }),
        ]);
        return result;
      });
      f.setCalls([{ name, args, executionId: "feedback-native-document" }]);

      await f.run();

      expect(executeRecruitingFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          prisma: f.prisma,
          memory: expect.objectContaining({ commit: f.memoryCommit }),
        }),
        expect.objectContaining({ runId: f.runData.id, sourceMessageId: "human-feedback" }),
        proposal,
        expect.objectContaining({ botId: "bot-1" }),
        { expectedMemory: { scope, path: "MEMORY.md", expectedRevision: 7, content: body } },
      );
      expect(f.results).toEqual([result]);
      expect(f.memoryCommit).not.toHaveBeenCalled();
      expect(f.semanticSave).not.toHaveBeenCalled();
      f.setCalls([{ name, args, executionId: "feedback-native-after-restart" }]);
      await f.run();
      expect(executeRecruitingFeedback).toHaveBeenCalledOnce();
      expect(f.results).toEqual([result, result]);
    },
  );

  it.each(["remember", "save_shared_memory", "save_memory"])(
    "rechecks the current role before %s dispatch after a role tool binds midrun",
    async (name) => {
      const f = fixture(`run-feedback-bind-midrun-${name}`);
      f.prisma.actionApprovalRule.findMany.mockResolvedValue([
        { effect: "always_allow", matchKind: "tool", matchValue: name },
      ]);
      if (name === "save_memory") {
        f.memoryProviderResolve.mockResolvedValue({
          provider: f.semanticMemory,
          defaultScope: "isolated",
        });
      }
      vi.mocked(executeRecruitingRoleTool).mockImplementation(async () => {
        f.thread.activeRecruitingRoleId = "role-1";
        return { status: "saved", workspace: null, source: null, changed: true };
      });
      f.setCalls([
        {
          name: "recruiting_role",
          args: {
            operation: "bind",
            roleId: "role-1",
            intent: { basis: "direct", quote: "Use this role" },
          },
          executionId: "bind-role",
        },
        {
          name,
          args: {
            path: "MEMORY.md",
            content: "Ungrounded recruiting preference",
            expectedRevision: 0,
          },
          executionId: "memory-after-bind",
        },
      ]);

      await f.run();

      expect(f.thread.activeRecruitingRoleId).toBe("role-1");
      expect(f.results[1]).toEqual(expect.objectContaining({ error: expect.any(String) }));
      expect(f.memoryCommit).not.toHaveBeenCalled();
      expect(f.semanticSave).not.toHaveBeenCalled();
    },
  );

  it("routes save_memory feedback to native memory without also saving to the semantic provider", async () => {
    const f = fixture("run-feedback-semantic");
    f.thread.activeRecruitingRoleId = "role-1";
    f.memoryProviderResolve.mockResolvedValue({
      provider: f.semanticMemory,
      defaultScope: "isolated",
    });
    const proposal = { ...feedback, expectedRevision: 3 };
    const result = { ...saved, feedback: proposal, document: { ...saved.document, revision: 4 } };
    const body = `Existing durable fact\n\n${feedback.content}`;
    const args = { content: body, recruitingFeedback: proposal };
    vi.mocked(executeRecruitingFeedback).mockImplementation(async () => {
      expect(f.effects).toEqual([
        expect.objectContaining({
          kind: "save_memory",
          status: "executing",
          request: args,
        }),
      ]);
      return result;
    });
    f.setCalls([{ name: "save_memory", args, executionId: "semantic-feedback" }]);

    await f.run();

    expect(executeRecruitingFeedback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: f.runData.id }),
      proposal,
      expect.objectContaining({ botId: "bot-1" }),
      { expectedMemory: { scope: "bot", path: "MEMORY.md", expectedRevision: 3, content: body } },
    );
    expect(f.results).toEqual([result]);
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.semanticSave).not.toHaveBeenCalled();
  });

  it("keeps unbound save_memory without recruiting feedback on the existing semantic path", async () => {
    const f = fixture("run-general-semantic");
    f.memoryProviderResolve.mockResolvedValue({
      provider: f.semanticMemory,
      defaultScope: "isolated",
    });
    f.setCalls([
      {
        name: "save_memory",
        args: { content: "General durable fact" },
        executionId: "ordinary-semantic",
      },
    ]);

    await f.run();

    expect(f.semanticSave).toHaveBeenCalledWith(
      {
        content: "General durable fact",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      expect.objectContaining({ runId: f.runData.id }),
    );
    expect(executeRecruitingFeedback).not.toHaveBeenCalled();
    expect(f.memoryCommit).not.toHaveBeenCalled();
  });

  it("applies the existing shared-memory approval rule before user-scope feedback", async () => {
    const f = fixture("run-feedback-approval");
    const shared = { ...feedback, scope: "user" as const };
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "save_shared_memory" },
    ]);
    vi.mocked(executeRecruitingFeedback).mockResolvedValue({ ...saved, feedback: shared });
    f.setCalls([
      { name: "recruiting_feedback", args: shared, executionId: "shared-feedback-approval" },
    ]);

    await f.run();

    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(executeRecruitingFeedback).not.toHaveBeenCalled();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toEqual([
      expect.objectContaining({ kind: "recruiting_feedback", status: "intended", request: shared }),
    ]);
  });

  it("retains the canonical shared-memory connector approval rule for feedback", async () => {
    const f = fixture("run-feedback-connector-approval");
    const shared = { ...feedback, scope: "user" as const };
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "connector", matchValue: "save" },
    ]);
    f.setCalls([
      { name: "recruiting_feedback", args: shared, executionId: "shared-feedback-connector" },
    ]);
    await f.run();
    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(executeRecruitingFeedback).not.toHaveBeenCalled();
  });

  it("retains feedback's own approval requirement when native bot memory is always allowed", async () => {
    const f = fixture("run-feedback-own-approval");
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "recruiting_feedback" },
      { effect: "always_allow", matchKind: "tool", matchValue: "remember" },
    ]);
    vi.mocked(executeRecruitingFeedback).mockResolvedValue(saved);
    f.setCalls([
      { name: "recruiting_feedback", args: feedback, executionId: "feedback-own-approval" },
    ]);

    await f.run();

    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(executeRecruitingFeedback).not.toHaveBeenCalled();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toEqual([
      expect.objectContaining({
        kind: "recruiting_feedback",
        status: "intended",
        request: feedback,
      }),
    ]);
  });

  it("respects disabled shared memory when feedback requests user scope", async () => {
    const f = fixture("run-feedback-disabled-shared");
    f.disabledBuiltinTools.push("save_shared_memory");
    const shared = { ...feedback, scope: "user" as const };
    vi.mocked(executeRecruitingFeedback).mockResolvedValue({ ...saved, feedback: shared });
    f.setCalls([
      { name: "recruiting_feedback", args: shared, executionId: "shared-feedback-disabled" },
    ]);

    await f.run();

    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(executeRecruitingFeedback).not.toHaveBeenCalled();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.semanticSave).not.toHaveBeenCalled();
  });
});

describe("native recruiting research executor integration", () => {
  const route = {
    connectorId: "mcp",
    resourceId: "research-server",
    resourceRevision: 3,
    toolName: "research",
  };
  const providerArgs = {
    prompt: "Exact current role, actual native memory and this round's request",
  };
  const tool: ConnectorTool = {
    name: "mcp__synthetic__research",
    description: "Synthetic research tool",
    route,
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
  };
  const source: RecruitingSourceRef = {
    id: "verified-research-source",
    kind: "original_material",
    anchor: { kind: "message", messageId: "verified-human", locator: "text" },
    readState: "read",
    readAt: "2026-10-15T00:00:00.000Z",
    quote: "Search this round",
  };
  const task: Parameters<typeof recruitingResearchSnapshot>[0] = {
    id: "research-task",
    roleId: "role-1",
    mcpServerId: route.resourceId,
    serverRevision: 3,
    providerTaskId: null,
    pendingActionId: "research-action",
    state: "active",
    createdByRunId: "origin-run",
  };
  const action: Parameters<typeof recruitingResearchSnapshot>[1] = {
    id: "research-action",
    taskId: task.id,
    roleRevisionId: "role-revision-1",
    runId: "origin-run",
    sourceMessageId: "verified-human",
    clientNonce: "research-round",
    kind: "create",
    deliveryState: "prepared",
    observedProviderState: null,
    requestArtifactId: "research-request-artifact",
    requestArtifactHash: "b".repeat(64),
    contextArtifactId: "research-context-artifact",
    contextArtifactHash: "a".repeat(64),
    recallScope: null,
    receiptArtifactId: null,
    receiptArtifactHash: null,
    cursor: null,
    effectId: "research-effect",
    outputArtifacts: [],
    usage: null,
  };
  const manifest = { operation: "create", route, args: providerArgs, source };
  const rawResult = {
    content: [{ type: "text", text: '{"task_id":"provider-task","status":"queued"}' }],
  };
  const completed = {
    status: "accepted",
    ...recruitingResearchSnapshot(
      { ...task, providerTaskId: "provider-task" },
      { ...action, deliveryState: "accepted" },
    ),
  };
  const start = { operation: "start", actionId: action.id };

  beforeEach(() => {
    vi.mocked(prepareRecruitingResearchTool).mockReset();
    vi.mocked(resolveRecruitingResearchTool)
      .mockReset()
      .mockResolvedValue({
        route,
        args: providerArgs,
        actionId: action.id,
        taskId: task.id,
        operation: "create",
      } as never);
    vi.mocked(admitRecruitingResearchCall).mockReset();
    vi.mocked(bindRecruitingResearchReadCall)
      .mockReset()
      .mockImplementation(async (_deps, _trusted, admitted) => admitted);
    vi.mocked(completeRecruitingResearchCall).mockReset();
    vi.mocked(claimRecruitingResearchAction).mockReset();
    vi.mocked(claimRecruitingResearchReadEffect).mockReset();
    vi.mocked(loadRecruitingRunContext).mockReset();
    vi.mocked(runAutoReviewJudge).mockClear();
  });

  it("prepares with the trusted source and actual loaded context without dispatch and offers the tool without graphics", async () => {
    const f = fixture("run-prepare-research");
    f.runData.sourceMessageId = "human-message";
    const input = {
      operation: "prepare" as const,
      mcpServerId: route.resourceId,
      expectedRoleRevision: 1,
      clientNonce: "research-round",
      instructions: "  Search engineers.\n",
      output: "Name and original source cells",
      recallScope: "This round only: example region",
      intent: { basis: "direct" as const, quote: source.quote! },
    };
    const loaded = {
      text: "Exact role and actual native memory",
      contextArtifact: { artifactId: "context", sha256: "a".repeat(64) },
    } as LoadedRecruitingRunContext;
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(loaded);
    const prepared = {
      status: "prepared",
      ...recruitingResearchSnapshot(task, action),
      source,
      request: providerArgs,
    };
    vi.mocked(prepareRecruitingResearchTool).mockImplementation(
      async (deps, trusted, request, context, loadContext) => {
        expect(deps.prisma).toBe(f.prisma);
        expect(deps.artifacts).toBe(f.artifacts);
        expect(trusted).toEqual({
          actor: { spaceId: "space-1", userId: "user-1", email: "", isDeploymentOwner: false },
          runId: f.runData.id,
          sourceMessageId: "human-message",
        });
        expect(request).toEqual(input);
        expect(context).toEqual(expect.objectContaining({ runId: f.runData.id, botId: "bot-1" }));
        expect(await loadContext("verified-human", input.recallScope)).toBe(loaded);
        return prepared as never;
      },
    );
    f.setCalls([{ name: "recruiting_research", args: input, executionId: "prepare-round" }]);

    await f.run();

    expect(prepareRecruitingResearchTool).toHaveBeenCalledOnce();
    expect(f.results).toEqual([prepared]);
    expect(f.runtimeRun.mock.calls[0]![0].tools.map((entry) => entry.name)).toContain(
      "recruiting_research",
    );
    expect(loadRecruitingRunContext).toHaveBeenCalledWith(
      expect.anything(),
      f.runData,
      { documents: [] },
      expect.anything(),
      expect.objectContaining({
        sourceMessageId: "verified-human",
        recallScope: input.recallScope,
      }),
    );
    expect(f.connector.execute).not.toHaveBeenCalled();
    expect(resolveRecruitingResearchTool).not.toHaveBeenCalled();
    expect(admitRecruitingResearchCall).not.toHaveBeenCalled();
  });

  it("rejects mismatched raw MCP research in admission before creating an effect or invoking the provider", async () => {
    const f = fixture("run-raw-research-mismatch");
    f.connector.discoverTools.mockResolvedValue([tool]);
    f.connector.resolveCall.mockImplementation(async (call) => ({ call, tool }));
    vi.mocked(admitRecruitingResearchCall).mockImplementation(async (_deps, trusted, call) => {
      expect(trusted).toEqual(
        expect.objectContaining({
          runId: f.runData.id,
          leaseOwner: "worker-1",
          leaseFence: f.runData.leaseFence,
        }),
      );
      expect(call).toEqual(
        expect.objectContaining({ route, args: { prompt: "Conditions omitted" } }),
      );
      expect(f.prisma.externalEffect.create).not.toHaveBeenCalled();
      expect(f.connector.execute).not.toHaveBeenCalled();
      throw new IsolationError();
    });
    f.setCalls([
      { name: tool.name, args: { prompt: "Conditions omitted" }, executionId: "raw-mismatch" },
    ]);

    await f.run();

    expect(admitRecruitingResearchCall).toHaveBeenCalledOnce();
    expect(f.results[0]).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(f.effects).toEqual([]);
    expect(f.prisma.externalEffect.create).not.toHaveBeenCalled();
    expect(f.connector.execute).not.toHaveBeenCalled();
    expect(claimRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it("keeps the newer run source after a cached prepare returns an older verified human source", async () => {
    const f = fixture("run-cached-research-source");
    f.runData.sourceMessageId = "new-human";
    f.sourceMessages.push({ id: "old-human", seq: 2 }, { id: "new-human", seq: 3 });
    vi.mocked(prepareRecruitingResearchTool).mockResolvedValue({
      status: "prepared",
      ...recruitingResearchSnapshot(task, action),
      request: providerArgs,
      source: { ...source, anchor: { kind: "message", messageId: "old-human", locator: "text" } },
    } as never);
    vi.mocked(executeRecruitingRoleTool).mockResolvedValue({
      status: "current",
      workspace: null,
      source: null,
      changed: false,
    });
    f.setCalls([
      {
        name: "recruiting_research",
        args: {
          operation: "prepare",
          mcpServerId: route.resourceId,
          expectedRoleRevision: 1,
          clientNonce: "cached-round",
          instructions: "Search engineers",
          output: "Original source cells",
          recallScope: null,
          intent: { basis: "direct", quote: source.quote! },
        },
        executionId: "cached-prepare",
      },
      {
        name: "recruiting_role",
        args: { operation: "read" },
        executionId: "role-after-cached-prepare",
      },
    ]);

    await f.run();

    expect(vi.mocked(executeRecruitingRoleTool).mock.calls.at(-1)![1].sourceMessageId).toBe(
      "new-human",
    );
    expect(f.connector.execute).not.toHaveBeenCalled();
  });

  it.each(["direct", "catalog"])(
    "applies canonical research approval to an admitted raw %s call",
    async (path) => {
      const f = fixture(`run-raw-research-policy-${path}`);
      const entries = catalogEntries([tool]);
      const wrappers = lazyCatalogTools("connectors", "mcp", "MCP", entries);
      const execute = wrappers.find((entry) => entry.route?.toolName === CATALOG_EXECUTE)!;
      f.connector.discoverTools.mockResolvedValue(path === "direct" ? [tool] : wrappers);
      f.connector.resolveCall.mockImplementation(async (call) =>
        call.route?.toolName === CATALOG_EXECUTE ? resolveCatalogCall(call, entries) : undefined,
      );
      f.prisma.actionApprovalRule.findMany.mockResolvedValue([
        { effect: "require_approval", matchKind: "tool", matchValue: "recruiting_research" },
      ]);
      vi.mocked(admitRecruitingResearchCall).mockImplementation(
        async (_deps, trusted, call, _context, options) => {
          const effect: Effect = {
            id: action.effectId!,
            spaceId: "space-1",
            runId: trusted.runId,
            kind: call.tool,
            idempotencyKey: `recruiting-research:${action.id}`,
            status: "intended",
            request: options.frozenRequest,
          };
          f.effects.push(effect);
          return {
            kind: "mutation",
            operation: "create",
            status: "ready",
            task,
            action,
            manifest,
            effect,
            ownerRunId: trusted.runId,
          } as never;
        },
      );
      f.setCalls([
        {
          name: path === "direct" ? tool.name : execute.name,
          args: path === "direct" ? providerArgs : { id: entries[0]!.id, arguments: providerArgs },
          executionId: "raw-needs-canonical-approval",
        },
      ]);

      await f.run();

      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(claimRecruitingResearchAction).not.toHaveBeenCalled();
      expect(f.connector.execute).not.toHaveBeenCalled();
      expect(f.effects).toEqual([expect.objectContaining({ status: "intended" })]);
    },
  );

  it("respects the canonical research disabled flag on an admitted raw MCP call", async () => {
    const f = fixture("run-raw-research-disabled");
    f.disabledBuiltinTools.push("recruiting_research");
    f.connector.discoverTools.mockResolvedValue([tool]);
    vi.mocked(admitRecruitingResearchCall).mockResolvedValue({
      kind: "mutation",
      operation: "create",
      status: "ready",
      task,
      action,
      manifest,
      effect: { id: action.effectId!, status: "intended", request: providerArgs },
      ownerRunId: f.runData.id,
    } as never);
    f.setCalls([{ name: tool.name, args: providerArgs, executionId: "disabled-raw-research" }]);

    await f.run();

    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(claimRecruitingResearchAction).not.toHaveBeenCalled();
    expect(f.connector.execute).not.toHaveBeenCalled();
  });

  it("replays an approved raw catalog call with the exact saved research arguments and domain claim", async () => {
    const f = fixture("run-research-approved-catalog");
    const entries = catalogEntries([tool]);
    const wrappers = lazyCatalogTools("connectors", "mcp", "MCP", entries);
    const execute = wrappers.find((entry) => entry.route?.toolName === CATALOG_EXECUTE)!;
    const frozenRequest = boundDirectApprovalRequest(route, providerArgs, "__rakazoCatalogTool");
    const effect: Effect = {
      id: action.effectId!,
      spaceId: "space-1",
      runId: f.runData.id,
      kind: tool.name,
      idempotencyKey: `recruiting-research:${action.id}`,
      status: "approved",
      request: frozenRequest,
    };
    f.effects.push(effect);
    f.connector.discoverTools.mockResolvedValue(wrappers);
    f.connector.resolveCall.mockImplementation(async (call) =>
      call.route?.toolName === CATALOG_EXECUTE ? resolveCatalogCall(call, entries) : undefined,
    );
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: tool.name },
    ]);
    vi.mocked(admitRecruitingResearchCall).mockImplementation(
      async (_deps, _trusted, call, _context, options) => {
        expect(call).toEqual(
          expect.objectContaining({ tool: tool.name, route, args: providerArgs }),
        );
        expect(options.frozenRequest).toEqual(frozenRequest);
        return {
          kind: "mutation",
          operation: "create",
          status: "ready",
          task,
          action,
          manifest,
          effect,
          ownerRunId: f.runData.id,
        } as never;
      },
    );
    vi.mocked(claimRecruitingResearchAction).mockImplementation(async (_db, _actor, input) => {
      expect(input).toEqual(
        expect.objectContaining({
          actionId: action.id,
          effectId: effect.id,
          from: "approved",
          leaseOwner: "worker-1",
          leaseFence: f.runData.leaseFence,
        }),
      );
      effect.status = "executing";
      return true;
    });
    f.connector.execute.mockImplementation(async function* (call) {
      expect(call).toEqual(
        expect.objectContaining({ route, args: providerArgs, executionId: effect.idempotencyKey }),
      );
      yield { type: "result", data: rawResult };
    });
    vi.mocked(completeRecruitingResearchCall).mockImplementation(
      async (_deps, _trusted, _admission, result) => {
        expect(result).toEqual(rawResult);
        expect(effect).toEqual(expect.objectContaining({ status: "completed", result: rawResult }));
        return completed as never;
      },
    );
    f.setCalls([
      {
        name: execute.name,
        args: {
          id: entries[0]!.id,
          arguments: { prompt: "Reconstructed text must not replace the approved request" },
        },
        executionId: "approved-catalog-replay",
      },
    ]);

    await f.run();

    expect(f.results).toEqual([completed]);
    expect(claimRecruitingResearchAction).toHaveBeenCalledOnce();
    expect(f.connector.execute).toHaveBeenCalledOnce();
    expect(f.prisma.externalEffect.create).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(resolveRecruitingResearchTool).not.toHaveBeenCalled();
  });

  it("recovers status completion from the saved raw read result after interrupted snapshot mapping", async () => {
    const f = fixture("run-research-status-recovery");
    f.prisma.actionAutoReviewPreference.findUnique.mockResolvedValue({ enabled: true });
    const readRoute = { ...route, toolName: "get_task" };
    const readArgs = { task_id: "provider-task", wait_seconds: 0 };
    const readTool: ConnectorTool = {
      ...tool,
      name: "mcp__synthetic__get_task",
      route: readRoute,
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, wait_seconds: { type: "integer" } },
        required: ["task_id", "wait_seconds"],
        additionalProperties: false,
      },
    };
    const rawRead = {
      content: [{ type: "text", text: '{"task_id":"provider-task","status":"completed"}' }],
    };
    const readCompleted = { ...completed, observation: { done: true }, providerResult: rawRead };
    f.connector.discoverTools.mockResolvedValue([readTool]);
    f.connector.resolveCall.mockImplementation(async (call) =>
      call.route?.toolName === CATALOG_EXECUTE
        ? resolveCatalogCall(call, catalogEntries([readTool]))
        : undefined,
    );
    vi.mocked(resolveRecruitingResearchTool).mockResolvedValue({
      route: readRoute,
      args: readArgs,
      taskId: task.id,
      operation: "status",
    } as never);
    vi.mocked(admitRecruitingResearchCall).mockImplementation(async (_deps, _trusted, call) => {
      expect(call).toEqual(expect.objectContaining({ route: readRoute, args: readArgs }));
      return {
        kind: "read",
        operation: "status",
        saved: { task: { ...task, providerTaskId: "provider-task" }, action },
        call,
      } as never;
    });
    f.connector.execute.mockImplementation(async function* () {
      expect(f.effects[0]!.status).toBe("executing");
      yield { type: "result", data: rawRead };
    });
    vi.mocked(claimRecruitingResearchReadEffect).mockImplementation(
      async (_deps, _actor, input) => {
        expect(input).toMatchObject({
          runId: f.runData.id,
          leaseOwner: "worker-1",
          leaseFence: f.runData.leaseFence,
          effectId: f.effects[0]!.id,
          from: "intended",
        });
        f.effects[0]!.status = "executing";
        return true;
      },
    );
    vi.mocked(completeRecruitingResearchCall)
      .mockResolvedValue(readCompleted as never)
      .mockImplementationOnce(async (_deps, _trusted, _admission, result) => {
        expect(result).toEqual(rawRead);
        expect(f.effects).toEqual([
          expect.objectContaining({ status: "completed", result: rawRead }),
        ]);
        throw new Error("status snapshot mapping interrupted");
      });
    f.setCalls([
      {
        name: "recruiting_research",
        args: { operation: "status", taskId: task.id },
        executionId: "status-before-interruption",
      },
    ]);

    await f.run("status snapshot mapping interrupted");

    expect(f.results).toEqual([]);
    f.setCalls([
      {
        name: "recruiting_research",
        args: { operation: "status", taskId: task.id },
        executionId: "status-after-interruption",
      },
    ]);

    await f.run();

    expect(f.results).toEqual([readCompleted]);
    expect(f.effects).toHaveLength(1);
    expect(f.connector.execute).toHaveBeenCalledOnce();
    expect(claimRecruitingResearchAction).not.toHaveBeenCalled();
    expect(runAutoReviewJudge).not.toHaveBeenCalled();
    expect(completeRecruitingResearchCall).toHaveBeenCalledTimes(2);
    expect(completeRecruitingResearchCall).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: "read", operation: "status" }),
      rawRead,
      expect.anything(),
      {
        effectId: f.effects[0]!.id,
        request: f.effects[0]!.request,
        historicalBackfill: true,
      },
    );
    expect(bindRecruitingResearchReadCall).toHaveBeenCalledTimes(2);
    expect(claimRecruitingResearchReadEffect).toHaveBeenCalledOnce();
  });

  it("returns recovered owned read receipts without live resolution or a new effect", async () => {
    const f = fixture("run-research-new-read-recovery");
    const recovered = { status: "recovered", receipts: [completed] };
    vi.mocked(resolveRecruitingResearchTool).mockResolvedValue({
      route: { ...route, toolName: "get_rows" },
      args: { task_id: "provider-task" },
      taskId: task.id,
      operation: "rows",
      recoveredResult: recovered,
    } as never);
    f.setCalls([
      {
        name: "recruiting_research",
        args: { operation: "rows", taskId: task.id },
        executionId: "read-recovered-from-old-run",
      },
    ]);

    await f.run();

    expect(f.results).toEqual([recovered]);
    expect(f.connector.resolveCall).not.toHaveBeenCalled();
    expect(f.connector.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
    expect(admitRecruitingResearchCall).not.toHaveBeenCalled();
    expect(bindRecruitingResearchReadCall).not.toHaveBeenCalled();
  });

  it("binds the exact native read effect before approval and never dispatches on binding failure", async () => {
    const f = fixture("run-research-read-binding");
    const readRoute = { ...route, toolName: "get_task" };
    const args = { task_id: "provider-task", wait_seconds: 0 };
    const readTool: ConnectorTool = {
      ...tool,
      name: "mcp__synthetic__get_task",
      route: readRoute,
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, wait_seconds: { type: "integer" } },
        required: ["task_id", "wait_seconds"],
      },
    };
    f.connector.discoverTools.mockResolvedValue([readTool]);
    vi.mocked(admitRecruitingResearchCall).mockImplementation(
      async (_deps, _trusted, call) =>
        ({
          kind: "read",
          operation: "status",
          saved: { task: { ...task, providerTaskId: "provider-task" }, action },
          call,
        }) as never,
    );
    vi.mocked(bindRecruitingResearchReadCall).mockImplementation(
      async (_deps, trusted, _admitted, effect) => {
        expect(trusted).toMatchObject({
          runId: f.runData.id,
          leaseOwner: "worker-1",
          leaseFence: f.runData.leaseFence,
        });
        expect(f.effects).toEqual([
          expect.objectContaining({ id: effect.id, status: "intended", request: effect.request }),
        ]);
        expect(effect.request).toEqual(
          boundDirectApprovalRequest(readRoute, args, "__rakazoCatalogTool"),
        );
        expect(f.pauseRunForInput).not.toHaveBeenCalled();
        expect(f.connector.execute).not.toHaveBeenCalled();
        throw new IsolationError();
      },
    );
    f.setCalls([{ name: readTool.name, args, executionId: "read-with-missing-binding" }]);

    await f.run("Resource not found");

    expect(bindRecruitingResearchReadCall).toHaveBeenCalledOnce();
    expect(f.connector.execute).not.toHaveBeenCalled();
    expect(completeRecruitingResearchCall).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
  });

  it.each(["intended", "approved"] as const)(
    "rejects a stale read lease at the final %s dispatch boundary",
    async (from) => {
      const f = fixture(`run-research-read-stale-${from}`);
      const readRoute = { ...route, toolName: "get_task" };
      const args = { task_id: "provider-task", wait_seconds: 0 };
      const readTool: ConnectorTool = {
        ...tool,
        name: "mcp__synthetic__get_task",
        route: readRoute,
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { task_id: { type: "string" }, wait_seconds: { type: "integer" } },
          required: ["task_id", "wait_seconds"],
        },
      };
      f.connector.discoverTools.mockResolvedValue([readTool]);
      vi.mocked(admitRecruitingResearchCall).mockImplementation(
        async (_deps, _trusted, call) =>
          ({
            kind: "read",
            operation: "status",
            saved: { task: { ...task, providerTaskId: "provider-task" }, action },
            call,
          }) as never,
      );
      if (from === "approved") {
        f.effects.push({
          id: "approved-read",
          spaceId: "space-1",
          runId: f.runData.id,
          kind: readTool.name,
          idempotencyKey: toolEffectIdempotencyKey(f.runData.id, readTool.name, args),
          status: "approved",
          request: boundDirectApprovalRequest(readRoute, args, "__rakazoCatalogTool"),
        });
      }
      vi.mocked(claimRecruitingResearchReadEffect).mockImplementation(
        async (_deps, _actor, input) => {
          expect(bindRecruitingResearchReadCall).toHaveBeenCalledOnce();
          expect(input).toMatchObject({
            runId: f.runData.id,
            leaseOwner: "worker-1",
            leaseFence: f.runData.leaseFence,
            effectId: f.effects[0]!.id,
            from,
          });
          throw new IsolationError();
        },
      );
      f.setCalls([{ name: readTool.name, args, executionId: "read-after-lease-loss" }]);

      await f.run("Resource not found");

      expect(claimRecruitingResearchReadEffect).toHaveBeenCalledOnce();
      expect(f.connector.execute).not.toHaveBeenCalled();
      expect(completeRecruitingResearchCall).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe(from);
    },
  );

  it("claims the pinned action effect through the domain boundary and saves raw MCP output before completion and cross-run replay", async () => {
    const f = fixture("run-research-original");
    const trace: string[] = [];
    f.connector.discoverTools.mockResolvedValue([tool]);
    f.connector.resolveCall.mockImplementation(async (call) => {
      trace.push("resolve");
      return call.route?.toolName === CATALOG_EXECUTE
        ? resolveCatalogCall(call, catalogEntries([tool]))
        : undefined;
    });
    vi.mocked(admitRecruitingResearchCall).mockImplementationOnce(
      async (_deps, trusted, call, _context, options) => {
        trace.push("admit");
        expect(f.effects).toEqual([]);
        const effect: Effect = {
          id: action.effectId!,
          spaceId: "space-1",
          runId: trusted.runId,
          kind: call.tool,
          idempotencyKey: `recruiting-research:${action.id}`,
          status: "intended",
          request: options.frozenRequest,
        };
        f.effects.push(effect);
        return {
          kind: "mutation",
          operation: "create",
          status: "ready",
          task,
          action,
          manifest,
          effect,
          ownerRunId: trusted.runId,
        } as never;
      },
    );
    vi.mocked(claimRecruitingResearchAction).mockImplementation(async (prisma, actor, input) => {
      trace.push("claim");
      expect(prisma).toBe(f.prisma);
      expect(actor).toEqual({
        spaceId: "space-1",
        userId: "user-1",
        email: "",
        isDeploymentOwner: false,
      });
      expect(input).toEqual({
        runId: f.runData.id,
        leaseOwner: "worker-1",
        leaseFence: f.runData.leaseFence,
        actionId: action.id,
        effectId: action.effectId,
        from: "intended",
      });
      expect(f.effects[0]?.status).toBe("intended");
      f.effects[0]!.status = "executing";
      return true;
    });
    f.connector.execute.mockImplementation(async function* (call) {
      trace.push("execute");
      expect(call).toEqual(
        expect.objectContaining({
          tool: tool.name,
          route,
          args: providerArgs,
          executionId: `recruiting-research:${action.id}`,
        }),
      );
      expect(f.effects[0]?.status).toBe("executing");
      expect(f.prisma.externalEffect.updateMany).not.toHaveBeenCalled();
      yield { type: "result", data: rawResult };
    });
    vi.mocked(completeRecruitingResearchCall).mockImplementation(
      async (_deps, _trusted, admission, result) => {
        trace.push("complete");
        expect(admission).toEqual(
          expect.objectContaining({
            kind: "mutation",
            action: expect.objectContaining({ id: action.id }),
          }),
        );
        expect(result).toEqual(rawResult);
        expect(f.effects[0]).toEqual(
          expect.objectContaining({ status: "completed", result: rawResult }),
        );
        return completed as never;
      },
    );
    f.setCalls([{ name: "recruiting_research", args: start, executionId: "start-research" }]);

    await f.run();

    expect(trace).toEqual(["resolve", "admit", "claim", "execute", "complete"]);
    expect(f.results).toEqual([completed]);
    expect(f.prisma.externalEffect.create).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    const resumed = fixture("run-research-restored");
    resumed.effects.push(...f.effects);
    vi.mocked(resolveRecruitingResearchTool).mockResolvedValue({
      route,
      args: providerArgs,
      actionId: action.id,
      taskId: task.id,
      operation: "create",
      recoveryEffectKind: tool.name,
    } as never);
    resumed.connector.resolveCall.mockRejectedValue(new Error("MCP discovery unavailable"));
    vi.mocked(admitRecruitingResearchCall).mockResolvedValue({
      kind: "mutation",
      operation: "create",
      status: "completed",
      task,
      action,
      manifest,
      effect: f.effects[0],
      ownerRunId: f.runData.id,
    } as never);
    resumed.setCalls([
      { name: "recruiting_research", args: start, executionId: "resume-research" },
    ]);

    await resumed.run();

    expect(claimRecruitingResearchAction).toHaveBeenCalledOnce();
    expect(completeRecruitingResearchCall).toHaveBeenCalledTimes(2);
    expect(resumed.results).toEqual([completed]);
    expect(resumed.effects).toHaveLength(1);
    expect(resumed.connector.execute).not.toHaveBeenCalled();
    expect(resumed.connector.resolveCall).not.toHaveBeenCalled();
    expect(resumed.prisma.externalEffect.create).not.toHaveBeenCalled();
  });

  it("recovers completed admission only and never dispatches or allocates effects for completed, busy or unknown actions", async () => {
    for (const status of ["completed", "busy", "unknown"] as const) {
      const f = fixture(`run-research-${status}`);
      vi.mocked(resolveRecruitingResearchTool).mockResolvedValue({
        route,
        args: providerArgs,
        actionId: action.id,
        taskId: task.id,
        operation: "create",
        recoveryEffectKind: tool.name,
      } as never);
      f.connector.resolveCall.mockRejectedValue(new Error("MCP discovery unavailable"));
      const effect: Effect = {
        id: action.effectId!,
        spaceId: "space-1",
        runId: "origin-run",
        kind: tool.name,
        idempotencyKey: `recruiting-research:${action.id}`,
        request: providerArgs,
        status:
          status === "completed" ? "completed" : status === "busy" ? "executing" : "uncertain",
        ...(status === "completed" ? { result: rawResult } : {}),
      };
      f.effects.push(effect);
      vi.mocked(admitRecruitingResearchCall)
        .mockReset()
        .mockResolvedValue({
          kind: "mutation",
          operation: "create",
          status,
          task,
          action,
          manifest,
          effect,
          ownerRunId: "origin-run",
        } as never);
      vi.mocked(completeRecruitingResearchCall)
        .mockReset()
        .mockResolvedValue(completed as never);
      f.setCalls([{ name: "recruiting_research", args: start, executionId: `research-${status}` }]);

      await f.run();

      expect(admitRecruitingResearchCall).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.prisma.externalEffect.create).not.toHaveBeenCalled();
      expect(f.connector.execute).not.toHaveBeenCalled();
      expect(f.connector.resolveCall).not.toHaveBeenCalled();
      expect(claimRecruitingResearchAction).not.toHaveBeenCalled();
      expect(completeRecruitingResearchCall).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
      expect(f.results[0]).toEqual(
        status === "completed" ? completed : expect.objectContaining({ status }),
      );
      expect(f.results[0]).not.toHaveProperty("effect");
      expect(f.results[0]).not.toHaveProperty("manifest");
      expect(f.results[0]).not.toHaveProperty("action.requestArtifactId");
    }
  });

  it("retains an explicit native research approval rule before claiming or dispatching the pinned action", async () => {
    const f = fixture("run-research-explicit-approval");
    f.connector.discoverTools.mockResolvedValue([tool]);
    f.connector.resolveCall.mockImplementation(async (call) =>
      call.route?.toolName === CATALOG_EXECUTE
        ? resolveCatalogCall(call, catalogEntries([tool]))
        : undefined,
    );
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "recruiting_research" },
    ]);
    vi.mocked(admitRecruitingResearchCall).mockImplementation(
      async (_deps, trusted, call, _context, options) => {
        const effect: Effect = {
          id: action.effectId!,
          spaceId: "space-1",
          runId: trusted.runId,
          kind: call.tool,
          idempotencyKey: `recruiting-research:${action.id}`,
          status: "intended",
          request: options.frozenRequest,
        };
        f.effects.push(effect);
        return {
          kind: "mutation",
          operation: "create",
          status: "ready",
          task,
          action,
          manifest,
          effect,
          ownerRunId: trusted.runId,
        } as never;
      },
    );
    f.setCalls([
      { name: "recruiting_research", args: start, executionId: "research-needs-approval" },
    ]);

    await f.run();

    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(claimRecruitingResearchAction).not.toHaveBeenCalled();
    expect(f.connector.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([
      expect.objectContaining({
        idempotencyKey: `recruiting-research:${action.id}`,
        status: "intended",
      }),
    ]);
    expect(f.prisma.externalEffect.create).not.toHaveBeenCalled();
  });
});

describe("native recruiting assessment effect delivery", () => {
  const args = {
    operation: "save",
    roleId: "role-1",
    roleRevisionId: "revision-1",
    candidateKey: "candidate-1",
    expectedRevision: 0,
    facts: [],
    questions: [],
    sourceRefs: [],
    atomJudgments: [],
    employmentEvaluations: [],
  };
  const saved = {
    assessment: {
      id: "assessment-1",
      version: 1,
      basedOnVersion: 0,
      createdByRunId: "assessment-save",
      roleId: "role-1",
      roleRevisionId: "revision-1",
      candidateKey: "candidate-1",
      facts: [],
      sourceRefs: [],
      questions: [],
      judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" as const },
      createdAt: "2026-10-16T00:00:00.000Z",
    },
    roleRevision: {
      id: "revision-1",
      roleId: "role-1",
      revision: 1,
      criteria: [],
      sourceRefs: [],
      preferences: [],
      definitionQuestions: [],
      createdAt: "2026-10-16T00:00:00.000Z",
    },
    sourceMessageTargets: [],
    isCurrent: true,
  };
  const adopted = {
    text: "current native role",
    contextArtifact: { artifactId: "context-1", sha256: "a".repeat(64) },
  } as LoadedRecruitingRunContext;
  beforeEach(() => {
    vi.mocked(executeRecruitingAssessmentTool).mockReset();
    vi.mocked(retainRecruitingWebMaterial).mockReset();
    vi.mocked(loadRecruitingRunContext).mockReset();
  });

  it("exposes the actual human message identifier and text block indexes for evidence reads", async () => {
    const f = fixture("assessment-source-metadata");
    f.runData.sourceMessageId = "human-evidence-source";
    const human = {
      id: "human-evidence-source",
      seq: 1,
      role: "user",
      runId: null,
      replyToMessageId: null,
      externalTranscriptFor: null,
      createdAt: new Date("2026-10-16T00:00:00.000Z"),
      blocks: [{ kind: "text", text: "Exact source material" }],
    };
    f.prisma.message.findMany.mockResolvedValue([human]);
    f.runtimeRun.mockImplementation(async function* (request) {
      expect(request.instructions).toContain('"messageId":"human-evidence-source"');
      expect(request.instructions).toContain('"blockIndex":0');
      expect(request.instructions).toContain(
        '"selection":{"kind":"message_text","blockIndex":0,"start":0,"end":21}',
      );
      expect(request.instructions).not.toContain('"text":"Exact source material"');
      yield { type: "done" as const, text: "Done" };
    });
    await f.run();
  });

  it("provides exact full-block selections for the current run's native answer on each rebuilt request", async () => {
    const runId = "resumed-native-answer";
    const answerText = ` \r\n${"证".repeat(44)}😀 `;
    expect(answerText).toHaveLength(50);
    const original = {
      id: "original-request",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      botId: null,
      runId,
      replyToMessageId: null,
      externalTranscriptFor: null,
      createdAt: new Date("2026-10-16T00:00:00.000Z"),
      blocks: [{ kind: "text", text: "Assess the supplied candidate" }],
    };
    const answer = {
      ...original,
      id: "native-answer",
      seq: 3,
      blocks: [{ kind: "text", text: answerText }],
    };
    const card = {
      ...original,
      id: "original-card",
      role: "bot",
      botId: "bot-1",
      seq: 2,
      blocks: [
        { kind: "ask", text: "Which implementation?", status: "answered", answer: answerText },
      ],
    };
    const older = { ...answer, id: "older-run-user", runId: "older-run" };
    const botAuthored = {
      ...answer,
      id: "bot-authored-user",
      role: "bot",
      botId: "peer-bot",
      blocks: [{ kind: "text", text: "Old JD from Sourcer" }],
    };
    const peer = {
      ...answer,
      id: "peer-message",
      blocks: [{ kind: "bot_message_received", text: "Peer-authored answer" }],
    };
    for (const laterPause of [undefined, "run.waiting_input", "computer.takeover.requested"]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const f = fixture(runId);
        f.runData.sourceMessageId = original.id;
        f.runData.leaseFence = 1;
        f.prisma.event.findMany.mockResolvedValue([
          { seq: 1, type: "run.waiting_input", payload: {} },
          {
            seq: 2,
            type: "thread.choice",
            payload: {
              messageId: card.id,
              askIndex: 0,
              answerMessageId: answer.id,
              answeredByUserId: "user-1",
            },
          },
        ]);
        if (laterPause)
          f.prisma.event.findMany.mockResolvedValue([
            ...(await f.prisma.event.findMany()),
            { seq: 3, type: laterPause, payload: {} },
          ]);
        f.prisma.task.findUniqueOrThrow.mockResolvedValue({
          id: "task-1",
          prompt: `${original.blocks[0]!.text}\n\nPrior choice\nAnswer: Selected choice choice-1: private-selected-value\n\nWhich implementation?\nAnswer: ${answerText}`,
        });
        const sourceRows = [answer, card, original];
        f.prisma.message.findMany.mockImplementation(async (query) => {
          const ids = (query as { where?: { id?: { in: string[] } } }).where?.id?.in;
          return ids
            ? sourceRows.filter((message) => ids.includes(message.id))
            : [older, botAuthored, peer];
        });
        f.runtimeRun.mockImplementation(async function* (request) {
          expect(request.sourceMessageId).toBe(laterPause ? original.id : answer.id);
          expect(request.prompt.startsWith(answerText)).toBe(!laterPause);
          expect(request.prompt).toContain(answerText);
          expect(request.prompt.includes(original.blocks[0]!.text)).toBe(Boolean(laterPause));
          expect(request.history.find((message) => message.id === original.id)).toMatchObject({
            requiredForRun: true,
            role: "user",
            content: original.blocks[0]!.text,
          });
          expect(request.history.find((message) => message.id === card.id)).toMatchObject({
            requiredForRun: true,
            role: "assistant",
            content: "Which implementation?",
          });
          if (!laterPause) {
            expect(
              request.history.find((message) =>
                message.content.startsWith("Platform task state (data):"),
              ),
            ).toMatchObject({
              requiredForRun: true,
              content: expect.stringContaining("private-selected-value"),
            });
            expect(request.prompt).not.toContain("private-selected-value");
            expect(request.instructions).not.toContain("private-selected-value");
          }
          const metadata = request
            .instructions!.split("\n")
            .filter((line) => line.startsWith("Native message source reference"))
            .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
          expect(metadata.map((source) => source.messageId)).toEqual(
            laterPause ? [original.id, answer.id] : [answer.id, original.id],
          );
          expect(metadata[laterPause ? 1 : 0]).toEqual({
            messageId: answer.id,
            readAt: expect.any(String),
            textBlocks: [
              {
                blockIndex: 0,
                length: 50,
                selection: { kind: "message_text", blockIndex: 0, start: 0, end: 50 },
              },
            ],
          });
          expect(
            request.history.find((message) => message.id === "bot-authored-user"),
          ).toMatchObject({ role: "user", content: "[bot peer-bot] Old JD from Sourcer" });
          expect(request.history.find((message) => message.id === answer.id)?.content).toBe(
            answerText,
          );
          yield { type: "done" as const, text: "Done" };
        });
        await f.run();
      }
    }
  });

  it("uses the latest adopted role and atomically saved receipt, then revalidates replay after an ACK loss", async () => {
    const f = fixture("assessment-save");
    f.thread.activeRecruitingRoleId = "role-1";
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    vi.mocked(executeRecruitingAssessmentTool).mockImplementation(
      async (deps, trusted, input, context) => {
        expect(deps).toEqual(expect.objectContaining({ prisma: f.prisma, artifacts: f.artifacts }));
        expect(input).toEqual(args);
        expect(trusted).toMatchObject({
          runId: "assessment-save",
          threadId: "thread-1",
          botId: "bot-1",
          save: {
            leaseOwner: "worker-1",
            leaseFence: f.runData.leaseFence,
            contextArtifact: adopted.contextArtifact,
            effectId: f.effects[0]?.id,
            effectRequest: args,
          },
        });
        expect(context.runId).toBe("assessment-save");
        expect(f.effects[0]?.status).toBe("executing");
        Object.assign(f.effects[0]!, { status: "completed", result: saved });
        throw new Error("assessment ACK lost");
      },
    );
    f.setCalls([{ name: "recruiting_assess", args, executionId: "before-ack" }]);
    await f.run("assessment ACK lost");
    expect(f.effects).toHaveLength(1);
    expect(f.results).toEqual([]);
    // A restarted run may have no current role; the immutable completed receipt still needs ACL validation.
    f.thread.activeRecruitingRoleId = null;
    vi.mocked(executeRecruitingAssessmentTool).mockImplementation(async (_deps, trusted) => {
      expect(trusted.save?.contextArtifact).toBeUndefined();
      expect(f.effects[0]?.status).toBe("completed");
      return saved as Awaited<ReturnType<typeof executeRecruitingAssessmentTool>>;
    });
    f.setCalls([{ name: "recruiting_assess", args, executionId: "after-ack" }]);
    await f.run();
    expect(executeRecruitingAssessmentTool).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.result).toEqual(saved);
    expect(f.results).toEqual([saved]);
    vi.mocked(executeRecruitingAssessmentTool).mockRejectedValue(new IsolationError());
    await f.run();
    expect(f.results[1]).toEqual({ error: "Recruiting assessment or source is unavailable" });
    expect(f.effects[0]?.result).toEqual(saved);
    expect(f.connector.execute).not.toHaveBeenCalled();
  });

  it("replays a native question receipt to read its actual answer, without overwriting it", async () => {
    const f = fixture("assessment-question");
    const request = {
      operation: "ask",
      roleId: "role-1",
      roleRevisionId: "revision-1",
      target: {
        kind: "candidate",
        candidateKey: "candidate-1",
        assessmentVersion: 1,
        criterionIds: [],
      },
      question: "Which implementation?",
      options: ["Personal", "Team"],
    };
    const binding = {
      roleId: "role-1",
      roleRevisionId: "revision-1",
      target: request.target,
      effectId: "effect-1",
      messageId: "original-card",
      askIndex: 0,
    };
    const paused = {
      kind: "agent_tool_result" as const,
      content: [],
      details: { input: "paused" },
      terminate: true as const,
    };
    vi.mocked(executeRecruitingAssessmentTool).mockImplementationOnce(async (_deps, trusted) => {
      expect(trusted.save?.effectRequest).toEqual(request);
      expect(trusted.attemptId).toBe("attempt-1");
      Object.assign(f.effects[0]!, { status: "completed", result: binding });
      return paused;
    });
    f.setCalls([{ name: "recruiting_assess", args: request, executionId: "ask" }]);
    await f.run();
    expect(f.effects[0]?.result).toEqual(binding);
    const answered = {
      question: { block: { kind: "ask", status: "answered", answer: "Personal" } },
    };
    vi.mocked(executeRecruitingAssessmentTool).mockResolvedValueOnce(answered as never);
    await f.run();
    expect(executeRecruitingAssessmentTool).toHaveBeenCalledTimes(2);
    expect(f.results.at(-1)).toEqual(answered);
    expect(f.effects[0]?.result).toEqual(binding);
    expect(f.effects).toHaveLength(1);
  });

  it("reads without an adopted context and does not dispatch a connector", async () => {
    const f = fixture("assessment-read");
    const read = { operation: "read", candidateKey: "candidate-1" };
    const result = { status: "current" as const, workspace: null, assessment: saved };
    vi.mocked(executeRecruitingAssessmentTool).mockResolvedValue(result);
    f.setCalls([{ name: "recruiting_assess", args: read, executionId: "read" }]);
    await f.run();
    expect(f.results).toEqual([result]);
    expect(executeRecruitingAssessmentTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ save: undefined }),
      read,
      expect.anything(),
    );
    expect(f.connector.execute).not.toHaveBeenCalled();
    // A completed generic read effect must not freeze role selection or source access.
    const updated = { status: "current" as const, workspace: null, assessment: null };
    vi.mocked(executeRecruitingAssessmentTool).mockResolvedValueOnce(updated);
    await f.run();
    expect(executeRecruitingAssessmentTool).toHaveBeenCalledTimes(2);
    expect(f.results[1]).toEqual(updated);
    vi.mocked(executeRecruitingAssessmentTool).mockRejectedValueOnce(new IsolationError());
    await f.run();
    expect(f.results[2]).toEqual({ error: "Recruiting assessment or source is unavailable" });
    expect(f.effects).toHaveLength(1);
  });

  it("redacts delivered evidence on save and completed replay while preserving the immutable receipt", async () => {
    const f = fixture("assessment-redaction", ["private-evidence-value"]);
    const source = {
      id: "source-1",
      kind: "original_material" as const,
      anchor: { kind: "message" as const, messageId: "human-1", locator: "text" },
      readState: "read" as const,
      readAt: "2026-10-16T00:00:00.000Z",
      quote: "private-evidence-value",
      selection: {
        kind: "message_text" as const,
        blockIndex: 0,
        start: 0,
        end: "private-evidence-value".length,
      },
    };
    const input = { ...args, sourceRefs: [source] };
    const receipt = { ...saved, assessment: { ...saved.assessment, sourceRefs: [source] } };
    vi.mocked(executeRecruitingAssessmentTool).mockImplementation(async () => {
      Object.assign(f.effects[0]!, { status: "completed", result: receipt });
      return receipt;
    });
    f.setCalls([{ name: "recruiting_assess", args: input, executionId: "save" }]);
    await f.run();
    await f.run();
    expect(executeRecruitingAssessmentTool).toHaveBeenCalledTimes(2);
    expect(f.results).toHaveLength(2);
    expect(JSON.stringify(f.results)).not.toContain("private-evidence-value");
    expect(JSON.stringify(f.results)).toContain("[redacted]");
    expect(f.effects[0]?.result).toEqual(receipt);
  });

  it.each([
    new RecruitingAssessmentValidationError(
      "Every role atom requires exactly its semantic or employment input",
    ),
    new RecruitingSourceValidationError("jd", "text"),
  ])(
    "settles deterministic assessment validation failures without leaving an executing effect: %s",
    async (failure) => {
      const f = fixture("assessment-invalid-semantics");
      vi.mocked(executeRecruitingAssessmentTool).mockRejectedValue(failure);
      f.setCalls([{ name: "recruiting_assess", args, executionId: "invalid-semantics" }]);
      await f.run();
      expect(f.results).toEqual([{ error: failure.message }]);
      expect(f.effects[0]?.status).toBe("completed");
      await f.run();
      expect(executeRecruitingAssessmentTool).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
    },
  );

  it("retains native web_fetch source receipts before role creation and after binding", async () => {
    const f = fixture("jd-web-source");
    vi.mocked(executeRecruitingRoleTool).mockClear();
    const receipt = {
      artifact: { artifactId: "read-1", sha256: "b".repeat(64) },
      url: "https://example.org/job",
      readAt: "2026-10-16T00:00:00.000Z",
    };
    vi.mocked(retainRecruitingWebMaterial).mockResolvedValue(receipt);
    f.web.fetch.mockResolvedValueOnce({
      url: receipt.url,
      title: "Job page",
      text: "Please enable JavaScript",
      truncated: false,
    });
    f.setCalls([{ name: "web_fetch", args: { url: receipt.url }, executionId: "before-role" }]);
    await f.run();
    expect(f.thread.activeRecruitingRoleId).toBeNull();
    expect(retainRecruitingWebMaterial).toHaveBeenCalledExactlyOnceWith(
      { prisma: f.prisma, artifacts: f.artifacts },
      expect.objectContaining({
        actor: expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
        runId: "jd-web-source",
        threadId: "thread-1",
        botId: "bot-1",
        leaseOwner: "worker-1",
        leaseFence: f.runData.leaseFence,
      }),
      await f.web.fetch.mock.results[0]?.value,
      expect.anything(),
    );
    expect(f.results[0]).toMatchObject({
      text: "Please enable JavaScript",
      truncated: false,
      sourceMaterial: receipt,
    });
    expect(executeRecruitingRoleTool).not.toHaveBeenCalled();
    f.thread.activeRecruitingRoleId = "role-1";
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    await f.run();
    expect(retainRecruitingWebMaterial).toHaveBeenCalledWith(
      { prisma: f.prisma, artifacts: f.artifacts },
      expect.objectContaining({
        runId: "jd-web-source",
        leaseOwner: "worker-1",
        leaseFence: f.runData.leaseFence,
      }),
      await f.web.fetch.mock.results[1]?.value,
      expect.anything(),
    );
    expect(f.results[1]).toMatchObject({ text: "Public evidence", sourceMaterial: receipt });
    f.web.fetch.mockRejectedValueOnce(new Error("not available"));
    await f.run();
    expect(retainRecruitingWebMaterial).toHaveBeenCalledTimes(2);
    expect(f.results[2]).toEqual({ error: "not available" });
  });

  it("clears retained recruiting context when steering removes the selected role", async () => {
    const f = fixture("assessment-unbind-steering");
    f.thread.activeRecruitingRoleId = "role-1";
    vi.mocked(loadRecruitingRunContext).mockResolvedValue(adopted);
    vi.mocked(executeRecruitingAssessmentTool).mockImplementation(async (_deps, trusted) => {
      expect(trusted.save?.contextArtifact).toBeUndefined();
      throw new IsolationError();
    });
    f.claimSteering.mockImplementation(async () => {
      f.thread.activeRecruitingRoleId = null;
      return [
        {
          id: "steering-1",
          messageId: "human-unbind",
          text: "Unselect this role",
          blocks: [{ kind: "text", text: "Unselect this role" }],
        },
      ];
    });
    f.runtimeRun.mockImplementation(async function* (request) {
      await request.claimSteering!([]);
      f.results.push(
        await request.executeTool!(
          "web_fetch",
          { url: "https://example.org/profile" },
          "after-unbind",
        ),
      );
      f.results.push(await request.executeTool!("recruiting_assess", args, "save-after-unbind"));
      yield { type: "done" as const, text: "Done" };
    });
    await f.run();
    expect(f.results).toMatchObject([
      { text: "Public evidence" },
      { error: "Recruiting assessment or source is unavailable" },
    ]);
    expect(retainRecruitingWebMaterial).toHaveBeenCalledOnce();
    expect(executeRecruitingAssessmentTool).toHaveBeenCalledOnce();
  });

  it("offers assessment without a computer and excludes disabled or messaging bots", () => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    expect(selectBuiltinToolsForRun(options).map((tool) => tool.name)).toContain(
      "recruiting_assess",
    );
    expect(
      selectBuiltinToolsForRun({ ...options, disabledBuiltinTools: ["recruiting_assess"] }).map(
        (tool) => tool.name,
      ),
    ).not.toContain("recruiting_assess");
    expect(
      selectBuiltinToolsForRun({ ...options, messagingChannelRun: true }).map((tool) => tool.name),
    ).not.toContain("recruiting_assess");
  });
});
