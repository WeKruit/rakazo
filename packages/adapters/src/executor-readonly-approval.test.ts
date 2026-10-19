import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AutoReviewProvider,
  ConnectorCall,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type * as DatabaseModule from "@rakazo/db";
import type { PauseRunForInput } from "@rakazo/db";
import { IsolationError, RecruitingConflictError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogExecuteToolName, isApprovalPausedResult } from "./approval-effect.js";
import { MAX_SHARED_MEMORY_CHARS } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor, selectBuiltinToolsForRun } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";
import type * as RecruitingAssessmentModule from "./recruiting-assessment.js";

const candidateReads = vi.hoisted(() => vi.fn());
vi.mock("./recruiting-assessment.js", async (original) => ({
  ...(await original<typeof RecruitingAssessmentModule>()),
  executeRecruitingCandidatesTool: candidateReads,
}));
const recruitingApproval = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn() }));
const replyProof = vi.hoisted(() => vi.fn());
const crmApprovalProof = vi.hoisted(() => vi.fn());
const nativeShortlist = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn() }));
const recruitingReply = vi.hoisted(() => ({ resolve: vi.fn(), admit: vi.fn(), claim: vi.fn() }));
const recruitingCrm = vi.hoisted(() => ({
  read: vi.fn(),
  prepare: vi.fn(),
  bind: vi.fn(),
  resolve: vi.fn(),
  admit: vi.fn(),
  claim: vi.fn(),
}));
beforeEach(() => {
  for (const mock of Object.values(recruitingCrm)) mock.mockReset();
  for (const mock of Object.values(recruitingReply)) mock.mockReset();
  crmApprovalProof.mockReset();
  nativeShortlist.prepare.mockReset();
  nativeShortlist.execute.mockReset();
  replyProof.mockReset().mockImplementation(async () => ({
    effectId: "native-email-read",
    result: { structuredContent: replyAnchor },
  }));
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  prepareRecruitingApproval: recruitingApproval.prepare,
  executeRecruitingApproval: recruitingApproval.execute,
  getRecruitingCrmTarget: recruitingCrm.read,
  prepareRecruitingCrmBinding: recruitingCrm.prepare,
  executeRecruitingCrmBinding: recruitingCrm.bind,
  resolveRecruitingCrmImport: recruitingCrm.resolve,
  admitRecruitingCrmImport: recruitingCrm.admit,
  claimRecruitingCrmImport: recruitingCrm.claim,
  readNativeReplyEmailProof: replyProof,
  readNativeCrmWriteApproval: crmApprovalProof,
  prepareNativeRecruitingShortlist: nativeShortlist.prepare,
  executeNativeRecruitingShortlist: nativeShortlist.execute,
  resolveRecruitingReply: recruitingReply.resolve,
  admitRecruitingReply: recruitingReply.admit,
  claimRecruitingReply: recruitingReply.claim,
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const reviewMock = vi.fn();
const autoReviewProvider: AutoReviewProvider = {
  describe: () => ({
    id: "mock",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: { offline: true, keyless: true },
  }),
  review: reviewMock,
};

type Effect = {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
  runId?: string;
};

const replyArgs = {
  reply_to_uuid: "10000000-0000-4000-8000-000000000001",
  eaccount: "recruiter@example.test",
  to: "candidate@example.test",
  subject: "Re: Example role",
  body_text: "Public synthetic draft.",
  skip_validation: false,
};
const replyAnchor = {
  id: replyArgs.reply_to_uuid,
  organization_id: "20000000-0000-4000-8000-000000000001",
  thread_id: "30000000-0000-4000-8000-000000000001",
  timestamp_created: "2026-10-16T00:00:00.000Z",
  timestamp_email: "2026-10-16T00:00:00.000Z",
  message_id: "original@example.test",
  eaccount: replyArgs.eaccount,
  from_address_email: replyArgs.to,
  to_address_email_list: replyArgs.eaccount,
  subject: "Example role",
  body: { text: "Public original question." },
  ue_type: 2,
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  readOnly = true,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  trigger = "user",
  secrets = [] as string[],
  prompt = "Read the item",
  bot = {
    name: "Assistant",
    title: "Assistant",
    description: "Test assistant",
  },
  shutdownSignal,
  builtin = false,
  disabledBuiltinTools = [],
  existingSharedMemory,
  artifacts = false,
  route,
  transportUncertain = false,
  inputSchema,
  connectorResult,
  replyServerEndpoint = "https://mcp.instantly.ai/mcp",
  providerToolName,
  extraTools = [],
  connectorResults = {},
}: {
  providerToolName?: string;
  extraTools?: ConnectorTool[];
  connectorResults?: Record<string, unknown>;
  replyServerEndpoint?: string;
  connectorResult?: unknown;
  inputSchema?: ConnectorTool["inputSchema"];
  transportUncertain?: boolean;
  route?: ConnectorTool["route"];
  artifacts?: boolean;
  builtin?: boolean;
  disabledBuiltinTools?: string[];
  existingSharedMemory?: string;
  name?: string;
  catalog?: boolean;
  readOnly?: boolean;
  rules?: ActionApprovalRule[];
  autoReview?: boolean;
  trigger?: string;
  secrets?: string[];
  prompt?: string;
  bot?: { name: string; title: string; description: string };
  shutdownSignal?: AbortSignal;
} = {}) {
  const connectorId = route?.connectorId ?? "demo";
  const catalogName = catalogExecuteToolName(connectorId);
  const tool: ConnectorTool = {
    name: providerToolName ?? name,
    description: "Read an item",
    readOnly,
    inputSchema: inputSchema ?? {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    route: route ?? { connectorId, resourceId: "resource-1", toolName: name },
  };
  const providerTools = [tool, ...extraTools];
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const sharedMemoryState = {
    content: existingSharedMemory as string | undefined,
    revision: existingSharedMemory === undefined ? 0 : 1,
  };
  const commit = vi.fn(
    async (request: { path: string; content: string; expectedRevision?: number }) => {
      if (
        request.expectedRevision !== undefined &&
        request.expectedRevision !== sharedMemoryState.revision
      ) {
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      }
      sharedMemoryState.content = request.content;
      sharedMemoryState.revision = (sharedMemoryState.revision || 0) + 1;
      return {
        id: "doc-1",
        path: request.path,
        revision: sharedMemoryState.revision,
        content: request.content,
      };
    },
  );
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    leaseFence: 0,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
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
        name: bot.name,
        title: bot.title,
        description: bot.description,
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
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    event: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt })) },
    connection: { findMany: vi.fn(async () => []) },
    mcpServer: {
      findFirst: vi.fn(async () => ({ endpoint: replyServerEndpoint, enabled: true, revision: 1 })),
    },
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
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async (_input: PauseRunForInput) => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    if (transportUncertain) {
      yield { type: "error" as const, message: "Response lost", outcome: "uncertain" as const };
      return;
    }
    yield {
      type: "result" as const,
      data: connectorResults[call.route?.toolName ?? call.tool] ??
        connectorResult ?? { item: call.args.id },
    };
  });
  let calls: { name?: string; args: Record<string, unknown>; executionId: string }[] = [
    { args: { id: "item-1" }, executionId: "call-1" },
  ];
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
  ): AsyncGenerator<AgentRuntimeEvent> {
    for (const call of calls) {
      const result = await request.executeTool!(
        call.name ?? (catalog ? catalogName : name),
        !call.name && catalog
          ? { id: catalogEntries([tool])[0]?.id, arguments: call.args }
          : call.args,
        call.executionId,
      );
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    ...(artifacts ? { artifacts: { get: vi.fn() } } : {}),
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        builtin
          ? providerToolName
            ? providerTools
            : []
          : catalog
            ? [
                {
                  name: catalogName,
                  description: "Execute a catalog tool",
                  inputSchema: { type: "object" },
                  route: { connectorId, toolName: "__catalog_execute" },
                },
              ]
            : [tool],
      resolveCall: async (call: ConnectorCall) =>
        catalog || call.route?.toolName === "__catalog_execute"
          ? resolveCatalogCall(call, catalogEntries(providerTools))
          : undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      read: async (request: { scope: string; path?: string }) => {
        const documents =
          request.scope === "user" &&
          request.path === "MEMORY.md" &&
          sharedMemoryState.content !== undefined
            ? [
                {
                  id: "doc-1",
                  path: "MEMORY.md",
                  content: sharedMemoryState.content,
                  revision: sharedMemoryState.revision,
                  updatedAt: "",
                },
              ]
            : [];
        return { documents };
      },
      commit,
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
    autoReview: autoReviewProvider,
    shutdownSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    prisma,
    effects,
    results,
    execute,
    commit,
    sharedMemoryState,
    pauseRunForInput,
    runtimeRun,
    setCalls(next: typeof calls) {
      calls = next;
    },
    async run({ allowFailure = false } = {}) {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      if (!allowFailure)
        expect(finalizeRun).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed" }),
        );
    },
  };
}

