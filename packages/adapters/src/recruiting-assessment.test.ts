import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeRecruitingAssessmentTool,
  executeRecruitingCandidatesTool,
  retainRecruitingWebMaterial,
} from "./recruiting-assessment.js";

const db = vi.hoisted(() => ({
  workspace: vi.fn(),
  assessment: vi.fn(),
  save: vi.fn(),
  material: vi.fn(),
  question: vi.fn(),
  candidates: vi.fn(),
  sources: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<object>()),
  getRecruitingWorkspace: db.workspace,
  getRecruitingAssessment: db.assessment,
  saveRecruitingAssessment: db.save,
  recordRecruitingWebMaterial: db.material,
  getRecruitingQuestion: db.question,
  listRecruitingCandidates: db.candidates,
  listRecruitingCandidateSources: db.sources,
}));

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const context: AdapterContext = {
  spaceId: actor.spaceId,
  userId: actor.userId,
  botId: "bot",
  runId: "run",
  operationId: "operation",
  traceId: "trace",
  signal: new AbortController().signal,
};
const contextArtifact = { artifactId: "context", sha256: "a".repeat(64) };
const trusted = { actor, runId: "run", threadId: "thread", botId: "bot" };
const saveTrusted = {
  ...trusted,
  save: {
    leaseOwner: "worker",
    leaseFence: 3,
    contextArtifact,
    effectId: "effect",
    effectRequest: { operation: "save", request: "frozen" },
  },
};
const textSource = {
  id: "resume",
  kind: "original_material",
  anchor: {
    kind: "artifact",
    artifact: { artifactId: "resume", sha256: "b".repeat(64) },
    locator: "resume.txt",
  },
  readState: "read",
  readAt: "2026-10-16T00:00:00.000Z",
  quote: " Engineer ",
  selection: { kind: "artifact_text", start: 0, end: 10 },
} as const;
const input = {
  operation: "save",
  roleId: "role",
  candidateKey: "unresolved:resume",
  roleRevisionId: "revision",
  expectedRevision: 0,
  facts: [{ kind: "statement", id: "fact", statement: "Engineer", sourceRefIds: ["resume"] }],
  atomJudgments: [
    { atomId: "engineering", verdict: "met", factIds: ["fact"], evidence: ["resume"], missing: [] },
  ],
  employmentEvaluations: [],
  questions: ["Confirm personal implementation"],
  sourceRefs: [textSource],
} as const;
const workspace = { role: { id: "role" }, revision: { id: "revision" } };
const receipt = { assessment: { candidateKey: input.candidateKey, version: 1 }, isCurrent: true };

function fixture() {
  const run = {
    ...actor,
    id: "run",
    threadId: "thread",
    botId: "bot",
    bot: { spaceId: actor.spaceId, userId: actor.userId },
  };
  const rows = [contextArtifact, textSource.anchor.artifact].map((ref) => ({
    id: ref.artifactId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    hash: ref.sha256,
    storageKey: `storage:${ref.artifactId}`,
  }));
  const findRun = vi.fn(async () => run);
  const findArtifacts = vi.fn(async () => rows);
  const get = vi.fn<ArtifactStore["get"]>(async (id) => Buffer.from(`bytes:${id}`));
  const put = vi.fn<ArtifactStore["put"]>(async () => ({
    id: "stored-material",
    hash: "not-a-native-sha256",
  }));
  const prisma = {
    run: { findFirst: findRun },
    artifact: { findMany: findArtifacts },
  } as unknown as PrismaClient;
  return {
    deps: { prisma, artifacts: { get, put } as unknown as ArtifactStore },
    run,
    rows,
    findRun,
    findArtifacts,
    get,
    put,
  };
}

