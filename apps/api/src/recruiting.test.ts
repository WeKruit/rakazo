import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { RecruitingAssessmentSnapshotSchema } from "@rakazo/contracts";
import type * as DbExports from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import * as api from "./recruiting.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbExports>();
  return {
    ...actual,
    confirmRecruitingBrief: vi.fn(),
    createRecruitingRole: vi.fn(),
    bindRecruitingRole: vi.fn(),
    getRecruitingWorkspace: vi.fn(),
    reviseRecruitingRole: vi.fn(),
    listRecruitingAssessments: vi.fn(),
    getRecruitingAssessment: vi.fn(),
    listRecruitingResearch: vi.fn(),
  };
});
const prisma = {} as PrismaClient;
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("authenticated recruiting API", () => {
  it("forwards native RPC inputs and trusted actors to the one shared domain implementation", async () => {
    for (const [domain, wrapper] of [
      [db.createRecruitingRole, api.createRecruitingRole],
      [db.bindRecruitingRole, api.bindRecruitingRole],
      [db.getRecruitingWorkspace, api.getRecruitingWorkspace],
      [db.reviseRecruitingRole, api.reviseRecruitingRole],
      [db.listRecruitingAssessments, api.listRecruitingAssessments],
      [db.getRecruitingAssessment, api.getRecruitingAssessment],
      [db.listRecruitingResearch, api.listRecruitingResearch],
    ] as const) {
      const output = { synthetic: true };
      vi.mocked(domain).mockResolvedValueOnce(output as never);
      const input = { roleId: "role", threadId: "thread" } as never;
      expect(await wrapper(prisma, actor, input)).toEqual(output);
      expect(domain).toHaveBeenLastCalledWith(
        ...(domain === db.createRecruitingRole || domain === db.reviseRecruitingRole
          ? [prisma, actor, input, undefined]
          : [prisma, actor, input]),
      );
    }
  });
  it("maps missing scoped resources to a generic not-found response", async () => {
    vi.mocked(db.getRecruitingWorkspace).mockRejectedValueOnce(
      new IsolationError("Private title and text"),
    );
    await expect(
      api.getRecruitingWorkspace(prisma, actor, { threadId: "other-thread" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  });
  it("maps authorized quote errors to actionable BAD_REQUEST without exposing material", async () => {
    const error = new RecruitingSourceValidationError("jd", "text");
    for (const [domain, wrapper] of [
      [db.createRecruitingRole, api.createRecruitingRole],
      [db.reviseRecruitingRole, api.reviseRecruitingRole],
    ] as const) {
      vi.mocked(domain).mockRejectedValueOnce(error);
      const response = await wrapper(prisma, actor, {} as never).catch((error: unknown) => error);
      expect(response).toMatchObject({ code: "BAD_REQUEST", message: error.message });
      expect(JSON.parse(JSON.stringify(response))).toMatchObject({
        code: "BAD_REQUEST",
        message:
          'Source "jd" at "text": quote must be exact contiguous text from the original read receipt; copy one unchanged excerpt without omissions or joined passages.',
      });
      vi.mocked(domain).mockRejectedValueOnce(new IsolationError("Private source details"));
      await expect(wrapper(prisma, actor, {} as never)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found",
      });
    }
  });
  it("maps CAS conflicts to CONFLICT and validation failures without echoing input", async () => {
    vi.mocked(db.reviseRecruitingRole).mockRejectedValueOnce(new RecruitingConflictError());
    await expect(api.reviseRecruitingRole(prisma, actor, {} as never)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const error = new Error("Private submitted source");
    error.name = "ZodError";
    vi.mocked(db.createRecruitingRole).mockRejectedValueOnce(error);
    await expect(api.createRecruitingRole(prisma, actor, {} as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid recruiting input",
    });
  });
});

describe("native recruiting RPC", () => {
  it("runs the existing router through shared storage with its authenticated actor", async () => {
    const client = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: { actor },
    });
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce(null);
    expect(await client.recruiting.getWorkspace({ threadId: "thread" })).toBeNull();
    expect(db.getRecruitingWorkspace).toHaveBeenLastCalledWith(prisma, actor, {
      threadId: "thread",
    });
    vi.mocked(db.bindRecruitingRole).mockResolvedValueOnce(null);
    expect(await client.recruiting.bindRole({ threadId: "thread", roleId: null })).toBeNull();
    expect(db.bindRecruitingRole).toHaveBeenLastCalledWith(prisma, actor, {
      threadId: "thread",
      roleId: null,
    });
    vi.mocked(db.listRecruitingAssessments).mockResolvedValueOnce([]);
    expect(await client.recruiting.listAssessments({ roleId: "role" })).toEqual([]);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValueOnce(null);
    expect(
      await client.recruiting.getAssessment({ roleId: "role", candidateKey: "row" }),
    ).toBeNull();
    vi.mocked(db.listRecruitingResearch).mockResolvedValueOnce({ tasks: [], actions: [] });
    expect(await client.recruiting.listResearch({ roleId: "role" })).toEqual({
      tasks: [],
      actions: [],
    });
  });
  it("supplies native artifact storage and authenticated context for both role writes", async () => {
    const artifacts = { get: vi.fn() };
    const client = createRouterClient(
      createRouter({ prisma, artifacts } as unknown as RouterDeps),
      { context: { actor } },
    );
    const definition = {
      title: "Example role",
      sourceRefs: [
        {
          id: "source",
          kind: "original_material" as const,
          anchor: { kind: "message" as const, messageId: "message", locator: "text:0" },
          readState: "unread" as const,
          readAt: null,
        },
      ],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    };
    const { title: _, ...revisionDefinition } = definition;
    const saved = {
      role: {
        id: "role",
        spaceId: actor.spaceId,
        userId: actor.userId,
        sourceThreadId: "thread",
        title: definition.title,
        revision: 1,
        currentRevisionId: "revision",
      },
      revision: {
        ...revisionDefinition,
        id: "revision",
        roleId: "role",
        revision: 1,
        createdAt: "2026-10-16T00:00:00.000Z",
      },
    };
    const input = { ...definition, sourceThreadId: "thread", expectedRevision: 0 as const };
    vi.mocked(db.createRecruitingRole).mockResolvedValueOnce(saved);
    await client.recruiting.createRole(input);
    expect(db.createRecruitingRole).toHaveBeenLastCalledWith(prisma, actor, input, {
      artifacts,
      context: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: expect.any(AbortSignal),
      }),
    });
    const revision = { ...definition, roleId: "role", expectedRevision: 1 };
    vi.mocked(db.reviseRecruitingRole).mockResolvedValueOnce(saved);
    await client.recruiting.reviseRole(revision);
    expect(db.reviseRecruitingRole).toHaveBeenLastCalledWith(prisma, actor, revision, {
      artifacts,
      context: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: expect.any(AbortSignal),
      }),
    });
  });
  it("returns the original assessment revision and authorized message targets through both RPC reads", async () => {
    const source = {
      id: "source",
      kind: "original_material" as const,
      anchor: { kind: "message" as const, messageId: "message", locator: "text:0" },
      readState: "unread" as const,
      readAt: null,
    };
    const snapshot: DbExports.RecruitingAssessmentSnapshot = {
      assessment: {
        roleId: "role",
        roleRevisionId: "original-revision",
        candidateKey: "row",
        version: 1,
        basedOnVersion: null,
        createdByRunId: "run",
        createdAt: "2026-10-16T00:00:00.000Z",
        facts: [],
        questions: [],
        sourceRefs: [source],
        judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" },
      },
      roleRevision: {
        id: "original-revision",
        roleId: "role",
        revision: 1,
        sourceRefs: [source],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        createdAt: "2026-10-16T00:00:00.000Z",
      },
      isCurrent: false,
      sourceMessageTargets: [
        { messageId: "message", threadId: "source-thread", target: { groupId: "source-group" } },
      ],
    };
    const client = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: { actor },
    });
    vi.mocked(db.listRecruitingAssessments).mockResolvedValueOnce([snapshot]);
    expect(await client.recruiting.listAssessments({ roleId: "role" })).toEqual([snapshot]);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValueOnce(snapshot);
    expect(
      await client.recruiting.getAssessment({ roleId: "role", candidateKey: "row", version: 1 }),
    ).toEqual(snapshot);
    expect(
      RecruitingAssessmentSnapshotSchema.safeParse({
        ...snapshot,
        roleRevision: { ...snapshot.roleRevision, id: "current-revision" },
      }).success,
    ).toBe(false);
    expect(
      RecruitingAssessmentSnapshotSchema.safeParse({
        ...snapshot,
        sourceMessageTargets: [
          {
            messageId: "message",
            threadId: "source-thread",
            target: { botId: "bot", groupId: "group" },
          },
        ],
      }).success,
    ).toBe(false);
    vi.mocked(db.getRecruitingAssessment).mockRejectedValueOnce(
      new IsolationError("Private source-thread and message target"),
    );
    await expect(
      client.recruiting.getAssessment({ roleId: "role", candidateKey: "row" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  });
  it("rejects unauthenticated reads and model-supplied identity before storage", async () => {
    const authenticated = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: { actor },
    });
    const unauthenticated = createRouterClient(createRouter({ prisma } as RouterDeps), {
      context: {},
    });
    const readsBefore = vi.mocked(db.getRecruitingWorkspace).mock.calls.length;
    await expect(
      unauthenticated.recruiting.getWorkspace({ threadId: "thread" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.getRecruitingWorkspace).toHaveBeenCalledTimes(readsBefore);
    const writesBefore = vi.mocked(db.createRecruitingRole).mock.calls.length;
    await expect(
      authenticated.recruiting.createRole({
        sourceThreadId: "thread",
        expectedRevision: 0,
        title: "Synthetic",
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        sourceRefs: [
          {
            id: "source",
            kind: "original_material",
            anchor: { kind: "message", messageId: "message", locator: "text:0" },
            readState: "unread",
            readAt: null,
          },
        ],
        userId: "forged",
        runId: "forged",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.createRecruitingRole).toHaveBeenCalledTimes(writesBefore);
  });
});

it("uses the existing authenticated wrapper for human confirmation and sanitizes foreign access", async () => {
  vi.mocked(db.confirmRecruitingBrief).mockRejectedValueOnce(
    new IsolationError("private source details"),
  );
  await expect(
    api.confirmRecruitingBrief(prisma, actor, {
      threadId: "thread",
      roleId: "role",
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  expect(db.confirmRecruitingBrief).toHaveBeenLastCalledWith(
    prisma,
    actor,
    { threadId: "thread", roleId: "role", expectedRevision: 1 },
    undefined,
  );
});