describe("native form pause", () => {
  it("persists the exact schema on the original run's native Ask card", async () => {
    const f = fixture();
    const requestedSchema = {
      type: "object" as const,
      properties: {
        website: { type: "string" as const, format: "uri" as const },
        regions: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["north", "south"] },
        },
      },
      required: ["website"],
    };
    f.runtimeRun.mockImplementation(async function* () {
      yield { type: "ask", text: "Details?", requestedSchema };
    });
    await f.run();
    expect(f.pauseRunForInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        blocks: [expect.objectContaining({ kind: "ask", status: "pending", requestedSchema })],
      }),
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(0);
  });

  it("rejects a secret-bearing schema instead of mutating enum identity", async () => {
    const f = fixture({ secrets: ["protected-test-token"] });
    f.runtimeRun.mockImplementation(async function* () {
      yield {
        type: "ask",
        text: "Details?",
        requestedSchema: {
          type: "object",
          properties: { token: { type: "string", enum: ["protected-test-token", "plain"] } },
        },
      };
    });
    await f.run({ allowFailure: true });
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
  });
});

describe("disabled builtins", () => {
  it("refuses a direct call before any effect or memory write", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      disabledBuiltinTools: ["save_shared_memory", "unknown"],
    });
    f.setCalls([{ args: { content: "Must not be saved" }, executionId: "call-1" }]);
    await f.run();
    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });
});

