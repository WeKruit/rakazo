import { randomUUID } from "node:crypto";
import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import type {
  Actor,
  CreateRecruitingRoleInput as CreateRoleInput,
  RecruitingArtifactRef,
  RecruitingAssessment,
  RecruitingHumanIntent,
  RecruitingPreferenceFeedbackInput,
  RecruitingRole,
  RecruitingRoleRevision,
  RecruitingRoleToolInput,
  RecruitingSourceRef,
  ReviseRecruitingRoleInput as ReviseRoleInput,
  SaveRecruitingAssessmentInput as SaveAssessmentInput,
} from "@rakazo/contracts";
import {
  CreateRecruitingRoleInput,
  ProductEventSchema,
  RecruitingAssessmentSchema,
  RecruitingHumanIntentSchema,
  RecruitingPreferenceFeedbackSchema,
  RecruitingResearchActionSchema,
  RecruitingResearchTaskSchema,
  RecruitingRoleRevisionSchema,
  RecruitingRoleSchema,
  RecruitingRoleToolInputSchema,
  RecruitingSourceRefSchema,
  ReviseRecruitingRoleInput,
  SaveRecruitingAssessmentInput,
} from "@rakazo/contracts";
import { applyRecruitingPreferenceEdit } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
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
  return prisma.$transaction((tx) => createRoleInTransaction(tx, actor, input));
}

async function createRoleInTransaction(tx: Tx, actor: Actor, input: CreateRoleInput) {
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
}

export async function bindRecruitingRole(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; roleId: string | null },
): Promise<RoleSnapshot | null> {
  return prisma.$transaction((tx) => bindRoleInTransaction(tx, actor, input));
}

async function bindRoleInTransaction(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; roleId: string | null },
) {
  await requireThread(tx, actor, input.threadId);
  const role = input.roleId ? await requireRole(tx, actor, input.roleId) : null;
  await tx.thread.update({
    where: { id: input.threadId },
    data: { activeRecruitingRoleId: role?.id ?? null },
  });
  return role ? roleSnapshot(tx, actor, role) : null;
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
  return prisma.$transaction((tx) => reviseRoleInTransaction(tx, actor, input));
}

async function reviseRoleInTransaction(tx: Tx, actor: Actor, input: ReviseRoleInput) {
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
}

export type RecruitingRoleMutationInput = Exclude<RecruitingRoleToolInput, { operation: "read" }>;
export type RecruitingRoleToolResult = {
  status: "current" | "saved" | "needs_clarification";
  workspace: RoleSnapshot | null;
  source: RecruitingSourceRef | null;
  changed: boolean;
};

async function lockLiveRecruitingRun(tx: Tx, actor: Actor, runId: string) {
  // Match native send/steering/stop: lock the thread before its run.
  const lockedThreads = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = (SELECT "threadId" FROM "runs" WHERE "id" = ${runId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}) AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
  );
  if (lockedThreads.length !== 1) throw new IsolationError();
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "runs" WHERE "id" = ${runId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
  );
  const run = scoped(
    actor,
    await tx.run.findFirst({
      where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
      include: { bot: { select: { spaceId: true, userId: true } } },
    }),
  );
  scoped(actor, run.bot);
  if (run.status !== "running" || run.threadId !== lockedThreads[0]!.id) throw new IsolationError();
  const thread = await requireThread(tx, actor, run.threadId);
  if (thread.botId && thread.botId !== run.botId) throw new IsolationError();
  if (
    thread.groupId &&
    !(await tx.chatGroupMember.findFirst({ where: { groupId: thread.groupId, botId: run.botId } }))
  )
    throw new IsolationError();
  if (
    thread.externalConversationId &&
    !(await tx.externalConversation.findFirst({
      where: {
        id: thread.externalConversationId,
        botId: run.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    }))
  )
    throw new IsolationError();
  return { run, thread };
}

const humanMessageInclude = { externalTranscriptFor: { select: { id: true } } } as const;
type SourceMessage = Prisma.MessageGetPayload<{ include: typeof humanMessageInclude }>;

function isNativeHumanMessage(message: SourceMessage): boolean {
  return (
    message.role === "user" &&
    message.botId === null &&
    message.externalTranscriptFor === null &&
    Array.isArray(message.blocks) &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) =>
        block &&
        typeof block === "object" &&
        "kind" in block &&
        ["text", "file", "image"].includes(String(block.kind)),
    )
  );
}

