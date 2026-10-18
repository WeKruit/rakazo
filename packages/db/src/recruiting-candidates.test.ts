import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  normalizeRecruitingCandidateRow,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
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
    title: "Systems engineer",
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
      recruiting.listRecruitingCandidates(f.prisma, actor, {
        roleId: "foreign",
        sourceEffectId: "native-read",
      }),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(["Engineer", "Example Candidate", "https://www.linkedin.com/in/example-candidate"])(
    "uses scoped server counts and bounded SQL pagination for %s, with cursors bound to filters",
    async (search) => {
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
        query: search,
        sourceEffectId: "native-read",
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
      expect(page.crmTarget).toBeNull();
      expect(page.items[0]?.crm).toBeNull();
      const query = f.tx.$queryRaw.mock.lastCall?.[0] as unknown as {
        sql: string;
        values: unknown[];
      };
      expect(query.sql).toContain("LIMIT");
      expect(query.values).toContain(2);
      expect(query.sql).not.toContain(search);
      expect(query.values).toContain(search);
      expect(query.sql).toContain('b."name"');
      expect(query.sql).toContain('b."linkedinUrl"');
      for (const [statement] of f.tx.$queryRaw.mock.calls) {
        const sql = statement as { sql: string; values: unknown[] };
        expect(sql.sql).toContain(
          'WHERE o."roleId" = b."roleId" AND o."candidateKey" = b."candidateKey" AND p."effectId" = ?',
        );
        expect(sql.values).toContain("native-read");
        expect(sql.sql).not.toContain('p."actionId" =');
      }
      const totals = f.tx.$queryRaw.mock.calls[0]![0] as { sql: string };
      expect(totals.sql).toContain('(SELECT count(*) FROM filtered) AS "total"');
      expect(totals.sql).toContain('AS "shortlisted" FROM base');
      for (const changed of [
        { query: "Different" },
        { sourceEffectId: "other-read" },
        { sourceEffectId: undefined },
        { actionId: "action" },
      ])
        await expect(
          recruiting.listRecruitingCandidates(f.prisma, actor, {
            roleId: "role",
            limit: 1,
            sort: "name",
            query: search,
            sourceEffectId: "native-read",
            cursor: page.nextCursor!,
            ...changed,
          }),
        ).rejects.toThrow(recruiting.RecruitingConflictError);
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    },
  );
  it.each([{ actionId: "action" }, { actionId: "action", sourceEffectId: "native-read" }])(
    "intersects source and action membership without changing the action predicate: %j",
    async (filters) => {
      const f = fixture();
      f.tx.$queryRaw.mockResolvedValueOnce([
        {
          total: 0n,
          sourceRows: 3n,
          candidates: 2n,
          identifiedCandidates: 2n,
          unassessed: 2n,
          assessed: 0n,
          shortlisted: 0n,
        },
      ]);
      await recruiting.listRecruitingCandidates(f.prisma, actor, { roleId: "role", ...filters });
      for (const [statement] of f.tx.$queryRaw.mock.calls) {
        const query = statement as { sql: string; values: unknown[] };
        expect(query.sql).toContain(
          'WHERE o."roleId" = b."roleId" AND o."candidateKey" = b."candidateKey" AND p."actionId" = ?',
        );
        expect(query.values).toContain("action");
        if (filters.sourceEffectId) {
          expect(query.sql).toContain(") AND EXISTS (");
          expect(query.values).toContain(filters.sourceEffectId);
        }
      }
    },
  );
  it("makes a human shortlist receipt only for a successful candidate CAS change", async () => {
    const f = fixture();
    f.candidate.candidateKey = "internal-candidate-key";
    f.tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: "Synthetic Avery",
          linkedinUrl: "https://www.linkedin.com/in/synthetic-avery",
          resumeUrl: null,
        },
      ]);
    const input = {
      threadId: "thread",
      roleId: "role",
      candidateKey: f.candidate.candidateKey,
      expectedRevision: 0,
      shortlisted: true,
    };
    expect(await recruiting.setRecruitingCandidateShortlist(f.prisma, actor, input)).toEqual({
      roleId: "role",
      candidateKey: f.candidate.candidateKey,
      shortlisted: true,
      revision: 1,
    });
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(f.tx, {
      role: "user",
      threadId: "thread",
      clientNonce: 'recruiting-shortlist:["role","revision","internal-candidate-key",0,true]',
      blocks: [
        {
          kind: "text",
          text: "Shortlist Synthetic Avery · https://www.linkedin.com/in/synthetic-avery for Systems engineer (requirements version 1).",
        },
      ],
    });
    expect(f.tx.recruitingCandidate.updateMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: f.candidate.candidateKey, revision: 0 },
      data: { shortlisted: true, revision: 1, shortlistMessageId: "human-shortlist-receipt" },
    });
    const profileQuery = f.tx.$queryRaw.mock.lastCall![0] as { values: unknown[] };
    expect(profileQuery.values).toEqual(["role", f.candidate.candidateKey]);
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
  return {
    prisma,
    tx,
    input,
    action,
    artifacts,
    now,
    hash,
    effect,
    task,
    run,
    revision,
    role: f.role,
  };
}

