import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Actor } from "@rakazo/contracts";
import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import {
  executeRecruitingRoleMutation,
  getRecruitingWorkspace,
  IsolationError,
  saveRecruitingCandidateCsvImport,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import { parametersFor } from "./pi-runtime.js";
import * as tools from "./recruiting-tools.js";
import { executeRecruitingRoleTool } from "./recruiting-tools.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  executeRecruitingRoleMutation: vi.fn(),
  getRecruitingWorkspace: vi.fn(),
  recruitingResearchSnapshot: vi.fn(),
  saveRecruitingAssessment: vi.fn(),
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

  it("keeps a valid email column, lowercased, and leaves out what is not an address", async () => {
    vi.mocked(saveRecruitingCandidateCsvImport).mockResolvedValue({ status: "saved" } as never);
    const d = deps("Name,Email\r\nNoah Test,Noah@Example.test\r\nAda,not an email\r\n");
    await tools.importRecruitingCandidateCsv(
      d as never,
      trusted,
      { ...input, mapping: { name: "Name", email: "Email" } },
      adapterContext,
    );
    const captured = vi.mocked(saveRecruitingCandidateCsvImport).mock.calls[0]![4];
    expect(captured.rows.map((row) => row.row)).toEqual([
      { name: "Noah Test", email: "noah@example.test" },
      { name: "Ada" },
    ]);
  });

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

  it("saves the role again when its save deadlocked with a search saving into it", async () => {
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
    // A Postgres deadlock as Prisma reports it from a raw query.
    const deadlock = Object.assign(new Error("deadlock detected"), {
      meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
    });
    vi.mocked(executeRecruitingRoleMutation)
      .mockReset()
      .mockRejectedValueOnce(deadlock)
      .mockResolvedValueOnce(receipt as never);
    expect(
      await executeRecruitingRoleTool(
        {} as PrismaClient,
        { ...context, mutation: { ...mutation, effectRequest: input } },
        input,
      ),
    ).toEqual(receipt);
    expect(executeRecruitingRoleMutation).toHaveBeenCalledTimes(2);
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

import { createHash } from "node:crypto";