async function requireRunSource(
  tx: Tx,
  actor: Actor,
  run: { id: string; botId: string; threadId: string; sourceMessageId: string | null },
  sourceMessageId: string | null,
) {
  if (!sourceMessageId) throw new IsolationError();
  const source = await tx.message.findFirst({
    where: { id: sourceMessageId, threadId: run.threadId },
    include: humanMessageInclude,
  });
  if (!source) throw new IsolationError();
  const steering = await tx.steeringMessage.findMany({
    where: {
      runId: run.id,
      botId: run.botId,
      userId: actor.userId,
      claimedAt: { not: null },
      message: { threadId: run.threadId },
    },
    include: { message: { include: humanMessageInclude } },
  });
  if (source.id !== run.sourceMessageId && !steering.some((item) => item.messageId === source.id))
    throw new IsolationError();
  return { source, steering };
}

function compareHumanMessages(left: SourceMessage, right: SourceMessage): number {
  return left.threadId === right.threadId
    ? left.seq - right.seq
    : left.createdAt.getTime() - right.createdAt.getTime();
}

async function requireCurrentHumanSource(
  tx: Tx,
  actor: Actor,
  run: Awaited<ReturnType<typeof lockLiveRecruitingRun>>["run"],
  sourceMessageId: string | null,
  quote: string,
) {
  const { source, steering } = await requireRunSource(tx, actor, run, sourceMessageId);
  const original =
    run.sourceMessageId === source.id
      ? source
      : await tx.message.findUnique({
          where: { id: run.sourceMessageId ?? "" },
          include: humanMessageInclude,
        });
  if (
    !isNativeHumanMessage(source) ||
    (source.id === run.sourceMessageId &&
      !["user", "follow_up", "reaction"].includes(run.trigger) &&
      !steering.some((item) => item.messageId === source.id)) ||
    (original &&
      isNativeHumanMessage(original) &&
      original.threadId === source.threadId &&
      original.seq > source.seq) ||
    steering.some((item) => isNativeHumanMessage(item.message) && item.message.seq > source.seq)
  )
    throw new IsolationError();
  const quoteIndex = (source.blocks as { kind: string; text?: string }[]).findIndex(
    (block) =>
      block.kind === "text" && typeof block.text === "string" && block.text.includes(quote),
  );
  if (quoteIndex < 0) throw new IsolationError();
  const humanSource: RecruitingSourceRef = {
    id: `human-message:${source.id}`,
    kind: "original_material",
    anchor: { kind: "message", messageId: source.id, locator: `blocks[${quoteIndex}].text` },
    readState: "read",
    readAt: new Date().toISOString(),
    quote,
  };
  return { source: humanSource, message: source };
}

export async function readRecruitingFeedbackContext(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    runId: string;
    sourceMessageId: string | null;
    intent: RecruitingHumanIntent;
    roleId?: string;
    expectedRoleRevision?: number;
    sourceRefs: readonly RecruitingSourceRef[];
  },
): Promise<{
  source: RecruitingSourceRef;
  workspace: RoleSnapshot | null;
  threadId: string;
  botId: string;
}> {
  const intent = RecruitingHumanIntentSchema.parse(input.intent);
  const sourceRefs = RecruitingSourceRefSchema.array().parse(input.sourceRefs);
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, input.runId);
    const { source } = await requireCurrentHumanSource(
      tx,
      actor,
      run,
      input.sourceMessageId,
      intent.quote,
    );
    const workspace = thread.activeRecruitingRoleId
      ? await roleSnapshot(
          tx,
          actor,
          await requireRole(tx, actor, thread.activeRecruitingRoleId, true),
        )
      : null;
    if (input.roleId !== undefined || input.expectedRoleRevision !== undefined) {
      if (
        !input.roleId ||
        input.expectedRoleRevision === undefined ||
        workspace?.role.id !== input.roleId
      )
        throw new IsolationError();
      if (workspace.role.revision !== input.expectedRoleRevision)
        throw new RecruitingConflictError();
    }
    await validateSources(tx, actor, sourceRefs);
    return { source, workspace, threadId: run.threadId, botId: run.botId };
  });
}

export type RecruitingMemoryAdmission = {
  source: RecruitingSourceRef;
  operation: RecruitingPreferenceFeedbackInput["operation"];
  previousAnchor: { start: number; end: number; quote: string } | null;
  anchor: { start: number; end: number; quote: string } | null;
  runId: string;
  threadId: string;
  botId: string;
  previousSourceVerified: boolean;
};