describe("native saved candidate reads", () => {
  beforeEach(() => candidateReads.mockReset());

  it.each(["user", "webhook"])(
    "dispatches %s reads without approval, effects or connectors",
    async (trigger) => {
      const f = fixture({
        name: "recruiting_candidates",
        builtin: true,
        autoReview: true,
        trigger,
      });
      const page = {
        roleId: "role",
        items: [{ candidateKey: "candidate" }],
        nextCursor: "next",
        total: 8,
      };
      candidateReads.mockResolvedValue(page);
      const args = { operation: "list", query: "Example Candidate", limit: 2 };
      f.setCalls([
        { args, executionId: "first" },
        { args, executionId: "second" },
        {
          args: { operation: "sources", candidateKey: "candidate", limit: 1 },
          executionId: "source",
        },
      ]);
      await f.run();
      expect(candidateReads).toHaveBeenCalledTimes(3);
      expect(candidateReads).toHaveBeenCalledWith(
        { prisma: f.prisma },
        expect.objectContaining({
          actor: expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
          runId: "run-1",
          threadId: "thread-1",
          botId: "bot-1",
        }),
        args,
        expect.objectContaining({ runId: "run-1", botId: "bot-1" }),
      );
      expect(f.results).toEqual([page, page, page]);
      expect(f.effects).toEqual([]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );

  it("honors native tool availability and disable settings", async () => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    expect(selectBuiltinToolsForRun(options).map((tool) => tool.name)).toContain(
      "recruiting_candidates",
    );
    expect(
      selectBuiltinToolsForRun({ ...options, messagingChannelRun: true }).map((tool) => tool.name),
    ).not.toContain("recruiting_candidates");
    const f = fixture({
      name: "recruiting_candidates",
      builtin: true,
      disabledBuiltinTools: ["recruiting_candidates"],
    });
    await f.run();
    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(candidateReads).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });
});

describe("native shortlist dispatch", () => {
  it("recovers an executing uncommitted local shortlist exactly once", async () => {
    const f = fixture({ name: "recruiting_shortlist", builtin: true });
    const args = {
      roleId: "role",
      expectedRoleRevision: 1,
      candidateKey: "candidate",
      expectedRevision: 0,
      shortlisted: true,
    };
    const result = {
      kind: "saved",
      roleId: "role",
      candidateKey: "candidate",
      shortlisted: true,
      revision: 1,
    };
    const interrupted = {
      id: "interrupted",
      spaceId: "space-1",
      runId: "run-1",
      kind: "recruiting_shortlist",
      idempotencyKey: toolEffectIdempotencyKey("run-1", "recruiting_shortlist", args),
      status: "executing",
      request: args,
    };
    f.effects.push(interrupted);
    nativeShortlist.execute.mockImplementation(async (_prisma, _actor, trusted) => {
      expect(trusted).toMatchObject({
        effectId: "interrupted",
        effectRequest: args,
        leaseOwner: "worker-1",
      });
      Object.assign(f.effects[0]!, { status: "completed", result });
      return result;
    });
    f.setCalls([{ args, executionId: "recovery" }]);
    await f.run();
    expect(nativeShortlist.execute).toHaveBeenCalledTimes(1);
    expect(f.results.at(-1)).toEqual(result);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]!.status).toBe("completed");
    await f.run();
    expect(nativeShortlist.execute).toHaveBeenCalledTimes(1);
    expect(f.results.at(-1)).toEqual(result);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["user", "webhook"])(
    "uses native effects and existing approval policy for %s",
    async (trigger) => {
      const f = fixture({ name: "recruiting_shortlist", builtin: true, trigger });
      const args = {
        roleId: "role",
        expectedRoleRevision: 1,
        candidateKey: "candidate",
        expectedRevision: 0,
        shortlisted: true,
      };
      const result = {
        kind: "saved",
        roleId: "role",
        candidateKey: "candidate",
        shortlisted: true,
        revision: 1,
      };
      nativeShortlist.prepare.mockResolvedValue({
        candidateName: "Synthetic Avery",
        roleTitle: "Example role",
        shortlisted: true,
      });
      nativeShortlist.execute.mockImplementation(async (_prisma, _actor, trusted) => {
        Object.assign(f.effects.find((effect) => effect.id === trusted.effectId)!, {
          status: "completed",
          result,
        });
        return result;
      });
      f.setCalls([{ args, executionId: "first" }]);
      await f.run();
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.request).toEqual(args);
      if (trigger === "webhook") {
        expect(nativeShortlist.execute).not.toHaveBeenCalled();
        expect(nativeShortlist.prepare).toHaveBeenCalledWith(
          f.prisma,
          expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
          expect.objectContaining({
            threadId: "thread-1",
            botId: "bot-1",
            runId: "run-1",
            leaseOwner: "worker-1",
          }),
          args,
        );
        const card = f.pauseRunForInput.mock.calls[0]![0].blocks[0];
        if (card?.kind !== "ask") throw new Error("Expected the original approval card");
        expect(card).toMatchObject({ kind: "ask", approvalEffectId: f.effects[0]!.id });
        expect(card.detail).toContain("Synthetic Avery");
        expect(card.detail).not.toContain("candidateKey");
        f.effects[0]!.status = "approved";
        await f.run();
      } else {
        expect(f.pauseRunForInput).not.toHaveBeenCalled();
        expect(nativeShortlist.prepare).not.toHaveBeenCalled();
      }
      expect(nativeShortlist.execute).toHaveBeenCalledTimes(1);
      expect(nativeShortlist.execute).toHaveBeenCalledWith(
        f.prisma,
        expect.objectContaining({ userId: "user-1" }),
        expect.objectContaining({
          threadId: "thread-1",
          botId: "bot-1",
          effectRequest: args,
          effectId: f.effects[0]!.id,
        }),
        args,
      );
      expect(f.results.at(-1)).toEqual(result);
      await f.run();
      expect(nativeShortlist.execute).toHaveBeenCalledTimes(1);
      expect(f.effects).toHaveLength(1);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("is separately disableable without changing read-only candidate access", async () => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    expect(selectBuiltinToolsForRun(options).map((tool) => tool.name)).toContain(
      "recruiting_shortlist",
    );
    expect(
      selectBuiltinToolsForRun({ ...options, messagingChannelRun: true }).map((tool) => tool.name),
    ).not.toContain("recruiting_shortlist");
    const f = fixture({
      name: "recruiting_shortlist",
      builtin: true,
      disabledBuiltinTools: ["recruiting_shortlist"],
    });
    await f.run();
    expect(nativeShortlist.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
  });
});

describe("native saved-candidate CRM workflow", () => {
  const target = {
    mcpServerId: "resource-1",
    serverRevision: 1,
    organizationId: "10000000-0000-4000-8000-000000000001",
    crmRoleId: "20000000-0000-4000-8000-000000000001",
    crmClientId: "30000000-0000-4000-8000-000000000001",
    clientLabel: "Example Robotics",
    roleLabel: "Data Engineer",
  };
  const binding = {
    operation: "bind",
    roleId: "native-role",
    expectedRoleRevision: 1,
    expectedBindingEffectId: null,
    crmRoleReadEffectId: "crm-role-read",
  };
  const source = {
    roleId: "native-role",
    candidateKey: "profile-example",
    bindingEffectId: "binding-effect",
    sourceEffectId: "source-page",
    rowIndex: 0,
  };
  const route = {
    connectorId: "mcp",
    resourceId: target.mcpServerId,
    resourceRevision: target.serverRevision,
    toolName: "crm_import_candidate",
  };
  const args = {
    p_org: target.organizationId,
    p_role: target.crmRoleId,
    p_name: "Example Candidate",
    p_linkedin_url: "https://www.linkedin.com/in/example-candidate",
    p_source_file: "rakazo:artifact:source-file:sha256:fixture:row:0",
  };

  beforeEach(() => {
    recruitingCrm.prepare.mockResolvedValue({ target, roleTitle: "Native data role" });
    recruitingCrm.bind.mockResolvedValue({
      status: "connected",
      roleId: binding.roleId,
      bindingEffectId: "effect-1",
      target,
    });
  });

  it("confirms a real CRM target once and replays the original binding on its card", async () => {
    const f = fixture({
      name: "recruiting_crm_target",
      builtin: true,
      autoReview: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "recruiting_crm_target" }],
    });
    f.setCalls([{ args: binding, executionId: "bind-target" }]);
    await f.run();
    expect(recruitingCrm.prepare).toHaveBeenCalledOnce();
    expect(recruitingCrm.bind).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            detail: expect.stringContaining(target.clientLabel),
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ],
      }),
    );
    f.effects[0]!.status = "approved";
    f.setCalls([
      {
        args: { ...binding, crmRoleReadEffectId: "changed-after-approval" },
        executionId: "replay",
      },
    ]);
    await f.run();
    expect(recruitingCrm.bind).toHaveBeenCalledWith(
      f.prisma,
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
      expect.objectContaining({ effectId: f.effects[0]!.id, effectRequest: binding }),
      binding,
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("reads the selected CRM target without another approval or provider call", async () => {
    const result = { roleId: source.roleId, bindingEffectId: source.bindingEffectId, target };
    recruitingCrm.read.mockResolvedValue(result);
    const f = fixture({ name: "recruiting_crm_target", builtin: true, autoReview: true });
    f.setCalls([
      { args: { operation: "read", roleId: source.roleId }, executionId: "read-target" },
    ]);
    await f.run();
    expect(recruitingCrm.read).toHaveBeenCalledWith(
      f.prisma,
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
      { runId: "run-1", roleId: source.roleId },
    );
    expect(f.results).toEqual([result]);
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "binds an exact saved occurrence before asking and claims it on catalog=%s replay",
    async (catalog) => {
      const f = fixture({
        name: "renamed_import",
        catalog,
        route,
        readOnly: true,
        inputSchema: { type: "object" },
      });
      recruitingCrm.resolve.mockImplementation(async () => ({
        input: source,
        target,
        route,
        args,
        effect: f.effects[0],
      }));
      recruitingCrm.admit.mockImplementation(async (_prisma, _actor, _trusted, input, call) => {
        expect(input).toEqual(source);
        let effect = f.effects[0];
        if (!effect) {
          effect = {
            id: "import-effect",
            kind: call.effectKind,
            idempotencyKey: "native-source-import",
            status: "intended",
            request: call.effectRequest,
            runId: "run-1",
          };
          f.effects.push(effect);
        }
        expect(call.effectKind).toBe(effect.kind);
        expect(call.effectRequest).toEqual(effect.request);
        return { status: effect.status === "completed" ? "completed" : "ready", effect };
      });
      recruitingCrm.claim.mockImplementation(async (_prisma, _actor, _trusted, input, call) => {
        expect(input).toEqual(source);
        expect(call).toMatchObject({ effectId: "import-effect", from: "approved" });
        f.effects[0]!.status = "executing";
        return true;
      });
      f.setCalls([{ name: "recruiting_crm_import", args: source, executionId: "import-source" }]);
      await f.run();
      expect(recruitingCrm.admit).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(recruitingCrm.claim).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();

      f.effects[0]!.status = "approved";
      f.setCalls([
        {
          name: catalog ? catalogExecuteToolName("mcp") : "renamed_import",
          args: catalog
            ? { id: "resource-1:crm_import_candidate", arguments: { p_name: "Changed by model" } }
            : { p_name: "Changed by model" },
          executionId: "direct-replay",
        },
      ]);
      await f.run();
      expect(recruitingCrm.resolve).toHaveBeenLastCalledWith(
        f.prisma,
        expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
        expect.objectContaining({ runId: "run-1", approvedEffectId: "import-effect" }),
        null,
      );
      expect(recruitingCrm.claim).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute.mock.calls[0]?.[0].args).toEqual(args);
      expect(f.effects).toHaveLength(1);
      const saved = f.effects[0]!.result;
      recruitingCrm.resolve.mockResolvedValue({
        input: source,
        target,
        route,
        args,
        effect: f.effects[0],
      });
      f.setCalls([{ name: "recruiting_crm_import", args: source, executionId: "inspect-saved" }]);
      await f.run();
      expect(f.results.at(-1)).toEqual(saved);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
    },
  );

  it("honors disabled native imports when their approved effect resumes through direct MCP", async () => {
    const f = fixture({
      name: "renamed_import",
      route,
      inputSchema: { type: "object" },
      disabledBuiltinTools: ["recruiting_crm_import"],
    });
    const effect = {
      id: "disabled-import",
      kind: "renamed_import",
      idempotencyKey: "disabled-source",
      status: "approved",
      request: ["__rakazoCatalogTool", "direct", { route, args }],
      runId: "run-1",
    };
    f.effects.push(effect);
    recruitingCrm.resolve.mockResolvedValue({ input: source, target, route, args, effect });
    f.setCalls([{ name: "renamed_import", args, executionId: "disabled-resume" }]);
    await f.run();
    expect(f.results[0]).toEqual({ error: "This tool is disabled for this bot." });
    expect(recruitingCrm.admit).not.toHaveBeenCalled();
    expect(recruitingCrm.claim).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(effect.status).toBe("approved");
  });

  it.each(["busy", "stopped", "unknown"] as const)(
    "does not dispatch a saved import with %s admission",
    async (status) => {
      const f = fixture({ name: "renamed_import", route, inputSchema: { type: "object" } });
      const effect = {
        id: "existing-import",
        kind: "renamed_import",
        idempotencyKey: "saved-crm-source",
        status: status === "stopped" ? "approved" : "executing",
        request: ["__rakazoCatalogTool", "direct", { route, args }],
        runId: "run-1",
      };
      f.effects.push(effect);
      recruitingCrm.resolve.mockResolvedValue({ input: source, target, route, args, effect });
      recruitingCrm.admit.mockResolvedValue({ status, effect });
      f.setCalls([{ name: "recruiting_crm_import", args: source, executionId: "inspect-import" }]);
      await f.run();
      expect(recruitingCrm.claim).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(f.effects).toHaveLength(1);
      if (status === "unknown") {
        expect(effect.status).toBe("uncertain");
        expect(f.results[0]).toMatchObject({ uncertain: true });
      } else {
        expect(f.results[0]).toMatchObject({ status, automaticRetry: false });
      }
    },
  );

  it("blocks an approved import whose domain claim rejects a changed binding", async () => {
    const f = fixture({ name: "renamed_import", route, inputSchema: { type: "object" } });
    const effect = {
      id: "stale-approved-import",
      kind: "renamed_import",
      idempotencyKey: "stale-crm-source",
      status: "approved",
      request: ["__rakazoCatalogTool", "direct", { route, args }],
      runId: "run-1",
    };
    f.effects.push(effect);
    recruitingCrm.resolve.mockResolvedValue({ input: source, target, route, args, effect });
    recruitingCrm.admit.mockResolvedValue({ status: "ready", effect });
    recruitingCrm.claim.mockRejectedValue(new RecruitingConflictError());
    f.setCalls([{ name: "recruiting_crm_import", args: source, executionId: "stale-claim" }]);
    await f.run();
    expect(f.results[0]).toMatchObject({ code: "CONFLICT" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(effect.status).toBe("approved");
  });
});

describe.each([
  "crm_import_candidate",
  "reply_to_email",
  "create_lead",
  "add_leads_to_campaign_or_list_bulk",
  "activate_campaign",
])("native one-time MCP mutation approval: %s", (operation) => {
  it("retains uncertainty for a known mutation even when its server advertises it as read-only", async () => {
    const f = fixture({
      name: "renamed_import",
      readOnly: true,
      transportUncertain: true,
      route: {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: operation,
      },
      ...(operation === "reply_to_email" ? { inputSchema: { type: "object" } } : {}),
    });
    if (operation === "reply_to_email") f.setCalls([{ args: replyArgs, executionId: "reply" }]);
    await f.run();
    expect(f.execute).not.toHaveBeenCalled();
    f.effects[0]!.status = "approved";
    await f.run();
    expect(f.effects[0]).toMatchObject({ status: "uncertain", result: { uncertain: true } });
    const result = f.effects[0]!.result;
    await f.run();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.results.at(-1)).toEqual(result);
  });

  for (const catalog of [false, true]) {
    it(`requires one exact human approval for ${catalog ? "catalog" : "direct"} mutations despite permanent allowance`, async () => {
      reviewMock
        .mockReset()
        .mockResolvedValue({ decision: "allow", reason: "pass", model: "test" });
      const f = fixture({
        name: "renamed_import",
        catalog,
        readOnly: true,
        autoReview: true,
        route: {
          connectorId: "mcp",
          resourceId: "resource-1",
          resourceRevision: 1,
          toolName: operation,
        },
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "renamed_import" }],
        ...(operation === "reply_to_email" ? { inputSchema: { type: "object" } } : {}),
      });
      if (operation === "reply_to_email") f.setCalls([{ args: replyArgs, executionId: "reply" }]);
      await f.run();
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]?.status).toBe("intended");
      expect(f.execute).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [
            expect.objectContaining({
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            }),
          ],
        }),
      );
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { id: "changed-after-approval" }, executionId: "replay" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute.mock.calls[0]?.[0].args).toEqual(
        operation === "reply_to_email" ? replyArgs : { id: "item-1" },
      );
    });
  }
});

