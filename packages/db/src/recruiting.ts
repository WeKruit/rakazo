import { randomUUID } from "node:crypto";
import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import type {
  Actor,
  CreateRecruitingRoleInput as CreateRoleInput,
  RecruitingArtifactRef,
  RecruitingAssessment,
  RecruitingHumanIntent,
  RecruitingPreferenceFeedbackInput,
  RecruitingReadPayload,
  RecruitingResearchAction,
  RecruitingRole,
  RecruitingRoleRevision,
  RecruitingRoleToolInput,
  RecruitingSourceRef,
  ReviseRecruitingRoleInput as ReviseRoleInput,
  SaveRecruitingAssessmentInput as SaveAssessmentInput,
} from "@rakazo/contracts";
import {
  CreateRecruitingRoleInput,
  MessageBlock as MessageBlockSchema,
  NativeAskAnswerPayloadSchema,
  ProductEventSchema,
  RecruitingArtifactRefSchema,
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
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
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
        botId: true,
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

async function loadRunHumanSources(
  tx: Tx,
  actor: Actor,
  run: { id: string; botId: string; threadId: string },
) {
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
  const receipts = await tx.event.findMany({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      runId: run.id,
      botId: run.botId,
      type: "thread.choice",
    },
  });
  const proofs = receipts.flatMap((receipt) => {
    const parsed = NativeAskAnswerPayloadSchema.safeParse(receipt.payload);
    return parsed.success && parsed.data.answeredByUserId === actor.userId ? [parsed.data] : [];
  });
  const messages = proofs.length
    ? await tx.message.findMany({
        where: {
          threadId: run.threadId,
          id: { in: proofs.flatMap((proof) => [proof.messageId, proof.answerMessageId]) },
        },
        include: humanMessageInclude,
      })
    : [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const answers = proofs.flatMap((proof) => {
    const card = byId.get(proof.messageId);
    const answer = byId.get(proof.answerMessageId);
    const blocks = MessageBlockSchema.array().safeParse(card?.blocks);
    const ask = blocks.success ? blocks.data[proof.askIndex] : undefined;
    return card?.role === "bot" &&
      card.runId === run.id &&
      card.botId === run.botId &&
      ask?.kind === "ask" &&
      ask.status === "answered" &&
      !ask.approvalEffectId &&
      ask.input !== "secret" &&
      !ask.credential &&
      answer &&
      isNativeHumanMessage(answer) &&
      answer.seq > card.seq
      ? [answer]
      : [];
  });
  return { steering, answers };
}

async function requireRunSource(
  tx: Tx,
  actor: Actor,
  run: { id: string; botId: string; threadId: string; sourceMessageId: string | null },
  sourceMessageId: string | null,
) {
  if (sourceMessageId === null && run.sourceMessageId !== null) throw new IsolationError();
  const source =
    sourceMessageId === null
      ? null
      : await tx.message.findFirst({
          where: { id: sourceMessageId, threadId: run.threadId },
          include: humanMessageInclude,
        });
  if (sourceMessageId !== null && !source) throw new IsolationError();
  const { steering, answers } = await loadRunHumanSources(tx, actor, run);
  const hint =
    source ??
    answers.reduce<SourceMessage | null>(
      (latest, answer) => (!latest || answer.seq > latest.seq ? answer : latest),
      null,
    );
  // Admit the supplied runtime hint before resolving a resumed run's newer answer.
  if (
    !hint ||
    (hint.id !== run.sourceMessageId &&
      !steering.some((item) => item.messageId === hint.id) &&
      !answers.some((answer) => answer.id === hint.id))
  )
    throw new IsolationError();
  return { source: hint, steering, answers };
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
  const {
    source: hint,
    steering,
    answers,
  } = await requireRunSource(tx, actor, run, sourceMessageId);
  if (hint.id !== run.sourceMessageId && !isNativeHumanMessage(hint)) throw new IsolationError();
  const source = answers.reduce(
    (current, answer) => (answer.seq > current.seq ? answer : current),
    hint,
  );
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
      !steering.some((item) => item.messageId === source.id) &&
      !answers.some((answer) => answer.id === source.id)) ||
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

type ResearchTaskRow = Prisma.RecruitingResearchTaskGetPayload<Record<string, never>>;
type ResearchActionRow = Prisma.RecruitingResearchActionGetPayload<Record<string, never>>;
type ResearchEffectRow = Prisma.ExternalEffectGetPayload<Record<string, never>>;
export type RecruitingResearchArtifactInput = {
  name: string;
  mimeType: string;
  size: number;
  hash: string;
  storageKey: string;
  clientNonce: string;
};
export type RecruitingResearchContextInput = {
  runId: string;
  sourceMessageId?: string | null;
  intent?: RecruitingHumanIntent;
  expectedRoleRevision?: number;
  mcpServerId?: string;
  taskId?: string;
  actionId?: string;
  clientNonce?: string;
  toolName?: "research" | "reply" | "get_task" | "get_rows";
  historical?: boolean;
};

export function recruitingResearchSnapshot(task: ResearchTaskRow, action: ResearchActionRow) {
  return {
    task: RecruitingResearchTaskSchema.parse(task),
    action: RecruitingResearchActionSchema.parse({
      id: action.id,
      taskId: action.taskId,
      roleRevisionId: action.roleRevisionId,
      clientNonce: action.clientNonce,
      kind: action.kind,
      runId: action.runId,
      sourceMessageId: action.sourceMessageId,
      deliveryState: action.deliveryState,
      observedProviderState: action.observedProviderState,
      requestArtifact: { artifactId: action.requestArtifactId, sha256: action.requestArtifactHash },
      contextArtifact: { artifactId: action.contextArtifactId, sha256: action.contextArtifactHash },
      recallScope: action.recallScope,
      receiptArtifact: action.receiptArtifactId
        ? { artifactId: action.receiptArtifactId, sha256: action.receiptArtifactHash }
        : null,
      outputArtifacts: action.outputArtifacts,
      cursor: action.cursor,
      effectId: action.effectId,
      usage: action.usage,
    }),
  };
}

async function requireResearchHandoff(
  tx: Tx,
  actor: Actor,
  run: {
    id: string;
    botId: string;
    threadId: string;
    sourceMessageId: string | null;
    trigger: string;
  },
  source: SourceMessage,
  current: boolean,
) {
  const parsed = MessageBlockSchema.array().safeParse(source.blocks);
  const block = parsed.success && parsed.data.length === 1 ? parsed.data[0] : null;
  if (
    source.id !== run.sourceMessageId ||
    run.trigger !== "follow_up" ||
    source.threadId !== run.threadId ||
    source.role !== "bot" ||
    source.externalTranscriptFor ||
    !source.botId ||
    !source.runId ||
    source.clientNonce !== `group-handoff:${source.runId}` ||
    block?.kind !== "handoff" ||
    block.fromBotId !== source.botId ||
    block.toBotId !== run.botId ||
    block.fromBotId === block.toBotId
  )
    throw new IsolationError();
  const sender = await tx.run.findFirst({
    where: {
      id: source.runId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: block.fromBotId,
      threadId: run.threadId,
    },
  });
  if (!sender) throw new IsolationError();
  await requireRun(tx, actor, sender.id);
  const thread = await requireThread(tx, actor, run.threadId);
  if (!thread.groupId) throw new IsolationError();
  const event = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: sender.botId,
      runId: sender.id,
      type: "group.handoff",
      payload: { path: ["messageId"], equals: source.id },
    },
  });
  if (
    !event ||
    stableJsonValue(event.payload) !==
      stableJsonValue({
        messageId: source.id,
        fromBotId: sender.botId,
        toBotId: run.botId,
        text: block.text,
      })
  )
    throw new IsolationError();
  if (current) {
    if (
      sender.status === "cancelled" ||
      !(await tx.chatGroup.findFirst({
        where: {
          id: thread.groupId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
        },
      })) ||
      (await tx.chatGroupMember.count({
        where: {
          groupId: thread.groupId,
          botId: { in: [sender.botId, run.botId] },
          bot: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        },
      })) !== 2
    )
      throw new IsolationError();
    for (const owner of [sender, run]) {
      const { steering, answers } = await loadRunHumanSources(tx, actor, owner);
      if (
        steering.some(
          (item) => isNativeHumanMessage(item.message) && item.message.seq > source.seq,
        ) ||
        answers.some((answer) => answer.seq > source.seq)
      )
        throw new IsolationError();
    }
  }
  return block;
}

