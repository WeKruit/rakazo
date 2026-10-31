import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Actor } from "@rakazo/contracts";
import { RecruitingResearchToolInputSchema } from "@rakazo/contracts";
import {
  boundDirectApprovalRequest,
  projectRecruitingCandidateReport,
  readRecruitingResearchReadArtifact,
} from "@rakazo/core";
import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import {
  bindRecruitingResearchReadEffect,
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  listUnmappedRecruitingResearchReads,
  readNativeRecruitingCandidatePage,
  readRecruitingResearchContext,
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
import * as tools from "./recruiting-tools.js";
import { executeRecruitingRoleTool } from "./recruiting-tools.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  executeRecruitingRoleMutation: vi.fn(),
  getRecruitingWorkspace: vi.fn(),
  readRecruitingResearchContext: vi.fn(),
  recruitingResearchSnapshot: vi.fn(),
  bindRecruitingResearchReadEffect: vi.fn(),
  listUnmappedRecruitingResearchReads: vi.fn(),
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

  it("retains mapped email and phone in the saved candidate report", async () => {
    const contactInput = RecruitingResearchToolInputSchema.parse({
      ...input,
      mapping: { ...input.mapping, email: "Email", phone: "Phone" },
    });
    if (contactInput.operation !== "import_csv") throw new Error("Expected CSV import");
    const d = deps(
      "Name,LinkedIn,Company,Email,Phone\n" +
        "Ada Example,https://www.linkedin.com/in/example,Example Co,ada@example.test,+1 555 0100\n",
    );
    await tools.importRecruitingCandidateCsv(
      d as never,
      { ...trusted, effectRequest: contactInput },
      contactInput,
      adapterContext,
    );
    const captured = vi.mocked(saveRecruitingCandidateCsvImport).mock.calls[0]![4];
    expect(captured.rows[0]!.row).toMatchObject({
      email: "ada@example.test",
      phone: "+1 555 0100",
    });
    expect(projectRecruitingCandidateReport(captured.rows[0]!.row).fields).toEqual(
      expect.arrayContaining([
        { label: "Email", value: "ada@example.test", sourceUrls: [] },
        { label: "Phone", value: "+1 555 0100", sourceUrls: [] },
      ]),
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
    const route = {
      connectorId: "mcp" as const,
      resourceId: "source",
      resourceRevision: 2,
      toolName: operation === "create" ? "research" : "reply",
    };
    const bytes = Buffer.from(JSON.stringify({ route }), "utf8");
    const request = {
      manifest: {
        route,
        args:
          operation === "create"
            ? { prompt: "Find engineers" }
            : { task_id: "provider-original", message: "Find engineers" },
      },
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
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
      run: {
        findFirst: vi.fn().mockResolvedValue({ thread: saved.thread }),
        // Live runs only; a stopped run counts 0.
        count: vi.fn().mockResolvedValue(1),
      },
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
      tools.admitRecruitingResearchCall(deps, trusted, call, context, { taskId: task.id });
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
    const result = await tools.admitRecruitingResearchCall(f.deps, f.trusted, call, context, {});
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
        {},
      ),
    ).resolves.toBeUndefined();
    expect(listUnmappedRecruitingResearchReads).not.toHaveBeenCalled();
    expect(readRecruitingResearchContext).not.toHaveBeenCalled();
  });

  function useLegacyRequest(f: ReturnType<typeof researchFixture>) {
    f.action.purpose = null;
    f.action.approvalEffectId = null;
    f.action.candidateOutputSchema = null;
    return f.blobs.get("request-blob");
  }

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
        tools.admitRecruitingResearchCall(f.deps, f.trusted, f.call, context, {}),
      ).resolves.toBeUndefined();
      expect(f.prisma.run.findFirst).not.toHaveBeenCalled();
      expect(readRecruitingResearchContext).not.toHaveBeenCalled();
      expect(f.artifacts.put).not.toHaveBeenCalled();
    },
  );

  it("leaves unrelated connector tools outside recruiting admission", async () => {
    const f = researchFixture();
    await expect(
      tools.admitRecruitingResearchCall(
        f.deps,
        f.trusted,
        { ...f.call, route: { ...f.call.route, toolName: "list_notes" } },
        context,
        {},
      ),
    ).resolves.toBeUndefined();
    expect(readRecruitingResearchContext).not.toHaveBeenCalled();
  });

  it.each(["task"] as const)(
    "still validates an explicit %s after the thread's role is unbound",
    async (selector) => {
      const f = researchFixture("continue");
      f.saved.thread.activeRecruitingRoleId = null;
      vi.mocked(readRecruitingResearchContext).mockReset().mockRejectedValue(new IsolationError());
      const call = {
        ...f.call,
        tool: "mcp__source__get_rows",
        route: { ...f.call.route, toolName: "get_rows" },
        args: { task_id: "provider-original" },
      };

      await expect(
        tools.admitRecruitingResearchCall(f.deps, f.trusted, call, context, {
          taskId: selector,
        }),
      ).rejects.toThrow(IsolationError);

      expect(readRecruitingResearchContext).toHaveBeenCalledWith(
        f.deps.prisma,
        actor,
        expect.objectContaining({
          runId: "run",
          taskId: selector,
        }),
      );
    },
  );

  it("hands a still-working task to the background poll once and says so in the tool result", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    const enqueue = vi.fn(async () => undefined);
    const providerResult = {
      structuredContent: { task_id: "provider-original", state: "working", done: false },
    };
    const admission = {
      kind: "read",
      operation: "status",
      saved: f.saved,
      call: {
        ...f.call,
        route: { ...read.route, toolName: "get_task" },
        args: { task_id: "provider-original", wait_seconds: 10 },
      },
    } as never;
    const receipt = { effectId: read.effect.id, request: read.effect.request };
    const result = await tools.completeRecruitingResearchCall(
      { ...f.deps, jobs: { enqueue } },
      f.trusted,
      admission,
      providerResult,
      context,
      receipt,
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
      admission,
      providerResult,
      context,
      receipt,
    );
    expect(plain).not.toHaveProperty("background");
  });

  it("never hands a research to the background poll from a run that was stopped", async () => {
    const f = researchFixture("continue");
    const read = pendingRead(f);
    const enqueue = vi.fn(async () => undefined);
    vi.mocked(f.prisma.run.count).mockResolvedValue(0);
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
      { structuredContent: { task_id: "provider-original", state: "working", done: false } },
      context,
      { effectId: read.effect.id, request: read.effect.request },
    );
    expect(f.prisma.run.count).toHaveBeenCalledWith({
      where: { id: "run", status: { in: expect.not.arrayContaining(["cancelled"]) } },
    });
    expect(result).not.toHaveProperty("background");
    expect(enqueue).not.toHaveBeenCalled();
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
      expect(f.action.receiptArtifactId).toBe(receipt);
    },
  );
});

