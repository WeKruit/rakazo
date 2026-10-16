import { randomUUID } from "node:crypto";
import type {
  Actor,
  CreateRecruitingRoleInput as CreateRoleInput,
  RecruitingArtifactRef,
  RecruitingAssessment,
  RecruitingRole,
  RecruitingRoleRevision,
  RecruitingSourceRef,
  ReviseRecruitingRoleInput as ReviseRoleInput,
  SaveRecruitingAssessmentInput as SaveAssessmentInput,
} from "@rakazo/contracts";
import {
  CreateRecruitingRoleInput,
  RecruitingAssessmentSchema,
  RecruitingResearchActionSchema,
  RecruitingResearchTaskSchema,
  RecruitingRoleRevisionSchema,
  RecruitingRoleSchema,
  ReviseRecruitingRoleInput,
  SaveRecruitingAssessmentInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError, scoped } from "./scope.js";

type Tx = Prisma.TransactionClient;
type RoleSnapshot = { role: RecruitingRole; revision: RecruitingRoleRevision };
export type RecruitingAssessmentSnapshot = { assessment: RecruitingAssessment; isCurrent: boolean };

export class RecruitingConflictError extends Error {
  constructor() {
    super("Recruiting revision changed");
    this.name = "RecruitingConflictError";
  }
}

async function requireThread(tx: Tx, actor: Actor, threadId: string) {
  const thread = scoped(
    actor,
    await tx.thread.findFirst({
      where: { id: threadId, spaceId: actor.spaceId, userId: actor.userId },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        botId: true,
        groupId: true,
        externalConversationId: true,
        activeRecruitingRoleId: true,
      },
    }),
  );
  if (thread.botId)
    scoped(
      actor,
      await tx.bot.findFirst({
        where: { id: thread.botId, spaceId: actor.spaceId, userId: actor.userId },
        select: { spaceId: true, userId: true },
      }),
    );
  else if (thread.groupId)
    scoped(
      actor,
      await tx.chatGroup.findFirst({
        where: { id: thread.groupId, spaceId: actor.spaceId, userId: actor.userId },
        select: { spaceId: true, userId: true },
      }),
    );
  else if (thread.externalConversationId) {
    const conversation = scoped(
      actor,
      await tx.externalConversation.findFirst({
        where: { id: thread.externalConversationId, spaceId: actor.spaceId, userId: actor.userId },
        select: { spaceId: true, userId: true, bot: { select: { spaceId: true, userId: true } } },
      }),
    );
    scoped(actor, conversation.bot);
  } else throw new IsolationError();
  return thread;
}

async function requireRole(tx: Tx, actor: Actor, roleId: string, lock = false) {
  if (lock) {
    // One existing row lock orders role revisions and candidate assessment CAS writes.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "recruiting_roles" WHERE "id" = ${roleId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
    );
  }
  const role = scoped(
    actor,
    await tx.recruitingRole.findFirst({
      where: { id: roleId, spaceId: actor.spaceId, userId: actor.userId },
    }),
  );
  await requireThread(tx, actor, role.sourceThreadId);
  return role;
}

async function requireRun(tx: Tx, actor: Actor, runId: string) {
  const run = scoped(
    actor,
    await tx.run.findFirst({
      where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        threadId: true,
        bot: { select: { spaceId: true, userId: true } },
      },
    }),
  );
  scoped(actor, run.bot);
  await requireThread(tx, actor, run.threadId);
  return run;
}

async function validateArtifact(tx: Tx, actor: Actor, ref: RecruitingArtifactRef) {
  const artifact = scoped(
    actor,
    await tx.artifact.findFirst({
      where: { id: ref.artifactId, spaceId: actor.spaceId, userId: actor.userId },
    }),
  );
  if (artifact.hash !== ref.sha256 || (!artifact.groupId && !artifact.botId))
    throw new IsolationError();
  const run = artifact.runId ? await requireRun(tx, actor, artifact.runId) : null;
  const thread = await tx.thread.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(run ? { id: run.threadId } : {}),
      ...(artifact.groupId
        ? { groupId: artifact.groupId }
        : {
            groupId: null,
            OR: [{ botId: artifact.botId }, { externalConversation: { botId: artifact.botId! } }],
          }),
    },
  });
  if (!thread) throw new IsolationError();
  await requireThread(tx, actor, thread.id);
}