function crmFixture() {
  const raw = {
    name: "Example",
    linkedin_url: "https://www.linkedin.com/in/example",
    current_title: "Engineer",
    current_company: "Example Company",
    location: "London",
    resume_url: null,
    evidence_urls: [],
  };
  const f = observationFixture([raw]);
  Object.assign(f.run, {
    status: "running",
    leaseOwner: "worker",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const target = {
    mcpServerId: "crm-server",
    serverRevision: 2,
    organizationId: "10000000-0000-4000-8000-000000000001",
    crmRoleId: "20000000-0000-4000-8000-000000000002",
    crmClientId: "30000000-0000-4000-8000-000000000003",
    clientLabel: "Client",
    roleLabel: "Engineer",
  };
  const bindingInput = {
    operation: "bind" as const,
    roleId: "role",
    expectedRoleRevision: 1,
    expectedBindingEffectId: null,
    crmRoleReadEffectId: "crm-read",
  };
  const binding = {
    id: "binding-effect",
    spaceId: actor.spaceId,
    runId: "run",
    kind: "recruiting_crm_target",
    status: "completed",
    request: bindingInput as unknown,
    result: {
      status: "connected",
      roleId: "role",
      bindingEffectId: "binding-effect",
      target,
    } as unknown,
    createdAt: f.now,
  };
  const crmRead = {
    id: "crm-read",
    spaceId: actor.spaceId,
    runId: "run",
    kind: "mcp__crm__get_crm_role",
    status: "completed",
    request: boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: target.mcpServerId,
        resourceRevision: 2,
        toolName: "get_crm_role",
      },
      { p_org: target.organizationId, p_role: target.crmRoleId },
      "__rakazoCatalogTool",
    ),
    result: {
      structuredContent: {
        data: {
          role_spec_id: target.crmRoleId,
          client_id: target.crmClientId,
          client_label: target.clientLabel,
          role_label: target.roleLabel,
        },
      },
    },
    createdAt: f.now,
  };
  const effects = new Map<string, typeof binding>([
    [binding.id, binding],
    [crmRead.id, crmRead as never],
    [f.effect.id, f.effect as never],
  ]);
  const approvals = new Set([binding.id]);
  const role = { ...f.role, title: "Native role", crmBindingEffectId: binding.id as string | null };
  const page = {
    effectId: "read",
    effect: f.effect,
    roleId: "role",
    taskId: "task",
    actionId: "action",
    roleRevisionId: "revision",
    artifactId: "observation-artifact",
    artifactHash: f.hash,
    requestCursor: null,
    outputId: null,
    observedAt: f.now,
    rowCount: 1,
  };
  const { candidateIdentity, ...profile } = normalizeRecruitingCandidateRow(raw, {
    schemaKnown: true,
  });
  const occurrence = {
    pageId: page.effectId,
    rowIndex: 0,
    roleId: "role",
    candidateKey: `linkedin:${candidateIdentity}`,
    ...profile,
    page,
  };
  const links: Array<{
    effectId: string;
    bindingEffectId: string;
    pageId: string;
    rowIndex: number;
  }> = [];
  const input = {
    roleId: role.id,
    candidateKey: occurrence.candidateKey,
    bindingEffectId: binding.id,
    sourceEffectId: page.effectId,
    rowIndex: 0,
  };
  const trusted = {
    runId: "run",
    threadId: "thread",
    botId: "bot",
    leaseOwner: "worker",
    leaseFence: 1,
  };
  const artifact = {
    ...actor,
    id: page.artifactId,
    hash: f.hash,
    botId: "bot",
    groupId: null,
    runId: "run",
    storageKey: "observation",
    clientNonce: "recruiting-observation:read",
  };
  f.artifacts.set(artifact.id, artifact);
  f.action.outputArtifacts = [{ artifactId: artifact.id, sha256: f.hash }] as never;
  const sourceEvents = [
    {
      id: "read-bound",
      seq: 1,
      spaceId: actor.spaceId,
      threadId: "thread",
      botId: "bot",
      runId: "run",
      type: "recruiting.read",
      createdAt: f.now,
      payload: {
        phase: "bound",
        taskId: "task",
        actionId: "action",
        effectId: "read",
        toolName: "get_rows",
      },
    },
    {
      id: "read-recorded",
      seq: 2,
      spaceId: actor.spaceId,
      threadId: "thread",
      botId: "bot",
      runId: "run",
      type: "recruiting.read",
      createdAt: f.now,
      payload: {
        phase: "recorded",
        taskId: "task",
        actionId: "action",
        effectId: "read",
        outputArtifact: { artifactId: artifact.id, sha256: f.hash },
      },
    },
  ];
  const runs = new Map([["run", f.run]]);
  const tx = {
    ...f.tx,
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    recruitingCandidate: {
      ...f.tx.recruitingCandidate,
      findUnique: vi.fn(async () => ({
        roleId: role.id,
        candidateKey: occurrence.candidateKey,
        shortlisted: false,
        revision: 0,
      })),
    },
    run: {
      findFirst: vi.fn(async ({ where }) => runs.get(where.id) ?? null),
      findUnique: vi.fn(async ({ where }) => runs.get(where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const run = runs.get(where.id);
        if (!run) throw new IsolationError();
        return run;
      }),
    },
    recruitingRole: {
      findFirst: vi.fn(async () => role),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.crmBindingEffectId !== role.crmBindingEffectId ||
          where.revision !== role.revision
        )
          return { count: 0 };
        Object.assign(role, data);
        return { count: 1 };
      }),
    },
    mcpServer: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "crm-server"
          ? { ...actor, id: "crm-server", revision: 2, enabled: true }
          : { ...actor, id: "server", revision: 1, enabled: true },
      ),
    },
    botMcpServer: {
      findFirst: vi.fn(async (_query: { where: { serverId: string } }) => ({
        allowAllTools: false,
        allowedTools: ["get_crm_role", "crm_import_candidate"],
      })),
    },
    externalEffect: {
      findMany: vi.fn(async ({ where }) =>
        [...effects.values()]
          .filter(
            (effect) =>
              effect.spaceId === where.spaceId &&
              effect.runId === where.runId &&
              (!where.status || effect.status === where.status),
          )
          .sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
          ),
      ),
      findFirst: vi.fn(async ({ where }) => {
        const effect = effects.get(where.id);
        return effect &&
          (!where.status || effect.status === where.status) &&
          (!where.spaceId || effect.spaceId === where.spaceId) &&
          (!where.runId || effect.runId === where.runId)
          ? effect
          : null;
      }),
      findUnique: vi.fn(async ({ where }) =>
        where.id
          ? (effects.get(where.id) ?? null)
          : ([...effects.values()].find(
              (effect) =>
                (effect as never as { idempotencyKey?: string }).idempotencyKey ===
                where.idempotencyKey,
            ) ?? null),
      ),
      create: vi.fn(async ({ data }) => {
        const effect = { ...data, id: `import-${effects.size}`, createdAt: new Date() };
        effects.set(effect.id, effect);
        return effect;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const effect = effects.get(where.id);
        if (!effect || (where.status && effect.status !== where.status)) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      }),
    },
    message: {
      ...f.tx.message,
      findUnique: vi.fn(async ({ where }) => {
        if (!where.id.startsWith("approval-card:")) return await f.tx.message.findUnique();
        const id = where.id.slice("approval-card:".length);
        return {
          id: where.id,
          threadId: "thread",
          runId: "run",
          botId: "bot",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              text: "Approve",
              approvalEffectId: id,
              status: "answered",
              answer: "allow",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        } as never;
      }),
    },
    event: {
      findMany: vi.fn(async () => sourceEvents),
      findFirst: vi.fn(async ({ where }) => {
        const id = where.payload.equals;
        const effect = effects.get(id);
        return effect && approvals.has(id)
          ? {
              createdAt: f.now,
              payload: {
                effectId: id,
                messageId: `approval-card:${id}`,
                askIndex: 0,
                answeredByUserId: actor.userId,
                answer: "allow",
                requestHash: createHash("sha256")
                  .update(stableJsonValue(effect.request))
                  .digest("hex"),
              },
            }
          : null;
      }),
    },
    artifact: { ...f.tx.artifact, findUnique: vi.fn(async () => artifact) },
    recruitingCandidatePage: {
      ...f.tx.recruitingCandidatePage,
      findUnique: vi.fn(async ({ where }) => (where.effectId === page.effectId ? page : null)),
    },
    recruitingCandidateOccurrence: {
      ...f.tx.recruitingCandidateOccurrence,
      findUnique: vi.fn(async ({ where }) =>
        where.pageId_rowIndex.pageId === page.effectId && where.pageId_rowIndex.rowIndex === 0
          ? occurrence
          : null,
      ),
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => [occurrence]),
    },
    recruitingCrmImport: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.bindingEffectId_pageId_rowIndex;
        const link = links.find((item) =>
          where.effectId
            ? item.effectId === where.effectId
            : item.bindingEffectId === key.bindingEffectId &&
              item.pageId === key.pageId &&
              item.rowIndex === key.rowIndex,
        );
        return link ? { ...link, effect: effects.get(link.effectId), occurrence } : null;
      }),
      create: vi.fn(async ({ data }) => {
        links.push(data);
        return data;
      }),
      findMany: vi.fn(async () =>
        links.map((link) => ({ ...link, effect: effects.get(link.effectId), occurrence })),
      ),
    },
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return {
    prisma,
    tx,
    target,
    bindingInput,
    binding,
    effects,
    approvals,
    role,
    page,
    occurrence,
    links,
    input,
    trusted,
    run: f.run,
    runs,
  };
}

