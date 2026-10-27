import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type {
  Actor,
  CreateRecruitingRoleInput,
  MessageBlock,
  NativeAskAnswerPayload,
  RecruitingApprovalToolInput,
  RecruitingAssessmentAskInput,
  RecruitingAssessmentSourceRef,
  RecruitingRoleToolInput,
  RecruitingSourceRef,
  SaveRecruitingAssessmentInput,
} from "@rakazo/contracts";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { guardRecruitingTurnEnd } from "../../adapters/src/turn-end-guard.js";
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
  let sourceQueries: string[] | undefined;
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
    const message = await recruiting.createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text }],
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
  async function mutateRole(
    db: PrismaClient,
    owner: Actor,
    context: { runId: string; sourceMessageId: string | null },
    input: recruiting.RecruitingRoleMutationInput,
    material?: recruiting.RecruitingRoleMaterialContext,
  ) {
    const run = await prisma.run.update({
      where: { id: context.runId },
      data: {
        leaseOwner: "native-role-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "recruiting_role",
        idempotencyKey: `role:${crypto.randomUUID()}`,
        status: "executing",
        request: input as Prisma.InputJsonValue,
      },
    });
    return recruiting.executeRecruitingRoleMutation(
      db,
      owner,
      {
        ...context,
        threadId: run.threadId,
        botId: run.botId,
        leaseOwner: "native-role-worker",
        leaseFence: 1,
        effectId: effect.id,
        effectRequest: input,
      },
      input,
      material,
    );
  }

  async function roleMutationFixture(operation: "create" | "revise" = "create") {
    const f = await assessmentFixture("Create and revise this supplied role");
    const bytes = Buffer.from(
      JSON.stringify({ text: "At least seven years of software experience" }),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const readAt = "2026-10-16T00:00:00Z";
    const material = await recruiting.recordRecruitingWebMaterial(prisma, actor, f.context, {
      artifact: {
        name: "native-role-proof.json",
        mimeType: "application/json",
        size: bytes.length,
        hash,
        storageKey: `native-role-${f.run.id}`,
        clientNonce: `native-role-${f.run.id}`,
      },
      reader: "web_fetch",
      url: "https://example.test/role",
      readAt,
    });
    const ref: RecruitingSourceRef = {
      id: "role-material",
      kind: "original_material",
      readState: "read",
      readAt,
      quote: "At least seven years of software experience",
      url: "https://example.test/role",
      anchor: {
        kind: "artifact",
        artifact: { artifactId: material.artifact.id, sha256: hash },
        locator: "text",
      },
    };
    const reader = {
      artifacts: { get: async () => bytes } as unknown as ArtifactStore,
      context: {
        spaceId,
        userId,
        botId,
        runId: f.run.id,
        operationId: f.run.id,
        traceId: f.run.id,
        signal: new AbortController().signal,
      },
    };
    const input = {
      operation,
      title: "Atomic native role",
      sourceRefs: [ref],
      criteria: [{ ...roleInput().criteria[0]!, sourceRefs: [ref] }],
      preferences: [],
      definitionQuestions: [],
      intent: { basis: "direct" as const, quote: "Create and revise this supplied role" },
      ...(operation === "revise" ? { roleId: f.role.role.id, expectedRevision: 1 } : {}),
    } as recruiting.RecruitingRoleMutationInput;
    await prisma.externalEffect.update({
      where: { id: f.context.effectId },
      data: { kind: "recruiting_role", request: input as Prisma.InputJsonValue },
    });
    const context = { ...f.context, sourceMessageId: f.message.id, effectRequest: input };
    return { ...f, input, context, reader };
  }

  it.each(["create", "revise"] as const)(
    "atomically recovers native role %s after commit ACK loss without overriding newer human state",
    async (operation) => {
      const f = await roleMutationFixture(operation);
      const steering = await recruiting.createThreadMessage(prisma, {
        threadId: f.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: f.input.intent.quote }],
      });
      await prisma.steeringMessage.create({
        data: { messageId: steering.id, userId, botId, runId: f.run.id, claimedAt: new Date() },
      });
      f.context.sourceMessageId = steering.id;
      const lostAck = {
        $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          const result = await prisma.$transaction(callback);
          if (result && typeof result === "object" && "status" in result)
            throw new Error("simulated role commit ACK loss");
          return result;
        },
      } as unknown as PrismaClient;
      await expect(
        recruiting.executeRecruitingRoleMutation(lostAck, actor, f.context, f.input, f.reader),
      ).rejects.toThrow("commit ACK loss");
      const effect = await prisma.externalEffect.findUniqueOrThrow({
        where: { id: f.context.effectId },
      });
      expect(effect.status).toBe("completed");
      const result = effect.result as unknown as recruiting.RecruitingRoleToolResult;
      // Serialize the actual completed receipt in its historical pre-brief JSON format.
      const { brief: _brief, ...legacyRevision } = result.workspace!.revision;
      const saved = { ...result, workspace: { ...result.workspace!, revision: legacyRevision } };
      await prisma.externalEffect.update({
        where: { id: effect.id },
        data: { result: saved as unknown as Prisma.InputJsonValue },
      });
      const revisionCount = await prisma.recruitingRoleRevision.count({
        where: { roleId: saved.workspace!.role.id },
      });
      const { sourceThreadId: _sourceThreadId, ...newDefinition } = roleInput(source(steering.id));
      const humanRevision = await recruiting.reviseRecruitingRole(prisma, actor, {
        ...newDefinition,
        roleId: saved.workspace!.role.id,
        expectedRevision: saved.workspace!.role.revision,
        title: "New human revision",
      });
      const newer = await recruiting.createRecruitingRole(prisma, actor, {
        ...roleInput(source(f.message.id)),
        title: "New human choice",
        sourceThreadId: f.thread.id,
      });
      await prisma.run.update({
        where: { id: f.run.id },
        data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
      });
      await prisma.steeringMessage.deleteMany({ where: { runId: f.run.id } });
      const roleCount = await prisma.recruitingRole.count({
        where: { sourceThreadId: f.thread.id },
      });
      const restored = createDb(databaseUrl!);
      try {
        expect(
          await recruiting.executeRecruitingRoleMutation(
            restored.prisma,
            actor,
            f.context,
            f.input,
            f.reader,
          ),
        ).toEqual(saved);
        expect(
          (
            await recruiting.getRecruitingWorkspace(restored.prisma, actor, {
              threadId: f.thread.id,
            })
          )?.role.id,
        ).toBe(newer.role.id);
        expect(
          await restored.prisma.recruitingRoleRevision.count({
            where: { roleId: saved.workspace!.role.id },
          }),
        ).toBe(revisionCount + 1);
        expect(
          (
            await restored.prisma.recruitingRole.findUniqueOrThrow({
              where: { id: saved.workspace!.role.id },
            })
          ).currentRevisionId,
        ).toBe(humanRevision.revision.id);
        expect(
          await restored.prisma.recruitingRole.count({ where: { sourceThreadId: f.thread.id } }),
        ).toBe(roleCount);
        expect(
          await restored.prisma.event.count({
            where: {
              runId: f.run.id,
              type: "effect.recorded",
              payload: { path: ["effectId"], equals: f.context.effectId },
            },
          }),
        ).toBe(1);
        await expect(
          recruiting.executeRecruitingRoleMutation(restored.prisma, actor, f.context, f.input, {
            ...f.reader,
            artifacts: {
              get: async () => Buffer.from("corrupted original bytes"),
            } as unknown as ArtifactStore,
          }),
        ).rejects.toThrow(IsolationError);
        expect(
          (
            await restored.prisma.externalEffect.findUniqueOrThrow({
              where: { id: f.context.effectId },
            })
          ).result,
        ).toEqual(saved);
      } finally {
        await restored.prisma.$disconnect();
        await restored.pool.end();
      }
    },
  );

  it.each(["bind", "clear", "inferred"] as const)(
    "replays a completed native %s without changing a later human binding",
    async (kind) => {
      const f = await roleMutationFixture();
      const input: recruiting.RecruitingRoleMutationInput =
        kind === "inferred"
          ? { ...f.input, intent: { ...f.input.intent, basis: "inferred" } }
          : {
              operation: "bind",
              roleId: kind === "clear" ? null : f.role.role.id,
              intent: f.input.intent,
            };
      const context = { ...f.context, effectRequest: input };
      await prisma.externalEffect.update({
        where: { id: context.effectId },
        data: { request: input as Prisma.InputJsonValue },
      });
      const saved = await recruiting.executeRecruitingRoleMutation(
        prisma,
        actor,
        context,
        input,
        f.reader,
      );
      expect(saved).toMatchObject(
        kind === "inferred"
          ? { status: "needs_clarification", changed: false }
          : { status: "saved", changed: kind === "clear" },
      );
      const newer = await recruiting.createRecruitingRole(prisma, actor, {
        ...roleInput(source(f.message.id)),
        sourceThreadId: f.thread.id,
        title: "Later human role",
      });
      await prisma.run.update({
        where: { id: f.run.id },
        data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
      });
      expect(
        await recruiting.executeRecruitingRoleMutation(prisma, actor, context, input, f.reader),
      ).toEqual(saved);
      expect(
        (await recruiting.getRecruitingWorkspace(prisma, actor, { threadId: f.thread.id }))?.role
          .id,
      ).toBe(newer.role.id);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: context.effectId } })).result,
      ).toEqual(saved);
      expect(
        await prisma.event.count({
          where: {
            runId: f.run.id,
            type: "effect.recorded",
            payload: { path: ["effectId"], equals: context.effectId },
          },
        }),
      ).toBe(1);
    },
  );

  it.each(["receipt", "event"] as const)(
    "rolls back the role domain when native %s persistence fails",
    async (boundary) => {
      const f = await roleMutationFixture();
      const before = await prisma.recruitingRole.count();
      const failing = {
        $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          prisma.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  if (key === "externalEffect" && boundary === "receipt")
                    return { ...target.externalEffect, updateMany: async () => ({ count: 0 }) };
                  if (key === "event" && boundary === "event")
                    return {
                      ...target.event,
                      create: async () => {
                        throw new Error("role receipt event failed");
                      },
                    };
                  return Reflect.get(target, key);
                },
              }),
            ),
          ),
      } as unknown as PrismaClient;
      await expect(
        recruiting.executeRecruitingRoleMutation(failing, actor, f.context, f.input, f.reader),
      ).rejects.toThrow();
      expect(await prisma.recruitingRole.count()).toBe(before);
      expect(
        (await recruiting.getRecruitingWorkspace(prisma, actor, { threadId: f.thread.id }))?.role
          .id,
      ).toBe(f.role.role.id);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.context.effectId } }))
          .status,
      ).toBe("executing");
    },
  );

  it("rejects native role identity, request and lease mismatches and revalidates completed source ACL", async () => {
    const f = await roleMutationFixture();
    for (const change of [
      { effectId: "missing-effect" },
      { threadId: "other-thread" },
      { botId: "other-bot" },
      { leaseOwner: "other-worker" },
      { leaseFence: 2 },
      { effectRequest: { ...f.input, title: "Changed request" } },
    ])
      await expect(
        recruiting.executeRecruitingRoleMutation(
          prisma,
          actor,
          { ...f.context, ...change },
          f.input,
          f.reader,
        ),
      ).rejects.toThrow(IsolationError);
    await expect(
      recruiting.executeRecruitingRoleMutation(
        prisma,
        { ...actor, userId: otherUserId },
        f.context,
        f.input,
        f.reader,
      ),
    ).rejects.toThrow(IsolationError);
    await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
    await expect(
      recruiting.executeRecruitingRoleMutation(prisma, actor, f.context, f.input, f.reader),
    ).rejects.toThrow(IsolationError);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60000) },
    });
    const saved = await recruiting.executeRecruitingRoleMutation(
      prisma,
      actor,
      f.context,
      f.input,
      f.reader,
    );
    await prisma.message.update({
      where: { id: f.message.id },
      data: { blocks: [{ kind: "text", text: "Edited original source" }] },
    });
    await expect(
      recruiting.executeRecruitingRoleMutation(prisma, actor, f.context, f.input, f.reader),
    ).rejects.toThrow();
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.context.effectId } })).result,
    ).toEqual(saved);
  });

  async function questionFixture(candidate = false) {
    const f = await assessmentFixture();
    if (candidate)
      await recruiting.saveRecruitingAssessment(prisma, actor, f.context, f.input, f.artifacts);
    const request: RecruitingAssessmentAskInput = {
      operation: "ask",
      roleId: f.role.role.id,
      roleRevisionId: f.role.revision.id,
      target: candidate
        ? {
            kind: "candidate",
            candidateKey: f.input.candidateKey,
            assessmentVersion: 1,
            criterionIds: ["experience"],
          }
        : { kind: "role", criterionIds: ["experience"] },
      question: "  Which evidence should be verified?  ",
      options: ["Employment history", "Personal code"],
    };
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: "recruiting_assess",
        status: "executing",
        idempotencyKey: `question:${f.run.id}`,
        request: request as Prisma.InputJsonValue,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: f.run.id, fence: 1, status: "running" },
    });
    const actions = request.options.map((label, index) => ({ id: `choice-${index + 1}`, label }));
    const pause: recruiting.PauseRunForInput = {
      spaceId,
      threadId: f.thread.id,
      botId,
      runId: f.run.id,
      attemptId: attempt.id,
      leaseOwner: f.context.leaseOwner,
      leaseFence: 1,
      blocks: [{ kind: "ask", text: request.question, actions, status: "pending" }],
      offeredActions: actions,
      recruitingQuestion: {
        actor,
        effectId: effect.id,
        effectRequest: request,
        contextArtifact: f.context.contextArtifact,
        artifacts: f.artifacts,
      },
    };
    const lookup = { threadId: f.thread.id, roleId: f.role.role.id, effectId: effect.id };
    return { ...f, request, effect, attempt, pause, lookup };
  }
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    db.pool.on("connect", (client) => {
      const query = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const statement = args[0] as string | { text?: string };
        const text = typeof statement === "string" ? statement : statement.text;
        if (text) sourceQueries?.push(text);
        return Reflect.apply(query, client, args);
      }) as typeof client.query;
    });
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
    await prisma.recruitingReply.deleteMany({
      where: { effect: { spaceId: { in: [spaceId, otherSpaceId] } } },
    });
    await prisma.recruitingCrmImport.deleteMany({
      where: { effect: { spaceId: { in: [spaceId, otherSpaceId] } } },
    });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });
  it("keeps a native interactive transaction open beyond five seconds", async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(5.1)`;
      return tx.$queryRaw<{ alive: number }[]>`SELECT 1::int AS alive`;
    });
    expect(rows).toEqual([{ alive: 1 }]);
  }, 15_000);
  it("creates an independent identity, revision one and thread binding atomically", async () => {
    expect(recruiting.createRecruitingRole).toBeTypeOf("function");
    const first = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    firstRoleId = first.role.id;
    firstRevisionId = first.revision.id;
    expect(first.role).toMatchObject({ revision: 1, currentRevisionId: first.revision.id });
    expect(first.revision.sourceRefs).toEqual([source()]);
    expect(await recruiting.getRecruitingWorkspace(prisma, actor, { threadId })).toEqual({
      ...first,
      crmTarget: null,
    });
    const second = await recruiting.createRecruitingRole(prisma, actor, roleInput());
    expect(second.role.id).not.toBe(firstRoleId);
    expect(await recruiting.getRecruitingWorkspace(prisma, actor, { threadId })).toEqual({
      ...second,
      crmTarget: null,
    });
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
  // 2026-10-26: a role from a sent link failed on the model's copy of its page reference, and a
  // brief that failed one check kept the whole role from being saved.
  it("fills a link role's page reference from its records and saves the role when only its brief fails", async () => {
    const f = await roleMutationFixture("create");
    if (f.input.operation !== "create") throw new Error("fixture is not a create");
    const page = f.input.sourceRefs[0]!;
    if (page.anchor.kind !== "artifact") throw new Error("fixture page is a file");
    const copied = {
      ...page,
      url: `${page.url}/`,
      readAt: "2026-10-16T00:00:00.000Z",
      anchor: {
        kind: "artifact",
        artifact: { ...page.anchor.artifact, sha256: "b".repeat(64) },
        locator: "page",
      },
    };
    const input = await recruiting.fillRecruitingRoleArgs(
      prisma,
      actor,
      { threadId: f.thread.id },
      {
        ...f.input,
        sourceRefs: [copied],
        criteria: [{ ...f.input.criteria[0]!, sourceRefs: [copied] }],
        brief: {
          fields: [
            {
              key: "location",
              value: null,
              origin: "jd",
              state: "known",
              sourceRefIds: ["role-material"],
            },
          ],
          searchFilters: [],
          questions: [],
          rules: [],
        },
      },
    );
    expect(input.sourceRefs).toEqual([page]);
    expect((input.brief as { rules: unknown[] }).rules).toEqual([
      { criterionId: "experience", origin: "jd", effect: "reject", sourceRefIds: [page.id] },
    ]);
    await prisma.externalEffect.update({
      where: { id: f.context.effectId },
      data: { request: input as Prisma.InputJsonValue },
    });
    const saved = await recruiting.executeRecruitingRoleMutation(
      prisma,
      actor,
      { ...f.context, effectRequest: input },
      input as recruiting.RecruitingRoleMutationInput,
      f.reader,
    );
    expect(saved).toMatchObject({
      status: "saved",
      briefError: "Known brief facts require a value.",
    });
    expect(saved.workspace?.revision.brief).toBeNull();
    expect(saved.workspace?.revision.sourceRefs).toContainEqual(page);
  });

  it("names the check a page reference failed and still refuses a file outside the account", async () => {
    const f = await roleMutationFixture("create");
    if (f.input.operation !== "create") throw new Error("fixture is not a create");
    const page = f.input.sourceRefs[0]!;
    if (page.anchor.kind !== "artifact") throw new Error("fixture page is a file");
    const stale = {
      ...f.input,
      sourceRefs: [
        {
          ...page,
          anchor: { ...page.anchor, artifact: { ...page.anchor.artifact, sha256: "b".repeat(64) } },
        },
      ],
      criteria: [],
    } as recruiting.RecruitingRoleMutationInput;
    await prisma.externalEffect.update({
      where: { id: f.context.effectId },
      data: { request: stale as Prisma.InputJsonValue },
    });
    await expect(
      recruiting.executeRecruitingRoleMutation(
        prisma,
        actor,
        { ...f.context, effectRequest: stale },
        stale,
        f.reader,
      ),
    ).rejects.toThrow(/sha256 is not this file's fingerprint/);
    const foreign = await recruiting.fillRecruitingRoleArgs(
      prisma,
      actor,
      { threadId: f.thread.id },
      {
        ...f.input,
        sourceRefs: [
          {
            ...page,
            anchor: {
              ...page.anchor,
              artifact: { artifactId: "someone-else", sha256: "c".repeat(64) },
            },
          },
        ],
        criteria: [],
      },
    );
    expect(JSON.stringify(foreign)).toContain("c".repeat(64));
    await prisma.externalEffect.update({
      where: { id: f.context.effectId },
      data: { request: foreign as Prisma.InputJsonValue },
    });
    const refused = recruiting.executeRecruitingRoleMutation(
      prisma,
      actor,
      { ...f.context, effectRequest: foreign },
      foreign as recruiting.RecruitingRoleMutationInput,
      f.reader,
    );
    await expect(refused).rejects.toThrow(IsolationError);
    await expect(refused).rejects.not.toBeInstanceOf(recruiting.RecruitingSourceCheckError);
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
    ]) {
      await expect(recruiting.createRecruitingRole(prisma, actor, roleInput(ref))).rejects.toThrow(
        "Resource not found",
      );
    }
    // The actor's own file with a wrong fingerprint is refused with the check to fix.
    await expect(
      recruiting.createRecruitingRole(
        prisma,
        actor,
        roleInput(artifactSource(artifactId, "b".repeat(64))),
      ),
    ).rejects.toThrow(recruiting.RecruitingSourceCheckError);
    const created = await recruiting.createRecruitingRole(
      prisma,
      actor,
      roleInput(artifactSource(artifactId)),
    );
    expect(created.revision.sourceRefs[0]?.anchor.kind).toBe("artifact");
    await recruiting.bindRecruitingRole(prisma, actor, { threadId, roleId: firstRoleId });
  });
  it("authenticates role quotes against native web material on both create and revise", async () => {
    const f = await assessmentFixture();
    const text =
      "Build geometry systems 👩🏽‍💻. Keep existing sensor tooling. Require seven years of experience.";
    const bytes = Buffer.from(
      JSON.stringify({ text, title: "Role", url: "https://example.test/jd" }),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const readAt = "2026-10-16T00:00:00.000Z";
    const material = await recruiting.recordRecruitingWebMaterial(prisma, actor, f.context, {
      artifact: {
        name: "role-material.json",
        mimeType: "application/json",
        size: bytes.length,
        hash,
        storageKey: `role-material-${f.run.id}`,
        clientNonce: `role-material-${f.run.id}`,
      },
      reader: "web_fetch",
      url: "https://example.test/jd",
      readAt,
    });
    const ref: RecruitingSourceRef = {
      id: "jd",
      kind: "original_material",
      anchor: {
        kind: "artifact",
        artifact: { artifactId: material.artifact.id, sha256: hash },
        locator: "text",
      },
      readState: "read",
      readAt,
      url: "https://example.test/jd",
      quote: "geometry systems 👩🏽‍💻",
    };
    const get = vi.fn(async () => bytes);
    const reader = {
      artifacts: { get } as unknown as ArtifactStore,
      context: {
        spaceId,
        userId,
        botId,
        runId: f.run.id,
        operationId: "role-source-check",
        traceId: "role-source-check",
        signal: new AbortController().signal,
      } satisfies AdapterContext,
    };
    for (const operation of ["create", "revise"] as const) {
      const { sourceThreadId: _, ...definition } = roleInput(ref);
      const write = (sourceRef: RecruitingSourceRef, trusted = reader) => {
        const input = {
          ...definition,
          sourceRefs: [sourceRef],
          criteria: [{ ...definition.criteria[0]!, sourceRefs: [sourceRef] }],
        };
        return operation === "create"
          ? recruiting.createRecruitingRole(
              prisma,
              actor,
              { ...input, sourceThreadId: f.thread.id },
              trusted,
            )
          : recruiting.reviseRecruitingRole(
              prisma,
              actor,
              {
                ...input,
                roleId: f.role.role.id,
                expectedRevision: 1,
              },
              trusted,
            );
      };
      const count = await prisma.recruitingRoleRevision.count();
      for (const invalid of [
        { ...ref, quote: text.replace(" Keep existing sensor tooling.", "") },
        { ...ref, quote: "Role" },
        { ...ref, anchor: { ...ref.anchor, locator: "title" } },
        { ...ref, readAt: "2026-10-17T00:00:00.000Z" },
      ]) {
        if (invalid.quote !== ref.quote) {
          const error = await write(invalid).catch((error: unknown) => error);
          expect(error).toMatchObject({
            name: "RecruitingSourceValidationError",
            message:
              'Source "jd" at "text": quote must be exact contiguous text from the original read receipt; copy one unchanged excerpt without omissions or joined passages.',
          });
          expect((error as Error).message).not.toContain(invalid.quote);
          expect((error as Error).message).not.toContain(text);
        } else {
          await expect(write(invalid)).rejects.toThrow(IsolationError);
        }
        expect(await prisma.recruitingRoleRevision.count()).toBe(count);
      }
      await expect(
        write(ref, {
          ...reader,
          artifacts: { get: async () => Buffer.from("wrong bytes") } as unknown as ArtifactStore,
        }),
      ).rejects.toThrow(IsolationError);
      const saved = await write(ref);
      expect(saved.revision.sourceRefs).toEqual([ref]);
      expect(saved.revision.criteria[0]?.sourceRefs).toEqual([ref]);
    }
    await expect(recruiting.createRecruitingRole(prisma, actor, roleInput(ref))).rejects.toThrow(
      IsolationError,
    );
    const { sourceThreadId: _, expectedRevision: _revision, ...definition } = roleInput(ref);
    const nativeInput = {
      ...definition,
      operation: "create" as const,
      intent: {
        basis: "direct" as const,
        quote: "Candidate personally implemented geometry transforms",
      },
    };
    const nativeContext = { runId: f.run.id, sourceMessageId: f.message.id };
    await expect(
      mutateRole(
        prisma,
        actor,
        nativeContext,
        { ...nativeInput, sourceRefs: [{ ...ref, quote: "Invented requirement" }] },
        reader,
      ),
    ).rejects.toMatchObject({ name: "RecruitingSourceValidationError" });
    const native = await mutateRole(prisma, actor, nativeContext, nativeInput, reader);
    expect(native.status).toBe("saved");
    expect(native.workspace?.revision.sourceRefs).toEqual(expect.arrayContaining([ref]));
    // Role-level and criterion references share the same exact Artifact read.
    expect(get).toHaveBeenCalledTimes(12);
    const count = await prisma.recruitingRoleRevision.count();
    try {
      await expect(
        recruiting.createRecruitingRole(prisma, actor, roleInput(ref), {
          ...reader,
          artifacts: {
            get: async () => {
              await prisma.artifact.update({
                where: { id: material.artifact.id },
                data: { hash: "b".repeat(64) },
              });
              return bytes;
            },
          } as unknown as ArtifactStore,
        }),
      ).rejects.toThrow(IsolationError);
      expect(await prisma.recruitingRoleRevision.count()).toBe(count);
    } finally {
      await prisma.artifact.update({ where: { id: material.artifact.id }, data: { hash } });
    }
  });
  it.each(["foreign", "hash", "bucket"])(
    "rejects unauthorized role material before loading bytes: %s",
    async (boundary) => {
      const ref: RecruitingSourceRef = {
        ...source(),
        quote: "At least seven years",
        anchor: {
          kind: "artifact",
          artifact: {
            artifactId:
              boundary === "foreign"
                ? otherArtifactId
                : boundary === "bucket"
                  ? wrongChatArtifactId
                  : artifactId,
            sha256: boundary === "hash" ? "b".repeat(64) : hash,
          },
          locator: "text",
        },
      };
      const get = vi.fn(async () => Buffer.from("At least seven years"));
      await expect(
        recruiting.createRecruitingRole(prisma, actor, roleInput(ref), {
          artifacts: { get } as unknown as ArtifactStore,
          context: {
            spaceId,
            userId,
            operationId: "role-source-check",
            traceId: "role-source-check",
            signal: new AbortController().signal,
          },
        }),
      ).rejects.toThrow(IsolationError);
      expect(get).not.toHaveBeenCalled();
    },
  );
  it.each(["artifact", "message"])(
    "reads one native %s once for distinct source excerpts in a mutation",
    async (kind) => {
      const f = await assessmentFixture();
      const excerpts = Array.from(
        { length: 8 },
        (_, index) =>
          `Requirement ${index + 1}: implement and maintain reliable data processing systems with clear ownership.`,
      );
      await prisma.message.update({
        where: { id: f.message.id },
        data: {
          blocks: [
            { kind: "text", text: "Candidate personally implemented geometry transforms" },
            ...excerpts.map((text) => ({ kind: "text", text })),
          ],
        },
      });
      const bytes = Buffer.from(
        JSON.stringify({ text: excerpts.join("\n"), title: "Synthetic role" }),
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const readAt = "2026-10-16T00:00:00.000Z";
      const material = await recruiting.recordRecruitingWebMaterial(prisma, actor, f.context, {
        artifact: {
          name: "distinct-excerpts.json",
          mimeType: "application/json",
          size: bytes.length,
          hash: sha256,
          storageKey: `distinct-excerpts-${f.run.id}`,
          clientNonce: `distinct-excerpts-${f.run.id}`,
        },
        reader: "web_fetch",
        url: "https://example.test/role",
        readAt,
      });
      const reader = {
        artifacts: { get: async () => bytes } as unknown as ArtifactStore,
        context: {
          spaceId,
          userId,
          botId,
          runId: f.run.id,
          operationId: f.run.id,
          traceId: f.run.id,
          signal: new AbortController().signal,
        },
      };
      const ref = (index: number): RecruitingSourceRef => ({
        id: "jd",
        kind: "original_material",
        readState: "read",
        readAt,
        url: "https://example.test/role",
        quote: excerpts[index],
        anchor:
          kind === "artifact"
            ? {
                kind: "artifact",
                artifact: { artifactId: material.artifact.id, sha256 },
                locator: "text",
              }
            : { kind: "message", messageId: f.message.id, locator: `blocks[${index + 1}].text` },
      });
      const input = (distinct: boolean) => ({
        operation: "create" as const,
        title: "Synthetic role",
        sourceRefs: [ref(0)],
        criteria: Array.from({ length: 7 }, (_, index) => ({
          id: `criterion-${index}`,
          priority: "hard" as const,
          expression: {
            kind: "atom" as const,
            id: `atom-${index}`,
            statement: `Requirement ${index + 1}`,
          },
          sourceRefs: [ref(distinct ? index + 1 : 0)],
          definitionQuestions: [],
        })),
        preferences: [],
        definitionQuestions: [],
        intent: {
          basis: "direct" as const,
          quote: "Candidate personally implemented geometry transforms",
        },
      });
      const context = { runId: f.run.id, sourceMessageId: f.message.id };
      const counts: number[] = [];
      for (const distinct of [false, true]) {
        await recruiting.bindRecruitingRole(prisma, actor, { threadId: f.thread.id, roleId: null });
        sourceQueries = [];
        let queries: string[];
        try {
          const result = await mutateRole(prisma, actor, context, input(distinct), reader);
          expect(result.status).toBe("saved");
          queries = sourceQueries;
        } finally {
          sourceQueries = undefined;
        }
        counts.push(queries.length);
        expect(
          queries.filter(
            (sql) =>
              sql.includes(`"${kind === "artifact" ? "artifacts" : "messages"}"`) &&
              sql.includes("FOR SHARE"),
          ),
        ).toHaveLength(1);
        if (kind === "artifact")
          expect(
            queries.filter((sql) => sql.includes('FROM "public"."recruiting_research_actions"')),
          ).toHaveLength(1);
      }
      expect(counts[1]).toBe(counts[0]);
      for (const state of ["unread", "unavailable", "read-noquote"] as const) {
        const { quote: _quote, ...reference } = ref(0);
        const mixed = {
          ...input(true),
          sourceRefs: [
            {
              ...reference,
              readState: state === "read-noquote" ? ("read" as const) : state,
              readAt: state === "unread" ? null : readAt,
            },
          ],
        };
        const result = await mutateRole(prisma, actor, context, mixed, reader);
        expect(result.workspace?.revision.sourceRefs[0]).toEqual(mixed.sourceRefs[0]);
        expect(result.workspace?.revision.sourceRefs[0]?.quote).toBeUndefined();
      }
      const request = input(true);
      const revisions = await prisma.recruitingRoleRevision.count();
      const selected = (await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } }))
        .activeRecruitingRoleId;
      const boundaries =
        kind === "artifact"
          ? (["quote", "readAt", "url", "hash", "kind", "locator"] as const)
          : (["quote", "kind", "locator"] as const);
      for (const boundary of boundaries) {
        let later = ref(7);
        if (boundary === "quote") later = { ...later, quote: "Invented later excerpt" };
        if (boundary === "readAt") later = { ...later, readAt: "2026-10-17T00:00:00.000Z" };
        if (boundary === "url") later = { ...later, url: "https://example.test/other" };
        if (boundary === "hash")
          later = {
            ...later,
            anchor: {
              kind: "artifact",
              artifact: { artifactId: material.artifact.id, sha256: "b".repeat(64) },
              locator: "text",
            },
          };
        if (boundary === "kind")
          later = {
            ...later,
            kind: kind === "artifact" ? "candidate_statement" : "provider_report",
          };
        if (boundary === "locator")
          later = {
            ...later,
            anchor: { ...later.anchor, locator: kind === "artifact" ? "title" : "blocks[99].text" },
          };
        const invalid = {
          ...request,
          criteria: request.criteria.map((criterion, index) =>
            index === 6 ? { ...criterion, sourceRefs: [later] } : criterion,
          ),
        };
        await expect(mutateRole(prisma, actor, context, invalid, reader)).rejects.toThrow(
          boundary === "quote" ? recruiting.RecruitingSourceValidationError : IsolationError,
        );
        expect(await prisma.recruitingRoleRevision.count()).toBe(revisions);
        expect(
          (await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } }))
            .activeRecruitingRoleId,
        ).toBe(selected);
      }
    },
  );
  it("checks role message quotes at their actual native text block", async () => {
    const f = await assessmentFixture("At least seven years");
    const ref: RecruitingSourceRef = {
      ...source(f.message.id),
      anchor: { kind: "message", messageId: f.message.id, locator: "blocks[0].text" },
      quote: "Invented requirement",
    };
    const input = (sourceRef: RecruitingSourceRef) => ({
      ...roleInput(sourceRef),
      sourceThreadId: f.thread.id,
    });
    const count = await prisma.recruitingRoleRevision.count();
    await expect(recruiting.createRecruitingRole(prisma, actor, input(ref))).rejects.toMatchObject({
      name: "RecruitingSourceValidationError",
      message: expect.stringContaining(
        `Source ${JSON.stringify(ref.id)} at "blocks[0].text": quote must be exact contiguous text`,
      ),
    });
    expect(await prisma.recruitingRoleRevision.count()).toBe(count);
    await expect(
      recruiting.createRecruitingRole(
        prisma,
        actor,
        input({
          ...ref,
          quote: "At least seven years",
          anchor: { ...ref.anchor, locator: "blocks[1].text" },
        }),
      ),
    ).rejects.toThrow(IsolationError);
    const saved = await recruiting.createRecruitingRole(
      prisma,
      actor,
      input({ ...ref, quote: "At least seven years" }),
    );
    expect(saved.revision.sourceRefs[0]?.quote).toBe("At least seven years");
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
  it("returns the assessment's original role revision after the current role changes", async () => {
    const f = await assessmentFixture();
    await recruiting.saveRecruitingAssessment(prisma, actor, f.context, f.input, f.artifacts);
    const { sourceThreadId: _, ...definition } = roleInput(source(f.message.id));
    await recruiting.reviseRecruitingRole(prisma, actor, {
      ...definition,
      roleId: f.role.role.id,
      expectedRevision: 1,
      criteria: [{ ...definition.criteria[0]!, id: "changed-criterion", priority: "preferred" }],
    });
    const input = { roleId: f.role.role.id, candidateKey: f.input.candidateKey };
    const restored = (await recruiting.getRecruitingAssessment(prisma, actor, input))!;
    expect(restored.isCurrent).toBe(false);
    expect(restored).toMatchObject({ roleRevision: f.role.revision });
    expect(
      (await recruiting.listRecruitingAssessments(prisma, actor, { roleId: f.role.role.id }))[0],
    ).toEqual(restored);
  });
  it("returns deduplicated real message targets from assessment and original role sources across threads", async () => {
    const a = await assessmentFixture();
    const b = await assessmentFixture();
    const { sourceThreadId: _, ...definition } = roleInput(source(b.message.id));
    const role = await recruiting.reviseRecruitingRole(prisma, actor, {
      ...definition,
      roleId: a.role.role.id,
      expectedRevision: 1,
    });
    const input = {
      ...a.input,
      roleRevisionId: role.revision.id,
      sourceRefs: [...a.input.sourceRefs, assessmentSource()],
    };
    const admission = await assessmentAdmission(input, { runId: a.run.id, threadId: a.thread.id });
    await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      input,
      admission.artifacts,
    );
    const restored = (await recruiting.getRecruitingAssessment(prisma, actor, {
      roleId: a.role.role.id,
      candidateKey: input.candidateKey,
    }))!;
    expect(restored).toMatchObject({
      roleRevision: role.revision,
      sourceMessageTargets: expect.arrayContaining([
        { messageId: a.message.id, threadId: a.thread.id, target: { groupId: a.group.id } },
        { messageId: b.message.id, threadId: b.thread.id, target: { groupId: b.group.id } },
        { messageId, threadId, target: { botId } },
      ]),
    });
    expect(restored.sourceMessageTargets).toHaveLength(3);
  });
  it("retains an external conversation source without inventing a native message target", async () => {
    const f = await assessmentFixture();
    const conversation = await prisma.externalConversation.create({
      data: {
        spaceId,
        userId,
        botId,
        provider: "synthetic",
        workspaceId: "synthetic",
        externalKey: `snapshot-${f.run.id}`,
        conversationId: `snapshot-${f.run.id}`,
      },
    });
    const externalThread = await prisma.thread.create({
      data: { spaceId, userId, externalConversationId: conversation.id },
    });
    const externalMessage = await prisma.message.create({
      data: {
        threadId: externalThread.id,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Supplied role material" }],
      },
    });
    const externalSource = source(externalMessage.id);
    const { sourceThreadId: _, ...definition } = roleInput(source(f.message.id));
    const role = await recruiting.reviseRecruitingRole(prisma, actor, {
      ...definition,
      sourceRefs: [...definition.sourceRefs, externalSource],
      roleId: f.role.role.id,
      expectedRevision: 1,
    });
    const input = { ...f.input, roleRevisionId: role.revision.id };
    const admission = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      input,
      admission.artifacts,
    );
    const restored = (await recruiting.getRecruitingAssessment(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: input.candidateKey,
    }))!;
    expect(restored.roleRevision.sourceRefs).toContainEqual(externalSource);
    expect(restored.sourceMessageTargets).toEqual([
      { messageId: f.message.id, threadId: f.thread.id, target: { groupId: f.group.id } },
    ]);
  });
  it("rejects snapshot reads without exposing original role source targets after access is revoked", async () => {
    const a = await assessmentFixture();
    const b = await assessmentFixture();
    const { sourceThreadId: _, ...definition } = roleInput(source(b.message.id));
    const role = await recruiting.reviseRecruitingRole(prisma, actor, {
      ...definition,
      roleId: a.role.role.id,
      expectedRevision: 1,
    });
    const input = { ...a.input, roleRevisionId: role.revision.id };
    const admission = await assessmentAdmission(input, { runId: a.run.id, threadId: a.thread.id });
    await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      input,
      admission.artifacts,
    );
    await prisma.thread.update({ where: { id: b.thread.id }, data: { userId: otherUserId } });
    await expect(
      recruiting.getRecruitingAssessment(prisma, actor, {
        roleId: a.role.role.id,
        candidateKey: input.candidateKey,
      }),
    ).rejects.toThrow(IsolationError);
    await expect(
      recruiting.listRecruitingAssessments(prisma, actor, { roleId: a.role.role.id }),
    ).rejects.toThrow(IsolationError);
  });
  it("reassesses only explicit changes and commits one immutable version per native effect", async () => {
    const f = await assessmentFixture();
    const first = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      f.context,
      f.input,
      f.artifacts,
    );
    const input = { ...f.input, expectedRevision: 1, atomJudgments: [], employmentEvaluations: [] };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const request = { operation: "reassess", ...input };
    await prisma.externalEffect.update({
      where: { id: admitted.context.effectId },
      data: { request: request as Prisma.InputJsonValue },
    });
    const context = { ...admitted.context, effectRequest: request };
    const second = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      context,
      input,
      admitted.artifacts,
    );
    expect(second.assessment.version).toBe(2);
    expect(second.assessment.judgments).toEqual(first.assessment.judgments);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
    });
    expect(
      await recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        { ...context, contextArtifact: undefined },
        input,
        [],
      ),
    ).toEqual(second);
    expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(2);
    const stale = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    await prisma.externalEffect.update({
      where: { id: stale.context.effectId },
      data: { request: request as Prisma.InputJsonValue },
    });
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        { ...stale.context, effectRequest: request },
        input,
        stale.artifacts,
      ),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    const changed = {
      ...input,
      expectedRevision: 2,
      facts: [{ ...input.facts[0]!, statement: "Changed material interpretation" }],
    };
    const rejected = await assessmentAdmission(changed, { runId: f.run.id, threadId: f.thread.id });
    const changedRequest = { operation: "reassess", ...changed };
    await prisma.externalEffect.update({
      where: { id: rejected.context.effectId },
      data: { request: changedRequest as Prisma.InputJsonValue },
    });
    await expect(
      recruiting.saveRecruitingAssessment(
        prisma,
        actor,
        { ...rejected.context, effectRequest: changedRequest },
        changed,
        rejected.artifacts,
      ),
    ).rejects.toThrow("explicit atom update");
    expect(await prisma.recruitingAssessment.count({ where: { roleId: f.role.role.id } })).toBe(2);
    const current = await recruiting.getRecruitingAssessment(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: input.candidateKey,
    });
    expect(current?.assessment.version).toBe(2);
  });
  it("pauses with the original native recruiting card, effect and asked event in one transaction", async () => {
    const f = await questionFixture();
    expect(await recruiting.pauseRunForInput(prisma, f.pause)).toBe(true);
    const question = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
    expect(question).toMatchObject({
      effectId: f.effect.id,
      messageId: expect.any(String),
      askIndex: 0,
      isCurrent: true,
      canAnswer: true,
      runStatus: "waiting_input",
      groupId: f.group.id,
      block: { kind: "ask", text: f.request.question, status: "pending" },
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).status).toBe(
      "waiting_input",
    );
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: question.messageId } })).clientNonce,
    ).toBe(`recruiting-question:${f.effect.id}`);
    const effect = await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } });
    const event = await prisma.event.findFirstOrThrow({
      where: { runId: f.run.id, type: "recruiting.question.asked" },
    });
    expect(effect.status).toBe("completed");
    expect(effect.result).toEqual(event.payload);
    expect(
      await recruiting.listRecruitingQuestions(prisma, actor, {
        threadId: f.thread.id,
        roleId: f.role.role.id,
      }),
    ).toEqual([question]);
    await expect(
      recruiting.getRecruitingQuestion(prisma, { ...actor, userId: otherUserId }, f.lookup),
    ).rejects.toThrow(IsolationError);
  });
  it("keeps a removed group bot's original question readable and disables its answer", async () => {
    const f = await questionFixture();
    await recruiting.pauseRunForInput(prisma, f.pause);
    const original = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
    await prisma.chatGroupMember.deleteMany({ where: { groupId: f.group.id, botId } });
    const question = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
    expect(question).toMatchObject({
      messageId: original.messageId,
      block: original.block,
      isCurrent: true,
      canAnswer: false,
      runStatus: "waiting_input",
    });
    expect(
      await recruiting.listRecruitingQuestions(prisma, actor, {
        threadId: f.thread.id,
        roleId: f.role.role.id,
      }),
    ).toEqual([question]);
    expect(
      await recruiting.answerRunInput(prisma, {
        spaceId,
        threadId: f.thread.id,
        runId: f.run.id,
        messageId: original.messageId,
        answeredByUserId: userId,
        answer: "Personal code",
      }),
    ).toBe(false);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "waiting_input",
    );
    expect(await prisma.event.count({ where: { runId: f.run.id, type: "thread.choice" } })).toBe(0);
  });
  it("retains raw offered options on the native checkpoint while storing only the redacted card", async () => {
    const f = await questionFixture();
    const secret = "synthetic-secret-token";
    const request = {
      ...f.request,
      question: `Use ${secret}?`,
      options: [`Use ${secret}`, "Other material"],
    };
    await prisma.externalEffect.update({
      where: { id: f.effect.id },
      data: { request: request as Prisma.InputJsonValue },
    });
    const actions = request.options.map((label, index) => ({ id: `choice-${index + 1}`, label }));
    const pause = {
      ...f.pause,
      blocks: [
        {
          kind: "ask" as const,
          text: "Use [redacted]?",
          actions: [{ id: "choice-1", label: "Use [redacted]" }, actions[1]!],
          status: "pending" as const,
        },
      ],
      offeredActions: actions,
      recruitingQuestion: { ...f.pause.recruitingQuestion!, effectRequest: request },
    };
    expect(await recruiting.pauseRunForInput(prisma, pause)).toBe(true);
    const question = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
    expect(question.block.text).toBe("Use [redacted]?");
    const events = await prisma.event.findMany({ where: { runId: f.run.id } });
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(secret);
    expect(
      await recruiting.answerRunInput(prisma, {
        spaceId,
        threadId: f.thread.id,
        runId: f.run.id,
        messageId: question.messageId,
        answeredByUserId: userId,
        answer: "choice-1",
      }),
    ).toBe(true);
    expect(await recruiting.getRecruitingQuestion(prisma, actor, f.lookup)).toMatchObject({
      canAnswer: false,
      block: { answer: "choice-1", status: "answered" },
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.run.taskId } })).prompt).toContain(
      secret,
    );
  });
  it.each(["role", "candidate"])(
    "rejects stale %s recruiting cards through both answer paths",
    async (target) => {
      const f = await questionFixture(target === "candidate");
      await recruiting.pauseRunForInput(prisma, f.pause);
      const original = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
      if (target === "role") {
        const { sourceThreadId: _, ...definition } = roleInput(source(f.message.id));
        await recruiting.reviseRecruitingRole(prisma, actor, {
          ...definition,
          roleId: f.role.role.id,
          expectedRevision: 1,
        });
      } else {
        const run = await prisma.run.create({
          data: {
            spaceId,
            userId,
            botId,
            threadId: f.thread.id,
            taskId: f.run.taskId,
            status: "running",
            trigger: "user",
          },
        });
        const input = { ...f.input, expectedRevision: 1 };
        const admission = await assessmentAdmission(input, {
          runId: run.id,
          threadId: f.thread.id,
        });
        await recruiting.saveRecruitingAssessment(
          prisma,
          actor,
          admission.context,
          input,
          admission.artifacts,
        );
      }
      expect(await recruiting.getRecruitingQuestion(prisma, actor, f.lookup)).toMatchObject({
        isCurrent: false,
        canAnswer: false,
      });
      expect(
        await recruiting.answerRunInput(prisma, {
          spaceId,
          threadId: f.thread.id,
          runId: f.run.id,
          messageId: original.messageId,
          answeredByUserId: userId,
          answer: "New answer",
        }),
      ).toBe(false);
      expect(
        await prisma.$transaction((tx) =>
          recruiting.answerWaitingRunWithTextInTransaction(tx, {
            spaceId,
            threadId: f.thread.id,
            runId: f.run.id,
            answeredByUserId: userId,
            answer: "New answer",
          }),
        ),
      ).toBeNull();
      expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        "waiting_input",
      );
      expect(await prisma.event.count({ where: { runId: f.run.id, type: "thread.choice" } })).toBe(
        0,
      );
      expect(
        (await prisma.message.findUniqueOrThrow({ where: { id: original.messageId } })).blocks,
      ).toEqual([original.block]);
    },
  );
  it.each(["custom", "choice", "composer"])(
    "records one native author proof for a recruiting %s answer",
    async (kind) => {
      const f = await questionFixture();
      const originalRun = await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
      const originalTask = await prisma.task.findUniqueOrThrow({ where: { id: f.run.taskId } });
      await recruiting.pauseRunForInput(prisma, f.pause);
      const question = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
      const rawAnswer = " \n  Custom material 😀\n  ";
      const answer = kind === "choice" ? "choice-2" : rawAnswer;
      if (kind === "composer") {
        const result = await prisma.$transaction(async (tx) => {
          const message = await recruiting.createThreadMessageInTransaction(tx, {
            threadId: f.thread.id,
            role: "user",
            blocks: [{ kind: "text", text: rawAnswer }],
          });
          return recruiting.answerWaitingRunWithTextInTransaction(tx, {
            spaceId,
            threadId: f.thread.id,
            runId: f.run.id,
            answeredByUserId: userId,
            answer,
            answerMessageId: message.id,
          });
        });
        expect(result).not.toBeNull();
      } else
        expect(
          await recruiting.answerRunInput(prisma, {
            spaceId,
            threadId: f.thread.id,
            runId: f.run.id,
            messageId: question.messageId,
            answeredByUserId: userId,
            answer,
          }),
        ).toBe(true);
      await prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
      expect(await recruiting.getRecruitingQuestion(prisma, actor, f.lookup)).toMatchObject({
        runStatus: "completed",
        canAnswer: false,
        block: { status: "answered", answer },
      });
      const receipt = await prisma.event.findFirstOrThrow({
        where: { runId: f.run.id, type: "thread.choice" },
      });
      const proof = receipt.payload as NativeAskAnswerPayload;
      expect(proof).toMatchObject({
        messageId: question.messageId,
        askIndex: 0,
        answeredByUserId: userId,
      });
      const human = await prisma.message.findUniqueOrThrow({
        where: { id: proof.answerMessageId },
      });
      expect(human.botId).toBeNull();
      expect(human.role).toBe("user");
      expect(human.blocks).toEqual([
        { kind: "text", text: kind === "choice" ? "Personal code" : rawAnswer },
      ]);
      const resumedPrompt = `${originalTask.prompt}\n\n${question.block.text}\nAnswer: ${kind === "choice" ? "Selected choice choice-2: Personal code" : rawAnswer}`;
      expect((await prisma.task.findUniqueOrThrow({ where: { id: f.run.taskId } })).prompt).toBe(
        resumedPrompt,
      );
      expect(resumedPrompt.split(originalTask.prompt)).toHaveLength(2);
      expect(await prisma.event.count({ where: { runId: f.run.id, type: "thread.choice" } })).toBe(
        1,
      );
      const restored = createDb(databaseUrl!);
      try {
        expect(
          await recruiting.getRecruitingQuestion(restored.prisma, actor, f.lookup),
        ).toMatchObject({
          messageId: question.messageId,
          runId: f.run.id,
          canAnswer: false,
          block: { status: "answered", answer },
        });
        expect(
          (await restored.prisma.message.findUniqueOrThrow({ where: { id: human.id } })).blocks,
        ).toEqual(human.blocks);
        expect(
          await restored.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } }),
        ).toMatchObject({
          taskId: originalRun.taskId,
          sourceMessageId: originalRun.sourceMessageId,
        });
        expect(
          (await restored.prisma.task.findUniqueOrThrow({ where: { id: f.run.taskId } })).prompt,
        ).toBe(resumedPrompt);
        const canonical = await recruiting.loadRunHumanSources(
          restored.prisma,
          actor,
          await restored.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } }),
          { continuationOnly: true },
        );
        expect(canonical.currentAnswer?.id).toBe(human.id);
        expect(canonical.currentAnswer?.blocks).toEqual(human.blocks);
        expect(canonical.answeredAsks.map((turn) => [turn.card.id, turn.answer.id])).toEqual([
          [question.messageId, human.id],
        ]);
        expect(canonical.originalSource?.id).toBe(originalRun.sourceMessageId);
      } finally {
        await restored.prisma.$disconnect();
        await restored.pool.end();
      }
    },
  );
  it("replays a committed question without a lease or another card/pause", async () => {
    const f = await questionFixture();
    const lostAck = {
      $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        await prisma.$transaction(callback);
        throw new Error("lost question acknowledgement");
      },
    } as unknown as PrismaClient;
    await expect(recruiting.pauseRunForInput(lostAck, f.pause)).rejects.toThrow(
      "lost question acknowledgement",
    );
    const original = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
    expect(
      await recruiting.pauseRunForInput(prisma, {
        ...f.pause,
        recruitingQuestion: {
          ...f.pause.recruitingQuestion!,
          contextArtifact: undefined,
          artifacts: [],
        },
      }),
    ).toBe(true);
    expect(
      await recruiting.answerRunInput(prisma, {
        spaceId,
        threadId: f.thread.id,
        runId: f.run.id,
        messageId: original.messageId,
        answeredByUserId: userId,
        answer: "Personal code",
      }),
    ).toBe(true);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "running", leaseOwner: "new-worker", leaseFence: 2 },
    });
    expect(await recruiting.pauseRunForInput(prisma, f.pause)).toBe(true);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "running",
      leaseOwner: "new-worker",
      leaseFence: 2,
    });
    expect(
      await prisma.message.count({
        where: { threadId: f.thread.id, clientNonce: `recruiting-question:${f.effect.id}` },
      }),
    ).toBe(1);
    expect(
      await prisma.event.count({ where: { runId: f.run.id, type: "recruiting.question.asked" } }),
    ).toBe(1);
  });
  it.each(["cancelled", "foreign", "deleted", "event", "card", "proof"])(
    "refuses a recruiting answer after %s changes",
    async (boundary) => {
      const f = await questionFixture();
      await recruiting.pauseRunForInput(prisma, f.pause);
      const question = (await recruiting.getRecruitingQuestion(prisma, actor, f.lookup))!;
      if (boundary === "cancelled")
        await prisma.$transaction((tx) =>
          recruiting.cancelRunsInTransaction(
            tx,
            [{ id: f.run.id, taskId: f.run.taskId }],
            new Date(),
          ),
        );
      if (boundary === "deleted")
        await prisma.message.delete({ where: { id: question.messageId } });
      if (boundary === "event")
        await prisma.event.deleteMany({
          where: { runId: f.run.id, type: "recruiting.question.asked" },
        });
      if (boundary === "card")
        await prisma.message.update({
          where: { id: question.messageId },
          data: { blocks: [{ ...question.block, text: "Changed question" }] },
        });
      if (boundary === "proof")
        await prisma.event.create({
          data: {
            spaceId,
            threadId: f.thread.id,
            botId,
            runId: f.run.id,
            seq: 100,
            type: "thread.choice",
            payload: {
              messageId: question.messageId,
              askIndex: 0,
              answerMessageId: f.message.id,
              answeredByUserId: userId,
            },
          },
        });
      expect(
        await recruiting.answerRunInput(prisma, {
          spaceId,
          threadId: f.thread.id,
          runId: f.run.id,
          messageId: question.messageId,
          answeredByUserId: boundary === "foreign" ? otherUserId : userId,
          answer: "Answer",
        }),
      ).toBe(false);
      expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        boundary === "cancelled" ? "cancelled" : "waiting_input",
      );
    },
  );
  it.each(["lease", "role", "attempt"])(
    "rolls back a question pause invalidated by %s before clearing the lease",
    async (boundary) => {
      const f = await questionFixture();
      if (boundary === "lease")
        await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
      if (boundary === "role") {
        const { sourceThreadId: _, ...definition } = roleInput(source(f.message.id));
        await recruiting.reviseRecruitingRole(prisma, actor, {
          ...definition,
          roleId: f.role.role.id,
          expectedRevision: 1,
        });
      }
      if (boundary === "attempt")
        await prisma.attempt.update({ where: { id: f.attempt.id }, data: { status: "failed" } });
      await expect(recruiting.pauseRunForInput(prisma, f.pause)).rejects.toThrow();
      expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
        status: "running",
        leaseOwner: f.context.leaseOwner,
      });
      expect(
        await prisma.message.count({
          where: { clientNonce: `recruiting-question:${f.effect.id}` },
        }),
      ).toBe(0);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
      ).toBe("executing");
    },
  );
  it.each(["pause", "answer"])(
    "linearizes native recruiting %s against cancellation",
    async (stage) => {
      const f = await questionFixture();
      if (stage === "answer") await recruiting.pauseRunForInput(prisma, f.pause);
      const question =
        stage === "answer" ? await recruiting.getRecruitingQuestion(prisma, actor, f.lookup) : null;
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
      const second = createDb(databaseUrl!);
      try {
        const pending =
          stage === "pause"
            ? recruiting.pauseRunForInput(second.prisma, f.pause)
            : recruiting.answerRunInput(second.prisma, {
                spaceId,
                threadId: f.thread.id,
                runId: f.run.id,
                messageId: question!.messageId,
                answeredByUserId: userId,
                answer: "Answer",
              });
        const observed = pending.then(
          (result) => result,
          () => false,
        );
        expect(
          await Promise.race([
            observed,
            new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
          ]),
        ).toBe("blocked");
        release();
        await cancel;
        expect(await observed).toBe(false);
        expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
          "cancelled",
        );
        expect(
          await prisma.event.count({ where: { runId: f.run.id, type: "thread.choice" } }),
        ).toBe(0);
        expect(
          await prisma.event.count({
            where: { runId: f.run.id, type: "recruiting.question.asked" },
          }),
        ).toBe(stage === "answer" ? 1 : 0);
      } finally {
        release();
        await cancel;
        await second.prisma.$disconnect();
        await second.pool.end();
      }
    },
  );
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
        ? JSON.stringify({
            rows: [{ detail: quote }, { detail: "Another actual field" }],
            decoy: "Other",
          })
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
    const other: RecruitingAssessmentSourceRef = {
      ...src,
      id: "other-field",
      quote: "Another actual field",
      selection: { kind: "artifact_json_string", path: ["rows", 1, "detail"], start: 0, end: 20 },
    };
    const input = { ...f.input, sourceRefs: format === "json" ? [src, other] : [src] };
    const admitted = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    const artifacts = [...admitted.artifacts, { artifactId: material.id, bytes }];
    const saved = await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admitted.context,
      input,
      artifacts,
    );
    expect(saved.assessment.sourceRefs).toEqual(input.sourceRefs);
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
    ).rejects.toThrow(IsolationError);
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
      { tasks: [], actions: [], observations: [] },
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
    ).toEqual({ ...created, crmTarget: null });
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

  it("lets a turn-end auto-continue act on the recruiter's last message", async () => {
    const { id: botId } = await prisma.bot.create({
      data: { spaceId, userId, name: "Continue", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId } });
    const jd = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "Customer success manager, B2B SaaS" }],
      },
    });
    const human = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Austin metro, hybrid three days" }],
      },
    });
    await prisma.message.create({
      data: { threadId: thread.id, seq: 2, role: "assistant", botId, blocks: [] },
    });
    const nudge = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 3,
        role: "user",
        clientNonce: "autocontinue:previous-run:1",
        blocks: [{ kind: "text", text: "继续下一步：确认简报。" }],
      },
    });
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId: thread.id, prompt: "continue", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        sourceMessageId: nudge.id,
        trigger: "follow_up",
        status: "running",
      },
    });
    const input = {
      operation: "create" as const,
      title: "Customer success manager",
      sourceRefs: [],
      criteria: [
        {
          ...roleInput().criteria[0]!,
          sourceRefs: [
            {
              id: "austin",
              kind: "original_material" as const,
              anchor: { kind: "message" as const, messageId: human.id, locator: "blocks[0].text" },
              readState: "read" as const,
              readAt: "2026-10-25T20:00:00.000Z",
              quote: "Austin metro",
            },
          ],
        },
      ],
      preferences: [],
      definitionQuestions: [],
      intent: { basis: "direct" as const, quote: "Austin metro" },
    };
    const saved = await mutateRole(
      prisma,
      actor,
      { runId: run.id, sourceMessageId: nudge.id },
      input,
    );
    expect(saved.status).toBe("saved");
    expect(saved.source?.anchor).toMatchObject({ kind: "message", messageId: human.id });
    // A brief may cite the recruiter's message by its runtime id alone.
    const briefed = await mutateRole(
      prisma,
      actor,
      { runId: run.id, sourceMessageId: nudge.id },
      {
        operation: "update",
        roleId: saved.workspace!.role.id,
        expectedRevision: saved.workspace!.role.revision,
        intent: { basis: "direct", quote: "Austin metro" },
        brief: {
          searchFilters: [],
          fields: [
            {
              key: "location",
              value: "Austin metro, hybrid",
              origin: "user_instruction",
              state: "known",
              consequential: true,
              sourceRefIds: [`human-message:${human.id}`],
            },
            {
              key: "title",
              value: "Customer success manager",
              origin: "user_instruction",
              state: "known",
              consequential: true,
              sourceRefIds: [`human-message:${jd.id}`],
            },
          ],
          questions: [],
          rules: [
            {
              criterionId: "experience",
              origin: "user_instruction",
              effect: "reject",
              sourceRefIds: [`human-message:${human.id}`],
            },
          ],
        },
      },
    );
    expect(briefed.status).toBe("saved");
    expect(briefed.workspace?.revision.sourceRefs).toContainEqual(
      expect.objectContaining({
        id: `human-message:${jd.id}`,
        quote: "Customer success manager, B2B SaaS",
      }),
    );
    // The nudge text itself never authorizes a change, and the error names the words to copy.
    await expect(
      mutateRole(
        prisma,
        actor,
        { runId: run.id, sourceMessageId: nudge.id },
        {
          ...input,
          title: "Other",
          intent: { basis: "direct", quote: "继续下一步" },
        },
      ),
    ).rejects.toThrow(/Austin metro, hybrid three days/);
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
      title: "Native role",
      sourceRefs: [],
      criteria: [{ ...roleInput().criteria[0]!, sourceRefs: [source(first.id)] }],
      preferences: [],
      definitionQuestions: [],
      intent: { basis: "direct" as const, quote: "Create this role with seven years" },
    };
    const call = (
      sourceMessageId: string,
      mutation: Exclude<RecruitingRoleToolInput, { operation: "read" }> = input,
    ) => mutateRole(prisma, actor, { ...context, sourceMessageId }, mutation);
    const created = await call(first.id);
    expect(created.changed).toBe(true);
    expect(created.status).toBe("saved");
    expect(created.workspace?.revision.sourceRefs).toEqual([created.source]);
    expect(created.workspace?.revision.criteria[0]?.sourceRefs).toEqual([source(first.id)]);
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
      mutateRole(prisma, { ...actor, userId: otherUserId }, context, input),
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
    const revised = await mutateRole(
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
    const refined = await mutateRole(
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
    const rebind = await mutateRole(
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
      mutateRole(prisma, actor, context, {
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

  async function nativeAsk(
    actions?: { id: string; label: string }[],
    text = "Please clarify this role",
  ) {
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Native answers", members: { create: { botId } } },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const original = await recruiting.createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text }],
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
      const created = await mutateRole(prisma, actor, context, {
        operation: "create",
        title: "Answered role",
        sourceRefs: [],
        criteria: [{ ...roleInput().criteria[0]!, sourceRefs: [source(answerMessage.id)] }],
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
    const created = await mutateRole(prisma, actor, input, {
      operation: "create",
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

  async function researchFixture(confirmed = true, includeCriterion = false) {
    const salary = "GBP 90,000 to 120,000";
    const f = await nativeAsk(
      undefined,
      `Please clarify this role. Outreach salary: ${salary}. Location: unrestricted.`,
    );
    await prisma.run.update({
      where: { id: f.run.id },
      data: {
        status: "running",
        leaseOwner: "research-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const ref: RecruitingSourceRef = {
      ...source(f.original.id),
      anchor: { kind: "message", messageId: f.original.id, locator: "blocks[0].text" },
      quote: salary,
    };
    const locationRef = { ...ref, id: "location", quote: "Location: unrestricted." };
    const definition = {
      title: "Synthetic research role",
      sourceRefs: [ref, locationRef],
      criteria: includeCriterion
        ? [
            {
              id: "compensation",
              priority: "hard" as const,
              expression: { kind: "atom" as const, id: "salary", statement: salary },
              sourceRefs: [ref],
              definitionQuestions: [],
            },
          ]
        : [],
      preferences: [],
      definitionQuestions: [],
      brief: {
        searchFilters: [],
        fields: [
          {
            key: "salary_range",
            value: salary,
            origin: "user_instruction" as const,
            state: "known" as const,
            consequential: true,
            sourceRefIds: [ref.id],
          },
          {
            key: "location",
            value: "Unrestricted",
            origin: "user_instruction" as const,
            state: "known" as const,
            consequential: true,
            sourceRefIds: [locationRef.id],
          },
        ],
        questions: [],
        rules: includeCriterion
          ? [
              {
                criterionId: "compensation",
                origin: "jd" as const,
                effect: "reject" as const,
                sourceRefIds: [ref.id],
              },
            ]
          : [],
      },
    };
    const draft = await recruiting.createRecruitingRole(prisma, actor, {
      ...definition,
      expectedRevision: 0,
      sourceThreadId: f.thread.id,
    });
    const role = confirmed
      ? await recruiting.confirmRecruitingBrief(prisma, actor, {
          threadId: f.thread.id,
          roleId: draft.role.id,
          expectedRevision: draft.role.revision,
        })
      : draft;
    let approvalEffectId = `missing-documents-${f.run.id}`;
    if (confirmed) {
      // A separate completed gate run keeps research dispatch assertions scoped to the research run.
      const approvalRun = await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId: f.thread.id,
          taskId: f.run.taskId,
          status: "running",
          trigger: "user",
          leaseOwner: "gate-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const bodies = new Map<string, Uint8Array>();
      const docs = [];
      for (const [name, text, mimeType] of [
        ["JD.txt", "Synthetic final job description", "text/plain"],
        ["JD.pdf", "%PDF-1.7\nsynthetic fixture", "application/pdf"],
      ] as const) {
        const bytes = new TextEncoder().encode(text);
        const row = await prisma.artifact.create({
          data: {
            spaceId,
            userId,
            botId,
            groupId: f.thread.groupId,
            runId: approvalRun.id,
            name,
            mimeType,
            size: bytes.byteLength,
            hash: createHash("sha256").update(bytes).digest("hex"),
            storageKey: `gate:${approvalRun.id}:${name}`,
          },
        });
        bodies.set(row.storageKey, bytes);
        docs.push({ artifactId: row.id, sha256: row.hash });
      }
      const request: RecruitingApprovalToolInput = {
        stage: "documents",
        roleId: role.role.id,
        expectedRoleRevision: role.role.revision,
        documents: { jdText: docs[0]!, namedPdf: docs[1]!, anonymousPdf: null, deck: null },
      };
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId,
          runId: approvalRun.id,
          kind: "recruiting_request_approval",
          status: "executing",
          request,
          idempotencyKey: `gate:${approvalRun.id}`,
        },
      });
      const card = await recruiting.createThreadMessage(prisma, {
        threadId: f.thread.id,
        role: "bot",
        botId,
        runId: approvalRun.id,
        blocks: [
          {
            kind: "ask",
            text: "Approve synthetic documents",
            approvalEffectId: effect.id,
            status: "answered",
            answer: "allow",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      });
      await recruiting.appendEvent(prisma, {
        spaceId,
        threadId: f.thread.id,
        botId,
        runId: approvalRun.id,
        type: "effect.approval.answered",
        payload: {
          effectId: effect.id,
          messageId: card.id,
          askIndex: 0,
          answeredByUserId: userId,
          answer: "allow",
          requestHash: createHash("sha256").update(stableJsonValue(request)).digest("hex"),
        },
      });
      const material = {
        context: { ...actor, signal: new AbortController().signal },
        artifacts: { get: async (key: string) => bodies.get(key)! },
      } as unknown as recruiting.RecruitingRoleMaterialContext;
      const saved = await recruiting.executeRecruitingApproval(
        prisma,
        actor,
        {
          runId: approvalRun.id,
          threadId: f.thread.id,
          botId,
          leaseOwner: "gate-worker",
          leaseFence: 1,
          effectId: effect.id,
          effectRequest: request,
        },
        request,
        material,
      );
      approvalEffectId = saved.approvalEffectId;
      await prisma.run.update({ where: { id: approvalRun.id }, data: { status: "completed" } });
    }
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
      purpose: "calibration" as const,
      candidateOutputSchema: "candidate_output_v1" as const,
      approvalEffectId,
      clientNonce: `action-${f.run.id}`,
      recallScope: null,
      requestArtifact: metadata("request"),
      contextArtifact,
      frozenRequest,
      effectKind: "mcp_research",
    };
    const lease = { runId: f.run.id, leaseOwner: "research-worker", leaseFence: 1 };
    return { ...f, role, draft, definition, server, metadata, input, lease };
  }

  it("confirms a brief with one durable human receipt and preserves the immutable draft", async () => {
    const f = await researchFixture(false);
    const before = await prisma.message.count({ where: { threadId: f.thread.id } });
    const draft = await prisma.recruitingRoleRevision.findUniqueOrThrow({
      where: { id: f.draft.revision.id },
    });
    const saved = await recruiting.confirmRecruitingBrief(prisma, actor, {
      threadId: f.thread.id,
      roleId: f.role.role.id,
      expectedRevision: f.role.role.revision,
    });
    expect(saved.role.revision).toBe(2);
    expect(saved.revision.brief?.confirmation).toMatchObject({
      revision: 2,
      userId: actor.userId,
    });
    for (const key of ["sourceRefs", "criteria", "preferences", "definitionQuestions"] as const)
      expect(saved.revision[key]).toEqual(f.draft.revision[key]);
    expect({ ...saved.revision.brief, confirmation: null }).toEqual(f.draft.revision.brief);
    const receipt = await prisma.message.findUniqueOrThrow({
      where: { id: saved.revision.brief!.confirmation!.messageId },
    });
    expect(receipt).toMatchObject({
      threadId: f.thread.id,
      role: "user",
      botId: null,
      blocks: [
        {
          kind: "text",
          text: `Confirm recruiting brief for ${f.role.role.title} (requirements version 1).`,
        },
      ],
    });
    expect(
      await prisma.recruitingRoleRevision.findUniqueOrThrow({
        where: { id: f.draft.revision.id },
      }),
    ).toEqual(draft);
    expect(
      await recruiting.confirmRecruitingBrief(prisma, actor, {
        threadId: f.thread.id,
        roleId: saved.role.id,
        expectedRevision: saved.role.revision,
      }),
    ).toEqual(saved);
    expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before + 1);
    expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
      2,
    );
  });

  it("atomically saves a human criterion edit, invalidates confirmation and preserves old assessment versions", async () => {
    const f = await researchFixture(true, true);
    const cursor =
      (await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } })).nextEventSeq - 1;
    const original = await prisma.recruitingRoleRevision.findUniqueOrThrow({
      where: { id: f.role.revision.id },
    });
    const before = await prisma.message.count({ where: { threadId: f.thread.id } });
    const assessment = await prisma.recruitingAssessment.create({
      data: {
        roleId: f.role.role.id,
        roleRevisionId: f.role.revision.id,
        candidateKey: "synthetic-row",
        version: 1,
        facts: [],
        sourceRefs: [],
        questions: [],
        createdByRunId: f.run.id,
        judgments: { atoms: [], employment: [], criteria: [], hardGate: "unknown" },
      },
    });
    const input = {
      threadId: f.thread.id,
      roleId: f.role.role.id,
      expectedRevision: f.role.role.revision,
      criteria: [
        {
          criterionId: "compensation",
          priority: "preferred" as const,
          atoms: [{ atomId: "salary", statement: "GBP 100,000 to 120,000" }],
        },
      ],
    };
    const saved = await recruiting.editRecruitingCriteria(prisma, actor, input);
    const second = createDb(databaseUrl!);
    try {
      expect(await recruiting.eventsAfter(second.prisma, f.thread.id, cursor)).toMatchObject([
        {
          spaceId: actor.spaceId,
          threadId: f.thread.id,
          type: "recruiting.changed",
          payload: { roleId: saved.role.id },
        },
      ]);
      expect(
        await recruiting.getRecruitingWorkspace(second.prisma, actor, { threadId: f.thread.id }),
      ).toEqual({ ...saved, crmTarget: null });
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
    expect(saved.role.revision).toBe(f.role.role.revision + 1);
    expect(saved.revision.brief?.confirmation).toBeNull();
    const human = saved.revision.sourceRefs.at(-1)!;
    expect(human.kind).toBe("recruiter_verified");
    expect(human.anchor.kind).toBe("message");
    const receipt = await prisma.message.findUniqueOrThrow({
      where: { id: human.anchor.kind === "message" ? human.anchor.messageId : "invalid" },
    });
    expect(receipt).toMatchObject({
      role: "user",
      botId: null,
      runId: null,
      threadId: f.thread.id,
      blocks: [{ kind: "text", text: human.quote }],
    });
    expect(saved.revision.brief?.rules[0]).toEqual({
      criterionId: "compensation",
      origin: "user_instruction",
      effect: "flag",
      sourceRefIds: [human.id],
    });
    expect(
      await prisma.recruitingRoleRevision.findUniqueOrThrow({ where: { id: f.role.revision.id } }),
    ).toEqual(original);
    const historical = await recruiting.getRecruitingAssessment(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: assessment.candidateKey,
    });
    expect(historical?.isCurrent).toBe(false);
    expect(historical?.roleRevision.id).toBe(f.role.revision.id);
    expect(
      await prisma.recruitingAssessment.findUniqueOrThrow({
        where: {
          roleId_candidateKey_version: {
            roleId: assessment.roleId,
            candidateKey: assessment.candidateKey,
            version: 1,
          },
        },
      }),
    ).toEqual(assessment);
    expect(
      await recruiting.editRecruitingCriteria(prisma, actor, {
        ...input,
        expectedRevision: saved.role.revision,
      }),
    ).toEqual(saved);
    expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before + 1);
    expect(await recruiting.eventsAfter(prisma, f.thread.id, cursor)).toHaveLength(1);
  });

  it("rolls back the recruiting change event and its saved mutation if native event persistence fails", async () => {
    const f = await researchFixture(false, true);
    const beforeThread = await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } });
    const beforeRole = await prisma.recruitingRole.findUniqueOrThrow({
      where: { id: f.role.role.id },
    });
    const beforeMessages = await prisma.message.count({ where: { threadId: f.thread.id } });
    const beforeEvents = await prisma.event.count({ where: { threadId: f.thread.id } });
    const failure = new Error("Injected failure after native saved-change event write");
    const failing = prisma.$extends({
      query: {
        event: {
          async create({ args, query }) {
            const event = await query(args);
            if (args.data.type === "recruiting.changed") throw failure;
            return event;
          },
        },
      },
    });
    await expect(
      recruiting.editRecruitingCriteria(failing as unknown as PrismaClient, actor, {
        threadId: f.thread.id,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
        criteria: [
          {
            criterionId: "compensation",
            priority: "preferred",
            atoms: [{ atomId: "salary", statement: "GBP 100,000 to 120,000" }],
          },
        ],
      }),
    ).rejects.toThrow(failure);
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } })).toEqual(
      beforeThread,
    );
    expect(
      await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }),
    ).toEqual(beforeRole);
    expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(beforeMessages);
    expect(await prisma.event.count({ where: { threadId: f.thread.id } })).toBe(beforeEvents);
    expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
      1,
    );
  });

  it("commits only one concurrent human criterion edit across two connections", async () => {
    const f = await researchFixture(false, true);
    const before = await prisma.message.count({ where: { threadId: f.thread.id } });
    const second = createDb(databaseUrl!);
    try {
      const input = {
        threadId: f.thread.id,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
        criteria: [
          {
            criterionId: "compensation",
            priority: "preferred" as const,
            atoms: [{ atomId: "salary", statement: "GBP 100,000 to 120,000" }],
          },
        ],
      };
      const results = await Promise.allSettled([
        recruiting.editRecruitingCriteria(prisma, actor, input),
        recruiting.editRecruitingCriteria(second.prisma, actor, input),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
        recruiting.RecruitingConflictError,
      );
      expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before + 1);
      expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
        2,
      );
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it("rolls back the human criterion message, sequence, revision and role pointer after the actual CAS write", async () => {
    const f = await researchFixture(false, true);
    const beforeThread = await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } });
    const beforeRole = await prisma.recruitingRole.findUniqueOrThrow({
      where: { id: f.role.role.id },
    });
    const beforeMessages = await prisma.message.count({ where: { threadId: f.thread.id } });
    const failure = new Error("Injected failure after actual edited role pointer update");
    const failing = prisma.$extends({
      query: {
        recruitingRole: {
          async updateMany({ args, query }) {
            await query(args);
            throw failure;
          },
        },
      },
    });
    await expect(
      recruiting.editRecruitingCriteria(failing as unknown as PrismaClient, actor, {
        threadId: f.thread.id,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
        criteria: [
          {
            criterionId: "compensation",
            priority: "preferred",
            atoms: [{ atomId: "salary", statement: "GBP 100,000 to 120,000" }],
          },
        ],
      }),
    ).rejects.toThrow(failure);
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } })).toEqual(
      beforeThread,
    );
    expect(
      await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }),
    ).toEqual(beforeRole);
    expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(beforeMessages);
    expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
      1,
    );
  });

  it.each(["foreign owner", "foreign space", "unbound", "changed source"] as const)(
    "rejects a human criterion edit with %s without persisted writes",
    async (mode) => {
      const f = await researchFixture(false, true);
      const before = await prisma.message.count({ where: { threadId: f.thread.id } });
      const beforeRole = await prisma.recruitingRole.findUniqueOrThrow({
        where: { id: f.role.role.id },
      });
      if (mode === "unbound")
        await prisma.thread.update({
          where: { id: f.thread.id },
          data: { activeRecruitingRoleId: null },
        });
      if (mode === "changed source")
        await prisma.message.update({
          where: { id: f.original.id },
          data: { blocks: [{ kind: "text", text: "Changed original material" }] },
        });
      const requester = {
        ...actor,
        ...(mode === "foreign owner" ? { userId: otherUserId } : {}),
        ...(mode === "foreign space" ? { spaceId: otherSpaceId } : {}),
      };
      await expect(
        recruiting.editRecruitingCriteria(prisma, requester, {
          threadId: f.thread.id,
          roleId: f.role.role.id,
          expectedRevision: f.role.role.revision,
          criteria: [
            {
              criterionId: "compensation",
              priority: "preferred",
              atoms: [{ atomId: "salary", statement: "GBP 100,000 to 120,000" }],
            },
          ],
        }),
      ).rejects.toThrow();
      expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before);
      expect(
        await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }),
      ).toEqual(beforeRole);
      expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
        1,
      );
    },
  );

  it("accepts one brief confirmation across two real database connections", async () => {
    const f = await researchFixture(false);
    const before = await prisma.message.count({ where: { threadId: f.thread.id } });
    const second = createDb(databaseUrl!);
    try {
      const input = {
        threadId: f.thread.id,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
      };
      const settled = await Promise.allSettled([
        recruiting.confirmRecruitingBrief(prisma, actor, input),
        recruiting.confirmRecruitingBrief(second.prisma, actor, input),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
        recruiting.RecruitingConflictError,
      );
      const current = await recruiting.getRecruitingWorkspace(second.prisma, actor, {
        threadId: f.thread.id,
      });
      expect(current?.role.revision).toBe(2);
      expect(current?.revision.brief?.confirmation?.revision).toBe(2);
      expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before + 1);
      expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
        2,
      );
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it("rechecks the current revision after confirmation preflight races a committed edit", async () => {
    const f = await researchFixture(false);
    const before = await prisma.message.count({ where: { threadId: f.thread.id } });
    const second = createDb(databaseUrl!);
    let release!: () => void;
    let loaded!: () => void;
    let paused = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preflight = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const observed = second.prisma.$extends({
      query: {
        recruitingRoleRevision: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (args.where?.id === f.draft.revision.id && !paused) {
              paused = true;
              loaded();
              await gate;
            }
            return result;
          },
        },
      },
    });
    const pending = recruiting.confirmRecruitingBrief(observed as unknown as PrismaClient, actor, {
      threadId: f.thread.id,
      roleId: f.role.role.id,
      expectedRevision: f.role.role.revision,
    });
    const result = expect(pending).rejects.toThrow(recruiting.RecruitingConflictError);
    try {
      await Promise.race([preflight, pending]);
      expect(paused).toBe(true);
      const revised = await recruiting.reviseRecruitingRole(prisma, actor, {
        ...f.definition,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
        title: "Human-edited research role",
      });
      release();
      await result;
      const current = await recruiting.getRecruitingWorkspace(second.prisma, actor, {
        threadId: f.thread.id,
      });
      expect(current).toEqual({ ...revised, crmTarget: null });
      expect(current?.revision.brief?.confirmation).toBeNull();
      expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before);
      expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
        2,
      );
    } finally {
      release();
      await Promise.allSettled([pending, result]);
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it("rolls back the human receipt, message sequence and role pointer after a confirmation write fails", async () => {
    const f = await researchFixture(false);
    const beforeThread = await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } });
    const beforeRole = await prisma.recruitingRole.findUniqueOrThrow({
      where: { id: f.role.role.id },
    });
    const beforeMessages = await prisma.message.count({ where: { threadId: f.thread.id } });
    const failure = new Error("Injected failure after the actual confirmed role pointer update");
    const failing = prisma.$extends({
      query: {
        recruitingRole: {
          async updateMany({ args, query }) {
            await query(args);
            throw failure;
          },
        },
      },
    });
    await expect(
      recruiting.confirmRecruitingBrief(failing as unknown as PrismaClient, actor, {
        threadId: f.thread.id,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
      }),
    ).rejects.toThrow(failure);
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: f.thread.id } })).toEqual(
      beforeThread,
    );
    expect(
      await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }),
    ).toEqual(beforeRole);
    expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(beforeMessages);
    expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
      1,
    );
  });

  it.each(["foreign owner", "foreign space", "changed source"] as const)(
    "rejects brief confirmation with %s without saving a receipt or revision",
    async (mode) => {
      const f = await researchFixture(false);
      const before = await prisma.message.count({ where: { threadId: f.thread.id } });
      const beforeRole = await prisma.recruitingRole.findUniqueOrThrow({
        where: { id: f.role.role.id },
      });
      if (mode === "changed source")
        await prisma.message.update({
          where: { id: f.original.id },
          data: { blocks: [{ kind: "text", text: "A different unconfirmed salary." }] },
        });
      const requester = {
        ...actor,
        ...(mode === "foreign owner" ? { userId: otherUserId } : {}),
        ...(mode === "foreign space" ? { spaceId: otherSpaceId } : {}),
      };
      await expect(
        recruiting.confirmRecruitingBrief(prisma, requester, {
          threadId: f.thread.id,
          roleId: f.role.role.id,
          expectedRevision: f.role.role.revision,
        }),
      ).rejects.toThrow();
      expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(before);
      expect(
        await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }),
      ).toEqual(beforeRole);
      expect(await prisma.recruitingRoleRevision.count({ where: { roleId: f.role.role.id } })).toBe(
        1,
      );
    },
  );

  it("rejects research preparation for a draft brief without creating a task or action", async () => {
    const f = await researchFixture(false);
    await expect(
      recruiting.prepareRecruitingResearchAction(prisma, actor, f.input),
    ).rejects.toThrow(/Confirm the current recruiting brief/);
    expect(await prisma.recruitingResearchTask.count({ where: { roleId: f.role.role.id } })).toBe(
      0,
    );
    expect(await prisma.recruitingResearchAction.count({ where: { runId: f.run.id } })).toBe(0);
  });

  it("rejects stale pre-confirmation research revisions even after the human confirms", async () => {
    const f = await researchFixture();
    await expect(
      recruiting.prepareRecruitingResearchAction(prisma, actor, {
        ...f.input,
        expectedRoleRevision: f.draft.role.revision,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(await prisma.recruitingResearchAction.count({ where: { runId: f.run.id } })).toBe(0);
  });

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
    cursor?: string,
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
        args: { task_id: "provider-task", ...(cursor === undefined ? {} : { cursor }) },
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
      purpose: f.input.purpose,
      approvalEffectId: f.input.approvalEffectId,
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
        expectedRevision: f.role.role.revision,
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
      expectedRevision: f.role.role.revision,
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

  it.each(["executing", "uncertain"])(
    "atomically settles an %s research effect and exposes durable unknown delivery without a provider receipt",
    async (status) => {
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
      const result = { error: "Provider response interrupted", uncertain: true as const };
      if (status === "uncertain")
        await prisma.externalEffect.update({
          where: { id: admitted.effect!.id },
          data: { status, result },
        });
      const input = {
        ...f.lease,
        taskId: prepared.task.id,
        actionId: prepared.action.id,
        effectId: admitted.effect!.id,
        effectKind: admitted.effect!.kind,
        effectRequest: admitted.effect!.request!,
        result,
      };
      const artifacts = await prisma.artifact.count({ where: { runId: f.run.id } });
      await recruiting.settleUncertainRecruitingResearchAction(prisma, actor, input);
      await recruiting.settleUncertainRecruitingResearchAction(prisma, actor, input);
      expect(
        await prisma.externalEffect.findUniqueOrThrow({ where: { id: input.effectId } }),
      ).toMatchObject({ status: "uncertain", request: admitted.effect!.request, result });
      const listed = await recruiting.listRecruitingResearch(prisma, actor, {
        roleId: f.role.role.id,
      });
      expect(listed.tasks).toContainEqual(
        expect.objectContaining({
          id: input.taskId,
          state: "unknown",
          pendingActionId: input.actionId,
        }),
      );
      expect(listed.actions).toContainEqual(
        expect.objectContaining({
          id: input.actionId,
          deliveryState: "unknown",
          receiptArtifact: null,
        }),
      );
      expect(await prisma.artifact.count({ where: { runId: f.run.id } })).toBe(artifacts);
      expect(
        await prisma.event.count({
          where: {
            runId: f.run.id,
            type: "recruiting.action.transitioned",
            payload: { path: ["to"], equals: "unknown" },
          },
        }),
      ).toBe(1);
      expect(
        (
          await recruiting.admitRecruitingResearchAction(
            prisma,
            actor,
            researchAdmission(f, prepared),
          )
        ).status,
      ).toBe("unknown");
      expect(
        await recruiting.claimRecruitingResearchAction(prisma, actor, {
          ...f.lease,
          actionId: input.actionId,
          effectId: input.effectId,
          from: "intended",
        }),
      ).toBe(false);
    },
  );

  it("settles a dispatched research outcome after Stop without reopening the cancelled run or task", async () => {
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
    await prisma.$transaction((tx) =>
      recruiting.cancelRunsInTransaction(tx, [{ id: f.run.id, taskId: f.run.taskId }], new Date()),
    );
    const stopped = await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(stopped).toMatchObject({
      status: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseFence: f.lease.leaseFence,
    });
    await recruiting.settleUncertainRecruitingResearchAction(prisma, actor, {
      ...f.lease,
      taskId: prepared.task.id,
      actionId: prepared.action.id,
      effectId: admitted.effect!.id,
      effectKind: admitted.effect!.kind,
      effectRequest: admitted.effect!.request!,
      result: { error: "Aborted after dispatch", uncertain: true },
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(stopped);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: f.run.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }),
    ).toMatchObject({ status: "uncertain" });
    expect(
      await prisma.recruitingResearchAction.findUniqueOrThrow({
        where: { id: prepared.action.id },
      }),
    ).toMatchObject({ deliveryState: "unknown", receiptArtifactId: null });
    expect(
      await prisma.recruitingResearchTask.findUniqueOrThrow({ where: { id: prepared.task.id } }),
    ).toMatchObject({ state: "unknown", pendingActionId: prepared.action.id });
  });

  it("rolls back native uncertainty with the domain transition if the task update fails", async () => {
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
    const failure = new Error("Injected research task update failure");
    const failing = prisma.$extends({
      query: {
        recruitingResearchTask: {
          async update({ args, query }) {
            await query(args);
            throw failure;
          },
        },
      },
    });
    await expect(
      recruiting.settleUncertainRecruitingResearchAction(
        failing as unknown as PrismaClient,
        actor,
        {
          ...f.lease,
          taskId: prepared.task.id,
          actionId: prepared.action.id,
          effectId: admitted.effect!.id,
          effectKind: admitted.effect!.kind,
          effectRequest: admitted.effect!.request!,
          result: { error: "Provider response interrupted", uncertain: true },
        },
      ),
    ).rejects.toThrow(failure);
    expect(
      await prisma.externalEffect.findUniqueOrThrow({ where: { id: admitted.effect!.id } }),
    ).toMatchObject({ status: "executing" });
    expect(
      await prisma.recruitingResearchAction.findUniqueOrThrow({
        where: { id: prepared.action.id },
      }),
    ).toMatchObject({ deliveryState: "sending", receiptArtifactId: null });
    expect(
      await prisma.recruitingResearchTask.findUniqueOrThrow({ where: { id: prepared.task.id } }),
    ).toMatchObject({ state: "active", pendingActionId: prepared.action.id });
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
      expectedRevision: f.role.role.revision,
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
      const revisedDraft = await recruiting.reviseRecruitingRole(prisma, actor, {
        ...f.definition,
        roleId: f.role.role.id,
        expectedRevision: f.role.role.revision,
        title: "Corrected role",
      });
      expect(revisedDraft.revision.brief?.confirmation).toBeNull();
      await expect(
        recruiting.prepareRecruitingResearchAction(prisma, actor, {
          ...f.input,
          expectedRoleRevision: revisedDraft.role.revision,
          clientNonce: `${f.input.clientNonce}-draft`,
          requestArtifact: f.metadata("request-draft"),
        }),
      ).rejects.toThrow(/Confirm the current recruiting brief/);
      const revised = await recruiting.confirmRecruitingBrief(prisma, actor, {
        threadId: f.thread.id,
        roleId: revisedDraft.role.id,
        expectedRevision: revisedDraft.role.revision,
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
        expectedRoleRevision: revised.role.revision,
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

  const canonicalCandidateRow = (
    name: string,
    linkedinUrl: string | null,
    company = "Example Company",
  ) => ({
    name: { value: name, source_id: "person" },
    linkedin_url: { value: linkedinUrl, source_id: "person" },
    current_title: { value: "Engineer", source_id: "person" },
    current_company: { value: company, source_id: "person" },
    location: { value: "London", source_id: "person" },
    resume_url: { value: null, source_id: "person" },
    evidence_urls: { value: ["https://example.test/project"], source_id: "person" },
    _sources: { person: "https://example.test/original" },
  });
  async function recordCandidatePage(
    f: Awaited<ReturnType<typeof researchFixture>>,
    prepared: Awaited<ReturnType<typeof recruiting.prepareRecruitingResearchAction>>,
    label: string,
    rows: Prisma.InputJsonValue[],
    options: { historicalBackfill?: boolean; observedAt?: Date; cursor?: string } = {},
  ) {
    const rawResult = {
      structuredContent: { rows, output_id: `output-${label}`, next_cursor: `next-${label}` },
    };
    const identity = await completedResearchRead(
      f,
      prepared.action.id,
      label,
      "get_rows",
      rawResult,
      options.cursor,
    );
    if (options.observedAt)
      await prisma.externalEffect.update({
        where: { id: identity.effectId },
        data: { updatedAt: options.observedAt },
      });
    const input = {
      ...identity,
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows" as const,
      rows,
      outputId: `output-${label}`,
      cursor: `next-${label}`,
      historicalBackfill: options.historicalBackfill,
      outputArtifact: {
        ...f.metadata(label),
        clientNonce: `recruiting-observation:${identity.effectId}`,
      },
    };
    const saved = await recordResearchRead(input);
    return { saved, input };
  }

  async function approveCrmEffect(
    f: Awaited<ReturnType<typeof researchFixture>>,
    effect: { id: string; request: unknown },
  ) {
    const card = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      runId: f.run.id,
      botId,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Approve this exact CRM action",
          approvalEffectId: effect.id,
          status: "answered",
          answer: "allow",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    await recruiting.appendEvent(prisma, {
      spaceId,
      threadId: f.thread.id,
      botId,
      runId: f.run.id,
      type: "effect.approval.answered",
      payload: {
        effectId: effect.id,
        messageId: card.id,
        askIndex: 0,
        answeredByUserId: userId,
        answer: "allow",
        requestHash: createHash("sha256").update(stableJsonValue(effect.request)).digest("hex"),
      },
    });
  }

  async function crmCandidateFixture(humanApproval = true) {
    const { f, prepared } = await mappedResearchFixture();
    const page = await recordCandidatePage(f, prepared, "crm-candidate", [
      canonicalCandidateRow("Example", "https://www.linkedin.com/in/example"),
    ]);
    const server = await prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: `crm-${f.run.id}`,
        name: "Synthetic CRM",
        transport: "http",
        assignments: {
          create: {
            spaceId,
            userId,
            botId,
            allowAllTools: false,
            allowedTools: ["get_crm_role", "crm_import_candidate"],
          },
        },
      },
    });
    const target = {
      mcpServerId: server.id,
      serverRevision: server.revision,
      organizationId: "10000000-0000-4000-8000-000000000001",
      crmRoleId: "20000000-0000-4000-8000-000000000002",
      crmClientId: "30000000-0000-4000-8000-000000000003",
      clientLabel: "Synthetic Client",
      roleLabel: "Engineer",
    };
    const read = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: "mcp__crm__get_crm_role",
        idempotencyKey: `crm-read:${f.run.id}`,
        status: "completed",
        request: boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: server.id,
            resourceRevision: server.revision,
            toolName: "get_crm_role",
          },
          { p_org: target.organizationId, p_role: target.crmRoleId },
          "__rakazoCatalogTool",
        ) as Prisma.InputJsonValue,
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
      },
    });
    const bindInput = {
      operation: "bind" as const,
      roleId: f.role.role.id,
      expectedRoleRevision: f.role.role.revision,
      expectedBindingEffectId: null,
      crmRoleReadEffectId: read.id,
    };
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: "recruiting_crm_target",
        idempotencyKey: `crm-bind:${f.run.id}`,
        status: "executing",
        request: bindInput,
      },
    });
    if (humanApproval) await approveCrmEffect(f, effect);
    const trusted = { ...f.lease, threadId: f.thread.id, botId };
    const saved = await recruiting.executeRecruitingCrmBinding(
      prisma,
      actor,
      { ...trusted, effectId: effect.id, effectRequest: bindInput },
      bindInput,
    );
    const input = {
      roleId: f.role.role.id,
      candidateKey: "linkedin:/in/example",
      bindingEffectId: effect.id,
      sourceEffectId: page.input.effectId,
      rowIndex: 0,
    };
    const resolved = (await recruiting.resolveRecruitingCrmImport(prisma, actor, trusted, input))!;
    const native = {
      effectKind: "mcp__crm__crm_import_candidate",
      effectRequest: boundDirectApprovalRequest(
        resolved.route,
        resolved.args,
        "__rakazoCatalogTool",
      ),
    };
    return { f, page, server, target, trusted, saved, input, native, resolved };
  }

  it("binds and claims internal CRM storage without human approval while retaining one native claim", async () => {
    const f = await crmCandidateFixture(false);
    const first = await recruiting.admitRecruitingCrmImport(
      prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    const claim = { ...f.native, effectId: first.effect.id, from: "intended" as const };
    expect(
      await recruiting.claimRecruitingCrmImport(prisma, actor, f.trusted, f.input, claim),
    ).toBe(true);
    expect(
      await recruiting.claimRecruitingCrmImport(prisma, actor, f.trusted, f.input, claim),
    ).toBe(false);
    expect(
      await prisma.event.count({ where: { runId: f.f.run.id, type: "effect.approval.answered" } }),
    ).toBe(0);
  });
  it("reserves a CRM source import once and rechecks native human approval and current binding at dispatch", async () => {
    const f = await crmCandidateFixture();
    expect(
      (await recruiting.getRecruitingWorkspace(prisma, actor, { threadId: f.f.thread.id }))?.role,
    ).not.toHaveProperty("crmBindingEffectId");
    const [first, second] = await Promise.all([
      recruiting.admitRecruitingCrmImport(prisma, actor, f.trusted, f.input, f.native),
      recruiting.admitRecruitingCrmImport(prisma, actor, f.trusted, f.input, f.native),
    ]);
    expect(first.effect.id).toBe(second.effect.id);
    expect(
      await prisma.recruitingCrmImport.count({
        where: {
          bindingEffectId: f.input.bindingEffectId,
          pageId: f.input.sourceEffectId,
          rowIndex: 0,
        },
      }),
    ).toBe(1);
    await prisma.externalEffect.update({
      where: { id: first.effect.id },
      data: { status: "approved" },
    });
    await expect(
      recruiting.claimRecruitingCrmImport(prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: first.effect.id,
        from: "approved",
      }),
    ).rejects.toThrow(IsolationError);
    await approveCrmEffect(f.f, first.effect);
    const canonical = await recruiting.resolveRecruitingCrmImport(
      prisma,
      actor,
      { ...f.trusted, approvedEffectId: first.effect.id },
      { ...f.input, candidateKey: "model-retargeted", rowIndex: 99 },
    );
    expect(canonical?.input).toEqual(f.input);
    await prisma.recruitingRole.update({
      where: { id: f.input.roleId },
      data: { crmBindingEffectId: null },
    });
    await expect(
      recruiting.claimRecruitingCrmImport(prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: first.effect.id,
        from: "approved",
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    await prisma.recruitingRole.update({
      where: { id: f.input.roleId },
      data: { crmBindingEffectId: f.input.bindingEffectId },
    });
    expect(
      await recruiting.claimRecruitingCrmImport(prisma, actor, f.trusted, f.input, {
        ...f.native,
        effectId: first.effect.id,
        from: "approved",
      }),
    ).toBe(true);
  });

  it("rolls back native import allocation if its immutable source link cannot be written", async () => {
    const f = await crmCandidateFixture();
    const before = await prisma.externalEffect.count({ where: { runId: f.f.run.id } });
    const failure = new Error("Injected CRM source-link failure");
    const failing = prisma.$extends({
      query: {
        recruitingCrmImport: {
          async create({ args, query }) {
            await query(args);
            throw failure;
          },
        },
      },
    });
    await expect(
      recruiting.admitRecruitingCrmImport(
        failing as unknown as PrismaClient,
        actor,
        f.trusted,
        f.input,
        f.native,
      ),
    ).rejects.toThrow(failure);
    expect(await prisma.externalEffect.count({ where: { runId: f.f.run.id } })).toBe(before);
    expect(
      await prisma.recruitingCrmImport.count({ where: { pageId: f.input.sourceEffectId } }),
    ).toBe(0);
  });

  it("keeps historical CRM receipt membership visible after the current target is cleared", async () => {
    const f = await crmCandidateFixture();
    const admitted = await recruiting.admitRecruitingCrmImport(
      prisma,
      actor,
      f.trusted,
      f.input,
      f.native,
    );
    await prisma.externalEffect.update({
      where: { id: admitted.effect.id },
      data: {
        status: "completed",
        result: {
          structuredContent: {
            data: {
              candidate_id: "40000000-0000-4000-8000-000000000004",
              source_id: "50000000-0000-4000-8000-000000000005",
              membership_id: "60000000-0000-4000-8000-000000000006",
              organization_id: f.target.organizationId,
              role_spec_id: f.target.crmRoleId,
              linkedin_identity: "/in/example",
              source_file: f.resolved.args.p_source_file,
            },
          },
        },
      },
    });
    await prisma.recruitingRole.update({
      where: { id: f.input.roleId },
      data: { crmBindingEffectId: null },
    });
    await prisma.mcpServer.update({ where: { id: f.server.id }, data: { enabled: false } });
    const candidates = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.input.roleId,
    });
    expect(candidates.crmTarget).toBeNull();
    expect(candidates.items[0]?.crm).toBeNull();
    const sources = await recruiting.listRecruitingCandidateSources(prisma, actor, {
      roleId: f.input.roleId,
      candidateKey: f.input.candidateKey,
    });
    expect(sources.items[0]?.crmImports[0]).toMatchObject({
      status: "synced",
      target: f.target,
      receipt: { source_file: f.resolved.args.p_source_file },
    });
  });

  it("indexes every raw row, deduplicates only canonical profiles and pages using real totals", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const first = await recordCandidatePage(
      f,
      prepared,
      "candidate-first",
      [
        canonicalCandidateRow("Example", "https://linkedin.com/in/Example?trk=source"),
        canonicalCandidateRow("Repeated", "https://www.linkedin.com/in/EXAMPLE/"),
        null as unknown as Prisma.InputJsonValue,
        {
          Name: "Unmapped name",
          _sources: { profile: "https://www.linkedin.com/in/NotAnIdentity" },
        },
      ],
      { observedAt: new Date("2026-10-16T00:00:00Z"), cursor: "exact-input-cursor" },
    );
    const latest = await recordCandidatePage(
      f,
      prepared,
      "candidate-next",
      [
        canonicalCandidateRow(
          "Example newest",
          "https://www.linkedin.com/in/example",
          "New Company",
        ),
        canonicalCandidateRow("Other", "https://www.linkedin.com/in/other"),
      ],
      { observedAt: new Date("2026-10-16T01:00:00Z") },
    );
    const page = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      limit: 2,
      sort: "name",
    });
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);
    expect(page.counts).toEqual({
      sourceRows: 6,
      candidates: 4,
      identifiedCandidates: 2,
      unassessed: 4,
      assessed: 0,
      shortlisted: 0,
    });
    const next = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      limit: 2,
      sort: "name",
      cursor: page.nextCursor!,
    });
    expect(new Set([...page.items, ...next.items].map((item) => item.candidateKey)).size).toBe(4);
    expect(next.nextCursor).toBeNull();
    const filtered = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      query: "new company",
      assessmentState: "unassessed",
    });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]).toMatchObject({
      candidateKey: "linkedin:/in/example",
      name: "Example newest",
      company: "New Company",
      discoveryCount: 3,
      latestAssessment: null,
    });
    const sources = await recruiting.listRecruitingCandidateSources(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: "linkedin:/in/example",
      limit: 1,
    });
    expect(sources.total).toBe(3);
    expect(sources.items[0]).toMatchObject({
      effectId: latest.input.effectId,
      rowIndex: 0,
      observedAt: "2026-10-16T01:00:00.000Z",
    });
    expect(sources.nextCursor).not.toBeNull();
    const older = await recruiting.listRecruitingCandidateSources(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: "linkedin:/in/example",
      limit: 1,
      cursor: sources.nextCursor!,
    });
    expect(older.items[0]).toMatchObject({
      taskId: prepared.task.id,
      actionId: prepared.action.id,
      roleRevisionId: prepared.action.roleRevisionId,
      effectId: first.input.effectId,
      rowIndex: 1,
      artifactRef: {
        artifactId: first.saved.outputArtifact.id,
        sha256: first.saved.outputArtifact.hash,
      },
      requestCursor: "exact-input-cursor",
      outputId: "output-candidate-first",
    });
    const last = await recruiting.listRecruitingCandidateSources(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: "linkedin:/in/example",
      limit: 1,
      cursor: older.nextCursor!,
    });
    expect(last.items[0]).toMatchObject({ effectId: first.input.effectId, rowIndex: 0 });
    expect(last.nextCursor).toBeNull();
    await expect(
      recruiting.listRecruitingCandidateSources(
        prisma,
        { ...actor, userId: otherUserId },
        { roleId: f.role.role.id, candidateKey: "linkedin:/in/example" },
      ),
    ).rejects.toThrow(IsolationError);
    await recordResearchRead(first.input);
    expect(
      await prisma.recruitingCandidateOccurrence.count({ where: { roleId: f.role.role.id } }),
    ).toBe(6);
    const unresolved = [...page.items, ...next.items].filter((item) => item.linkedinUrl === null);
    expect(unresolved).toHaveLength(2);
    expect(unresolved.every((item) => item.name === null && item.issues.length > 0)).toBe(true);
  });

  it("score-sorts a role whose several saved results carry provider cell objects", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const cell = (value: number) => ({ value, source_id: "91872", source_ids: ["d7203"] });
    const rows = (scores: [string, number, number][]) =>
      scores.map(([key, rank, score]) => ({
        ...canonicalCandidateRow(`Cell ${key}`, `https://www.linkedin.com/in/cell-${key}`),
        rank: cell(rank),
        match_score: cell(score),
      }));
    for (const [label, day, scores] of [
      [
        "cells-1",
        "17",
        [
          ["a", 1, 90],
          ["b", 2, 80],
          ["c", 3, 70],
        ],
      ],
      [
        "cells-2",
        "18",
        [
          ["a", 3, 40],
          ["b", 2, 50],
          ["c", 1, 60],
        ],
      ],
      [
        "cells-3",
        "19",
        [
          ["a", 2, 62],
          ["b", 3, 45],
          ["c", 1, 82],
        ],
      ],
    ] as const)
      await recordCandidatePage(f, prepared, label, rows(scores as never), {
        observedAt: new Date(`2026-10-${day}T00:00:00Z`),
        cursor: label,
      });
    const page = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "score",
    });
    expect(page.sortAvailability.score).toBe(true);
    expect(page.items.map((item) => [item.candidateKey, item.match?.score])).toEqual([
      ["linkedin:/in/cell-c", 82],
      ["linkedin:/in/cell-a", 62],
      ["linkedin:/in/cell-b", 45],
    ]);
    // A list already sorted by name still offers the score sort.
    const byName = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "name",
    });
    expect(byName.sortAvailability).toMatchObject({ rank: true, score: true });
  });

  it("shows a result answered on 0–10 on the 0–100 scale", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const row = (key: string, match: Prisma.InputJsonObject) => ({
      ...canonicalCandidateRow(`Ten ${key}`, `https://www.linkedin.com/in/ten-${key}`),
      ...match,
    });
    await recordCandidatePage(f, prepared, "match-ten", [
      row("a", { match_score: { value: 8.5 } }),
      row("b", { match_score: "6" }),
      row("c", { score: "7/10" }),
      row("d", { match_score: null }),
    ]);
    const page = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "score",
    });
    expect(page.items.map((item) => [item.candidateKey, item.match?.score])).toEqual([
      ["linkedin:/in/ten-a", 85],
      ["linkedin:/in/ten-c", 70],
      ["linkedin:/in/ten-b", 60],
      ["linkedin:/in/ten-d", null],
    ]);
  });

  it("orders native ranks, tiers and scores across numeric, tie and unknown cursor boundaries with source proof", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const row = (key: string, match: Prisma.InputJsonObject) => ({
      ...canonicalCandidateRow(`Order ${key}`, `https://www.linkedin.com/in/order-${key}`),
      ...match,
    });
    const original = await recordCandidatePage(
      f,
      prepared,
      "match-original",
      [
        row("a", { updated_rank: { value: 10 }, match_tier: { value: "Strong" }, match_score: 55 }),
        row("b", { updated_rank: 2, match_tier: "Promising", match_score: { value: 72.5 } }),
        row("c", {
          updated_rank: { value: 1 },
          match_tier: { value: "Uncertain" },
          match_score: 72.5,
        }),
        row("d", {
          updated_rank: { value: 2 },
          match_tier: { value: "Partial" },
          match_score: { value: 0 },
        }),
        row("e", { rank: 1, match_tier: "Unrecognized", match_score: null }),
        row("f", { updated_rank: null, match_tier: "Strong", match_score: "90" }),
        row("g", { updated_rank: "3", match_tier: null, match_score: { value: true } }),
        row("h", { updated_rank: 1.5, match_score: { value: -0.5 } }),
        row("i", { updated_rank: -1 }),
        row("j", { updated_rank: 9007199254740992 }),
      ],
      { observedAt: new Date("2026-10-16T00:00:00Z") },
    );
    const key = (suffix: string) => `linkedin:/in/order-${suffix}`;
    let rankCursor: string | undefined;
    let scoreCursor: string | undefined;
    for (const [sort, expected] of [
      ["rank", ["c", "e", "b", "d", "g", "a", "f", "h", "i", "j"]],
      ["tier", ["a", "f", "b", "d", "c", "e", "g", "h", "i", "j"]],
      ["score", ["f", "b", "c", "a", "d", "h", "e", "g", "i", "j"]],
    ] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await recruiting.listRecruitingCandidates(prisma, actor, {
          roleId: f.role.role.id,
          sort,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.total).toBe(10);
        seen.push(...page.items.map((item) => item.candidateKey));
        cursor = page.nextCursor ?? undefined;
        if (sort === "rank" && !rankCursor) rankCursor = cursor;
        if (sort === "score" && !scoreCursor) scoreCursor = cursor;
      } while (cursor);
      expect(seen).toEqual(expected.map(key));
      expect(new Set(seen).size).toBe(10);
    }
    await expect(
      recruiting.listRecruitingCandidates(prisma, actor, {
        roleId: f.role.role.id,
        sort: "tier",
        cursor: rankCursor,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    const compact = await recordCandidatePage(f, prepared, "match-omitted", [row("a", {})], {
      observedAt: new Date("2026-10-16T01:00:00Z"),
    });
    await expect(
      recruiting.listRecruitingCandidates(prisma, actor, {
        roleId: f.role.role.id,
        sort: "score",
        cursor: scoreCursor,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    const unavailable = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "score",
    });
    // A newer result without scores keeps the role's newest scored result sortable.
    expect(unavailable.sortAvailability.score).toBe(true);
    const saved = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "score",
      sourceEffectId: original.input.effectId,
    });
    expect(saved.sortAvailability.score).toBe(true);
    expect(saved.items.map((item) => item.candidateKey)).toEqual(
      ["f", "b", "c", "a", "d", "h", "e", "g", "i", "j"].map(key),
    );
    // Shown on 0–100: 72.5 rounds, a negative score clamps to 0.
    expect(saved.items.map((item) => item.match?.score)).toEqual([
      90,
      73,
      73,
      55,
      0,
      0,
      null,
      null,
      null,
      null,
    ]);
    await expect(
      recruiting.listRecruitingCandidates(prisma, actor, {
        roleId: f.role.role.id,
        sort: "score",
        sourceEffectId: original.input.effectId,
        cursor: scoreCursor,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    await expect(
      recruiting.listRecruitingCandidates(prisma, actor, {
        roleId: f.role.role.id,
        sort: "rank",
        cursor: rankCursor,
      }),
    ).rejects.toThrow(recruiting.RecruitingConflictError);
    expect(
      (
        await recruiting.listRecruitingCandidates(prisma, actor, {
          roleId: f.role.role.id,
          sort: "rank",
          limit: 10,
        })
      ).items.map((item) => item.candidateKey),
    ).toEqual(["c", "b", "d", "a", "e", "f", "g", "h", "i", "j"].map(key));
    await recordCandidatePage(
      f,
      prepared,
      "match-cleared",
      [row("b", { updated_rank: null, match_tier: null })],
      {
        observedAt: new Date("2026-10-16T02:00:00Z"),
      },
    );
    expect(
      (
        await recruiting.listRecruitingCandidates(prisma, actor, {
          roleId: f.role.role.id,
          sort: "rank",
          limit: 10,
        })
      ).items.map((item) => item.candidateKey),
    ).toEqual(["c", "d", "a", "b", "e", "f", "g", "h", "i", "j"].map(key));
    await prisma.artifact.update({
      where: { id: original.saved.outputArtifact.id },
      data: { hash: "f".repeat(64) },
    });
    expect(
      (
        await recruiting.listRecruitingCandidates(prisma, actor, {
          roleId: f.role.role.id,
          sort: "recent",
          query: "Order a",
        })
      ).items[0]?.latestSource?.effectId,
    ).toBe(compact.input.effectId);
    await expect(
      recruiting.listRecruitingCandidates(prisma, actor, {
        roleId: f.role.role.id,
        sort: "rank",
        query: "Order a",
      }),
    ).rejects.toThrow(IsolationError);
  });

  it("retains omitted profile fields but preserves explicit null, invalid and blank updates", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const profile = canonicalCandidateRow("Example", "https://www.linkedin.com/in/example");
    await recordCandidatePage(f, prepared, "profile-full", [profile], {
      observedAt: new Date("2026-10-16T00:00:00Z"),
    });
    const compact = { name: profile.name, linkedin_url: profile.linkedin_url, updated_rank: 1 };
    const latest = await recordCandidatePage(f, prepared, "profile-compact", [compact], {
      observedAt: new Date("2026-10-16T01:00:00Z"),
    });
    const listed = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      query: "Example Company",
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      title: "Engineer",
      company: "Example Company",
      location: "London",
      evidenceUrls: ["https://example.test/project"],
      latestSource: { effectId: latest.input.effectId, rowIndex: 0 },
    });
    await recordCandidatePage(
      f,
      prepared,
      "profile-unknown",
      [{ ...compact, current_title: null, current_company: 42, location: " " }],
      { observedAt: new Date("2026-10-16T02:00:00Z") },
    );
    const final = await recordCandidatePage(f, prepared, "profile-compact-again", [compact], {
      observedAt: new Date("2026-10-16T03:00:00Z"),
    });
    const unknown = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    expect(unknown.items[0]).toMatchObject({
      title: null,
      company: null,
      location: null,
      evidenceUrls: ["https://example.test/project"],
      latestSource: { effectId: final.input.effectId, rowIndex: 0 },
    });
    expect(
      (
        await recruiting.listRecruitingCandidates(prisma, actor, {
          roleId: f.role.role.id,
          query: "Example Company",
        })
      ).total,
    ).toBe(0);
  });

  it("recovers already recorded native pages without moving the current cursor or overwriting newer profiles", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const old = await recordCandidatePage(
      f,
      prepared,
      "candidate-old",
      [canonicalCandidateRow("Old name", "https://www.linkedin.com/in/example")],
      { observedAt: new Date("2026-10-16T00:00:00Z") },
    );
    await recordCandidatePage(
      f,
      prepared,
      "candidate-current",
      [canonicalCandidateRow("Current name", "https://www.linkedin.com/in/EXAMPLE?trk=new")],
      { observedAt: new Date("2026-10-16T02:00:00Z") },
    );
    await prisma.recruitingCandidatePage.delete({ where: { effectId: old.input.effectId } });
    const before = await prisma.recruitingResearchAction.findUniqueOrThrow({
      where: { id: prepared.action.id },
    });
    const pending = await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
      runId: f.run.id,
      taskId: prepared.task.id,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.outputArtifact?.hash).toBe(old.saved.outputArtifact.hash);
    await recordResearchRead({
      ...old.input,
      historicalBackfill: true,
      cursor: "old-cursor",
      observedProviderState: "queued",
      usage: [{ scope: "task", unit: "credits", amount: 0 }],
    });
    expect(
      await prisma.recruitingResearchAction.findUniqueOrThrow({
        where: { id: prepared.action.id },
      }),
    ).toEqual(before);
    const list = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    expect(list.items[0]).toMatchObject({ name: "Current name", discoveryCount: 2 });
    expect(
      await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
        runId: f.run.id,
        taskId: prepared.task.id,
      }),
    ).toEqual([]);
  });

  it("requires a feedback card after the tenth saved candidate advances the real stage", async () => {
    const { f, prepared } = await mappedResearchFixture();
    await prisma.recruitingRole.update({
      where: { id: f.role.role.id },
      data: { playbookStage: "calibration_10" },
    });
    const rows = Array.from({ length: 10 }, (_, index) =>
      canonicalCandidateRow(
        `Calibration ${index}`,
        `https://www.linkedin.com/in/calibration-${index}`,
      ),
    );
    await recordCandidatePage(f, prepared, "calibration-first-nine", rows.slice(0, 9));
    expect(
      (await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }))
        .playbookStage,
    ).toBe("calibration_10");
    await recordCandidatePage(f, prepared, "calibration-tenth", rows.slice(9));
    expect(
      (await prisma.recruitingRole.findUniqueOrThrow({ where: { id: f.role.role.id } }))
        .playbookStage,
    ).toBe("feedback");
    const sendUserMessage = vi.fn(async () => ({
      messageId: "wake",
      seq: 1,
      taskId: "task",
      runId: "continued-run",
    }));
    const deps = {
      prisma,
      events: { sendUserMessage },
      jobs: { enqueue: vi.fn(async () => undefined) },
    };
    const input = {
      run: { id: f.run.id, spaceId, threadId: f.thread.id, botId, userId, trigger: "user" },
      roleId: f.role.role.id,
      handedOff: false,
      pendingApproval: false,
      postAssistant: vi.fn(async () => undefined),
    };
    expect(
      await guardRecruitingTurnEnd(deps, {
        ...input,
        blocks: [{ kind: "text", text: "Saved the ten profiles." }],
      }),
    ).toMatchObject({ action: "continued", stage: "feedback" });
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ internal: true, prompt: expect.stringContaining("原生问题卡") }),
    );
    sendUserMessage.mockClear();
    expect(
      await guardRecruitingTurnEnd(deps, {
        ...input,
        blocks: [
          {
            kind: "ask",
            text: "What feedback do you have on the calibration profiles?",
            status: "pending",
          },
        ],
      }),
    ).toEqual({ action: "ended", classification: "question" });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("rolls back candidate rows, page, artifact and native observation together after a write failure", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const rows = [
      canonicalCandidateRow("Rollback example", "https://www.linkedin.com/in/rollback"),
    ];
    const rawResult = { structuredContent: { rows } };
    const identity = await completedResearchRead(
      f,
      prepared.action.id,
      "candidate-rollback",
      "get_rows",
      rawResult,
    );
    const failure = new Error("Injected failure after candidate occurrences");
    const failing = prisma.$extends({
      query: {
        recruitingCandidateOccurrence: {
          async createMany({ args, query }) {
            await query(args);
            throw failure;
          },
        },
      },
    });
    await expect(
      recruiting.recordRecruitingResearchObservation(failing as unknown as PrismaClient, actor, {
        ...identity,
        runId: f.run.id,
        actionId: prepared.action.id,
        toolName: "get_rows",
        rows,
        outputArtifact: {
          ...f.metadata("rollback"),
          clientNonce: `recruiting-observation:${identity.effectId}`,
        },
      }),
    ).rejects.toThrow(failure);
    expect(await prisma.recruitingCandidatePage.count({ where: { roleId: f.role.role.id } })).toBe(
      0,
    );
    expect(await prisma.recruitingCandidate.count({ where: { roleId: f.role.role.id } })).toBe(0);
    expect(
      await prisma.artifact.count({
        where: { clientNonce: `recruiting-observation:${identity.effectId}` },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.recruitingResearchAction.findUniqueOrThrow({
          where: { id: prepared.action.id },
        })
      ).outputArtifacts,
    ).toEqual([]);
    expect(
      await prisma.event.count({
        where: {
          type: "recruiting.read",
          AND: [
            { payload: { path: ["phase"], equals: "recorded" } },
            { payload: { path: ["effectId"], equals: identity.effectId } },
          ],
        },
      }),
    ).toBe(0);
  });

  it("keeps historical schemas unresolved and marks zero-row native pages without sentinel candidates", async () => {
    const { f, prepared } = await mappedResearchFixture();
    await prisma.recruitingResearchAction.update({
      where: { id: prepared.action.id },
      data: { candidateOutputSchema: null },
    });
    await recordCandidatePage(f, prepared, "historical-candidate", [
      canonicalCandidateRow(
        "Never infer historical columns",
        "https://www.linkedin.com/in/historical",
      ),
    ]);
    const empty = await recordCandidatePage(f, prepared, "empty-candidate-page", []);
    const list = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    expect(list.total).toBe(1);
    expect(list.counts).toMatchObject({ sourceRows: 1, identifiedCandidates: 0, unassessed: 1 });
    expect(list.items[0]).toMatchObject({
      name: null,
      linkedinUrl: null,
      issues: ["historical_schema_unknown"],
    });
    expect(
      await prisma.recruitingCandidatePage.findUniqueOrThrow({
        where: { effectId: empty.input.effectId },
      }),
    ).toMatchObject({ rowCount: 0 });
  });

  it("backfills only recorded shortlist event dates", async () => {
    const sql = await readFile(
      new URL(
        "../prisma/migrations/20261023171000_recruiting_candidate_shortlisted_at/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE "messages" ("id" TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3)) ON COMMIT DROP',
      );
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE "recruiting_candidates" ("candidateKey" TEXT PRIMARY KEY, "shortlisted" BOOLEAN, "shortlistMessageId" TEXT) ON COMMIT DROP',
      );
      await tx.$executeRawUnsafe(`INSERT INTO "messages" VALUES ('event', '2026-10-01T12:00:00Z')`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "recruiting_candidates" VALUES ('known', true, 'event'), ('unknown', true, null), ('removed', false, 'event')`,
      );
      for (const statement of sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((part) => part.trim()))
        await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<
        { candidateKey: string; shortlistedAt: Date | null }[]
      >`SELECT "candidateKey", "shortlistedAt" FROM "recruiting_candidates" ORDER BY "candidateKey"`;
      expect(rows).toEqual([
        { candidateKey: "known", shortlistedAt: new Date("2026-10-01T12:00:00Z") },
        { candidateKey: "removed", shortlistedAt: null },
        { candidateKey: "unknown", shortlistedAt: null },
      ]);
    });
  });

  it("persists private notes and reads reminders across both person keys", async () => {
    const f = await assessmentFixture();
    const keys = ["autumn:profile-fixture", "crm:profile-fixture"];
    const note = await recruiting.createRecruitingCandidateNote(prisma, actor, {
      candidateKey: keys[0]!,
      roleId: f.role.role.id,
      body: "Follow up next week",
    });
    await recruiting.createRecruitingCandidateNote(prisma, actor, {
      candidateKey: keys[1]!,
      body: "Second source",
    });
    const other = { ...actor, userId: otherUserId };
    expect(
      (await recruiting.listRecruitingCandidateNotes(prisma, other, { candidateKeys: keys })).items,
    ).toEqual([]);
    await expect(
      recruiting.updateRecruitingCandidateNote(prisma, other, { id: note.id, body: "not allowed" }),
    ).rejects.toThrow(IsolationError);
    await recruiting.updateRecruitingCandidateNote(prisma, actor, {
      id: note.id,
      body: "Updated note",
    });
    expect(
      (await recruiting.listRecruitingCandidateNotes(prisma, actor, { candidateKeys: keys })).items,
    ).toHaveLength(2);
    await recruiting.deleteRecruitingCandidateNote(prisma, actor, note.id);
    expect(
      (await prisma.recruitingCandidateNote.findUniqueOrThrow({ where: { id: note.id } }))
        .deletedAt,
    ).not.toBeNull();
    expect(
      (await recruiting.listRecruitingCandidateNotes(prisma, actor, { candidateKeys: keys })).items,
    ).toHaveLength(1);
    for (const candidateKey of keys)
      await recruiting.createRecruitingReminder(prisma, actor, {
        candidateKey,
        title: "Call",
        dueAt: "2026-10-23T00:00:00Z",
      });
    expect(
      (await recruiting.listRecruitingReminders(prisma, actor, { candidateKeys: keys })).items,
    ).toHaveLength(2);
    expect(
      (await recruiting.listRecruitingReminders(prisma, other, { candidateKeys: keys })).items,
    ).toHaveLength(0);
  });

  it("lists newly assessed candidates independently of discovery and separates shortlist CAS from qualification", async () => {
    const f = await assessmentFixture();
    await recruiting.saveRecruitingAssessment(prisma, actor, f.context, f.input, f.artifacts);
    const page = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      assessmentState: "current",
      verdict: "met",
    });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      candidateKey: f.input.candidateKey,
      discoveryCount: 0,
      revision: 0,
      latestAssessment: { isCurrent: true, hardGate: "met", version: 1 },
    });
    const input = {
      threadId: f.thread.id,
      roleId: f.role.role.id,
      candidateKey: f.input.candidateKey,
      expectedRevision: 0,
      shortlisted: true,
    };
    expect(await recruiting.setRecruitingCandidateShortlist(prisma, actor, input)).toMatchObject({
      shortlisted: true,
      revision: 1,
    });
    const shortlisted = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    const shortlistedAt = shortlisted.items[0]?.shortlistedAt;
    expect(shortlistedAt).toEqual(expect.any(String));
    expect(Number.isFinite(Date.parse(shortlistedAt!))).toBe(true);
    const receipts = await prisma.message.count({ where: { threadId: f.thread.id } });
    expect(
      await recruiting.setRecruitingCandidateShortlist(prisma, actor, {
        ...input,
        expectedRevision: 1,
      }),
    ).toMatchObject({ revision: 1 });
    expect(await prisma.message.count({ where: { threadId: f.thread.id } })).toBe(receipts);
    await expect(recruiting.setRecruitingCandidateShortlist(prisma, actor, input)).rejects.toThrow(
      recruiting.RecruitingConflictError,
    );
    const old = await prisma.recruitingAssessment.findFirstOrThrow({
      where: { roleId: f.role.role.id, candidateKey: f.input.candidateKey },
    });
    await recruiting.reviseRecruitingRole(prisma, actor, {
      sourceRefs: f.role.revision.sourceRefs,
      criteria: f.role.revision.criteria,
      preferences: [],
      definitionQuestions: [],
      roleId: f.role.role.id,
      expectedRevision: f.role.role.revision,
      title: "Updated assessment role",
    });
    const stale = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      assessmentState: "outdated",
      shortlisted: true,
    });
    expect(stale.items[0]?.latestAssessment?.isCurrent).toBe(false);
    expect(stale.total).toBe(1);
    expect(stale.items[0]?.shortlistedAt).toBe(shortlistedAt);
    await recruiting.setRecruitingCandidateShortlist(prisma, actor, {
      ...input,
      expectedRevision: 1,
      shortlisted: false,
    });
    const removed = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    expect(removed.items[0]?.shortlistedAt).toBeNull();

    expect(
      await prisma.recruitingAssessment.findFirstOrThrow({
        where: { roleId: f.role.role.id, candidateKey: f.input.candidateKey },
      }),
    ).toEqual(old);
  });

  it("offers score sort when provider scores are numeric strings and rank is Unknown", async () => {
    const { f, prepared } = await mappedResearchFixture();
    await recordCandidatePage(
      f,
      prepared,
      "simulation-shape",
      [45, 35, "Unknown"].map((score, i) => ({
        ...canonicalCandidateRow(`Sim ${i}`, `https://www.linkedin.com/in/sim-${i}`),
        rank: { value: "Unknown" },
        match_score: { value: typeof score === "number" ? String(score) : score },
      })) as never,
    );
    const listed = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "score",
    });
    expect(listed.sortAvailability).toEqual({ rank: false, tier: false, score: true });
    expect(listed.items.map((item) => item.candidateKey)).toEqual([
      "linkedin:/in/sim-0",
      "linkedin:/in/sim-1",
      "linkedin:/in/sim-2",
    ]);
  });
  it("lists legacy NULL matchFields rows with provider rank/score sorts on the first read", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const rows = [0, 1, 2].map((i) => ({
      ...canonicalCandidateRow(`Legacy ${i}`, `https://www.linkedin.com/in/legacy-${i}`),
      overall_rank: { value: 3 - i },
      match_score: { value: 10 * (i + 1) },
      notes: { value: "Long provider evidence paragraph. ".repeat(400), source_id: "person" },
    }));
    await recordCandidatePage(f, prepared, "legacy-null-match", rows as never);
    // Rows saved before matchFields existed.
    await prisma.$executeRaw`UPDATE "recruiting_candidate_occurrences" SET "matchFields" = NULL WHERE "roleId" = ${f.role.role.id}`;
    const listed = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "rank",
      limit: 100,
    });
    expect(listed.sortAvailability).toMatchObject({ rank: true, score: true });
    expect(listed.items.map((item) => item.candidateKey)).toEqual([
      "linkedin:/in/legacy-2",
      "linkedin:/in/legacy-1",
      "linkedin:/in/legacy-0",
    ]);
    const missing = await prisma.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM "recruiting_candidate_occurrences" WHERE "roleId" = ${f.role.role.id} AND "matchFields" IS NULL`;
    expect(Number(missing[0]!.n)).toBe(0);
  });
  it("verifies research-action page provenance once per listing, not once per referenced page", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const proofQueries = async (pageCount: number) => {
      for (let page = 0; page < pageCount; page++)
        await recordCandidatePage(
          f,
          prepared,
          `proof-${pageCount}-${page}`,
          [
            canonicalCandidateRow(
              `Proof ${pageCount}-${page}`,
              `https://www.linkedin.com/in/proof-${pageCount}-${page}`,
            ),
          ],
          { observedAt: new Date(Date.UTC(2026, 9, 17, pageCount, page)) },
        );
      sourceQueries = [];
      const listed = await recruiting.listRecruitingCandidates(prisma, actor, {
        roleId: f.role.role.id,
        sort: "name",
        limit: 100,
      });
      const queries = sourceQueries;
      sourceQueries = undefined;
      return { listed, queries };
    };
    const two = await proofQueries(2);
    const eight = await proofQueries(6);
    expect(eight.listed.items).toHaveLength(8);
    expect(eight.listed.items.every((item) => item.latestSource?.effectId)).toBe(true);
    const per = (queries: string[], pattern: RegExp) =>
      queries.filter((q) => pattern.test(q)).length;
    // The same proof lookups for 2 or 8 pages: one batched load, one shared research context.
    for (const pattern of [
      /FROM "public"\."external_effects" WHERE .*"status"/,
      /FROM "public"\."recruiting_research_actions"/,
      /FROM "public"\."recruiting_research_tasks"/,
    ])
      expect(per(eight.queries, pattern)).toBe(per(two.queries, pattern));
    // Unbatched this listing ran ~60 queries per referenced page.
    expect(eight.queries.length).toBeLessThan(150);
  });
  it("lists research-action pages without re-validating the action's own artifacts", async () => {
    const { f, prepared } = await mappedResearchFixture();
    for (let page = 0; page < 2; page++)
      await recordCandidatePage(
        f,
        prepared,
        `light-${page}`,
        [canonicalCandidateRow(`Light ${page}`, `https://www.linkedin.com/in/light-${page}`)],
        { observedAt: new Date(Date.UTC(2026, 9, 18, page)) },
      );
    sourceQueries = [];
    const listed = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      sort: "name",
    });
    const queries = sourceQueries;
    sourceQueries = undefined;
    expect(listed.items.map((item) => item.candidateKey)).toEqual([
      "linkedin:/in/light-0",
      "linkedin:/in/light-1",
    ]);
    expect(listed.items.every((item) => item.latestSource?.effectId)).toBe(true);
    // Page artifacts are still proven (by clientNonce + id/hash); the action's request/context/
    // output artifacts are not fetched one by id per action (7 owner-scoped id lookups before,
    // the 2 left are the recorded page read's own proof).
    expect(queries.some((q) => /FROM "public"\."artifacts" WHERE .*"clientNonce"/.test(q))).toBe(
      true,
    );
    expect(
      queries.filter((q) =>
        /"artifacts"\."id" = \$1 AND "public"\."artifacts"\."spaceId" = \$2/.test(q),
      ).length,
    ).toBeLessThanOrEqual(2);
  });
  it("filters saved native pages with overlapping identities without narrowing role counts", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const pages = [];
    for (const [label, name, hour] of [
      ["native-first", "Alpha", "00"],
      ["native-second", "Beta", "01"],
    ] as const) {
      const page = await recordCandidatePage(
        f,
        prepared,
        label,
        [
          {
            ...canonicalCandidateRow("Shared", "https://www.linkedin.com/in/shared", label),
            resume_url: { value: `https://example.test/${label}.pdf`, source_id: "person" },
            batch_rank: { value: 1 },
            match_tier: { value: "Strong" },
          },
          canonicalCandidateRow(name, `https://www.linkedin.com/in/${name.toLowerCase()}`),
        ],
        { observedAt: new Date(`2026-10-16T${hour}:00:00Z`) },
      );
      pages.push(
        await prisma.recruitingCandidatePage.update({
          where: { effectId: page.input.effectId },
          data: { taskId: null, actionId: null },
        }),
      );
    }
    const latest = await recordCandidatePage(
      f,
      prepared,
      "action-page",
      [canonicalCandidateRow("Shared", "https://www.linkedin.com/in/shared", "Latest company")],
      { observedAt: new Date("2026-10-16T02:00:00Z") },
    );
    const input = {
      roleId: f.role.role.id,
      sourceEffectId: pages[0]!.effectId,
      sort: "name" as const,
      limit: 1,
    };
    const first = await recruiting.listRecruitingCandidates(prisma, actor, input);
    expect(first.total).toBe(2);
    expect(first.items.map((item) => item.candidateKey)).toEqual(["linkedin:/in/alpha"]);
    expect(first.counts).toEqual({
      sourceRows: 5,
      candidates: 3,
      identifiedCandidates: 3,
      unassessed: 3,
      assessed: 0,
      shortlisted: 0,
    });
    expect(first.nextCursor).not.toBeNull();
    const next = await recruiting.listRecruitingCandidates(prisma, actor, {
      ...input,
      cursor: first.nextCursor!,
    });
    expect(next.items[0]).toMatchObject({
      candidateKey: "linkedin:/in/shared",
      discoveryCount: 3,
      company: "native-first",
      resumeUrl: "https://example.test/native-first.pdf",
      latestSource: { effectId: pages[0]!.effectId, rowIndex: 0 },
    });
    expect(next.nextCursor).toBeNull();
    expect(next.total).toBe(first.total);
    expect(next.counts).toEqual(first.counts);
    const second = await recruiting.listRecruitingCandidates(prisma, actor, {
      ...input,
      sourceEffectId: pages[1]!.effectId,
      limit: 100,
    });
    expect(second.items.map((item) => item.candidateKey)).toEqual([
      "linkedin:/in/beta",
      "linkedin:/in/shared",
    ]);
    expect(second.items[1]).toMatchObject({
      company: "native-second",
      resumeUrl: "https://example.test/native-second.pdf",
      latestSource: { effectId: pages[1]!.effectId },
    });
    const ranked = await recruiting.listRecruitingCandidates(prisma, actor, {
      ...input,
      sort: "rank",
      limit: 100,
    });
    expect(ranked.sortAvailability).toEqual({ rank: true, tier: true, score: false });
    expect(ranked.items.map((item) => item.candidateKey)).toEqual([
      "linkedin:/in/shared",
      "linkedin:/in/alpha",
    ]);
    const all = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: input.roleId,
      sort: "name",
    });
    expect(all.items.find((item) => item.candidateKey === "linkedin:/in/shared")).toMatchObject({
      company: "Latest company",
      resumeUrl: null,
      latestSource: { effectId: latest.input.effectId },
    });
    for (const sourceEffectId of [pages[1]!.effectId, undefined])
      await expect(
        recruiting.listRecruitingCandidates(prisma, actor, {
          ...input,
          sourceEffectId,
          cursor: first.nextCursor!,
        }),
      ).rejects.toThrow(recruiting.RecruitingConflictError);
    const action = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: input.roleId,
      actionId: prepared.action.id,
    });
    const intersection = await recruiting.listRecruitingCandidates(prisma, actor, {
      ...input,
      actionId: prepared.action.id,
    });
    expect(action.total).toBe(1);
    expect(action.items[0]).toMatchObject({
      company: "Latest company",
      latestSource: { effectId: latest.input.effectId },
    });
    expect(intersection.items).toEqual([]);
    expect(intersection.total).toBe(0);
    expect(intersection.counts).toEqual(first.counts);
    const other = await mappedResearchFixture();
    await recordCandidatePage(other.f, other.prepared, "other-role-page", [
      canonicalCandidateRow("Shared", "https://www.linkedin.com/in/shared"),
    ]);
    const foreign = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: other.f.role.role.id,
      sourceEffectId: input.sourceEffectId,
    });
    expect(foreign.total).toBe(0);
    expect(foreign.items).toEqual([]);
    expect(foreign.counts).toMatchObject({ sourceRows: 1, candidates: 1 });
  });

  it("keeps cross-action occurrences for one profile while role identities stay isolated", async () => {
    const { f, prepared } = await mappedResearchFixture();
    await recordCandidatePage(f, prepared, "cross-action-first", [
      canonicalCandidateRow("First round", "https://www.linkedin.com/in/example"),
    ]);
    const human = await recruiting.createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Continue the supplied search" }],
    });
    await prisma.steeringMessage.create({
      data: { messageId: human.id, userId, botId, runId: f.run.id, claimedAt: new Date() },
    });
    const continued = await recruiting.prepareRecruitingResearchAction(prisma, actor, {
      ...f.input,
      sourceMessageId: human.id,
      intent: { basis: "direct", quote: "Continue the supplied search" },
      kind: "continue",
      taskId: prepared.task.id,
      clientNonce: `${f.input.clientNonce}-candidate-next`,
      requestArtifact: f.metadata("candidate-next-request"),
    });
    const admitted = await recruiting.admitRecruitingResearchAction(
      prisma,
      actor,
      researchAdmission(f, continued),
    );
    const rawResult = { task_id: "provider-task", status: "accepted" };
    await prisma.externalEffect.update({
      where: { id: admitted.effect!.id },
      data: { status: "completed", result: rawResult },
    });
    await recruiting.reconcileRecruitingResearchAction(prisma, actor, {
      runId: f.run.id,
      actionId: continued.action.id,
      effectId: admitted.effect!.id,
      rawResult,
      deliveryState: "accepted",
      providerTaskId: "provider-task",
      receiptArtifact: f.metadata("candidate-next-receipt"),
    });
    await recordCandidatePage(f, continued, "cross-action-second", [
      canonicalCandidateRow("Second round", "https://linkedin.com/in/EXAMPLE/?trk=other"),
    ]);
    const all = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    expect(all.counts).toMatchObject({ sourceRows: 2, candidates: 1 });
    const round = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
      actionId: continued.action.id,
    });
    expect(round.total).toBe(1);
    expect(round.items[0]?.discoveryCount).toBe(2);
    const occurrences = await recruiting.listRecruitingCandidateSources(prisma, actor, {
      roleId: f.role.role.id,
      candidateKey: "linkedin:/in/example",
    });
    expect(new Set(occurrences.items.map((item) => item.actionId))).toEqual(
      new Set([prepared.action.id, continued.action.id]),
    );
    const other = await mappedResearchFixture();
    await recordCandidatePage(other.f, other.prepared, "cross-role", [
      canonicalCandidateRow("Separate role", "https://www.linkedin.com/in/example"),
    ]);
    expect(
      (await recruiting.listRecruitingCandidates(prisma, actor, { roleId: f.role.role.id }))
        .items[0]?.discoveryCount,
    ).toBe(2);
    expect(
      (await recruiting.listRecruitingCandidates(prisma, actor, { roleId: other.f.role.role.id }))
        .items[0]?.discoveryCount,
    ).toBe(1);
  });

  it("preserves raw-only native reads without reporting a genuine empty candidate page or retrying recovery", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const rawResult = {
      content: [{ type: "text", text: "No structured candidate rows supplied" }],
    };
    const identity = await completedResearchRead(
      f,
      prepared.action.id,
      "raw-only-page",
      "get_rows",
      rawResult,
    );
    await recordResearchRead({
      ...identity,
      runId: f.run.id,
      actionId: prepared.action.id,
      toolName: "get_rows",
      outputArtifact: f.metadata("raw-only-page"),
    });
    expect(
      await prisma.recruitingCandidatePage.findUniqueOrThrow({
        where: { effectId: identity.effectId },
      }),
    ).toMatchObject({ rowCount: null });
    expect(await prisma.recruitingCandidate.count({ where: { roleId: f.role.role.id } })).toBe(0);
    expect(
      await recruiting.listUnmappedRecruitingResearchReads(prisma, actor, {
        runId: f.run.id,
        taskId: prepared.task.id,
      }),
    ).toEqual([]);
    const empty = await recordCandidatePage(f, prepared, "accepted-empty-page", []);
    expect(
      await prisma.recruitingCandidatePage.findUniqueOrThrow({
        where: { effectId: empty.input.effectId },
      }),
    ).toMatchObject({ rowCount: 0 });
  });

  it("joins an assessment saved with the native research row reference to the same discovered candidate", async () => {
    const { f, prepared } = await mappedResearchFixture();
    const page = await recordCandidatePage(f, prepared, "assessment-join", [
      canonicalCandidateRow("Unresolved person", null),
    ]);
    const reference = page.saved.candidateRows[0]!;
    expect(reference).toMatchObject({
      rowIndex: 0,
      candidateKey: `source-row:${page.input.effectId}:0`,
    });
    const input = {
      ...assessmentInput(f.role.role.id, f.role.revision.id, reference.candidateKey),
      sourceRefs: [],
      questions: [],
      atomJudgments: [],
    };
    const admission = await assessmentAdmission(input, { runId: f.run.id, threadId: f.thread.id });
    await recruiting.saveRecruitingAssessment(
      prisma,
      actor,
      admission.context,
      input,
      admission.artifacts,
    );
    const listed = await recruiting.listRecruitingCandidates(prisma, actor, {
      roleId: f.role.role.id,
    });
    expect(listed.counts).toMatchObject({
      candidates: 1,
      sourceRows: 1,
      assessed: 1,
      unassessed: 0,
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      candidateKey: reference.candidateKey,
      discoveryCount: 1,
      latestAssessment: { version: 1, isCurrent: true },
    });
  });
});