async function validateSources(tx: Tx, actor: Actor, sources: readonly RecruitingSourceRef[]) {
  for (const source of sources) {
    if (source.anchor.kind === "artifact") {
      await validateArtifact(tx, actor, source.anchor.artifact);
    } else {
      const message = await tx.message.findUnique({
        where: { id: source.anchor.messageId },
        select: { threadId: true },
      });
      if (!message) throw new IsolationError();
      await requireThread(tx, actor, message.threadId);
    }
  }
}

async function validateDefinition(
  tx: Tx,
  actor: Actor,
  definition: Pick<RecruitingRoleRevision, "sourceRefs" | "criteria">,
) {
  await validateSources(tx, actor, [
    ...definition.sourceRefs,
    ...definition.criteria.flatMap((criterion) => criterion.sourceRefs),
  ]);
}

function definitionData(input: CreateRoleInput | ReviseRoleInput) {
  return {
    sourceRefs: input.sourceRefs as Prisma.InputJsonValue,
    criteria: input.criteria as Prisma.InputJsonValue,
    preferences: input.preferences as Prisma.InputJsonValue,
    definitionQuestions: input.definitionQuestions as Prisma.InputJsonValue,
  };
}

async function roleSnapshot(tx: Tx, actor: Actor, role: RecruitingRole): Promise<RoleSnapshot> {
  const row = await tx.recruitingRoleRevision.findFirst({
    where: { id: role.currentRevisionId, roleId: role.id, revision: role.revision },
  });
  if (!row) throw new IsolationError();
  const revision = RecruitingRoleRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  await validateDefinition(tx, actor, revision);
  return { role: RecruitingRoleSchema.parse(role), revision };
}

export async function createRecruitingRole(
  prisma: PrismaClient,
  actor: Actor,
  untrusted: CreateRoleInput,
): Promise<RoleSnapshot> {
  const input = CreateRecruitingRoleInput.parse(untrusted);
  return prisma.$transaction(async (tx) => {
    await requireThread(tx, actor, input.sourceThreadId);
    await validateDefinition(tx, actor, input);
    const role = await tx.recruitingRole.create({
      data: {
        id: randomUUID(),
        spaceId: actor.spaceId,
        userId: actor.userId,
        sourceThreadId: input.sourceThreadId,
        title: input.title,
        revision: 1,
        currentRevisionId: randomUUID(),
      },
    });
    await tx.recruitingRoleRevision.create({
      data: { id: role.currentRevisionId, roleId: role.id, revision: 1, ...definitionData(input) },
    });
    await tx.thread.update({
      where: { id: input.sourceThreadId },
      data: { activeRecruitingRoleId: role.id },
    });
    return roleSnapshot(tx, actor, role);
  });
}

export async function bindRecruitingRole(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; roleId: string | null },
): Promise<RoleSnapshot | null> {
  return prisma.$transaction(async (tx) => {
    await requireThread(tx, actor, input.threadId);
    const role = input.roleId ? await requireRole(tx, actor, input.roleId) : null;
    await tx.thread.update({
      where: { id: input.threadId },
      data: { activeRecruitingRoleId: role?.id ?? null },
    });
    return role ? roleSnapshot(tx, actor, role) : null;
  });
}