describe.each([false, true])("verified CRM approval target, catalog=%s", (catalog) => {
  it.each(["crm_update_candidate_stage", "crm_append_candidate_note"])(
    "keeps the trusted %s card separate from the immutable write payload",
    async (operation) => {
      const note = `  Exact note.\n${"Keep complete content. ".repeat(230)}  `;
      const args = {
        p_org: "internal-org",
        p_candidate: "internal-candidate",
        p_role: "internal-role",
        p_expected_updated_at: "exact-cas-token",
        ...(operation === "crm_append_candidate_note"
          ? { p_expected_notes: "Old private notes", p_note: note }
          : { p_expected_stage: "Screening", p_stage: "Interview" }),
      };
      const route = {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: operation,
      };
      const f = fixture({
        name: "renamed_write",
        catalog,
        readOnly: true,
        autoReview: true,
        inputSchema: { type: "object" },
        route,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "renamed_write" }],
      });
      crmApprovalProof.mockResolvedValue({
        candidateName: "Ada Example",
        roleTitle: "Platform Engineer",
        ...(operation === "crm_append_candidate_note"
          ? { note }
          : { currentStage: "Screening", newStage: "Interview" }),
      });
      f.setCalls([{ args, executionId: "crm-change" }]);
      await f.run();
      expect(crmApprovalProof).toHaveBeenCalledWith(
        f.prisma,
        expect.anything(),
        expect.objectContaining({ runId: "run-1", threadId: "thread-1", botId: "bot-1" }),
        { route, args },
      );
      expect(f.execute).not.toHaveBeenCalled();
      const card = f.pauseRunForInput.mock.calls[0]?.[0].blocks[0];
      if (card?.kind !== "ask") throw new Error("Expected the original approval card");
      expect(card).toMatchObject({
        approvalEffectId: f.effects[0]?.id,
        text:
          operation === "crm_append_candidate_note" ? "Review CRM note" : "Review CRM stage change",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      });
      expect(card.detail).toContain("Candidate: Ada Example\nRole: Platform Engineer");
      expect(card.detail).not.toMatch(/internal-|exact-cas-token|Old private|expected_|crm_/);
      if (operation === "crm_append_candidate_note") expect(card.detail).toContain(note);
      const request = structuredClone(f.effects[0]!.request);
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { p_note: "Changed after approval" }, executionId: "replay" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute.mock.calls[0]?.[0].args).toEqual(args);
      expect(f.effects[0]!.request).toEqual(request);
      expect(crmApprovalProof).toHaveBeenCalledOnce();
    },
  );
  it("returns a corrective read result without an approval card when target proof is missing", async () => {
    const f = fixture({
      name: "renamed_write",
      catalog,
      readOnly: true,
      inputSchema: { type: "object" },
      route: {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: "crm_append_candidate_note",
      },
    });
    crmApprovalProof.mockRejectedValue(new IsolationError());
    f.setCalls([
      { args: { candidateName: "Model-supplied label", p_note: "New note" }, executionId: "write" },
    ]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects[0]).toMatchObject({
      status: "completed",
      result: {
        error: expect.stringContaining("get_crm_candidate_review"),
      },
    });
  });
});