describe("research uncertainty settlement (offline)", () => {
  function fixture() {
    const actor: Actor = {
      spaceId: "space",
      userId: "owner",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const run = {
      ...actor,
      id: "run",
      threadId: "thread",
      botId: "bot",
      bot: actor,
      taskId: "runtime-task",
      status: "running",
      leaseOwner: "worker" as string | null,
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000) as Date | null,
    };
    const thread = {
      ...actor,
      id: "thread",
      botId: "bot",
      groupId: null,
      externalConversationId: null,
      activeRecruitingRoleId: "role",
      nextEventSeq: 1,
    };
    const role = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      id: "role",
      sourceThreadId: "thread",
      title: "Engineer",
      revision: 1,
      currentRevisionId: "revision",
    };
    const revision = {
      id: "revision",
      roleId: "role",
      revision: 1,
      createdAt: new Date(),
      brief: null,
      sourceRefs: [
        {
          id: "source",
          kind: "original_material",
          anchor: { kind: "message", messageId: "message", locator: "text" },
          readState: "read",
          readAt: new Date().toISOString(),
        },
      ],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    };
    const task = {
      id: "task",
      roleId: "role",
      mcpServerId: "server",
      serverRevision: 1,
      providerTaskId: null,
      pendingActionId: "action",
      state: "active",
      createdByRunId: "run",
    };
    const hash = "a".repeat(64);
    const action = {
      id: "action",
      taskId: "task",
      roleRevisionId: "revision",
      runId: "run",
      sourceMessageId: "message",
      clientNonce: "round",
      kind: "create",
      purpose: "calibration",
      candidateOutputSchema: "candidate_output_v1",
      approvalEffectId: "approval",
      deliveryState: "sending",
      observedProviderState: null,
      requestArtifactId: "request",
      requestArtifactHash: hash,
      contextArtifactId: "context",
      contextArtifactHash: hash,
      recallScope: null,
      receiptArtifactId: null,
      receiptArtifactHash: null,
      outputArtifacts: [],
      cursor: "previous-cursor",
      effectId: "effect",
      usage: null,
    };
    const effect = {
      id: "effect",
      spaceId: actor.spaceId,
      runId: run.id,
      kind: "mcp_research",
      idempotencyKey: "recruiting-research:action",
      request: { prompt: "Frozen request" },
      status: "executing",
      result: null as unknown,
    };
    const runtimeTask = { id: run.taskId, status: "running" };
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "thread" }]),
      run: {
        findFirst: vi.fn(async () => run),
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async (_input: { where: { id: string } }) => run),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: {
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(runtimeTask, data);
          return { count: 1 };
        }),
      },
      thread: {
        findFirst: vi.fn(async () => thread),
        update: vi.fn(async () => ({ nextEventSeq: ++thread.nextEventSeq })),
      },
      bot: { findFirst: vi.fn(async () => actor) },
      recruitingRole: { findFirst: vi.fn(async () => role) },
      recruitingRoleRevision: { findFirst: vi.fn(async () => revision) },
      recruitingResearchTask: {
        findUnique: vi.fn(async () => ({ ...task })),
        findUniqueOrThrow: vi.fn(async () => ({ ...task })),
        update: vi.fn(async ({ data }) => Object.assign(task, data)),
      },
      recruitingResearchAction: {
        findFirst: vi.fn(async ({ where }) =>
          where.effectId
            ? null
            : { ...action, run: { threadId: "thread" }, effect: { status: effect.status } },
        ),
        findUniqueOrThrow: vi.fn(async () => ({ ...action })),
        update: vi.fn(async ({ data }) => Object.assign(action, data)),
      },
      mcpServer: {
        findFirst: vi.fn(async () => ({
          ...actor,
          id: "server",
          enabled: true,
          revision: 1,
          slug: "demo",
        })),
      },
      message: {
        findMany: vi.fn(async () => [{ id: "message", threadId: "thread" }]),
        findUnique: vi.fn(async () => ({
          id: "message",
          threadId: "thread",
          role: "user",
          botId: null,
          externalTranscriptFor: null,
          blocks: [{ kind: "text", text: "Search this round" }],
        })),
      },
      artifact: {
        findFirst: vi.fn(async ({ where }) => ({
          ...actor,
          id: where.id,
          hash,
          botId: "bot",
          groupId: null,
          runId: "run",
        })),
        findUniqueOrThrow: vi.fn(async ({ where }) => ({ id: where.id, hash })),
      },
      externalEffect: {
        findFirst: vi.fn(async () => ({ ...effect })),
        findUniqueOrThrow: vi.fn(async () => ({ ...effect })),
        updateMany: vi.fn(async ({ where, data }) => {
          if (effect.status !== where.status) return { count: 0 };
          Object.assign(effect, data);
          return { count: 1 };
        }),
      },
      event: {
        create: vi.fn(async ({ data }) => ({ id: "event", ...data, createdAt: new Date() })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as unknown as PrismaClient;
    const input = {
      runId: run.id,
      leaseOwner: run.leaseOwner!,
      leaseFence: run.leaseFence,
      taskId: task.id,
      actionId: action.id,
      effectId: effect.id,
      effectKind: effect.kind,
      effectRequest: effect.request,
      result: { error: "Outcome unknown", uncertain: true as const },
    };
    return { prisma, tx, actor, run, runtimeTask, thread, role, task, action, effect, input };
  }

  it.each(["executing", "uncertain"])(
    "settles %s native state and only current sending domain state",
    async (status) => {
      expect(recruiting.settleUncertainRecruitingResearchAction).toBeTypeOf("function");
      const f = fixture();
      f.effect.status = status;
      f.effect.result = status === "uncertain" ? f.input.result : null;
      const before = structuredClone({ action: f.action, task: f.task });
      const result = await recruiting.settleUncertainRecruitingResearchAction(
        f.prisma,
        f.actor,
        f.input,
      );
      expect(result.effect).toMatchObject({
        status: "uncertain",
        result: f.input.result,
        request: f.input.effectRequest,
      });
      expect(f.action).toEqual({ ...before.action, deliveryState: "unknown" });
      expect(f.task).toEqual({ ...before.task, state: "unknown" });
      await recruiting.settleUncertainRecruitingResearchAction(f.prisma, f.actor, f.input);
      expect(f.tx.event.create).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "selected-role",
    "revision",
    "pending-action",
    "completed",
    "closed",
    "accepted-action",
  ])("settles native uncertainty while preserving obsolete %s domain state", async (boundary) => {
    const f = fixture();
    if (boundary === "selected-role") f.thread.activeRecruitingRoleId = "new-role";
    if (boundary === "revision") f.action.roleRevisionId = "previous-revision";
    if (boundary === "pending-action") f.task.pendingActionId = "new-action";
    if (boundary === "completed" || boundary === "closed") f.task.state = boundary;
    if (boundary === "accepted-action") f.action.deliveryState = "accepted";
    const before = structuredClone({ action: f.action, task: f.task });
    await recruiting.settleUncertainRecruitingResearchAction(f.prisma, f.actor, f.input);
    expect(f.effect.status).toBe("uncertain");
    expect({ action: f.action, task: f.task }).toEqual(before);
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });

  it.each(["actor", "lease-owner", "lease-fence", "expired", "effect", "request", "kind", "task"])(
    "rejects an invalid %s boundary before changing native or domain state",
    async (boundary) => {
      const f = fixture();
      if (boundary === "actor") f.actor.userId = "foreign";
      if (boundary === "lease-owner") f.input.leaseOwner = "stale";
      if (boundary === "lease-fence") f.input.leaseFence += 1;
      if (boundary === "expired") f.run.leaseExpiresAt = new Date(0);
      if (boundary === "effect") f.input.effectId = "other-effect";
      if (boundary === "request") f.input.effectRequest = { prompt: "Changed request" };
      if (boundary === "kind") f.input.effectKind = "get_rows";
      if (boundary === "task") f.input.taskId = "other-task";
      await expect(
        recruiting.settleUncertainRecruitingResearchAction(f.prisma, f.actor, f.input),
      ).rejects.toThrow(IsolationError);
      expect(f.effect.status).toBe("executing");
      expect(f.action.deliveryState).toBe("sending");
      expect(f.task.state).toBe("active");
    },
  );

  it("settles the same-fence cancelled effect owner after actual Stop without reopening it", async () => {
    const f = fixture();
    await recruiting.cancelRunsInTransaction(
      f.tx as never,
      [{ id: f.run.id, taskId: f.run.taskId }],
      new Date(),
    );
    const stoppedRun = structuredClone(f.run);
    expect(stoppedRun).toMatchObject({
      status: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseFence: f.input.leaseFence,
    });
    await recruiting.settleUncertainRecruitingResearchAction(f.prisma, f.actor, f.input);
    expect(f.effect.status).toBe("uncertain");
    expect(f.action.deliveryState).toBe("unknown");
    expect(f.task.state).toBe("unknown");
    expect(f.run).toEqual(stoppedRun);
    expect(f.runtimeTask.status).toBe("cancelled");
    expect(f.tx.event.create).toHaveBeenCalledOnce();
  });

  it.each(["older-fence", "newer-fence", "foreign-owner"])(
    "rejects cancelled %s settlement without changing outcome state",
    async (boundary) => {
      const f = fixture();
      await recruiting.cancelRunsInTransaction(
        f.tx as never,
        [{ id: f.run.id, taskId: f.run.taskId }],
        new Date(),
      );
      if (boundary === "older-fence") f.input.leaseFence -= 1;
      if (boundary === "newer-fence") f.input.leaseFence += 1;
      if (boundary === "foreign-owner") f.effect.runId = "other-run";
      await expect(
        recruiting.settleUncertainRecruitingResearchAction(f.prisma, f.actor, f.input),
      ).rejects.toThrow(IsolationError);
      expect(f.effect.status).toBe("executing");
      expect(f.action.deliveryState).toBe("sending");
      expect(f.task.state).toBe("active");
      expect(f.tx.event.create).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "closed", "newer-action"])(
    "keeps %s research state intact when settling a cancelled owner",
    async (boundary) => {
      const f = fixture();
      await recruiting.cancelRunsInTransaction(
        f.tx as never,
        [{ id: f.run.id, taskId: f.run.taskId }],
        new Date(),
      );
      if (boundary === "newer-action") f.task.pendingActionId = "newer-action";
      else f.task.state = boundary;
      const before = structuredClone({ action: f.action, task: f.task });
      await recruiting.settleUncertainRecruitingResearchAction(f.prisma, f.actor, f.input);
      expect(f.effect.status).toBe("uncertain");
      expect({ action: f.action, task: f.task }).toEqual(before);
      expect(f.run.status).toBe("cancelled");
      expect(f.tx.event.create).not.toHaveBeenCalled();
    },
  );

  it("preserves the original uncertain result while repairing sending domain state", async () => {
    const f = fixture();
    f.effect.status = "uncertain";
    const original = { error: "Original interruption", uncertain: true };
    f.effect.result = original;
    const result = await recruiting.settleUncertainRecruitingResearchAction(
      f.prisma,
      f.actor,
      f.input,
    );
    expect(result.effect.result).toEqual(original);
    expect(f.effect.result).toEqual(original);
    expect(f.action.deliveryState).toBe("unknown");
  });

  it.each(["running", "failed"])(
    "checks a different %s effect owner's lease before recovery settlement",
    async (status) => {
      const f = fixture();
      f.effect.runId = "dispatch-owner";
      f.tx.run.findUniqueOrThrow.mockImplementation(async ({ where }) =>
        where.id === "dispatch-owner" ? { ...f.run, id: "dispatch-owner", status } : f.run,
      );
      const pending = recruiting.settleUncertainRecruitingResearchAction(
        f.prisma,
        f.actor,
        f.input,
      );
      if (status === "running") {
        await expect(pending).rejects.toThrow(IsolationError);
        expect(f.effect.status).toBe("executing");
      } else {
        await pending;
        expect(f.effect.status).toBe("uncertain");
        expect(f.action.deliveryState).toBe("unknown");
      }
    },
  );

  it.each(["completed", "denied"])(
    "returns authoritative %s native state without downgrading domain state",
    async (status) => {
      const f = fixture();
      f.effect.status = status;
      f.effect.result = { provider: "authoritative" };
      const before = structuredClone({ action: f.action, task: f.task, effect: f.effect });
      const result = await recruiting.settleUncertainRecruitingResearchAction(
        f.prisma,
        f.actor,
        f.input,
      );
      expect(result.effect).toEqual(before.effect);
      expect({ action: f.action, task: f.task }).toEqual({
        action: before.action,
        task: before.task,
      });
    },
  );
});
