import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Actor } from "@rakazo/contracts";
import { boundDirectApprovalRequest, readRecruitingResearchReadArtifact } from "@rakazo/core";
import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import {
  admitRecruitingResearchAction,
  bindRecruitingResearchReadEffect,
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  listUnmappedRecruitingResearchReads,
  prepareRecruitingResearchAction,
  readNativeRecruitingCandidatePage,
  readRecruitingResearchContext,
  reconcileRecruitingResearchAction,
  recordRecruitingResearchObservation,
  recruitingResearchSnapshot,
  saveNativeRecruitingCandidatePage,
  saveRecruitingAssessment,
  saveRecruitingCandidateCsvImport,
} from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import { parametersFor } from "./pi-runtime.js";
import { executeRecruitingAssessmentTool } from "./recruiting-assessment.js";
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
  bindRecruitingResearchReadEffect: vi.fn(),
  listUnmappedRecruitingResearchReads: vi.fn(),
  reconcileRecruitingResearchAction: vi.fn(),
  recordRecruitingResearchObservation: vi.fn(),
  saveRecruitingAssessment: vi.fn(),
  readNativeRecruitingCandidatePage: vi.fn(),
  saveNativeRecruitingCandidatePage: vi.fn(),
  saveRecruitingCandidateCsvImport: vi.fn(),
}));

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const context = { actor, runId: "run", sourceMessageId: "human-message" };
const mutation = {
  threadId: "actual-thread",
  botId: "bot",
  leaseOwner: "worker",
  leaseFence: 1,
  effectId: "role-effect",
  effectRequest: {},
};
const workspace = { role: { id: "role" }, revision: { id: "revision" } };

describe("optional native candidate output saving", () => {
  beforeEach(() => vi.clearAllMocks());
  const input = {
    operation: "save_results" as const,
    expectedRoleRevision: 1,
    mcpServerId: "server",
    providerTaskId: "provider-task",
    cursor: null,
  };
  const adapterContext = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    runId: "run",
    operationId: "save",
    traceId: "save",
    signal: new AbortController().signal,
  };
  const trusted = {
    ...context,
    leaseOwner: "worker",
    leaseFence: 1,
    effectId: "save",
    effectRequest: input,
  };
  function capture(raw: unknown) {
    return {
      effect: { id: "read", result: raw },
      snapshot: { request: ["original-read"], providerResult: raw },
    };
  }
  it.each(["succeeded", "readTX", "serializeArtifactPut", "atomicWriteTX"] as const)(
    "summarizes only settled save phases for %s without changing the result",
    async (outcome) => {
      const previousLogger = getLogger();
      const sink = createTestSink();
      installLogger(createLogger({ service: "save-check", sinks: [sink] }));
      let clock = 0;
      const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
      try {
        const failure = new Error("private diagnostic must not be logged");
        const read = capture({
          structuredContent: { rows: [{ name: "Example", linkedin_url: null }, null] },
        });
        vi.mocked(readNativeRecruitingCandidatePage).mockImplementation(async () => {
          clock = 11;
          if (outcome === "readTX") throw failure;
          return read as never;
        });
        const put = vi.fn(async (_file: { bytes: Uint8Array }) => {
          clock = 18;
          if (outcome === "serializeArtifactPut") throw failure;
          return { id: "retained-blob" };
        });
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        let resolveWrite!: (value: never) => void;
        let rejectWrite!: (reason: Error) => void;
        const settled = new Promise<never>((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        });
        vi.mocked(saveNativeRecruitingCandidatePage).mockImplementation(() => {
          markEntered();
          return settled;
        });
        const receipt = { status: "saved" };
        const saving = tools.saveNativeRecruitingCandidateResults(
          { prisma: {} as PrismaClient, artifacts: { put } } as never,
          trusted,
          input,
          adapterContext,
        );
        if (outcome === "succeeded" || outcome === "atomicWriteTX") {
          await entered;
          expect(sink.events).toHaveLength(0);
          clock = 31;
          if (outcome === "succeeded") resolveWrite(receipt as never);
          else rejectWrite(failure);
        }
        if (outcome === "succeeded") expect(await saving).toBe(receipt);
        else await expect(saving).rejects.toBe(failure);
        expect(sink.events).toHaveLength(1);
        const event = sink.events[0]!;
        expect(event).toEqual({
          timestamp: expect.any(String),
          level: "info",
          message: "recruiting.candidates.save.timing",
          "service.name": "save-check",
          outcome: outcome === "succeeded" ? "succeeded" : "error",
          failedPhase: outcome === "succeeded" ? null : outcome,
          durationMs: clock,
          readTXWallMs: 11,
          serializeArtifactPutWallMs: outcome === "readTX" ? 0 : 7,
          atomicWriteTXWallMs: clock === 31 ? 13 : 0,
          rowCount: outcome === "readTX" ? null : 2,
          bytes: clock === 31 ? put.mock.calls[0]![0].bytes.byteLength : null,
        });
      } finally {
        now.mockRestore();
        installLogger(previousLogger);
      }
    },
  );
  it("saves the actual native page bytes and all candidate rows through existing storage", async () => {
    const rows = [{ name: "Example", linkedin_url: "https://linkedin.com/in/example" }, null];
    const read = capture({ structuredContent: { rows, next_cursor: "opaque-next" } });
    vi.mocked(readNativeRecruitingCandidatePage).mockResolvedValue(read as never);
    const receipt = { status: "saved", sourceEffectId: "read" };
    vi.mocked(saveNativeRecruitingCandidatePage).mockResolvedValue(receipt as never);
    const put = vi.fn(async (_file: unknown) => ({ id: "retained-blob" }));
    const prisma = {} as PrismaClient;
    expect(
      await tools.saveNativeRecruitingCandidateResults(
        { prisma, artifacts: { put } } as never,
        trusted,
        input,
        adapterContext,
      ),
    ).toEqual(receipt);
    expect(put).toHaveBeenCalledOnce();
    const uploaded = put.mock.calls[0]![0] as { bytes: Uint8Array };
    expect(JSON.parse(Buffer.from(uploaded.bytes).toString())).toEqual(read.snapshot);
    expect(saveNativeRecruitingCandidatePage).toHaveBeenCalledWith(
      prisma,
      actor,
      trusted,
      input,
      expect.objectContaining({
        sourceEffectId: "read",
        rows,
        outputArtifact: expect.objectContaining({ clientNonce: "recruiting-observation:read" }),
      }),
    );
  });
  it.each([
    {
      structuredContent: {
        rows: [{ fact: "Company evidence", source_url: "https://example.test" }],
      },
    },
    { content: [{ type: "text", text: "Unstructured results" }] },
    { isError: true, structuredContent: { rows: [{ name: "Example", linkedin_url: null }] } },
  ])("does not relabel company/JD or invalid tool results as candidate pages", async (raw) => {
    vi.mocked(readNativeRecruitingCandidatePage).mockResolvedValue(capture(raw) as never);
    const put = vi.fn();
    await expect(
      tools.saveNativeRecruitingCandidateResults(
        { prisma: {}, artifacts: { put } } as never,
        trusted,
        input,
        adapterContext,
      ),
    ).rejects.toThrow(/candidate/i);
    expect(put).not.toHaveBeenCalled();
    expect(saveNativeRecruitingCandidatePage).not.toHaveBeenCalled();
  });
  it("rejects a foreign adapter context before reading retained provider data", async () => {
    await expect(
      tools.saveNativeRecruitingCandidateResults(
        { prisma: {}, artifacts: {} } as never,
        trusted,
        input,
        { ...adapterContext, userId: "other" },
      ),
    ).rejects.toThrow(IsolationError);
    expect(readNativeRecruitingCandidatePage).not.toHaveBeenCalled();
  });
});

