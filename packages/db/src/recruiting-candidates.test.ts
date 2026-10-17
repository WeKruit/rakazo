import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createThreadMessageInTransaction } from "./messages.js";
import * as recruiting from "./recruiting.js";
import { IsolationError } from "./scope.js";

vi.mock("./messages.js", async (load) => ({
  ...(await load<typeof import("./messages.js")>()),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "human-shortlist-receipt" })),
}));
vi.mock("./events.js", () => ({
  appendEventInTransaction: vi.fn(async (_tx, input) => ({
    id: "recorded-event",
    seq: 2,
    createdAt: new Date(),
    ...input,
  })),
}));
const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const role = {
    id: "role",
    spaceId: "space",
    userId: "owner",
    sourceThreadId: "thread",
    currentRevisionId: "revision",
    revision: 1,
  };
  const candidate = { roleId: "role", candidateKey: "candidate", shortlisted: false, revision: 0 };
  const tx = {
    $queryRaw: vi.fn(async (_query: unknown) => [] as unknown[]),
    recruitingRole: { findFirst: vi.fn(async () => role) },
    thread: {
      findFirst: vi.fn(async () => ({
        ...actor,
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "role",
      })),
    },
    bot: { findFirst: vi.fn(async () => actor) },
    recruitingCandidate: {
      findUnique: vi.fn(async () => candidate),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, role, candidate };
}

describe("candidate listing and shortlist boundaries", () => {
  beforeEach(() => vi.clearAllMocks());
  it("authorizes before querying candidate data", async () => {
    const f = fixture();
    f.tx.recruitingRole.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      recruiting.listRecruitingCandidates(f.prisma, actor, { roleId: "foreign" }),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it("uses server counts and bounded SQL pagination, with cursors bound to filters", async () => {
    const f = fixture();
    const row = (key: string) => ({
      roleId: "role",
      candidateKey: key,
      name: key,
      title: null,
      company: null,
      location: null,
      linkedinUrl: null,
      resumeUrl: null,
      evidenceUrls: null,
      issues: [],
      shortlisted: false,
      revision: 0,
      discoveryCount: 1,
      firstDiscoveredAt: "2026-10-16T00:00:00.000Z",
      lastDiscoveredAt: "2026-10-16T00:00:00.000Z",
      assessmentVersion: null,
      assessmentRoleRevisionId: null,
      assessmentCreatedAt: null,
      hardGate: null,
      sortValue: key,
    });
    f.tx.$queryRaw.mockResolvedValueOnce([
      {
        total: 19n,
        sourceRows: 30n,
        candidates: 20n,
        identifiedCandidates: 4n,
        unassessed: 19n,
        assessed: 1n,
        shortlisted: 2n,
      },
    ]);
    f.tx.$queryRaw.mockResolvedValueOnce([row("a"), row("b")]);
    const page = await recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: "role",
      limit: 1,
      sort: "name",
      query: "Engineer",
    });
    expect(page.total).toBe(19);
    expect(page.counts).toEqual({
      sourceRows: 30,
      candidates: 20,
      identifiedCandidates: 4,
      unassessed: 19,
      assessed: 1,
      shortlisted: 2,
    });
    expect(page.items.map((item) => item.candidateKey)).toEqual(["a"]);
    const query = f.tx.$queryRaw.mock.lastCall?.[0] as unknown as {
      sql: string;
      values: unknown[];
    };
    expect(query.sql).toContain("LIMIT");
    expect(query.values).toContain(2);
    expect(query.sql).not.toContain("Engineer");
    await expect(
      recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "role",
        limit: 1,
        sort: "name",
        query: "Different",
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
  });
  it("makes a human shortlist receipt only for a successful candidate CAS change", async () => {
    const f = fixture();
    const input = {
      threadId: "thread",
      roleId: "role",
      candidateKey: "candidate",
      expectedRevision: 0,
      shortlisted: true,
    };
    expect(await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input)).toEqual({
      roleId: "role",
      candidateKey: "candidate",
      shortlisted: true,
      revision: 1,
    });
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ role: "user", threadId: "thread" }),
    );
    expect(f.tx.recruitingCandidate.updateMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: "candidate", revision: 0 },
      data: { shortlisted: true, revision: 1, shortlistMessageId: "human-shortlist-receipt" },
    });
  });
  it("rejects stale selection and performs no write for a no-op", async () => {
    const f = fixture();
    const input = {
      threadId: "thread",
      roleId: "role",
      candidateKey: "candidate",
      expectedRevision: 0,
      shortlisted: false,
    };
    expect(await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input)).toMatchObject({
      revision: 0,
      shortlisted: false,
    });
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(f.tx.recruitingCandidate.updateMany).not.toHaveBeenCalled();
    await expect(
      recruiting.setRecruitingCandidateShortlist(f.prisma, actor, {
        ...input,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    f.tx.thread.findFirst.mockResolvedValue({
      ...actor,
      id: "thread",
      botId: "bot",
      activeRecruitingRoleId: "changed-role",
    });
    await expect(
      recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input),
    ).rejects.toThrow(IsolationError);
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
  });
});

