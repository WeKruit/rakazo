import { createHash } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { RecruitingAssessmentSnapshotSchema } from "@rakazo/contracts";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type * as DbExports from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./recruiting.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@rakazo/core/node/pdf-text", () => ({ extractPdfText: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbExports>();
  return {
    ...actual,
    confirmRecruitingBrief: vi.fn(),
    editRecruitingCriteria: vi.fn(),
    createRecruitingRole: vi.fn(),
    bindRecruitingRole: vi.fn(),
    getRecruitingWorkspace: vi.fn(),
    reviseRecruitingRole: vi.fn(),
    listRecruitingAssessments: vi.fn(),
    getRecruitingAssessment: vi.fn(),
    listRecruitingResearch: vi.fn(),
    listRecruitingCandidates: vi.fn(),
    listRecruitingCandidateSources: vi.fn(),
    setRecruitingCandidateShortlist: vi.fn(),
  };
});
const prisma = {} as PrismaClient;
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("readable recruiting sources", () => {
  const text = "Original 🧭 candidate evidence\nSecond line";
  const quote = "🧭 candidate evidence";
  const bytes = Buffer.from(
    JSON.stringify({ request: { internalId: "hidden-routing" }, text, nested: { evidence: text } }),
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const source = {
    id: "source",
    kind: "original_material" as const,
    anchor: {
      kind: "artifact" as const,
      artifact: { artifactId: "material", sha256: hash },
      locator: "text",
    },
    readState: "read" as const,
    readAt: "2026-09-01T00:00:00.000Z",
    quote,
  };
  const roleInput = {
    kind: "role" as const,
    threadId: "thread",
    roleRevisionId: "revision",
    sourceRefId: "source",
  };
  function fixture(content = bytes, mimeType = "application/json") {
    const contentHash = createHash("sha256").update(content).digest("hex");
    const savedSource = {
      ...source,
      anchor: { ...source.anchor, artifact: { artifactId: "material", sha256: contentHash } },
    };
    const get = vi.fn(async () => content);
    const findFirst = vi.fn(async () => ({
      id: "material",
      spaceId: actor.spaceId,
      userId: actor.userId,
      storageKey: "stored",
      botId: "bot",
      mimeType,
      size: content.length,
      hash: contentHash,
    }));
    const deps = {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
    };
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
      revision: { id: "revision", sourceRefs: [savedSource], criteria: [] },
    } as never);
    return { deps, get, findFirst, source: savedSource };
  }
  it("reads only a persisted source string and exact highlight without returning its raw wrapper", async () => {
    const f = fixture();
    const value = await api.readRecruitingSource(f.deps, actor, roleInput);
    expect(value).toEqual({
      kind: "text",
      text,
      start: text.indexOf(quote),
      end: text.indexOf(quote) + quote.length,
    });
    expect(JSON.stringify(value)).not.toMatch(
      /hidden-routing|contentBase64|artifactId|sha256|storageKey/,
    );
    expect(db.getRecruitingWorkspace).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      threadId: "thread",
    });
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "material", spaceId: actor.spaceId, userId: actor.userId },
    });
  });
  it("loads the exact stored assessment selection, not a caller-controlled JSON path", async () => {
    const f = fixture();
    const start = text.indexOf(quote);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            ...source,
            kind: "original_material",
            selection: {
              kind: "artifact_json_string",
              path: ["nested", "evidence"],
              start,
              end: start + quote.length,
            },
          },
        ],
      },
    } as never);
    const input = {
      kind: "assessment" as const,
      roleId: "role",
      candidateKey: "candidate",
      version: 2,
      sourceRefId: "source",
    };
    expect(await api.readRecruitingSource(f.deps, actor, input)).toEqual({
      kind: "text",
      text,
      start,
      end: start + quote.length,
    });
    expect(db.getRecruitingAssessment).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      roleId: "role",
      candidateKey: "candidate",
      version: 2,
    });
  });
  it("rejects missing, conflicting, unread or revised stored references before reading bytes", async () => {
    const f = fixture();
    for (const revision of [
      { id: "another-revision", sourceRefs: [source], criteria: [] },
      { id: "revision", sourceRefs: [], criteria: [] },
      {
        id: "revision",
        sourceRefs: [{ ...source, readState: "unread", quote: undefined }],
        criteria: [],
      },
      {
        id: "revision",
        sourceRefs: [source],
        criteria: [{ sourceRefs: [{ ...source, quote: "Second line" }] }],
      },
    ]) {
      vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce({ revision } as never);
      await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect(f.get).not.toHaveBeenCalled();
  });
  it("fails closed on changed original bytes or source hashes and sanitizes storage errors", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(Buffer.from("changed"));
    await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
    vi.mocked(db.getRecruitingWorkspace).mockResolvedValueOnce({
      revision: {
        id: "revision",
        sourceRefs: [
          {
            ...source,
            anchor: {
              ...source.anchor,
              artifact: { ...source.anchor.artifact, sha256: "0".repeat(64) },
            },
          },
        ],
        criteria: [],
      },
    } as never);
    await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    f.get.mockRejectedValueOnce(new Error("private storage path"));
    await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
  });

  it("keeps native RPC authorization and refuses client-provided source extraction fields", async () => {
    const f = fixture();
    const client = createRouterClient(createRouter(f.deps as RouterDeps), { context: { actor } });
    for (const extra of [
      { path: ["request", "internalId"] },
      { quote: "hidden-routing" },
      { artifactId: "other" },
      { sha256: hash },
    ])
      await expect(
        client.recruiting.readSource({ ...roleInput, ...extra } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unauthenticated = createRouterClient(createRouter(f.deps as RouterDeps), { context: {} });
    await expect(unauthenticated.recruiting.readSource(roleInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    vi.mocked(db.getRecruitingWorkspace).mockRejectedValueOnce(new IsolationError("Private role"));
    await expect(client.recruiting.readSource(roleInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
    expect(f.get).not.toHaveBeenCalled();
  });

  describe("original PDF evidence (mocked storage and processor)", () => {
    const pdf = Buffer.from("%PDF-1.7\nsynthetic original bytes");
    beforeEach(() => vi.mocked(extractPdfText).mockReset().mockResolvedValue(text));

    it("reads a saved role quote and assessment UTF-16 selection from the same extracted text", async () => {
      const f = fixture(pdf, "application/pdf");
      const start = text.indexOf(quote);
      const expected = { kind: "text", text, start, end: start + quote.length };
      expect(await api.readRecruitingSource(f.deps, actor, roleInput)).toEqual(expected);
      vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
        assessment: {
          version: 2,
          sourceRefs: [
            {
              ...f.source,
              selection: { kind: "artifact_text", start, end: start + quote.length },
            },
          ],
        },
      } as never);
      expect(
        await api.readRecruitingSource(f.deps, actor, {
          kind: "assessment",
          roleId: "role",
          candidateKey: "candidate",
          version: 2,
          sourceRefId: "source",
        }),
      ).toEqual(expected);
      expect(extractPdfText).toHaveBeenCalledTimes(2);
      expect(extractPdfText).toHaveBeenLastCalledWith(pdf);
    });

    it.each(["foreign", "hash", "bytes", "json-selection", "message-selection"])(
      "rejects %s before invoking the PDF processor",
      async (boundary) => {
        const f = fixture(pdf, "application/pdf");
        if (boundary === "foreign") f.findFirst.mockResolvedValueOnce(null as never);
        if (boundary === "bytes") f.get.mockResolvedValueOnce(Buffer.from("changed"));
        const saved = {
          ...f.source,
          ...(boundary === "hash"
            ? { anchor: { ...f.source.anchor, artifact: { artifactId: "material", sha256: hash } } }
            : {}),
          ...(boundary === "json-selection"
            ? { selection: { kind: "artifact_json_string", path: ["text"], start: 0, end: 1 } }
            : {}),
          ...(boundary === "message-selection"
            ? { selection: { kind: "message_text", blockIndex: 0, start: 0, end: 1 } }
            : {}),
        };
        vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
          revision: { id: "revision", sourceRefs: [saved], criteria: [] },
        } as never);
        await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found",
        });
        expect(extractPdfText).not.toHaveBeenCalled();
        if (boundary === "foreign") expect(f.get).not.toHaveBeenCalled();
      },
    );

    it.each(["quote", "offset", "processor"])(
      "fails closed on a PDF %s error without returning raw bytes or processor details",
      async (boundary) => {
        const f = fixture(pdf, "application/pdf");
        const start = text.indexOf(quote);
        vi.mocked(db.getRecruitingWorkspace).mockResolvedValue({
          revision: {
            id: "revision",
            sourceRefs: [
              {
                ...f.source,
                quote: boundary === "quote" ? "Invented evidence" : quote,
                selection: {
                  kind: "artifact_text",
                  start: boundary === "offset" ? start + 1 : start,
                  end: start + quote.length,
                },
              },
            ],
            criteria: [],
          },
        } as never);
        if (boundary === "processor")
          vi.mocked(extractPdfText).mockRejectedValueOnce(new Error("private processor path"));
        await expect(api.readRecruitingSource(f.deps, actor, roleInput)).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found",
        });
        expect(extractPdfText).toHaveBeenCalledOnce();
      },
    );
  });
});

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
      [db.listRecruitingCandidates, api.listRecruitingCandidates],
      [db.setRecruitingCandidateShortlist, api.setRecruitingCandidateShortlist],
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
    const candidatePage = {
      roleId: "role",
      roleRevisionId: "revision",
      crmTarget: null,
      items: [],
      nextCursor: null,
      total: 10,
      counts: {
        sourceRows: 15,
        candidates: 10,
        identifiedCandidates: 6,
        unassessed: 10,
        assessed: 0,
        shortlisted: 0,
      },
    };
    vi.mocked(db.listRecruitingCandidates).mockResolvedValueOnce(candidatePage);
    expect(
      await client.recruiting.listCandidates({
        roleId: "role",
        query: "Engineer",
        limit: 20,
        sourceEffectId: "native-read",
      }),
    ).toEqual(candidatePage);
    expect(db.listRecruitingCandidates).toHaveBeenLastCalledWith(prisma, actor, {
      roleId: "role",
      query: "Engineer",
      limit: 20,
      sourceEffectId: "native-read",
    });
    const sources = {
      roleId: "role",
      candidateKey: "candidate",
      items: [],
      nextCursor: null,
      total: 0,
    };
    vi.mocked(db.listRecruitingCandidateSources).mockResolvedValueOnce(sources);
    expect(
      await client.recruiting.listCandidateSources({ roleId: "role", candidateKey: "candidate" }),
    ).toEqual(sources);
    const shortlist = { roleId: "role", candidateKey: "candidate", shortlisted: true, revision: 1 };
    vi.mocked(db.setRecruitingCandidateShortlist).mockResolvedValueOnce(shortlist);
    expect(
      await client.recruiting.setCandidateShortlist({
        threadId: "thread",
        roleId: "role",
        candidateKey: "candidate",
        expectedRevision: 0,
        shortlisted: true,
      }),
    ).toEqual(shortlist);
    vi.mocked(db.listRecruitingResearch).mockResolvedValueOnce({
      tasks: [],
      actions: [],
      observations: [],
    });
    expect(await client.recruiting.listResearch({ roleId: "role" })).toEqual({
      tasks: [],
      actions: [],
      observations: [],
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

it("uses trusted RPC identity and artifact context for closed human criterion edits", async () => {
  const artifacts = { get: vi.fn() };
  const client = createRouterClient(createRouter({ prisma, artifacts } as unknown as RouterDeps), {
    context: { actor },
  });
  const input = {
    threadId: "thread",
    roleId: "role",
    expectedRevision: 1,
    criteria: [
      {
        criterionId: "criterion",
        priority: "hard" as const,
        atoms: [{ atomId: "atom", statement: "Edited statement" }],
      },
    ],
  };
  vi.mocked(db.editRecruitingCriteria).mockRejectedValueOnce(
    new IsolationError("Private source details"),
  );
  await expect(client.recruiting.editCriteria(input)).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Resource not found",
  });
  expect(db.editRecruitingCriteria).toHaveBeenLastCalledWith(prisma, actor, input, {
    artifacts,
    context: expect.objectContaining({
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: expect.any(AbortSignal),
    }),
  });
  const typedAtom = {
    atomId: "atom",
    employmentRule: {
      minimumMonths: 84,
      countingRule: "complete_calendar_months" as const,
      qualificationDefinition: "Full-time geometry implementation",
      cutoff: { kind: "assessment_date" as const },
    },
  };
  const typedInput = { ...input, criteria: [{ ...input.criteria[0]!, atoms: [typedAtom] }] };
  vi.mocked(db.editRecruitingCriteria).mockRejectedValueOnce(new RecruitingConflictError());
  await expect(client.recruiting.editCriteria(typedInput)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(db.editRecruitingCriteria).toHaveBeenLastCalledWith(
    prisma,
    actor,
    typedInput,
    expect.objectContaining({ artifacts }),
  );
  const writesBefore = vi.mocked(db.editRecruitingCriteria).mock.calls.length;
  for (const extra of [
    { actor: { userId: "foreign" } },
    { sourceRefs: [] },
    { confirmation: {} },
    { expression: {} },
  ])
    await expect(
      client.recruiting.editCriteria({ ...input, ...extra } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  for (const atom of [
    { ...typedAtom, statement: "7+ years" },
    { atomId: "atom" },
    { ...typedAtom, employmentRule: { ...typedAtom.employmentRule, minimumMonths: 1.5 } },
    { ...typedAtom, employmentRule: { ...typedAtom.employmentRule, cutoff: { kind: "fixed" } } },
  ])
    await expect(
      client.recruiting.editCriteria({
        ...input,
        criteria: [{ ...input.criteria[0], atoms: [atom] }],
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(db.editRecruitingCriteria).toHaveBeenCalledTimes(writesBefore);
});

it("retains the existing safe mappings for criterion conflict, source and input failures", async () => {
  for (const [error, code] of [
    [new RecruitingConflictError(), "CONFLICT"],
    [new RecruitingSourceValidationError("source", "text"), "BAD_REQUEST"],
    [Object.assign(new Error("Private input"), { name: "ZodError" }), "BAD_REQUEST"],
  ] as const) {
    vi.mocked(db.editRecruitingCriteria).mockRejectedValueOnce(error);
    await expect(api.editRecruitingCriteria(prisma, actor, {})).rejects.toMatchObject({ code });
  }
});

describe("retained candidate report API", () => {
  const input = { roleId: "role", candidateKey: "candidate" };
  const rows = [
    {
      name: { value: "Selected Person", source_id: "profile" },
      concerns: { value: null, evidence: "No code supplied", reasoning: "Needs verification" },
      tier: { value: "Provider shortlist" },
      _sources: { profile: "https://example.test/selected" },
      shard_id: "private-shard",
    },
    { name: { value: "Neighbor Person" }, private_note: { value: "Neighbor-only text" } },
  ];
  function fixture(legacy = false, transform: (snapshot: any) => void = () => {}) {
    const body = { rows, next_cursor: "private-next" };
    const providerResult = {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    };
    const observation = {
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      observedProviderState: null,
      done: null,
      providerApplicationConfirmed: false,
      automaticRetry: false,
      usage: null,
      rows,
      nextCursor: "private-next",
    };
    const snapshot = legacy
      ? {
          version: 1,
          taskId: "task",
          actionId: "action",
          operation: "rows",
          effectId: "effect",
          request: { task_id: "provider-task", cursor: "private-cursor" },
          providerResult,
          observation,
        }
      : {
          request: [
            "__rakazoCatalogTool",
            "direct",
            {
              route: {
                connectorId: "mcp",
                resourceId: "private-route",
                resourceRevision: 1,
                toolName: "get_rows",
              },
              args: { task_id: "provider-task", cursor: "private-cursor" },
            },
          ],
          providerResult,
        };
    transform(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactRef = { artifactId: "report-artifact", sha256 };
    const occurrence = {
      crmImports: [],
      providerTaskId: "provider-task",
      taskId: legacy ? "task" : null,
      actionId: legacy ? "action" : null,
      roleRevisionId: "old-revision",
      effectId: "effect",
      rowIndex: 0,
      artifactRef,
      requestCursor: "private-cursor",
      outputId: null,
      observedAt: "2026-10-17T00:00:00.000Z",
    };
    const page = { ...input, items: [occurrence], nextCursor: null, total: 1 };
    vi.mocked(db.listRecruitingCandidateSources).mockResolvedValue(page);
    vi.mocked(db.listRecruitingResearch).mockResolvedValue({
      tasks: [{ id: "task", roleId: "role", providerTaskId: "provider-task" }],
      actions: [
        {
          id: "action",
          taskId: "task",
          roleRevisionId: "old-revision",
          outputArtifacts: [artifactRef],
        },
      ],
      observations: [],
    } as never);
    const get = vi.fn(async () => bytes);
    const findFirst = vi.fn(async () => ({
      id: artifactRef.artifactId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      storageKey: "stored",
      botId: "bot",
      mimeType: "application/json",
      hash: sha256,
      size: bytes.length,
    }));
    const deps = {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
    };
    return { deps, get, findFirst, page, occurrence, bytes, snapshot };
  }
  beforeEach(() => {
    vi.mocked(db.listRecruitingCandidateSources).mockReset();
    vi.mocked(db.listRecruitingResearch).mockReset();
  });
  it.each([false, true])(
    "projects only the exact person from a %s historical-task snapshot",
    async (legacy) => {
      const f = fixture(legacy);
      const client = createRouterClient(createRouter(f.deps as RouterDeps), { context: { actor } });
      const result = await client.recruiting.listCandidateSources(input);
      expect(result.items[0]?.report).toEqual({
        fields: [
          {
            label: "Name",
            value: "Selected Person",
            sourceUrls: ["https://example.test/selected"],
          },
          {
            label: "Concerns",
            value: null,
            evidence: "No code supplied",
            reasoning: "Needs verification",
            sourceUrls: [],
          },
          { label: "Tier", value: "Provider shortlist", sourceUrls: [] },
        ],
        sourceUrls: ["https://example.test/selected"],
      });
      expect(JSON.stringify(result.items[0]?.report)).not.toMatch(
        /Neighbor|private-|source_id|structuredContent|request/,
      );
      expect(f.get).toHaveBeenCalledOnce();
      expect(db.listRecruitingResearch).toHaveBeenCalledTimes(legacy ? 1 : 0);
      expect(db.listRecruitingCandidateSources).toHaveBeenCalledWith(f.deps.prisma, actor, input);
      expect(result.items[0]?.roleRevisionId).toBe("old-revision");
    },
  );
  it("decodes the existing catalog request tuple without creating a local task", async () => {
    const f = fixture(false, (snapshot) => {
      const { route, args } = snapshot.request[2];
      snapshot.request = [
        "__rakazoCatalogTool",
        "mcp_execute_tool",
        { id: "private-route:get_rows", arguments: args },
        route,
      ];
    });
    const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
    expect(result.items[0]?.report?.fields[0]?.value).toBe("Selected Person");
    expect(db.listRecruitingResearch).not.toHaveBeenCalled();
  });
  it("reads a shared artifact once for multiple selected occurrences", async () => {
    const f = fixture();
    f.page.items.push({ ...f.occurrence });
    const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
    expect(result.items.map((item) => item.report?.fields[0]?.value)).toEqual([
      "Selected Person",
      "Selected Person",
    ]);
    expect(f.get).toHaveBeenCalledOnce();
  });
  it("keeps readable reports when another authorized occurrence cannot be projected", async () => {
    const f = fixture();
    f.page.items.push({ ...f.occurrence, rowIndex: 99 });
    const result = await api.listRecruitingCandidateSources(f.deps, actor, input);
    expect(result.items[0]?.report?.fields[0]?.value).toBe("Selected Person");
    expect(result.items[1]).toEqual(f.page.items[1]);
    expect(f.get).toHaveBeenCalledOnce();
  });
  it("does no artifact or research read for an empty saved page", async () => {
    const f = fixture();
    f.page.items = [];
    expect(await api.listRecruitingCandidateSources(f.deps, actor, input)).toEqual(f.page);
    expect(f.get).not.toHaveBeenCalled();
    expect(db.listRecruitingResearch).not.toHaveBeenCalled();
  });
  it.each([
    "foreign-actor",
    "missing-occurrence",
    "hash",
    "bytes",
    "row",
    "request",
    "envelope",
    "legacy-binding",
    "legacy-effect",
    "legacy-result",
  ])("keeps authorized source metadata unavailable at the %s boundary", async (boundary) => {
    const legacy = boundary.startsWith("legacy-");
    const f = fixture(legacy, (snapshot) => {
      if (boundary === "request") snapshot.request = { task_id: "invented" };
      if (boundary === "envelope")
        snapshot.providerResult.structuredContent = { rows: ["conflicting"] };
      if (boundary === "legacy-effect") snapshot.effectId = "other-effect";
      if (boundary === "legacy-result") snapshot.observation.rows = [{ name: "Changed" }];
    });
    if (boundary === "foreign-actor") f.findFirst.mockResolvedValueOnce(null as never);
    if (boundary === "missing-occurrence")
      vi.mocked(db.listRecruitingCandidateSources).mockRejectedValueOnce(new IsolationError());
    if (boundary === "hash") f.occurrence.artifactRef.sha256 = "0".repeat(64);
    if (boundary === "bytes") f.get.mockResolvedValueOnce(Buffer.from("changed"));
    if (boundary === "row") f.occurrence.rowIndex = 99;
    if (boundary === "legacy-binding")
      vi.mocked(db.listRecruitingResearch).mockResolvedValueOnce({
        tasks: [],
        actions: [],
        observations: [],
      });
    const result = api.listRecruitingCandidateSources(f.deps, actor, input);
    if (boundary === "missing-occurrence")
      await expect(result).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found",
      });
    else expect((await result).items).toEqual([f.occurrence]);
    if (["foreign-actor", "missing-occurrence"].includes(boundary))
      expect(f.get).not.toHaveBeenCalled();
  });
  it("accepts an exact 550-character incomplete array prefix confined to its saved person", async () => {
    const f = fixture(false, (snapshot) => {
      const canonical = structuredClone(rows);
      Object.assign(canonical[0]!, {
        infra_evidence: { value: "Supplied project implementation evidence. ".repeat(30) },
      });
      snapshot.providerResult.structuredContent.rows = canonical;
      snapshot.providerResult.content[0].text = JSON.stringify(
        canonical.map((row) =>
          Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => !key.startsWith("_"))
              .map(([key, cell]) => [
                key,
                typeof cell === "object" && cell !== null && "value" in cell ? cell.value : cell,
              ]),
          ),
        ),
      );
    });
    const quote = f.snapshot.providerResult.content[0]!.text.slice(0, 550);
    expect(() => JSON.parse(quote)).toThrow();
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            id: "source",
            kind: "provider_report",
            anchor: {
              kind: "artifact",
              artifact: f.occurrence.artifactRef,
              locator: "providerResult",
            },
            readState: "read",
            readAt: "2026-10-17T00:00:00.000Z",
            quote,
            selection: {
              kind: "artifact_json_string",
              path: ["providerResult", "content", 0, "text"],
              start: 0,
              end: 550,
            },
          },
        ],
      },
    } as never);
    const result = await api.readRecruitingSource(f.deps, actor, {
      kind: "assessment",
      ...input,
      version: 2,
      sourceRefId: "source",
    });
    expect(result).toMatchObject({
      kind: "report",
      report: {
        fields: expect.arrayContaining([
          expect.objectContaining({ label: "Name", value: "Selected Person" }),
          expect.objectContaining({
            label: "Infra evidence",
            value: "Supplied project implementation evidence. ".repeat(30),
          }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/Neighbor|private-|shard_id|providerResult/);
  });
  it.each([
    "prefix",
    "pretty-prefix",
    "neighbor",
    "cross-row",
    "values",
    "sparse-same-title",
    "missing-gap",
    "order",
    "duplicate",
    "request",
    "typed-cell",
  ])("binds the exact assessment selection to its own row at the %s boundary", async (boundary) => {
    const flatRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => !key.startsWith("_") && key !== "shard_id")
          .map(([key, cell]) => [
            key,
            typeof cell === "object" && cell !== null && "value" in cell ? cell.value : cell,
          ]),
      ),
    );
    if (boundary === "values") flatRows[0]!.name = "Changed person";
    if (boundary === "sparse-same-title") flatRows[0] = { current_title: "Engineer" };
    if (boundary === "missing-gap") delete flatRows[0]!.concerns;
    if (boundary === "order") flatRows.reverse();
    const f = fixture(false, (snapshot) => {
      if (boundary === "sparse-same-title") {
        snapshot.providerResult.structuredContent.rows = structuredClone(rows);
        snapshot.providerResult.structuredContent.rows[0].current_title = { value: "Engineer" };
      }
      snapshot.providerResult.content[0].text = JSON.stringify(
        flatRows,
        null,
        boundary === "pretty-prefix" ? 2 : undefined,
      );
    });
    const text = f.snapshot.providerResult.content[0]!.text;
    let path: (string | number)[] = ["providerResult", "content", 0, "text"];
    let start = 0;
    let end = text.indexOf('"tier"') + 6;
    if (boundary === "neighbor") {
      start = text.indexOf("Neighbor Person");
      end = start + "Neighbor Person".length;
    }
    if (boundary === "cross-row") end = text.indexOf("Neighbor Person") + "Neighbor Person".length;
    if (boundary === "request") {
      path = ["request", 2, "args", "task_id"];
      start = 0;
      end = "provider-task".length;
    }
    if (boundary === "typed-cell") {
      path = ["providerResult", "structuredContent", "rows", 0, "name", "value"];
      start = 0;
      end = "Selected Person".length;
    }
    const quote =
      boundary === "request"
        ? "provider-task"
        : boundary === "typed-cell"
          ? "Selected Person"
          : text.slice(start, end);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            id: "source",
            kind: "provider_report",
            anchor: {
              kind: "artifact",
              artifact: f.occurrence.artifactRef,
              locator: "providerResult",
            },
            readState: "read",
            readAt: "2026-10-17T00:00:00.000Z",
            quote,
            selection: { kind: "artifact_json_string", path, start, end },
          },
        ],
      },
    } as never);
    if (boundary === "duplicate") f.page.items.push({ ...f.occurrence });
    const result = api.readRecruitingSource(f.deps, actor, {
      kind: "assessment",
      ...input,
      version: 2,
      sourceRefId: "source",
    });
    if (["prefix", "pretty-prefix", "typed-cell"].includes(boundary)) {
      expect(await result).toMatchObject({
        kind: "report",
        report: { sourceUrls: ["https://example.test/selected"] },
      });
      expect(f.get).toHaveBeenCalledOnce();
    } else
      await expect(result).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found",
      });
  });
  it("returns the exact person's report after validating an assessment's original quote and scoped saved occurrence", async () => {
    const f = fixture();
    const text = f.snapshot.providerResult.content[0]!.text;
    const quote = "Selected Person";
    const start = text.indexOf(quote);
    vi.mocked(db.getRecruitingAssessment).mockResolvedValue({
      assessment: {
        version: 2,
        sourceRefs: [
          {
            id: "source",
            kind: "provider_report",
            anchor: {
              kind: "artifact",
              artifact: f.occurrence.artifactRef,
              locator: "providerResult",
            },
            readState: "read",
            readAt: "2026-10-17T00:00:00.000Z",
            quote,
            selection: {
              kind: "artifact_json_string",
              path: ["providerResult", "content", 0, "text"],
              start,
              end: start + quote.length,
            },
          },
        ],
      },
    } as never);
    const result = await api.readRecruitingSource(f.deps, actor, {
      kind: "assessment",
      ...input,
      version: 2,
      sourceRefId: "source",
    });
    expect(result).toMatchObject({
      kind: "report",
      report: { sourceUrls: ["https://example.test/selected"] },
    });
    expect(JSON.stringify(result)).not.toMatch(/Neighbor|private-|task_id|rows|providerResult/);
    expect(f.get).toHaveBeenCalledOnce();
    f.page.items = [];
    await expect(
      api.readRecruitingSource(f.deps, actor, {
        kind: "assessment",
        ...input,
        version: 2,
        sourceRefId: "source",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