describe("native reply email proof", () => {
  const route = {
    connectorId: "mcp" as const,
    resourceId: "mail-server",
    resourceRevision: 1,
    toolName: "reply_to_email" as const,
  };
  const input = { route, replyToEmailId: "inbound-email" };
  const readRoute = { ...route, toolName: "get_email" };
  const proofRequest = boundDirectApprovalRequest(
    readRoute,
    { id: input.replyToEmailId },
    "__rakazoCatalogTool",
  );
  function proofFixture() {
    const f = crmFixture();
    f.tx.mcpServer.findFirst.mockResolvedValue({
      ...actor,
      id: "mail-server",
      revision: 1,
      enabled: true,
    });
    f.tx.botMcpServer.findFirst.mockResolvedValue({
      allowAllTools: false,
      allowedTools: ["get_email", "reply_to_email"],
    });
    const effect = {
      ...f.binding,
      id: "email-read",
      kind: "mcp__mail__get_email",
      request: proofRequest as unknown,
      result: { content: [{ type: "text", text: '{"id":"inbound-email"}' }] } as unknown,
    };
    f.effects.set(effect.id, effect);
    return { ...f, effect };
  }
  it("reads the exact canonical direct native receipt without provider parsing or mutation", async () => {
    expect(recruiting.readNativeReplyEmailProof).toBeTypeOf("function");
    const f = proofFixture();
    await expect(
      recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
    ).resolves.toEqual({ effectId: f.effect.id, result: f.effect.result });
    expect(f.tx.externalEffect.findMany).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, runId: "run" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
    expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });
  it.each(["connectors_execute_tool", "mcp_execute_tool"])(
    "accepts canonical %s receipts and chooses the deterministic newest proof",
    async (tool) => {
      const f = proofFixture();
      const latest = {
        ...f.effect,
        id: "z-email-read",
        request: catalogApprovalRequest(
          tool,
          { id: "mail-server:get_email", arguments: { id: input.replyToEmailId } },
          "__rakazoCatalogTool",
          readRoute,
        ),
        result: { isError: false, content: [] },
      };
      f.effects.set(latest.id, latest);
      await expect(
        recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
      ).resolves.toEqual({ effectId: latest.id, result: latest.result });
    },
  );
  it.each(
    [
      { id: input.replyToEmailId },
      [
        "__rakazoCatalogTool",
        "mcp_execute_tool",
        { id: "mail-server:get_email", arguments: { id: input.replyToEmailId } },
      ],
      boundDirectApprovalRequest(
        { ...readRoute, resourceRevision: "1" },
        { id: input.replyToEmailId },
        "__rakazoCatalogTool",
      ),
      boundDirectApprovalRequest(
        readRoute,
        { id: input.replyToEmailId, modelResult: {} },
        "__rakazoCatalogTool",
      ),
      catalogApprovalRequest(
        "other_execute_tool",
        { id: "mail-server:get_email", arguments: { id: input.replyToEmailId } },
        "__rakazoCatalogTool",
        readRoute,
      ),
      catalogApprovalRequest(
        "mcp_execute_tool",
        { id: "different-server:get_email", arguments: { id: input.replyToEmailId } },
        "__rakazoCatalogTool",
        readRoute,
      ),
      [
        "__rakazoCatalogTool",
        "direct",
        { route: readRoute, args: { id: input.replyToEmailId }, extra: true },
      ],
    ].map((request) => ({ request })),
  )("does not admit noncanonical or unbound proof $request", async ({ request }) => {
    const f = proofFixture();
    f.effect.request = request;
    await expect(
      recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
    ).resolves.toBeNull();
  });
  it.each(["failed", "executing", "uncertain"])(
    "does not use an earlier success after the latest exact read is %s",
    async (status) => {
      const f = proofFixture();
      f.effects.set("newest", {
        ...f.effect,
        id: "newest",
        createdAt: new Date(f.effect.createdAt.getTime() + 1),
        status: status === "failed" ? "completed" : status,
        result: { isError: true, content: [] },
      });
      await expect(
        recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
      ).resolves.toBeNull();
    },
  );
  it.each(["missing", "other-email", "executing", "no-result"])(
    "returns no proof for %s",
    async (boundary) => {
      const f = proofFixture();
      if (boundary === "missing") f.effects.delete(f.effect.id);
      if (boundary === "other-email")
        f.effect.request = boundDirectApprovalRequest(
          readRoute,
          { id: "another-email" },
          "__rakazoCatalogTool",
        );
      if (boundary === "executing") f.effect.status = "executing";
      if (boundary === "no-result") f.effect.result = null;
      await expect(
        recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, input),
      ).resolves.toBeNull();
    },
  );
  it.each([
    "lease",
    "expired",
    "stopped",
    "foreign-actor",
    "foreign-run",
    "foreign-thread",
    "foreign-bot",
    "disabled-server",
    "server-revision",
    "assignment",
  ])("rejects the %s boundary before reading a proof", async (boundary) => {
    const f = proofFixture();
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "expired") Object.assign(f.run, { leaseExpiresAt: new Date(0) });
    if (boundary === "stopped") f.run.status = "cancelled";
    if (boundary === "foreign-run") f.run.userId = "other";
    if (boundary === "foreign-thread")
      f.tx.thread.findFirst.mockResolvedValue({
        ...actor,
        userId: "other",
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "role",
      });
    if (boundary === "foreign-bot")
      f.tx.bot.findFirst.mockResolvedValue({ ...actor, userId: "other" });
    if (boundary === "disabled-server")
      f.tx.mcpServer.findFirst.mockResolvedValue({
        ...actor,
        id: "mail-server",
        revision: 1,
        enabled: false,
      });
    if (boundary === "server-revision")
      f.tx.mcpServer.findFirst.mockResolvedValue({
        ...actor,
        id: "mail-server",
        revision: 2,
        enabled: true,
      });
    if (boundary === "assignment")
      f.tx.botMcpServer.findFirst.mockResolvedValue({
        allowAllTools: false,
        allowedTools: ["get_email"],
      });
    await expect(
      recruiting.readNativeReplyEmailProof(
        f.prisma,
        boundary === "foreign-actor" ? { ...actor, spaceId: "other" } : actor,
        f.trusted,
        input,
      ),
    ).rejects.toThrow(IsolationError);
    expect(f.tx.externalEffect.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, route: { ...route, connectorId: "foreign" } },
    { ...input, route: { ...route, resourceId: " " } },
    { ...input, route: { ...route, resourceRevision: 0 } },
    { ...input, route: { ...route, toolName: "get_email" } },
    { ...input, replyToEmailId: " " },
  ])("rejects invalid input %j", async (invalid) => {
    const f = proofFixture();
    await expect(
      recruiting.readNativeReplyEmailProof(f.prisma, actor, f.trusted, invalid as never),
    ).rejects.toThrow(IsolationError);
  });
});

async function replyFixture() {
  const f = crmFixture();
  const imported = (await recruiting.resolveRecruitingCrmImport(
    f.prisma,
    actor,
    f.trusted,
    f.input,
  ))!;
  const admission = await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
    effectKind: "crm-import",
    effectRequest: boundDirectApprovalRequest(imported.route, imported.args, "__rakazoCatalogTool"),
  });
  const receipt = {
    candidate_id: "40000000-0000-4000-8000-000000000004",
    source_id: "50000000-0000-4000-8000-000000000005",
    membership_id: "60000000-0000-4000-8000-000000000006",
    organization_id: f.target.organizationId,
    role_spec_id: f.target.crmRoleId,
    linkedin_identity: "/in/example",
    source_file: imported.args.p_source_file,
  };
  const importEffect = f.effects.get(admission.effect.id)!;
  Object.assign(importEffect, {
    status: "completed",
    result: { structuredContent: { data: receipt } },
  });
  const revision = await f.tx.recruitingRoleRevision.findFirst();
  Object.assign(revision, {
    sourceRefs: [
      {
        ...revision.sourceRefs[0],
        readState: "read",
        readAt: "2026-10-16T00:00:00Z",
        quote: "Search examples",
      },
    ],
    brief: {
      fields: [
        {
          key: "salary_range",
          value: "USD 100000 to 150000",
          state: "known",
          origin: "user_instruction",
          consequential: true,
          sourceRefIds: ["human"],
        },
        {
          key: "location",
          value: "Unrestricted",
          state: "known",
          origin: "user_instruction",
          consequential: true,
          sourceRefIds: ["human"],
        },
      ],
      searchFilters: [],
      questions: [],
      rules: [],
      confirmation: {
        revision: 1,
        userId: actor.userId,
        messageId: "human",
        confirmedAt: "2026-10-16T00:00:00Z",
      },
    },
  });
  const mailRoute = {
    connectorId: "mcp",
    resourceId: "mail-server",
    resourceRevision: 1,
    toolName: "reply_to_email",
  };
  const identity = {
    providerWorkspaceId: "workspace",
    account: "owner@example.test",
    threadId: "provider-thread",
    anchorId: "inbound-email",
    crmCandidateId: receipt.candidate_id,
  };
  const email = {
    ...f.binding,
    id: "email-read",
    kind: "get_email",
    request: boundDirectApprovalRequest(
      { ...mailRoute, toolName: "get_email" },
      { id: identity.anchorId },
      "__rakazoCatalogTool",
    ),
    result: { structuredContent: { id: identity.anchorId } } as unknown,
  };
  const crm = {
    ...email,
    id: "crm-context-read",
    request: boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: "crm-server",
        resourceRevision: 2,
        toolName: "get_crm_candidate_outreach_context",
      },
      { p_org: receipt.organization_id, p_candidate: receipt.candidate_id },
      "__rakazoCatalogTool",
    ),
    result: { structuredContent: { data: { candidate: { id: receipt.candidate_id } } } } as unknown,
  };
  f.effects.set(email.id, email);
  f.effects.set(crm.id, crm);
  const replyLinks: Array<{
    effectId: string;
    roleRevisionId: string;
    crmImportEffectId: string;
    emailReadEffectId: string;
    crmContextReadEffectId: string;
  }> = [];
  const tx = {
    ...f.tx,
    recruitingReply: {
      findUnique: vi.fn(async ({ where }) => {
        const link = replyLinks.find((item) => item.effectId === where.effectId);
        return link
          ? { ...link, effect: f.effects.get(link.effectId), roleRevision: revision }
          : null;
      }),
      findMany: vi.fn(async ({ where }) =>
        replyLinks
          .filter(
            (link) =>
              !where.crmImportEffectId || link.crmImportEffectId === where.crmImportEffectId,
          )
          .map((link) => ({
            ...link,
            effect: f.effects.get(link.effectId),
            roleRevision: revision,
          })),
      ),
      create: vi.fn(async ({ data }) => {
        replyLinks.push(data);
        return data;
      }),
    },
  };
  f.tx.mcpServer.findFirst.mockImplementation(async ({ where }) => ({
    ...actor,
    id: where.id,
    enabled: true,
    revision: where.id === "crm-server" ? 2 : 1,
    endpoint: "https://mcp.instantly.ai/mcp",
  }));
  f.tx.botMcpServer.findFirst.mockImplementation(async ({ where }) => ({
    allowAllTools: false,
    allowedTools:
      where.serverId === "crm-server"
        ? ["get_crm_candidate_outreach_context"]
        : ["get_email", "list_emails", "reply_to_email"],
  }));
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const input = {
    roleId: "role",
    expectedRoleRevision: 1,
    crmImportEffectId: importEffect.id,
    mcpServerId: "mail-server",
    serverRevision: 1,
    replyToEmailId: identity.anchorId,
  };
  const native = {
    effectKind: "mcp__mail__reply_to_email",
    effectRequest: boundDirectApprovalRequest(
      mailRoute,
      {
        reply_to_uuid: identity.anchorId,
        eaccount: identity.account,
        to: "candidate@example.test",
        subject: "Exact subject",
        body_text: "Exact body",
        skip_validation: false,
      },
      "__rakazoCatalogTool",
    ),
    identity,
    emailReadEffectId: email.id,
    crmContextReadEffectId: crm.id,
  };
  return {
    ...f,
    prisma,
    tx,
    input,
    native,
    revision,
    receipt,
    importEffect,
    email,
    crm,
    replyLinks,
  };
}

