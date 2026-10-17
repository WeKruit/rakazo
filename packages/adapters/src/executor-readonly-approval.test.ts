import type {
  AgentRunRequest,
  AutoReviewProvider,
  ConnectorCall,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type * as DatabaseModule from "@rakazo/db";
import { RecruitingConflictError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogExecuteToolName, isApprovalPausedResult } from "./approval-effect.js";
import { MAX_SHARED_MEMORY_CHARS } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";

const recruitingApproval = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn() }));
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
}: {
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
    name,
    description: "Read an item",
    readOnly,
    inputSchema: inputSchema ?? {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    route: route ?? { connectorId, resourceId: "resource-1", toolName: name },
  };
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
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    if (transportUncertain) {
      yield { type: "error" as const, message: "Response lost", outcome: "uncertain" as const };
      return;
    }
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls: { name?: string; args: Record<string, unknown>; executionId: string }[] = [
    { args: { id: "item-1" }, executionId: "call-1" },
  ];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
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
          ? []
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
          ? resolveCatalogCall(call, catalogEntries([tool]))
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
    setCalls(next: typeof calls) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

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

describe("native CRM import approval", () => {
  it("retains uncertainty for a known import even when its server advertises it as read-only", async () => {
    const f = fixture({
      name: "renamed_import",
      readOnly: true,
      transportUncertain: true,
      route: {
        connectorId: "mcp",
        resourceId: "resource-1",
        resourceRevision: 1,
        toolName: "crm_import_candidate",
      },
    });
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
    it(`requires one exact human approval for ${catalog ? "catalog" : "direct"} CRM imports despite permanent allowance`, async () => {
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
          toolName: "crm_import_candidate",
        },
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "renamed_import" }],
      });
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
      expect(f.execute.mock.calls[0]?.[0].args).toEqual({ id: "item-1" });
    });
  }
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