function observationFixture(rows: readonly unknown[] | undefined) {
  const f = fixture();
  const now = new Date("2026-10-16T00:00:00.000Z");
  const hash = "a".repeat(64);
  const run = {
    ...actor,
    id: "run",
    threadId: "thread",
    botId: "bot",
    bot: actor,
    status: "completed",
  };
  const human = {
    id: "human",
    threadId: "thread",
    role: "user",
    botId: null,
    externalTranscriptFor: null,
    blocks: [{ kind: "text", text: "Search examples" }],
  };
  const revision = {
    id: "revision",
    roleId: "role",
    revision: 1,
    createdAt: now,
    sourceRefs: [
      {
        id: "human",
        kind: "original_material",
        anchor: { kind: "message", messageId: "human", locator: "text:0" },
        readState: "unread",
        readAt: null,
      },
    ],
    criteria: [],
    preferences: [],
    definitionQuestions: [],
  };
  const action = {
    id: "action",
    taskId: "task",
    roleRevisionId: "revision",
    runId: "run",
    sourceMessageId: "human",
    clientNonce: "action-nonce",
    kind: "create",
    purpose: "calibration",
    candidateOutputSchema: "candidate_output_v1",
    approvalEffectId: "approval",
    deliveryState: "accepted",
    observedProviderState: null,
    requestArtifactId: "request",
    requestArtifactHash: hash,
    contextArtifactId: "context",
    contextArtifactHash: hash,
    recallScope: null,
    receiptArtifactId: null,
    receiptArtifactHash: null,
    outputArtifacts: [],
    cursor: null,
    effectId: null,
    usage: null,
  };
  const task = {
    id: "task",
    roleId: "role",
    mcpServerId: "server",
    serverRevision: 1,
    providerTaskId: "provider-task",
    pendingActionId: "action",
    state: "active",
    createdByRunId: "run",
  };
  const request = [
    "__rakazoCatalogTool",
    "direct",
    {
      route: {
        connectorId: "mcp",
        resourceId: "server",
        resourceRevision: 1,
        toolName: "get_rows",
      },
      args: { task_id: "provider-task" },
    },
  ];
  const rawResult =
    rows === undefined
      ? { content: [{ type: "text", text: "No structured result supplied" }] }
      : { structuredContent: { rows } };
  const effect = {
    ...actor,
    id: "read",
    runId: "run",
    status: "completed",
    request,
    result: rawResult,
    createdAt: now,
    updatedAt: now,
  };
  const artifacts = new Map(
    ["request", "context"].map((id) => [
      id,
      { ...actor, id, hash, botId: "bot", groupId: null, runId: "run", storageKey: id },
    ]),
  );
  const tx = {
    ...f.tx,
    recruitingRole: { findFirst: vi.fn(async () => ({ ...f.role, title: "Example engineer" })) },
    run: { findFirst: vi.fn(async () => run), findUniqueOrThrow: vi.fn(async () => run) },
    recruitingRoleRevision: { findFirst: vi.fn(async () => revision) },
    recruitingResearchAction: {
      findFirst: vi.fn(async () => action),
      findUniqueOrThrow: vi.fn(async () => action),
      update: vi.fn(async ({ data }) => ({ ...action, ...data })),
    },
    recruitingResearchTask: {
      findUnique: vi.fn(async () => task),
      findUniqueOrThrow: vi.fn(async () => task),
    },
    mcpServer: { findFirst: vi.fn(async () => ({ ...actor, id: "server", revision: 1 })) },
    message: { findMany: vi.fn(async () => [human]), findUnique: vi.fn(async () => human) },
    artifact: {
      findFirst: vi.fn(async ({ where }) => artifacts.get(where.id)),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async ({ where }) => artifacts.get(where.id)),
      create: vi.fn(async ({ data }) => ({ id: "observation-artifact", ...data })),
    },
    externalEffect: { findFirst: vi.fn(async () => effect) },
    event: {
      findMany: vi.fn(async () => [
        {
          id: "binding",
          seq: 1,
          spaceId: actor.spaceId,
          threadId: "thread",
          botId: "bot",
          runId: "run",
          type: "recruiting.read",
          payload: {
            phase: "bound",
            taskId: "task",
            actionId: "action",
            effectId: "read",
            toolName: "get_rows",
          },
          createdAt: now,
        },
      ]),
    },
    recruitingCandidatePage: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => data),
    },
    recruitingCandidate: {
      ...f.tx.recruitingCandidate,
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    recruitingCandidateOccurrence: {
      createMany: vi.fn(async (_input: unknown) => ({ count: rows?.length ?? 0 })),
      findMany: vi.fn(async (_input: unknown) => [
        { rowIndex: 0, candidateKey: "source-row:read:0" },
      ]),
    },
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const input = {
    runId: "run",
    actionId: "action",
    effectId: "read",
    request,
    rawResult,
    toolName: "get_rows" as const,
    ...(rows === undefined ? {} : { rows }),
    outputArtifact: {
      name: "observation.json",
      mimeType: "application/json",
      size: 1,
      hash,
      storageKey: "observation",
      clientNonce: "recruiting-observation:read",
    },
  };
  return { prisma, tx, input, action, artifacts, now, hash };
}