async function requireResearchSource(
  tx: Tx,
  actor: Actor,
  run: Awaited<ReturnType<typeof lockLiveRecruitingRun>>["run"],
  sourceMessageId: string | null,
  quote: string,
) {
  const { source, answers } = await requireRunSource(tx, actor, run, sourceMessageId);
  if (isNativeHumanMessage(source) || answers.some((answer) => answer.seq > source.seq))
    return requireCurrentHumanSource(tx, actor, run, sourceMessageId, quote);
  const handoff = await requireResearchHandoff(tx, actor, run, source, true);
  if (!handoff.text.includes(quote)) throw new IsolationError();
  return {
    message: source,
    source: RecruitingSourceRefSchema.parse({
      id: `group-handoff:${source.id}`,
      kind: "original_material",
      anchor: { kind: "message", messageId: source.id, locator: "blocks[0].text" },
      readState: "read",
      readAt: new Date().toISOString(),
      quote,
    }),
  };
}

async function researchContextInTransaction(
  tx: Tx,
  actor: Actor,
  input: RecruitingResearchContextInput,
  requireLive = false,
) {
  const live =
    input.historical && !requireLive ? null : await lockLiveRecruitingRun(tx, actor, input.runId);
  if (!live) await requireRun(tx, actor, input.runId);
  const run =
    live?.run ??
    (await tx.run.findUniqueOrThrow({
      where: { id: input.runId },
      include: { bot: { select: { spaceId: true, userId: true } } },
    }));
  const thread = live?.thread ?? (await requireThread(tx, actor, run.threadId));
  let action =
    input.actionId || input.clientNonce
      ? await tx.recruitingResearchAction.findFirst({
          where: {
            ...(input.actionId ? { id: input.actionId } : { clientNonce: input.clientNonce }),
          },
        })
      : null;
  if ((input.actionId || input.clientNonce) && !action) {
    if (input.actionId) throw new IsolationError();
  }
  if (action && input.taskId && action.taskId !== input.taskId) throw new IsolationError();
  const taskId = action?.taskId ?? input.taskId;
  let task = taskId ? await tx.recruitingResearchTask.findUnique({ where: { id: taskId } }) : null;
  const roleId = input.historical && task ? task.roleId : thread.activeRecruitingRoleId;
  if (!roleId) throw new IsolationError();
  const role = await requireRole(tx, actor, roleId, true);
  if (action)
    action = await tx.recruitingResearchAction.findUniqueOrThrow({ where: { id: action.id } });
  if (task) task = await tx.recruitingResearchTask.findUniqueOrThrow({ where: { id: task.id } });
  if (!action && task && !input.actionId && !input.clientNonce) {
    action = task.pendingActionId
      ? await tx.recruitingResearchAction.findUnique({ where: { id: task.pendingActionId } })
      : await tx.recruitingResearchAction.findFirst({ where: { taskId: task.id, kind: "create" } });
    if (!action || action.taskId !== task.id) throw new IsolationError();
  }
  if (input.expectedRoleRevision !== undefined && role.revision !== input.expectedRoleRevision)
    throw new RecruitingConflictError();
  const workspace = await roleSnapshot(tx, actor, role);
  const source = input.intent
    ? (
        await requireResearchSource(
          tx,
          actor,
          run,
          input.sourceMessageId === undefined ? run.sourceMessageId : input.sourceMessageId,
          RecruitingHumanIntentSchema.parse(input.intent).quote,
        )
      ).source
    : null;
  if (taskId && (!task || task.roleId !== role.id)) throw new IsolationError();
  if (task) await requireRun(tx, actor, task.createdByRunId);
  if (input.mcpServerId && task && input.mcpServerId !== task.mcpServerId)
    throw new IsolationError();
  const serverId = task?.mcpServerId ?? input.mcpServerId;
  const server = serverId
    ? scoped(
        actor,
        await tx.mcpServer.findFirst({
          where: {
            id: serverId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            ...(input.historical ? {} : { enabled: true }),
          },
          select: {
            id: true,
            spaceId: true,
            userId: true,
            enabled: true,
            revision: true,
            slug: true,
          },
        }),
      )
    : null;
  if (server && !input.historical) {
    const assignment = await tx.botMcpServer.findFirst({
      where: {
        serverId: server.id,
        botId: run.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    });
    const toolName = input.toolName ?? (action?.kind === "continue" ? "reply" : "research");
    if (
      !assignment ||
      (!assignment.allowAllTools &&
        (!Array.isArray(assignment.allowedTools) || !assignment.allowedTools.includes(toolName)))
    )
      throw new IsolationError();
    if (task && task.serverRevision !== server.revision) throw new RecruitingConflictError();
  }
  let effect: ResearchEffectRow | null = null;
  let requestArtifact: Prisma.ArtifactGetPayload<Record<string, never>> | null = null;
  if (action) {
    if (
      !task ||
      !(await tx.recruitingRoleRevision.findFirst({
        where: { id: action.roleRevisionId, roleId: role.id },
      }))
    )
      throw new IsolationError();
    const origin = await requireRun(tx, actor, action.runId);
    const message = await tx.message.findUnique({
      where: { id: action.sourceMessageId },
      include: humanMessageInclude,
    });
    if (!message || message.threadId !== origin.threadId) throw new IsolationError();
    if (!isNativeHumanMessage(message))
      await requireResearchHandoff(
        tx,
        actor,
        await tx.run.findUniqueOrThrow({ where: { id: origin.id } }),
        message,
        !input.historical,
      );
    const snapshot = recruitingResearchSnapshot(task, action).action;
    for (const ref of [
      snapshot.requestArtifact,
      snapshot.contextArtifact,
      ...(snapshot.receiptArtifact ? [snapshot.receiptArtifact] : []),
      ...snapshot.outputArtifacts,
    ])
      await validateArtifact(tx, actor, ref);
    requestArtifact = await tx.artifact.findUniqueOrThrow({
      where: { id: action.requestArtifactId },
    });
    if (action.effectId) {
      effect = await tx.externalEffect.findFirst({
        where: { id: action.effectId, spaceId: actor.spaceId },
      });
      if (
        !effect ||
        effect.idempotencyKey !== `recruiting-research:${action.id}` ||
        (await tx.recruitingResearchAction.findFirst({
          where: { effectId: effect.id, id: { not: action.id } },
        }))
      )
        throw new IsolationError();
      await requireRun(tx, actor, effect.runId);
    }
  }
  return { run, thread, workspace, server, task, action, effect, requestArtifact, source };
}

export async function readRecruitingResearchContext(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingResearchContextInput,
) {
  return prisma.$transaction((tx) => researchContextInTransaction(tx, actor, input));
}

async function requireResearchAdoption(
  tx: Tx,
  actor: Actor,
  run: { id: string; threadId: string; botId: string },
  role: RecruitingRole,
  ref?: RecruitingArtifactRef,
) {
  const event = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      runId: run.id,
      botId: run.botId,
      type: "recruiting.context.adopted",
      ...(ref
        ? {
            AND: [
              { payload: { path: ["contextArtifact", "artifactId"], equals: ref.artifactId } },
              { payload: { path: ["contextArtifact", "sha256"], equals: ref.sha256 } },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
  });
  if (!event) throw new IsolationError();
  const payload = ProductEventSchema.parse({ ...event, createdAt: event.createdAt.toISOString() })
    .payload as {
    roleId: string;
    roleRevisionId: string;
    contextArtifact: RecruitingArtifactRef;
  };
  if (
    payload.roleId !== role.id ||
    payload.roleRevisionId !== role.currentRevisionId ||
    (ref &&
      (payload.contextArtifact.artifactId !== ref.artifactId ||
        payload.contextArtifact.sha256 !== ref.sha256))
  )
    throw new RecruitingConflictError();
  await validateArtifact(tx, actor, payload.contextArtifact);
  const artifact = await tx.artifact.findUniqueOrThrow({
    where: { id: payload.contextArtifact.artifactId },
  });
  if (artifact.runId !== run.id) throw new IsolationError();
}

async function createResearchArtifact(
  tx: Tx,
  actor: Actor,
  run: { id: string; botId: string },
  thread: { groupId: string | null },
  input: RecruitingResearchArtifactInput,
) {
  if (
    !/^[a-f0-9]{64}$/.test(input.hash) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !input.name ||
    !input.mimeType ||
    !input.storageKey ||
    !input.clientNonce
  )
    throw new IsolationError();
  const data = {
    ...input,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: run.botId,
    groupId: thread.groupId,
    runId: run.id,
    rootArtifactId: null,
    version: 1,
  };
  const existing = await tx.artifact.findUnique({
    where: {
      spaceId_userId_clientNonce: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        clientNonce: input.clientNonce,
      },
    },
  });
  if (existing) {
    if (
      Object.entries(data).some(([key, value]) => existing[key as keyof typeof existing] !== value)
    )
      throw new RecruitingConflictError();
    return existing;
  }
  return tx.artifact.create({ data });
}

async function transitionResearchAction(
  tx: Tx,
  actor: Actor,
  run: { id: string; threadId: string; botId: string },
  action: ResearchActionRow,
  to: RecruitingResearchAction["deliveryState"],
) {
  const changed = await tx.recruitingResearchAction.update({
    where: { id: action.id },
    data: { deliveryState: to },
  });
  if (action.deliveryState !== to)
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "recruiting.action.transitioned",
      payload: { taskId: action.taskId, actionId: action.id, from: action.deliveryState, to },
    });
  return changed;
}