export async function authorizeRecruitingMemoryCommit(
  tx: Tx,
  request: MemoryCommitRequest,
  context: AdapterContext,
  existing: { id: string; content: string; revision: number } | null,
): Promise<RecruitingMemoryAdmission | undefined> {
  if (!context.runId) {
    if (request.recruiting) throw new IsolationError();
    return;
  }
  const actor: Actor = {
    spaceId: context.spaceId,
    userId: context.userId,
    email: "",
    isDeploymentOwner: false,
  };
  const { run, thread } = await lockLiveRecruitingRun(tx, actor, context.runId);
  if (
    request.sourceRunId !== run.id ||
    request.sourceThreadId !== run.threadId ||
    (context.botId !== undefined && context.botId !== run.botId)
  )
    throw new IsolationError();
  if (!thread.activeRecruitingRoleId && !request.recruiting) return;
  if (!request.recruiting) throw new IsolationError();
  const feedback = RecruitingPreferenceFeedbackSchema.parse(request.recruiting.feedback);
  if (
    feedback.intent.basis !== "direct" ||
    feedback.scope !== request.scope ||
    feedback.path !== request.path ||
    feedback.expectedRevision !== request.expectedRevision ||
    (feedback.scope === "bot" ? request.botId !== run.botId : request.botId !== undefined)
  )
    throw new IsolationError();
  const { source, message } = await requireCurrentHumanSource(
    tx,
    actor,
    run,
    request.recruiting.sourceMessageId,
    feedback.intent.quote,
  );
  await validateSources(tx, actor, feedback.sourceRefs);
  if (thread.activeRecruitingRoleId)
    await roleSnapshot(
      tx,
      actor,
      await requireRole(tx, actor, thread.activeRecruitingRoleId, true),
    );
  const edit = applyRecruitingPreferenceEdit(existing?.content ?? "", feedback);
  if ((existing?.revision ?? 0) !== feedback.expectedRevision || edit.content !== request.content)
    throw new RecruitingConflictError();
  let previousSourceVerified = !existing;
  if (existing) {
    const previousRevision = await tx.memoryRevision.findUnique({
      where: { documentId_revision: { documentId: existing.id, revision: existing.revision } },
    });
    const receipt =
      previousRevision?.sourceRunId && previousRevision.sourceThreadId
        ? await tx.event.findFirst({
            where: {
              spaceId: actor.spaceId,
              threadId: previousRevision.sourceThreadId,
              runId: previousRevision.sourceRunId,
              type: "memory.revised",
              AND: [
                { payload: { path: ["kind"], equals: "recruiting_preference" } },
                { payload: { path: ["documentId"], equals: existing.id } },
                { payload: { path: ["revision"], equals: existing.revision } },
                { payload: { path: ["scope"], equals: request.scope } },
                { payload: { path: ["path"], equals: request.path } },
              ],
            },
          })
        : null;
    if (receipt) {
      const previousSource = RecruitingSourceRefSchema.parse(
        (receipt.payload as { source?: unknown }).source,
      );
      if (previousSource.anchor.kind !== "message") throw new IsolationError();
      const previousMessage = await tx.message.findUnique({
        where: { id: previousSource.anchor.messageId },
        include: humanMessageInclude,
      });
      if (previousMessage) {
        await validateSources(tx, actor, [previousSource]);
        if (!isNativeHumanMessage(previousMessage)) throw new IsolationError();
        if (previousMessage.id !== message.id && compareHumanMessages(previousMessage, message) > 0)
          throw new RecruitingConflictError();
        previousSourceVerified = true;
      }
    }
  }
  return {
    source,
    operation: feedback.operation,
    previousAnchor: feedback.operation === "add" ? null : feedback.anchor,
    anchor: edit.anchor,
    runId: run.id,
    threadId: run.threadId,
    botId: run.botId,
    previousSourceVerified,
  };
}