describe.each([false, true])("native outbound draft approval, catalog=%s", (catalog) => {
  function replyFixture(connectorResult?: unknown) {
    const f = fixture({
      name: "renamed_reply",
      catalog,
      readOnly: true,
      inputSchema: { type: "object" },
      connectorResult,
      route: {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: "reply_to_email",
      },
    });
    f.setCalls([{ args: replyArgs, executionId: "reply" }]);
    return f;
  }
  const sentEmail = {
    ...replyAnchor,
    id: "10000000-0000-4000-8000-000000000002",
    message_id: "sent@example.test",
    from_address_email: replyArgs.eaccount,
    to_address_email_list: replyArgs.to,
    subject: replyArgs.subject,
    body: { text: replyArgs.body_text },
    ue_type: 3,
  };

  it.each([
    null,
    { effectId: "read", result: { structuredContent: { ...replyAnchor, ue_type: 3 } } },
    {
      effectId: "read",
      result: { structuredContent: { ...replyAnchor, from_address_email: "other@example.test" } },
    },
    { effectId: "read", result: { isError: true, structuredContent: replyAnchor } },
  ])("requires a verified original inbound read before showing a card: %s", async (proof) => {
    replyProof.mockResolvedValue(proof);
    const f = replyFixture();
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toMatchObject({ error: expect.any(String), dispatched: false });
  });

  it("rejects implicit recipients and disabled provider validation before approval", async () => {
    const { to: _to, ...implicitRecipient } = replyArgs;
    for (const args of [implicitRecipient, { ...replyArgs, skip_validation: true }]) {
      const f = replyFixture();
      f.setCalls([{ args, executionId: "invalid-reply" }]);
      await f.run();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toMatchObject({ dispatched: false });
    }
  });

  it("rechecks source ownership before claiming an approved effect", async () => {
    const f = replyFixture();
    await f.run();
    f.effects[0]!.status = "approved";
    replyProof.mockResolvedValue(null);
    await f.run({ allowFailure: true });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects[0]!.status).toBe("approved");
    expect(f.results.at(-1)).toMatchObject({ dispatched: false });
  });

  it("uses the current recruiting role when a role was selected after the attempt began", async () => {
    const f = replyFixture();
    f.prisma.thread.findUniqueOrThrow
      .mockResolvedValueOnce({ id: "thread-1", groupId: null })
      .mockResolvedValue({
        id: "thread-1",
        groupId: null,
        activeRecruitingRoleId: "selected-role",
      } as never);
    await f.run();
    expect(f.results.at(-1)).toMatchObject({
      error: expect.stringContaining("recruiting_reply"),
      dispatched: false,
    });
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rechecks a newly selected recruiting role at the final raw-reply claim", async () => {
    const f = replyFixture({ structuredContent: sentEmail });
    await f.run();
    f.effects[0]!.status = "approved";
    replyProof.mockImplementationOnce(async () => {
      f.prisma.thread.findUniqueOrThrow.mockResolvedValue({
        id: "thread-1",
        groupId: null,
        activeRecruitingRoleId: "selected-role",
      } as never);
      return { effectId: "native-email-read", result: { structuredContent: replyAnchor } };
    });
    await f.run();
    expect(f.results.at(-1)).toMatchObject({
      error: expect.stringContaining("recruiting_reply"),
      dispatched: false,
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects[0]!.status).toBe("approved");
  });

  it("keeps the original approved request through source failure and repair within the same attempt", async () => {
    const f = replyFixture({ structuredContent: sentEmail });
    await f.run();
    f.effects[0]!.status = "approved";
    replyProof.mockResolvedValueOnce(null);
    f.setCalls([
      {
        args: { ...replyArgs, body_text: "Changed first reconstruction" },
        executionId: "missing-proof",
      },
      {
        args: {
          ...replyArgs,
          to: "other@example.test",
          body_text: "Changed second reconstruction",
        },
        executionId: "repaired-proof",
      },
    ]);
    await f.run();
    expect(f.results.at(-2)).toMatchObject({ dispatched: false });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]?.[0].args).toEqual(replyArgs);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]!.status).toBe("completed");
  });

  it("leaves another MCP provider's same-name reply contract intact", async () => {
    const f = fixture({
      name: "another_reply",
      catalog,
      readOnly: false,
      replyServerEndpoint: "https://mail.example.test/mcp",
      route: {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: "reply_to_email",
      },
    });
    await f.run();
    f.effects[0]!.status = "approved";
    await f.run();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]?.[0].args).toEqual({ id: "item-1" });
    expect(f.results.at(-1)).toEqual({ item: "item-1" });
    expect(replyProof).not.toHaveBeenCalled();
  });

  it("uses one retained proof snapshot before consuming the approved request", async () => {
    const f = replyFixture({ structuredContent: sentEmail });
    await f.run();
    f.effects[0]!.status = "approved";
    replyProof.mockClear();
    replyProof
      .mockResolvedValueOnce({
        effectId: "native-email-read",
        result: { structuredContent: replyAnchor },
      })
      .mockResolvedValueOnce(null);
    await f.run();
    expect(replyProof).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.effects[0]!.status).toBe("completed");
    await f.run();
    expect(replyProof).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each([
    [3, "sent_recorded"],
    [4, "scheduled"],
  ] as const)("records only the correlated provider outcome %s", async (ue_type, status) => {
    const providerResult = { structuredContent: { ...sentEmail, ue_type } };
    const f = replyFixture(providerResult);
    await f.run();
    f.effects[0]!.status = "approved";
    await f.run();
    expect(f.results.at(-1)).toMatchObject({
      status,
      sourceReadEffectId: "native-email-read",
      receipt: { emailId: sentEmail.id, replyToEmailId: replyArgs.reply_to_uuid },
      providerResult,
    });
    expect(f.effects[0]!.status).toBe("completed");
    const saved = f.effects[0]!.result;
    replyProof.mockResolvedValue(null);
    await f.run();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.results.at(-1)).toEqual(saved);
  });

  it.each([
    { structuredContent: { success: true } },
    { structuredContent: { ...sentEmail, thread_id: "30000000-0000-4000-8000-000000000002" } },
    { isError: true, structuredContent: sentEmail },
  ])(
    "retains an unverifiable provider response as uncertain without resend: %s",
    async (providerResult) => {
      const f = replyFixture(providerResult);
      await f.run();
      f.effects[0]!.status = "approved";
      await f.run();
      expect(f.effects[0]).toMatchObject({
        status: "uncertain",
        result: { uncertain: true, providerResult },
      });
      const saved = f.effects[0]!.result;
      replyProof.mockResolvedValue(null);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual(saved);
    },
  );

  it("shows the complete draft and restores its exact account, recipient and body after approval", async () => {
    const args = {
      reply_to_uuid: "10000000-0000-4000-8000-000000000001",
      eaccount: "recruiter@example.test",
      to: "candidate@example.test",
      subject: "Re: Example role",
      body_text: `${"Public synthetic draft with Unicode 🧭.\n".repeat(160)}END_OF_DRAFT`,
      skip_validation: false,
    };
    const f = fixture({
      name: "renamed_reply",
      catalog,
      readOnly: true,
      autoReview: true,
      inputSchema: { type: "object" },
      route: {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: "reply_to_email",
      },
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "renamed_reply" }],
    });
    f.setCalls([{ args, executionId: "prepare-draft" }]);
    await f.run();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            detail: expect.stringContaining(args.body_text),
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ],
      }),
    );
    f.effects[0]!.status = "approved";
    f.setCalls([
      {
        args: {
          ...args,
          eaccount: "changed-sender@example.test",
          to: "changed@example.test",
          reply_to_uuid: "10000000-0000-4000-8000-000000000002",
          subject: "Changed subject",
          body_text: "Changed reconstruction",
          skip_validation: true,
        },
        executionId: "resume-approved-draft",
      },
    ]);
    await f.run();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]?.[0].args).toEqual(args);
    expect(f.effects).toHaveLength(1);
  });
});

