import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, RecruiterSeen, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeRecruitingAssessmentTool,
  executeRecruitingCandidatesTool,
  NOTHING_SAVED_IS_NO_BLOCKER,
  peopleToShow,
  retainRecruitingWebMaterial,
} from "./recruiting-assessment.js";

const db = vi.hoisted(() => ({
  workspace: vi.fn(),
  roleId: vi.fn(),
  assessment: vi.fn(),
  save: vi.fn(),
  material: vi.fn(),
  question: vi.fn(),
  candidates: vi.fn(),
  sources: vi.fn(),
  round: vi.fn(),
  marks: vi.fn(async () => [] as unknown[]),
  seen: vi.fn(async (): Promise<RecruiterSeen> => ({ latestRound: null, people: new Map() })),
}));
const overview = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./recruiting-account.js", () => ({ readRecruitingAccountView: overview.read }));
const lookups = vi.hoisted(() => ({
  saved: vi.fn(async () => new Map()),
  searched: vi.fn(async () => new Map<string, Set<string>>()),
}));
vi.mock("./recruiting-research.js", async (original) => ({
  ...(await original<object>()),
  lookedUpContacts: async () => ({
    emails: await lookups.saved(),
    searched: await lookups.searched(),
  }),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<object>()),
  getRecruitingWorkspace: db.workspace,
  getRecruitingWorkspaceRoleId: db.roleId,
  getRecruitingAssessment: db.assessment,
  saveRecruitingAssessment: db.save,
  recordRecruitingWebMaterial: db.material,
  getRecruitingQuestion: db.question,
  listRecruitingCandidates: db.candidates,
  listRecruitingCandidateSources: db.sources,
  readRecruitingCalibrationRound: db.round,
  readRecruitingResultsMarks: db.marks,
  readRecruiterSeen: db.seen,
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
  const findSearches = vi.fn(async (): Promise<unknown[]> => []);
  const get = vi.fn<ArtifactStore["get"]>(async (id) => Buffer.from(`bytes:${id}`));
  const put = vi.fn<ArtifactStore["put"]>(async () => ({
    id: "stored-material",
    hash: "not-a-native-sha256",
  }));
  const prisma = {
    run: { findFirst: findRun },
    artifact: { findMany: findArtifacts },
    mcpServer: { findMany: vi.fn(async () => []) },
    recruitingCandidateOccurrence: { findMany: findSearches },
  } as unknown as PrismaClient;
  return {
    findSearches,
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
  function sourceFixture() {
    const f = fixture();
    const snapshot = {
      request: [
        "__rakazoCatalogTool",
        "direct",
        {
          route: {
            connectorId: "mcp",
            resourceId: "saved-connection",
            resourceRevision: 1,
            toolName: "get_rows",
          },
          args: { task_id: "provider-task", cursor: "original-cursor" },
        },
      ],
      providerResult: {
        structuredContent: {
          rows: [
            {
              name: { value: "Selected Person", source_id: "profile" },
              concerns: { value: null, evidence: "No code supplied" },
              _sources: { profile: "https://example.test/selected" },
            },
            { name: { value: "Neighbor Person" } },
          ],
          next_cursor: null,
        },
      },
    };
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const source = {
      crmImports: [],
      providerTaskId: "provider-task",
      taskId: null,
      actionId: null,
      roleRevisionId: "old-revision",
      effectId: "source-effect",
      rowIndex: 0,
      artifactRef: { artifactId: "original-page", sha256: hash },
      requestCursor: "original-cursor",
      outputId: null,
      observedAt: "2026-10-17T00:00:00.000Z",
    };
    const page = {
      roleId: "role",
      candidateKey: "candidate-one",
      total: 3,
      nextCursor: "next-source",
      items: [source],
    };
    const findFirst = vi.fn(async () => ({
      id: "original-page",
      spaceId: actor.spaceId,
      userId: actor.userId,
      storageKey: "stored",
      botId: "bot",
      hash,
      size: bytes.length,
    }));
    const internalFamilies = vi.fn(async () => [] as Array<{ id: string }>);
    Object.assign(f.deps.prisma.artifact, { findFirst });
    Object.assign(f.deps.prisma, { $queryRaw: internalFamilies });
    f.get.mockResolvedValue(bytes);
    db.sources.mockResolvedValue(page);
    return { ...f, source, page, findFirst, internalFamilies };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db.workspace.mockResolvedValue(workspace);
    // The candidate tool reads only the current role id; keep it in step with the snapshot mock.
    db.roleId.mockImplementation(
      async (...args: unknown[]) =>
        ((await db.workspace(...args)) as typeof workspace | null)?.role.id ?? null,
    );
  });

  it("reads candidates with the current role id instead of the full role snapshot", async () => {
    const f = fixture();
    db.roleId.mockResolvedValueOnce("role");
    db.candidates.mockResolvedValue({ roleId: "role", items: [], total: 0, nextCursor: null });
    await executeRecruitingCandidatesTool(f.deps, trusted, { operation: "list" }, context);
    expect(db.roleId).toHaveBeenCalledWith(f.deps.prisma, actor, { threadId: "thread" });
    expect(db.workspace).not.toHaveBeenCalled();
    expect(db.candidates).toHaveBeenCalledWith(f.deps.prisma, actor, { roleId: "role" });
  });

  it("marks each listed person with what the recruiter already saw of them", async () => {
    // Staging 11-14: lists, rounds and replies each guessed who was already shown, and a pool page
    // brought back people from round one and people the recruiter had turned down.
    const f = fixture();
    db.roleId.mockResolvedValueOnce("role");
    db.candidates.mockResolvedValue({
      roleId: "role",
      items: [
        { candidateKey: "shown" },
        { candidateKey: "rejected" },
        { candidateKey: "fresh" },
        { candidateKey: "found" },
      ],
      total: 4,
      nextCursor: null,
    });
    db.seen.mockResolvedValueOnce({
      latestRound: {
        round: 1,
        recordedAt: new Date("2026-11-14T03:00:00Z"),
        people: 10,
        accepted: false,
      },
      people: new Map([
        ["shown", { round: 1, seenBeforeLatestRound: true }],
        ["rejected", { round: 1, seenBeforeLatestRound: true, verdict: "not_fit" }],
        ["fresh", { seenBeforeLatestRound: false }],
        ["found", { seenBeforeLatestRound: true }],
      ]),
    });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list" },
      context,
    );
    expect(db.seen).toHaveBeenCalledWith(f.deps.prisma, actor, {
      roleId: "role",
      candidateKeys: ["shown", "rejected", "fresh", "found"],
    });
    expect(result).toMatchObject({
      latestRound: { round: 1, people: 10, accepted: false },
      items: [
        { candidateKey: "shown", shownInRound: 1, alreadySeen: "shown in round 1" },
        {
          candidateKey: "rejected",
          shownInRound: 1,
          alreadySeen: "shown in round 1",
          recruiterVerdict: "not_fit",
        },
        { candidateKey: "fresh" },
        // Staging 11-15: a person found before round 1 but never shown was called "in the first ten".
        {
          candidateKey: "found",
          alreadySeen: "found before round 1 and never shown in a round: not a repeat of any round",
        },
      ],
    });
    expect((result as { items: object[] }).items[3]).not.toHaveProperty("shownInRound");
    expect((result as { items: object[] }).items[2]).not.toHaveProperty("alreadySeen");
  });

  // Staging aefd141e: "7 unassessed" beside a Reviewer's 52/Partial read as a conflicting status.
  it("gives the Reviewer's grade as the review, without empty local-assessment fields", async () => {
    const f = fixture();
    db.roleId.mockResolvedValueOnce("role");
    const ranking = { source: "reviewer", state: "current", grade: "Partial", score: 52 };
    db.candidates.mockResolvedValueOnce({
      roleId: "role",
      items: [
        { candidateKey: "graded", ranking, latestAssessment: null },
        { candidateKey: "local", latestAssessment: { version: 1, hardGate: "fail" } },
      ],
      total: 2,
      nextCursor: null,
      counts: { candidates: 2, assessed: 1, unassessed: 1, shortlisted: 0 },
    });
    const result = (await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list" },
      context,
    )) as { counts: object; items: object[] };
    expect(result.counts).toEqual({ candidates: 2, shortlisted: 0 });
    expect(result.items[0]).toMatchObject({ candidateKey: "graded", ranking });
    expect(result.items[0]).not.toHaveProperty("latestAssessment");
    expect(result.items[1]).toMatchObject({ latestAssessment: { hardGate: "fail" } });
  });

  // Staging 2d92e0d2 and branch plays 11-25: the brief list took its grade from the ranking, which
  // only the default sort carries and which a brief change marks outdated, so the lead's
  // `sort:"tier", brief:true` read returned no grade for anyone it had already had checked.
  it("gives the saved grade in a brief list whatever the sort or brief revision", async () => {
    const f = fixture();
    db.roleId.mockResolvedValueOnce("role");
    db.candidates.mockResolvedValueOnce({
      roleId: "role",
      items: [
        { candidateKey: "a", name: "A", match: { rank: null, tier: "Strong", score: 90 } },
        {
          candidateKey: "b",
          name: "B",
          ranking: { source: "reviewer", state: "outdated", grade: "Promising", score: 70 },
          match: { rank: null, tier: "Promising", score: 70 },
        },
        { candidateKey: "c", name: "C", match: { rank: null, tier: null, score: null } },
      ],
      total: 3,
      nextCursor: null,
    });
    db.seen.mockResolvedValueOnce({ latestRound: null, people: new Map() });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list", sort: "tier", brief: true },
      context,
    );
    expect(result).toMatchObject({
      items: [
        { candidateKey: "a", grade: "Strong" },
        { candidateKey: "b", grade: "Promising" },
        { candidateKey: "c", grade: null },
      ],
    });
  });

  // Staging 11-15: "shown in round 2" on the latest round's own people read as nine repeats.
  it("says the latest round's people are in it, not repeats", async () => {
    const f = fixture();
    db.roleId.mockResolvedValueOnce("role");
    db.candidates.mockResolvedValueOnce({
      roleId: "role",
      items: [{ candidateKey: "first" }, { candidateKey: "latest" }],
      total: 2,
      nextCursor: null,
    });
    db.seen.mockResolvedValueOnce({
      latestRound: { round: 2, recordedAt: new Date(), people: 10, accepted: false },
      people: new Map([
        ["first", { round: 1, seenBeforeLatestRound: true }],
        ["latest", { round: 2, seenBeforeLatestRound: false }],
      ]),
    });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list" },
      context,
    );
    expect(result).toMatchObject({
      items: [
        { candidateKey: "first", shownInRound: 1, alreadySeen: "shown in round 1" },
        {
          candidateKey: "latest",
          shownInRound: 2,
          alreadySeen: "in round 2, the latest round, and in no earlier round: not a repeat",
        },
      ],
    });
  });

  it("reads a named role's round from the global conversation", async () => {
    // Staging 11-14: global Kruit was told to read the round with the roleId, the schema refused
    // the key, and it listed the newest saved people instead of the round as the new ten.
    const f = fixture();
    db.roleId.mockResolvedValueOnce(null);
    const round = { round: 2, candidates: [{ candidateKey: "c1" }] };
    db.round.mockResolvedValue({ roleId: "role-named", round });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "round", roleId: "role-named" },
      context,
    );
    expect(db.round).toHaveBeenCalledWith(f.deps.prisma, actor, {
      threadId: "thread",
      roleId: "role-named",
    });
    expect(result).toMatchObject({ status: "found", round });
  });

  it("gives the link that opens the role's Results with the round", async () => {
    // fosp x5 11-20: asked to open Results and see the marks, Kruit had no link to give and
    // wrote an HTML file instead.
    const f = fixture();
    const findFirst = vi.fn(async () => ({ sourceThread: { groupId: "group-role" } }));
    Object.assign(f.deps.prisma, { recruitingRole: { findFirst } });
    db.round.mockResolvedValue({ roleId: "role-named", round: { round: 1, candidates: [] } });
    const result = await executeRecruitingCandidatesTool(
      { ...f.deps, webOrigin: "https://app.example.test" },
      trusted,
      { operation: "round", roleId: "role-named" },
      context,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "role-named" } }),
    );
    expect(result).toMatchObject({
      resultsPage: "https://app.example.test/app/g/group-role?view=results",
    });
  });

  it("says which mark Results shows for each person in the round", async () => {
    // fosp x5 11-20: Kruit read an empty decision as unmarked, but Results shows the recruiter's
    // "not a fit" as passed.
    const f = fixture();
    const candidates = [
      { candidateKey: "turned-down", recruiterVerdict: "not_fit" },
      { candidateKey: "held", decision: "hold", recruiterVerdict: "not_fit" },
      { candidateKey: "new" },
    ];
    db.round.mockResolvedValue({ roleId: "role-named", round: { round: 1, candidates } });
    const result = (await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "round", roleId: "role-named" },
      context,
    )) as { round: { candidates: Array<{ onResults?: string }> } };
    expect(result.round.candidates.map((person) => person.onResults)).toEqual([
      "not a fit",
      "on hold",
      undefined,
    ]);
  });

  it("says with the round that it repeats no one and what the recruiter said about the last one", async () => {
    // Staging 11-15: global Kruit called two round-1 people repeats in round 2, and could not find
    // the feedback the recruiter gave in the role's chat.
    const f = fixture();
    const findRounds = vi.fn(async () => [
      { round: 1, createdAt: new Date("2026-11-15T02:04:00Z") },
    ]);
    const findEffects = vi.fn(async () => [
      {
        request: {
          target: "candidate",
          fit: "not_fit",
          intent: { quote: "garrett is a software engineer, not data eng" },
        },
      },
    ]);
    Object.assign(f.deps.prisma, {
      recruitingCalibrationRound: { findMany: findRounds },
      externalEffect: { findMany: findEffects },
    });
    db.roleId.mockResolvedValueOnce(null);
    const round = {
      round: 2,
      createdAt: "2026-11-15T02:07:00.000Z",
      candidates: [{ candidateKey: "c1" }],
    };
    db.round.mockResolvedValue({ roleId: "role-named", round });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "round", roleId: "role-named" },
      context,
    );
    expect(result).toMatchObject({
      status: "found",
      round: {
        round: 2,
        repeats: expect.stringContaining("none"),
        feedbackBeforeThisRound: [
          { said: "garrett is a software engineer, not data eng", fit: "not_fit" },
        ],
      },
    });
  });

  it("says who Results marks on the role, whichever round is read", async () => {
    // fosp x5 11-20 (1ae3a9c3): asked about round 1's turned-down people, Kruit read round 2.
    const f = fixture();
    db.roleId.mockResolvedValueOnce(null);
    db.round.mockResolvedValue({
      roleId: "role-named",
      round: {
        round: 2,
        createdAt: "2026-11-20T20:52:00.000Z",
        candidates: [{ candidateKey: "c9" }],
      },
    });
    db.marks.mockResolvedValueOnce([
      { candidateKey: "c3", name: "Person C", round: 1, mark: "not a fit" },
      { candidateKey: "c4", name: null, mark: "on hold" },
    ]);
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "round", roleId: "role-named" },
      context,
    );
    expect(result).toMatchObject({
      status: "found",
      markedOnResults: ["Person C (round 1): not a fit", "c4: on hold"],
    });
    expect(db.marks).toHaveBeenCalledWith(f.deps.prisma, actor, { roleId: "role-named" });
  });

  it.each([
    ["list", "succeeded"],
    ["list", "error"],
    ["sources", "succeeded"],
    ["sources", "error"],
  ] as const)("logs only settled safe read metadata for %s/%s", async (operation, outcome) => {
    const previousLogger = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "candidate-read-check", sinks: [sink] }));
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const f = fixture();
      const failure = new Error("private candidate URL and database diagnostic");
      const page = {
        candidateKey: "private-candidate",
        items: operation === "list" ? [{ candidateKey: "private result" }] : [],
      };
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resolveRead!: (value: unknown) => void;
      let rejectRead!: (error: Error) => void;
      const result = new Promise((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
      const reader = operation === "list" ? db.candidates : db.sources;
      reader.mockImplementation(() => {
        entered();
        return result;
      });
      const paging = outcome === "succeeded" ? { limit: 2, cursor: "private-cursor" } : {};
      const pending = executeRecruitingCandidatesTool(
        f.deps,
        trusted,
        operation === "list"
          ? { operation, query: "private query https://example.test/profile", ...paging }
          : { operation, candidateKey: "private-candidate", ...paging },
        context,
      );
      await reading;
      expect(sink.events).toHaveLength(0);
      clock = 17.6;
      if (outcome === "succeeded") {
        resolveRead(page);
        expect(await pending).toMatchObject(page);
      } else {
        rejectRead(failure);
        await expect(pending).rejects.toBe(failure);
      }
      expect(sink.events).toEqual([
        {
          timestamp: expect.any(String),
          level: "info",
          message: "recruiting.candidates.read.timing",
          "service.name": "candidate-read-check",
          operation,
          limit: paging.limit ?? null,
          hasCursor: paging.cursor !== undefined,
          durationMs: 18,
          authorizeMs: 0,
          queryMs: outcome === "succeeded" ? 18 : null,
          reportReadMs: operation === "sources" && outcome === "succeeded" ? 0 : null,
          itemCount: outcome === "succeeded" ? page.items.length : null,
          outcome,
        },
      ]);
    } finally {
      now.mockRestore();
      installLogger(previousLogger);
    }
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
        f.deps,
        trusted,
        // Branch a2d787f8: show (whether Kruit posts the page) reached the saved-people read,
        // which refused it, and Kruit told the recruiter it would drop the parameter.
        { operation: "list", query, limit: 2, cursor: "opaque+/=", show: true },
        context,
      );
      expect(result).toEqual({
        ...page,
        items: page.items.map((item) => ({ ...item, email: "not_looked_up" })),
      });
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

  it("tells the agent to list without the query when a filtered list matches no one", async () => {
    const f = fixture();
    db.candidates.mockResolvedValue({ roleId: "role", items: [], total: 0, nextCursor: null });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list", query: "Data Engineer 6", limit: 3 },
      context,
    );
    expect(result).toMatchObject({
      items: [],
      next: `No saved person matched this query. To list the role's people, call again without query. ${NOTHING_SAVED_IS_NO_BLOCKER}`,
    });
  });

  it("shows each listed person's email saved by an earlier contact lookup", async () => {
    const f = fixture();
    const linkedinUrl = "https://www.linkedin.com/in/example-person";
    db.candidates.mockResolvedValue({
      roleId: "role",
      items: [
        { candidateKey: "candidate-one", name: "Example Person", linkedinUrl },
        { candidateKey: "candidate-two", name: "Other Person" },
        { candidateKey: "candidate-three", name: "Third Person" },
      ],
      total: 3,
      nextCursor: null,
    });
    lookups.saved.mockResolvedValueOnce(
      new Map([
        [
          "linkedin:/in/example-person",
          [
            {
              address: "maybe@example.test",
              type: "personal",
              status: null,
              provider: "fullenrich",
            },
            {
              address: "person@example.test",
              type: "work",
              status: "DELIVERABLE",
              provider: "fullenrich",
            },
          ],
        ],
      ]),
    );
    // Simulated 11-16 on 245ab70b (team-has-no-email, 2/10): "who has no email" had only a
    // missing field to go on, so the team guessed the wrong person.
    lookups.searched.mockResolvedValueOnce(new Map([["candidate-two", new Set(["fullenrich"])]]));
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list" },
      context,
    );
    expect(result).toMatchObject({
      items: [
        { candidateKey: "candidate-one", email: { address: "person@example.test", type: "work" } },
        { candidateKey: "candidate-two", email: "none_found" },
        { candidateKey: "candidate-three", email: "not_looked_up" },
      ],
    });
  });

  it("returns verified selected source reports with unchanged references and pagination", async () => {
    const f = sourceFixture();
    f.page.items.push({ ...f.source });
    // The language check's finding, saved with the search, comes with the person's sources.
    Object.assign(f.deps.prisma, {
      recruitingCandidateOccurrence: {
        findMany: async () => [
          {
            page: {
              effect: {
                result: {
                  languageLevels: { requirement: "Mandarin", levels: { "candidate-one": "strong" } },
                },
              },
            },
          },
        ],
      },
    });
    const result = await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      {
        operation: "sources",
        candidateKey: "candidate-one",
        cursor: "original-cursor",
        limit: 1,
      },
      context,
    );
    expect(result).toMatchObject({
      ...f.page,
      items: f.page.items.map((source) => ({
        ...source,
        report: {
          fields: [
            {
              label: "Name",
              value: "Selected Person",
              sourceUrls: ["https://example.test/selected"],
            },
            { label: "Concerns", value: null, evidence: "No code supplied", sourceUrls: [] },
          ],
          sourceUrls: ["https://example.test/selected"],
        },
      })),
    });
    expect(result).toMatchObject({
      requiredLanguage: "Mandarin: strong (the language check's finding)",
    });
    expect(JSON.stringify(result)).not.toContain("Neighbor Person");
    expect(f.page.items.every((source) => !("report" in source))).toBe(true);
    expect(db.sources).toHaveBeenCalledWith(f.deps.prisma, actor, {
      roleId: "role",
      candidateKey: "candidate-one",
      cursor: "original-cursor",
      limit: 1,
    });
    expect(db.candidates).not.toHaveBeenCalled();
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "original-page", spaceId: actor.spaceId, userId: actor.userId },
    });
    expect(f.internalFamilies).toHaveBeenCalledOnce();
    expect(f.get).toHaveBeenCalledOnce();
    expect(db.save).not.toHaveBeenCalled();
  });

  it.each(["artifact-store", "actor", "internal-family", "hash", "bytes", "row", "cursor"])(
    "fails the native read instead of returning metadata-only evidence at the %s boundary",
    async (boundary) => {
      const f = sourceFixture();
      if (boundary === "artifact-store") f.deps.artifacts = undefined as never;
      if (boundary === "actor") f.findFirst.mockResolvedValue(null as never);
      if (boundary === "internal-family")
        f.internalFamilies.mockResolvedValue([{ id: "internal-context-version" }]);
      if (boundary === "hash") f.source.artifactRef.sha256 = "0".repeat(64);
      if (boundary === "bytes") f.get.mockResolvedValue(Buffer.from("changed"));
      if (boundary === "row") f.source.rowIndex = 99;
      if (boundary === "cursor") f.source.requestCursor = "different-cursor";
      await expect(
        executeRecruitingCandidatesTool(
          f.deps,
          trusted,
          { operation: "sources", candidateKey: "candidate-one", limit: 1 },
          context,
        ),
      ).rejects.toThrow("Resource not found");
      if (["artifact-store", "actor", "internal-family"].includes(boundary))
        expect(f.get).not.toHaveBeenCalled();
      expect(db.save).not.toHaveBeenCalled();
    },
  );

  it.each(["list", "sources"])(
    "reports no current role for %s with the open roles to name, without inventing a page",
    async (operation) => {
      const f = fixture();
      const roles = [{ id: "role-1", title: "Data engineer" }];
      const findRoles = vi.fn(async () => roles);
      (f.deps.prisma as unknown as { recruitingRole: unknown }).recruitingRole = {
        findMany: findRoles,
      };
      db.workspace.mockResolvedValue(null);
      expect(
        await executeRecruitingCandidatesTool(
          f.deps,
          trusted,
          operation === "list" ? { operation } : { operation, candidateKey: "candidate-one" },
          context,
        ),
      ).toEqual({
        status: "no_current_role",
        roles,
        next: expect.any(String),
      });
      // Only the caller's own open roles.
      expect(findRoles).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: actor.userId,
            spaceId: actor.spaceId,
            archivedAt: null,
          }),
        }),
      );
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

  it.each([{ actor: { userId: "foreign" } }, { shortlisted: true }])(
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

describe("native cross-role recruiting reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.roleId.mockResolvedValue(null);
    overview.read.mockResolvedValue({
      roles: [{ id: "role", title: "Engineer" }],
      items: [],
      nextCursor: null,
    });
  });

  it.each([
    ["roles", "roles"],
    ["interviews", "interview"],
    ["shortlist", "shortlist"],
    ["replies", "inbox"],
    ["sequences", "sequence"],
  ])("routes %s through the same account reader as the page", async (operation, view) => {
    const f = fixture();
    const connector = { execute: vi.fn() };
    await executeRecruitingCandidatesTool(
      { ...f.deps, connector },
      trusted,
      { operation },
      context,
    );
    expect(overview.read).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: f.deps.prisma, connectors: connector }),
      actor,
      {
        view,
        roleId: undefined,
        since: undefined,
        cursor: undefined,
        itemCursor: undefined,
        campaignId: undefined,
        campaignServerId: undefined,
        campaignLeadCursor: undefined,
        limit: operation === "interviews" ? 50 : 20,
      },
    );
    const guard = overview.read.mock.calls[0]![0].stillAuthorized;
    await expect(guard()).resolves.toBe(true);
    f.run.userId = "foreign";
    await expect(guard()).rejects.toThrow();
  });

  it("returns only the page's roles, not the whole account's role list", async () => {
    const f = fixture();
    overview.read.mockResolvedValue({
      roles: [
        { id: "role", title: "Engineer" },
        { id: "other", title: "Designer" },
      ],
      items: [{ roleId: "role" }],
      nextCursor: "role",
      total: 2,
    });
    const result = await executeRecruitingCandidatesTool(
      { ...f.deps, connector: { execute: vi.fn() } },
      trusted,
      { operation: "sequences" },
      context,
    );
    expect(result).toMatchObject({ roles: [{ id: "role" }], nextCursor: "role", total: 2 });
  });

  it("pages a read too large for the model's context at the roles that fit", async () => {
    // Staging 11-20 (what-happened-since-yesterday): a sequences read of 20 roles, each with its
    // stored mail, did not fit the model's context and the turn failed with nothing said.
    const f = fixture();
    const mail = "x".repeat(30_000);
    overview.read.mockResolvedValue({
      roles: ["a", "b", "c"].map((id) => ({ id, title: id })),
      items: ["a", "b", "c"].map((roleId) => ({ roleId, mail })),
      nextCursor: null,
      total: 3,
    });
    const result = (await executeRecruitingCandidatesTool(
      { ...f.deps, connector: { execute: vi.fn() } },
      trusted,
      { operation: "sequences" },
      context,
    )) as { items: { roleId: string }[]; roles: { id: string }[]; nextCursor: string | null };
    expect(result.items.map((item) => item.roleId)).toEqual(["a"]);
    expect(result.roles.map((role) => role.id)).toEqual(["a"]);
    expect(result.nextCursor).toBe("a");
  });

  it("lists a named role's people where no role is linked, never overriding a linked role", async () => {
    const f = fixture();
    db.candidates.mockResolvedValue({ roleId: "selected", items: [], total: 0, nextCursor: null });
    await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list", roleId: "selected", limit: 3 },
      context,
    );
    expect(db.candidates).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      roleId: "selected",
      limit: 3,
    });
    db.roleId.mockResolvedValue("current");
    await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list", roleId: "selected" },
      context,
    );
    expect(db.candidates).toHaveBeenLastCalledWith(f.deps.prisma, actor, { roleId: "current" });
  });

  it("turns a numbered page into an offset of whole pages", async () => {
    const f = fixture();
    db.candidates.mockResolvedValue({ roleId: "selected", items: [], total: 0, nextCursor: null });
    await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "list", roleId: "selected", page: 3 },
      context,
    );
    expect(db.candidates).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      roleId: "selected",
      limit: 10,
      offset: 20,
    });
  });

  it("reads a named role's saved sources where no role is linked", async () => {
    const f = fixture();
    db.sources.mockResolvedValue({ roleId: "selected", items: [], nextCursor: null });
    await executeRecruitingCandidatesTool(
      f.deps,
      trusted,
      { operation: "sources", candidateKey: "candidate", roleId: "selected" },
      context,
    );
    expect(db.sources).toHaveBeenLastCalledWith(f.deps.prisma, actor, {
      roleId: "selected",
      candidateKey: "candidate",
    });
  });

  it("uses the current role by default and honors an explicit owned role filter", async () => {
    const f = fixture();
    db.roleId.mockResolvedValue("current");
    const deps = { ...f.deps, connector: { execute: vi.fn() } };
    await executeRecruitingCandidatesTool(deps, trusted, { operation: "shortlist" }, context);
    expect(overview.read.mock.calls.at(-1)![2].roleId).toBe("current");
    await executeRecruitingCandidatesTool(
      deps,
      trusted,
      { operation: "shortlist", roleId: "selected" },
      context,
    );
    expect(overview.read.mock.calls.at(-1)![2].roleId).toBe("selected");
  });

  it("says whether an empty role list is the account's whole record (simulated 2026-11-16, push-back)", async () => {
    const f = fixture();
    overview.read.mockResolvedValue({ roles: [], items: [], nextCursor: null });
    const findMany = vi.fn(async (_query: unknown) => [] as { title: string; archivedAt: Date }[]);
    const deps = {
      ...f.deps,
      prisma: { ...f.deps.prisma, recruitingRole: { findMany } } as unknown as PrismaClient,
      connector: { execute: vi.fn() },
    };
    const none = (await executeRecruitingCandidatesTool(
      deps,
      trusted,
      { operation: "roles" },
      context,
    )) as { closedRoles?: unknown[]; note?: string };
    expect(none.closedRoles).toEqual([]);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { userId: actor.userId, spaceId: actor.spaceId },
    });
    findMany.mockResolvedValueOnce([
      { title: "Java", archivedAt: new Date("2026-11-15T09:00:00Z") },
    ]);
    const closed = (await executeRecruitingCandidatesTool(
      deps,
      trusted,
      { operation: "roles" },
      context,
    )) as { closedRoles?: unknown[]; note?: string };
    expect(closed.closedRoles).toEqual([{ title: "Java", closedAt: "2026-11-15T09:00:00.000Z" }]);
    expect(closed.note).not.toBe(none.note);
  });

  it.each([
    { status: "not_checked" },
    { status: "failed" },
    { status: "unsupported" },
    { connectionChanged: true },
    { connections: [{ status: "needs_connection", checkIssue: null }] },
    { connections: [{ status: "configured", checkIssue: { status: "failed" } }] },
    { partial: true },
    { nextCursor: "next-mail" },
  ])(
    "does not present unavailable or incomplete replies as a complete zero (%j)",
    async (unknown) => {
      const f = fixture();
      overview.read.mockResolvedValue({
        roles: [{ id: "role", title: "Engineer" }],
        items: [
          {
            roleId: "role",
            correspondence: {
              status: "empty",
              connectionChanged: false,
              connections: [],
              partial: false,
              nextCursor: null,
              emails: [],
              ...unknown,
            },
          },
        ],
        nextCursor: null,
      });
      const deps = { ...f.deps, connector: { execute: vi.fn() } };
      expect(
        await executeRecruitingCandidatesTool(deps, trusted, { operation: "replies" }, context),
      ).toMatchObject({ counts: { messages: 0, complete: false } });
    },
  );

  it("reports a verified complete empty inbox as zero", async () => {
    const f = fixture();
    overview.read.mockResolvedValue({
      roles: [{ id: "role", title: "Engineer" }],
      items: [
        {
          roleId: "role",
          correspondence: {
            status: "empty",
            connectionChanged: false,
            connections: [{ status: "configured", checkIssue: null }],
            partial: false,
            nextCursor: null,
            emails: [],
          },
        },
      ],
      nextCursor: null,
    });
    expect(
      await executeRecruitingCandidatesTool(
        { ...f.deps, connector: { execute: vi.fn() } },
        trusted,
        { operation: "replies" },
        context,
      ),
    ).toMatchObject({
      counts: { messages: 0, complete: true },
      // A one-off email outside a role is not in this read; its reply is in the mailbox.
      note: expect.stringContaining("search_contact_emails"),
    });
  });

  it("counts only received mail and keeps page completeness explicit", async () => {
    const f = fixture();
    overview.read.mockResolvedValue({
      roles: [{ id: "role", title: "Engineer" }],
      items: [
        {
          roleId: "role",
          correspondence: {
            emails: [
              { sender: "candidate@example.test", direction: "received" },
              { sender: "candidate@example.test", crm: { direction: "received" } },
              { sender: "recruiter@example.test", direction: "sent" },
              { sender: "unknown@example.test" },
            ],
          },
        },
      ],
      nextCursor: "next-role",
    });
    const result = await executeRecruitingCandidatesTool(
      { ...f.deps, connector: { execute: vi.fn() } },
      trusted,
      { operation: "replies" },
      context,
    );
    expect(result).toMatchObject({
      counts: { messages: 2, people: 1, complete: false },
      nextCursor: "next-role",
    });
  });
});