describe("durable recruiting reply linkage", () => {
  it("resolves actual CRM/source records and opaque native read receipts with read-only CRM permissions", async () => {
    expect(recruiting.resolveRecruitingReply).toBeTypeOf("function");
    const f = await replyFixture();
    const resolved = await recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input);
    expect(resolved).toMatchObject({
      input: f.input,
      target: f.target,
      crmImportReceipt: f.receipt,
      emailProof: { effectId: f.email.id, result: f.email.result },
      crmProof: { effectId: f.crm.id, result: f.crm.result },
      role: { id: "role", revision: 1 },
    });
    expect(resolved?.effect).toBeUndefined();
  });
  it.each([
    "role",
    "revision",
    "binding",
    "receipt",
    "source",
    "mail-assignment",
    "crm-assignment",
    "mail-revision",
    "lease",
    "email-proof",
    "crm-proof",
    "brief",
  ])("rejects the invalid %s context before admission", async (boundary) => {
    const f = await replyFixture();
    if (boundary === "role")
      f.tx.thread.findFirst.mockResolvedValue({
        ...actor,
        id: "thread",
        botId: "bot",
        activeRecruitingRoleId: "other",
      });
    if (boundary === "revision") f.input.expectedRoleRevision += 1;
    if (boundary === "binding") f.role.crmBindingEffectId = "other";
    if (boundary === "receipt") f.importEffect.result = { success: true };
    if (boundary === "source") f.occurrence.name = null;
    if (boundary === "mail-assignment" || boundary === "crm-assignment")
      f.tx.botMcpServer.findFirst.mockImplementation(async ({ where }) => ({
        allowAllTools: false,
        allowedTools:
          where.serverId === (boundary === "mail-assignment" ? "mail-server" : "crm-server")
            ? []
            : ["get_email", "list_emails", "reply_to_email", "get_crm_candidate_outreach_context"],
      }));
    if (boundary === "mail-revision") f.input.serverRevision = 2;
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "email-proof") f.email.status = "uncertain";
    if (boundary === "crm-proof") f.crm.status = "executing";
    if (boundary === "brief") Object.assign(f.revision, { brief: null });
    await expect(
      recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input),
    ).rejects.toThrow();
    expect(f.tx.recruitingReply.create).not.toHaveBeenCalled();
  });
  it("leaves provider endpoint translation to the adapter while validating owned assignments", async () => {
    const f = await replyFixture();
    f.tx.mcpServer.findFirst.mockImplementation(async ({ where }) => ({
      ...actor,
      id: where.id,
      enabled: true,
      revision: where.id === "crm-server" ? 2 : 1,
      endpoint: "https://other.example.test/mcp",
    }));
    const resolved = await recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input);
    expect(resolved?.route).toEqual({
      connectorId: "mcp",
      resourceId: "mail-server",
      resourceRevision: 1,
      toolName: "reply_to_email",
    });
    expect(f.tx.recruitingReply.create).not.toHaveBeenCalled();
  });
  it("reserves one native effect and thin link, restores original scope, and claims only the human-approved original request", async () => {
    expect(recruiting.admitRecruitingReply).toBeTypeOf("function");
    const f = await replyFixture();
    const first = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const second = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    expect(first.status).toBe("ready");
    expect(second.effect.id).toBe(first.effect.id);
    expect(f.replyLinks).toEqual([
      {
        effectId: first.effect.id,
        roleRevisionId: "revision",
        crmImportEffectId: f.importEffect.id,
        emailReadEffectId: f.email.id,
        crmContextReadEffectId: f.crm.id,
      },
    ]);
    const effect = f.effects.get(first.effect.id)!;
    const claim = { ...f.native, effectId: effect.id, from: "approved" as const };
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(false);
    effect.status = "approved";
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).rejects.toThrow(IsolationError);
    f.approvals.add(effect.id);
    expect(
      (
        await recruiting.resolveRecruitingReply(
          f.prisma,
          actor,
          { ...f.trusted, approvedEffectId: effect.id },
          { ...f.input, roleId: "changed", expectedRoleRevision: 99 },
        )
      )?.input,
    ).toEqual(f.input);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(true);
    expect(effect.status).toBe("executing");
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, claim),
    ).resolves.toBe(false);
  });
  it.each([
    "email-proof",
    "crm-proof",
    "candidate-identity",
    "anchor-identity",
    "route",
    "noncanonical",
  ])("rejects inconsistent frozen %s before creating a reply", async (boundary) => {
    const f = await replyFixture();
    const native: recruiting.RecruitingReplyNative = {
      ...f.native,
      identity: { ...f.native.identity },
    };
    if (boundary === "email-proof") native.emailReadEffectId = "other";
    if (boundary === "crm-proof") native.crmContextReadEffectId = "other";
    if (boundary === "candidate-identity") native.identity.crmCandidateId = "other";
    if (boundary === "anchor-identity") native.identity.anchorId = "other";
    if (boundary === "route")
      native.effectRequest = boundDirectApprovalRequest(
        {
          connectorId: "mcp",
          resourceId: "other",
          resourceRevision: 1,
          toolName: "reply_to_email",
        },
        {},
        "__rakazoCatalogTool",
      );
    if (boundary === "noncanonical") native.effectRequest = { body: "model reconstruction" };
    await expect(
      recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, native),
    ).rejects.toThrow();
    expect(f.replyLinks).toHaveLength(0);
  });
  it("keeps the first draft immutable and rejects stale binding or proof changes at claim", async () => {
    const f = await replyFixture();
    const admitted = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "approved";
    f.approvals.add(effect.id);
    await expect(
      recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectRequest: boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: "mail-server",
            resourceRevision: 1,
            toolName: "reply_to_email",
          },
          { changed: true },
          "__rakazoCatalogTool",
        ),
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        emailReadEffectId: "other",
        effectId: effect.id,
        from: "approved",
      }),
    ).rejects.toThrow(IsolationError);
    f.role.crmBindingEffectId = null;
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: effect.id,
        from: "approved",
      }),
    ).rejects.toThrow();
    expect(effect.status).toBe("approved");
  });
  it("rejects inconsistent stored role linkage rather than reusing a pending action", async () => {
    const f = await replyFixture();
    await recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, f.native);
    f.replyLinks[0]!.roleRevisionId = "other-revision";
    await expect(
      recruiting.admitRecruitingReply(f.prisma, actor, f.trusted, f.input, f.native),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
  });
  it("uses frozen retained proof IDs when later preflight reads exist", async () => {
    const f = await replyFixture();
    const admission = await recruiting.admitRecruitingReply(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const effect = f.effects.get(admission.effect.id)!;
    effect.status = "approved";
    f.approvals.add(effect.id);
    f.effects.set("later-email", {
      ...f.email,
      id: "later-email",
      status: "uncertain",
      createdAt: new Date(f.email.createdAt.getTime() + 1),
    });
    f.effects.set("later-crm", {
      ...f.crm,
      id: "later-crm",
      status: "completed",
      createdAt: new Date(f.crm.createdAt.getTime() + 1),
    });
    const resolved = await recruiting.resolveRecruitingReply(f.prisma, actor, f.trusted, f.input);
    expect(resolved?.emailProof.effectId).toBe(f.email.id);
    expect(resolved?.crmProof.effectId).toBe(f.crm.id);
    await expect(
      recruiting.claimRecruitingReply(f.prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: effect.id,
        from: "approved",
      }),
    ).resolves.toBe(true);
  });
  it("contends on one provider round even when another CRM identity maps to its email", async () => {
    const first = await replyFixture();
    const existing = await recruiting.admitRecruitingReply(
      first.prisma,
      actor,
      first.trusted,
      first.input,
      first.native,
    );
    const second = await replyFixture();
    second.receipt.candidate_id = "70000000-0000-4000-8000-000000000007";
    second.native.identity.crmCandidateId = second.receipt.candidate_id;
    second.crm.request = boundDirectApprovalRequest(
      {
        connectorId: "mcp",
        resourceId: "crm-server",
        resourceRevision: 2,
        toolName: "get_crm_candidate_outreach_context",
      },
      { p_org: second.receipt.organization_id, p_candidate: second.receipt.candidate_id },
      "__rakazoCatalogTool",
    );
    second.crm.result = {
      structuredContent: { data: { candidate: { id: second.receipt.candidate_id } } },
    };
    const next = {
      ...second.run,
      id: "next-run",
      status: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    second.runs.set(next.id, next);
    const email = { ...second.email, id: "next-email", runId: next.id };
    const crm = { ...second.crm, id: "next-crm", runId: next.id };
    second.effects.set(email.id, email);
    second.effects.set(crm.id, crm);
    second.effects.set(existing.effect.id, existing.effect as never);
    const stored = {
      ...first.replyLinks[0]!,
      effect: existing.effect,
      roleRevision: first.revision,
    };
    second.tx.recruitingReply.findUnique.mockResolvedValue(stored);
    const result = await recruiting.admitRecruitingReply(
      second.prisma,
      actor,
      { ...second.trusted, runId: next.id },
      second.input,
      { ...second.native, emailReadEffectId: email.id, crmContextReadEffectId: crm.id },
    );
    expect(result).toMatchObject({ status: "busy", effect: { id: existing.effect.id } });
    expect(second.replyLinks).toHaveLength(0);
  });
  it.each([
    ["intended", "running", "busy"],
    ["approved", "completed", "stopped"],
    ["executing", "running", "busy"],
    ["executing", "failed", "unknown"],
    ["uncertain", "failed", "unknown"],
    ["completed", "completed", "completed"],
    ["denied", "cancelled", "denied"],
  ])(
    "retains %s effect owned by a %s run as %s without transfer or another effect",
    async (status, ownerStatus, expected) => {
      const f = await replyFixture();
      const admitted = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        f.native,
      );
      const effect = f.effects.get(admitted.effect.id)!;
      Object.assign(effect, { status, result: { outcome: "retained-provider-result" } });
      f.run.status = ownerStatus;
      const next = {
        ...f.run,
        id: "next-run",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      f.runs.set(next.id, next);
      const got = await recruiting.admitRecruitingReply(
        f.prisma,
        actor,
        { ...f.trusted, runId: next.id },
        f.input,
        f.native,
      );
      expect(got.status).toBe(expected);
      expect(got.effect.id).toBe(effect.id);
      expect(got.effect.result).toEqual(effect.result);
      expect(effect.runId).toBe("run");
      expect(f.replyLinks).toHaveLength(1);
    },
  );
});