describe("Composio one-time outbound approval", () => {
  const route = { connectorId: "composio", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL" };
  const args = {
    tools: [
      { tool_slug: "GOOGLECALENDAR_FREE_BUSY_QUERY", arguments: {} },
      {
        tool_slug: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: {
          tools: [
            {
              tool_slug: "GMAIL_SEND_EMAIL",
              account: "mail-account-one",
              arguments: {
                recipient_email: "candidate@example.test",
                subject: "Approved subject",
                body: "Approved content",
              },
            },
          ],
        },
      },
    ],
    sync_response_to_workbench: false,
  };

  it.each([
    { catalog: false, autoReview: false },
    { catalog: true, autoReview: false },
    { catalog: false, autoReview: true },
    { catalog: true, autoReview: true },
  ])("keeps nested outbound approval exact for %j", async ({ catalog, autoReview }) => {
    reviewMock.mockReset().mockResolvedValue({ decision: "pass", model: "mock" });
    const f = fixture({
      name: "renamed_batch",
      catalog,
      route,
      readOnly: true,
      autoReview,
      rules: autoReview
        ? []
        : [{ effect: "always_allow", matchKind: "tool", matchValue: "renamed_batch" }],
      inputSchema: { type: "object" },
    });
    f.setCalls([{ args, executionId: "draft-batch" }]);
    await f.run();
    expect(f.execute).not.toHaveBeenCalled();
    expect(reviewMock).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            detail: expect.stringContaining("Approved content"),
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ],
      }),
    );

    f.effects[0]!.status = "approved";
    f.setCalls([
      {
        args: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] },
        executionId: "resume-batch",
      },
    ]);
    await f.run();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ route, args });
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]!.status).toBe("completed");
    expect(reviewMock).not.toHaveBeenCalled();
  });
});

describe("candidate-linked native reply", () => {
  const target = {
    mcpServerId: "crm-server",
    serverRevision: 1,
    organizationId: "40000000-0000-4000-8000-000000000001",
    crmRoleId: "50000000-0000-4000-8000-000000000001",
    crmClientId: "60000000-0000-4000-8000-000000000001",
    clientLabel: "Example Client",
    roleLabel: "Example role",
  };
  const receipt = {
    candidate_id: "70000000-0000-4000-8000-000000000001",
    source_id: "80000000-0000-4000-8000-000000000001",
    membership_id: "90000000-0000-4000-8000-000000000001",
    organization_id: target.organizationId,
    role_spec_id: target.crmRoleId,
    linkedin_identity: "/in/example-candidate",
    source_file: "synthetic-source",
  };
  const input = {
    roleId: "native-role",
    expectedRoleRevision: 1,
    crmImportEffectId: "crm-import",
    mcpServerId: "resource-1",
    serverRevision: 1,
    replyToEmailId: replyArgs.reply_to_uuid,
    subject: replyArgs.subject,
    body: { text: replyArgs.body_text },
  };
  const { subject: _subject, body: _body, ...references } = input;
  const crmResult = {
    structuredContent: {
      data: {
        candidate: {
          id: receipt.candidate_id,
          organization_id: target.organizationId,
          email: replyArgs.to,
          linkedin_url: "https://www.linkedin.com/in/example-candidate",
          linkedin_identity: receipt.linkedin_identity,
          status: "replied",
        },
        pipeline: {
          candidate_id: receipt.candidate_id,
          organization_id: target.organizationId,
          role_spec_id: target.crmRoleId,
          stage: "Interested",
          reviewed: true,
          review_result: "approved",
          campaign_id: null,
          last_reply_at: null,
          last_email_id: null,
          updated_at: "2026-10-16T00:00:00Z",
        },
        roleInterests: [
          {
            role_key: "Example role (Example Client)",
            client_label: "Example Client",
            role_label: "Example role",
            interest: "interested",
            source: "manual",
          },
        ],
        canWrite: true,
        suppressed: false,
      },
    },
  };
  const route = {
    connectorId: "mcp",
    resourceId: "resource-1",
    resourceRevision: 1,
    toolName: "reply_to_email",
  };
  function linkedFixture(
    fullHistory = true,
    options: { disabledBuiltinTools?: string[]; replyServerEndpoint?: string } = {},
  ) {
    const f = fixture({
      name: "recruiting_reply",
      builtin: true,
      providerToolName: "mcp__mail__reply_to_email",
      ...options,
      route,
      inputSchema: { type: "object" },
      extraTools: [
        {
          name: "mcp__crm__context",
          description: "Read",
          inputSchema: { type: "object" },
          readOnly: true,
          route: {
            connectorId: "mcp",
            resourceId: "crm-server",
            resourceRevision: 1,
            toolName: "get_crm_candidate_outreach_context",
          },
        },
        ...["get_email", "list_emails"].map((toolName) => ({
          name: `mcp__mail__${toolName}`,
          description: "Read",
          inputSchema: {
            type: "object",
            ...(toolName === "list_emails" && fullHistory
              ? {
                  properties: {
                    mode: { type: "string", enum: ["emode_all"] },
                    latest_of_thread: { type: "boolean" },
                    preview_only: { type: "boolean" },
                    eaccount: { type: "string" },
                    limit: { type: "number" },
                    starting_after: { type: "string" },
                  },
                }
              : {}),
          },
          readOnly: true,
          route: { ...route, toolName },
        })),
      ],
      connectorResults: {
        get_crm_candidate_outreach_context: crmResult,
        get_email: { structuredContent: replyAnchor },
        list_emails: { structuredContent: { items: [replyAnchor] } },
      },
    });
    const selection = {
      input: references,
      target,
      crmImportReceipt: receipt,
      role: { id: input.roleId, title: "Example role", revision: 1 },
      roleRevision: { id: "role-revision" },
      route,
      emailProof: { effectId: "native-email-read", result: { structuredContent: replyAnchor } },
      crmProof: { effectId: "native-crm-read", result: crmResult },
    };
    recruitingReply.resolve.mockImplementation(async () => ({
      ...selection,
      effect: f.effects.find((effect) => effect.id === "candidate-reply"),
    }));
    recruitingReply.admit.mockImplementation(async (_prisma, _actor, _trusted, _input, native) => {
      let effect = f.effects.find((effect) => effect.id === "candidate-reply");
      if (!effect) {
        effect = {
          id: "candidate-reply",
          runId: "run-1",
          kind: native.effectKind,
          request: native.effectRequest,
          idempotencyKey: "reply-round",
          status: "intended",
        };
        f.effects.push(effect);
      }
      return { status: "ready", effect };
    });
    f.setCalls([{ name: "recruiting_reply", args: input, executionId: "draft" }]);
    return Object.assign(f, { selection });
  }
  it("saves the exact candidate/source reply on its native one-time card", async () => {
    const f = linkedFixture();
    await f.run();
    expect(recruitingReply.resolve).toHaveBeenCalledWith(
      f.prisma,
      expect.anything(),
      expect.anything(),
      references,
    );
    expect(recruitingReply.admit).toHaveBeenCalledWith(
      f.prisma,
      expect.anything(),
      expect.anything(),
      references,
      expect.objectContaining({
        emailReadEffectId: "native-email-read",
        crmContextReadEffectId: "native-crm-read",
        identity: expect.objectContaining({
          crmCandidateId: receipt.candidate_id,
          anchorId: input.replyToEmailId,
        }),
      }),
    );
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            approvalEffectId: "candidate-reply",
            detail: expect.stringContaining(replyArgs.body_text),
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ],
      }),
    );
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("performs and saves fresh native reads after approval but does not bypass missing source coverage", async () => {
    const f = linkedFixture();
    await f.run();
    f.effects[0]!.status = "approved";
    f.setCalls([
      {
        name: "mcp__mail__reply_to_email",
        args: { ...replyArgs, to: "changed@example.test", body_text: "Changed" },
        executionId: "approved",
      },
    ]);
    await f.run({ allowFailure: true });
    expect(f.execute.mock.calls.map(([call]) => call.route?.toolName)).toEqual([
      "get_crm_candidate_outreach_context",
      "get_email",
      "list_emails",
    ]);
    expect(recruitingReply.claim).not.toHaveBeenCalled();
    expect(f.effects.find((effect) => effect.id === "candidate-reply")?.status).toBe("approved");
    expect(f.results.at(-1)).toMatchObject({
      status: "incomplete",
      dispatched: false,
      gaps: ["legacy_hold_sources", "gmail_history"],
    });
    expect(f.effects.filter((effect) => effect.status === "completed")).toHaveLength(3);
  });
  it("records a new preflight observation instead of replaying an older identical read", async () => {
    const f = linkedFixture();
    await f.run();
    f.effects[0]!.status = "approved";
    const stale = {
      id: "old-email-read",
      runId: "run-1",
      kind: "get_email",
      idempotencyKey: "old-read",
      status: "completed",
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: { ...route, toolName: "get_email" },
          args: { id: input.replyToEmailId },
        },
      ],
      result: { structuredContent: { ...replyAnchor, subject: "Older observation" } },
    };
    f.effects.push(stale);
    await f.run({ allowFailure: true });
    const fresh = f.effects.filter(
      (effect) => effect.kind === "get_email" && effect.id !== stale.id,
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      status: "completed",
      result: { structuredContent: replyAnchor },
    });
    expect(stale.result.structuredContent.subject).toBe("Older observation");
    expect(f.results.at(-1)).toMatchObject({
      readEffectIds: expect.arrayContaining([fresh[0]!.id]),
      dispatched: false,
    });
  });
  it("does not present a sendable draft for a suppressed candidate", async () => {
    const f = linkedFixture();
    f.selection.crmProof.result = {
      structuredContent: { data: { ...crmResult.structuredContent.data, suppressed: true } },
    };
    await f.run();
    expect(f.results.at(-1)).toMatchObject({
      status: "blocked",
      reasons: ["crm_suppressed"],
      dispatched: false,
    });
    expect(recruitingReply.admit).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
  });
  it("rejects incomplete provider history capabilities before dispatching unsupported list arguments", async () => {
    const f = linkedFixture(false);
    await f.run();
    f.effects[0]!.status = "approved";
    await f.run({ allowFailure: true });
    expect(f.execute.mock.calls.map(([call]) => call.route?.toolName)).toEqual([
      "get_crm_candidate_outreach_context",
      "get_email",
    ]);
    expect(f.results.at(-1)).toMatchObject({
      status: "incomplete",
      reasons: ["provider_history_scope_unknown"],
      dispatched: false,
    });
    expect(recruitingReply.claim).not.toHaveBeenCalled();
  });
  it("keeps the preflight at the final claim even when approval arrives after the attempt snapshot", async () => {
    const f = linkedFixture();
    await f.run();
    f.effects[0]!.status = "approved";
    f.prisma.externalEffect.findMany.mockImplementation(async ({ where } = {}) =>
      where?.status === "approved" ? [] : f.effects,
    );
    await f.run();
    expect(f.results.at(-1)).toMatchObject({ status: "incomplete", dispatched: false });
    expect(recruitingReply.claim).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.some(([call]) => call.route?.toolName === "reply_to_email")).toBe(
      false,
    );
  });
  it("returns the original terminal effect without new reads or send attempts", async () => {
    const f = linkedFixture();
    await f.run();
    f.effects[0]!.status = "completed";
    f.effects[0]!.result = {
      status: "sent_recorded",
      receipt: { emailId: "saved-provider-email" },
    };
    await f.run();
    expect(f.results.at(-1)).toEqual(f.effects[0]!.result);
    expect(f.execute).not.toHaveBeenCalled();
    expect(recruitingReply.admit).toHaveBeenCalledOnce();
  });
  it("rejects a linked reply on another provider before admitting a draft", async () => {
    const f = linkedFixture(true, { replyServerEndpoint: "https://mail.example.test/mcp" });
    await f.run();
    expect(f.results.at(-1)).toMatchObject({ error: expect.any(String), dispatched: false });
    expect(recruitingReply.admit).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects disabled linked approval replay before any remote reads", async () => {
    const f = linkedFixture(true, { disabledBuiltinTools: ["recruiting_reply"] });
    f.effects.push({
      id: "candidate-reply",
      runId: "run-1",
      kind: "mcp__mail__reply_to_email",
      request: ["__rakazoCatalogTool", "direct", { route, args: replyArgs }],
      idempotencyKey: "reply-round",
      status: "approved",
    });
    f.setCalls([{ name: "mcp__mail__reply_to_email", args: replyArgs, executionId: "disabled" }]);
    await f.run({ allowFailure: true });
    expect(f.results.at(-1)).toEqual({ error: "This tool is disabled for this bot." });
    expect(f.execute).not.toHaveBeenCalled();
    expect(recruitingReply.admit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
  });
});

