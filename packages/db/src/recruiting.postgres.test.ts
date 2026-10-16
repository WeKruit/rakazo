import type { Actor, CreateRecruitingRoleInput, RecruitingSourceRef } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import * as recruiting from "./index.js";
import { IsolationError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("recruiting domain (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `recruiting-owner-${suffix}`;
  const otherUserId = `recruiting-other-${suffix}`;
  const organizationId = `recruiting-org-${suffix}`;
  const spaceId = `recruiting-space-${suffix}`;
  const otherSpaceId = `recruiting-other-space-${suffix}`;
  const actor: Actor = { userId, spaceId, email: "owner@example.test", isDeploymentOwner: false };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let threadId: string;
  let otherThreadId: string;
  let wrongSpaceThreadId: string;
  let wrongGroupThreadId: string;
  let messageId: string;
  let otherMessageId: string;
  let botId: string;
  let runId: string;
  let wrongRunId: string;
  let artifactId: string;
  let otherArtifactId: string;
  let unrelatedArtifactId: string;
  let wrongChatArtifactId: string;
  const hash = "a".repeat(64);
  let firstRoleId: string;
  let firstRevisionId: string;
  const source = (id = messageId): RecruitingSourceRef => ({
    id: `source-${id}`,
    kind: "original_material",
    anchor: { kind: "message", messageId: id, locator: "text:0" },
    readState: "read",
    readAt: "2026-10-15T00:00:00.000Z",
  });
  const roleInput = (sourceRef = source()): CreateRecruitingRoleInput => ({
    sourceThreadId: threadId,
    expectedRevision: 0,
    title: "Software engineer",
    sourceRefs: [sourceRef],
    preferences: [],
    definitionQuestions: [],
    criteria: [
      {
        id: "experience",
        priority: "hard",
        expression: { kind: "atom", id: "years", statement: "At least seven years" },
        sourceRefs: [sourceRef],
        definitionQuestions: [],
      },
    ],
  });
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.createMany({
      data: [
        { id: userId, name: "Owner", email: `${userId}@example.test` },
        { id: otherUserId, name: "Other", email: `${otherUserId}@example.test` },
      ],
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.createMany({
      data: [
        { id: spaceId, organizationId, name: "Space" },
        { id: otherSpaceId, organizationId, name: "Other" },
      ],
    });
    const bot = await prisma.bot.create({ data: { spaceId, userId, name: "Main", color: "blue" } });
    botId = bot.id;
    const otherBot = await prisma.bot.create({
      data: { spaceId, userId: otherUserId, name: "Other", color: "blue" },
    });
    const wrongSpaceBot = await prisma.bot.create({
      data: { spaceId: otherSpaceId, userId, name: "Other space", color: "blue" },
    });
    threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    otherThreadId = (
      await prisma.thread.create({ data: { spaceId, userId: otherUserId, botId: otherBot.id } })
    ).id;
    wrongSpaceThreadId = (
      await prisma.thread.create({
        data: { spaceId: otherSpaceId, userId, botId: wrongSpaceBot.id },
      })
    ).id;
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId: otherUserId, name: "Other group" },
    });
    wrongGroupThreadId = (
      await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } })
    ).id;
    messageId = (
      await prisma.message.create({
        data: {
          threadId,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "At least seven years" }],
        },
      })
    ).id;
    otherMessageId = (
      await prisma.message.create({
        data: {
          threadId: otherThreadId,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Private unrelated source" }],
        },
      })
    ).id;
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Synthetic", status: "running" },
    });
    runId = (
      await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      })
    ).id;
    wrongRunId = (
      await prisma.run.create({
        data: {
          spaceId,
          userId: otherUserId,
          botId: otherBot.id,
          threadId: otherThreadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      })
    ).id;
    const artifact = {
      name: "Source",
      mimeType: "text/plain",
      hash,
      storageKey: `test-${suffix}`,
      size: 1,
    };
    artifactId = (
      await prisma.artifact.create({ data: { ...artifact, spaceId, userId, botId, runId } })
    ).id;
    wrongChatArtifactId = (
      await prisma.artifact.create({ data: { ...artifact, spaceId, userId, botId: otherBot.id } })
    ).id;
    otherArtifactId = (
      await prisma.artifact.create({
        data: { ...artifact, spaceId, userId: otherUserId, botId: otherBot.id },
      })
    ).id;
    unrelatedArtifactId = (
      await prisma.artifact.create({
        data: { ...artifact, spaceId: otherSpaceId, userId, botId: wrongSpaceBot.id },
      })
    ).id;
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });
  it("creates an independent identity, revision one and thread binding atomically", async () => {
    expect(recruiting.createRecruitingRole).toBeTypeOf("function");
    const first = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    firstRoleId = first.role.id;
    firstRevisionId = first.revision.id;
    expect(first.role).toMatchObject({ revision: 1, currentRevisionId: first.revision.id });
    expect(first.revision.sourceRefs).toEqual([source()]);
    expect(await recruiting.getRecruitingWorkspace(prisma, actor, { threadId })).toEqual(first);
    const second = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    expect(second.role.id).not.toBe(firstRoleId);
    expect(await recruiting.getRecruitingWorkspace(prisma, actor, { threadId })).toEqual(second);
    expect(
      await recruiting.bindRecruitingRole(prisma, actor, { threadId, roleId: firstRoleId }),
    ).toEqual(first);
  });
  it("CAS appends one immutable revision and changes the current pointer together", async () => {
    const { sourceThreadId: _, ...input } = roleInput();
    const settled = await Promise.allSettled([
      recruiting.reviseRecruitingRole(prisma, actor, {
        ...input,
        roleId: firstRoleId,
        expectedRevision: 1,
        title: "Revision A",
      }),
      recruiting.reviseRecruitingRole(prisma, actor, {
        ...input,
        roleId: firstRoleId,
        expectedRevision: 1,
        title: "Revision B",
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      recruiting.RecruitingConflictError,
    );
    const workspace = await recruiting.getRecruitingWorkspace(prisma, actor, { threadId });
    expect(workspace?.role.revision).toBe(2);
    expect(workspace?.revision.id).toBe(workspace?.role.currentRevisionId);
    expect(await prisma.recruitingRoleRevision.count({ where: { roleId: firstRoleId } })).toBe(2);
    await expect(
      prisma.recruitingRoleRevision.update({
        where: { id: firstRevisionId },
        data: { preferences: ["Changed"] },
      }),
    ).rejects.toThrow();
  });
  it("rejects owner, space, native thread/group and source message boundaries without writing", async () => {
    const { sourceThreadId: _, ...revision } = roleInput();
    const before = await prisma.recruitingRole.count({ where: { spaceId } });
    for (const foreignActor of [
      { ...actor, userId: otherUserId },
      { ...actor, spaceId: otherSpaceId },
    ]) {
      await expect(
        recruiting.listRecruitingAssessments(prisma, foreignActor, { roleId: firstRoleId }),
      ).rejects.toThrow(IsolationError);
      await expect(
        recruiting.reviseRecruitingRole(prisma, foreignActor, {
          ...revision,
          roleId: firstRoleId,
          expectedRevision: 2,
        }),
      ).rejects.toThrow("Resource not found");
      await expect(
        recruiting.listRecruitingResearch(prisma, foreignActor, { roleId: firstRoleId }),
      ).rejects.toThrow("Resource not found");
    }
    for (const id of [otherThreadId, wrongSpaceThreadId, wrongGroupThreadId]) {
      await expect(
        recruiting.createRecruitingRole(prisma, actor, { ...roleInput(), sourceThreadId: id }),
      ).rejects.toThrow("Resource not found");
      await expect(
        recruiting.bindRecruitingRole(prisma, actor, { threadId: id, roleId: firstRoleId }),
      ).rejects.toThrow("Resource not found");
      await expect(
        recruiting.getRecruitingWorkspace(prisma, actor, { threadId: id }),
      ).rejects.toThrow("Resource not found");
    }
    await expect(
      recruiting.createRecruitingRole(prisma, actor, roleInput(source(otherMessageId))),
    ).rejects.toThrow("Resource not found");
    expect(await prisma.recruitingRole.count({ where: { spaceId } })).toBe(before);
  });
  it("checks exact Artifact owner, space, chat association and hash before persisting references", async () => {
    const artifactSource = (id: string, sha256 = hash): RecruitingSourceRef => ({
      ...source(),
      anchor: { kind: "artifact", artifact: { artifactId: id, sha256 }, locator: "line:1" },
    });
    for (const ref of [
      artifactSource(otherArtifactId),
      artifactSource(unrelatedArtifactId),
      artifactSource(wrongChatArtifactId),
      artifactSource(artifactId, "b".repeat(64)),
    ]) {
      await expect(recruiting.createRecruitingRole(prisma, actor, roleInput(ref))).rejects.toThrow(
        "Resource not found",
      );
    }
    const created = await recruiting.createRecruitingRole(
      prisma,
      actor,
      roleInput(artifactSource(artifactId)),
    );
    expect(created.revision.sourceRefs[0]?.anchor.kind).toBe("artifact");
    await recruiting.bindRecruitingRole(prisma, actor, { threadId, roleId: firstRoleId });
  });
  it("assessment CAS retains full snapshots and computes staleness from the actual role pointer", async () => {
    const role = (await recruiting.getRecruitingWorkspace(prisma, actor, { threadId }))!;
    const input = {
      roleId: firstRoleId,
      roleRevisionId: role.revision.id,
      candidateKey: "source-row-1",
      expectedRevision: 0,
      facts: [],
      judgments: [
        {
          criterionId: "experience",
          verdict: "unknown" as const,
          factIds: [],
          evidence: [],
          missing: ["Employment history"],
        },
      ],
      questions: ["Employment history"],
      sourceRefs: [source()],
    };
    const context = { runId, threadId };
    const first = await recruiting.saveRecruitingAssessment(prisma, actor, context, input);
    expect(first.isCurrent).toBe(true);
    const settled = await Promise.allSettled([
      recruiting.saveRecruitingAssessment(prisma, actor, context, {
        ...input,
        expectedRevision: 1,
      }),
      recruiting.saveRecruitingAssessment(prisma, actor, context, {
        ...input,
        expectedRevision: 1,
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await recruiting.getRecruitingAssessment(prisma, actor, {
          roleId: firstRoleId,
          candidateKey: "source-row-1",
        })
      )?.assessment.version,
    ).toBe(2);
    const { sourceThreadId: _, ...definition } = roleInput();
    await recruiting.reviseRecruitingRole(prisma, actor, {
      ...definition,
      roleId: firstRoleId,
      expectedRevision: 2,
    });
    expect(
      (await recruiting.listRecruitingAssessments(prisma, actor, { roleId: firstRoleId }))[0]
        ?.isCurrent,
    ).toBe(false);
    expect(
      (
        await recruiting.getRecruitingAssessment(prisma, actor, {
          roleId: firstRoleId,
          candidateKey: "source-row-1",
          version: 1,
        })
      )?.assessment,
    ).toEqual(first.assessment);
    await expect(
      prisma.recruitingAssessment.update({
        where: {
          roleId_candidateKey_version: {
            roleId: firstRoleId,
            candidateKey: "source-row-1",
            version: 1,
          },
        },
        data: { questions: ["Modified"] },
      }),
    ).rejects.toThrow();
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        { runId: wrongRunId, threadId },
        { ...input, expectedRevision: 2 },
      ),
    ).rejects.toThrow("Resource not found");
    const otherRole = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    await recruiting.bindRecruitingRole(prisma, actor, { threadId, roleId: firstRoleId });
    await expect(
      recruiting.saveRecruitingAssessment(prisma, actor, context, {
        ...input,
        roleRevisionId: otherRole.revision.id,
        expectedRevision: 2,
      }),
    ).rejects.toThrow("Resource not found");
  });
  it("restores research through the owning role and validates action run/message/artifact links", async () => {
    const role = await recruiting.bindRecruitingRole(prisma, actor, {
      threadId,
      roleId: firstRoleId,
    });
    const server = await prisma.mcpServer.create({
      data: { spaceId, userId, slug: `synthetic-${suffix}`, name: "Synthetic", transport: "http" },
    });
    const task = await prisma.recruitingResearchTask.create({
      data: {
        roleId: firstRoleId,
        mcpServerId: server.id,
        serverRevision: 1,
        state: "unknown",
        createdByRunId: runId,
      },
    });
    const action = await prisma.recruitingResearchAction.create({
      data: {
        taskId: task.id,
        roleRevisionId: role!.revision.id,
        runId,
        sourceMessageId: messageId,
        clientNonce: `nonce-${suffix}`,
        kind: "create",
        requestArtifactId: artifactId,
        requestArtifactHash: hash,
        contextArtifactId: artifactId,
        contextArtifactHash: hash,
        outputArtifacts: [],
      },
    });
    const research = await recruiting.listRecruitingResearch(prisma, actor, {
      roleId: firstRoleId,
    });
    expect(research.tasks[0]).toMatchObject({
      id: task.id,
      providerTaskId: null,
      state: "unknown",
    });
    expect(research.actions[0]).toMatchObject({
      id: action.id,
      requestArtifact: { artifactId, sha256: hash },
      deliveryState: "prepared",
    });
    await prisma.recruitingResearchAction.update({
      where: { id: action.id },
      data: { requestArtifactHash: "b".repeat(64) },
    });
    await expect(
      recruiting.listRecruitingResearch(prisma, actor, { roleId: firstRoleId }),
    ).rejects.toThrow("Resource not found");
    // The native relation itself rejects a missing referenced exact Artifact version.
    await expect(
      prisma.recruitingResearchAction.update({
        where: { id: action.id },
        data: { requestArtifactId: "missing-artifact" },
      }),
    ).rejects.toThrow();
    await prisma.recruitingResearchAction.delete({ where: { id: action.id } });
    await prisma.recruitingResearchTask.delete({ where: { id: task.id } });
    await prisma.mcpServer.delete({ where: { id: server.id } });
    expect(await recruiting.listRecruitingResearch(prisma, actor, { roleId: firstRoleId })).toEqual(
      { tasks: [], actions: [] },
    );
  });
  it("retains authorized historical sources and creator runs after a secondary thread changes role", async () => {
    const current = (await recruiting.bindRecruitingRole(prisma, actor, {
      threadId,
      roleId: firstRoleId,
    }))!;
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Owned secondary" },
    });
    const secondary = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    await recruiting.bindRecruitingRole(prisma, actor, {
      threadId: secondary.id,
      roleId: firstRoleId,
    });
    const message = await prisma.message.create({
      data: {
        threadId: secondary.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "Additional material" }],
      },
    });
    const definition = roleInput(source(message.id));
    const { sourceThreadId: _, ...revision } = definition;
    const updated = await recruiting.reviseRecruitingRole(prisma, actor, {
      ...revision,
      roleId: firstRoleId,
      expectedRevision: current.role.revision,
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: secondary.id,
        prompt: "Secondary",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: secondary.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        initialRecruitingRoleRevisionId: updated.revision.id,
      },
    });
    const assessmentInput = {
      roleId: firstRoleId,
      roleRevisionId: updated.revision.id,
      candidateKey: "secondary-row",
      expectedRevision: 0,
      facts: [],
      judgments: [
        {
          criterionId: "experience",
          verdict: "unknown" as const,
          factIds: [],
          evidence: [],
          missing: ["History"],
        },
      ],
      questions: [],
      sourceRefs: [source(message.id)],
    };
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      { runId: run.id, threadId: secondary.id },
      assessmentInput,
    );
    const independent = await recruiting.createRecruitingRole(prisma, actor, {
      ...definition,
      sourceThreadId: secondary.id,
    });
    expect(independent.role.id).not.toBe(firstRoleId);
    expect(
      (await recruiting.getRecruitingWorkspace(prisma, actor, { threadId }))?.revision,
    ).toEqual(updated.revision);
    expect(
      await recruiting.getRecruitingAssessment(prisma, actor, {
        roleId: firstRoleId,
        candidateKey: "secondary-row",
      }),
    ).toEqual(saved);
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        { runId: run.id, threadId: secondary.id },
        { ...assessmentInput, expectedRevision: 1 },
      ),
    ).rejects.toThrow(IsolationError);
  });
  it("resolves a run Artifact by its actual external conversation even when the bot has a normal chat", async () => {
    expect(await prisma.thread.findUnique({ where: { botId } })).toMatchObject({ id: threadId });
    const conversation = await prisma.externalConversation.create({
      data: {
        provider: "synthetic",
        workspaceId: "synthetic",
        externalKey: `external-${suffix}`,
        conversationId: `conversation-${suffix}`,
        spaceId,
        userId,
        botId,
      },
    });
    const externalThread = await prisma.thread.create({
      data: { spaceId, userId, externalConversationId: conversation.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: externalThread.id,
        prompt: "External material",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: externalThread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        spaceId,
        userId,
        botId,
        runId: run.id,
        name: "External source",
        mimeType: "text/plain",
        hash,
        size: 1,
        storageKey: `external-${suffix}`,
      },
    });
    const artifactSource: RecruitingSourceRef = {
      ...source(),
      anchor: {
        kind: "artifact",
        artifact: { artifactId: artifact.id, sha256: hash },
        locator: "line:1",
      },
    };
    const created = await recruiting.createRecruitingRole(prisma, actor, {
      ...roleInput(artifactSource),
      sourceThreadId: externalThread.id,
    });
    expect(
      await recruiting.getRecruitingWorkspace(prisma, actor, { threadId: externalThread.id }),
    ).toEqual(created);
    const reused = await recruiting.createRecruitingRole(prisma, actor, roleInput(artifactSource));
    expect(reused.revision.sourceRefs).toEqual([artifactSource]);
    const mismatchedBucket = await prisma.artifact.create({
      data: {
        spaceId,
        userId,
        botId: null,
        runId: run.id,
        groupId: (
          await prisma.chatGroup.create({
            data: { spaceId, userId, name: "Unrelated owned group" },
          })
        ).id,
        name: "Mismatched group",
        mimeType: "text/plain",
        hash,
        size: 1,
        storageKey: `mismatch-${suffix}`,
      },
    });
    await expect(
      recruiting.createRecruitingRole(
        prisma,
        actor,
        roleInput({
          ...artifactSource,
          anchor: {
            kind: "artifact",
            artifact: { artifactId: mismatchedBucket.id, sha256: hash },
            locator: "line:1",
          },
        }),
      ),
    ).rejects.toThrow(IsolationError);
  });
});