describe("native observation indexing", () => {
  it.each([undefined, []])(
    "keeps raw-only observations distinct from accepted empty pages: %j",
    async (rows) => {
      const f = observationFixture(rows);
      await recruiting.recordRecruitingResearchObservation(f.prisma, actor, f.input as never);
      expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ rowCount: rows === undefined ? null : 0 }),
      });
      expect(f.tx.recruitingCandidate.createMany).not.toHaveBeenCalled();
      expect(f.tx.recruitingCandidateOccurrence.createMany).not.toHaveBeenCalled();
      expect(f.tx.recruitingResearchAction.update).toHaveBeenCalledOnce();
    },
  );
  it("indexes all rows with independent unknown keys and deduplicated canonical profile keys", async () => {
    const row = {
      name: { value: "Example", source_id: "source" },
      linkedin_url: "https://www.linkedin.com/in/Example?trk=source",
      current_title: "Engineer",
      current_company: "Company",
      location: "London",
      resume_url: null,
      evidence_urls: [],
    };
    const f = observationFixture([
      row,
      { ...row, linkedin_url: "https://linkedin.com/in/EXAMPLE/" },
      null,
      { full_name: "Never inferred", _sources: { profile: "https://www.linkedin.com/in/no" } },
    ]);
    const receipt = await recruiting.recordRecruitingResearchObservation(
      f.prisma,
      actor,
      f.input as never,
    );
    expect(receipt).toHaveProperty("candidateRows", [
      { rowIndex: 0, candidateKey: "linkedin:/in/example" },
      { rowIndex: 1, candidateKey: "linkedin:/in/example" },
      { rowIndex: 2, candidateKey: "source-row:read:2" },
      { rowIndex: 3, candidateKey: "source-row:read:3" },
    ]);
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rowCount: 4,
        effectId: "read",
        artifactId: "observation-artifact",
        roleRevisionId: "revision",
      }),
    });
    expect(f.tx.recruitingCandidate.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: "role", candidateKey: "linkedin:/in/example" },
        { roleId: "role", candidateKey: "source-row:read:2" },
        { roleId: "role", candidateKey: "source-row:read:3" },
      ],
      skipDuplicates: true,
    });
    const occurrences = f.tx.recruitingCandidateOccurrence.createMany.mock
      .lastCall?.[0] as unknown as {
      data: Array<{
        rowIndex: number;
        candidateKey: string;
        name: string | null;
        issues: string[];
      }>;
    };
    expect(occurrences.data.map((item) => item.rowIndex)).toEqual([0, 1, 2, 3]);
    expect(occurrences.data[0]).toMatchObject({
      candidateKey: "linkedin:/in/example",
      name: "Example",
    });
    expect(occurrences.data[2]).toMatchObject({ name: null, issues: ["invalid_row"] });
    expect(occurrences.data[3]?.name).toBeNull();
  });
  it("fills a previously recorded native receipt without changing its cursor, state or usage", async () => {
    const f = observationFixture([{ name: "Example" }]);
    const output = {
      ...actor,
      id: "observation-artifact",
      hash: f.hash,
      botId: "bot",
      groupId: null,
      runId: "run",
      storageKey: "observation",
    };
    f.artifacts.set(output.id, output);
    Object.assign(f.action, {
      outputArtifacts: [{ artifactId: output.id, sha256: output.hash }],
      cursor: "current-cursor",
      receiptArtifactId: "context",
      receiptArtifactHash: f.hash,
      usage: [{ scope: "task", unit: "credits", amount: 2 }],
    });
    f.tx.artifact.findUnique.mockResolvedValue(output as never);
    const binding = (await f.tx.event.findMany())[0]!;
    f.tx.event.findMany.mockResolvedValue([
      binding,
      {
        ...binding,
        id: "recorded",
        seq: 2,
        payload: {
          phase: "recorded",
          taskId: "task",
          actionId: "action",
          effectId: "read",
          outputArtifact: { artifactId: output.id, sha256: output.hash },
        },
      },
    ] as never);
    await recruiting.recordRecruitingResearchObservation(f.prisma, actor, {
      ...f.input,
      historicalBackfill: true,
      cursor: "old-cursor",
      usage: [{ scope: "task", unit: "credits", amount: 0 }],
    } as never);
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledOnce();
    expect(f.tx.recruitingResearchAction.update).not.toHaveBeenCalled();
    expect(f.tx.artifact.create).not.toHaveBeenCalled();
    f.tx.recruitingCandidatePage.findUnique.mockResolvedValue({ effectId: "read" } as never);
    const replay = await recruiting.recordRecruitingResearchObservation(
      f.prisma,
      actor,
      f.input as never,
    );
    expect(replay.candidateRows).toEqual([{ rowIndex: 0, candidateKey: "source-row:read:0" }]);
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledOnce();
    expect(f.tx.recruitingCandidateOccurrence.createMany).toHaveBeenCalledOnce();
  });
  it("does not index a result that differs from its completed native effect", async () => {
    const f = observationFixture([{ name: "Example" }]);
    await expect(
      recruiting.recordRecruitingResearchObservation(f.prisma, actor, {
        ...f.input,
        rawResult: { changed: true },
      } as never),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
    expect(f.tx.artifact.create).not.toHaveBeenCalled();
  });
});
