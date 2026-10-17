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
    expect(page.crmTarget).toBeNull();
    expect(page.items[0]?.crm).toBeNull();
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