export type RecruitingResearchPreparationInput = {
  runId: string;
  sourceMessageId: string | null;
  intent: RecruitingHumanIntent;
  expectedRoleRevision: number;
  mcpServerId: string;
  serverRevision: number;
  taskId?: string;
  kind: "create" | "continue";
  clientNonce: string;
  recallScope: string | null;
  requestArtifact: RecruitingResearchArtifactInput;
  contextArtifact: RecruitingArtifactRef;
};

export async function prepareRecruitingResearchAction(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingResearchPreparationInput,
) {
  return prisma.$transaction(async (tx) => {
    const context = await researchContextInTransaction(tx, actor, {
      ...input,
      toolName: input.kind === "create" ? "research" : "reply",
    });
    const { run, thread, workspace, server, source } = context;
    if (
      !server ||
      server.revision !== input.serverRevision ||
      input.intent.basis !== "direct" ||
      !source ||
      source.anchor.kind !== "message" ||
      !input.clientNonce
    )
      throw new IsolationError();
    await requireResearchAdoption(tx, actor, run, workspace.role, input.contextArtifact);
    if (context.action) {
      const action = context.action;
      const artifact = context.requestArtifact!;
      if (
        action.kind !== input.kind ||
        action.runId !== run.id ||
        action.sourceMessageId !== source.anchor.messageId ||
        action.roleRevisionId !== workspace.revision.id ||
        action.recallScope !== input.recallScope ||
        action.contextArtifactId !== input.contextArtifact.artifactId ||
        action.contextArtifactHash !== input.contextArtifact.sha256 ||
        (input.taskId && action.taskId !== input.taskId) ||
        Object.entries(input.requestArtifact).some(
          ([key, value]) => artifact[key as keyof typeof artifact] !== value,
        )
      )
        throw new RecruitingConflictError();
      return { task: context.task!, action, requestArtifact: artifact, created: false };
    }
    let task = context.task;
    if (input.kind === "create") {
      if (input.taskId) throw new IsolationError();
      const unresolved = await tx.recruitingResearchTask.findMany({
        where: {
          roleId: workspace.role.id,
          mcpServerId: server.id,
          providerTaskId: null,
          actions: {
            some: { kind: "create", deliveryState: { in: ["prepared", "sending", "unknown"] } },
          },
        },
        include: {
          actions: {
            where: { kind: "create", deliveryState: { in: ["prepared", "sending", "unknown"] } },
          },
        },
      });
      for (const previous of unresolved) {
        for (const oldAction of previous.actions) {
          if (
            oldAction.deliveryState !== "prepared" ||
            oldAction.roleRevisionId === workspace.revision.id
          )
            throw new RecruitingConflictError();
          let effect = await tx.externalEffect.findUnique({
            where: { idempotencyKey: `recruiting-research:${oldAction.id}` },
          });
          if (oldAction.effectId && oldAction.effectId !== effect?.id) throw new IsolationError();
          if (effect) {
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${effect.id} FOR UPDATE`,
            );
            effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
            if (effect.spaceId !== actor.spaceId) throw new IsolationError();
            await requireRun(tx, actor, effect.runId);
            if (!["intended", "approved"].includes(effect.status))
              throw new RecruitingConflictError();
          }
          await transitionResearchAction(tx, actor, run, oldAction, "superseded");
        }
        await tx.recruitingResearchTask.update({
          where: { id: previous.id },
          data: { state: "closed", pendingActionId: null },
        });
      }
      task = await tx.recruitingResearchTask.create({
        data: {
          roleId: workspace.role.id,
          mcpServerId: server.id,
          serverRevision: server.revision,
          createdByRunId: run.id,
        },
      });
    } else if (
      !task?.providerTaskId ||
      (task.pendingActionId &&
        (await tx.recruitingResearchAction.findFirst({
          where: {
            id: task.pendingActionId,
            deliveryState: { in: ["prepared", "sending", "unknown"] },
          },
        })))
    )
      throw new RecruitingConflictError();
    const requestArtifact = await createResearchArtifact(
      tx,
      actor,
      run,
      thread,
      input.requestArtifact,
    );
    const action = await tx.recruitingResearchAction.create({
      data: {
        taskId: task!.id,
        roleRevisionId: workspace.revision.id,
        runId: run.id,
        sourceMessageId: source.anchor.messageId,
        clientNonce: input.clientNonce,
        kind: input.kind,
        requestArtifactId: requestArtifact.id,
        requestArtifactHash: requestArtifact.hash,
        contextArtifactId: input.contextArtifact.artifactId,
        contextArtifactHash: input.contextArtifact.sha256,
        recallScope: input.recallScope,
        outputArtifacts: [],
      },
    });
    task = await tx.recruitingResearchTask.update({
      where: { id: task!.id },
      data: { pendingActionId: action.id, state: "active" },
    });
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "recruiting.action.transitioned",
      payload: { taskId: task.id, actionId: action.id, from: null, to: "prepared" },
    });
    return { task, action, requestArtifact, created: true };
  });
}

type ResearchLease = { runId: string; leaseOwner: string; leaseFence: number };
function requireResearchLease(
  run: Awaited<ReturnType<typeof lockLiveRecruitingRun>>["run"],
  input: ResearchLease,
) {
  if (
    run.status !== "running" ||
    run.leaseOwner !== input.leaseOwner ||
    run.leaseFence !== input.leaseFence ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt.getTime() <= Date.now()
  )
    throw new IsolationError();
}

async function researchCanDispatch(
  tx: Tx,
  actor: Actor,
  context: Awaited<ReturnType<typeof researchContextInTransaction>>,
) {
  const { run, thread, workspace, task, action, server } = context;
  if (!task || !action || !server) throw new IsolationError();
  if (
    action.deliveryState !== "prepared" ||
    task.pendingActionId !== action.id ||
    thread.activeRecruitingRoleId !== task.roleId ||
    !server.enabled ||
    workspace.revision.id !== action.roleRevisionId ||
    task.serverRevision !== server.revision
  )
    return false;
  const assignment = await tx.botMcpServer.findFirst({
    where: { serverId: server.id, botId: run.botId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (
    !assignment ||
    (!assignment.allowAllTools &&
      (!Array.isArray(assignment.allowedTools) ||
        !assignment.allowedTools.includes(action.kind === "create" ? "research" : "reply")))
  )
    return false;
  const origin = await tx.run.findUniqueOrThrow({ where: { id: action.runId } });
  if (origin.status === "cancelled") return false;
  const { source, steering, answers } = await requireRunSource(
    tx,
    actor,
    origin,
    action.sourceMessageId,
  );
  if (!isNativeHumanMessage(source)) {
    try {
      await requireResearchHandoff(tx, actor, origin, source, true);
    } catch (error) {
      if (error instanceof IsolationError) return false;
      throw error;
    }
  }
  if (
    steering.some((item) => isNativeHumanMessage(item.message) && item.message.seq > source.seq) ||
    answers.some((answer) => answer.seq > source.seq)
  )
    return false;
  try {
    await requireResearchAdoption(tx, actor, origin, workspace.role, {
      artifactId: action.contextArtifactId,
      sha256: action.contextArtifactHash,
    });
    await requireResearchAdoption(tx, actor, run, workspace.role);
  } catch (error) {
    if (error instanceof RecruitingConflictError) return false;
    throw error;
  }
  return true;
}

export type RecruitingResearchAdmissionInput = ResearchLease & {
  actionId: string;
  requestArtifact: RecruitingArtifactRef;
  contextArtifact: RecruitingArtifactRef;
  frozenRequest: Prisma.InputJsonValue;
  effectKind: string;
};
export type RecruitingResearchAdmissionStatus =
  | "ready"
  | "busy"
  | "completed"
  | "unknown"
  | "superseded"
  | "rejected";

async function lockResearchDispatchThreads(
  tx: Tx,
  actor: Actor,
  input: { runId: string; actionId: string },
) {
  const current = await tx.run.findFirst({
    where: { id: input.runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { threadId: true },
  });
  const action = await tx.recruitingResearchAction.findFirst({
    where: {
      id: input.actionId,
      run: { spaceId: actor.spaceId, userId: actor.userId },
      task: { role: { spaceId: actor.spaceId, userId: actor.userId } },
    },
    select: { run: { select: { threadId: true } }, effect: { select: { status: true } } },
  });
  if (!current || !action) throw new IsolationError();
  if (action.effect?.status === "completed") return;
  const ids = [...new Set([current.threadId, action.run.threadId])];
  for (const id of ids) await requireThread(tx, actor, id);
  const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "threads" WHERE "id" IN (${Prisma.join(ids)})
    AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} ORDER BY "id" FOR UPDATE`);
  if (locked.length !== ids.length) throw new IsolationError();
}

export async function admitRecruitingResearchAction(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingResearchAdmissionInput,
) {
  return prisma.$transaction(async (tx) => {
    await lockResearchDispatchThreads(tx, actor, input);
    const context = await researchContextInTransaction(
      tx,
      actor,
      { runId: input.runId, actionId: input.actionId, historical: true },
      true,
    );
    const { run, task } = context;
    requireResearchLease(run, input);
    let action = context.action!;
    if (
      !input.effectKind ||
      action.requestArtifactId !== input.requestArtifact.artifactId ||
      action.requestArtifactHash !== input.requestArtifact.sha256 ||
      action.contextArtifactId !== input.contextArtifact.artifactId ||
      action.contextArtifactHash !== input.contextArtifact.sha256
    )
      throw new IsolationError();
    let effect =
      context.effect ??
      (await tx.externalEffect.findUnique({
        where: { idempotencyKey: `recruiting-research:${action.id}` },
      }));
    if (effect) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${effect.id} FOR UPDATE`,
      );
      effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
      if (
        effect.spaceId !== actor.spaceId ||
        effect.kind !== input.effectKind ||
        stableJsonValue(effect.request) !== stableJsonValue(input.frozenRequest) ||
        (await tx.recruitingResearchAction.findFirst({
          where: { effectId: effect.id, id: { not: action.id } },
        }))
      )
        throw new IsolationError();
    }
    const result = (status: RecruitingResearchAdmissionStatus) => ({
      status,
      task: task!,
      action,
      effect,
      ownerRunId: effect?.runId ?? null,
    });
    if (effect?.status === "completed") return result("completed");
    if (effect?.status === "executing") {
      const owner = await tx.run.findUniqueOrThrow({ where: { id: effect.runId } });
      if (
        owner.id !== run.id &&
        (["queued", "leased", "waiting_input"].includes(owner.status) ||
          (owner.status === "running" &&
            owner.leaseExpiresAt &&
            owner.leaseExpiresAt.getTime() > Date.now()))
      )
        return result("busy");
      return result("unknown");
    }
    if (effect?.status === "uncertain") return result("unknown");
    if (action.deliveryState === "superseded") return result("superseded");
    if (effect?.status === "denied" || action.deliveryState === "rejected") {
      action = await transitionResearchAction(tx, actor, run, action, "rejected");
      return result("rejected");
    }
    if (!(await researchCanDispatch(tx, actor, context))) {
      if (action.deliveryState === "prepared")
        action = await transitionResearchAction(tx, actor, run, action, "superseded");
      return result(action.deliveryState === "superseded" ? "superseded" : "unknown");
    }
    if (effect && effect.runId !== run.id) {
      const owner = await requireRun(tx, actor, effect.runId);
      const ownerRun = await tx.run.findUniqueOrThrow({ where: { id: owner.id } });
      if (["queued", "leased", "running", "waiting_input"].includes(ownerRun.status))
        return result("busy");
      if (ownerRun.status === "cancelled") {
        action = await transitionResearchAction(tx, actor, run, action, "superseded");
        return result("superseded");
      }
      if (
        !["failed", "completed"].includes(ownerRun.status) ||
        !["intended", "approved"].includes(effect.status)
      )
        return result("unknown");
      const transferred = await tx.externalEffect.updateMany({
        where: {
          id: effect.id,
          runId: owner.id,
          status: { in: ["intended", "approved"] },
          run: { status: { in: ["failed", "completed"] } },
        },
        data: { runId: run.id },
      });
      if (transferred.count !== 1) return result("busy");
      effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
    }
    if (!effect)
      effect = await tx.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: run.id,
          kind: input.effectKind,
          idempotencyKey: `recruiting-research:${action.id}`,
          status: "intended",
          request: input.frozenRequest,
        },
      });
    if (!["intended", "approved"].includes(effect.status)) return result("unknown");
    action = await tx.recruitingResearchAction.update({
      where: { id: action.id },
      data: { effectId: effect.id },
    });
    return result("ready");
  });
}

export async function claimRecruitingResearchAction(
  prisma: PrismaClient,
  actor: Actor,
  input: ResearchLease & { actionId: string; effectId: string; from: "intended" | "approved" },
) {
  return prisma.$transaction(async (tx) => {
    await lockResearchDispatchThreads(tx, actor, input);
    const context = await researchContextInTransaction(
      tx,
      actor,
      { runId: input.runId, actionId: input.actionId, historical: true },
      true,
    );
    requireResearchLease(context.run, input);
    const { action, effect } = context;
    if (
      !action ||
      !effect ||
      effect.id !== input.effectId ||
      effect.runId !== input.runId ||
      !["intended", "approved"].includes(input.from) ||
      effect.status !== input.from
    )
      return false;
    if (!(await researchCanDispatch(tx, actor, context))) {
      if (action.deliveryState === "prepared")
        await transitionResearchAction(tx, actor, context.run, action, "superseded");
      return false;
    }
    const claimed = await tx.externalEffect.updateMany({
      where: { id: effect.id, spaceId: actor.spaceId, runId: input.runId, status: input.from },
      data: { status: "executing" },
    });
    if (claimed.count !== 1) return false;
    await transitionResearchAction(tx, actor, context.run, action, "sending");
    return true;
  });
}

export type RecruitingResearchReconciliationInput = {
  runId: string;
  actionId: string;
  effectId: string;
  rawResult: Prisma.InputJsonValue;
  receiptArtifact: RecruitingResearchArtifactInput;
  deliveryState: "accepted" | "rejected" | "unknown";
  providerTaskId?: string;
  observedProviderState?: string;
  usage?: RecruitingResearchAction["usage"];
  outputArtifact?: RecruitingResearchArtifactInput;
  cursor?: string | null;
  taskState?: "active" | "completed" | "closed" | "unknown";
  providerApplicationConfirmed?: boolean;
  retryAfterSeconds?: number;
  refusalCode?: string;
};

async function appendResearchOutput(
  tx: Tx,
  actor: Actor,
  run: { id: string; botId: string },
  thread: { groupId: string | null },
  action: ResearchActionRow,
  input: { outputArtifact: RecruitingResearchArtifactInput; cursor?: string | null },
) {
  const refs = RecruitingArtifactRefSchema.array().parse(action.outputArtifacts);
  const duplicate =
    input.cursor === undefined || input.cursor === action.cursor
      ? refs.find((ref) => ref.sha256 === input.outputArtifact.hash)
      : undefined;
  const outputArtifact = duplicate
    ? await tx.artifact.findUniqueOrThrow({ where: { id: duplicate.artifactId } })
    : await createResearchArtifact(tx, actor, run, thread, input.outputArtifact);
  if (!duplicate) refs.push({ artifactId: outputArtifact.id, sha256: outputArtifact.hash });
  return { outputArtifact, outputArtifacts: refs as Prisma.InputJsonValue };
}

export async function reconcileRecruitingResearchAction(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingResearchReconciliationInput,
) {
  return prisma.$transaction(async (tx) => {
    const run = await requireRun(tx, actor, input.runId);
    const thread = await requireThread(tx, actor, run.threadId);
    let action = await tx.recruitingResearchAction.findUnique({ where: { id: input.actionId } });
    if (!action) throw new IsolationError();
    let task = await tx.recruitingResearchTask.findUniqueOrThrow({ where: { id: action.taskId } });
    await requireRole(tx, actor, task.roleId, true);
    action = await tx.recruitingResearchAction.findUniqueOrThrow({ where: { id: action.id } });
    task = await tx.recruitingResearchTask.findUniqueOrThrow({ where: { id: task.id } });
    await requireRun(tx, actor, action.runId);
    if (action.effectId !== input.effectId) throw new IsolationError();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${input.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: { id: input.effectId, spaceId: actor.spaceId, status: "completed" },
    });
    if (
      !effect ||
      effect.idempotencyKey !== `recruiting-research:${action.id}` ||
      (await tx.recruitingResearchAction.findFirst({
        where: { effectId: effect.id, id: { not: action.id } },
      }))
    )
      throw new IsolationError();
    await requireRun(tx, actor, effect.runId);
    const prior = effect.result as {
      providerResult?: unknown;
      recruitingReceipt?: { version?: number; actionId?: string };
    } | null;
    const rawResult =
      action.receiptArtifactId &&
      prior?.recruitingReceipt?.version === 1 &&
      prior.recruitingReceipt.actionId === action.id
        ? prior.providerResult
        : effect.result;
    if (stableJsonValue(rawResult) !== stableJsonValue(input.rawResult)) throw new IsolationError();
    if (input.providerTaskId && task.providerTaskId && task.providerTaskId !== input.providerTaskId)
      throw new RecruitingConflictError();
    const providerTaskId = input.providerTaskId ?? task.providerTaskId;
    const deliveryState =
      input.deliveryState === "accepted" && !providerTaskId ? "unknown" : input.deliveryState;
    if (
      providerTaskId &&
      (await tx.recruitingResearchTask.findFirst({
        where: {
          mcpServerId: task.mcpServerId,
          serverRevision: task.serverRevision,
          providerTaskId,
          id: { not: task.id },
        },
      }))
    )
      throw new RecruitingConflictError();
    if (action.receiptArtifactId) {
      const receiptArtifact = await tx.artifact.findUniqueOrThrow({
        where: { id: action.receiptArtifactId },
      });
      await validateArtifact(tx, actor, {
        artifactId: receiptArtifact.id,
        sha256: action.receiptArtifactHash!,
      });
      if (
        receiptArtifact.hash !== input.receiptArtifact.hash ||
        action.deliveryState !== deliveryState
      )
        throw new RecruitingConflictError();
      return { task, action, receiptArtifact, outputArtifact: null };
    }
    const receiptArtifact = await createResearchArtifact(
      tx,
      actor,
      run,
      thread,
      input.receiptArtifact,
    );
    const output = input.outputArtifact
      ? await appendResearchOutput(tx, actor, run, thread, action, {
          outputArtifact: input.outputArtifact,
          cursor: input.cursor,
        })
      : null;
    const state =
      deliveryState === "unknown"
        ? "unknown"
        : (input.taskState ??
          (deliveryState === "rejected" && !providerTaskId ? "closed" : "active"));
    task = await tx.recruitingResearchTask.update({
      where: { id: task.id },
      data: {
        providerTaskId,
        state,
        ...(task.pendingActionId === action.id && state === "closed"
          ? { pendingActionId: null }
          : {}),
      },
    });
    action = await tx.recruitingResearchAction.update({
      where: { id: action.id },
      data: {
        receiptArtifactId: receiptArtifact.id,
        receiptArtifactHash: receiptArtifact.hash,
        ...(input.observedProviderState !== undefined
          ? { observedProviderState: input.observedProviderState }
          : {}),
        ...(input.usage !== undefined
          ? {
              usage:
                input.usage === null ? Prisma.JsonNull : (input.usage as Prisma.InputJsonValue),
            }
          : {}),
        ...(output ? { outputArtifacts: output.outputArtifacts } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      },
    });
    action = await transitionResearchAction(tx, actor, run, action, deliveryState);
    recruitingResearchSnapshot(task, action);
    if (
      input.retryAfterSeconds !== undefined &&
      (!Number.isFinite(input.retryAfterSeconds) || input.retryAfterSeconds < 0)
    )
      throw new IsolationError();
    await tx.externalEffect.update({
      where: { id: effect.id },
      data: {
        result: {
          providerResult: input.rawResult,
          recruitingReceipt: {
            version: 1,
            actionId: action.id,
            deliveryState,
            providerApplicationConfirmed: input.providerApplicationConfirmed ?? false,
            ...(input.retryAfterSeconds !== undefined
              ? {
                  retryAfterSeconds: input.retryAfterSeconds,
                  retryAt: new Date(Date.now() + input.retryAfterSeconds * 1000).toISOString(),
                }
              : {}),
            ...(input.refusalCode !== undefined ? { refusalCode: input.refusalCode } : {}),
          },
        },
      },
    });
    return { task, action, receiptArtifact, outputArtifact: output?.outputArtifact ?? null };
  });
}

export type RecruitingResearchObservationInput = {
  runId: string;
  actionId: string;
  effectId: string;
  request: Prisma.InputJsonValue;
  rawResult: Prisma.InputJsonValue;
  toolName: "get_task" | "get_rows";
  outputArtifact: RecruitingResearchArtifactInput;
  observedProviderState?: string;
  taskState?: "active" | "completed" | "closed" | "unknown";
  usage?: RecruitingResearchAction["usage"];
  cursor?: string | null;
  historicalBackfill?: boolean;
};

type ResearchReadBinding = Extract<RecruitingReadPayload, { phase: "bound" }>;
type ResearchReadRecorded = Extract<RecruitingReadPayload, { phase: "recorded" }>;
type ResearchReadTool = ResearchReadBinding["toolName"];
type ResearchReadEvent = Prisma.EventGetPayload<Record<string, never>>;

function researchReadPayload(event: ResearchReadEvent): RecruitingReadPayload {
  const parsed = ProductEventSchema.safeParse({
    ...event,
    createdAt: event.createdAt.toISOString(),
  });
  if (!parsed.success) throw new IsolationError();
  return parsed.data.payload as RecruitingReadPayload;
}

function researchReadRequest(
  request: Prisma.JsonValue | Prisma.InputJsonValue,
  task?: ResearchTaskRow,
  toolName?: ResearchReadTool,
) {
  if (!Array.isArray(request) || request[0] !== "__rakazoCatalogTool") throw new IsolationError();
  const payload = request[2] as {
    route?: unknown;
    args?: unknown;
    id?: unknown;
    arguments?: unknown;
  } | null;
  const direct = request.length === 3 && request[1] === "direct";
  const catalog =
    request.length === 4 &&
    ["connectors_execute_tool", "mcp_execute_tool"].includes(String(request[1]));
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || (!direct && !catalog))
    throw new IsolationError();
  const route = (direct ? payload.route : request[3]) as {
    connectorId: "mcp";
    resourceId: string;
    resourceRevision: number;
    toolName: ResearchReadTool;
  } | null;
  const args = (direct ? payload.args : payload.arguments) as Prisma.InputJsonObject | null;
  if (
    !route ||
    typeof route !== "object" ||
    Array.isArray(route) ||
    Object.keys(route).length !== 4 ||
    Object.keys(route).some(
      (key) => !["connectorId", "resourceId", "resourceRevision", "toolName"].includes(key),
    ) ||
    route.connectorId !== "mcp" ||
    typeof route.resourceId !== "string" ||
    !Number.isSafeInteger(route.resourceRevision) ||
    route.resourceRevision < 1 ||
    !["get_task", "get_rows"].includes(route.toolName) ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    typeof args.task_id !== "string" ||
    !args.task_id ||
    (toolName && route.toolName !== toolName) ||
    (task &&
      (route.resourceId !== task.mcpServerId ||
        route.resourceRevision !== task.serverRevision ||
        args.task_id !== task.providerTaskId)) ||
    (catalog && payload.id !== `${route.resourceId}:${encodeURIComponent(route.toolName)}`)
  )
    throw new IsolationError();
  return { toolName: route.toolName, args, route };
}

async function researchReadBinding(
  tx: Tx,
  actor: Actor,
  effect: ResearchEffectRow,
  lease?: ResearchLease,
) {
  const owner = await requireRun(tx, actor, effect.runId);
  const events = await tx.event.findMany({
    where: {
      spaceId: actor.spaceId,
      type: "recruiting.read",
      payload: { path: ["effectId"], equals: effect.id },
    },
  });
  if (events.length === 0) return null;
  const parsed = events.map((event) => ({ event, payload: researchReadPayload(event) }));
  const bindings = parsed.filter((item) => item.payload.phase === "bound");
  const recorded = parsed.filter((item) => item.payload.phase === "recorded");
  if (bindings.length !== 1 || recorded.length > 1) throw new IsolationError();
  const { event, payload } = bindings[0]!;
  const binding = payload as ResearchReadBinding;
  if (lease && effect.runId !== lease.runId) throw new IsolationError();
  if (event.runId !== owner.id || event.threadId !== owner.threadId || event.botId !== owner.botId)
    throw new IsolationError();
  const saved = await researchContextInTransaction(tx, actor, {
    runId: owner.id,
    actionId: binding.actionId,
    toolName: binding.toolName,
    historical: !lease,
  });
  if (lease) requireResearchLease(saved.run, lease);
  if (!saved.task || !saved.action || saved.task.id !== binding.taskId) throw new IsolationError();
  const call = researchReadRequest(effect.request, saved.task, binding.toolName);
  const materialized = recorded[0];
  if (
    materialized &&
    (materialized.payload.taskId !== binding.taskId ||
      materialized.payload.actionId !== binding.actionId)
  )
    throw new IsolationError();
  return {
    saved,
    effect,
    binding,
    ...call,
    recorded: materialized
      ? {
          event: materialized.event,
          payload: materialized.payload as ResearchReadRecorded,
        }
      : null,
  };
}

async function recordedResearchReadArtifact(
  tx: Tx,
  actor: Actor,
  read: NonNullable<Awaited<ReturnType<typeof researchReadBinding>>>,
) {
  const artifact = await tx.artifact.findUnique({
    where: {
      spaceId_userId_clientNonce: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        clientNonce: `recruiting-observation:${read.effect.id}`,
      },
    },
  });
  if (!artifact && !read.recorded) return null;
  if (!artifact || !read.recorded) throw new IsolationError();
  const { event, payload } = read.recorded;
  if (!event.runId) throw new IsolationError();
  const owner = await requireRun(tx, actor, event.runId);
  if (
    event.threadId !== owner.threadId ||
    event.botId !== owner.botId ||
    artifact.runId !== owner.id ||
    artifact.botId !== owner.botId ||
    payload.outputArtifact.artifactId !== artifact.id ||
    payload.outputArtifact.sha256 !== artifact.hash ||
    !RecruitingArtifactRefSchema.array()
      .parse(read.saved.action!.outputArtifacts)
      .some((ref) => ref.artifactId === artifact.id && ref.sha256 === artifact.hash)
  )
    throw new IsolationError();
  await validateArtifact(tx, actor, payload.outputArtifact);
  return artifact;
}

export async function bindRecruitingResearchReadEffect(
  prisma: PrismaClient,
  actor: Actor,
  input: ResearchLease & { actionId: string; effectId: string; request: Prisma.InputJsonValue },
) {
  return prisma.$transaction(async (tx) => {
    let effect = await tx.externalEffect.findFirst({
      where: { id: input.effectId, spaceId: actor.spaceId, runId: input.runId },
    });
    if (!effect || stableJsonValue(effect.request) !== stableJsonValue(input.request))
      throw new IsolationError();
    const existing = await researchReadBinding(
      tx,
      actor,
      effect,
      effect.status === "completed" ? undefined : input,
    );
    if (existing) {
      if (
        input.actionId !== existing.binding.actionId &&
        !(await tx.recruitingResearchAction.findFirst({
          where: { id: input.actionId, taskId: existing.binding.taskId },
        }))
      )
        throw new IsolationError();
      await recordedResearchReadArtifact(tx, actor, existing);
      return { saved: existing.saved, effect, binding: existing.binding };
    }
    const call = researchReadRequest(input.request);
    const saved = await researchContextInTransaction(tx, actor, {
      runId: input.runId,
      actionId: input.actionId,
      toolName: call.toolName,
    });
    requireResearchLease(saved.run, input);
    if (!saved.task || !saved.action) throw new IsolationError();
    researchReadRequest(input.request, saved.task, call.toolName);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${effect.id} FOR UPDATE`,
    );
    effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
    if (
      effect.runId !== input.runId ||
      effect.spaceId !== actor.spaceId ||
      stableJsonValue(effect.request) !== stableJsonValue(input.request)
    )
      throw new IsolationError();
    const raced = await researchReadBinding(tx, actor, effect);
    if (raced) {
      if (raced.binding.taskId !== saved.task.id) throw new IsolationError();
      return { saved: raced.saved, effect, binding: raced.binding };
    }
    if (!["intended", "approved", "executing"].includes(effect.status)) throw new IsolationError();
    const binding: ResearchReadBinding = {
      phase: "bound",
      taskId: saved.task.id,
      actionId: saved.action.id,
      effectId: effect.id,
      toolName: call.toolName,
    };
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: saved.run.threadId,
      botId: saved.run.botId,
      runId: saved.run.id,
      type: "recruiting.read",
      payload: binding,
    });
    researchReadPayload(event);
    return { saved, effect, binding };
  });
}

export async function claimRecruitingResearchReadEffect(
  prisma: PrismaClient,
  actor: Actor,
  input: ResearchLease & { effectId: string; from: "intended" | "approved" },
) {
  return prisma.$transaction(async (tx) => {
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: input.effectId,
        spaceId: actor.spaceId,
        runId: input.runId,
      },
    });
    if (!effect) throw new IsolationError();
    const read = await researchReadBinding(tx, actor, effect, input);
    if (!read || !["intended", "approved"].includes(input.from) || effect.status !== input.from)
      return false;
    const claimed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        spaceId: actor.spaceId,
        runId: input.runId,
        status: input.from,
        request: { equals: effect.request as Prisma.InputJsonValue },
      },
      data: { status: "executing" },
    });
    return claimed.count === 1;
  });
}

