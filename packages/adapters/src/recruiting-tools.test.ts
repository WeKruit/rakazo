import type { Actor } from "@rakazo/contracts";
import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import {
  admitRecruitingResearchAction,
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  prepareRecruitingResearchAction,
  readRecruitingResearchContext,
  reconcileRecruitingResearchAction,
  recordRecruitingResearchObservation,
  recruitingResearchSnapshot,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { boundDirectApprovalRequest } from "./approval-effect.js";
import type { LoadedRecruitingRunContext } from "./recruiting-context.js";
import { buildRecruitingResearchRequest } from "./recruiting-research.js";
import * as tools from "./recruiting-tools.js";
import { executeRecruitingRoleTool } from "./recruiting-tools.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  executeRecruitingRoleMutation: vi.fn(),
  getRecruitingWorkspace: vi.fn(),
  readRecruitingResearchContext: vi.fn(),
  prepareRecruitingResearchAction: vi.fn(),
  recruitingResearchSnapshot: vi.fn(),
  admitRecruitingResearchAction: vi.fn(),
  reconcileRecruitingResearchAction: vi.fn(),
  recordRecruitingResearchObservation: vi.fn(),
}));

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const context = { actor, runId: "run", sourceMessageId: "human-message" };
const workspace = { role: { id: "role" }, revision: { id: "revision" } };

describe("native recruiting_role", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the actual owned run's thread without requiring new human consent", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      ...actor,
      id: "run",
      threadId: "actual-thread",
      bot: actor,
      trigger: "bot_message",
    });
    vi.mocked(getRecruitingWorkspace).mockResolvedValue(workspace as never);
    const prisma = { run: { findFirst } } as unknown as PrismaClient;
    expect(
      await executeRecruitingRoleTool(
        prisma,
        { ...context, sourceMessageId: null },
        { operation: "read" },
      ),
    ).toEqual({
      status: "current",
      workspace,
      source: null,
      changed: false,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run", spaceId: actor.spaceId, userId: actor.userId },
      }),
    );
    expect(getRecruitingWorkspace).toHaveBeenCalledWith(prisma, actor, {
      threadId: "actual-thread",
    });
    expect(executeRecruitingRoleMutation).not.toHaveBeenCalled();
  });

  it("does not disclose a workspace through a missing, foreign, or foreign-bot run", async () => {
    for (const run of [
      null,
      { ...actor, userId: "other", bot: actor },
      { ...actor, bot: { ...actor, userId: "other" } },
    ]) {
      const prisma = {
        run: { findFirst: vi.fn().mockResolvedValue(run) },
      } as unknown as PrismaClient;
      await expect(
        executeRecruitingRoleTool(prisma, context, { operation: "read" }),
      ).rejects.toThrow(IsolationError);
    }
    expect(getRecruitingWorkspace).not.toHaveBeenCalled();
  });

  it("routes mutations through the atomic DB provenance guard with trusted runtime identity", async () => {
    const prisma = {} as PrismaClient;
    const input = {
      operation: "bind",
      roleId: "role",
      intent: { basis: "direct", quote: "Use this role" },
    };
    const receipt = { status: "saved", changed: true, workspace, source: { id: "verified-human" } };
    vi.mocked(executeRecruitingRoleMutation).mockResolvedValue(receipt as never);
    expect(await executeRecruitingRoleTool(prisma, context, input)).toEqual(receipt);
    expect(executeRecruitingRoleMutation).toHaveBeenCalledWith(
      prisma,
      actor,
      { runId: "run", sourceMessageId: "human-message" },
      input,
    );
  });

  it("rejects model-selected identity before dispatch", async () => {
    await expect(
      executeRecruitingRoleTool({} as PrismaClient, context, {
        operation: "read",
        threadId: "other-thread",
      }),
    ).rejects.toThrow();
    expect(getRecruitingWorkspace).not.toHaveBeenCalled();
    expect(executeRecruitingRoleMutation).not.toHaveBeenCalled();
  });
});