export async function executeRecruitingRoleMutation(
  prisma: PrismaClient,
  actor: Actor,
  context: { runId: string; sourceMessageId: string | null },
  untrusted: RecruitingRoleMutationInput,
): Promise<RecruitingRoleToolResult> {
  const input = RecruitingRoleToolInputSchema.parse(untrusted);
  if (input.operation === "read") throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, context.runId);
    const { source: humanSource, message: source } = await requireCurrentHumanSource(
      tx,
      actor,
      run,
      context.sourceMessageId,
      input.intent.quote,
    );
    const current = thread.activeRecruitingRoleId
      ? await roleSnapshot(
          tx,
          actor,
          await requireRole(tx, actor, thread.activeRecruitingRoleId, true),
        )
      : null;
    if (input.operation === "revise") {
      if (current?.role.id !== input.roleId) throw new IsolationError();
      if (current.role.revision !== input.expectedRevision) throw new RecruitingConflictError();
      const sourceIds = current.revision.sourceRefs.flatMap((ref) =>
        ref.anchor.kind === "message" ? [ref.anchor.messageId] : [],
      );
      const previous = await tx.message.findMany({
        where: { id: { in: sourceIds } },
        include: humanMessageInclude,
      });
      if (
        previous.some(
          (message) => isNativeHumanMessage(message) && compareHumanMessages(message, source) > 0,
        )
      )
        throw new RecruitingConflictError();
    }
    if (input.intent.basis === "inferred")
      return {
        status: "needs_clarification",
        workspace: current,
        source: humanSource,
        changed: false,
      };
    let workspace: RoleSnapshot | null;
    if (input.operation === "bind") {
      workspace = await bindRoleInTransaction(tx, actor, {
        threadId: run.threadId,
        roleId: input.roleId,
      });
    } else {
      const definition = {
        title: input.title,
        sourceRefs: [...input.sourceRefs.filter((ref) => ref.id !== humanSource.id), humanSource],
        criteria: input.criteria.map((criterion) => ({
          ...criterion,
          sourceRefs: criterion.sourceRefs.length ? criterion.sourceRefs : [humanSource],
        })),
        preferences: input.preferences,
        definitionQuestions: input.definitionQuestions,
      };
      workspace =
        input.operation === "create"
          ? await createRoleInTransaction(
              tx,
              actor,
              CreateRecruitingRoleInput.parse({
                ...definition,
                expectedRevision: 0,
                sourceThreadId: run.threadId,
              }),
            )
          : await reviseRoleInTransaction(
              tx,
              actor,
              ReviseRecruitingRoleInput.parse({
                ...definition,
                roleId: input.roleId,
                expectedRevision: input.expectedRevision,
              }),
            );
    }
    return {
      status: "saved",
      workspace,
      source: humanSource,
      changed: input.operation !== "bind" || current?.role.id !== (workspace?.role.id ?? undefined),
    };
  });
}

export async function recordRecruitingContextAdoption(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    runId: string;
    threadId: string;
    botId: string;
    roleId: string;
    roleRevisionId: string;
    sourceMessageId?: string | null;
    artifact: {
      name: string;
      mimeType: string;
      size: number;
      hash: string;
      storageKey: string;
      clientNonce: string;
    };
  },
) {
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, input.runId);
    if (thread.id !== input.threadId || run.botId !== input.botId) throw new IsolationError();
    if (thread.activeRecruitingRoleId !== input.roleId) throw new RecruitingConflictError();
    const role = await requireRole(tx, actor, input.roleId, true);
    if (role.currentRevisionId !== input.roleRevisionId) throw new RecruitingConflictError();
    // Reading the snapshot validates the exact version and all enduring source ACLs.
    await roleSnapshot(tx, actor, role);
    if (input.sourceMessageId) await requireRunSource(tx, actor, run, input.sourceMessageId);
    const existing = await tx.artifact.findUnique({
      where: {
        spaceId_userId_clientNonce: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          clientNonce: input.artifact.clientNonce,
        },
      },
    });
    if (existing) {
      if (
        existing.runId !== run.id ||
        existing.botId !== run.botId ||
        existing.groupId !== thread.groupId ||
        existing.name !== input.artifact.name ||
        existing.mimeType !== input.artifact.mimeType ||
        existing.version !== 1 ||
        existing.rootArtifactId !== null
      )
        throw new IsolationError();
      const row = await tx.event.findFirst({
        where: {
          spaceId: actor.spaceId,
          threadId: thread.id,
          botId: run.botId,
          runId: run.id,
          type: "recruiting.context.adopted",
          payload: { path: ["contextArtifact", "artifactId"], equals: existing.id },
        },
      });
      if (!row) throw new IsolationError();
      const event = ProductEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
      const payload = event.payload as {
        roleId: string;
        roleRevisionId: string;
        contextArtifact: RecruitingArtifactRef;
      };
      if (
        payload.roleId !== role.id ||
        payload.roleRevisionId !== role.currentRevisionId ||
        payload.contextArtifact.artifactId !== existing.id ||
        payload.contextArtifact.sha256 !== existing.hash
      )
        throw new IsolationError();
      // The first frozen bytes win; the adapter verifies their hash and semantic context.
      return { artifact: existing, event, created: false };
    }
    const artifact = await tx.artifact.create({
      data: {
        ...input.artifact,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: run.botId,
        groupId: thread.groupId,
        runId: run.id,
        rootArtifactId: null,
        version: 1,
      },
    });
    const row = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: run.botId,
      runId: run.id,
      type: "recruiting.context.adopted",
      payload: {
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        contextArtifact: { artifactId: artifact.id, sha256: artifact.hash },
      },
    });
    await tx.run.updateMany({
      where: { id: run.id, initialRecruitingRoleRevisionId: null },
      data: { initialRecruitingRoleRevisionId: role.currentRevisionId },
    });
    const event = ProductEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
    return { artifact, event, created: true };
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