describe("native recruiting package approval", () => {
  const args = {
    stage: "documents",
    roleId: "role-example",
    expectedRoleRevision: 2,
    documents: {
      jdText: { artifactId: "jd-text", sha256: "a".repeat(64) },
      namedPdf: { artifactId: "jd-pdf", sha256: "b".repeat(64) },
      anonymousPdf: null,
      deck: null,
    },
  };
  const file = {
    kind: "file",
    artifactId: "jd-pdf",
    mimeType: "application/pdf",
    name: "JD.pdf",
    size: 128,
  };
  beforeEach(() => {
    recruitingApproval.prepare.mockReset().mockResolvedValue({ files: [file] });
    recruitingApproval.execute.mockReset();
    reviewMock.mockReset();
  });
  function approvalFixture() {
    const f = fixture({
      name: "recruiting_request_approval",
      builtin: true,
      artifacts: true,
      autoReview: true,
      rules: [
        { effect: "always_allow", matchKind: "tool", matchValue: "recruiting_request_approval" },
      ],
    });
    f.setCalls([{ args, executionId: "approval-1" }]);
    return f;
  }
  it("shows verified files and a one-time card despite always-allow and auto review", async () => {
    const f = approvalFixture();
    await f.run();
    expect(recruitingApproval.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
      expect.objectContaining({
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        leaseOwner: "worker-1",
      }),
      args,
      expect.objectContaining({ artifacts: expect.anything() }),
    );
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          file,
          expect.objectContaining({
            kind: "ask",
            approvalEffectId: f.effects[0]!.id,
            actions: [
              expect.objectContaining({ id: "allow" }),
              expect.objectContaining({ id: "deny" }),
            ],
          }),
        ],
      }),
    );
    expect(f.effects[0]!.request).toEqual(args);
    expect(recruitingApproval.execute).not.toHaveBeenCalled();
    expect(reviewMock).not.toHaveBeenCalled();
  });
  it("rejects an unavailable package without creating a misleading approval card", async () => {
    const { RecruitingConflictError } = await import("@rakazo/db");
    const conflict = new RecruitingConflictError();
    recruitingApproval.prepare.mockRejectedValue(conflict);
    const f = approvalFixture();
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(recruitingApproval.execute).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({ error: conflict.message, code: "CONFLICT" });
  });
  it("resumes the original approved payload once and retains its immutable receipt", async () => {
    const f = approvalFixture();
    await f.run();
    f.effects[0]!.status = "approved";
    const result = { status: "approved", stage: "documents", approvalEffectId: f.effects[0]!.id };
    recruitingApproval.execute.mockImplementation(async () => {
      Object.assign(f.effects[0]!, { status: "completed", result });
      return result;
    });
    f.setCalls([{ args: { ...args, expectedRoleRevision: 99 }, executionId: "approval-2" }]);
    await f.run();
    expect(recruitingApproval.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ effectId: f.effects[0]!.id, effectRequest: args }),
      args,
      expect.anything(),
    );
    expect(f.results.at(-1)).toEqual(result);
    expect(f.effects).toHaveLength(1);
    f.setCalls([{ args, executionId: "approval-3" }]);
    await f.run();
    expect(recruitingApproval.execute).toHaveBeenCalledOnce();
    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(f.results.at(-1)).toEqual(result);
  });
});