export async function getRecruitingWorkspace(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
): Promise<RoleSnapshot | null> {
  return prisma.$transaction(
    async (tx) => {
      const thread = await requireThread(tx, actor, input.threadId);
      return thread.activeRecruitingRoleId
        ? roleSnapshot(tx, actor, await requireRole(tx, actor, thread.activeRecruitingRoleId))
        : null;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function reviseRecruitingRole(
  prisma: PrismaClient,
  actor: Actor,
  untrusted: ReviseRoleInput,
): Promise<RoleSnapshot> {
  const input = ReviseRecruitingRoleInput.parse(untrusted);
  return prisma.$transaction(async (tx) => {
    const role = await requireRole(tx, actor, input.roleId, true);
    if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
    await validateDefinition(tx, actor, input);
    const revision = await tx.recruitingRoleRevision.create({
      data: { roleId: role.id, revision: role.revision + 1, ...definitionData(input) },
    });
    const changed = await tx.recruitingRole.updateMany({
      where: {
        id: role.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        revision: input.expectedRevision,
        currentRevisionId: role.currentRevisionId,
      },
      data: { title: input.title, revision: revision.revision, currentRevisionId: revision.id },
    });
    if (changed.count !== 1) throw new RecruitingConflictError();
    return roleSnapshot(tx, actor, {
      ...role,
      title: input.title,
      revision: revision.revision,
      currentRevisionId: revision.id,
    });
  });
}

async function assessmentSnapshot(
  tx: Tx,
  actor: Actor,
  role: RecruitingRole,
  row: Prisma.RecruitingAssessmentGetPayload<Record<string, never>>,
): Promise<RecruitingAssessmentSnapshot> {
  const assessment = RecruitingAssessmentSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  if (
    !(await tx.recruitingRoleRevision.findFirst({
      where: { id: row.roleRevisionId, roleId: role.id },
    }))
  )
    throw new IsolationError();
  await requireRun(tx, actor, row.createdByRunId);
  await validateSources(tx, actor, assessment.sourceRefs);
  return { assessment, isCurrent: role.currentRevisionId === assessment.roleRevisionId };
}

export async function listRecruitingAssessments(
  prisma: PrismaClient,
  actor: Actor,
  input: { roleId: string },
): Promise<RecruitingAssessmentSnapshot[]> {
  return prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const rows = await tx.recruitingAssessment.findMany({
        where: { roleId: role.id },
        distinct: ["candidateKey"],
        orderBy: [{ candidateKey: "asc" }, { version: "desc" }],
      });
      const snapshots = [];
      for (const row of rows) snapshots.push(await assessmentSnapshot(tx, actor, role, row));
      return snapshots;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function getRecruitingAssessment(
  prisma: PrismaClient,
  actor: Actor,
  input: { roleId: string; candidateKey: string; version?: number },
): Promise<RecruitingAssessmentSnapshot | null> {
  return prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const row = await tx.recruitingAssessment.findFirst({
        where: { roleId: role.id, candidateKey: input.candidateKey, version: input.version },
        orderBy: { version: "desc" },
      });
      return row ? assessmentSnapshot(tx, actor, role, row) : null;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Only the authenticated runtime supplies this context; no model input can set the creator. */
export async function saveRecruitingAssessment(
  prisma: PrismaClient,
  actor: Actor,
  context: { runId: string; threadId: string },
  untrusted: SaveAssessmentInput,
): Promise<RecruitingAssessmentSnapshot> {
  const input = SaveRecruitingAssessmentInput.parse(untrusted);
  return prisma.$transaction(async (tx) => {
    // ponytail: one role row lock serializes candidate writes; split by candidate only if contention appears.
    const role = await requireRole(tx, actor, input.roleId, true);
    const run = await requireRun(tx, actor, context.runId);
    if (run.threadId !== context.threadId) throw new IsolationError();
    const thread = await requireThread(tx, actor, context.threadId);
    if (thread.activeRecruitingRoleId !== role.id) throw new IsolationError();
    const revision = await tx.recruitingRoleRevision.findFirst({
      where: { id: input.roleRevisionId, roleId: role.id },
    });
    if (!revision) throw new IsolationError();
    if (role.currentRevisionId !== input.roleRevisionId) throw new RecruitingConflictError();
    const definition = RecruitingRoleRevisionSchema.parse({
      ...revision,
      createdAt: revision.createdAt.toISOString(),
    });
    const criteria = new Set(definition.criteria.map((criterion) => criterion.id));
    if (
      input.judgments.length !== criteria.size ||
      input.judgments.some((judgment) => !criteria.has(judgment.criterionId))
    )
      throw new IsolationError();
    const last = await tx.recruitingAssessment.findFirst({
      where: { roleId: role.id, candidateKey: input.candidateKey },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    if ((last?.version ?? 0) !== input.expectedRevision) throw new RecruitingConflictError();
    await validateSources(tx, actor, input.sourceRefs);
    const row = await tx.recruitingAssessment.create({
      data: {
        roleId: role.id,
        candidateKey: input.candidateKey,
        roleRevisionId: input.roleRevisionId,
        version: input.expectedRevision + 1,
        basedOnVersion: input.expectedRevision || null,
        facts: input.facts as Prisma.InputJsonValue,
        judgments: input.judgments as Prisma.InputJsonValue,
        questions: input.questions as Prisma.InputJsonValue,
        sourceRefs: input.sourceRefs as Prisma.InputJsonValue,
        createdByRunId: run.id,
      },
    });
    return assessmentSnapshot(tx, actor, role, row);
  });
}

export async function listRecruitingResearch(
  prisma: PrismaClient,
  actor: Actor,
  input: { roleId: string },
) {
  return prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const rows = await tx.recruitingResearchTask.findMany({
        where: { roleId: role.id },
        orderBy: { id: "asc" },
        include: { actions: { orderBy: { id: "asc" } } },
      });
      const tasks = [];
      const actions = [];
      for (const row of rows) {
        await requireRun(tx, actor, row.createdByRunId);
        const server = await tx.mcpServer.findUnique({
          where: { id: row.mcpServerId },
          select: { id: true, spaceId: true, userId: true },
        });
        scoped(actor, server);
        if (row.pendingActionId && !row.actions.some((action) => action.id === row.pendingActionId))
          throw new IsolationError();
        const { actions: taskActions, ...task } = row;
        tasks.push(RecruitingResearchTaskSchema.parse(task));
        for (const action of taskActions) {
          if (
            !(await tx.recruitingRoleRevision.findFirst({
              where: { id: action.roleRevisionId, roleId: role.id },
            }))
          )
            throw new IsolationError();
          const actionRun = await requireRun(tx, actor, action.runId);
          const message = await tx.message.findUnique({ where: { id: action.sourceMessageId } });
          if (!message || message.threadId !== actionRun.threadId) throw new IsolationError();
          if (
            action.effectId &&
            !(await tx.externalEffect.findFirst({
              where: { id: action.effectId, runId: action.runId, spaceId: actor.spaceId },
              select: { id: true },
            }))
          )
            throw new IsolationError();
          const dto = RecruitingResearchActionSchema.parse({
            id: action.id,
            taskId: action.taskId,
            roleRevisionId: action.roleRevisionId,
            clientNonce: action.clientNonce,
            kind: action.kind,
            runId: action.runId,
            sourceMessageId: action.sourceMessageId,
            deliveryState: action.deliveryState,
            observedProviderState: action.observedProviderState,
            requestArtifact: {
              artifactId: action.requestArtifactId,
              sha256: action.requestArtifactHash,
            },
            contextArtifact: {
              artifactId: action.contextArtifactId,
              sha256: action.contextArtifactHash,
            },
            recallScope: action.recallScope,
            receiptArtifact: action.receiptArtifactId
              ? { artifactId: action.receiptArtifactId, sha256: action.receiptArtifactHash }
              : null,
            outputArtifacts: action.outputArtifacts,
            cursor: action.cursor,
            effectId: action.effectId,
            usage: action.usage,
          });
          for (const ref of [
            dto.requestArtifact,
            dto.contextArtifact,
            ...(dto.receiptArtifact ? [dto.receiptArtifact] : []),
            ...dto.outputArtifacts,
          ])
            await validateArtifact(tx, actor, ref);
          actions.push(dto);
        }
      }
      return { tasks, actions };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