describe("native CRM binding and source import", () => {
  it("binds only from a retained role read and native human approval, then replays the immutable receipt", async () => {
    expect(recruiting.prepareRecruitingCrmBinding).toBeTypeOf("function");
    const f = crmFixture();
    f.role.crmBindingEffectId = null;
    f.binding.status = "executing";
    expect(
      await recruiting.prepareRecruitingCrmBinding(f.prisma, actor, f.trusted, f.bindingInput),
    ).toEqual({ target: f.target, roleTitle: "Native role" });
    f.approvals.clear();
    await expect(
      recruiting.executeRecruitingCrmBinding(
        f.prisma,
        actor,
        { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
        f.bindingInput,
      ),
    ).rejects.toThrow(IsolationError);
    f.approvals.add(f.binding.id);
    const saved = await recruiting.executeRecruitingCrmBinding(
      f.prisma,
      actor,
      { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
      f.bindingInput,
    );
    expect(f.role.crmBindingEffectId).toBe(f.binding.id);
    expect(f.binding.status).toBe("completed");
    f.role.crmBindingEffectId = "new-binding";
    expect(
      await recruiting.executeRecruitingCrmBinding(
        f.prisma,
        actor,
        { ...f.trusted, effectId: f.binding.id, effectRequest: f.bindingInput },
        f.bindingInput,
      ),
    ).toEqual(saved);
    expect(f.role.crmBindingEffectId).toBe("new-binding");
  });
  it("derives immutable professional args and reserves one native effect/source link", async () => {
    const f = crmFixture();
    const resolved = await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    );
    expect(resolved?.args).toEqual({
      p_org: f.target.organizationId,
      p_role: f.target.crmRoleId,
      p_name: "Example",
      p_linkedin_url: f.occurrence.linkedinUrl,
      p_title: "Engineer",
      p_company: "Example Company",
      p_location: "London",
      p_source_file: `rakazo:artifact:${f.page.artifactId}:sha256:${f.page.artifactHash}:row:0`,
    });
    const native = {
      effectKind: "mcp__crm__crm_import_candidate",
      effectRequest: boundDirectApprovalRequest(
        resolved!.route,
        resolved!.args,
        "__rakazoCatalogTool",
      ),
    };
    const first = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    const second = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    expect(second.effect.id).toBe(first.effect.id);
    expect(f.links).toHaveLength(1);
    expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
    const claim = { ...native, effectId: first.effect.id, from: "approved" as const };
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, {
        ...claim,
        from: "intended",
      }),
    ).rejects.toThrow(IsolationError);
    f.effects.get(first.effect.id)!.status = "approved";
    f.approvals.add(first.effect.id);
    const approved = await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      { ...f.trusted, approvedEffectId: first.effect.id },
      { ...f.input, candidateKey: "model-changed", rowIndex: 99 },
    );
    expect(approved?.input).toEqual(f.input);
    expect(
      (
        await recruiting.resolveRecruitingCrmImport(
          f.prisma,
          actor,
          { ...f.trusted, approvedEffectId: first.effect.id },
          null,
        )
      )?.input,
    ).toEqual(f.input);
    f.role.crmBindingEffectId = "new-binding";
    await expect(
      recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(f.effects.get(first.effect.id)!.status).toBe("approved");
    f.role.crmBindingEffectId = f.binding.id;
    expect(
      await recruiting.claimRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, claim),
    ).toBe(true);
  });
  it("derives historical source status from strict native receipts after rebinding", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      },
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.status = "completed";
    effect.result = { message: "Looks synced" };
    f.role.crmBindingEffectId = null;
    f.tx.botMcpServer.findFirst.mockResolvedValue({ allowAllTools: false, allowedTools: [] });
    expect(
      (await recruiting.resolveRecruitingCrmImport(f.prisma, actor, f.trusted, f.input))?.effect
        ?.id,
    ).toBe(effect.id);
    let sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.input.roleId,
      candidateKey: f.input.candidateKey,
    });
    expect(sources.items[0]?.crmImports[0]).toMatchObject({
      status: "unknown",
      receipt: null,
      target: f.target,
    });
    effect.result = {
      structuredContent: {
        data: {
          candidate_id: "40000000-0000-4000-8000-000000000004",
          source_id: "50000000-0000-4000-8000-000000000005",
          membership_id: "60000000-0000-4000-8000-000000000006",
          organization_id: f.target.organizationId,
          role_spec_id: f.target.crmRoleId,
          linkedin_identity: "/in/example",
          source_file: resolved.args.p_source_file,
        },
      },
    };
    sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: f.input.roleId,
      candidateKey: f.input.candidateKey,
    });
    expect(sources.items[0]?.crmImports[0]).toMatchObject({
      status: "synced",
      target: f.target,
      receipt: { source_file: resolved.args.p_source_file },
    });
  });
  it("projects the current target and pending membership from the native source-linked effect", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      {
        effectKind: "crm-import",
        effectRequest: boundDirectApprovalRequest(
          resolved.route,
          resolved.args,
          "__rakazoCatalogTool",
        ),
      },
    );
    const { page: _page, pageId: _pageId, rowIndex: _rowIndex, ...profile } = f.occurrence;
    f.tx.$queryRaw
      .mockResolvedValueOnce([
        {
          total: 1n,
          sourceRows: 1n,
          candidates: 1n,
          identifiedCandidates: 1n,
          unassessed: 1n,
          assessed: 0n,
          shortlisted: 0n,
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          ...profile,
          shortlisted: false,
          revision: 0,
          discoveryCount: 1,
          firstDiscoveredAt: "2026-10-16T00:00:00.000Z",
          lastDiscoveredAt: "2026-10-16T00:00:00.000Z",
          assessmentVersion: null,
          assessmentRoleRevisionId: null,
          assessmentCreatedAt: null,
          hardGate: null,
          sortValue: "example",
        },
      ] as never);
    const listed = await recruiting.listRecruitingCandidates(f.prisma, actor, {
      roleId: f.input.roleId,
    });
    expect(listed.crmTarget).toEqual({ bindingEffectId: f.binding.id, target: f.target });
    expect(listed.items[0]?.crm).toMatchObject({
      effectId: admitted.effect.id,
      status: "pending",
      receipt: null,
      target: f.target,
    });
  });
  it.each([new Date(0), null])(
    "projects an executing import as unknown when its running lease is %s",
    async (leaseExpiresAt) => {
      const f = crmFixture();
      const resolved = (await recruiting.resolveRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
      ))!;
      const admitted = await recruiting.admitRecruitingCrmImport(
        f.prisma,
        actor,
        f.trusted,
        f.input,
        {
          effectKind: "crm-import",
          effectRequest: boundDirectApprovalRequest(
            resolved.route,
            resolved.args,
            "__rakazoCatalogTool",
          ),
        },
      );
      const effect = f.effects.get(admitted.effect.id)!;
      effect.status = "executing";
      const input = { roleId: f.input.roleId, candidateKey: f.input.candidateKey };
      const live = await recruiting.listRecruitingCandidateSources(f.prisma, actor, input);
      expect(live.items[0]?.crmImports[0]?.status).toBe("syncing");
      Object.assign(f.run, { leaseExpiresAt });
      const interrupted = await recruiting.listRecruitingCandidateSources(f.prisma, actor, input);
      expect(interrupted.items[0]?.crmImports[0]).toMatchObject({
        status: "unknown",
        receipt: null,
      });
      expect(effect.status).toBe("executing");
      expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );
  it("keeps another live owner busy and terminal unclaimed owner stopped without transferring effects", async () => {
    const f = crmFixture();
    const resolved = (await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    ))!;
    const native = {
      effectKind: "crm-import",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    };
    const admitted = await recruiting.admitRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      native,
    );
    const effect = f.effects.get(admitted.effect.id)!;
    effect.runId = "another-run";
    const owner = { ...f.run, id: "another-run" };
    f.runs.set(owner.id, owner);
    expect(
      (await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, native))
        .status,
    ).toBe("busy");
    owner.status = "failed";
    f.role.crmBindingEffectId = "new-target";
    expect(
      (await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, native))
        .status,
    ).toBe("stopped");
    effect.status = "executing";
    expect(
      (await recruiting.admitRecruitingCrmImport(f.prisma, actor, f.trusted, f.input, native))
        .status,
    ).toBe("unknown");
    expect(effect.runId).toBe(owner.id);
    expect(f.links).toHaveLength(1);
    expect(f.tx.externalEffect.create).toHaveBeenCalledOnce();
  });
  it.each([
    "source",
    "candidate",
    "name",
    "assignment",
    "foreign",
    "lease",
    "binding",
    "retained-read",
  ])("rejects an invalid %s before reserving an import", async (boundary) => {
    const f = crmFixture();
    if (boundary === "source") f.input.rowIndex = 1;
    if (boundary === "candidate") f.input.candidateKey = "another-person";
    if (boundary === "name") f.occurrence.name = null;
    if (boundary === "lease") f.trusted.leaseFence += 1;
    if (boundary === "binding") f.role.crmBindingEffectId = "new-binding";
    if (boundary === "retained-read") f.effects.get("crm-read")!.status = "executing";
    if (boundary === "assignment")
      f.tx.botMcpServer.findFirst.mockResolvedValue({
        allowAllTools: false,
        allowedTools: ["get_crm_role"],
      });
    await expect(
      recruiting.resolveRecruitingCrmImport(
        f.prisma,
        boundary === "foreign" ? { ...actor, userId: "foreign" } : actor,
        f.trusted,
        f.input,
      ),
    ).rejects.toThrow();
    expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
  });
});

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