describe("native research preparation", () => {
  const input = {
    operation: "prepare" as const,
    mcpServerId: "source",
    expectedRoleRevision: 1,
    clientNonce: "round-1",
    instructions: "  Find engineers.\nKeep the supplied detail.  ",
    output: "Name, profile and per-criterion evidence",
    recallScope: null,
    intent: { basis: "direct" as const, quote: "Find engineers" },
  };
  const source = {
    id: "human-message:answer",
    kind: "original_material" as const,
    anchor: { kind: "message" as const, messageId: "answer", locator: "blocks[0].text" },
    readState: "read" as const,
    readAt: "2026-01-01T00:00:00.000Z",
    quote: input.intent.quote,
  };
  const context = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: "bot",
    runId: "run",
    operationId: "run",
    traceId: "trace",
    signal: new AbortController().signal,
  };
  const loaded = {
    workspace: {
      role: { id: "role", revision: 1, currentRevisionId: "revision" },
      revision: { id: "revision", roleId: "role", revision: 1 },
    },
    contextArtifact: { artifactId: "context", sha256: "a".repeat(64) },
    text: "Exact current criteria\nActual memory fragments",
    manifest: {
      roleId: "role",
      roleRevisionId: "revision",
      roleRevision: 1,
      roleText: "Exact current criteria",
      text: "Exact current criteria\nActual memory fragments",
    },
  } as LoadedRecruitingRunContext;

  function researchFixture(operation: "create" | "continue" = "create") {
    const request = buildRecruitingResearchRequest({
      context: loaded,
      source,
      intent: input.intent,
      route: {
        connectorId: "mcp",
        resourceId: "source",
        resourceRevision: 2,
        toolName: operation === "create" ? "research" : "reply",
      },
      instructions: input.instructions,
      output: input.output,
      recallScope: input.recallScope,
      ...(operation === "create"
        ? { operation: "create" as const }
        : {
            operation: "continue" as const,
            providerTaskId: "provider-original",
          }),
    });
    const task = {
      id: "task",
      roleId: "role",
      mcpServerId: "source",
      serverRevision: 2,
      providerTaskId: operation === "continue" ? "provider-original" : null,
      pendingActionId: "action" as string | null,
      state: "active",
      createdByRunId: "preparation-run",
    };
    const action = {
      id: "action",
      taskId: "task",
      roleRevisionId: "revision",
      runId: "preparation-run",
      sourceMessageId: "answer",
      clientNonce: input.clientNonce,
      kind: operation,
      deliveryState: "prepared",
      requestArtifactId: "request-artifact",
      requestArtifactHash: request.sha256,
      contextArtifactId: "context",
      contextArtifactHash: "a".repeat(64),
      recallScope: null,
      receiptArtifactId: null as string | null,
      receiptArtifactHash: null as string | null,
      observedProviderState: null,
      outputArtifacts: [],
      cursor: null,
      effectId: "effect",
      usage: null,
    };
    const frozenRequest = [
      "__rakazoCatalogTool",
      "direct",
      { route: request.manifest.route, args: request.manifest.args },
    ];
    const effect = {
      id: "effect",
      spaceId: actor.spaceId,
      runId: "run",
      kind: `mcp__source__${request.manifest.route.toolName}`,
      idempotencyKey: "recruiting-research:action",
      status: "intended",
      request: frozenRequest,
      result: null as unknown,
    };
    const saved = {
      source,
      workspace: loaded.workspace,
      server: { id: "source", revision: 2, slug: "source", enabled: true },
      run: { id: "run", botId: "bot", threadId: "thread", ...actor },
      thread: { id: "thread", activeRecruitingRoleId: "role" as string | null },
      task,
      action,
      effect,
      requestArtifact: {
        id: "request-artifact",
        storageKey: "request-blob",
        hash: request.sha256,
        name: "request.json",
        mimeType: "application/json",
        size: request.bytes.byteLength,
      },
    };
    const blobs = new Map<string, Uint8Array>([["request-blob", request.bytes]]);
    const uploads: Array<{ name: string; mimeType: string; bytes: Uint8Array }> = [];
    const artifacts = {
      get: vi.fn(async (id: string) => blobs.get(id)!),
      put: vi.fn(async (file: (typeof uploads)[number]) => {
        uploads.push(file);
        const id = `upload-${uploads.length}`;
        blobs.set(id, file.bytes);
        return { id, hash: "untrusted-store-hash" };
      }),
    };
    const prisma = {
      run: { findFirst: vi.fn().mockResolvedValue({ thread: saved.thread }) },
      thread: { findUnique: vi.fn().mockResolvedValue(saved.thread) },
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ endpoint: "https://api.autumn.ai/mcp" }),
      },
      recruitingResearchTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        findMany: vi.fn().mockResolvedValue([task]),
      },
      recruitingResearchAction: {
        findFirst: vi.fn().mockResolvedValue(action),
        findMany: vi.fn().mockResolvedValue([action]),
      },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue(effect),
        findUnique: vi.fn().mockResolvedValue(effect),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    vi.mocked(readRecruitingResearchContext).mockResolvedValue(saved as never);
    vi.mocked(recruitingResearchSnapshot).mockImplementation(
      (task, action) => ({ task, action }) as never,
    );
    vi.mocked(admitRecruitingResearchAction).mockResolvedValue({
      status: "ready",
      task,
      action,
      effect,
      ownerRunId: "run",
    } as never);
    vi.mocked(reconcileRecruitingResearchAction).mockImplementation(
      async (_db, _actor, receipt) =>
        ({
          task: { ...task, providerTaskId: receipt.providerTaskId ?? task.providerTaskId },
          action: { ...action, deliveryState: receipt.deliveryState },
        }) as never,
    );
    vi.mocked(recordRecruitingResearchObservation).mockResolvedValue({ task, action } as never);
    const trusted = {
      actor,
      runId: "run",
      sourceMessageId: "answer",
      leaseOwner: "worker",
      leaseFence: 4,
    };
    const deps = { prisma: prisma as unknown as PrismaClient, artifacts: artifacts as never };
    const call = {
      tool: effect.kind,
      executionId: "execution",
      route: request.manifest.route,
      args: request.manifest.args,
    };
    const admit = () =>
      tools.admitRecruitingResearchCall(deps, trusted, call, context, {
        actionId: action.id,
        frozenRequest,
      });
    return {
      request,
      task,
      action,
      effect,
      saved,
      blobs,
      uploads,
      artifacts,
      prisma,
      trusted,
      deps,
      call,
      frozenRequest,
      admit,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("freezes actual prompt bytes and verified human source before preparing without dispatch", async () => {
    vi.mocked(readRecruitingResearchContext).mockResolvedValue({
      source,
      workspace: loaded.workspace,
      server: { id: "source", revision: 2 },
      action: null,
      task: null,
    } as never);
    vi.mocked(prepareRecruitingResearchAction).mockImplementation(
      async (_db, _actor, request) =>
        ({
          task: { id: "task" },
          action: { id: "action", deliveryState: "prepared" },
          requestArtifact: request.requestArtifact,
        }) as never,
    );
    vi.mocked(recruitingResearchSnapshot).mockReturnValue({
      task: { id: "task" },
      action: { id: "action", deliveryState: "prepared" },
    } as never);
    let bytes: Uint8Array | undefined;
    const artifacts = {
      put: vi.fn(async (file: { bytes: Uint8Array }) => {
        bytes = file.bytes;
        return { id: "request-blob", hash: "not-a-sha256" };
      }),
    };
    const loadContext = vi.fn(async () => loaded);
    const result = await tools.prepareRecruitingResearchTool(
      { prisma: {} as PrismaClient, artifacts: artifacts as never },
      { actor, runId: "run", sourceMessageId: "original" },
      input,
      context,
      loadContext,
    );
    const manifest = JSON.parse(Buffer.from(bytes!).toString("utf8"));
    expect(manifest.args.prompt).toContain(loaded.text);
    expect(manifest.args.prompt).toContain(input.instructions);
    expect(manifest.source.anchor.messageId).toBe("answer");
    expect(loadContext).toHaveBeenCalledWith("answer", null);
    expect(prepareRecruitingResearchAction).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        sourceMessageId: "answer",
        requestArtifact: expect.objectContaining({
          storageKey: "request-blob",
          hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(result).toMatchObject({
      status: "prepared",
      task: { id: "task" },
      action: { id: "action" },
    });
  });

  it("does not write or load a new adoption for inferred search intent", async () => {
    vi.mocked(readRecruitingResearchContext).mockResolvedValue({
      source,
      workspace: loaded.workspace,
      server: { id: "source", revision: 2 },
      action: null,
    } as never);
    const artifacts = { put: vi.fn() };
    const loadContext = vi.fn();
    await expect(
      tools.prepareRecruitingResearchTool(
        { prisma: {} as PrismaClient, artifacts: artifacts as never },
        { actor, runId: "run", sourceMessageId: "original" },
        { ...input, intent: { ...input.intent, basis: "inferred" } },
        context,
        loadContext,
      ),
    ).resolves.toMatchObject({ status: "needs_clarification" });
    expect(artifacts.put).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
    expect(prepareRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it("replays an existing prepared nonce from verified frozen bytes without another upload or adoption", async () => {
    const f = researchFixture();
    const loadContext = vi.fn();
    await expect(
      tools.prepareRecruitingResearchTool(f.deps, f.trusted, input, context, loadContext),
    ).resolves.toMatchObject({
      status: "prepared",
      task: { id: "task" },
      action: { id: "action" },
      request: f.request.manifest.args,
    });
    expect(f.artifacts.get).toHaveBeenCalledWith("request-blob", context);
    expect(f.artifacts.put).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
    expect(prepareRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it("rejects changed content under a saved nonce before any upload or preparation", async () => {
    const f = researchFixture();
    await expect(
      tools.prepareRecruitingResearchTool(
        f.deps,
        f.trusted,
        { ...input, instructions: "Different criteria" },
        context,
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(f.artifacts.put).not.toHaveBeenCalled();
    expect(prepareRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it.each(["create", "continue"] as const)(
    "resolves %s start to the verified original request",
    async (operation) => {
      const f = researchFixture(operation);
      const result = await tools.resolveRecruitingResearchTool(
        f.deps,
        f.trusted,
        { operation: "start", actionId: "action" },
        context,
      );
      expect(result).toMatchObject({
        operation,
        actionId: "action",
        taskId: "task",
        route: f.call.route,
        args: f.call.args,
      });
      expect(f.artifacts.put).not.toHaveBeenCalled();
      expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    },
  );

  it("rejects a tampered start Artifact before effect admission", async () => {
    const f = researchFixture();
    f.blobs.set(
      "request-blob",
      Buffer.from(JSON.stringify({ ...f.request.manifest, args: { prompt: "Incomplete" } })),
    );
    await expect(
      tools.resolveRecruitingResearchTool(
        f.deps,
        f.trusted,
        { operation: "start", actionId: "action" },
        context,
      ),
    ).rejects.toThrow(/hash/i);
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    expect(f.artifacts.put).not.toHaveBeenCalled();
  });

  it.each(["status", "rows"] as const)(
    "resolves %s against the owned task's original provider ID",
    async (operation) => {
      const f = researchFixture("continue");
      const result = await tools.resolveRecruitingResearchTool(
        f.deps,
        { ...f.trusted, sourceMessageId: null },
        operation === "rows"
          ? { operation, taskId: "task", limit: 17, cursor: "  opaque cursor  " }
          : { operation, taskId: "task" },
        context,
      );
      expect(result).toMatchObject({
        operation,
        taskId: "task",
        route: {
          connectorId: "mcp",
          resourceId: "source",
          resourceRevision: 2,
          toolName: operation === "rows" ? "get_rows" : "get_task",
        },
        args: {
          task_id: "provider-original",
          ...(operation === "rows" ? { limit: 17, cursor: "  opaque cursor  " } : {}),
        },
      });
      expect(readRecruitingResearchContext).toHaveBeenCalledWith(
        f.deps.prisma,
        actor,
        expect.objectContaining({
          runId: "run",
          taskId: "task",
          toolName: operation === "rows" ? "get_rows" : "get_task",
        }),
      );
      expect(f.artifacts.put).not.toHaveBeenCalled();
      expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    },
  );

  it("admits exact frozen mutation arguments with the actual current dispatch lease", async () => {
    const f = researchFixture();
    await expect(f.admit()).resolves.toMatchObject({
      kind: "mutation",
      operation: "create",
      status: "ready",
      manifest: f.request.manifest,
      task: f.task,
      action: f.action,
      effect: f.effect,
    });
    expect(admitRecruitingResearchAction).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        runId: "run",
        leaseOwner: "worker",
        leaseFence: 4,
        actionId: "action",
        frozenRequest: f.frozenRequest,
        requestArtifact: { artifactId: "request-artifact", sha256: f.request.sha256 },
      }),
    );
  });

  it("preserves the saved effect kind when discovery renames the same bound MCP tool", async () => {
    const f = researchFixture();
    const renamed = { ...f.call, tool: "collision.mcp__source__research" };
    await expect(
      tools.admitRecruitingResearchCall(f.deps, f.trusted, renamed, context, {
        actionId: "action",
        frozenRequest: f.frozenRequest,
      }),
    ).resolves.toMatchObject({ kind: "mutation", effect: { id: "effect", kind: f.effect.kind } });
    expect(admitRecruitingResearchAction).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({ effectKind: f.effect.kind }),
    );
  });

  it.each(["completed", "executing", "uncertain", "denied"])(
    "resolves %s effect recovery using its saved kind",
    async (status) => {
      const f = researchFixture();
      f.effect.status = status;
      f.effect.kind = "original.mcp__source__research";
      await expect(
        tools.resolveRecruitingResearchTool(
          f.deps,
          f.trusted,
          { operation: "start", actionId: "action" },
          context,
        ),
      ).resolves.toMatchObject({
        recoveryEffectKind: f.effect.kind,
        route: f.call.route,
        args: f.call.args,
      });
      expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    },
  );

  it("rejects a raw MCP mutation that omits frozen conditions before DB effect admission", async () => {
    const f = researchFixture();
    await expect(
      tools.admitRecruitingResearchCall(
        f.deps,
        f.trusted,
        { ...f.call, args: { prompt: "Find anyone" } },
        context,
        { frozenRequest: { prompt: "Find anyone" } },
      ),
    ).rejects.toThrow();
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    expect(f.artifacts.put).not.toHaveBeenCalled();
  });

  it("leaves unrelated connector tools outside recruiting admission", async () => {
    const f = researchFixture();
    await expect(
      tools.admitRecruitingResearchCall(
        f.deps,
        f.trusted,
        { ...f.call, route: { ...f.call.route, toolName: "list_notes" } },
        context,
        { frozenRequest: {} },
      ),
    ).resolves.toBeUndefined();
    expect(readRecruitingResearchContext).not.toHaveBeenCalled();
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it.each(["https://api.autumn.ai/mcp", "https://api.autumn.ai/mcp/"])(
    "guards a raw canonical research call before any task exists at %s",
    async (endpoint) => {
      const f = researchFixture();
      f.prisma.mcpServer.findFirst.mockResolvedValue({ endpoint });
      f.prisma.recruitingResearchTask.findFirst.mockResolvedValue(null);
      f.prisma.recruitingResearchAction.findMany.mockResolvedValue([]);

      await expect(
        tools.admitRecruitingResearchCall(f.deps, f.trusted, f.call, context, {
          frozenRequest: f.frozenRequest,
        }),
      ).rejects.toThrow(/prepare this exact request/);

      expect(f.prisma.mcpServer.findFirst).toHaveBeenCalledWith({
        where: { id: "source", spaceId: actor.spaceId, userId: actor.userId },
        select: { endpoint: true },
      });
      expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
      expect(f.artifacts.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://other.example.test/mcp",
    "https://api.autumn.ai/mcp-other",
    "http://api.autumn.ai/mcp",
  ])("leaves an unrelated raw reply at %s untouched without an owned task", async (endpoint) => {
    const f = researchFixture("continue");
    f.prisma.mcpServer.findFirst.mockResolvedValue({ endpoint });
    f.prisma.recruitingResearchTask.findFirst.mockResolvedValue(null);

    await expect(
      tools.admitRecruitingResearchCall(f.deps, f.trusted, f.call, context, {
        frozenRequest: f.frozenRequest,
      }),
    ).resolves.toBeUndefined();

    expect(f.prisma.mcpServer.findFirst).toHaveBeenCalledOnce();
    expect(readRecruitingResearchContext).not.toHaveBeenCalled();
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    expect(f.artifacts.get).not.toHaveBeenCalled();
  });

  it("guards raw replies when an owned task links the noncanonical MCP resource", async () => {
    const f = researchFixture("continue");
    f.prisma.mcpServer.findFirst.mockResolvedValue({ endpoint: "https://other.example.test/mcp" });

    await expect(
      tools.admitRecruitingResearchCall(f.deps, f.trusted, f.call, context, {
        frozenRequest: f.frozenRequest,
      }),
    ).resolves.toMatchObject({ kind: "mutation", operation: "continue", status: "ready" });

    expect(f.prisma.recruitingResearchTask.findFirst).toHaveBeenCalledWith({
      where: {
        mcpServerId: "source",
        role: { spaceId: actor.spaceId, userId: actor.userId },
      },
      select: { id: true },
    });
    expect(admitRecruitingResearchAction).toHaveBeenCalledOnce();
  });

  it.each(["action", "task"] as const)(
    "still validates an explicit %s after the thread's role is unbound",
    async (selector) => {
      const f = researchFixture("continue");
      f.saved.thread.activeRecruitingRoleId = null;
      vi.mocked(readRecruitingResearchContext).mockReset().mockRejectedValue(new IsolationError());
      const call =
        selector === "action"
          ? f.call
          : {
              ...f.call,
              tool: "mcp__source__get_rows",
              route: { ...f.call.route, toolName: "get_rows" },
              args: { task_id: "provider-original" },
            };

      await expect(
        tools.admitRecruitingResearchCall(f.deps, f.trusted, call, context, {
          ...(selector === "action" ? { actionId: "action" } : { taskId: "task" }),
          frozenRequest: f.frozenRequest,
        }),
      ).rejects.toThrow(IsolationError);

      expect(readRecruitingResearchContext).toHaveBeenCalledWith(
        f.deps.prisma,
        actor,
        expect.objectContaining({
          runId: "run",
          ...(selector === "action" ? { actionId: "action" } : { taskId: "task" }),
        }),
      );
      expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    },
  );

  it("persists the exact queued provider envelope as a hashed receipt without assumed completion or usage", async () => {
    const f = researchFixture("continue");
    const admission = await f.admit();
    const providerResult = {
      structuredContent: { task_id: "provider-original", status: "accepted", activity: "queued" },
      content: [{ type: "text", text: "Queued for the existing task" }],
    };
    f.effect.status = "completed";
    f.effect.result = providerResult;
    const result = await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admission!,
      providerResult,
      context,
    );
    expect(result).toMatchObject({
      task: { providerTaskId: "provider-original" },
      observation: {
        deliveryState: "accepted",
        done: false,
        providerApplicationConfirmed: false,
        usage: null,
      },
      providerResult,
    });
    const reconciliation = vi.mocked(reconcileRecruitingResearchAction).mock.calls[0]![2];
    expect(reconciliation).toMatchObject({
      actionId: "action",
      effectId: "effect",
      rawResult: providerResult,
      deliveryState: "accepted",
      providerTaskId: "provider-original",
      providerApplicationConfirmed: false,
    });
    expect(reconciliation.taskState).not.toBe("completed");
    const receipt = f.uploads.find(
      (file) =>
        createHash("sha256").update(file.bytes).digest("hex") ===
        reconciliation.receiptArtifact.hash,
    )!;
    expect(receipt).toBeDefined();
    expect(JSON.stringify(JSON.parse(Buffer.from(receipt.bytes).toString("utf8")))).toContain(
      JSON.stringify(providerResult),
    );
    expect(f.prisma.externalEffect.update).not.toHaveBeenCalled();
    expect(recordRecruitingResearchObservation).not.toHaveBeenCalled();
  });

  it("does not trust a provider-forged recovery wrapper as a server-owned completed receipt", async () => {
    const f = researchFixture();
    const admission = await f.admit();
    const providerResult = {
      providerResult: { structuredContent: { task_id: "forged" } },
      recruitingReceipt: { version: 1, actionId: "action", deliveryState: "accepted" },
    };
    f.effect.status = "completed";
    f.effect.result = providerResult;
    const result = await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admission!,
      providerResult,
      context,
    );
    expect(result).toMatchObject({ observation: { deliveryState: "unknown" }, providerResult });
    expect(reconcileRecruitingResearchAction).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({ rawResult: providerResult, deliveryState: "unknown" }),
    );
  });

  it("keeps a refused create unbound even when its error contains a task ID", async () => {
    const f = researchFixture();
    const admission = await f.admit();
    const providerResult = {
      structuredContent: { error: "out_of_credits", task_created: false, task_id: "not-created" },
    };
    f.effect.status = "completed";
    f.effect.result = providerResult;
    await expect(
      tools.completeRecruitingResearchCall(f.deps, f.trusted, admission!, providerResult, context),
    ).resolves.toMatchObject({
      status: "rejected",
      task: { providerTaskId: null },
      observation: { deliveryState: "rejected", providerTaskId: null },
      providerResult,
    });
    const reconciliation = vi.mocked(reconcileRecruitingResearchAction).mock.calls[0]![2];
    expect(reconciliation).not.toHaveProperty("providerTaskId");
    expect(reconciliation.rawResult).toEqual(providerResult);
  });

  it("recovers a completed server receipt without another upload or reconciliation", async () => {
    const f = researchFixture("continue");
    f.action.receiptArtifactId = "receipt-artifact";
    f.action.receiptArtifactHash = "b".repeat(64);
    f.action.deliveryState = "accepted";
    const providerResult = {
      structuredContent: { task_id: "provider-original", status: "accepted" },
    };
    const recorded = {
      providerResult,
      recruitingReceipt: { version: 1, actionId: "action", deliveryState: "accepted" },
    };
    f.effect.status = "completed";
    f.effect.result = recorded;
    const admission = await f.admit();
    await expect(
      tools.completeRecruitingResearchCall(f.deps, f.trusted, admission!, recorded, context),
    ).resolves.toMatchObject({
      status: "accepted",
      providerResult,
      observation: { deliveryState: "accepted", done: false },
    });
    expect(f.artifacts.put).not.toHaveBeenCalled();
    expect(reconcileRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it.each(["pending-continue", "original-create", "unreceipted-continue"])(
    "records read pages against selected %s without overwriting its mutation receipt",
    async (actionId) => {
      const f = researchFixture(actionId === "original-create" ? "create" : "continue");
      const receipt = actionId === "unreceipted-continue" ? null : "mutation-receipt";
      f.action.id = actionId;
      f.task.pendingActionId = actionId === "original-create" ? null : actionId;
      f.task.providerTaskId = "provider-original";
      f.task.state = "completed";
      f.action.receiptArtifactId = receipt;
      f.action.receiptArtifactHash = receipt ? "b".repeat(64) : null;
      const call = {
        ...f.call,
        tool: "mcp__source__get_rows",
        route: { ...f.call.route, toolName: "get_rows" },
        args: { task_id: "provider-original", cursor: "input-cursor", limit: 10 },
      };
      const admission = await tools.admitRecruitingResearchCall(f.deps, f.trusted, call, context, {
        taskId: "task",
        frozenRequest: call.args,
      });
      expect(admission).toMatchObject({ kind: "read", operation: "rows" });
      const rows = [
        {
          name: { value: "Synthetic Person", source_id: "s1" },
          _sources: { s1: "https://example.test/profile" },
        },
      ];
      const providerResult = {
        structuredContent: { rows, next_cursor: "next-cursor", credits_used: 9 },
      };
      const readEffect = {
        ...f.effect,
        id: "read-effect",
        kind: call.tool,
        status: "completed",
        request: boundDirectApprovalRequest(call.route, call.args, "__rakazoCatalogTool"),
        result: providerResult,
      };
      f.prisma.externalEffect.findFirst.mockResolvedValue(readEffect);
      f.prisma.externalEffect.findUnique.mockResolvedValue(readEffect);
      await tools.completeRecruitingResearchCall(
        f.deps,
        f.trusted,
        admission!,
        providerResult,
        context,
        { effectId: readEffect.id, request: readEffect.request },
      );
      expect(recordRecruitingResearchObservation).toHaveBeenCalledWith(
        f.deps.prisma,
        actor,
        expect.objectContaining({
          actionId,
          effectId: readEffect.id,
          request: readEffect.request,
          rawResult: providerResult,
          toolName: "get_rows",
          cursor: "next-cursor",
          outputArtifact: expect.objectContaining({
            hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      );
      const snapshot = JSON.parse(Buffer.from(f.uploads[0]!.bytes).toString("utf8"));
      expect(vi.mocked(recordRecruitingResearchObservation).mock.lastCall?.[2]).not.toHaveProperty(
        "taskState",
      );
      expect(JSON.stringify(snapshot)).toContain(JSON.stringify(rows));
      expect(JSON.stringify(snapshot)).toContain("input-cursor");
      expect(snapshot.observation.usage).toEqual([{ scope: "task", unit: "credits", amount: 9 }]);
      if (!receipt)
        expect(
          vi.mocked(recordRecruitingResearchObservation).mock.lastCall?.[2],
        ).not.toHaveProperty("usage");
      expect(reconcileRecruitingResearchAction).not.toHaveBeenCalled();
      expect(f.action.receiptArtifactId).toBe(receipt);
    },
  );
});

import { createHash } from "node:crypto";