describe("recruiter CSV import", () => {
  beforeEach(() => vi.clearAllMocks());
  const input = {
    operation: "import_csv" as const,
    roleId: "role",
    expectedRoleRevision: 1,
    artifactId: "csv",
    mapping: { name: "Name", linkedinUrl: "LinkedIn", company: "Company" },
  };
  const adapterContext = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    runId: "run",
    operationId: "import",
    traceId: "import",
    signal: new AbortController().signal,
  };
  const trusted = {
    ...context,
    leaseOwner: "worker",
    leaseFence: 1,
    effectId: "import",
    effectRequest: input,
  };
  function deps(text: string, row: Record<string, unknown> | null = {}) {
    const bytes = Buffer.from(text);
    const artifact = row && {
      ...actor,
      id: "csv",
      botId: "bot",
      groupId: null,
      rootArtifactId: null,
      storageKey: "csv-blob",
      mimeType: "text/csv",
      size: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
      ...row,
    };
    const prisma = {
      artifact: { findFirst: vi.fn(async () => artifact) },
      $queryRaw: vi.fn(async () => []),
    };
    const put = vi.fn(async (_file: { bytes: Uint8Array }) => ({ id: "receipt-blob" }));
    const get = vi.fn(async () => bytes);
    return { prisma, artifacts: { put, get }, artifact, put, get };
  }
  const run = (d: ReturnType<typeof deps>, ctx = adapterContext) =>
    tools.importRecruitingCandidateCsv(d as never, trusted, input, ctx);

  it("maps columns, skips rows with no name and no LinkedIn, and binds the receipt", async () => {
    vi.mocked(saveRecruitingCandidateCsvImport).mockResolvedValue({ status: "saved" } as never);
    const d = deps(
      "Name,LinkedIn,Company,Notes\r\n" +
        "Ada Example,https://www.linkedin.com/in/example,Example Co,x\r\n" +
        ",,Orphan Co,y\r\n" +
        "No Profile,, ,z\r\n",
    );
    expect(await run(d)).toEqual({ status: "saved" });
    const [, who, lease, saved, captured] = vi.mocked(saveRecruitingCandidateCsvImport).mock
      .calls[0]!;
    expect(who).toBe(actor);
    expect(lease).toBe(trusted);
    expect(saved).toBe(input);
    expect(captured).toMatchObject({
      artifactSha256: d.artifact!.hash,
      header: ["Name", "LinkedIn", "Company", "Notes"],
      rows: [
        {
          rowIndex: 0,
          csvRowIndex: 0,
          row: {
            name: "Ada Example",
            linkedin_url: "https://www.linkedin.com/in/example",
            current_company: "Example Co",
          },
        },
        { rowIndex: 1, csvRowIndex: 2, row: { name: "No Profile" } },
      ],
      skipped: [{ csvRowIndex: 1, reason: "missing_name_and_linkedin_url" }],
      truncated: false,
      outputArtifact: { clientNonce: "recruiting-csv-import:import", storageKey: "receipt-blob" },
    });
    const uploaded = JSON.parse(Buffer.from(d.put.mock.calls[0]![0].bytes).toString());
    expect(uploaded).toMatchObject({
      kind: "csv_import",
      source: { artifactId: "csv", artifactSha256: d.artifact!.hash },
    });
    expect(captured.outputArtifact.hash).toBe(
      createHash("sha256").update(d.put.mock.calls[0]![0].bytes).digest("hex"),
    );
  });

  it("reports a truncated CSV", async () => {
    vi.mocked(saveRecruitingCandidateCsvImport).mockResolvedValue({ status: "saved" } as never);
    const lines = Array.from({ length: 5001 }, (_, i) => `Person ${i},,`);
    await run(deps(["Name,LinkedIn,Company", ...lines].join("\n")));
    const captured = vi.mocked(saveRecruitingCandidateCsvImport).mock.calls[0]![4];
    expect(captured.truncated).toBe(true);
    expect(captured.rows.length).toBeLessThan(5001);
  });

  it("refuses a foreign artifact before storage access", async () => {
    const d = deps("Name\nA\n", null);
    await expect(run(d)).rejects.toThrow(IsolationError);
    expect(d.get).not.toHaveBeenCalled();
    expect(d.put).not.toHaveBeenCalled();
    expect(saveRecruitingCandidateCsvImport).not.toHaveBeenCalled();
  });

  it("refuses a foreign adapter context before any read", async () => {
    const d = deps("Name\nA\n");
    await expect(run(d, { ...adapterContext, userId: "other" })).rejects.toThrow(IsolationError);
    expect(d.prisma.artifact.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["tampered bytes", { hash: "f".repeat(64) }, /could not be read or verified/],
    ["non-CSV artifact", { mimeType: "application/json" }, /text\/csv/],
  ])("rejects a %s", async (_label, row, message) => {
    const d = deps("Name\nA\n", row);
    await expect(run(d)).rejects.toThrow(message);
    expect(saveRecruitingCandidateCsvImport).not.toHaveBeenCalled();
  });

  it("names a mapped column missing from the header", async () => {
    await expect(run(deps("Full name,LinkedIn,Company\nA,,\n"))).rejects.toThrow(
      /Column "Name" is not in the CSV header/,
    );
    expect(saveRecruitingCandidateCsvImport).not.toHaveBeenCalled();
  });

  it("is a valid recruiting_research tool call", () => {
    const tool = builtinAgentTools.find((candidate) => candidate.name === "recruiting_research")!;
    expect(() =>
      validateToolArguments(
        { name: tool.name, description: "", parameters: parametersFor(tool) } as never,
        { type: "toolCall", id: "call", name: tool.name, arguments: input } as never,
      ),
    ).not.toThrow();
  });
});

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
    const material = {
      artifacts: { get: vi.fn() },
      context: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        operationId: "native-role",
        traceId: "native-role",
        signal: new AbortController().signal,
      },
    } as unknown as Parameters<typeof executeRecruitingRoleTool>[3];
    expect(
      await executeRecruitingRoleTool(
        prisma,
        { ...context, mutation: { ...mutation, effectRequest: input } },
        input,
        material,
      ),
    ).toEqual(receipt);
    expect(executeRecruitingRoleMutation).toHaveBeenCalledWith(
      prisma,
      actor,
      { ...mutation, effectRequest: input, runId: "run", sourceMessageId: "human-message" },
      input,
      material,
    );
  });

  it("creates from semantic input without a model revision while keeping the native provenance guard", async () => {
    const prisma = {} as PrismaClient;
    const input = {
      operation: "create",
      title: "Example engineer",
      sourceRefs: [],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
      intent: { basis: "direct", quote: "Create this role" },
    };
    const receipt = { status: "saved", changed: true, workspace, source: { id: "verified-human" } };
    vi.mocked(executeRecruitingRoleMutation).mockResolvedValue(receipt as never);
    expect(
      await executeRecruitingRoleTool(
        prisma,
        { ...context, mutation: { ...mutation, effectRequest: input } },
        input,
      ),
    ).toEqual(receipt);
    expect(executeRecruitingRoleMutation).toHaveBeenCalledExactlyOnceWith(
      prisma,
      actor,
      { ...mutation, effectRequest: input, runId: "run", sourceMessageId: "human-message" },
      input,
      undefined,
    );
    for (const expectedRevision of [0, 1]) {
      await expect(
        executeRecruitingRoleTool(prisma, context, { ...input, expectedRevision }),
      ).rejects.toThrow();
    }
    expect(executeRecruitingRoleMutation).toHaveBeenCalledOnce();
  });

  it("rejects native mutations without a runtime-owned receipt identity", async () => {
    await expect(
      executeRecruitingRoleTool({} as PrismaClient, context, {
        operation: "bind",
        roleId: null,
        intent: { basis: "direct", quote: "Clear this role" },
      }),
    ).rejects.toThrow(IsolationError);
    expect(executeRecruitingRoleMutation).not.toHaveBeenCalled();
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
    purpose: "calibration" as const,
    approvalEffectId: "g1-approval",
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
  const { mcpServerId: _mcpServerId, ...continuationInput } = input;
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
      role: {
        id: "role",
        revision: 1,
        currentRevisionId: "revision",
        spaceId: "space",
        userId: "owner",
        sourceThreadId: "thread",
        title: "Example engineer",
      },
      revision: {
        id: "revision",
        roleId: "role",
        revision: 1,
        sourceRefs: [],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        createdAt: "2026-10-16T18:00:00Z",
        brief: {
          searchFilters: [],
          fields: [
            {
              key: "salary_range",
              value: "GBP 90,000 to 120,000",
              origin: "user_instruction",
              state: "known",
              consequential: true,
              sourceRefIds: ["human"],
            },
            {
              key: "location",
              value: "Unrestricted",
              origin: "user_instruction",
              state: "known",
              consequential: true,
              sourceRefIds: ["human"],
            },
          ],
          questions: [],
          rules: [],
          confirmation: {
            revision: 1,
            userId: "owner",
            messageId: "confirmation",
            confirmedAt: "2026-10-16T18:00:00Z",
          },
        },
      },
    },
    contextArtifact: { artifactId: "context", sha256: "a".repeat(64) },
    text: "Exact current criteria\nActual memory fragments",
    manifest: {
      version: 1,
      actor: { spaceId: "space", userId: "owner" },
      runId: "run",
      threadId: "thread",
      botId: "bot",
      memory: { documents: [] },
      recallScope: null,
      placement: "instructions",
      reason: "synthetic intake",
      sourceMessageId: "human",
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
      purpose: input.purpose,
      approvalEffectId: input.approvalEffectId,
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
      purpose: input.purpose as "calibration" | "scale" | null,
      candidateOutputSchema: "candidate_output_v1" as string | null,
      approvalEffectId: input.approvalEffectId as string | null,
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
    vi.mocked(listUnmappedRecruitingResearchReads).mockResolvedValue([]);
    vi.mocked(bindRecruitingResearchReadEffect).mockResolvedValue({ saved } as never);
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

  function pendingRead(f: ReturnType<typeof researchFixture>, cursor = "page-1") {
    f.task.providerTaskId = "provider-original";
    const route = {
      connectorId: "mcp",
      resourceId: "source",
      resourceRevision: 2,
      toolName: "get_rows",
    };
    const args = { task_id: "provider-original", cursor, limit: 10 };
    const request = boundDirectApprovalRequest(route, args, "__rakazoCatalogTool");
    const effect = {
      ...f.effect,
      id: "old-read-effect",
      runId: "old-run",
      kind: "mcp__source__get_rows",
      status: "completed",
      request,
      result: { rows: [{ value: "captured page" }], next_cursor: "page-2" },
    };
    const read = { saved: f.saved, effect, toolName: "get_rows", route, args };
    vi.mocked(listUnmappedRecruitingResearchReads).mockResolvedValue([read] as never);
    return read;
  }

  it.each(["direct", "catalog"])(
    "binds a native %s read effect to its original action before approval or dispatch",
    async (shape) => {
      expect(tools.bindRecruitingResearchReadCall).toBeTypeOf("function");
      const f = researchFixture("continue");
      const read = pendingRead(f);
      if (shape === "catalog")
        read.effect.request = [
          "__rakazoCatalogTool",
          "connectors_execute_tool",
          { id: "source:get_rows", arguments: read.args },
          read.route,
        ];
      const original = { ...f.saved, action: { ...f.action, id: "first-bound-action" } };
      vi.mocked(bindRecruitingResearchReadEffect).mockResolvedValue({
        saved: original,
        effect: read.effect,
      } as never);
      const admitted = {
        kind: "read" as const,
        operation: "rows" as const,
        saved: f.saved,
        call: {
          ...f.call,
          route: read.route,
          args: { ...read.args, cursor: "reconstructed-page" },
        },
      };
      const bound = await tools.bindRecruitingResearchReadCall(
        f.deps,
        f.trusted,
        admitted as never,
        read.effect,
      );
      expect(bound.saved.action!.id).toBe("first-bound-action");
      expect(bound.call.args).toEqual(read.args);
      expect(bindRecruitingResearchReadEffect).toHaveBeenCalledWith(f.deps.prisma, actor, {
        runId: "run",
        leaseOwner: "worker",
        leaseFence: 4,
        actionId: "action",
        effectId: read.effect.id,
        request: read.effect.request,
      });
      expect(f.artifacts.put).not.toHaveBeenCalled();
    },
  );

  it("rejects read capture under an adapter context belonging to a different run", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    await expect(
      tools.completeRecruitingResearchCall(
        f.deps,
        f.trusted,
        {
          kind: "read",
          operation: "rows",
          saved: f.saved,
          call: { ...f.call, route: read.route, args: read.args },
        } as never,
        read.effect.result,
        { ...context, runId: "foreign-capture" },
        {
          effectId: read.effect.id,
          request: read.effect.request,
          historicalBackfill: true,
        },
      ),
    ).rejects.toThrow(IsolationError);
    expect(f.artifacts.put).not.toHaveBeenCalled();
    expect(recordRecruitingResearchObservation).not.toHaveBeenCalled();
  });

  it("writes canonical read bytes tied to one native effect and forwards historical capture", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    const admitted = {
      kind: "read" as const,
      operation: "rows" as const,
      saved: f.saved,
      call: { ...f.call, route: read.route, args: read.args },
    };
    await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admitted as never,
      { rows: [{ b: 2, a: 1 }], next_cursor: "next" },
      context,
      { effectId: read.effect.id, request: read.effect.request, historicalBackfill: true },
    );
    await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admitted as never,
      { next_cursor: "next", rows: [{ a: 1, b: 2 }] },
      context,
      { effectId: read.effect.id, request: read.effect.request, historicalBackfill: true },
    );
    expect(Buffer.from(f.uploads[0]!.bytes).equals(Buffer.from(f.uploads[1]!.bytes))).toBe(true);
    const snapshot = JSON.parse(Buffer.from(f.uploads[0]!.bytes).toString("utf8"));
    expect(snapshot.effectId).toBe(read.effect.id);
    const output = vi.mocked(recordRecruitingResearchObservation).mock.calls[0]![2].outputArtifact;
    const reference = { artifactId: "retained-read", sha256: output.hash };
    expect(
      await readRecruitingResearchReadArtifact(f.uploads[0]!.bytes, {
        task: f.task,
        action: { ...f.action, outputArtifacts: [reference] },
        artifact: reference,
      }),
    ).toEqual(snapshot);
    expect(recordRecruitingResearchObservation).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        historicalBackfill: true,
        outputArtifact: expect.objectContaining({
          clientNonce: `recruiting-observation:${read.effect.id}`,
        }),
      }),
    );
    await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admitted as never,
      { rows: [{ b: 2, a: 1 }], next_cursor: "next" },
      context,
      { effectId: "different-native-read", request: read.effect.request },
    );
    expect(Buffer.from(f.uploads[0]!.bytes).equals(Buffer.from(f.uploads[2]!.bytes))).toBe(false);
  });

  it("recovers a completed read in a new run before live server validation and does not cache mapped reads", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    f.saved.server.enabled = false;
    f.saved.server.revision = 99;
    vi.mocked(readRecruitingResearchContext).mockImplementation(async (_db, _actor, input) => {
      if (!input.historical) throw new IsolationError();
      return f.saved as never;
    });
    const trusted = { ...f.trusted, runId: "new-run" };
    const capture = { ...context, runId: "new-run" };
    const result = await tools.resolveRecruitingResearchTool(
      f.deps,
      trusted,
      { operation: "rows", taskId: "task", cursor: "page-1", limit: 10 },
      capture,
    );
    expect(result.recoveredResult).toMatchObject({
      status: "recovered",
      receipts: [
        {
          providerResult: read.effect.result,
        },
      ],
    });
    expect(recordRecruitingResearchObservation).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        runId: "new-run",
        actionId: "action",
        effectId: read.effect.id,
        request: read.effect.request,
        rawResult: read.effect.result,
        historicalBackfill: true,
      }),
    );
    expect(readRecruitingResearchContext).toHaveBeenCalledTimes(1);
    expect(f.artifacts.put).toHaveBeenCalledWith(expect.anything(), capture);
    vi.mocked(listUnmappedRecruitingResearchReads).mockResolvedValue([]);
    await expect(
      tools.resolveRecruitingResearchTool(
        f.deps,
        trusted,
        { operation: "rows", taskId: "task", cursor: "page-1", limit: 10 },
        capture,
      ),
    ).rejects.toThrow(IsolationError);
    expect(recordRecruitingResearchObservation).toHaveBeenCalledTimes(1);
  });

  it("reuses original recorded receipt metadata while indexing its native result", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    const rows = [{ name: { value: "Example", source_id: "source" } }, null];
    read.effect.result = { structuredContent: { rows, output_id: "original-output" } } as never;
    const outputArtifact = {
      name: "original-receipt.json",
      mimeType: "application/json",
      size: 100,
      hash: "a".repeat(64),
      storageKey: "original-blob",
      clientNonce: `recruiting-observation:${read.effect.id}`,
    };
    vi.mocked(listUnmappedRecruitingResearchReads).mockResolvedValue([
      { ...read, outputArtifact },
    ] as never);
    await tools.resolveRecruitingResearchTool(
      f.deps,
      f.trusted,
      { operation: "rows", taskId: "task", cursor: "page-1", limit: 10 },
      context,
    );
    expect(recordRecruitingResearchObservation).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        rows,
        outputId: "original-output",
        outputArtifact,
        historicalBackfill: true,
      }),
    );
    expect(f.artifacts.put).not.toHaveBeenCalled();
  });

  it("backfills an unrelated pending page while admitting the requested fresh read", async () => {
    const f = researchFixture("continue");
    pendingRead(f, "different-page");
    const result = await tools.resolveRecruitingResearchTool(
      f.deps,
      f.trusted,
      { operation: "rows", taskId: "task", cursor: "page-1", limit: 10 },
      context,
    );
    expect(result.recoveredResult).toBeUndefined();
    expect(recordRecruitingResearchObservation).toHaveBeenCalledOnce();
    expect(readRecruitingResearchContext).toHaveBeenLastCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({ taskId: "task", toolName: "get_rows" }),
    );
    expect(vi.mocked(readRecruitingResearchContext).mock.lastCall![2].historical).not.toBe(true);
  });

  it("backfills a rows receipt without returning it as the requested status result", async () => {
    const f = researchFixture("continue");
    pendingRead(f);
    const result = await tools.resolveRecruitingResearchTool(
      f.deps,
      f.trusted,
      { operation: "status", taskId: "task" },
      context,
    );
    expect(result.recoveredResult).toBeUndefined();
    expect(result.args).toEqual({ task_id: "provider-original", wait_seconds: 10 });
    expect(recordRecruitingResearchObservation).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({ toolName: "get_rows", historicalBackfill: true }),
    );
    expect(readRecruitingResearchContext).toHaveBeenLastCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({ toolName: "get_task" }),
    );
  });

  it("returns every exact pending receipt without choosing a latest cross-run observation", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    const another = {
      ...read,
      effect: {
        ...read.effect,
        id: "another-read",
        runId: "another-run",
        result: { rows: [{ value: "another legitimate capture" }], next_cursor: "page-2" },
      },
    };
    vi.mocked(listUnmappedRecruitingResearchReads).mockResolvedValue([read, another] as never);
    const result = await tools.resolveRecruitingResearchTool(
      f.deps,
      f.trusted,
      { operation: "rows", taskId: "task", cursor: "page-1", limit: 10 },
      context,
    );
    expect(result.recoveredResult?.receipts.map((receipt) => receipt.providerResult)).toEqual([
      read.effect.result,
      another.effect.result,
    ]);
    expect(recordRecruitingResearchObservation).toHaveBeenCalledTimes(2);
  });

  it("recovers raw MCP reads from the historical owned task after its active role changes", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    f.saved.thread.activeRecruitingRoleId = null;
    vi.mocked(readRecruitingResearchContext).mockImplementation(async (_db, _actor, input) => {
      if (!input.historical) throw new IsolationError();
      return f.saved as never;
    });
    const call = { ...f.call, tool: read.effect.kind, route: read.route, args: read.args };
    const result = await tools.admitRecruitingResearchCall(f.deps, f.trusted, call, context, {
      frozenRequest: read.effect.request,
    });
    expect(result).toMatchObject({
      kind: "read",
      recoveredResult: {
        status: "recovered",
        receipts: [
          {
            providerResult: read.effect.result,
          },
        ],
      },
    });
    expect(f.prisma.recruitingResearchTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: { spaceId: "space", userId: "owner" },
          mcpServerId: "source",
          serverRevision: 2,
          providerTaskId: "provider-original",
          actions: { some: {} },
        }),
      }),
    );
  });

  // Research started directly on the provider has a followed task row but no native actions;
  // the lookup's `actions: { some: {} }` filter returns nothing, so its reads stay native.
  it("leaves an unrelated raw MCP read outside the recruiting lifecycle", async () => {
    const f = researchFixture("continue");
    f.saved.thread.activeRecruitingRoleId = null;
    f.prisma.recruitingResearchTask.findFirst.mockResolvedValue(null as never);
    await expect(
      tools.admitRecruitingResearchCall(
        { prisma: f.deps.prisma },
        f.trusted,
        {
          ...f.call,
          route: { ...f.call.route, toolName: "get_rows" },
          args: { task_id: "unrelated-native-task" },
        },
        context,
        { frozenRequest: {} },
      ),
    ).resolves.toBeUndefined();
    expect(listUnmappedRecruitingResearchReads).not.toHaveBeenCalled();
    expect(readRecruitingResearchContext).not.toHaveBeenCalled();
  });

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
    expect(manifest).toMatchObject({
      version: 3,
      purpose: "calibration",
      approvalEffectId: "g1-approval",
    });
    expect(manifest.source.anchor.messageId).toBe("answer");
    expect(loadContext).toHaveBeenCalledWith("answer", null);
    expect(prepareRecruitingResearchAction).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        sourceMessageId: "answer",
        purpose: "calibration",
        approvalEffectId: "g1-approval",
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

  it.each([{ purpose: "scale" as const }, { approvalEffectId: "other-approval" }])(
    "rejects changed phase or approval under a saved nonce %#",
    async (changed) => {
      const f = researchFixture();
      await expect(
        tools.prepareRecruitingResearchTool(
          f.deps,
          f.trusted,
          { ...input, ...changed },
          context,
          vi.fn(),
        ),
      ).rejects.toThrow();
      expect(f.artifacts.put).not.toHaveBeenCalled();
      expect(prepareRecruitingResearchAction).not.toHaveBeenCalled();
    },
  );

  it("prepares an explicitly approved scale action on the same existing provider task", async () => {
    const f = researchFixture("continue");
    vi.mocked(readRecruitingResearchContext)
      .mockResolvedValueOnce({ ...f.saved, action: null } as never)
      .mockResolvedValueOnce(f.saved as never);
    vi.mocked(prepareRecruitingResearchAction).mockImplementation(
      async (_db, _actor, prepared) =>
        ({ task: f.task, action: { ...f.action, ...prepared, id: "scale-action" } }) as never,
    );
    const result = await tools.prepareRecruitingResearchTool(
      f.deps,
      f.trusted,
      {
        ...continuationInput,
        operation: "continue",
        taskId: "task",
        clientNonce: "scale-round",
        purpose: "scale",
        approvalEffectId: "g2-approval",
      },
      context,
      async () => loaded,
    );
    expect(prepareRecruitingResearchAction).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        kind: "continue",
        taskId: "task",
        purpose: "scale",
        approvalEffectId: "g2-approval",
      }),
    );
    expect(result).toMatchObject({ task: { id: "task" } });
    const manifest = JSON.parse(Buffer.from(f.uploads[0]!.bytes).toString("utf8"));
    expect(manifest).toMatchObject({
      version: 3,
      operation: "continue",
      purpose: "scale",
      approvalEffectId: "g2-approval",
      args: {
        task_id: "provider-original",
        message: expect.stringContaining("Research purpose:\nscale"),
      },
    });
  });

  it("freezes the verified native G2 task before adopting its first formal scale action", async () => {
    const f = researchFixture("continue");
    vi.mocked(readRecruitingResearchContext).mockResolvedValue({
      ...f.saved,
      action: null,
      task: null,
      nativeResearchTarget: {
        mcpServerId: "source",
        serverRevision: 2,
        providerTaskId: "provider-original",
      },
    } as never);
    vi.mocked(prepareRecruitingResearchAction).mockImplementation(
      async (_db, _actor, prepared) =>
        ({
          task: f.task,
          action: { ...f.action, ...prepared, id: "native-scale-action" },
        }) as never,
    );
    const round = continuationInput;
    const nativeInput = {
      ...round,
      operation: "continue" as const,
      purpose: "scale" as const,
      approvalEffectId: "native-g2",
      clientNonce: "native-scale",
    };
    const nativeTool = builtinAgentTools.find((entry) => entry.name === "recruiting_research")!;
    expect(
      validateToolArguments(
        { ...nativeTool, parameters: parametersFor(nativeTool) },
        { type: "toolCall", id: "native-scale", name: nativeTool.name, arguments: nativeInput },
      ),
    ).toEqual(nativeInput);
    const result = await tools.prepareRecruitingResearchTool(
      f.deps,
      f.trusted,
      nativeInput,
      context,
      async () => loaded,
    );
    expect(readRecruitingResearchContext).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        purpose: "scale",
        approvalEffectId: "native-g2",
        toolName: "reply",
      }),
    );
    expect(prepareRecruitingResearchAction).toHaveBeenCalledWith(
      f.deps.prisma,
      actor,
      expect.objectContaining({
        kind: "continue",
        purpose: "scale",
        approvalEffectId: "native-g2",
        providerTaskId: "provider-original",
      }),
    );
    const manifest = JSON.parse(Buffer.from(f.uploads[0]!.bytes).toString("utf8"));
    expect(manifest).toMatchObject({
      version: 3,
      operation: "continue",
      purpose: "scale",
      args: { task_id: "provider-original" },
      route: { resourceId: "source", resourceRevision: 2, toolName: "reply" },
    });
    expect(result).toMatchObject({ task: { id: "task" } });
  });

  it.each([
    { purpose: "scale" as const },
    { purpose: null },
    { approvalEffectId: "other-approval" },
    { approvalEffectId: null },
  ])("rejects action metadata that differs from verified frozen bytes %#", async (changed) => {
    const f = researchFixture();
    Object.assign(f.action, changed);
    await expect(f.admit()).rejects.toThrow(IsolationError);
    await expect(
      tools.resolveRecruitingResearchTool(
        f.deps,
        f.trusted,
        { operation: "start", actionId: "action" },
        context,
      ),
    ).rejects.toThrow(IsolationError);
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it.each([
    { purpose: "scale" },
    { approvalEffectId: "other-approval" },
    { purpose: undefined },
    { approvalEffectId: undefined },
  ])("rejects rehashed request metadata that differs from its action %#", async (changed) => {
    const f = researchFixture();
    const manifest = { ...f.request.manifest, ...changed };
    if (changed.purpose === "scale" && "prompt" in manifest.args)
      manifest.args = {
        prompt: manifest.args.prompt.replace(
          "Research purpose:\ncalibration",
          "Research purpose:\nscale",
        ),
      };
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    f.blobs.set("request-blob", bytes);
    f.action.requestArtifactHash = hash;
    f.saved.requestArtifact.hash = hash;
    await expect(f.admit()).rejects.toThrow();
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
    expect(f.artifacts.put).not.toHaveBeenCalled();
  });

  function useLegacyRequest(f: ReturnType<typeof researchFixture>) {
    const legacy = JSON.parse(f.request.bytes.toString("utf8"));
    legacy.version = 1;
    delete legacy.purpose;
    delete legacy.approvalEffectId;
    delete legacy.candidateOutputSchema;
    const key = legacy.operation === "create" ? "prompt" : "message";
    legacy.args[key] = legacy.args[key]
      .replace("Research purpose:\ncalibration\n\n", "")
      .split("\n\nCanonical candidate output schema:")[0];
    const bytes = Buffer.from(JSON.stringify(legacy), "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    f.blobs.set("request-blob", bytes);
    f.action.requestArtifactHash = hash;
    f.saved.requestArtifact.hash = hash;
    f.action.purpose = null;
    f.action.approvalEffectId = null;
    f.action.candidateOutputSchema = null;
    return bytes;
  }

  it("keeps a legacy task readable but never upgrades its prepared action for dispatch", async () => {
    const f = researchFixture("continue");
    const bytes = useLegacyRequest(f);
    await expect(
      tools.resolveRecruitingResearchTool(
        f.deps,
        f.trusted,
        { operation: "status", taskId: "task" },
        context,
      ),
    ).resolves.toMatchObject({ args: { task_id: "provider-original" } });
    await expect(f.admit()).rejects.toThrow();
    await expect(
      tools.resolveRecruitingResearchTool(
        f.deps,
        f.trusted,
        { operation: "start", actionId: "action" },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      tools.prepareRecruitingResearchTool(
        f.deps,
        f.trusted,
        { ...continuationInput, operation: "continue", taskId: "task" },
        context,
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(f.blobs.get("request-blob")).toEqual(bytes);
    expect(f.artifacts.put).not.toHaveBeenCalled();
    expect(prepareRecruitingResearchAction).not.toHaveBeenCalled();
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
  });

  it("records rows from a legacy task without rewriting or assigning its mutation metadata", async () => {
    const f = researchFixture("continue");
    const bytes = useLegacyRequest(f);
    const call = {
      ...f.call,
      tool: "mcp__source__get_rows",
      route: { ...f.call.route, toolName: "get_rows" },
      args: { task_id: "provider-original", cursor: "legacy-page" },
    };
    const request = boundDirectApprovalRequest(call.route, call.args, "__rakazoCatalogTool");
    const admission = await tools.admitRecruitingResearchCall(f.deps, f.trusted, call, context, {
      taskId: "task",
      frozenRequest: request,
    });
    const providerResult = {
      structuredContent: { rows: [{ value: "original raw report value" }], next_cursor: null },
    };
    await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admission!,
      providerResult,
      context,
      { effectId: "legacy-read-effect", request },
    );
    const snapshot = JSON.parse(Buffer.from(f.uploads[0]!.bytes).toString("utf8"));
    expect(snapshot.providerResult).toEqual(providerResult);
    expect(f.action).toMatchObject({ purpose: null, approvalEffectId: null });
    expect(f.blobs.get("request-blob")).toEqual(bytes);
    expect(recordRecruitingResearchObservation).toHaveBeenCalledOnce();
    expect(reconcileRecruitingResearchAction).not.toHaveBeenCalled();
    expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
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
        purpose: "calibration",
        approvalEffectId: "g1-approval",
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

  it.each([
    ["create", "role"],
    ["create", null],
    ["continue", "role"],
    ["continue", null],
  ] as const)(
    "keeps native %s under MCP execution when the selected role is %s",
    async (operation, roleId) => {
      const f = researchFixture(operation);
      f.saved.thread.activeRecruitingRoleId = roleId;
      await expect(
        tools.admitRecruitingResearchCall(f.deps, f.trusted, f.call, context, {
          frozenRequest: f.frozenRequest,
        }),
      ).resolves.toBeUndefined();
      expect(f.prisma.run.findFirst).not.toHaveBeenCalled();
      expect(readRecruitingResearchContext).not.toHaveBeenCalled();
      expect(admitRecruitingResearchAction).not.toHaveBeenCalled();
      expect(f.artifacts.put).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicit action whose MCP arguments omit its frozen conditions", async () => {
    const f = researchFixture();
    await expect(
      tools.admitRecruitingResearchCall(
        f.deps,
        f.trusted,
        { ...f.call, args: { prompt: "Find anyone" } },
        context,
        { actionId: "action", frozenRequest: { prompt: "Find anyone" } },
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

  it("validates an explicitly selected reply independently of the MCP hostname", async () => {
    const f = researchFixture("continue");
    f.prisma.mcpServer.findFirst.mockResolvedValue({ endpoint: "https://other.example.test/mcp" });

    await expect(
      tools.admitRecruitingResearchCall(f.deps, f.trusted, f.call, context, {
        actionId: "action",
        frozenRequest: f.frozenRequest,
      }),
    ).resolves.toMatchObject({ kind: "mutation", operation: "continue", status: "ready" });

    expect(f.prisma.mcpServer.findFirst).not.toHaveBeenCalled();
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

  it("hands a still-working task to the background poll once and says so in the tool result", async () => {
    const f = researchFixture("continue");
    const admission = await f.admit();
    const enqueue = vi.fn(async () => undefined);
    const providerResult = {
      structuredContent: { task_id: "provider-original", status: "accepted", activity: "queued" },
    };
    f.effect.status = "completed";
    f.effect.result = providerResult;
    const result = await tools.completeRecruitingResearchCall(
      { ...f.deps, jobs: { enqueue } },
      f.trusted,
      admission!,
      providerResult,
      context,
    );
    expect(result).toMatchObject({
      observation: { deliveryState: "accepted", done: false },
      background: expect.stringContaining("delivered to this conversation automatically"),
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "recruiting_research.poll",
        payload: { taskId: "task" },
        replaceKey: "recruiting_research.poll:task",
        availableAt: expect.any(Date),
      }),
    );
    // Without a job publisher the call behaves exactly as before.
    const plain = await tools.completeRecruitingResearchCall(
      f.deps,
      f.trusted,
      admission!,
      providerResult,
      context,
    );
    expect(plain).not.toHaveProperty("background");
  });

  it("does not poll a task the provider already finished", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    const enqueue = vi.fn(async () => undefined);
    const result = await tools.completeRecruitingResearchCall(
      { ...f.deps, jobs: { enqueue } },
      f.trusted,
      {
        kind: "read",
        operation: "status",
        saved: f.saved,
        call: {
          ...f.call,
          route: { ...read.route, toolName: "get_task" },
          args: { task_id: "provider-original", wait_seconds: 10 },
        },
      } as never,
      { structuredContent: { task_id: "provider-original", state: "completed", done: true } },
      context,
      { effectId: read.effect.id, request: read.effect.request },
    );
    expect(result).toMatchObject({
      observation: { done: true, observedProviderState: "completed" },
    });
    expect(result).not.toHaveProperty("background");
    expect(enqueue).not.toHaveBeenCalled();
  });

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
      const candidateRows = [{ rowIndex: 0, candidateKey: "source-row:read-effect:0" }];
      vi.mocked(recordRecruitingResearchObservation).mockResolvedValue({
        task: f.task,
        action: f.action,
        candidateRows,
      } as never);
      const pageReceipt = await tools.completeRecruitingResearchCall(
        f.deps,
        f.trusted,
        admission!,
        providerResult,
        context,
        { effectId: readEffect.id, request: readEffect.request },
      );
      expect(pageReceipt).toHaveProperty("candidateRows", candidateRows);
      const readRows = "candidateRows" in pageReceipt ? pageReceipt.candidateRows : undefined;
      if (!readRows?.[0]) throw new Error("Missing indexed candidate row reference");
      const assessment = {
        operation: "save",
        roleId: "role",
        roleRevisionId: "revision",
        candidateKey: readRows[0].candidateKey,
        expectedRevision: 0,
        facts: [],
        questions: [],
        sourceRefs: [],
        atomJudgments: [],
        employmentEvaluations: [],
      };
      vi.mocked(saveRecruitingAssessment).mockResolvedValue({
        assessment: { candidateKey: assessment.candidateKey, version: 1 },
      } as never);
      const assessmentDb = {
        run: {
          findFirst: vi.fn(async () => ({
            ...actor,
            id: "run",
            threadId: "thread",
            botId: "bot",
            bot: actor,
          })),
        },
        artifact: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient;
      await executeRecruitingAssessmentTool(
        { prisma: assessmentDb, artifacts: f.deps.artifacts },
        {
          actor,
          runId: "run",
          threadId: "thread",
          botId: "bot",
          save: {
            leaseOwner: "worker",
            leaseFence: 1,
            effectId: "assessment-effect",
            effectRequest: assessment,
          },
        },
        assessment,
        context,
      );
      expect(saveRecruitingAssessment).toHaveBeenCalledWith(
        assessmentDb,
        actor,
        expect.anything(),
        expect.objectContaining({ candidateKey: candidateRows[0]!.candidateKey }),
        [],
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
          rows,
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
      expect(snapshot.providerResult.structuredContent.rows).toEqual(rows);
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