function nativeCandidateFixture() {
  const row = {
    name: "Example",
    linkedin_url: "https://www.linkedin.com/in/example",
    current_title: "Engineer",
    current_company: "Example Company",
    location: null,
    resume_url: null,
    evidence_urls: [],
  };
  const f = observationFixture([row, { ...row }, null]);
  Object.assign(f.run, {
    status: "running",
    leaseOwner: "worker",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const input = {
    operation: "save_results" as const,
    expectedRoleRevision: 1,
    mcpServerId: "server",
    providerTaskId: "provider-task",
    cursor: null,
  };
  const saveEffect = {
    ...f.effect,
    id: "save",
    kind: "recruiting_research",
    status: "executing",
    request: input,
    result: null,
  };
  const pages = new Map<string, unknown>();
  const snapshot = { request: f.effect.request, providerResult: f.effect.result };
  const bytes = Buffer.from(stableJsonValue(snapshot));
  const file = {
    name: "native-candidates.json",
    mimeType: "application/json",
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    storageKey: "native-source",
    clientNonce: "recruiting-observation:read",
  };
  const tx = {
    ...f.tx,
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    externalEffect: {
      findMany: vi.fn(async () => [f.effect]),
      findFirst: vi.fn(async ({ where }) => (where.id === "save" ? saveEffect : f.effect)),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(saveEffect, data);
        return { count: 1 };
      }),
    },
    event: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({
        id: "adoption",
        seq: 1,
        spaceId: actor.spaceId,
        threadId: "thread",
        botId: "bot",
        runId: "run",
        type: "recruiting.context.adopted",
        payload: {
          roleId: "role",
          roleRevisionId: "revision",
          contextArtifact: { artifactId: "context", sha256: f.hash },
        },
        createdAt: f.now,
      })),
    },
    recruitingCandidatePage: {
      findUnique: vi.fn(async ({ where }) => pages.get(where.effectId) ?? null),
      create: vi.fn(async ({ data }) => {
        pages.set(data.effectId, data);
        return data;
      }),
    },
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const trusted = {
    runId: "run",
    leaseOwner: "worker",
    leaseFence: 1,
    effectId: "save",
    effectRequest: input,
  };
  return { ...f, tx, prisma, input, trusted, saveEffect, file, row, snapshot };
}