describe("peopleToShow", () => {
  // Staging 11-15: asked for "only the new ones", Kruit's page relisted five of round 1's ten.
  it("never relists people shown in a round, turned down or already listed", () => {
    const items = [
      { candidateKey: "a", shownInRound: 1, alreadySeen: "shown in round 1" },
      { candidateKey: "b" },
      { candidateKey: "c", alreadySeen: "found before round 2 and never shown in a round" },
      { candidateKey: "d", recruiterVerdict: "not_fit" as const },
      { candidateKey: "e" },
    ];
    expect(peopleToShow(items, { size: 10, listed: new Set(["e"]) })).toEqual({
      shown: [items[1], items[2]],
      inRounds: 1,
      farAway: 0,
    });
  });

  // Staging 11-15: a page for a Bay Area role listed two people in Texas whom the search had
  // left out for living beyond commuting distance.
  it("leaves out people beyond commuting distance of a local role", () => {
    const items = [
      { candidateKey: "a", location: "Austin, Texas" },
      { candidateKey: "b", location: "San Jose, California" },
      { candidateKey: "c", location: null },
    ];
    expect(
      peopleToShow(items, {
        size: 10,
        listed: new Set(),
        beyond: (location) => location.includes("Texas"),
      }),
    ).toEqual({ shown: [items[1], items[2]], inRounds: 0, farAway: 1 });
  });
});