import { createHash } from "node:crypto";

describe("withCandidatePageSummary", () => {
  const receipt = { status: "saved", roleId: "role", sourceEffectId: "page-2", candidateRows: [] };
  const person = (key: string, match?: unknown) => ({
    candidateKey: key,
    name: key,
    title: "Live Ops",
    company: "Acme",
    location: "Los Angeles",
    linkedinUrl: `https://www.linkedin.com/in/${key}`,
    matchFields: match ?? {},
  });

  it("names the new people saved on the page and counts the ones already in the pool", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([person("a", { tier: "A" }), person("b"), person("c")])
      .mockResolvedValueOnce([{ candidateKey: "b" }]);
    const result = (await tools.withCandidatePageSummary(
      { recruitingCandidateOccurrence: { findMany } } as unknown as PrismaClient,
      receipt,
      [{ grade: { value: "A" } }, { grade: "B" }, { grade: "B" }],
    )) as { summary: { saved: number; newToRole: number; people: { name: string }[] } };
    expect(result).toMatchObject({
      ...receipt,
      summary: { saved: 3, newToRole: 2, grades: { A: 1, B: 2 } },
    });
    expect(result.summary.people).toEqual([
      {
        name: "a",
        title: "Live Ops",
        company: "Acme",
        location: "Los Angeles",
        linkedinUrl: "https://www.linkedin.com/in/a",
        match: { tier: "A" },
      },
      {
        name: "c",
        title: "Live Ops",
        company: "Acme",
        location: "Los Angeles",
        linkedinUrl: "https://www.linkedin.com/in/c",
      },
    ]);
  });

  it("keeps the saved receipt when the summary cannot be read", async () => {
    const findMany = vi.fn().mockRejectedValue(new Error("pool timeout"));
    expect(
      await tools.withCandidatePageSummary(
        { recruitingCandidateOccurrence: { findMany } } as unknown as PrismaClient,
        receipt,
      ),
    ).toBe(receipt);
  });
});
