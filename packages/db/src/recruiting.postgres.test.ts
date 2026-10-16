import { createHash } from "node:crypto";
import type {
  Actor,
  CreateRecruitingRoleInput,
  MessageBlock,
  NativeAskAnswerPayload,
  RecruitingAssessmentSourceRef,
  RecruitingRoleToolInput,
  RecruitingSourceRef,
  SaveRecruitingAssessmentInput,
} from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb, Prisma as PrismaSql } from "./client.js";
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
  const assessmentSource = (
    id = messageId,
    quote = "At least seven years",
  ): RecruitingAssessmentSourceRef => ({
    ...source(id),
    quote,
    selection: { kind: "message_text", blockIndex: 0, start: 0, end: quote.length },
  });
  const assessmentInput = (
    roleId: string,
    roleRevisionId: string,
    candidateKey: string,
  ): SaveRecruitingAssessmentInput => ({
    roleId,
    roleRevisionId,
    candidateKey,
    expectedRevision: 0,
    facts: [],
    sourceRefs: [assessmentSource()],
    questions: ["Employment history"],
    atomJudgments: [
      {
        atomId: "years",
        verdict: "unknown",
        factIds: [],
        evidence: [],
        missing: ["Employment history"],
      },
    ],
    employmentEvaluations: [],
  });
  async function assessmentAdmission(
    input: SaveRecruitingAssessmentInput,
    scope = { runId, threadId },
  ) {
    const run = await prisma.run.update({
      where: { id: scope.runId },
      data: {
        status: "running",
        leaseOwner: "assessment-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const role = await prisma.recruitingRole.findUniqueOrThrow({ where: { id: input.roleId } });
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        actor: { spaceId, userId },
        runId: run.id,
        threadId: scope.threadId,
        botId: run.botId,
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        roleRevision: role.revision,
      }),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const adopted = await recruiting.recordRecruitingContextAdoption(prisma, actor, {
      runId: run.id,
      threadId: scope.threadId,
      botId: run.botId,
      roleId: role.id,
      roleRevisionId: role.currentRevisionId,
      artifact: {
        name: "assessment-context.json",
        mimeType: "application/json",
        size: bytes.length,
        hash,
        storageKey: `test-context-${run.id}-${hash}`,
        clientNonce: `assessment-context:${run.id}:${hash}`,
      },
    });
    const effectRequest = { operation: "save", ...input };
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "recruiting_assess",
        idempotencyKey: `assessment:${suffix}:${crypto.randomUUID()}`,
        status: "executing",
        request: effectRequest as Prisma.InputJsonValue,
      },
    });
    return {
      context: {
        runId: run.id,
        threadId: scope.threadId,
        botId: run.botId,
        leaseOwner: "assessment-worker",
        leaseFence: 1,
        contextArtifact: { artifactId: adopted.artifact.id, sha256: hash },
        effectId: effect.id,
        effectRequest,
      },
      artifacts: [{ artifactId: adopted.artifact.id, bytes }],
    };
  }
  async function assessmentFixture(text = "Candidate personally implemented geometry transforms") {
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Assessment fixture", members: { create: { botId } } },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const message = await prisma.message.create({
      data: { threadId: thread.id, seq: 0, role: "user", blocks: [{ kind: "text", text }] },
    });
    const role = await recruiting.createRecruitingRole(prisma, actor, {
      ...roleInput(source(message.id)),
      sourceThreadId: thread.id,
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: thread.id,
        prompt: "Assess supplied material",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        sourceMessageId: message.id,
      },
    });
    const src = assessmentSource(message.id, text);
    const input: SaveRecruitingAssessmentInput = {
      ...assessmentInput(role.role.id, role.revision.id, "candidate"),
      sourceRefs: [src],
      questions: [],
      facts: [{ kind: "statement", id: "personal-work", statement: text, sourceRefIds: [src.id] }],
      atomJudgments: [
        {
          atomId: "years",
          verdict: "met",
          factIds: ["personal-work"],
          evidence: [src.id],
          missing: [],
        },
      ],
    };
    return {
      group,
      thread,
      message,
      role,
      run,
      input,
      ...(await assessmentAdmission(input, { runId: run.id, threadId: thread.id })),
    };
  }
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
    const input = assessmentInput(firstRoleId, role.revision.id, "source-row-1");
    const admission = await assessmentAdmission(input);
    const first = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      input,
      admission.artifacts,
    );
    expect(first.isCurrent).toBe(true);
    expect(first.assessment.judgments).toMatchObject({
      hardGate: "unknown",
      criteria: [{ criterionId: "experience", verdict: "unknown" }],
    });
    const next = { ...input, expectedRevision: 1 };
    const a = await assessmentAdmission(next);
    const b = await assessmentAdmission(next);
    const secondPool = createDb(databaseUrl!);
    const settled = await Promise.allSettled([
      recruiting.saveRecruitingAssessment(prisma, actor, a.context, next, a.artifacts),
      recruiting.saveRecruitingAssessment(secondPool.prisma, actor, b.context, next, b.artifacts),
    ]);
    await secondPool.prisma.$disconnect();
    await secondPool.pool.end();
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
        { ...admission.context, runId: wrongRunId },
        { ...input, expectedRevision: 2 },
        admission.artifacts,
      ),
    ).rejects.toThrow("Resource not found");
    const otherRole = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    await recruiting.bindRecruitingRole(prisma, actor, { threadId, roleId: firstRoleId });
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        admission.context,
        {
          ...input,
          roleRevisionId: otherRole.revision.id,
          expectedRevision: 2,
        },
        admission.artifacts,
      ),
    ).rejects.toThrow();
  });
  it("persists the server-computed composite gate and non-overlapping employment calculation", async () => {
    const text =
      "I personally implemented 3D coordinate transforms. I was a full-time software engineer from 2018-01-01 to 2026-01-01; this is my complete history through 2026-01-01.";
    const f = await assessmentFixture(text);
    const day = (year: number) => ({ precision: "day" as const, year, month: 1, day: 1 });
    const definition = roleInput(source(f.message.id));
    const { sourceThreadId: _sourceThreadId, ...revision } = definition;
    const role = await recruiting.reviseRecruitingRole(prisma, actor, {
      ...revision,
      roleId: f.role.role.id,
      expectedRevision: 1,
      criteria: [
        {
          ...definition.criteria[0]!,
          expression: {
            kind: "all",
            items: [
              {
                kind: "atom",
                id: "personal-geometry",
                statement: "Personally implemented 3D coordinate transforms",
              },
              {
                kind: "atom",
                id: "years",
                statement: "At least seven years of qualifying full-time engineering",
                employmentRule: {
                  minimumMonths: 84,
                  countingRule: "complete_calendar_months",
                  qualificationDefinition: "Full-time software engineering",
                  cutoff: { kind: "fixed", date: day(2026) },
                },
              },
            ],
          },
        },
      ],
    });
    const ref = f.input.sourceRefs[0]!;
    const input: SaveRecruitingAssessmentInput = {
      ...f.input,
      roleRevisionId: role.revision.id,
      facts: [
        {
          kind: "statement",
          id: "geometry",
          statement: "Personally implemented coordinate transforms",
          sourceRefIds: [ref.id],
        },
        {
          kind: "employment",
          id: "employment",
          statement: "Qualifying full-time engineering",
          sourceRefIds: [ref.id],
          start: day(2018),
          end: day(2026),
          employmentType: "full-time",
        },
        {
          kind: "history_completeness",
          id: "complete",
          statement: "Complete employment history",
          sourceRefIds: [ref.id],
          complete: true,
          asOf: day(2026),
        },
      ],
      atomJudgments: [
        {
          atomId: "personal-geometry",
          verdict: "met",
          factIds: ["geometry"],
          evidence: [ref.id],
          missing: [],
        },
      ],
      employmentEvaluations: [
        {
          atomId: "years",
          intervals: [
            { factId: "employment", qualifyingFullTime: "met", evidence: [ref.id], missing: [] },
          ],
          historyCompletenessFactId: "complete",
          evidence: [ref.id],
          missing: [],
        },
      ],
    };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admitted.context,
      input,
      admitted.artifacts,
    );
    expect(saved.assessment.judgments).toMatchObject({
      hardGate: "met",
      criteria: [{ criterionId: "experience", verdict: "met" }],
      employment: [
        {
          atomId: "years",
          lowerMonths: 96,
          upperMonths: 96,
          verdict: "met",
          minimumMonths: 84,
          cutoff: day(2026),
        },
      ],
    });
    expect(saved.assessment.facts).toEqual(input.facts);
  });
  it("authenticates exact human text selections and preserves whitespace and emoji", async () => {
    const text = "prefix 👩🏽‍💻 exact text  ";
    const f = await assessmentFixture(text);
    const quote = "👩🏽‍💻 exact text  ";
    const src: RecruitingAssessmentSourceRef = {
      ...f.input.sourceRefs[0]!,
      kind: "candidate_statement",
      quote,
      selection: { kind: "message_text", blockIndex: 0, start: 7, end: text.length },
    };
    const input = { ...f.input, sourceRefs: [src] };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admitted.context,
      input,
      admitted.artifacts,
    );
    expect(saved.assessment.sourceRefs[0]).toEqual(src);
    expect(saved.assessment.judgments.hardGate).toBe("met");
    expect(
      await prisma.event.count({ where: { runId: f.run.id, type: "recruiting.assessment.saved" } }),
    ).toBe(1);
  });
  it.each(["quote", "block", "surrogate", "foreign", "deleted", "assistant", "transcript"])(
    "rejects unauthenticated message evidence: %s",
    async (boundary) => {
      const f = await assessmentFixture("A😀B");
      let src = f.input.sourceRefs[0]!;
      if (boundary === "quote") src = { ...src, quote: "Invented candidate work" };
      if (boundary === "block")
        src = { ...src, selection: { kind: "message_text", blockIndex: 1, start: 0, end: 4 } };
      if (boundary === "surrogate")
        src = {
          ...src,
          quote: "😀",
          selection: { kind: "message_text", blockIndex: 0, start: 1, end: 2 },
        };
      if (boundary === "foreign")
        src = { ...src, anchor: { kind: "message", messageId: otherMessageId, locator: "text:0" } };
      if (boundary === "assistant")
        await prisma.message.update({
          where: { id: f.message.id },
          data: { role: "bot", botId, runId: f.run.id },
        });
      if (boundary === "transcript") {
        const conversation = await prisma.externalConversation.create({
          data: {
            spaceId,
            userId,
            botId,
            provider: "synthetic",
            workspaceId: "test",
            externalKey: `assessment-${f.run.id}`,
            conversationId: `assessment-${f.run.id}`,
          },
        });
        await prisma.externalMessage.create({
          data: {
            externalConversationId: conversation.id,
            providerEventId: "source",
            threadMessageId: f.message.id,
            content: "A😀B",
            senderId: "synthetic",
            senderName: "Synthetic",
          },
        });
      }
      const input = { ...f.input, sourceRefs: [src] };
      const admission = await assessmentAdmission(input, {
        runId: f.run.id,
        threadId: f.thread.id,
      });
      if (boundary === "deleted") await prisma.message.delete({ where: { id: f.message.id } });
      await expect(
        recruiting.saveRecruitingAssessment(
          prisma,
          actor,
          admission.context,
          input,
          admission.artifacts,
        ),
      ).rejects.toThrow();
      expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(
        0,
      );
      expect(
        (
          await prisma.externalEffect.findUniqueOrThrow({
            where: { id: admission.context.effectId },
          })
        ).status,
      ).toBe("executing");
    },
  );
  it.each([
    "owner",
    "fence",
    "expired",
    "cancelled",
    "adoption",
    "revision",
    "active-role",
    "effect-request",
    "effect-run",
  ])("fences a live assessment against %s changes", async (boundary) => {
    const f = await assessmentFixture();
    if (boundary === "owner") f.context.leaseOwner = "old-worker";
    if (boundary === "fence") f.context.leaseFence = 0;
    if (boundary === "expired")
      await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
    if (boundary === "cancelled")
      await prisma.run.update({
        where: { id: f.run.id },
        data: { status: "cancelled", leaseOwner: null },
      });
    if (boundary === "adoption") {
      await prisma.event.create({
        data: {
          spaceId,
          threadId: f.thread.id,
          botId,
          runId: f.run.id,
          seq: 2,
          type: "recruiting.context.adopted",
          payload: {
            roleId: f.role.role.id,
            roleRevisionId: f.role.revision.id,
            contextArtifact: { artifactId, sha256: hash },
          },
        },
      });
    }
    if (boundary === "revision") {
      const { sourceThreadId: _, ...definition } = roleInput(source(f.message.id));
      await recruiting.reviseRecruitingRole(prisma, actor, {
        ...definition,
        roleId: f.role.role.id,
        expectedRevision: 1,
      });
    }
    if (boundary === "active-role")
      await recruiting.bindRecruitingRole(prisma, actor, { threadId: f.thread.id, roleId: null });
    if (boundary === "effect-request")
      await prisma.externalEffect.update({
        where: { id: f.context.effectId },
        data: { request: { operation: "read" } },
      });
    if (boundary === "effect-run")
      await prisma.externalEffect.update({ where: { id: f.context.effectId }, data: { runId } });
    await expect(
      recruiting.saveRecruitingAssessment(prisma, actor, f.context, f.input, f.artifacts),
    ).rejects.toThrow();
    expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(0);
  });
  it.each(["text", "json"])("selects exact native %s Artifact content", async (format) => {
    const f = await assessmentFixture();
    const quote = "Candidate 😀 implemented transforms";
    const bytes = Buffer.from(
      format === "json"
        ? JSON.stringify({ rows: [{ detail: quote }], decoy: "Other" })
        : `prefix ${quote}`,
    );
    const materialHash = createHash("sha256").update(bytes).digest("hex");
    const material = await prisma.artifact.create({
      data: {
        spaceId,
        userId,
        botId,
        groupId: f.group.id,
        name: `material.${format}`,
        mimeType: format === "json" ? "application/json" : "text/plain",
        hash: materialHash,
        size: bytes.length,
        storageKey: `material-${f.run.id}`,
      },
    });
    const src: RecruitingAssessmentSourceRef = {
      ...f.input.sourceRefs[0]!,
      anchor: {
        kind: "artifact",
        artifact: { artifactId: material.id, sha256: materialHash },
        locator: "exact field",
      },
      quote,
      selection:
        format === "json"
          ? {
              kind: "artifact_json_string",
              path: ["rows", 0, "detail"],
              start: 0,
              end: quote.length,
            }
          : { kind: "artifact_text", start: 7, end: 7 + quote.length },
    };
    const input = { ...f.input, sourceRefs: [src] };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const artifacts = [...admitted.artifacts, { artifactId: material.id, bytes }];
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admitted.context,
      input,
      artifacts,
    );
    expect(saved.assessment.sourceRefs[0]).toEqual(src);
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        { ...admitted.context, contextArtifact: undefined },
        input,
        [{ artifactId: material.id, bytes: Buffer.from("changed") }],
      ),
    ).rejects.toThrow();
    expect(
      (
        await recruiting.saveRecruitingAssessment(
          prisma,
          actor,
          { ...admitted.context, contextArtifact: undefined },
          input,
          [{ artifactId: material.id, bytes }],
        )
      ).assessment,
    ).toEqual(saved.assessment);
  });
  it.each([
    "hash",
    "bytes",
    "quote",
    "json-path",
    "prototype",
    "array-key",
    "raw-json",
    "foreign",
    "deleted",
    "assistant",
    "provider-label",
  ])("rejects unverified Artifact evidence: %s", async (boundary) => {
    const f = await assessmentFixture();
    const quote = "Actual primary text";
    const bytes = Buffer.from(JSON.stringify({ rows: [{ detail: quote }], decoy: "Invented" }));
    const materialHash = createHash("sha256").update(bytes).digest("hex");
    const material = await prisma.artifact.create({
      data: {
        spaceId,
        userId,
        botId,
        groupId: f.group.id,
        name: "material.json",
        mimeType: "application/json",
        hash: materialHash,
        size: bytes.length,
        storageKey: `bad-material-${f.run.id}`,
        ...(boundary === "assistant" ? { runId: f.run.id } : {}),
      },
    });
    let src: RecruitingAssessmentSourceRef = {
      ...f.input.sourceRefs[0]!,
      anchor: {
        kind: "artifact",
        artifact: { artifactId: material.id, sha256: materialHash },
        locator: "rows[0].detail",
      },
      quote,
      selection: {
        kind: "artifact_json_string",
        path: ["rows", 0, "detail"],
        start: 0,
        end: quote.length,
      },
    };
    if (boundary === "hash")
      src = {
        ...src,
        anchor: {
          kind: "artifact",
          artifact: { artifactId: material.id, sha256: hash },
          locator: "field",
        },
      };
    if (boundary === "quote") src = { ...src, quote: "Invented" };
    if (boundary === "json-path")
      src = {
        ...src,
        selection: { kind: "artifact_json_string", path: ["decoy"], start: 0, end: quote.length },
      };
    if (boundary === "prototype")
      src = {
        ...src,
        selection: {
          kind: "artifact_json_string",
          path: ["__proto__", "detail"],
          start: 0,
          end: quote.length,
        },
      };
    if (boundary === "array-key")
      src = {
        ...src,
        selection: {
          kind: "artifact_json_string",
          path: ["rows", "0", "detail"],
          start: 0,
          end: quote.length,
        },
      };
    if (boundary === "raw-json")
      src = {
        ...src,
        selection: {
          kind: "artifact_text",
          start: bytes.toString().indexOf(quote),
          end: bytes.toString().indexOf(quote) + quote.length,
        },
      };
    if (boundary === "foreign")
      src = {
        ...src,
        anchor: {
          kind: "artifact",
          artifact: { artifactId: otherArtifactId, sha256: hash },
          locator: "text",
        },
      };
    if (boundary === "provider-label") src = { ...src, kind: "provider_report" };
    const input = { ...f.input, sourceRefs: [src] };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    if (boundary === "deleted") await prisma.artifact.delete({ where: { id: material.id } });
    await expect(
      recruiting.saveRecruitingAssessment(prisma, actor, admitted.context, input, [
        ...admitted.artifacts,
        { artifactId: material.id, bytes: boundary === "bytes" ? Buffer.from("corrupt") : bytes },
      ]),
    ).rejects.toThrow();
    expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(0);
  });
  it("retains unread gaps but refuses to use them for a nonunknown atom", async () => {
    const f = await assessmentFixture();
    const { quote: _quote, selection: _selection, ...ref } = f.input.sourceRefs[0]!;
    const unread = { ...ref, readState: "unread" as const, readAt: null };
    const invalid = { ...f.input, sourceRefs: [unread], candidateKey: "unread-primary" };
    const rejected = await assessmentAdmission(invalid, { runId: f.run.id, threadId: f.thread.id });
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        rejected.context,
        invalid,
        rejected.artifacts,
      ),
    ).rejects.toThrow();
    const input = {
      ...invalid,
      candidateKey: "unread-gap",
      atomJudgments: [
        {
          ...invalid.atomJudgments[0]!,
          verdict: "unknown" as const,
          evidence: [],
          missing: ["Read the supplied material"],
        },
      ],
    };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admitted.context,
      input,
      admitted.artifacts,
    );
    expect(saved.assessment.sourceRefs).toEqual([unread]);
    expect(saved.assessment.judgments.hardGate).toBe("unknown");
  });
  it("keeps provider snapshots as reports even when their label is spoofed", async () => {
    const f = await assessmentFixture();
    const text = "Provider claims sufficient experience";
    const bytes = Buffer.from(JSON.stringify({ text }));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const material = await prisma.artifact.create({
      data: {
        spaceId,
        userId,
        botId,
        groupId: f.group.id,
        runId: f.run.id,
        name: "provider.json",
        mimeType: "application/json",
        size: bytes.length,
        hash,
        storageKey: `provider-${f.run.id}`,
      },
    });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        name: "Synthetic research",
        slug: `provider-${f.run.id}`,
        transport: "http",
        endpoint: "https://example.test/mcp",
      },
    });
    const task = await prisma.recruitingResearchTask.create({
      data: {
        roleId: f.role.role.id,
        mcpServerId: server.id,
        serverRevision: 1,
        createdByRunId: f.run.id,
      },
    });
    await prisma.recruitingResearchAction.create({
      data: {
        taskId: task.id,
        roleRevisionId: f.role.revision.id,
        runId: f.run.id,
        sourceMessageId: f.message.id,
        clientNonce: `provider-${f.run.id}`,
        kind: "create",
        requestArtifactId: material.id,
        requestArtifactHash: hash,
        contextArtifactId: f.context.contextArtifact!.artifactId,
        contextArtifactHash: f.context.contextArtifact!.sha256,
        outputArtifacts: [{ artifactId: material.id, sha256: hash }],
      },
    });
    const src: RecruitingAssessmentSourceRef = {
      ...f.input.sourceRefs[0]!,
      quote: text,
      anchor: {
        kind: "artifact",
        artifact: { artifactId: material.id, sha256: hash },
        locator: "text",
      },
      selection: { kind: "artifact_json_string", path: ["text"], start: 0, end: text.length },
    };
    for (const kind of ["original_material", "provider_report"] as const) {
      const input = { ...f.input, candidateKey: kind, sourceRefs: [{ ...src, kind }] };
      const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
      await expect(
        recruiting.saveRecruitingAssessment(prisma, actor, admitted.context, input, [
          ...admitted.artifacts,
          { artifactId: material.id, bytes },
        ]),
      ).rejects.toThrow();
    }
    const input = {
      ...f.input,
      candidateKey: "provider-gap",
      sourceRefs: [{ ...src, kind: "provider_report" as const }],
      atomJudgments: [
        {
          ...f.input.atomJudgments[0]!,
          verdict: "unknown" as const,
          missing: ["Original evidence"],
        },
      ],
    };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admitted.context,
      input,
      [...admitted.artifacts, { artifactId: material.id, bytes }],
    );
    expect(saved.assessment.facts).toEqual(f.input.facts);
    expect(saved.assessment.sourceRefs[0]?.kind).toBe("provider_report");
    expect(saved.assessment.judgments.hardGate).toBe("unknown");
  });
  it("uses a native web reader receipt as primary material and preserves its first read time", async () => {
    const f = await assessmentFixture();
    const text = "Candidate personally implemented coordinate transforms 😀";
    const url = "https://example.test/profile";
    const readAt = "2026-10-16T00:00:00.000Z";
    const bytes = Buffer.from(JSON.stringify({ text, title: "Profile", url, truncated: false }));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const metadata = {
      name: "web-material.json",
      mimeType: "application/json",
      size: bytes.length,
      hash,
      storageKey: `web-${f.run.id}`,
      clientNonce: `native-web:${f.run.id}:${hash}`,
    };
    const input = { artifact: metadata, reader: "web_fetch" as const, url, readAt };
    const retained = await recruiting.recordRecruitingWebMaterial(prisma, actor, f.context, input);
    const repeated = await recruiting.recordRecruitingWebMaterial(prisma, actor, f.context, {
      ...input,
      readAt: "2026-10-16T01:00:00.000Z",
      artifact: { ...metadata, storageKey: "second-blob" },
    });
    expect(repeated.created).toBe(false);
    expect(repeated.event).toEqual(retained.event);
    expect((retained.event.payload as { readAt: string }).readAt).toBe(readAt);
    const src: RecruitingAssessmentSourceRef = {
      ...f.input.sourceRefs[0]!,
      url,
      readAt,
      quote: text,
      anchor: {
        kind: "artifact",
        artifact: { artifactId: retained.artifact.id, sha256: hash },
        locator: "text",
      },
      selection: { kind: "artifact_json_string", path: ["text"], start: 0, end: text.length },
    };
    const candidate = { ...f.input, sourceRefs: [src] };
    for (const kind of ["candidate_statement", "recruiter_verified"] as const) {
      const spoofed = { ...candidate, candidateKey: kind, sourceRefs: [{ ...src, kind }] };
      const rejected = await assessmentAdmission(spoofed, {
        runId: f.run.id,
        threadId: f.thread.id,
      });
      await expect(
        recruiting.saveRecruitingAssessment(prisma, actor, rejected.context, spoofed, [
          ...rejected.artifacts,
          { artifactId: retained.artifact.id, bytes },
        ]),
      ).rejects.toThrow(IsolationError);
    }
    const admission = await assessmentAdmission(candidate, {
      runId: f.run.id,
      threadId: f.thread.id,
    });
    const evidence = [...admission.artifacts, { artifactId: retained.artifact.id, bytes }];
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      candidate,
      evidence,
    );
    expect(saved.assessment.judgments.hardGate).toBe("met");
    await prisma.event.delete({ where: { id: retained.event.id } });
    await expect(
      recruiting.saveRecruitingAssessment(prisma, actor, admission.context, candidate, evidence),
    ).rejects.toThrow(IsolationError);
  });
  it("recovers a committed assessment after acknowledgement loss without a second version", async () => {
    const f = await assessmentFixture();
    const lostAck = {
      $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        await prisma.$transaction(callback);
        throw new Error("simulated commit acknowledgement loss");
      },
    } as unknown as PrismaClient;
    await expect(
      recruiting.saveRecruitingAssessment(lostAck, actor, f.context, f.input, f.artifacts),
    ).rejects.toThrow("acknowledgement loss");
    const receipt = await prisma.externalEffect.findUniqueOrThrow({
      where: { id: f.context.effectId },
    });
    expect(receipt.status).toBe("completed");
    await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
    });
    const { sourceThreadId: _, ...definition } = roleInput(source(f.message.id));
    await recruiting.reviseRecruitingRole(prisma, actor, {
      ...definition,
      roleId: f.role.role.id,
      expectedRevision: 1,
    });
    const { contextArtifact: _contextArtifact, ...recovery } = f.context;
    const restored = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      recovery,
      f.input,
      [],
    );
    expect(restored.isCurrent).toBe(false);
    expect(restored.assessment).toEqual((receipt.result as { assessment: unknown }).assessment);
    expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(1);
    expect(
      await prisma.event.count({ where: { runId: f.run.id, type: "recruiting.assessment.saved" } }),
    ).toBe(1);
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        { ...actor, userId: otherUserId },
        f.context,
        f.input,
        [],
      ),
    ).rejects.toThrow(IsolationError);
    await prisma.message.delete({ where: { id: f.message.id } });
    await expect(
      recruiting.saveRecruitingAssessment(prisma, actor, f.context, f.input, []),
    ).rejects.toThrow(IsolationError);
  });
  it("serializes candidate CAS across separate thread locks and PostgreSQL pools", async () => {
    const a = await assessmentFixture();
    const b = await assessmentFixture();
    await recruiting.bindRecruitingRole(prisma, actor, {
      threadId: b.thread.id,
      roleId: a.role.role.id,
    });
    const admitted = await assessmentAdmission(a.input, { runId: b.run.id, threadId: b.thread.id });
    const second = createDb(databaseUrl!);
    try {
      const settled = await Promise.allSettled([
        recruiting.saveRecruitingAssessment(prisma, actor, a.context, a.input, a.artifacts),
        recruiting.saveRecruitingAssessment(
          second.prisma,
          actor,
          admitted.context,
          a.input,
          admitted.artifacts,
        ),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
        recruiting.RecruitingConflictError,
      );
      expect(await prisma.recruitingAssessment.count({ where: { roleId: a.role.role.id } })).toBe(
        1,
      );
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });
  it("linearizes cancellation before assessment commit through the native thread lock", async () => {
    const f = await assessmentFixture();
    const second = createDb(databaseUrl!);
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const cancel = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        PrismaSql.sql`SELECT "id" FROM "threads" WHERE "id" = ${f.thread.id} FOR UPDATE`,
      );
      await recruiting.cancelRunsInTransaction(
        tx,
        [{ id: f.run.id, taskId: f.run.taskId }],
        new Date(),
      );
      locked();
      await gate;
    });
    await lock;
    try {
      const pending = recruiting.saveRecruitingAssessment(
        second.prisma,
        actor,
        f.context,
        f.input,
        f.artifacts,
      );
      const observed = pending.then(
        () => "saved",
        () => "rejected",
      );
      expect(
        await Promise.race([
          observed,
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
        ]),
      ).toBe("blocked");
      release();
      await cancel;
      expect(await observed).toBe("rejected");
      expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(
        0,
      );
    } finally {
      release();
      await cancel;
      await second.prisma.$disconnect();
      await second.pool.end();
    }
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
      data: { spaceId, userId, name: "Owned secondary", members: { create: { botId } } },
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
    const input = {
      ...assessmentInput(firstRoleId, updated.revision.id, "secondary-row"),
      sourceRefs: [assessmentSource(message.id, "Additional material")],
    };
    const admission = await assessmentAdmission(input, { runId: run.id, threadId: secondary.id });
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      input,
      admission.artifacts,
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
        {
          ...admission.context,
          effectRequest: { operation: "save", ...input, expectedRevision: 1 },
        },
        { ...input, expectedRevision: 1 },
        admission.artifacts,
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

  it("verifies native human authorship and current source atomically for role tools", async () => {
    expect(recruiting.executeRecruitingRoleMutation).toBeTypeOf("function");
    let seq = 1_000;
    const makeMessage = (data = {}) =>
      prisma.message.create({
        data: {
          threadId,
          seq: seq++,
          role: "user",
          blocks: [{ kind: "text", text: "Create this role with seven years" }],
          ...data,
        },
      });
    const first = await makeMessage();
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Native role", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        sourceMessageId: first.id,
        trigger: "user",
        status: "running",
      },
    });
    const context = { runId: run.id, sourceMessageId: first.id };
    await prisma.message.update({ where: { id: first.id }, data: { runId: run.id } });
    const input = {
      operation: "create" as const,
      expectedRevision: 0 as const,
      title: "Native role",
      sourceRefs: [],
      criteria: [{ ...roleInput().criteria[0]!, sourceRefs: [] }],
      preferences: [],
      definitionQuestions: [],
      intent: { basis: "direct" as const, quote: "Create this role with seven years" },
    };
    const call = (
      sourceMessageId: string,
      mutation: Exclude<RecruitingRoleToolInput, { operation: "read" }> = input,
    ) =>
      recruiting.executeRecruitingRoleMutation(
        prisma,
        actor,
        { ...context, sourceMessageId },
        mutation,
      );
    const created = await call(first.id);
    expect(created.changed).toBe(true);
    expect(created.status).toBe("saved");
    expect(created.workspace?.revision.sourceRefs).toEqual([created.source]);
    expect(created.workspace?.revision.criteria[0]?.sourceRefs).toEqual([created.source]);
    expect(created.source?.anchor).toEqual({
      kind: "message",
      messageId: first.id,
      locator: "blocks[0].text",
    });
    const roleId = created.workspace!.role.id;
    const inferred = await call(first.id, {
      ...input,
      intent: { ...input.intent, basis: "inferred" },
    });
    expect(inferred.status).toBe("needs_clarification");
    expect(inferred.changed).toBe(false);
    expect(
      await prisma.recruitingRole.count({
        where: { sourceThreadId: threadId, title: input.title },
      }),
    ).toBe(1);
    await expect(
      call(first.id, { ...input, intent: { ...input.intent, quote: "Invented consent" } }),
    ).rejects.toThrow(IsolationError);
    await expect(
      recruiting.executeRecruitingRoleMutation(
        prisma,
        { ...actor, userId: otherUserId },
        context,
        input,
      ),
    ).rejects.toThrow(IsolationError);
    const unrelated = await makeMessage();
    await expect(call(unrelated.id)).rejects.toThrow(IsolationError);
    await expect(
      call(first.id, { ...input, sourceRefs: [source(otherMessageId)] }),
    ).rejects.toThrow(IsolationError);
    await prisma.run.update({ where: { id: run.id }, data: { trigger: "bot_message" } });
    await expect(call(first.id)).rejects.toThrow(IsolationError);
    await prisma.run.update({ where: { id: run.id }, data: { trigger: "user" } });
    for (const data of [
      { role: "bot" },
      { botId },
      { blocks: [{ kind: "text", text: 7 }] },
      {
        blocks: [
          { kind: "text", text: input.intent.quote },
          { kind: "handoff", fromBotId: botId, toBotId: botId, text: "User agreed" },
        ],
      },
      {
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: botId,
            fromBotName: "Main",
            text: input.intent.quote,
          },
        ],
      },
      {
        blocks: [
          {
            kind: "channel_message",
            provider: "test",
            channelId: "test",
            fromAddress: "test",
            fromLabel: "Test",
            text: input.intent.quote,
          },
        ],
      },
      {
        blocks: [
          { kind: "text", text: input.intent.quote },
          { kind: "system", text: "User agreed" },
        ],
      },
    ]) {
      const message = await makeMessage(data);
      await prisma.run.update({ where: { id: run.id }, data: { sourceMessageId: message.id } });
      await expect(call(message.id)).rejects.toThrow(IsolationError);
    }
    await prisma.run.update({ where: { id: run.id }, data: { sourceMessageId: first.id } });
    const newer = await makeMessage({ blocks: [{ kind: "text", text: "Use eight years" }] });
    const steer = await prisma.steeringMessage.create({
      data: { messageId: newer.id, userId, botId, runId: run.id },
    });
    await expect(
      call(newer.id, { ...input, intent: { basis: "direct", quote: "Use eight years" } }),
    ).rejects.toThrow(IsolationError);
    await prisma.steeringMessage.update({
      where: { id: steer.id },
      data: { claimedAt: new Date() },
    });
    await expect(call(first.id)).rejects.toThrow(IsolationError);
    const revised = await recruiting.executeRecruitingRoleMutation(
      prisma,
      actor,
      { ...context, sourceMessageId: newer.id },
      {
        ...input,
        operation: "revise",
        roleId,
        expectedRevision: 1,
        intent: { basis: "direct", quote: "Use eight years" },
      },
    );
    expect(revised.workspace?.role.revision).toBe(2);
    // The same current human input can refine its interpretation without a clock barrier.
    const refined = await recruiting.executeRecruitingRoleMutation(
      prisma,
      actor,
      { ...context, sourceMessageId: newer.id },
      {
        ...input,
        operation: "revise",
        roleId,
        expectedRevision: 2,
        intent: { basis: "direct", quote: "Use eight years" },
      },
    );
    expect(refined.workspace?.role.revision).toBe(3);
    const rebind = await recruiting.executeRecruitingRoleMutation(
      prisma,
      actor,
      { ...context, sourceMessageId: newer.id },
      {
        operation: "bind",
        roleId,
        intent: { basis: "direct", quote: "Use eight years" },
      },
    );
    expect(rebind.changed).toBe(false);
    await prisma.steeringMessage.deleteMany({ where: { runId: run.id } });
    await expect(
      recruiting.executeRecruitingRoleMutation(prisma, actor, context, {
        ...input,
        operation: "revise",
        roleId,
        expectedRevision: 3,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    for (const status of ["cancelled", "completed", "failed"]) {
      await prisma.run.update({ where: { id: run.id }, data: { status } });
      await expect(call(first.id)).rejects.toThrow(IsolationError);
    }
  });

  async function nativeAsk(actions?: { id: string; label: string }[]) {
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Native answers", members: { create: { botId } } },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const original = await recruiting.createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Please clarify this role" }],
    });
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId: thread.id, prompt: "Clarify", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        sourceMessageId: original.id,
        trigger: "user",
        status: "waiting_input",
      },
    });
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Role clarification" },
      {
        kind: "ask",
        text: "What should change?",
        status: "pending",
        ...(actions ? { actions } : {}),
      },
    ];
    const card = await recruiting.createThreadMessage(prisma, {
      threadId: thread.id,
      role: "bot",
      botId,
      runId: run.id,
      blocks,
    });
    return { thread, original, task, run, card };
  }

  async function answerNativeAsk(f: Awaited<ReturnType<typeof nativeAsk>>, answer: string) {
    expect(
      await recruiting.answerRunInput(prisma, {
        spaceId,
        threadId: f.thread.id,
        runId: f.run.id,
        messageId: f.card.id,
        answeredByUserId: userId,
        answer,
      }),
    ).toBe(true);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      id: f.run.id,
      status: "queued",
      sourceMessageId: f.run.sourceMessageId,
    });
    const receipt = await prisma.event.findFirstOrThrow({
      where: {
        runId: f.run.id,
        type: "thread.choice",
        payload: { path: ["messageId"], equals: f.card.id },
      },
    });
    const payload = receipt.payload as NativeAskAnswerPayload;
    const answerMessage = await prisma.message.findUniqueOrThrow({
      where: { id: payload.answerMessageId },
    });
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "running" } });
    return { receipt, payload, answerMessage };
  }

  it.each(["choice", "custom"])(
    "uses the actual native %s answer after the original run resumes",
    async (kind) => {
      const quote = "Use eight years and always show the complete prompt";
      const f = await nativeAsk(kind === "choice" ? [{ id: "confirm", label: quote }] : undefined);
      const { payload, answerMessage } = await answerNativeAsk(
        f,
        kind === "choice" ? "confirm" : quote,
      );
      expect(payload).toEqual({
        messageId: f.card.id,
        askIndex: 1,
        answerMessageId: answerMessage.id,
        answeredByUserId: userId,
      });
      expect(answerMessage).toMatchObject({
        role: "user",
        botId: null,
        blocks: [{ kind: "text", text: quote }],
      });
      const context = { runId: f.run.id, sourceMessageId: f.original.id };
      const created = await recruiting.executeRecruitingRoleMutation(prisma, actor, context, {
        operation: "create",
        expectedRevision: 0,
        title: "Answered role",
        sourceRefs: [],
        criteria: [{ ...roleInput().criteria[0]!, sourceRefs: [] }],
        preferences: [],
        definitionQuestions: [],
        intent: { basis: "direct", quote },
      });
      expect(created.source?.anchor).toEqual({
        kind: "message",
        messageId: answerMessage.id,
        locator: "blocks[0].text",
      });
      expect(created.workspace?.revision.sourceRefs).toEqual([created.source]);
      const feedback = { ...context, intent: { basis: "direct" as const, quote }, sourceRefs: [] };
      expect(
        (await recruiting.readRecruitingFeedbackContext(prisma, actor, feedback)).source.anchor,
      ).toEqual(created.source?.anchor);
      expect(
        (
          await recruiting.readRecruitingFeedbackContext(prisma, actor, {
            ...feedback,
            sourceMessageId: answerMessage.id,
          })
        ).source.anchor,
      ).toEqual(created.source?.anchor);
      const admission = await prisma.$transaction((tx) =>
        recruiting.authorizeRecruitingMemoryCommit(
          tx,
          {
            scope: "user",
            path: "MEMORY.md",
            content: "Show complete prompts",
            expectedRevision: 0,
            sourceRunId: f.run.id,
            sourceThreadId: f.thread.id,
            recruiting: {
              sourceMessageId: f.original.id,
              feedback: {
                target: "preference",
                operation: "add",
                scope: "user",
                path: "MEMORY.md",
                expectedRevision: 0,
                intent: { basis: "direct", quote },
                sourceRefs: [],
                content: "Show complete prompts",
              },
            },
          },
          {
            operationId: "native-answer",
            traceId: "native-answer",
            spaceId,
            userId,
            botId,
            runId: f.run.id,
            signal: new AbortController().signal,
          },
          null,
        ),
      );
      expect(admission?.source.anchor).toEqual(created.source?.anchor);
      await expect(
        recruiting.readRecruitingFeedbackContext(prisma, actor, {
          ...feedback,
          intent: { basis: "direct", quote: "Please clarify this role" },
        }),
      ).rejects.toThrow(IsolationError);
    },
  );

  it.each(["bot_message", "routine"])(
    "accepts the human answer to a %s run without treating its original bot input as human",
    async (trigger) => {
      const f = await nativeAsk();
      await prisma.message.update({ where: { id: f.original.id }, data: { role: "bot", botId } });
      await prisma.run.update({ where: { id: f.run.id }, data: { trigger } });
      const { answerMessage } = await answerNativeAsk(f, "Always show complete prompts");
      const input = {
        runId: f.run.id,
        sourceMessageId: f.original.id,
        intent: { basis: "direct" as const, quote: "Always show complete prompts" },
        sourceRefs: [],
      };
      expect(
        (await recruiting.readRecruitingFeedbackContext(prisma, actor, input)).source.anchor,
      ).toMatchObject({ messageId: answerMessage.id });
      await prisma.event.deleteMany({ where: { runId: f.run.id, type: "thread.choice" } });
      await expect(recruiting.readRecruitingFeedbackContext(prisma, actor, input)).rejects.toThrow(
        IsolationError,
      );
    },
  );

  it("uses an authenticated answer for a routine with no original source message", async () => {
    const f = await nativeAsk();
    const run = await prisma.run.update({
      where: { id: f.run.id },
      data: { sourceMessageId: null, trigger: "routine" },
    });
    await prisma.message.delete({ where: { id: f.original.id } });
    const quote = "Always show complete prompts";
    const { answerMessage } = await answerNativeAsk({ ...f, run }, quote);
    const input = {
      runId: run.id,
      sourceMessageId: null,
      intent: { basis: "direct" as const, quote },
      sourceRefs: [],
    };
    expect(
      (await recruiting.readRecruitingFeedbackContext(prisma, actor, input)).source.anchor,
    ).toMatchObject({ messageId: answerMessage.id });
    const created = await recruiting.executeRecruitingRoleMutation(prisma, actor, input, {
      operation: "create",
      expectedRevision: 0,
      title: "Routine answer",
      sourceRefs: [],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
      intent: input.intent,
    });
    expect(created.source?.anchor).toMatchObject({ messageId: answerMessage.id });
    await expect(
      recruiting.readRecruitingFeedbackContext(prisma, actor, {
        ...input,
        sourceMessageId: otherMessageId,
      }),
    ).rejects.toThrow(IsolationError);
    await prisma.event.deleteMany({ where: { runId: run.id, type: "thread.choice" } });
    await expect(recruiting.readRecruitingFeedbackContext(prisma, actor, input)).rejects.toThrow(
      IsolationError,
    );
  });

  it.each([
    "actor",
    "space",
    "thread",
    "run",
    "bot",
    "card",
    "card-run",
    "card-bot",
    "card-thread",
    "index",
    "missing-index",
    "negative-index",
    "extra-field",
    "legacy",
    "missing-receipt",
    "pending",
    "approval",
    "secret",
    "bot-answer",
    "synthetic-answer",
    "external-transcript",
    "old-answer",
  ])("rejects native answer proof with an invalid %s boundary", async (boundary) => {
    const f = await nativeAsk();
    const quote = "Always show complete prompts";
    const { receipt, payload, answerMessage } = await answerNativeAsk(f, quote);
    const proof = (data: object) =>
      prisma.event.update({
        where: { id: receipt.id },
        data: { payload: { ...payload, ...data } },
      });
    const card = (data: object) => prisma.message.update({ where: { id: f.card.id }, data });
    if (boundary === "actor") await proof({ answeredByUserId: otherUserId });
    if (boundary === "space")
      await prisma.event.update({ where: { id: receipt.id }, data: { spaceId: otherSpaceId } });
    if (boundary === "thread")
      await prisma.event.update({ where: { id: receipt.id }, data: { threadId: otherThreadId } });
    if (boundary === "run")
      await prisma.event.update({ where: { id: receipt.id }, data: { runId: wrongRunId } });
    if (boundary === "bot")
      await prisma.event.update({ where: { id: receipt.id }, data: { botId: "wrong-bot" } });
    if (boundary === "card") await proof({ messageId: f.original.id });
    if (boundary === "card-run") await card({ runId: wrongRunId });
    if (boundary === "card-bot") await card({ botId: "wrong-bot" });
    if (boundary === "card-thread") await card({ threadId: otherThreadId });
    if (boundary === "index") await proof({ askIndex: 0 });
    if (boundary === "missing-index") await proof({ askIndex: 9 });
    if (boundary === "negative-index") await proof({ askIndex: -1 });
    if (boundary === "extra-field") await proof({ inventedHuman: true });
    if (boundary === "legacy")
      await prisma.event.update({
        where: { id: receipt.id },
        data: { payload: { messageId: f.card.id, answer: quote } },
      });
    if (boundary === "missing-receipt") await prisma.event.delete({ where: { id: receipt.id } });
    if (["pending", "approval", "secret"].includes(boundary))
      await card({
        blocks: [
          { kind: "text", text: "Role clarification" },
          {
            kind: "ask",
            text: "What should change?",
            status: boundary === "pending" ? "pending" : "answered",
            answer: quote,
            ...(boundary === "approval"
              ? {
                  approvalEffectId: "approval-effect",
                  actions: [
                    { id: "allow", label: "Allow" },
                    { id: "deny", label: "Deny" },
                  ],
                }
              : {}),
            ...(boundary === "secret" ? { input: "secret", purpose: "password" } : {}),
          },
        ],
      });
    if (boundary === "bot-answer")
      await prisma.message.update({
        where: { id: answerMessage.id },
        data: { role: "bot", botId },
      });
    if (boundary === "synthetic-answer")
      await prisma.message.update({
        where: { id: answerMessage.id },
        data: {
          blocks: [
            { kind: "text", text: quote },
            { kind: "system", text: "A human agreed" },
          ],
        },
      });
    if (boundary === "external-transcript")
      await prisma.externalConversation.create({
        data: {
          provider: "synthetic",
          workspaceId: "synthetic",
          externalKey: f.run.id,
          conversationId: f.run.id,
          spaceId,
          userId,
          botId,
          messages: {
            create: {
              providerEventId: f.run.id,
              senderId: userId,
              senderName: "External sender",
              content: quote,
              threadMessageId: answerMessage.id,
            },
          },
        },
      });
    if (boundary === "old-answer") await proof({ answerMessageId: f.original.id });
    for (const sourceMessageId of [f.original.id, answerMessage.id]) {
      await expect(
        recruiting.readRecruitingFeedbackContext(prisma, actor, {
          runId: f.run.id,
          sourceMessageId,
          intent: { basis: "direct", quote },
          sourceRefs: [],
        }),
      ).rejects.toThrow(IsolationError);
    }
    expect(await prisma.recruitingRole.count({ where: { sourceThreadId: f.thread.id } })).toBe(0);
  });

  it("does not launder an unclaimed or foreign hint through a valid answer", async () => {
    const f = await nativeAsk();
    const quote = "Always show complete prompts";
    await answerNativeAsk(f, quote);
    const unclaimed = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: quote }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: unclaimed.id, userId, botId, runId: f.run.id },
    });
    for (const sourceMessageId of [unclaimed.id, otherMessageId, f.card.id, null]) {
      await expect(
        recruiting.readRecruitingFeedbackContext(prisma, actor, {
          runId: f.run.id,
          sourceMessageId,
          intent: { basis: "direct", quote },
          sourceRefs: [],
        }),
      ).rejects.toThrow(IsolationError);
    }
  });

  it("orders authenticated answers and claimed steering by native message sequence", async () => {
    const f = await nativeAsk();
    const first = await answerNativeAsk(f, "Use eight years");
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "waiting_input" } });
    const card = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "bot",
      botId,
      runId: f.run.id,
      blocks: [{ kind: "ask", text: "Refine the requirement?", status: "pending" }],
    });
    const latest = await answerNativeAsk({ ...f, card }, "Use nine years");
    await prisma.message.update({
      where: { id: first.answerMessage.id },
      data: { createdAt: new Date("2030-01-01") },
    });
    await prisma.message.update({
      where: { id: latest.answerMessage.id },
      data: { createdAt: new Date("2020-01-01") },
    });
    const feedback = (sourceMessageId: string, quote = "Use nine years") =>
      recruiting.readRecruitingFeedbackContext(prisma, actor, {
        runId: f.run.id,
        sourceMessageId,
        intent: { basis: "direct", quote },
        sourceRefs: [],
      });
    for (const id of [f.original.id, first.answerMessage.id, latest.answerMessage.id]) {
      expect((await feedback(id)).source.anchor).toMatchObject({
        messageId: latest.answerMessage.id,
      });
      await expect(feedback(id, "Use eight years")).rejects.toThrow(IsolationError);
    }
    const steering = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Use ten years" }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: steering.id, userId, botId, runId: f.run.id, claimedAt: new Date() },
    });
    for (const id of [f.original.id, first.answerMessage.id, latest.answerMessage.id])
      await expect(feedback(id)).rejects.toThrow(IsolationError);
    expect((await feedback(steering.id, "Use ten years")).source.anchor).toMatchObject({
      messageId: steering.id,
    });
  });

  it("links one genuine composer message to multiple waiting group runs through distinct receipts", async () => {
    const f = await nativeAsk();
    const peer = await prisma.bot.create({
      data: { spaceId, userId, name: "Peer", color: "blue" },
    });
    await prisma.chatGroupMember.create({ data: { groupId: f.thread.groupId!, botId: peer.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: peer.id,
        threadId: f.thread.id,
        prompt: "Peer clarification",
        status: "running",
      },
    });
    const peerRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: peer.id,
        threadId: f.thread.id,
        taskId: task.id,
        sourceMessageId: f.original.id,
        trigger: "user",
        status: "waiting_input",
      },
    });
    await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "bot",
      botId: peer.id,
      runId: peerRun.id,
      blocks: [{ kind: "ask", text: "What should change?", status: "pending" }],
    });
    const quote = "Always show complete prompts";
    const composer = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      runId: f.run.id,
      blocks: [{ kind: "text", text: quote }],
    });
    for (const run of [f.run, peerRun]) {
      expect(
        await prisma.$transaction((tx) =>
          recruiting.answerWaitingRunWithTextInTransaction(tx, {
            spaceId,
            threadId: f.thread.id,
            runId: run.id,
            answeredByUserId: userId,
            answer: quote,
            answerMessageId: composer.id,
          }),
        ),
      ).toBeTruthy();
      await prisma.run.update({ where: { id: run.id }, data: { status: "running" } });
      expect(
        (
          await recruiting.readRecruitingFeedbackContext(prisma, actor, {
            runId: run.id,
            sourceMessageId: f.original.id,
            intent: { basis: "direct", quote },
            sourceRefs: [],
          })
        ).source.anchor,
      ).toMatchObject({ messageId: composer.id });
    }
    expect((await prisma.message.findUniqueOrThrow({ where: { id: composer.id } })).runId).toBe(
      f.run.id,
    );
    expect(
      await prisma.event.count({
        where: {
          threadId: f.thread.id,
          type: "thread.choice",
          payload: { path: ["answerMessageId"], equals: composer.id },
        },
      }),
    ).toBe(2);
    expect(await prisma.message.count({ where: { threadId: f.thread.id, role: "user" } })).toBe(2);
  });

  it("reads feedback only from the current actual human and exact bound role revision", async () => {
    expect(recruiting.readRecruitingFeedbackContext).toBeTypeOf("function");
    const current = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Feedback", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        sourceMessageId: messageId,
        status: "running",
        trigger: "user",
      },
    });
    const input = {
      runId: run.id,
      sourceMessageId: messageId,
      intent: { basis: "direct" as const, quote: "At least seven years" },
      roleId: current.role.id,
      expectedRoleRevision: current.role.revision,
      sourceRefs: [],
    };
    const result = await recruiting.readRecruitingFeedbackContext(prisma, actor, input);
    expect(result.workspace).toEqual(current);
    expect(result.source.anchor).toMatchObject({ kind: "message", messageId });
    await expect(
      recruiting.readRecruitingFeedbackContext(prisma, actor, {
        ...input,
        expectedRoleRevision: 2,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    await expect(
      recruiting.readRecruitingFeedbackContext(prisma, actor, {
        ...input,
        sourceMessageId: otherMessageId,
      }),
    ).rejects.toThrow(IsolationError);
    await expect(
      recruiting.readRecruitingFeedbackContext(prisma, actor, {
        ...input,
        sourceRefs: [source(otherMessageId)],
      }),
    ).rejects.toThrow(IsolationError);
    await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    await expect(recruiting.readRecruitingFeedbackContext(prisma, actor, input)).rejects.toThrow(
      IsolationError,
    );
  });

  it("records one immutable native adoption artifact and event per context nonce", async () => {
    expect(recruiting.recordRecruitingContextAdoption).toBeTypeOf("function");
    const current = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Adoption", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        sourceMessageId: messageId,
        trigger: "user",
        status: "running",
      },
    });
    const input = {
      runId: run.id,
      threadId,
      botId,
      roleId: current.role.id,
      roleRevisionId: current.revision.id,
      sourceMessageId: messageId,
      artifact: {
        name: `context-${run.id}-${hash}.json`,
        mimeType: "application/json",
        size: 2,
        hash,
        storageKey: `context-${run.id}`,
        clientNonce: `context-${run.id}`,
      },
    };
    const first = await recruiting.recordRecruitingContextAdoption(prisma, actor, input);
    expect(first.created).toBe(true);
    expect(first.artifact.version).toBe(1);
    expect(first.artifact.rootArtifactId).toBeNull();
    expect(first.event.payload).toEqual({
      roleId: current.role.id,
      roleRevisionId: current.revision.id,
      contextArtifact: { artifactId: first.artifact.id, sha256: hash },
    });
    const replay = await recruiting.recordRecruitingContextAdoption(prisma, actor, {
      ...input,
      artifact: { ...input.artifact, hash: "b".repeat(64), storageKey: "unused-upload" },
    });
    expect(replay.created).toBe(false);
    expect(replay.artifact).toEqual(first.artifact);
    expect(replay.event).toEqual(first.event);
    expect(
      await prisma.event.count({ where: { runId: run.id, type: "recruiting.context.adopted" } }),
    ).toBe(1);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: run.id } }))
        .initialRecruitingRoleRevisionId,
    ).toBe(current.revision.id);
    await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    await expect(recruiting.recordRecruitingContextAdoption(prisma, actor, input)).rejects.toThrow(
      IsolationError,
    );
  });

  async function researchFixture() {
    const f = await nativeAsk();
    await prisma.run.update({
      where: { id: f.run.id },
      data: {
        status: "running",
        leaseOwner: "research-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const role = await recruiting.createRecruitingRole(prisma, actor, {
      ...roleInput(source(f.original.id)),
      sourceThreadId: f.thread.id,
    });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: `research-${f.run.id}`,
        name: "Synthetic research",
        transport: "http",
        assignments: {
          create: {
            spaceId,
            userId,
            botId,
            allowAllTools: false,
            allowedTools: ["research", "reply", "get_task", "get_rows"],
          },
        },
      },
    });
    const metadata = (label: string, digest = hash) => ({
      name: `${label}-${f.run.id}.json`,
      mimeType: "application/json",
      size: 2,
      hash: digest,
      storageKey: `${label}-${f.run.id}`,
      clientNonce: `${label}-${f.run.id}`,
    });
    const adopted = await recruiting.recordRecruitingContextAdoption(prisma, actor, {
      runId: f.run.id,
      threadId: f.thread.id,
      botId,
      roleId: role.role.id,
      roleRevisionId: role.revision.id,
      sourceMessageId: f.original.id,
      artifact: metadata("context"),
    });
    const contextArtifact = { artifactId: adopted.artifact.id, sha256: adopted.artifact.hash };
    const frozenRequest = [
      "native",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: server.id,
          resourceRevision: server.revision,
          toolName: "research",
        },
        args: { prompt: "Find synthetic engineers" },
      },
    ];
    const input = {
      runId: f.run.id,
      sourceMessageId: f.original.id,
      intent: { basis: "direct" as const, quote: "Please clarify this role" },
      expectedRoleRevision: role.role.revision,
      mcpServerId: server.id,
      serverRevision: server.revision,
      kind: "create" as const,
      clientNonce: `action-${f.run.id}`,
      recallScope: null,
      requestArtifact: metadata("request"),
      contextArtifact,
      frozenRequest,
      effectKind: "mcp_research",
    };
    const lease = { runId: f.run.id, leaseOwner: "research-worker", leaseFence: 1 };
    return { ...f, role, server, metadata, input, lease };
  }

  it("prepares one immutable research action and artifacts without reserving an external effect", async () => {
    expect(recruiting.prepareRecruitingResearchAction).toBeTypeOf("function");
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    expect(prepared.action).toMatchObject({
      kind: "create",
      deliveryState: "prepared",
      runId: f.run.id,
      sourceMessageId: f.original.id,
      effectId: null,
      roleRevisionId: f.role.revision.id,
    });
    expect(prepared.task).toMatchObject({
      providerTaskId: null,
      pendingActionId: prepared.action.id,
      roleId: f.role.role.id,
      mcpServerId: f.server.id,
    });
    expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(0);
    const again = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    expect(again.created).toBe(false);
    expect(again.action.id).toBe(prepared.action.id);
    await expect(
      recruiting.prepareRecruitingResearchAction(prisma, actor, {
        ...f.input,
        recallScope: "Different instructions",
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(
      await prisma.recruitingResearchAction.count({ where: { taskId: prepared.task.id } }),
    ).toBe(1);
    expect(
      await prisma.event.count({
        where: { runId: f.run.id, type: "recruiting.action.transitioned" },
      }),
    ).toBe(1);
  });

  it("requires actual scoped source and adoption references while retaining an earlier same-version adoption", async () => {
    const f = await researchFixture();
    for (const input of [
      { ...f.input, sourceMessageId: otherMessageId },
      { ...f.input, contextArtifact: { artifactId, sha256: hash } },
      { ...f.input, serverRevision: f.server.revision + 1 },
    ])
      await expect(
        recruiting.prepareRecruitingResearchAction(prisma, actor, input),
      ).rejects.toThrow(IsolationError);
    expect(await prisma.recruitingResearchTask.count({ where: { roleId: f.role.role.id } })).toBe(
      0,
    );
    await recruiting.recordRecruitingContextAdoption(prisma, actor, {
      runId: f.run.id,
      threadId: f.thread.id,
      botId,
      roleId: f.role.role.id,
      roleRevisionId: f.role.revision.id,
      sourceMessageId: f.original.id,
      artifact: f.metadata("context-newer"),
    });
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    expect(prepared.action.contextArtifactId).toBe(f.input.contextArtifact.artifactId);
  });

  it("returns the same preparation to concurrent retries and resolves task reads through its pending action", async () => {
    const f = await researchFixture();
    const results = await Promise.all([
      recruiting.prepareRecruitingResearchAction(prisma, actor, f.input),
      recruiting.prepareRecruitingResearchAction(prisma, actor, f.input),
    ]);
    expect(results[0].action.id).toBe(results[1].action.id);
    const read = await recruiting.readRecruitingResearchContext(prisma, actor, {
      runId: f.run.id,
      taskId: results[0].task.id,
      toolName: "get_task",
    });
    expect(read.action?.id).toBe(results[0].action.id);
  });

  async function nextResearchRun(f: Awaited<ReturnType<typeof researchFixture>>) {
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: f.thread.id,
        prompt: "Start prepared action",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: f.thread.id,
        taskId: task.id,
        sourceMessageId: f.original.id,
        trigger: "user",
        status: "running",
        leaseOwner: "research-worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await recruiting.recordRecruitingContextAdoption(prisma, actor, {
      runId: run.id,
      threadId: f.thread.id,
      botId,
      roleId: f.role.role.id,
      roleRevisionId: f.role.revision.id,
      sourceMessageId: f.original.id,
      artifact: { ...f.metadata("context-next"), clientNonce: `context-${run.id}` },
    });
    return { runId: run.id, leaseOwner: "research-worker", leaseFence: 2 };
  }

  async function researchHandoffFixture() {
    const f = await researchFixture();
    const target = await prisma.bot.create({
      data: { spaceId, userId, name: "Research peer", color: "blue" },
    });
    await prisma.chatGroupMember.create({ data: { groupId: f.thread.groupId!, botId: target.id } });
    await prisma.botMcpServer.create({
      data: { spaceId, userId, botId: target.id, serverId: f.server.id },
    });
    const quote = "Search using this role and preserve all requirements";
    const handoff = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "bot",
      botId,
      runId: f.run.id,
      clientNonce: `group-handoff:${f.run.id}`,
      blocks: [{ kind: "handoff", fromBotId: botId, toBotId: target.id, text: quote, hop: 1 }],
    });
    const event = await recruiting.appendEvent(prisma, {
      spaceId,
      threadId: f.thread.id,
      botId,
      runId: f.run.id,
      type: "group.handoff",
      payload: { messageId: handoff.id, fromBotId: botId, toBotId: target.id, text: quote },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: target.id,
        threadId: f.thread.id,
        prompt: quote,
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: target.id,
        threadId: f.thread.id,
        taskId: task.id,
        sourceMessageId: handoff.id,
        trigger: "follow_up",
        status: "running",
        leaseOwner: "research-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const adopted = await recruiting.recordRecruitingContextAdoption(prisma, actor, {
      runId: run.id,
      threadId: f.thread.id,
      botId: target.id,
      roleId: f.role.role.id,
      roleRevisionId: f.role.revision.id,
      sourceMessageId: handoff.id,
      artifact: f.metadata("handoff-context"),
    });
    return {
      ...f,
      run,
      senderRun: f.run,
      target,
      handoff,
      event,
      quote,
      lease: { runId: run.id, leaseOwner: "research-worker", leaseFence: 1 },
      input: {
        ...f.input,
        runId: run.id,
        sourceMessageId: handoff.id,
        intent: { basis: "direct" as const, quote },
        contextArtifact: { artifactId: adopted.artifact.id, sha256: adopted.artifact.hash },
      },
    };
  }

  it("prepares and dispatches real group handoff research without treating a bot as human", async () => {
    const f = await researchHandoffFixture();
    const context = await recruiting.readRecruitingResearchContext(prisma, actor, f.input);
    expect(context.source).toMatchObject({
      kind: "original_material",
      quote: f.quote,
      anchor: { kind: "message", messageId: f.handoff.id, locator: "blocks[0].text" },
    });
    expect(context.source?.id).not.toContain("human-message");
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    expect(admitted.status).toBe("ready");
    expect(
      await recruiting.claimRecruitingResearchAction(prisma, actor, {
        ...f.lease,
        actionId: prepared.action.id,
        effectId: admitted.effect!.id,
        from: "intended",
      }),
    ).toBe(true);
    await expect(
      recruiting.readRecruitingFeedbackContext(prisma, actor, {
        runId: f.run.id,
        sourceMessageId: f.handoff.id,
        intent: f.input.intent,
        sourceRefs: [],
      }),
    ).rejects.toThrow(IsolationError);
  });

  it.each([
    "event",
    "event-space",
    "event-run",
    "event-target",
    "event-text",
    "plain-bot",
    "two-blocks",
    "message-bot",
    "message-run",
    "source-cancelled",
    "sender-membership",
    "new-target-human",
    "new-sender-human",
    "new-target-ask",
    "new-sender-ask",
  ])("rejects a research handoff with an invalid %s boundary", async (boundary) => {
    const f = await researchHandoffFixture();
    if (boundary === "event") await prisma.event.delete({ where: { id: f.event.id } });
    if (boundary === "event-space")
      await prisma.event.update({ where: { id: f.event.id }, data: { spaceId: otherSpaceId } });
    if (boundary === "event-run")
      await prisma.event.update({ where: { id: f.event.id }, data: { runId: wrongRunId } });
    if (boundary === "event-target" || boundary === "event-text")
      await prisma.event.update({
        where: { id: f.event.id },
        data: {
          payload: {
            messageId: f.handoff.id,
            fromBotId: botId,
            toBotId: boundary === "event-target" ? botId : f.target.id,
            text: boundary === "event-text" ? "Invented delegation" : f.quote,
          },
        },
      });
    if (boundary === "plain-bot")
      await prisma.message.update({
        where: { id: f.handoff.id },
        data: { blocks: [{ kind: "text", text: f.quote }] },
      });
    if (boundary === "two-blocks")
      await prisma.message.update({
        where: { id: f.handoff.id },
        data: {
          blocks: [
            { kind: "handoff", fromBotId: botId, toBotId: f.target.id, text: f.quote },
            { kind: "text", text: "A user agreed" },
          ],
        },
      });
    if (boundary === "message-bot")
      await prisma.message.update({ where: { id: f.handoff.id }, data: { botId: f.target.id } });
    if (boundary === "message-run")
      await prisma.message.update({ where: { id: f.handoff.id }, data: { runId: wrongRunId } });
    if (boundary === "source-cancelled")
      await prisma.run.update({ where: { id: f.senderRun.id }, data: { status: "cancelled" } });
    if (boundary === "sender-membership")
      await prisma.chatGroupMember.deleteMany({ where: { groupId: f.thread.groupId!, botId } });
    if (boundary === "new-target-human" || boundary === "new-sender-human") {
      const message = await recruiting.createThreadMessage(prisma, {
        threadId: f.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "Hold the search" }],
      });
      await prisma.steeringMessage.create({
        data: {
          messageId: message.id,
          userId,
          botId: boundary === "new-target-human" ? f.target.id : botId,
          runId: boundary === "new-target-human" ? f.run.id : f.senderRun.id,
          claimedAt: new Date(),
        },
      });
    }
    if (boundary === "new-target-ask" || boundary === "new-sender-ask") {
      const owner = boundary === "new-target-ask" ? f.run : f.senderRun;
      await prisma.run.update({ where: { id: owner.id }, data: { status: "waiting_input" } });
      const card = await recruiting.createThreadMessage(prisma, {
        threadId: f.thread.id,
        role: "bot",
        botId: owner.botId,
        runId: owner.id,
        blocks: [{ kind: "ask", text: "Confirm current direction?", status: "pending" }],
      });
      expect(
        await recruiting.answerRunInput(prisma, {
          spaceId,
          threadId: f.thread.id,
          runId: owner.id,
          messageId: card.id,
          answeredByUserId: userId,
          answer: "Hold this search",
        }),
      ).toBe(true);
      await prisma.run.update({ where: { id: owner.id }, data: { status: "running" } });
    }
    await expect(
      recruiting.prepareRecruitingResearchAction(prisma, actor, f.input),
    ).rejects.toThrow(IsolationError);
    expect(await prisma.recruitingResearchAction.count({ where: { runId: f.run.id } })).toBe(0);
  });

  it("revalidates handoff cancellation at dispatch after a valid preparation", async () => {
    const f = await researchHandoffFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    await prisma.run.update({ where: { id: f.senderRun.id }, data: { status: "cancelled" } });
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    expect(admitted.status).toBe("superseded");
    expect(admitted.effect).toBeNull();
  });

  async function completedResearchRead(
    f: Awaited<ReturnType<typeof researchFixture>>,
    actionId: string,
    label: string,
    toolName: "get_task" | "get_rows",
    rawResult: Prisma.InputJsonValue,
  ) {
    const request: Prisma.InputJsonValue = [
      "__rakazoCatalogTool",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: f.server.id,
          resourceRevision: f.server.revision,
          toolName,
        },
        args: { task_id: "provider-task" },
      },
    ];
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: `mcp_${toolName}`,
        idempotencyKey: `research-read:${actionId}:${label}`,
        status: "intended",
        request,
      },
    });
    const owner = await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
    await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
      runId: owner.id,
      leaseOwner: owner.leaseOwner!,
      leaseFence: owner.leaseFence,
      actionId,
      effectId: effect.id,
      request,
    });
    await prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", result: rawResult },
    });
    return { effectId: effect.id, request, rawResult };
  }

  function recordResearchRead(
    input: recruiting.RecruitingResearchObservationInput,
    suppliedActor = actor,
  ) {
    return recruiting.recordRecruitingResearchObservation(prisma, suppliedActor, {
      ...input,
      outputArtifact: {
        ...input.outputArtifact,
        clientNonce: `recruiting-observation:${input.effectId}`,
      },
    });
  }

  async function intendedResearchRead(
    f: Awaited<ReturnType<typeof researchFixture>>,
    label: string,
  ) {
    const request: Prisma.InputJsonValue = [
      "__rakazoCatalogTool",
      "direct",
      {
        route: {
          connectorId: "mcp",
          resourceId: f.server.id,
          resourceRevision: f.server.revision,
          toolName: "get_rows",
        },
        args: { task_id: "provider-task" },
      },
    ];
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: "mcp_get_rows",
        idempotencyKey: `bound-read:${f.run.id}:${label}`,
        status: "intended",
        request,
      },
    });
    return { effect, request };
  }

  it("recovers an actually bound completed read from a cancelled run without rewinding current summaries", async () => {
    expect(recruiting.bindRecruitingResearchReadEffect).toBeTypeOf("function");
    const { f, prepared } = await mappedResearchFixture();
    const { effect, request } = await intendedResearchRead(f, "recover");
    const bound = await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
      ...f.lease,
      actionId: prepared.action.id,
      effectId: effect.id,
      request,
    });
    expect(bound.binding).toEqual({
      phase: "bound",
      taskId: prepared.task.id,
      actionId: prepared.action.id,
      effectId: effect.id,
      toolName: "get_rows",
    });
    const rawResult = { rows: [{ value: "old page", source_id: "raw-old" }] };
    await prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", result: rawResult },
    });
    await prisma.recruitingResearchAction.update({
      where: { id: prepared.action.id },
      data: {
        cursor: "current-cursor",
        observedProviderState: "completed",
        usage: [{ scope: "task", unit: "credits", amount: 9 }],
      },
    });
    await prisma.recruitingResearchTask.update({
      where: { id: prepared.task.id },
      data: { state: "completed" },
    });
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    const next = await nextResearchRun(f);
    await recruiting.createRecruitingRole(prisma, actor, {
      ...roleInput(source(f.original.id)),
      sourceThreadId: f.thread.id,
      title: "Switched role",
    });
    await prisma.mcpServer.update({
      where: { id: f.server.id },
      data: { enabled: false, revision: 2 },
    });
    await prisma.botMcpServer.deleteMany({ where: { serverId: f.server.id } });
    const pending = await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
      runId: next.runId,
      taskId: prepared.task.id,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      saved: { action: { id: prepared.action.id } },
      effect: { id: effect.id },
      toolName: "get_rows",
      args: { task_id: "provider-task" },
    });
    const input = {
      runId: next.runId,
      actionId: prepared.action.id,
      effectId: effect.id,
      request,
      rawResult,
      toolName: "get_rows" as const,
      historicalBackfill: true,
      cursor: "old-cursor",
      taskState: "active" as const,
      observedProviderState: "queued",
      usage: [{ scope: "task" as const, unit: "credits", amount: 1 }],
      outputArtifact: {
        ...f.metadata("backfilled-read", "e".repeat(64)),
        clientNonce: `recruiting-observation:${effect.id}`,
      },
    };
    await expect(recordResearchRead({ ...input, historicalBackfill: false })).rejects.toThrow(
      IsolationError,
    );
    await expect(
      recruiting.listUnmappedRecruitingResearchReads(
        prisma,
        { ...actor, userId: otherUserId },
        {
          runId: next.runId,
          taskId: prepared.task.id,
        },
      ),
    ).rejects.toThrow(IsolationError);
    const recorded = await recordResearchRead(input);
    expect(recorded.action).toMatchObject({
      cursor: "current-cursor",
      observedProviderState: "completed",
      usage: [{ scope: "task", unit: "credits", amount: 9 }],
    });
    expect(recorded.task.state).toBe("completed");
    expect(
      await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
        runId: next.runId,
        taskId: prepared.task.id,
      }),
    ).toEqual([]);
    const replayed = await recordResearchRead({
      ...input,
      cursor: "another-old-cursor",
      usage: [{ scope: "task", unit: "credits", amount: 0 }],
    });
    expect(replayed.outputArtifact.id).toBe(recorded.outputArtifact.id);
    expect(replayed.action).toEqual(recorded.action);
    expect(
      (
        await prisma.event.findFirstOrThrow({
          where: {
            type: "recruiting.read",
            AND: [
              { payload: { path: ["phase"], equals: "recorded" } },
              { payload: { path: ["effectId"], equals: effect.id } },
            ],
          },
        })
      ).runId,
    ).toBe(next.runId);
    expect(
      await prisma.event.count({
        where: {
          type: "recruiting.read",
          AND: [
            { payload: { path: ["phase"], equals: "recorded" } },
            { payload: { path: ["effectId"], equals: effect.id } },
          ],
        },
      }),
    ).toBe(1);
  });

  it("binds and records one read once across two database connections", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const { effect, request } = await intendedResearchRead(f, "concurrent");
    const second = createDb(databaseUrl!);
    try {
      const bind = { ...f.lease, actionId: prepared.action.id, effectId: effect.id, request };
      const bound = await Promise.all([
        recruiting.bindRecruitingResearchReadEffect(prisma, actor, bind),
        recruiting.bindRecruitingResearchReadEffect(second.prisma, actor, bind),
      ]);
      expect(bound[0]!.binding).toEqual(bound[1]!.binding);
      const rawResult = { rows: [{ value: "concurrent page" }] };
      await prisma.externalEffect.update({
        where: { id: effect.id },
        data: { status: "completed", result: rawResult },
      });
      const input = {
        runId: f.run.id,
        actionId: prepared.action.id,
        effectId: effect.id,
        request,
        rawResult,
        toolName: "get_rows" as const,
        outputArtifact: {
          ...f.metadata("concurrent-read"),
          clientNonce: `recruiting-observation:${effect.id}`,
        },
      };
      const recorded = await Promise.all([
        recruiting.recordRecruitingResearchObservation(prisma, actor, input),
        recruiting.recordRecruitingResearchObservation(second.prisma, actor, input),
      ]);
      expect(recorded[0]!.outputArtifact.id).toBe(recorded[1]!.outputArtifact.id);
      expect(recorded[1]!.action.outputArtifacts).toHaveLength(1);
      expect(
        await prisma.event.count({
          where: { type: "recruiting.read", payload: { path: ["effectId"], equals: effect.id } },
        }),
      ).toBe(2);
      expect(
        await prisma.artifact.count({ where: { clientNonce: input.outputArtifact.clientNonce } }),
      ).toBe(1);
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it.each(["intended", "approved", "executing"] as const)(
    "rechecks the native lease when replaying an already bound %s read",
    async (status) => {
      const { f, prepared } = await mappedResearchFixture();
      const { effect, request } = await intendedResearchRead(f, `stale-${status}`);
      const input = { ...f.lease, actionId: prepared.action.id, effectId: effect.id, request };
      await recruiting.bindRecruitingResearchReadEffect(prisma, actor, input);
      await prisma.externalEffect.update({ where: { id: effect.id }, data: { status } });
      await prisma.run.update({
        where: { id: f.run.id },
        data: { leaseOwner: "replacement-worker", leaseFence: 2 },
      });
      await expect(
        recruiting.bindRecruitingResearchReadEffect(prisma, actor, input),
      ).rejects.toThrow(IsolationError);
      if (status !== "executing")
        await expect(
          recruiting.claimRecruitingResearchReadEffect(prisma, actor, {
            ...f.lease,
            effectId: effect.id,
            from: status,
          }),
        ).rejects.toThrow(IsolationError);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
      ).toBe(status);
    },
  );

  it.each(["cancel", "expire", "role", "server", "assignment"])(
    "does not dispatch a previously bound read after its %s boundary changes",
    async (boundary) => {
      expect(recruiting.claimRecruitingResearchReadEffect).toBeTypeOf("function");
      const { f, prepared } = await mappedResearchFixture();
      const { effect, request } = await intendedResearchRead(f, `claim-${boundary}`);
      await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
        ...f.lease,
        actionId: prepared.action.id,
        effectId: effect.id,
        request,
      });
      if (boundary === "cancel")
        await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
      if (boundary === "expire")
        await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
      if (boundary === "role")
        await recruiting.createRecruitingRole(prisma, actor, {
          ...roleInput(source(f.original.id)),
          sourceThreadId: f.thread.id,
          title: "Switched before read claim",
        });
      if (boundary === "server")
        await prisma.mcpServer.update({ where: { id: f.server.id }, data: { enabled: false } });
      if (boundary === "assignment")
        await prisma.botMcpServer.deleteMany({ where: { serverId: f.server.id } });
      await expect(
        recruiting.claimRecruitingResearchReadEffect(prisma, actor, {
          ...f.lease,
          effectId: effect.id,
          from: "intended",
        }),
      ).rejects.toThrow(IsolationError);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
      ).toBe("intended");
    },
  );

  it.each(["intended", "approved"] as const)(
    "claims a native %s read once across two connections",
    async (from) => {
      expect(recruiting.claimRecruitingResearchReadEffect).toBeTypeOf("function");
      const { f, prepared } = await mappedResearchFixture();
      const { effect, request } = await intendedResearchRead(f, `claim-once-${from}`);
      await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
        ...f.lease,
        actionId: prepared.action.id,
        effectId: effect.id,
        request,
      });
      await prisma.externalEffect.update({ where: { id: effect.id }, data: { status: from } });
      const second = createDb(databaseUrl!);
      try {
        const input = { ...f.lease, effectId: effect.id, from };
        expect(
          (
            await Promise.all([
              recruiting.claimRecruitingResearchReadEffect(prisma, actor, input),
              recruiting.claimRecruitingResearchReadEffect(second.prisma, actor, input),
            ])
          ).sort(),
        ).toEqual([false, true]);
        expect(
          (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
        ).toBe("executing");
        expect(
          (
            await prisma.recruitingResearchAction.findUniqueOrThrow({
              where: { id: prepared.action.id },
            })
          ).deliveryState,
        ).toBe("accepted");
      } finally {
        await second.prisma.$disconnect();
        await second.pool.end();
      }
    },
  );

  it("keeps a late live read on its original action without completing a newer continuation", async () => {
    const { f, prepared: original } = await mappedResearchFixture();
    const { effect, request } = await intendedResearchRead(f, "late-original-read");
    await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
      ...f.lease,
      actionId: original.action.id,
      effectId: effect.id,
      request,
    });
    const continued = await recruiting.prepareRecruitingResearchAction(prisma, actor, {
      ...f.input,
      kind: "continue",
      taskId: original.task.id,
      clientNonce: `${f.input.clientNonce}-live-next-round`,
      requestArtifact: f.metadata("live-next-round"),
    });
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, continued),
    );
    const accepted = { task_id: "provider-task", state: "queued" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: accepted },
    });
    await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: continued.action.id,
      effectId: admitted.effect!.id,
      rawResult: accepted,
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      taskState: "active",
      cursor: "current-round",
      receiptArtifact: f.metadata("live-next-receipt"),
    });
    const rawResult = { rows: [{ value: "old round completed" }], done: true };
    await prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", result: rawResult },
    });
    const recorded = await recordResearchRead({
      runId: f.run.id,
      actionId: original.action.id,
      effectId: effect.id,
      request,
      rawResult,
      toolName: "get_rows",
      taskState: "completed",
      cursor: "old-round",
      outputArtifact: f.metadata("late-live-original"),
    });
    expect(recorded.task).toMatchObject({ state: "active", pendingActionId: continued.action.id });
    expect(recorded.action).toMatchObject({ id: original.action.id, cursor: "old-round" });
    expect(recorded.action.outputArtifacts).toHaveLength(1);
    expect(
      await prisma.recruitingResearchAction.findUniqueOrThrow({
        where: { id: continued.action.id },
      }),
    ).toMatchObject({ cursor: "current-round", outputArtifacts: [] });
  });

  it.each(["lease", "actor", "run", "request", "role", "server", "assignment", "legacy"])(
    "rejects a fresh read binding with an invalid %s boundary",
    async (boundary) => {
      const { f, prepared } = await mappedResearchFixture();
      const { effect, request } = await intendedResearchRead(f, boundary);
      const input = { ...f.lease, actionId: prepared.action.id, effectId: effect.id, request };
      if (boundary === "lease") input.leaseFence += 1;
      if (boundary === "run") input.runId = wrongRunId;
      if (boundary === "request") input.request = ["changed"];
      if (boundary === "role")
        await recruiting.createRecruitingRole(prisma, actor, {
          ...roleInput(source(f.original.id)),
          sourceThreadId: f.thread.id,
          title: "Changed role",
        });
      if (boundary === "server")
        await prisma.mcpServer.update({ where: { id: f.server.id }, data: { enabled: false } });
      if (boundary === "assignment")
        await prisma.botMcpServer.deleteMany({ where: { serverId: f.server.id } });
      if (boundary === "legacy")
        await prisma.externalEffect.update({
          where: { id: effect.id },
          data: { status: "completed", result: { rows: [] } },
        });
      await expect(
        recruiting.bindRecruitingResearchReadEffect(
          prisma,
          boundary === "actor" ? { ...actor, userId: otherUserId } : actor,
          input,
        ),
      ).rejects.toThrow();
      expect(
        await prisma.event.count({
          where: { type: "recruiting.read", payload: { path: ["effectId"], equals: effect.id } },
        }),
      ).toBe(0);
      if (boundary === "legacy") {
        expect(
          await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
            runId: f.run.id,
            taskId: prepared.task.id,
          }),
        ).toEqual([]);
        await expect(
          recordResearchRead({
            runId: f.run.id,
            actionId: prepared.action.id,
            effectId: effect.id,
            request,
            rawResult: { rows: [] },
            toolName: "get_rows",
            outputArtifact: f.metadata("legacy-output"),
          }),
        ).rejects.toThrow(IsolationError);
      }
    },
  );

  it.each(["artifact-only", "missing-ref", "changed-record", "duplicate-bind", "extra-field"])(
    "rejects a contradictory read receipt with %s",
    async (boundary) => {
      const { f, prepared } = await mappedResearchFixture();
      const identity = await completedResearchRead(f, prepared.action.id, boundary, "get_rows", {
        rows: [],
      });
      const input = {
        ...identity,
        runId: f.run.id,
        actionId: prepared.action.id,
        toolName: "get_rows" as const,
        outputArtifact: {
          ...f.metadata("receipt-proof"),
          clientNonce: `recruiting-observation:${identity.effectId}`,
        },
      };
      if (boundary === "artifact-only") {
        await prisma.artifact.create({
          data: { ...input.outputArtifact, spaceId, userId, botId, runId: f.run.id, version: 1 },
        });
      } else if (boundary === "duplicate-bind" || boundary === "extra-field") {
        const event = await prisma.event.findFirstOrThrow({
          where: {
            type: "recruiting.read",
            payload: { path: ["effectId"], equals: identity.effectId },
          },
        });
        if (boundary === "extra-field")
          await prisma.event.update({
            where: { id: event.id },
            data: { payload: { ...(event.payload as Prisma.InputJsonObject), invented: true } },
          });
        else
          await recruiting.appendEvent(prisma, {
            spaceId,
            threadId: f.thread.id,
            botId,
            runId: f.run.id,
            type: "recruiting.read",
            payload: event.payload as Prisma.InputJsonObject,
          });
      } else {
        await recordResearchRead(input);
        if (boundary === "missing-ref")
          await prisma.recruitingResearchAction.update({
            where: { id: prepared.action.id },
            data: { outputArtifacts: [] },
          });
        else {
          const event = await prisma.event.findFirstOrThrow({
            where: {
              type: "recruiting.read",
              AND: [
                { payload: { path: ["effectId"], equals: identity.effectId } },
                { payload: { path: ["phase"], equals: "recorded" } },
              ],
            },
          });
          await prisma.event.update({
            where: { id: event.id },
            data: {
              payload: { ...(event.payload as Prisma.InputJsonObject), taskId: "changed-task" },
            },
          });
        }
      }
      await expect(
        recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
          runId: f.run.id,
          taskId: prepared.task.id,
        }),
      ).rejects.toThrow(IsolationError);
      await expect(recordResearchRead(input)).rejects.toThrow(IsolationError);
    },
  );

  it("requires the exact native observation artifact nonce", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const identity = await completedResearchRead(f, prepared.action.id, "nonce", "get_rows", {
      rows: [],
    });
    await expect(
      recruiting.recordRecruitingResearchObservation(prisma, actor, {
        ...identity,
        runId: f.run.id,
        actionId: prepared.action.id,
        toolName: "get_rows",
        outputArtifact: f.metadata("invented-receipt-nonce"),
      }),
    ).rejects.toThrow(IsolationError);
  });

  it("retains the first read binding when a continuation becomes the current action", async () => {
    const { f, prepared: original } = await mappedResearchFixture();
    const { effect, request } = await intendedResearchRead(f, "first-action");
    await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
      ...f.lease,
      actionId: original.action.id,
      effectId: effect.id,
      request,
    });
    const continued = await recruiting.prepareRecruitingResearchAction(prisma, actor, {
      ...f.input,
      kind: "continue",
      taskId: original.task.id,
      clientNonce: `${f.input.clientNonce}-continue-after-read`,
      requestArtifact: f.metadata("continue-after-read"),
    });
    const replay = await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
      ...f.lease,
      actionId: continued.action.id,
      effectId: effect.id,
      request,
    });
    expect(replay.binding.actionId).toBe(original.action.id);
    const rawResult = { rows: [{ value: "first action rows" }] };
    await prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "completed", result: rawResult },
    });
    const terminalReplay = await recruiting.bindRecruitingResearchReadEffect(prisma, actor, {
      ...f.lease,
      actionId: continued.action.id,
      effectId: effect.id,
      request,
    });
    expect(terminalReplay.saved.action!.id).toBe(original.action.id);
    const pending = await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
      runId: f.run.id,
      taskId: original.task.id,
    });
    expect(pending[0]!.saved.action!.id).toBe(original.action.id);
    const recorded = await recordResearchRead({
      runId: f.run.id,
      actionId: original.action.id,
      effectId: effect.id,
      request,
      rawResult,
      toolName: "get_rows",
      historicalBackfill: true,
      taskState: "completed",
      cursor: "old-page",
      outputArtifact: f.metadata("first-action-page"),
    });
    expect(recorded.task).toMatchObject({ state: "active", pendingActionId: continued.action.id });
    expect(recorded.action.cursor).toBeNull();
    expect(
      (
        await prisma.recruitingResearchAction.findUniqueOrThrow({
          where: { id: continued.action.id },
        })
      ).outputArtifacts,
    ).toEqual([]);
    await expect(
      recordResearchRead({
        runId: f.run.id,
        actionId: continued.action.id,
        effectId: effect.id,
        request,
        rawResult,
        toolName: "get_rows",
        outputArtifact: f.metadata("wrong-action"),
      }),
    ).rejects.toThrow(IsolationError);
  });

  it("persists a completed rows receipt after cancellation and role/provider permission changes", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    const rawResult = { task_id: "provider-task" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      receiptArtifact: f.metadata("mutation-receipt"),
      deliveryState: "accepted",
      providerTaskId: "provider-task",
    });
    const read = await completedResearchRead(f, prepared.action.id, "late-page", "get_rows", {
      rows: [{ value: "A", source_id: "raw-a" }],
    });
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    await recruiting.createRecruitingRole(prisma, actor, {
      ...roleInput(source(f.original.id)),
      sourceThreadId: f.thread.id,
      title: "Another role",
    });
    await prisma.mcpServer.update({
      where: { id: f.server.id },
      data: { enabled: false, revision: 2 },
    });
    await prisma.botMcpServer.deleteMany({ where: { serverId: f.server.id } });
    const recorded = await recordResearchRead({
      ...read,
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows",
      outputArtifact: f.metadata("late-page", "e".repeat(64)),
      cursor: "after-a",
    });
    expect(recorded.action.outputArtifacts).toEqual([
      { artifactId: recorded.outputArtifact.id, sha256: "e".repeat(64) },
    ]);
    expect(recorded.action.cursor).toBe("after-a");
    expect(recorded.action.effectId).toBe(admitted.effect!.id);
  });

  async function mappedResearchFixture() {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    const rawResult = { task_id: "provider-task" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    const mapped = await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      receiptArtifact: f.metadata("receipt"),
    });
    return { f, prepared, mapped };
  }

  it("keeps a completed continuation as the authoritative task action for subsequent rows", async () => {
    const { f, prepared: original } = await mappedResearchFixture();
    const source = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Continue with the missing-evidence round" }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: source.id, userId, botId, runId: f.run.id, claimedAt: new Date() },
    });
    const continued = await recruiting.prepareRecruitingResearchAction(prisma, actor, {
      ...f.input,
      sourceMessageId: source.id,
      intent: { basis: "direct", quote: "Continue with the missing-evidence round" },
      kind: "continue",
      taskId: original.task.id,
      clientNonce: `${f.input.clientNonce}-round-b`,
      requestArtifact: f.metadata("request-round-b"),
    });
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, continued),
    );
    const rawResult = { task_id: "provider-task", state: "queued" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: continued.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      receiptArtifact: f.metadata("round-b-receipt"),
      deliveryState: "accepted",
      providerTaskId: "provider-task",
    });
    const status = await recordResearchRead({
      ...(await completedResearchRead(f, continued.action.id, "round-b-completed", "get_task", {
        state: "completed",
      })),
      runId: f.run.id,
      actionId: continued.action.id,
      toolName: "get_task",
      taskState: "completed",
      outputArtifact: f.metadata("round-b-status", "b".repeat(64)),
      observedProviderState: "completed",
    });
    expect(status.task.pendingActionId).toBe(continued.action.id);
    const selected = await recruiting.readRecruitingResearchContext(prisma, actor, {
      runId: f.run.id,
      taskId: original.task.id,
      toolName: "get_rows",
    });
    expect(selected.action?.id).toBe(continued.action.id);
    const rows = await recordResearchRead({
      ...(await completedResearchRead(f, selected.action!.id, "round-b-rows", "get_rows", {
        rows: [{ value: "round B" }],
      })),
      runId: f.run.id,
      actionId: selected.action!.id,
      toolName: "get_rows",
      cursor: "b-next",
      usage: [{ scope: "task", unit: "credits", amount: 5 }],
      outputArtifact: f.metadata("round-b-rows", "c".repeat(64)),
    });
    expect(rows.task).toMatchObject({ state: "completed", pendingActionId: continued.action.id });
    expect(rows.action).toMatchObject({
      id: continued.action.id,
      sourceMessageId: source.id,
      cursor: "b-next",
      usage: [{ scope: "task", unit: "credits", amount: 5 }],
    });
    const untouched = await prisma.recruitingResearchAction.findUniqueOrThrow({
      where: { id: original.action.id },
    });
    expect(untouched).toMatchObject({
      cursor: null,
      usage: null,
      sourceMessageId: f.original.id,
      outputArtifacts: [],
    });
  });

  it.each(["admission", "claim"])(
    "linearizes cross-thread preparation cancellation before %s through native thread locks",
    async (stage) => {
      const f = await researchFixture();
      const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
      const group = await prisma.chatGroup.create({
        data: { spaceId, userId, name: "Dispatch thread", members: { create: { botId } } },
      });
      const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
      await recruiting.bindRecruitingRole(prisma, actor, {
        threadId: thread.id,
        roleId: f.role.role.id,
      });
      const source = await recruiting.createThreadMessage(prisma, {
        threadId: thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "Start the prepared search" }],
      });
      const task = await prisma.task.create({
        data: { spaceId, userId, botId, threadId: thread.id, prompt: "Start", status: "running" },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId: thread.id,
          taskId: task.id,
          sourceMessageId: source.id,
          trigger: "user",
          status: "running",
          leaseOwner: "research-worker",
          leaseFence: 2,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await recruiting.recordRecruitingContextAdoption(prisma, actor, {
        runId: run.id,
        threadId: thread.id,
        botId,
        roleId: f.role.role.id,
        roleRevisionId: f.role.revision.id,
        sourceMessageId: source.id,
        artifact: f.metadata("cross-thread-context"),
      });
      const admission = { ...researchAdmission(f, prepared), runId: run.id, leaseFence: 2 };
      const admitted =
        stage === "claim"
          ? await recruiting.admitRecruitingResearchAction(prisma, actor, admission)
          : null;
      let release!: () => void;
      let locked!: () => void;
      const committed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const cancel = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          PrismaSql.sql`SELECT "id" FROM "threads" WHERE "id" = ${f.thread.id} FOR UPDATE`,
        );
        await recruiting.cancelRunsInTransaction(
          tx,
          [{ id: f.run.id, taskId: f.run.taskId }],
          new Date(),
        );
        locked();
        await committed;
      });
      await originLocked;
      const second = createDb(databaseUrl!);
      try {
        const pending =
          stage === "claim"
            ? recruiting.claimRecruitingResearchAction(second.prisma, actor, {
                runId: run.id,
                leaseOwner: "research-worker",
                leaseFence: 2,
                actionId: prepared.action.id,
                effectId: admitted!.effect!.id,
                from: "intended",
              })
            : recruiting.admitRecruitingResearchAction(second.prisma, actor, admission);
        await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 300))]);
        release();
        await cancel;
        const result = await pending;
        if (stage === "claim") expect(result).toBe(false);
        else expect(result).toMatchObject({ status: "superseded", effect: null });
        expect(
          (
            await prisma.recruitingResearchAction.findUniqueOrThrow({
              where: { id: prepared.action.id },
            })
          ).deliveryState,
        ).toBe("superseded");
      } finally {
        release();
        await cancel;
        await second.prisma.$disconnect();
        await second.pool.end();
      }
    },
  );

  it.each([
    "missing",
    "status",
    "run",
    "space",
    "result",
    "request",
    "server",
    "revision",
    "tool",
    "task",
    "extra-route",
    "catalog-id",
    "actor",
  ])("rejects a completed research read with an invalid %s receipt boundary", async (boundary) => {
    const { f, prepared } = await mappedResearchFixture();
    const identity = await completedResearchRead(
      f,
      prepared.action.id,
      "invalid-page",
      "get_rows",
      { rows: [] },
    );
    const payload = (
      identity.request as unknown as [
        string,
        string,
        {
          route: Record<string, Prisma.InputJsonValue>;
          args: Record<string, Prisma.InputJsonValue>;
        },
      ]
    )[2];
    if (boundary === "missing") identity.effectId = "missing-read-effect";
    if (boundary === "status")
      await prisma.externalEffect.update({
        where: { id: identity.effectId },
        data: { status: "executing" },
      });
    if (boundary === "run")
      await prisma.externalEffect.update({
        where: { id: identity.effectId },
        data: { runId: wrongRunId },
      });
    if (boundary === "space")
      await prisma.externalEffect.update({
        where: { id: identity.effectId },
        data: { spaceId: otherSpaceId },
      });
    if (boundary === "result") identity.rawResult = { rows: [{ invented: true }] };
    if (boundary === "request") payload.args.task_id = "changed-after-native-recording";
    if (boundary === "server") payload.route.resourceId = "another-server";
    if (boundary === "revision") payload.route.resourceRevision = 2;
    if (boundary === "tool") payload.route.toolName = "get_task";
    if (boundary === "task") payload.args.task_id = "another-task";
    if (boundary === "extra-route") payload.route.invented = true;
    if (boundary === "catalog-id")
      identity.request = [
        "__rakazoCatalogTool",
        "connectors_execute_tool",
        { id: "another-server:get_rows", arguments: payload.args },
        payload.route,
      ];
    if (["server", "revision", "tool", "task", "extra-route", "catalog-id"].includes(boundary))
      await prisma.externalEffect.update({
        where: { id: identity.effectId },
        data: { request: identity.request },
      });
    const input = {
      ...identity,
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows" as const,
      outputArtifact: f.metadata("invalid-output", "e".repeat(64)),
    };
    await expect(
      recordResearchRead(input, boundary === "actor" ? { ...actor, userId: otherUserId } : actor),
    ).rejects.toThrow(IsolationError);
    expect(
      (
        await prisma.recruitingResearchAction.findUniqueOrThrow({
          where: { id: prepared.action.id },
        })
      ).outputArtifacts,
    ).toEqual([]);
    expect(
      await prisma.artifact.count({ where: { clientNonce: input.outputArtifact.clientNonce } }),
    ).toBe(0);
  });

  it("records distinct native catalog and direct reads of identical content across capture runs", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const identity = await completedResearchRead(
      f,
      prepared.action.id,
      "catalog-page",
      "get_rows",
      { rows: [{ value: "same" }] },
    );
    const route = {
      connectorId: "mcp",
      resourceId: f.server.id,
      resourceRevision: f.server.revision,
      toolName: "get_rows",
    };
    identity.request = [
      "__rakazoCatalogTool",
      "connectors_execute_tool",
      {
        id: `${f.server.id}:get_rows`,
        arguments: { task_id: "provider-task" },
      },
      route,
    ];
    await prisma.externalEffect.update({
      where: { id: identity.effectId },
      data: { request: identity.request },
    });
    const first = await recordResearchRead({
      ...identity,
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows",
      outputArtifact: f.metadata("catalog-page", "e".repeat(64)),
      cursor: "next",
    });
    const lease = await nextResearchRun(f);
    const next = { ...f, run: await prisma.run.findUniqueOrThrow({ where: { id: lease.runId } }) };
    const repeated = await completedResearchRead(
      next,
      prepared.action.id,
      "direct-page",
      "get_rows",
      identity.rawResult,
    );
    const second = await recordResearchRead({
      ...repeated,
      runId: next.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows",
      cursor: "next",
      outputArtifact: {
        ...f.metadata("same-page-new-run", "e".repeat(64)),
        clientNonce: `page:${next.run.id}:${hash}`,
      },
    });
    expect(second.outputArtifact.id).not.toBe(first.outputArtifact.id);
    expect(second.action.outputArtifacts).toHaveLength(2);
  });

  function researchAdmission(
    f: Awaited<ReturnType<typeof researchFixture>>,
    prepared: Awaited<ReturnType<typeof recruiting.prepareRecruitingResearchAction>>,
  ) {
    return {
      ...f.lease,
      actionId: prepared.action.id,
      requestArtifact: {
        artifactId: prepared.requestArtifact.id,
        sha256: prepared.requestArtifact.hash,
      },
      contextArtifact: f.input.contextArtifact,
      frozenRequest: f.input.frozenRequest,
      effectKind: f.input.effectKind,
    };
  }

  it("pins the first dispatch effect to its actual run and returns busy to another active run", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
    const dispatch = await nextResearchRun(f);
    const admitted = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...dispatch,
    });
    expect(admitted.status).toBe("ready");
    expect(admitted.effect).toMatchObject({
      runId: dispatch.runId,
      idempotencyKey: `recruiting-research:${prepared.action.id}`,
      status: "intended",
    });
    expect(admitted.action.runId).toBe(f.run.id);
    const third = await nextResearchRun(f);
    const busy = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...third,
    });
    expect(busy).toMatchObject({ status: "busy", ownerRunId: dispatch.runId });
    expect(
      (await recruiting.listRecruitingResearch(prisma, actor, { roleId: f.role.role.id }))
        .actions[0]?.effectId,
    ).toBe(admitted.effect!.id);
  });

  it.each(["owner", "fence", "expired"])(
    "fences research admission and claim against an invalid lease %s",
    async (boundary) => {
      const f = await researchFixture();
      const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
      const invalid = {
        ...f.lease,
        ...(boundary === "owner" ? { leaseOwner: "stale-worker" } : {}),
        ...(boundary === "fence" ? { leaseFence: 0 } : {}),
      };
      if (boundary === "expired")
        await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
      await expect(
        recruiting.admitRecruitingResearchAction(prisma, actor, {
          ...researchAdmission(f, prepared),
          ...invalid,
        }),
      ).rejects.toThrow(IsolationError);
      expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(0);
      await prisma.run.update({
        where: { id: f.run.id },
        data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      const admitted = await recruiting.admitRecruitingResearchAction(
        prisma,
        actor,
        researchAdmission(f, prepared),
      );
      if (boundary === "expired")
        await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
      await expect(
        recruiting.claimRecruitingResearchAction(prisma, actor, {
          ...invalid,
          actionId: prepared.action.id,
          effectId: admitted.effect!.id,
          from: "intended",
        }),
      ).rejects.toThrow(IsolationError);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }))
          .status,
      ).toBe("intended");
    },
  );

  it.each([
    "role",
    "source",
    "server-disabled",
    "server-revision",
    "assignment",
    "origin-cancelled",
  ])("supersedes an unclaimed research action after its %s changes", async (boundary) => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    let lease = f.lease;
    if (boundary === "role")
      await recruiting.reviseRecruitingRole(prisma, actor, {
        roleId: f.role.role.id,
        expectedRevision: 1,
        title: "Revised role",
        sourceRefs: [source(f.original.id)],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
      });
    if (boundary === "source") {
      const message = await recruiting.createThreadMessage(prisma, {
        threadId: f.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "Hold this search" }],
      });
      await prisma.steeringMessage.create({
        data: { messageId: message.id, userId, botId, runId: f.run.id, claimedAt: new Date() },
      });
    }
    if (boundary === "server-disabled")
      await prisma.mcpServer.update({ where: { id: f.server.id }, data: { enabled: false } });
    if (boundary === "server-revision")
      await prisma.mcpServer.update({ where: { id: f.server.id }, data: { revision: 2 } });
    if (boundary === "assignment")
      await prisma.botMcpServer.updateMany({
        where: { serverId: f.server.id },
        data: { allowedTools: ["get_task"] },
      });
    if (boundary === "origin-cancelled") {
      await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
      lease = await nextResearchRun(f);
    }
    const result = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...lease,
    });
    expect(result.status).toBe("superseded");
    expect(result.action.deliveryState).toBe("superseded");
    expect(
      await prisma.externalEffect.count({
        where: { idempotencyKey: `recruiting-research:${prepared.action.id}` },
      }),
    ).toBe(0);
  });

  it("transfers the same approved unclaimed effect after owner failure and never after cancellation", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
    const first = await nextResearchRun(f);
    const admitted = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...first,
    });
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "approved" },
    });
    await prisma.run.update({ where: { id: first.runId }, data: { status: "failed" } });
    const next = await nextResearchRun(f);
    const transferred = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...next,
    });
    expect(transferred).toMatchObject({
      status: "ready",
      effect: { id: admitted.effect!.id, runId: next.runId, status: "approved" },
    });
    await prisma.run.update({ where: { id: next.runId }, data: { status: "cancelled" } });
    const last = await nextResearchRun(f);
    const rejected = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...last,
    });
    expect(rejected).toMatchObject({
      status: "superseded",
      effect: { id: admitted.effect!.id, runId: next.runId },
    });
  });

  it("returns busy for another live dispatch and unknown after its executing owner fails", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    await recruiting.claimRecruitingResearchAction(prisma, actor, {
      ...f.lease,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      from: "intended",
    });
    const next = await nextResearchRun(f);
    const busy = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...next,
    });
    expect(busy.status).toBe("busy");
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "failed" } });
    const unknown = await recruiting.admitRecruitingResearchAction(prisma, actor, {
      ...researchAdmission(f, prepared),
      ...next,
    });
    expect(unknown).toMatchObject({
      status: "unknown",
      effect: { id: admitted.effect!.id, runId: f.run.id, status: "executing" },
    });
    expect(
      await prisma.externalEffect.count({
        where: { idempotencyKey: `recruiting-research:${prepared.action.id}` },
      }),
    ).toBe(1);
  });

  it("reuses completed raw results after origin cancellation, role revision, and provider permission changes", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    const rawResult = { task_id: "completed-provider-task", state: "queued" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
    const next = await nextResearchRun(f);
    await recruiting.reviseRecruitingRole(prisma, actor, {
      roleId: f.role.role.id,
      expectedRevision: 1,
      title: "New requirements",
      sourceRefs: [source(f.original.id)],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    });
    await prisma.mcpServer.update({
      where: { id: f.server.id },
      data: { enabled: false, revision: 2 },
    });
    await prisma.botMcpServer.deleteMany({ where: { serverId: f.server.id } });
    const historical = await recruiting.readRecruitingResearchContext(prisma, actor, {
      runId: next.runId,
      actionId: prepared.action.id,
      historical: true,
    });
    expect(historical.effect?.result).toEqual(rawResult);
    await expect(
      recruiting.readRecruitingResearchContext(prisma, actor, {
        runId: next.runId,
        actionId: prepared.action.id,
        toolName: "get_task",
      }),
    ).rejects.toThrow(IsolationError);
    expect(
      (
        await recruiting.admitRecruitingResearchAction(prisma, actor, {
          ...researchAdmission(f, prepared),
          ...next,
        })
      ).status,
    ).toBe("completed");
    const reconciled = await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: next.runId,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      receiptArtifact: f.metadata("recovered-receipt"),
      deliveryState: "accepted",
      providerTaskId: "completed-provider-task",
    });
    expect(reconciled.action.roleRevisionId).toBe(f.role.revision.id);
    expect(reconciled.task.providerTaskId).toBe("completed-provider-task");
    await expect(
      recruiting.readRecruitingResearchContext(
        prisma,
        { ...actor, userId: otherUserId },
        { runId: next.runId, actionId: prepared.action.id, historical: true },
      ),
    ).rejects.toThrow(IsolationError);
  });

  it("claims a prepared research action and native effect once across two database connections", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    const second = createDb(databaseUrl!);
    try {
      const input = {
        ...f.lease,
        actionId: prepared.action.id,
        effectId: admitted.effect!.id,
        from: "intended" as const,
      };
      const results = await Promise.all([
        recruiting.claimRecruitingResearchAction(prisma, actor, input),
        recruiting.claimRecruitingResearchAction(second.prisma, actor, input),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(
        await prisma.externalEffect.findUniqueOrThrow({ where: { id: input.effectId } }),
      ).toMatchObject({ status: "executing" });
      expect(
        await prisma.recruitingResearchAction.findUniqueOrThrow({
          where: { id: prepared.action.id },
        }),
      ).toMatchObject({ deliveryState: "sending" });
      expect(
        await prisma.event.count({
          where: {
            runId: f.run.id,
            type: "recruiting.action.transitioned",
            payload: { path: ["to"], equals: "sending" },
          },
        }),
      ).toBe(1);
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it("rechecks the role at the final native claim and leaves an obsolete approved effect unsent", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "approved" },
    });
    await recruiting.reviseRecruitingRole(prisma, actor, {
      roleId: f.role.role.id,
      expectedRevision: 1,
      title: "Changed before dispatch",
      sourceRefs: [source(f.original.id)],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    });
    expect(
      await recruiting.claimRecruitingResearchAction(prisma, actor, {
        ...f.lease,
        actionId: prepared.action.id,
        effectId: admitted.effect!.id,
        from: "approved",
      }),
    ).toBe(false);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }))
        .status,
    ).toBe("approved");
    expect(
      (
        await prisma.recruitingResearchAction.findUniqueOrThrow({
          where: { id: prepared.action.id },
        })
      ).deliveryState,
    ).toBe("superseded");
  });

  it.each([false, true])(
    "prepares a corrected revision directly after superseding an unsent action (effect reserved: %s)",
    async (reserved) => {
      const f = await researchFixture();
      const previous = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
      const admitted = reserved
        ? await recruiting.admitRecruitingResearchAction(
            prisma,
            actor,
            researchAdmission(f, previous),
          )
        : null;
      if (admitted)
        await prisma.externalEffect.update({
          where: { id: admitted.effect!.id },
          data: { status: "approved" },
        });
      const revised = await recruiting.reviseRecruitingRole(prisma, actor, {
        roleId: f.role.role.id,
        expectedRevision: 1,
        title: "Corrected role",
        sourceRefs: [source(f.original.id)],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
      });
      const adopted = await recruiting.recordRecruitingContextAdoption(prisma, actor, {
        runId: f.run.id,
        threadId: f.thread.id,
        botId,
        roleId: revised.role.id,
        roleRevisionId: revised.revision.id,
        sourceMessageId: f.original.id,
        artifact: f.metadata("context-corrected"),
      });
      const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, {
        ...f.input,
        expectedRoleRevision: 2,
        clientNonce: `${f.input.clientNonce}-corrected`,
        requestArtifact: f.metadata("request-corrected"),
        contextArtifact: { artifactId: adopted.artifact.id, sha256: adopted.artifact.hash },
      });
      expect(prepared.action.roleRevisionId).toBe(revised.revision.id);
      expect(prepared.action.id).not.toBe(previous.action.id);
      expect(
        (
          await prisma.recruitingResearchAction.findUniqueOrThrow({
            where: { id: previous.action.id },
          })
        ).deliveryState,
      ).toBe("superseded");
      expect(
        await prisma.recruitingResearchTask.findUniqueOrThrow({ where: { id: previous.task.id } }),
      ).toMatchObject({ state: "closed", pendingActionId: null });
      if (admitted)
        expect(
          (await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }))
            .status,
        ).toBe("approved");
    },
  );

  it("treats provider-shaped receipt metadata as raw input until a real domain receipt is linked", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    const rawResult = {
      providerResult: { task_id: "invented-provider-task" },
      recruitingReceipt: { version: 1, actionId: prepared.action.id, deliveryState: "accepted" },
    };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    const input = {
      runId: f.run.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      receiptArtifact: f.metadata("receipt"),
      deliveryState: "unknown" as const,
    };
    await expect(
      recruiting.reconcileRecruitingResearchAction(prisma, actor, {
        ...input,
        rawResult: rawResult.providerResult,
      }),
    ).rejects.toThrow(IsolationError);
    const first = await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      ...input,
      rawResult,
    });
    const repeat = await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      ...input,
      rawResult,
    });
    expect(repeat.receiptArtifact.id).toBe(first.receiptArtifact.id);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }))
        .result,
    ).toMatchObject({ providerResult: rawResult });
    expect(repeat.task.providerTaskId).toBeNull();
  });

  it("requires a completed raw native receipt before mapping and blocks a new unknown creation", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    await recruiting.claimRecruitingResearchAction(prisma, actor, {
      ...f.lease,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      from: "intended",
    });
    const rawResult = { error: "Connection lost after dispatch" };
    const input = {
      runId: f.run.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      receiptArtifact: f.metadata("receipt"),
      deliveryState: "unknown" as const,
    };
    await expect(
      recruiting.reconcileRecruitingResearchAction(prisma, actor, input),
    ).rejects.toThrow(IsolationError);
    expect(
      await prisma.artifact.count({ where: { clientNonce: input.receiptArtifact.clientNonce } }),
    ).toBe(0);
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    const reconciled = await recruiting.reconcileRecruitingResearchAction(prisma, actor, input);
    expect(reconciled.action).toMatchObject({
      deliveryState: "unknown",
      receiptArtifactId: reconciled.receiptArtifact.id,
    });
    expect(reconciled.task).toMatchObject({ state: "unknown", providerTaskId: null });
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }))
        .result,
    ).toMatchObject({
      providerResult: rawResult,
      recruitingReceipt: { version: 1, actionId: prepared.action.id },
    });
    await expect(
      recruiting.prepareRecruitingResearchAction(prisma, actor, {
        ...f.input,
        clientNonce: `${f.input.clientNonce}-another`,
        requestArtifact: f.metadata("request-another"),
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
  });

  it("keeps queued acceptance separate from completion and continues the same provider task", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    await recruiting.claimRecruitingResearchAction(prisma, actor, {
      ...f.lease,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      from: "intended",
    });
    const rawResult = { task_id: "provider-task", state: "queued" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    const reconciled = await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      receiptArtifact: f.metadata("receipt"),
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      observedProviderState: "queued",
      taskState: "active",
      providerApplicationConfirmed: false,
      usage: [{ scope: "task", unit: "credits", amount: 2 }],
    });
    expect(reconciled.task).toMatchObject({
      state: "active",
      providerTaskId: "provider-task",
      pendingActionId: prepared.action.id,
    });
    const continued = await recruiting.prepareRecruitingResearchAction(prisma, actor, {
      ...f.input,
      kind: "continue",
      taskId: prepared.task.id,
      clientNonce: `${f.input.clientNonce}-continue`,
      requestArtifact: f.metadata("followup"),
    });
    expect(continued.task.id).toBe(prepared.task.id);
    expect(continued.task.providerTaskId).toBe("provider-task");
    expect(continued.action.kind).toBe("continue");
  });

  it("preserves mutation receipt while rows snapshots retain changed bytes at the same cursor", async () => {
    const f = await researchFixture();
    const prepared = await recruiting.prepareRecruitingResearchAction(prisma, actor, f.input);
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, prepared),
    );
    const rawResult = { task_id: "provider-task" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    const mapped = await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      receiptArtifact: f.metadata("receipt"),
    });
    const input = {
      ...(await completedResearchRead(f, prepared.action.id, "rows-one", "get_rows", {
        rows: [{ value: "one" }],
      })),
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows" as const,
      outputArtifact: f.metadata("rows-one", "b".repeat(64)),
      cursor: "same-cursor",
    };
    const first = await recordResearchRead(input);
    const duplicate = await recordResearchRead({
      ...input,
      outputArtifact: { ...f.metadata("rows-duplicate", "b".repeat(64)) },
    });
    expect(duplicate.outputArtifact.id).toBe(first.outputArtifact.id);
    const changed = await recordResearchRead({
      ...input,
      ...(await completedResearchRead(f, prepared.action.id, "rows-changed", "get_rows", {
        rows: [{ value: "changed" }],
      })),
      outputArtifact: f.metadata("rows-changed", "c".repeat(64)),
    });
    expect(changed.action.outputArtifacts).toEqual([
      { artifactId: first.outputArtifact.id, sha256: "b".repeat(64) },
      { artifactId: changed.outputArtifact.id, sha256: "c".repeat(64) },
    ]);
    expect(changed.action.receiptArtifactId).toBe(mapped.receiptArtifact.id);
    expect(changed.action.effectId).toBe(admitted.effect!.id);
    expect(changed.action.cursor).toBe("same-cursor");
    const next = await recordResearchRead({
      ...input,
      ...(await completedResearchRead(f, prepared.action.id, "rows-next", "get_rows", {
        rows: [{ value: "changed" }],
        next_cursor: "next-cursor",
      })),
      outputArtifact: f.metadata("rows-next", "c".repeat(64)),
      cursor: "next-cursor",
    });
    expect(next.action.outputArtifacts).toHaveLength(3);
    expect(next.outputArtifact.id).not.toBe(changed.outputArtifact.id);
    const completed = await recordResearchRead({
      ...(await completedResearchRead(f, prepared.action.id, "status-completed", "get_task", {
        state: "completed",
      })),
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_task",
      taskState: "completed",
      observedProviderState: "completed",
      outputArtifact: f.metadata("status-completed", "d".repeat(64)),
    });
    expect(completed.task.pendingActionId).toBe(prepared.action.id);
    const historical = await recruiting.readRecruitingResearchContext(prisma, actor, {
      runId: f.run.id,
      taskId: prepared.task.id,
      toolName: "get_rows",
    });
    expect(historical.action?.id).toBe(prepared.action.id);
    expect(historical.action?.receiptArtifactId).toBe(mapped.receiptArtifact.id);
  });
});