describe("native recruiting_assess adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspace.mockResolvedValue(workspace);
    db.assessment.mockResolvedValue(receipt);
    db.save.mockResolvedValue(receipt);
  });

  it.each(["pending", "answered", "stale"])(
    "uses the original native question on %s replay",
    async (state) => {
      const f = fixture();
      const ask = {
        operation: "ask",
        roleId: "role",
        roleRevisionId: "revision",
        target: {
          kind: "candidate",
          candidateKey: "candidate",
          assessmentVersion: 1,
          criterionIds: ["geometry"],
        },
        question: "Did you implement geometry?",
        options: ["Yes", "No"],
      };
      const question = {
        effectId: "effect",
        messageId: "original",
        canAnswer: state === "pending",
        runStatus: state === "answered" ? "running" : "waiting_input",
        block: {
          kind: "ask",
          status: state === "answered" ? "answered" : "pending",
          answer: state === "answered" ? "Yes" : undefined,
        },
        isCurrent: state !== "stale",
      };
      db.question.mockResolvedValue(question);
      const pauseRunForInput = vi.fn<ThreadEvents["pauseRunForInput"]>(async () => true);
      const result = await executeRecruitingAssessmentTool(
        { ...f.deps, events: { pauseRunForInput } },
        { ...saveTrusted, attemptId: "attempt", save: { ...saveTrusted.save, effectRequest: ask } },
        ask,
        context,
      );
      expect(pauseRunForInput).toHaveBeenCalledOnce();
      expect(pauseRunForInput.mock.calls[0]?.[0]).toMatchObject({
        attemptId: "attempt",
        runId: "run",
        offeredActions: [
          { id: "choice-1", label: "Yes" },
          { id: "choice-2", label: "No" },
        ],
        blocks: [{ kind: "ask", text: ask.question, status: "pending" }],
        recruitingQuestion: { actor, effectId: "effect", effectRequest: ask },
      });
      if (state === "pending")
        expect(result).toMatchObject({ terminate: true, details: { input: "paused" } });
      else expect(result).toEqual({ question });
      expect(db.save).not.toHaveBeenCalled();
    },
  );

  it("reads the current thread role and exact candidate key without loading artifact bytes", async () => {
    const f = fixture();
    expect(
      await executeRecruitingAssessmentTool(
        { prisma: f.deps.prisma },
        trusted,
        { operation: "read", candidateKey: input.candidateKey },
        context,
      ),
    ).toEqual({ status: "current", workspace, assessment: receipt });
    expect(db.workspace).toHaveBeenCalledWith(f.deps.prisma, actor, { threadId: "thread" });
    expect(db.assessment).toHaveBeenCalledWith(f.deps.prisma, actor, {
      roleId: "role",
      candidateKey: "unresolved:resume",
    });
    expect(f.findArtifacts).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it("returns an empty current workspace without inventing a role or candidate assessment", async () => {
    const f = fixture();
    db.workspace.mockResolvedValue(null);
    expect(
      await executeRecruitingAssessmentTool(
        f.deps,
        trusted,
        { operation: "read", candidateKey: "source:unresolved" },
        context,
      ),
    ).toEqual({ status: "current", workspace: null, assessment: null });
    expect(db.assessment).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("loads only owned exact versions before passing bytes and typed facts to atomic storage", async () => {
    const f = fixture();
    const { operation: _operation, ...assessment } = input;
    expect(await executeRecruitingAssessmentTool(f.deps, saveTrusted, input, context)).toBe(
      receipt,
    );
    expect(f.findArtifacts).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        OR: [
          { id: "context", hash: contextArtifact.sha256 },
          { id: "resume", hash: textSource.anchor.artifact.sha256 },
        ],
      },
      select: { id: true, spaceId: true, userId: true, hash: true, storageKey: true },
    });
    expect(f.get.mock.calls).toEqual([
      ["storage:context", context],
      ["storage:resume", context],
    ]);
    const { actor: _actor, save, ...base } = saveTrusted;
    const saveContext = { ...base, ...save };
    expect(db.save).toHaveBeenCalledWith(f.deps.prisma, actor, saveContext, assessment, [
      { artifactId: "context", bytes: Buffer.from("bytes:storage:context") },
      { artifactId: "resume", bytes: Buffer.from("bytes:storage:resume") },
    ]);
    expect(db.workspace).not.toHaveBeenCalled();
  });

  it("preserves typed employment dates and unknown interval judgments for server evaluation", async () => {
    const f = fixture();
    const facts = [
      {
        kind: "employment",
        id: "job",
        statement: "Employment began in 2020; exact month unknown",
        sourceRefIds: ["resume"],
        start: { precision: "year", year: 2020 },
        end: "present",
        employmentType: "Unknown",
      },
      {
        kind: "history_completeness",
        id: "history",
        statement: "Resume may omit prior work",
        sourceRefIds: ["resume"],
        complete: false,
        asOf: { precision: "day", year: 2026, month: 10, day: 16 },
      },
    ];
    const employmentEvaluations = [
      {
        atomId: "experience",
        intervals: [
          {
            factId: "job",
            qualifyingFullTime: "unknown",
            evidence: ["resume"],
            missing: ["Confirm full-time status"],
          },
        ],
        historyCompletenessFactId: "history",
        evidence: ["resume"],
        missing: [],
      },
    ];
    await executeRecruitingAssessmentTool(
      f.deps,
      saveTrusted,
      { ...input, facts, atomJudgments: [], employmentEvaluations },
      context,
    );
    expect(db.save.mock.calls[0]?.[3]).toMatchObject({
      facts,
      atomJudgments: [],
      employmentEvaluations,
    });
  });

  it.each(["unread", "unavailable"] as const)(
    "does not read or fetch %s URLs and binary sources",
    async (readState) => {
      const f = fixture();
      const { quote: _quote, selection: _selection, ...source } = textSource;
      const unread = {
        ...source,
        id: "unread",
        readState,
        readAt: readState === "unread" ? null : "2026-10-16T00:00:00.000Z",
        url: "https://example.test/unread",
        anchor: {
          ...source.anchor,
          artifact: { artifactId: "binary", sha256: "c".repeat(64) },
        },
      };
      await executeRecruitingAssessmentTool(
        f.deps,
        saveTrusted,
        { ...input, facts: [], atomJudgments: [], sourceRefs: [unread] },
        context,
      );
      expect(f.get.mock.calls).toEqual([["storage:context", context]]);
      expect(db.save.mock.calls[0]?.[3].sourceRefs).toEqual([unread]);
      expect(db.save.mock.calls[0]?.[4]).toEqual([
        { artifactId: "context", bytes: Buffer.from("bytes:storage:context") },
      ]);
    },
  );

  it("deduplicates repeated exact artifact references without changing their selections", async () => {
    const f = fixture();
    const json = {
      ...textSource,
      id: "other-quote",
      quote: " Engineer ",
      selection: { kind: "artifact_json_string", path: ["rows", 0, "title"], start: 0, end: 10 },
    };
    await executeRecruitingAssessmentTool(
      f.deps,
      saveTrusted,
      { ...input, sourceRefs: [textSource, json] },
      context,
    );
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(db.save.mock.calls[0]?.[3].sourceRefs).toEqual([textSource, json]);
  });

  it.each(["spaceId", "userId", "runId", "botId"] as const)(
    "rejects a mismatched adapter %s before native reads or writes",
    async (key) => {
      const f = fixture();
      await expect(
        executeRecruitingAssessmentTool(f.deps, saveTrusted, input, { ...context, [key]: "other" }),
      ).rejects.toThrow();
      expect(f.findRun).not.toHaveBeenCalled();
      expect(f.findArtifacts).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      expect(db.save).not.toHaveBeenCalled();
    },
  );

  it.each(["threadId", "botId"] as const)(
    "rejects a sibling run %s before blob reads",
    async (key) => {
      const f = fixture();
      f.run[key] = "other";
      await expect(
        executeRecruitingAssessmentTool(f.deps, saveTrusted, input, context),
      ).rejects.toThrow();
      expect(f.findArtifacts).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      expect(db.save).not.toHaveBeenCalled();
    },
  );

  it("rejects model-supplied identity and proof fields before native work", async () => {
    const f = fixture();
    for (const forged of [
      { ...input, userId: "other" },
      { ...input, threadId: "other" },
      { ...input, effectId: "other" },
      { ...input, validatedSources: true },
      { ...input, sourceRefs: [{ ...textSource, verified: true }] },
    ]) {
      await expect(
        executeRecruitingAssessmentTool(f.deps, saveTrusted, forged, context),
      ).rejects.toThrow();
    }
    expect(f.findRun).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it.each(["missing", "hash", "spaceId", "userId"] as const)(
    "refuses %s metadata before loading any bytes",
    async (mismatch) => {
      const f = fixture();
      if (mismatch === "missing") f.rows.pop();
      else f.rows[1]![mismatch] = "other";
      await expect(
        executeRecruitingAssessmentTool(f.deps, saveTrusted, input, context),
      ).rejects.toThrow();
      expect(f.get).not.toHaveBeenCalled();
      expect(db.save).not.toHaveBeenCalled();
    },
  );

  it("refuses conflicting hashes for one native artifact version before loading bytes", async () => {
    const f = fixture();
    await expect(
      executeRecruitingAssessmentTool(
        f.deps,
        saveTrusted,
        {
          ...input,
          sourceRefs: [
            textSource,
            {
              ...textSource,
              id: "conflicting",
              anchor: {
                ...textSource.anchor,
                artifact: { artifactId: "resume", sha256: "c".repeat(64) },
              },
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it("requires the trusted mutation context and artifact storage for a save", async () => {
    const f = fixture();
    for (const key of ["leaseOwner", "leaseFence", "effectId", "effectRequest"] as const) {
      const incomplete = {
        ...saveTrusted,
        save: { ...saveTrusted.save, [key]: undefined },
      } as never;
      await expect(
        executeRecruitingAssessmentTool(f.deps, incomplete, input, context),
      ).rejects.toThrow();
    }
    await expect(
      executeRecruitingAssessmentTool({ prisma: f.deps.prisma }, saveTrusted, input, context),
    ).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it("passes a completed replay without an adopted context to storage while checking source bytes", async () => {
    const f = fixture();
    const { contextArtifact: _contextArtifact, ...save } = saveTrusted.save;
    expect(
      await executeRecruitingAssessmentTool(f.deps, { ...trusted, save }, input, context),
    ).toBe(receipt);
    expect(f.get.mock.calls).toEqual([["storage:resume", context]]);
    expect(db.save.mock.calls[0]?.[2]).toEqual({
      runId: "run",
      threadId: "thread",
      botId: "bot",
      ...save,
    });
    expect(db.save.mock.calls[0]?.[4]).toEqual([
      { artifactId: "resume", bytes: Buffer.from("bytes:storage:resume") },
    ]);
  });

  it("propagates storage rejection of a fresh save without an adopted context", async () => {
    const f = fixture();
    const { contextArtifact: _contextArtifact, ...save } = saveTrusted.save;
    const failure = new Error("Fresh assessment requires an adopted context");
    db.save.mockRejectedValue(failure);
    await expect(
      executeRecruitingAssessmentTool(f.deps, { ...trusted, save }, input, context),
    ).rejects.toBe(failure);
  });

  it("honors cancellation before native work", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    await expect(
      executeRecruitingAssessmentTool(f.deps, saveTrusted, input, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Stopped");
    expect(f.findRun).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it("propagates unavailable bytes without producing a saved receipt", async () => {
    const f = fixture();
    const failure = new Error("Blob unavailable");
    f.get.mockRejectedValue(failure);
    await expect(executeRecruitingAssessmentTool(f.deps, saveTrusted, input, context)).rejects.toBe(
      failure,
    );
    expect(db.save).not.toHaveBeenCalled();
  });

  it("propagates atomic storage failure without claiming success", async () => {
    const f = fixture();
    const failure = new Error("Assessment changed");
    db.save.mockRejectedValue(failure);
    await expect(executeRecruitingAssessmentTool(f.deps, saveTrusted, input, context)).rejects.toBe(
      failure,
    );
  });
});

describe("native saved candidate reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspace.mockResolvedValue(workspace);
  });

  it.each(["Example Candidate", "https://www.linkedin.com/in/example-candidate"])(
    "passes %s to the existing current-role list without choosing a match or changing totals",
    async (query) => {
      const f = fixture();
      const page = {
        roleId: "role",
        items: [
          { candidateKey: "candidate-one", name: "Example Candidate" },
          { candidateKey: "candidate-two", name: "Example Candidate" },
        ],
        total: 7,
        nextCursor: "next-page",
      };
      db.candidates.mockResolvedValue(page);
      const result = await executeRecruitingCandidatesTool(
        { prisma: f.deps.prisma },
        trusted,
        { operation: "list", query, limit: 2, cursor: "opaque+/=" },
        context,
      );
      expect(result).toBe(page);
      expect(db.workspace).toHaveBeenCalledWith(f.deps.prisma, actor, { threadId: "thread" });
      expect(db.candidates).toHaveBeenCalledWith(f.deps.prisma, actor, {
        roleId: "role",
        query,
        limit: 2,
        cursor: "opaque+/=",
      });
      expect(db.sources).not.toHaveBeenCalled();
      expect(f.findArtifacts).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      expect(f.put).not.toHaveBeenCalled();
      expect(db.save).not.toHaveBeenCalled();
      expect(db.material).not.toHaveBeenCalled();
    },
  );

  it("returns the existing source page with exact artifact references without reading bytes", async () => {
    const f = fixture();
    const page = {
      roleId: "role",
      candidateKey: "candidate-one",
      total: 3,
      nextCursor: "next-source",
      items: [
        { rowIndex: 4, artifactRef: { artifactId: "original-page", sha256: "d".repeat(64) } },
      ],
    };
    db.sources.mockResolvedValue(page);
    expect(
      await executeRecruitingCandidatesTool(
        f.deps,
        trusted,
        {
          operation: "sources",
          candidateKey: "candidate-one",
          cursor: "original-cursor",
          limit: 1,
        },
        context,
      ),
    ).toBe(page);
    expect(db.sources).toHaveBeenCalledWith(f.deps.prisma, actor, {
      roleId: "role",
      candidateKey: "candidate-one",
      cursor: "original-cursor",
      limit: 1,
    });
    expect(db.candidates).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it.each(["list", "sources"])(
    "reports no current role for %s without inventing a page",
    async (operation) => {
      const f = fixture();
      db.workspace.mockResolvedValue(null);
      expect(
        await executeRecruitingCandidatesTool(
          f.deps,
          trusted,
          operation === "list" ? { operation } : { operation, candidateKey: "candidate-one" },
          context,
        ),
      ).toEqual({ status: "no_current_role" });
      expect(db.candidates).not.toHaveBeenCalled();
      expect(db.sources).not.toHaveBeenCalled();
    },
  );

  it.each([
    { context: { userId: "foreign" } },
    { context: { spaceId: "foreign" } },
    { context: { runId: "foreign" } },
    { context: { botId: "foreign" } },
    { run: { userId: "foreign" } },
    { run: { spaceId: "foreign" } },
    { run: { threadId: "foreign" } },
    { run: { botId: "foreign" } },
    { run: { bot: { spaceId: "space", userId: "foreign" } } },
  ])("denies foreign run context before listing: %j", async (changed) => {
    const f = fixture();
    Object.assign(f.run, changed.run);
    await expect(
      executeRecruitingCandidatesTool(
        f.deps,
        trusted,
        { operation: "list" },
        {
          ...context,
          ...changed.context,
        },
      ),
    ).rejects.toThrow("Resource not found");
    expect(db.workspace).not.toHaveBeenCalled();
    expect(db.candidates).not.toHaveBeenCalled();
    expect(db.sources).not.toHaveBeenCalled();
  });

  it("preserves current-role and candidate ownership denials from the existing readers", async () => {
    const f = fixture();
    db.workspace.mockRejectedValueOnce(new Error("current role denied"));
    await expect(
      executeRecruitingCandidatesTool(f.deps, trusted, { operation: "list" }, context),
    ).rejects.toThrow("current role denied");
    expect(db.candidates).not.toHaveBeenCalled();
    db.sources.mockRejectedValueOnce(new Error("candidate denied"));
    await expect(
      executeRecruitingCandidatesTool(
        f.deps,
        trusted,
        {
          operation: "sources",
          candidateKey: "foreign",
        },
        context,
      ),
    ).rejects.toThrow("candidate denied");
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each([{ roleId: "foreign" }, { actor: { userId: "foreign" } }, { shortlisted: true }])(
    "rejects model scope or mutation fields before any read: %j",
    async (extra) => {
      const f = fixture();
      await expect(
        executeRecruitingCandidatesTool(
          f.deps,
          trusted,
          {
            operation: "list",
            ...extra,
          },
          context,
        ),
      ).rejects.toThrow();
      expect(f.findRun).not.toHaveBeenCalled();
      expect(db.workspace).not.toHaveBeenCalled();
      expect(db.candidates).not.toHaveBeenCalled();
    },
  );
});

const readerTrusted = { ...trusted, leaseOwner: "worker", leaseFence: 3 };
const material = {
  url: "https://example.test/profile",
  title: "Profile",
  text: " Exact fetched résumé text 😀 ",
  truncated: true,
};
const materialPayload = {
  reader: "web_fetch",
  artifact: { artifactId: "material", sha256: "d".repeat(64) },
  url: material.url,
  readAt: "2026-10-16T00:00:00.000Z",
};

describe("native recruiting web material", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.material.mockResolvedValue({
      artifact: { id: "material", hash: materialPayload.artifact.sha256 },
      event: { payload: materialPayload },
      created: true,
    });
  });

  it("retains actual text and truncation in canonical bytes and returns native source receipt", async () => {
    const f = fixture();
    const result = await retainRecruitingWebMaterial(f.deps, readerTrusted, material, context);
    const upload = f.put.mock.calls[0]![0];
    expect(JSON.parse(Buffer.from(upload.bytes).toString("utf8"))).toEqual(material);
    const hash = createHash("sha256").update(upload.bytes).digest("hex");
    expect(upload).toEqual({
      name: `recruiting-material-${hash}.json`,
      mimeType: "application/json",
      bytes: expect.any(Uint8Array),
    });
    expect(f.put.mock.calls[0]?.[1]).toBe(context);
    const { actor: _actor, ...readerContext } = readerTrusted;
    expect(db.material).toHaveBeenCalledWith(f.deps.prisma, actor, readerContext, {
      artifact: {
        name: upload.name,
        mimeType: "application/json",
        size: upload.bytes.byteLength,
        hash,
        storageKey: "stored-material",
        clientNonce: `recruiting-material:run:${hash}`,
      },
      reader: "web_fetch",
      url: material.url,
      readAt: expect.any(String),
    });
    expect(result).toEqual({
      artifact: materialPayload.artifact,
      url: material.url,
      readAt: materialPayload.readAt,
    });
    expect(f.get).not.toHaveBeenCalled();
  });

  it("keeps empty extracted text without a read claim or retained artifact", async () => {
    const f = fixture();
    expect(
      await retainRecruitingWebMaterial(
        f.deps,
        readerTrusted,
        { ...material, text: " \n\t" },
        context,
      ),
    ).toBeUndefined();
    expect(f.put).not.toHaveBeenCalled();
    expect(db.material).not.toHaveBeenCalled();
  });

  it("reuses the first native read time and nonce for exactly repeated fetched bytes", async () => {
    const f = fixture();
    const first = await retainRecruitingWebMaterial(f.deps, readerTrusted, material, context);
    db.material.mockResolvedValue({ event: { payload: materialPayload }, created: false });
    const repeated = await retainRecruitingWebMaterial(
      f.deps,
      readerTrusted,
      { ...material },
      context,
    );
    expect(repeated).toEqual(first);
    expect(db.material.mock.calls[1]?.[3].artifact.clientNonce).toBe(
      db.material.mock.calls[0]?.[3].artifact.clientNonce,
    );
  });

  it("rejects a foreign adapter context before upload or source recording", async () => {
    const f = fixture();
    await expect(
      retainRecruitingWebMaterial(f.deps, readerTrusted, material, { ...context, userId: "other" }),
    ).rejects.toThrow();
    expect(f.findRun).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
    expect(db.material).not.toHaveBeenCalled();
  });

  it("does not publish a read claim when retaining bytes fails", async () => {
    const f = fixture();
    const failure = new Error("Storage unavailable");
    f.put.mockRejectedValue(failure);
    await expect(
      retainRecruitingWebMaterial(f.deps, readerTrusted, material, context),
    ).rejects.toBe(failure);
    expect(db.material).not.toHaveBeenCalled();
  });

  it("propagates native receipt failure without deleting a possibly reused blob", async () => {
    const f = fixture();
    const failure = new Error("Stale lease");
    db.material.mockRejectedValue(failure);
    await expect(
      retainRecruitingWebMaterial(f.deps, readerTrusted, material, context),
    ).rejects.toBe(failure);
    expect(f.put).toHaveBeenCalledOnce();
  });
});