export async function listUnmappedRecruitingResearchReads(
  prisma: PrismaClient,
  actor: Actor,
  input: { runId: string; taskId: string },
) {
  return prisma.$transaction(async (tx) => {
    await requireRun(tx, actor, input.runId);
    const task = await tx.recruitingResearchTask.findUnique({ where: { id: input.taskId } });
    if (!task) throw new IsolationError();
    await requireRole(tx, actor, task.roleId, true);
    const events = await tx.event.findMany({
      where: {
        spaceId: actor.spaceId,
        type: "recruiting.read",
        payload: { path: ["taskId"], equals: task.id },
      },
    });
    const pending = [];
    for (const effectId of new Set(events.map((event) => researchReadPayload(event).effectId))) {
      const effect = await tx.externalEffect.findFirst({
        where: { id: effectId, spaceId: actor.spaceId },
      });
      if (!effect) throw new IsolationError();
      const read = await researchReadBinding(tx, actor, effect);
      if (!read || read.binding.taskId !== task.id) throw new IsolationError();
      if (effect.status !== "completed") continue;
      if (!(await recordedResearchReadArtifact(tx, actor, read)))
        pending.push({
          saved: read.saved,
          effect,
          toolName: read.toolName,
          args: read.args,
          route: read.route,
        });
    }
    return pending;
  });
}