async function nativeSourceFixture() {
  const f = crmFixture();
  const read = f.effects.get("read")!;
  const bytes = Buffer.from(
    stableJsonValue({ request: read.request, providerResult: read.result }),
  );
  const artifact = await f.tx.artifact.findUnique();
  Object.assign(artifact, {
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
  Object.assign(f.page, { taskId: null, actionId: null, artifactHash: artifact.hash });
  const event = {
    id: "native-saved",
    seq: 3,
    spaceId: actor.spaceId,
    threadId: "thread",
    runId: "run",
    botId: "bot",
    type: "recruiting.candidates.saved",
    createdAt: new Date(),
    payload: {
      roleId: "role",
      roleRevisionId: "revision",
      effectId: "read",
      mcpServerId: "server",
      serverRevision: 1,
      providerTaskId: "provider-task",
      requestCursor: null,
      outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
      candidateOutputSchema: "candidate_output_v1",
    },
  };
  f.tx.event.findMany.mockResolvedValue([event] as never);
  const thread = { ...(await f.tx.thread.findFirst()), bot: { ...actor } };
  const findEffects = f.tx.externalEffect.findMany.getMockImplementation()!;
  f.tx.externalEffect.findMany.mockImplementation(async (query) =>
    "include" in query
      ? ([
          {
            ...read,
            run: { ...f.run, thread },
            recruitingCandidatePage: { artifact },
          },
        ] as never)
      : findEffects(query),
  );
  return { ...f, artifact, event, read, thread };
}

describe("native candidate source provenance", () => {
  it("validates every native page in one snapshot proof batch, including duplicate-event rejection", async () => {
    const f = await nativeSourceFixture();
    const thread = await f.tx.thread.findFirst();
    const pages = Array.from({ length: 13 }, (_, index) => {
      const id = `read-${index}`;
      const request = structuredClone(f.read.request) as unknown[];
      (request[2] as { args: { cursor?: string } }).args.cursor = `cursor-${index}`;
      const effect = { ...f.read, id, request };
      const bytes = Buffer.from(stableJsonValue({ request, providerResult: effect.result }));
      const artifact = {
        ...f.artifact,
        id: `artifact-${index}`,
        clientNonce: `recruiting-observation:${id}`,
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
      };
      return {
        ...f.page,
        effectId: id,
        requestCursor: `cursor-${index}`,
        artifactId: artifact.id,
        artifactHash: artifact.hash,
        artifact,
        effect,
      };
    });
    const events = pages.map((page, index) => ({
      ...f.event,
      id: `event-${index}`,
      payload: {
        ...f.event.payload,
        effectId: page.effectId,
        requestCursor: page.requestCursor,
        outputArtifact: { artifactId: page.artifactId, sha256: page.artifactHash },
      },
    }));
    f.tx.externalEffect.findMany.mockImplementation(
      async () =>
        pages.map((page) => ({
          ...page.effect,
          run: { ...f.run, thread: { ...thread, bot: actor } },
          recruitingCandidatePage: { artifact: page.artifact },
        })) as never,
    );
    f.tx.event.findMany.mockImplementation(async (...args: unknown[]) => {
      const where = (args[0] as { where: { payload?: { equals: string } } }).where;
      return (
        where.payload
          ? events.filter((event) => event.payload.effectId === where.payload!.equals)
          : events
      ) as never;
    });
    f.tx.externalEffect.findFirst.mockImplementation(
      async ({ where }) =>
        (pages.find((page) => page.effectId === where.id)?.effect ?? null) as never,
    );
    f.tx.artifact.findUnique.mockImplementation(async (...args: unknown[]) => {
      const { where } = args[0] as { where: { id: string } };
      return (pages.find((page) => page.artifactId === where.id)?.artifact ?? null) as never;
    });
    const tx = {
      ...f.tx,
      recruitingResearchTask: { findMany: vi.fn(async () => []) },
      recruitingCandidatePage: { findMany: vi.fn(async () => pages) },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
    f.tx.thread.findFirst.mockClear();
    const result = await recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" });
    expect(result.observations.map((page) => page.effectId)).toEqual(
      pages.map((page) => page.effectId),
    );
    expect(f.tx.externalEffect.findMany).toHaveBeenCalledTimes(1);
    expect(f.tx.event.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        spaceId: actor.spaceId,
        type: "recruiting.candidates.saved",
        OR: pages.map((page) => ({ payload: { path: ["effectId"], equals: page.effectId } })),
      },
    });
    expect(f.tx.run.findFirst).not.toHaveBeenCalled();
    expect(f.tx.thread.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    events.push({ ...events.at(-1)!, id: "duplicate-other-thread", threadId: "other-thread" });
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
  });

  it("lists native saved research history without creating domain tasks", async () => {
    const f = await nativeSourceFixture();
    const tx = {
      ...f.tx,
      recruitingResearchTask: { findMany: vi.fn(async () => []) },
      recruitingCandidatePage: {
        ...f.tx.recruitingCandidatePage,
        findMany: vi.fn(async () => [{ ...f.page, effect: f.read }]),
      },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
    const result = await recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" });
    expect(result).toEqual({
      tasks: [],
      actions: [],
      observations: [
        {
          effectId: "read",
          providerTaskId: "provider-task",
          roleRevisionId: "revision",
          runId: "run",
          rowCount: 1,
          observedAt: f.page.observedAt.toISOString(),
          requestCursor: null,
          artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
        },
      ],
    });
    expect(tx.recruitingCandidatePage.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", taskId: null, actionId: null },
      orderBy: [{ observedAt: "asc" }, { effectId: "asc" }],
      include: { effect: { select: { runId: true, request: true } } },
    });
    f.artifact.hash = "f".repeat(64);
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
    tx.recruitingCandidatePage.findMany.mockClear();
    await expect(
      recruiting.listRecruitingResearch(prisma, { ...actor, userId: "other" }, { roleId: "role" }),
    ).rejects.toThrow(IsolationError);
    expect(tx.recruitingCandidatePage.findMany).not.toHaveBeenCalled();
  });
  it("serves the native artifact and keeps unassessed sources readable after a role revision", async () => {
    const f = await nativeSourceFixture();
    f.role.currentRevisionId = "later-revision";
    f.role.revision = 2;
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items[0]).toMatchObject({
      providerTaskId: "provider-task",
      taskId: null,
      actionId: null,
      effectId: "read",
      roleRevisionId: "revision",
      artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
    });
    expect(f.tx.recruitingCandidateOccurrence.findMany).toHaveBeenCalledWith({
      where: { roleId: "role", candidateKey: f.occurrence.candidateKey },
      orderBy: [{ page: { observedAt: "desc" } }, { pageId: "desc" }, { rowIndex: "desc" }],
      take: 26,
      include: { page: { include: { effect: { select: { request: true } } } } },
    });
    expect(f.tx.recruitingResearchAction.findFirst).not.toHaveBeenCalled();
  });
  it.each(["valid", "foreign-actor", "artifact-hash"])(
    "binds the bounded candidate page to its validated latest source at the %s boundary",
    async (boundary) => {
      const f = await nativeSourceFixture();
      f.role.crmBindingEffectId = null;
      const { page: _page, pageId, rowIndex, ...profile } = f.occurrence;
      const row = {
        ...profile,
        sourcePageId: pageId,
        sourceRowIndex: rowIndex,
        shortlisted: false,
        revision: 0,
        discoveryCount: 1,
        firstDiscoveredAt: f.page.observedAt.toISOString(),
        lastDiscoveredAt: f.page.observedAt.toISOString(),
        assessmentVersion: null,
        assessmentRoleRevisionId: null,
        assessmentCreatedAt: null,
        hardGate: null,
        sortValue: "example",
      };
      f.tx.$queryRaw
        .mockResolvedValueOnce([
          {
            total: 1n,
            sourceRows: 1n,
            candidates: 1n,
            identifiedCandidates: 1n,
            unassessed: 1n,
            assessed: 0n,
            shortlisted: 0n,
          },
        ] as never)
        .mockResolvedValueOnce([row] as never);
      const findMany = vi.fn(async () => [{ ...f.page, effect: f.read }]);
      const tx = {
        ...f.tx,
        recruitingCandidatePage: { ...f.tx.recruitingCandidatePage, findMany },
      };
      const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
      if (boundary === "artifact-hash") f.artifact.hash = "f".repeat(64);
      const result = recruiting.listRecruitingCandidates(
        prisma,
        boundary === "foreign-actor" ? { ...actor, userId: "other" } : actor,
        { roleId: "role", limit: 1 },
      );
      if (boundary !== "valid") {
        await expect(result).rejects.toThrow(IsolationError);
        if (boundary === "foreign-actor") expect(findMany).not.toHaveBeenCalled();
        return;
      }
      expect((await result).items[0]?.latestSource).toMatchObject({
        effectId: pageId,
        rowIndex,
        taskId: null,
        actionId: null,
        roleRevisionId: "revision",
        artifactRef: { artifactId: f.artifact.id, sha256: f.artifact.hash },
      });
      expect(findMany).toHaveBeenCalledExactlyOnceWith({
        where: { roleId: "role", effectId: { in: [pageId] } },
        include: { effect: { select: { request: true } } },
      });
      const [statement] = f.tx.$queryRaw.mock.lastCall as unknown as [{ sql: string }];
      expect(statement.sql).toContain(
        'p."pageId" AS "sourcePageId", p."rowIndex" AS "sourceRowIndex"',
      );
    },
  );
  it("keeps the exact provider task separate from historical custom task/action links", async () => {
    const f = crmFixture();
    const sources = await recruiting.listRecruitingCandidateSources(f.prisma, actor, {
      roleId: "role",
      candidateKey: f.occurrence.candidateKey,
    });
    expect(sources.items[0]).toMatchObject({
      providerTaskId: "provider-task",
      taskId: "task",
      actionId: "action",
    });
  });
  it.each([{ userId: "other" }, { spaceId: "other" }])(
    "rejects an actor mismatch before reading source metadata: %j",
    async (mismatch) => {
      const f = await nativeSourceFixture();
      await expect(
        recruiting.listRecruitingCandidateSources(
          f.prisma,
          { ...actor, ...mismatch },
          {
            roleId: "role",
            candidateKey: f.occurrence.candidateKey,
          },
        ),
      ).rejects.toThrow(IsolationError);
      expect(f.tx.recruitingCandidateOccurrence.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    "artifact-hash",
    "artifact-size",
    "artifact-id",
    "run-owner",
    "run-empty-owner",
    "run-bot-owner",
    "thread-owner",
    "thread-empty-owner",
    "thread-bot-owner",
    "thread-bot-empty-owner",
    "source-role",
    "event-role",
    "event-owner",
    "route",
    "schema",
    "missing-event",
    "duplicate-event",
  ])("rejects a native source with invalid %s", async (boundary) => {
    const f = await nativeSourceFixture();
    if (boundary === "artifact-hash") f.artifact.hash = "f".repeat(64);
    if (boundary === "artifact-size") Object.assign(f.artifact, { size: 0 });
    if (boundary === "artifact-id") f.artifact.id = "other-artifact";
    if (boundary === "run-owner") f.run.userId = "other";
    if (boundary === "run-empty-owner") f.run.userId = "";
    if (boundary === "run-bot-owner") f.run.bot = { ...actor, userId: "other" };
    if (boundary === "thread-owner") f.thread.userId = "other";
    if (boundary === "thread-empty-owner") f.thread.userId = "";
    if (boundary === "thread-bot-owner") f.thread.bot.userId = "other";
    if (boundary === "thread-bot-empty-owner") f.thread.bot.userId = "";
    if (boundary === "source-role") f.page.roleId = "other-role";
    if (boundary === "event-role") f.event.payload.roleId = "other-role";
    if (boundary === "event-owner") f.event.runId = "other-run";
    if (boundary === "route") f.event.payload.providerTaskId = "other-task";
    if (boundary === "schema") f.event.payload.candidateOutputSchema = "unknown";
    if (boundary === "missing-event") f.tx.event.findMany.mockResolvedValue([]);
    if (boundary === "duplicate-event")
      f.tx.event.findMany.mockResolvedValue([f.event, { ...f.event, id: "duplicate" }] as never);
    await expect(
      recruiting.listRecruitingCandidateSources(f.prisma, actor, {
        roleId: "role",
        candidateKey: f.occurrence.candidateKey,
      }),
    ).rejects.toThrow();
  });
  it.each(["group", "external-conversation", "external-bot"])(
    "preserves scoped native %s thread parents",
    async (boundary) => {
      const f = await nativeSourceFixture();
      f.role.crmBindingEffectId = null;
      const parent = { ...actor };
      const bot = { ...actor };
      Object.assign(f.thread, {
        botId: null,
        groupId: boundary === "group" ? "group" : null,
        group: parent,
        externalConversationId: boundary === "group" ? null : "conversation",
        externalConversation: { ...parent, bot },
      });
      const input = { roleId: "role", candidateKey: f.occurrence.candidateKey };
      expect(
        (await recruiting.listRecruitingCandidateSources(f.prisma, actor, input)).items,
      ).toHaveLength(1);
      if (boundary === "group") parent.userId = "other";
      if (boundary === "external-conversation")
        Object.assign(f.thread, { externalConversation: { ...parent, userId: "other", bot } });
      if (boundary === "external-bot") bot.userId = "other";
      await expect(
        recruiting.listRecruitingCandidateSources(f.prisma, actor, input),
      ).rejects.toThrow(IsolationError);
    },
  );
  it("keeps the existing CRM identity and target guards for a native discovery", async () => {
    const f = await nativeSourceFixture();
    const prepared = await recruiting.resolveRecruitingCrmImport(
      f.prisma,
      actor,
      f.trusted,
      f.input,
    );
    expect(prepared?.args).toMatchObject({
      p_name: "Example",
      p_linkedin_url: f.occurrence.linkedinUrl,
    });
    expect(f.tx.externalEffect.create).not.toHaveBeenCalled();
    f.occurrence.name = null;
    await expect(
      recruiting.resolveRecruitingCrmImport(f.prisma, actor, f.trusted, f.input),
    ).rejects.toThrow();
  });
});

describe("native candidate results without domain actions", () => {
  it("derives the connection from the completed native receipt when saving without an internal ID", async () => {
    const f = nativeCandidateFixture();
    const { mcpServerId: _, ...input } = f.input;
    Object.assign(f.saveEffect, { request: input });
    const result = await recruiting.saveNativeRecruitingCandidatePage(
      f.prisma,
      actor,
      { ...f.trusted, effectRequest: input },
      input,
      { sourceEffectId: "read", rows: [f.row], outputArtifact: f.file },
    );
    expect(result).toMatchObject({ status: "saved", sourceEffectId: "read" });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        type: "recruiting.candidates.saved",
        payload: expect.objectContaining({ mcpServerId: "server" }),
      }),
    );
  });

  it("selects only an owned completed get_rows page on the exact native task and cursor", async () => {
    const f = nativeCandidateFixture();
    const result = await recruiting.readNativeRecruitingCandidatePage(
      f.prisma,
      actor,
      "run",
      f.input,
    );
    expect(result.effect.id).toBe("read");
    expect(result.snapshot).toEqual(f.snapshot);
    expect(f.tx.recruitingResearchAction.findFirst).not.toHaveBeenCalled();
    expect(f.tx.recruitingResearchTask.findUnique).not.toHaveBeenCalled();
    expect(f.tx.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { lte: f.effect.createdAt } }),
      }),
    );
    for (const input of [
      { ...f.input, providerTaskId: "other-task" },
      { ...f.input, mcpServerId: "other-server" },
      { ...f.input, cursor: "another-page" },
    ]) {
      await expect(
        recruiting.readNativeRecruitingCandidatePage(f.prisma, actor, "run", input),
      ).rejects.toThrow();
    }
  });

  it("indexes native candidates and completes its save receipt atomically without fake tasks", async () => {
    const f = nativeCandidateFixture();
    const result = await recruiting.saveNativeRecruitingCandidatePage(
      f.prisma,
      actor,
      f.trusted,
      f.input,
      { sourceEffectId: "read", rows: [f.row, { ...f.row }, null], outputArtifact: f.file },
    );
    expect(result).toMatchObject({
      status: "saved",
      roleId: "role",
      roleRevisionId: "revision",
      sourceEffectId: "read",
      candidateRows: [
        { rowIndex: 0, candidateKey: "linkedin:/in/example" },
        { rowIndex: 1, candidateKey: "linkedin:/in/example" },
        { rowIndex: 2, candidateKey: "source-row:read:2" },
      ],
    });
    expect(f.tx.recruitingCandidatePage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: null,
        actionId: null,
        roleId: "role",
        effectId: "read",
        rowCount: 3,
        observedAt: f.effect.updatedAt,
        artifactHash: f.file.hash,
      }),
    });
    expect(f.tx.recruitingCandidate.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: "role", candidateKey: "linkedin:/in/example" },
        { roleId: "role", candidateKey: "source-row:read:2" },
      ],
      skipDuplicates: true,
    });
    expect(f.saveEffect).toMatchObject({ status: "completed", result });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        type: "recruiting.candidates.saved",
        payload: expect.objectContaining({
          candidateOutputSchema: "candidate_output_v1",
          providerTaskId: "provider-task",
          outputArtifact: { artifactId: "observation-artifact", sha256: f.file.hash },
        }),
      }),
    );
    expect(f.tx.recruitingResearchAction.update).not.toHaveBeenCalled();
  });

  it.each(["foreign-run", "wrong-hash", "expired-lease", "stale-role", "changed-receipt"])(
    "rejects %s without candidate writes",
    async (failure) => {
      const f = nativeCandidateFixture();
      if (failure === "foreign-run") f.effect.runId = "other-run";
      if (failure === "wrong-hash") f.file.hash = "f".repeat(64);
      if (failure === "expired-lease") Object.assign(f.run, { leaseExpiresAt: new Date(0) });
      if (failure === "stale-role") f.input.expectedRoleRevision = 2;
      if (failure === "changed-receipt")
        f.saveEffect.request = { ...f.input, providerTaskId: "other" };
      await expect(
        recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
          sourceEffectId: "read",
          rows: [f.row],
          outputArtifact: f.file,
        }),
      ).rejects.toThrow();
      expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
    },
  );

  it("replays a completed save after a role revision without recreating projections", async () => {
    const f = nativeCandidateFixture();
    const saved = {
      status: "saved",
      roleId: "role",
      roleRevisionId: "revision",
      sourceEffectId: "read",
      outputArtifact: { artifactId: "observation-artifact", sha256: f.file.hash },
      candidateRows: [{ rowIndex: 0, candidateKey: "linkedin:/in/example" }],
    };
    Object.assign(f.saveEffect, { status: "completed", result: saved });
    f.input.expectedRoleRevision = 1;
    f.tx.recruitingRole.findFirst.mockResolvedValue({ ...f.role, revision: 2 } as never);
    expect(
      await recruiting.saveNativeRecruitingCandidatePage(f.prisma, actor, f.trusted, f.input, {
        sourceEffectId: "read",
        rows: [f.row],
        outputArtifact: f.file,
      }),
    ).toEqual(saved);
    expect(f.tx.recruitingCandidatePage.create).not.toHaveBeenCalled();
  });
});