describe("connector read-only metadata and approval enforcement", () => {
  beforeEach(() => {
    reviewMock.mockReset();
  });

  it.each(["shell", "write_file"])(
    "forces owner approval for webhook-triggered %s despite an allow rule",
    async (name) => {
      const f = fixture({
        name,
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      if (name === "write_file")
        f.setCalls([
          { args: { path: "shared/note.md", content: "A saved note." }, executionId: "call-1" },
        ]);
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );

  it("writes shared memory directly, including when an always-allow rule exists", async () => {
    const args = {
      path: " MEMORY.md ",
      content: "Printing: all print jobs go to Clyde.",
      expectedRevision: 0,
    };
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      autoReview: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "save_shared_memory" }],
    });
    f.setCalls([{ args, executionId: "call-1" }]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(reviewMock).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "user",
        path: "MEMORY.md",
        content: args.content,
        expectedRevision: 0,
      }),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
    expect(f.commit.mock.calls[0]![0]).not.toHaveProperty("botId");
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("replaces an existing shared document at the caller's loaded revision", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
    });
    f.setCalls([
      {
        args: { path: "MEMORY.md", content: "New rule", expectedRevision: 1 },
        executionId: "call-1",
      },
    ]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: "New rule", expectedRevision: 1 }),
      expect.anything(),
    );
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 2 });
  });

  it("does not overwrite shared memory that changed after it was read", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
    });
    // The caller prepared its text at revision 0, before the existing edit landed.
    f.setCalls([
      {
        args: { path: "MEMORY.md", content: "New rule", expectedRevision: 0 },
        executionId: "call-1",
      },
    ]);
    await f.run();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 0 }),
      expect.anything(),
    );
    expect(f.sharedMemoryState.content).toBe("Old rule");
    expect(f.results.at(-1)).toEqual({ error: MEMORY_REVISION_CONFLICT_ERROR, currentRevision: 1 });
  });

  it.each(["remember", "save_shared_memory"])("requires a loaded revision for %s", async (name) => {
    const f = fixture({ name, builtin: true });
    f.setCalls([{ args: { path: "MEMORY.md", content: "New rule" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({ error: "expectedRevision must be a nonnegative integer" });
  });

  it("reads a native document with its current revision before editing", async () => {
    const f = fixture({ name: "read_memory", builtin: true, existingSharedMemory: "Old rule" });
    f.setCalls([{ args: { scope: "user", path: "MEMORY.md" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({
      scope: "user",
      path: "MEMORY.md",
      content: "Old rule",
      revision: 1,
    });
  });

  it("revokes the last shared preference with an empty-body revision", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
    });
    f.setCalls([
      { args: { path: "MEMORY.md", content: "", expectedRevision: 1 }, executionId: "call-1" },
    ]);
    await f.run();
    expect(f.sharedMemoryState).toEqual({ content: "", revision: 2 });
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 2 });
  });

  it("rejects shared memory content over the size limit", async () => {
    const args = {
      path: "MEMORY.md",
      content: "x".repeat(MAX_SHARED_MEMORY_CHARS + 1),
    };
    const f = fixture({ name: "save_shared_memory", builtin: true });
    f.setCalls([{ args, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({
      error: `content exceeds ${MAX_SHARED_MEMORY_CHARS} characters`,
    });
  });

  it("rejects a shared memory save without a path", async () => {
    const f = fixture({ name: "save_shared_memory", builtin: true });
    f.setCalls([{ args: { path: "  ", content: "ok" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({ error: "path is required" });
  });

  describe.each([false, true])("catalog = %s", (catalog) => {
    it.each(["tool", "connector"] as const)(
      "honors an explicit %s approval rule",
      async (matchKind) => {
        const f = fixture({
          catalog,
          autoReview: true,
          rules: [
            {
              effect: "require_approval",
              matchKind,
              matchValue: matchKind === "tool" ? "demo_get_item" : "demo",
            },
          ],
        });
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
        expect(f.pauseRunForInput).toHaveBeenCalledWith(
          expect.objectContaining({
            blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: f.effects[0]!.id })],
          }),
        );
        expect(isApprovalPausedResult(f.results[0])).toBe(true);
        expect(reviewMock).not.toHaveBeenCalled();
      },
    );

    it("replays the approved arguments once and returns the result on retry", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: { id: "item-1" },
          executionId: approvalEffectKey("run-1", "demo_get_item", { id: "item-1" }),
        }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("executes a later identical-args call after an approved replay when approval is not required by default", async () => {
      const args = { id: "item-1" };
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([
        { args, executionId: "call-2" },
        { args, executionId: "call-3" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.effects).toHaveLength(2);
      expect(f.effects[0]?.idempotencyKey).toBe(approvalEffectKey("run-1", "demo_get_item", args));
      expect(f.effects[1]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", args, 1),
      );
      expect(f.results.slice(1)).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("honors a persisted denial on a new tool call id", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "denied";
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toEqual({
        error:
          "The user denied this action. Do not retry or rephrase it; tell the user and ask what they want instead.",
      });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("consumes the saved approval after the user chooses always allow", async () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("allows ordinary reads without approval or automatic review", async () => {
      const f = fixture({ catalog, autoReview: true });
      f.setCalls([
        { args: { id: "item-1" }, executionId: "call-1" },
        { args: { id: "item-1" }, executionId: "call-2" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.results).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("replays a non-approval connector effect when the tool-call id changes", async () => {
      const f = fixture({ catalog });
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects[0]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", { id: "item-1" }),
      );

      f.setCalls([{ args: { id: "item-1" }, executionId: "call-new" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
    });

    it("keeps an explicit allow rule ahead of automatic review", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for webhook-triggered writes despite an allow rule", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for a webhook-triggered read-named write operation", async () => {
      const f = fixture({
        catalog,
        name: "demo_read_profile_card",
        readOnly: false,
        trigger: "webhook",
        rules: [
          { effect: "always_allow", matchKind: "tool", matchValue: "demo_read_profile_card" },
        ],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
    });

    it("lets a webhook-triggered declared read run unattended", async () => {
      const f = fixture({ catalog, trigger: "webhook" });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("treats a read-named write operation as consequential for automatic review", async () => {
      reviewMock.mockResolvedValue({ decision: "ask", reason: "Writes data", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_find_validator_record",
        readOnly: false,
        autoReview: true,
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it.each(["ask", "error", "pass"] as const)(
      "honors automatic review %s despite a read-only hint",
      async (decision) => {
        reviewMock.mockResolvedValue({
          decision,
          reason: "Review result",
          model: "scripted/checker",
        });
        const f = fixture({ catalog, name: "demo_send_message", autoReview: true });
        await f.run();
        expect(reviewMock).toHaveBeenCalledOnce();
        expect(reviewMock).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "demo_send_message", connectorKind: "demo" }),
          expect.objectContaining({ runId: "run-1" }),
        );
        expect(f.effects[0]?.reviewDecision).toBe(decision);
        expect(f.execute).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
        expect(f.pauseRunForInput).toHaveBeenCalledTimes(decision === "pass" ? 0 : 1);
      },
    );

    it("redacts run secrets from automatic review task and bot context", async () => {
      reviewMock.mockResolvedValue({ decision: "pass", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        secrets: ["super-secret-token"],
        prompt: "Send mail with super-secret-token",
        bot: {
          name: "Mail",
          title: "Helper",
          description: "Uses super-secret-token",
        },
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userTask: "Send mail with [redacted]",
          botDescription: "Mail: Helper\nUses [redacted]",
        }),
        expect.objectContaining({ runId: "run-1" }),
      );
    });

    it("does not persist a review decision when the run is cancelled", async () => {
      const shutdown = new AbortController();
      reviewMock.mockImplementation(async () => {
        shutdown.abort();
        return { decision: "error", reason: "Checker timed out or failed.", model: "mock" };
      });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        shutdownSignal: shutdown.signal,
      });
      await f.run();
      expect(f.effects[0]?.reviewDecision).toBeUndefined();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });
  });
});