export async function recordRecruitingResearchObservation(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingResearchObservationInput,
) {
  return prisma.$transaction(async (tx) => {
    const capture = await requireRun(tx, actor, input.runId);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = ${capture.threadId} FOR UPDATE`,
    );
    const context = await researchContextInTransaction(tx, actor, { ...input, historical: true });
    const { run, thread, action, task } = context;
    if (
      !action ||
      !task?.providerTaskId ||
      (input.usage !== undefined && !action.receiptArtifactId)
    )
      throw new IsolationError();
    const effect = await tx.externalEffect.findFirst({
      where: { id: input.effectId, spaceId: actor.spaceId, status: "completed" },
    });
    if (
      !effect ||
      (effect.runId !== run.id && !input.historicalBackfill) ||
      stableJsonValue(effect.request) !== stableJsonValue(input.request) ||
      stableJsonValue(effect.result) !== stableJsonValue(input.rawResult) ||
      input.outputArtifact.clientNonce !== `recruiting-observation:${effect.id}`
    )
      throw new IsolationError();
    researchReadRequest(input.request, task, input.toolName);
    const read = await researchReadBinding(tx, actor, effect);
    if (
      !read ||
      read.binding.actionId !== action.id ||
      read.binding.taskId !== task.id ||
      read.toolName !== input.toolName
    )
      throw new IsolationError();
    const recorded = await recordedResearchReadArtifact(tx, actor, read);
    if (recorded) {
      if (recorded.hash !== input.outputArtifact.hash) throw new RecruitingConflictError();
      return { task, action, outputArtifact: recorded };
    }
    const outputArtifact = await createResearchArtifact(
      tx,
      actor,
      run,
      thread,
      input.outputArtifact,
    );
    const outputArtifacts = [
      ...RecruitingArtifactRefSchema.array().parse(action.outputArtifacts),
      { artifactId: outputArtifact.id, sha256: outputArtifact.hash },
    ];
    const updated = await tx.recruitingResearchAction.update({
      where: { id: action.id },
      data: {
        outputArtifacts,
        ...(!input.historicalBackfill && input.observedProviderState !== undefined
          ? { observedProviderState: input.observedProviderState }
          : {}),
        ...(!input.historicalBackfill && input.usage !== undefined
          ? {
              usage:
                input.usage === null ? Prisma.JsonNull : (input.usage as Prisma.InputJsonValue),
            }
          : {}),
        ...(!input.historicalBackfill && input.cursor !== undefined
          ? { cursor: input.cursor }
          : {}),
      },
    });
    const changedTask =
      !input.historicalBackfill && task.pendingActionId === action.id && input.taskState
        ? await tx.recruitingResearchTask.update({
            where: { id: task.id },
            data: {
              state: input.taskState,
              ...(task.pendingActionId === action.id && input.taskState === "closed"
                ? { pendingActionId: null }
                : {}),
            },
          })
        : task;
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "recruiting.read",
      allowCancelledRun: true,
      payload: {
        phase: "recorded",
        taskId: task.id,
        actionId: action.id,
        effectId: effect.id,
        outputArtifact: { artifactId: outputArtifact.id, sha256: outputArtifact.hash },
      },
    });
    researchReadPayload(event);
    recruitingResearchSnapshot(changedTask, updated);
    return { task: changedTask, action: updated, outputArtifact };
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
          if (action.effectId) {
            const effect = await tx.externalEffect.findFirst({
              where: { id: action.effectId, spaceId: actor.spaceId },
              select: { runId: true },
            });
            if (!effect) throw new IsolationError();
            await requireRun(tx, actor, effect.runId);
          }
          const dto = recruitingResearchSnapshot(task, action).action;
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
