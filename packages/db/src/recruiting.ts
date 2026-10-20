import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext, ArtifactStore, MemoryCommitRequest } from "@rakazo/adapter-kit";
import type {
  Actor,
  ListRecruitingCandidateSourcesInput as CandidateSourcesInput,
  ListRecruitingCandidateSourcesOutput as CandidateSourcesOutput,
  ListRecruitingCandidatesInput as CandidatesInput,
  ListRecruitingCandidatesOutput as CandidatesOutput,
  CreateRecruitingRoleInput as CreateRoleInput,
  MessageBlock,
  RecruitingApprovalToolInput,
  RecruitingArtifactRef,
  RecruitingAssessmentAskInput,
  RecruitingAssessmentSnapshot,
  RecruitingAssessmentSourceRef,
  RecruitingCriterionExpression,
  RecruitingCrmCandidateSync,
  RecruitingCrmImportInput,
  RecruitingCrmTarget,
  RecruitingFeedbackRecord,
  RecruitingHumanIntent,
  RecruitingMaterialReadPayload,
  RecruitingPreferenceFeedbackInput,
  RecruitingQuestion,
  RecruitingReadPayload,
  RecruitingReplyTarget,
  RecruitingResearchAction,
  RecruitingResearchPurpose,
  RecruitingResearchToolInput,
  RecruitingRole,
  RecruitingRoleRevision,
  RecruitingRoleToolInput,
  RecruitingSourceRef,
  ReviseRecruitingRoleInput as ReviseRoleInput,
  SaveRecruitingAssessmentInput as SaveAssessmentInput,
  SetRecruitingCandidateShortlistInput as ShortlistInput,
  SetRecruitingCandidateShortlistOutput as ShortlistOutput,
} from "@rakazo/contracts";
import {
  ConfirmRecruitingBriefInput,
  CreateRecruitingRoleInput,
  EditRecruitingCriteriaInput,
  EffectApprovalAnsweredPayloadSchema,
  ListRecruitingCandidateSourcesInput,
  ListRecruitingCandidateSourcesOutput,
  ListRecruitingCandidatesInput,
  ListRecruitingCandidatesOutput,
  ListRecruitingFeedbackInput,
  ListRecruitingFeedbackOutput,
  MessageBlock as MessageBlockSchema,
  NativeAskAnswerPayloadSchema,
  ProductEventSchema,
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  ReassessRecruitingAssessmentInput,
  RecruitingApprovalToolInputSchema,
  RecruitingArtifactRefSchema,
  RecruitingAssessmentAskInputSchema,
  RecruitingAssessmentSchema,
  RecruitingCandidateFeedbackSelectionSchema,
  RecruitingCandidateOutputSchemaId,
  RecruitingCrmBindingInputSchema,
  RecruitingCrmImportArgsSchema,
  RecruitingCrmImportInputSchema,
  RecruitingFeedbackInputSchema,
  RecruitingFeedbackRecordSchema,
  RecruitingHumanIntentSchema,
  RecruitingMaterialReadPayloadSchema,
  RecruitingPreferenceFeedbackSchema,
  RecruitingQuestionAskedPayloadSchema,
  RecruitingQuestionSchema,
  RecruitingReplyTargetSchema,
  RecruitingResearchActionSchema,
  RecruitingResearchSavedObservationSchema,
  RecruitingResearchTaskSchema,
  RecruitingResearchToolInputSchema,
  RecruitingRoleRevisionSchema,
  RecruitingRoleSchema,
  RecruitingRoleToolInputSchema,
  RecruitingShortlistToolInputSchema,
  RecruitingShortlistToolResultSchema,
  RecruitingSourceRefSchema,
  ReviseRecruitingRoleInput,
  SaveRecruitingAssessmentInput,
  SetRecruitingCandidateShortlistInput,
} from "@rakazo/contracts";
import {
  applyRecruitingPreferenceEdit,
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalRequest,
  deriveRecruitingCrmImportStatus,
  evaluateRecruitingAssessment,
  extractLinksFromText,
  extractRecruitingCrmTarget,
  mergeRecruitingReassessment,
  normalizeRecruitingCandidateRow,
  parseRecruitingCrmImportReceipt,
  RecruitingPlaybookValidationError,
  readRecruitingJsonString,
  recruitingBriefClarifications,
  recruitingCalibrationIdentity,
  requireRecruitingBriefConfirmation,
  validateRecruitingBrief,
  validateRecruitingTextSelection,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { AnswerRunInput, PauseRunForInput } from "./events.js";
import { appendEventInTransaction } from "./events.js";
import type { SourceMessage } from "./messages.js";
import {
  createThreadMessageInTransaction,
  humanMessageInclude,
  isNativeHumanMessage,
  loadRunHumanSources,
  validateRunHumanSourceRows,
} from "./messages.js";
import { IsolationError, scoped } from "./scope.js";

type Tx = Prisma.TransactionClient;
type RoleSnapshot = { role: RecruitingRole; revision: RecruitingRoleRevision };

export type { RecruitingAssessmentSnapshot } from "@rakazo/contracts";

export class RecruitingConflictError extends Error {
  constructor() {
    super("Recruiting revision changed");
    this.name = "RecruitingConflictError";
  }
}

export class RecruitingSourceValidationError extends Error {
  constructor(sourceRefId: string, locator: string) {
    super(
      `Source ${JSON.stringify(sourceRefId)} at ${JSON.stringify(locator)}: quote must be exact contiguous text from the original read receipt; copy one unchanged excerpt without omissions or joined passages.`,
    );
    this.name = "RecruitingSourceValidationError";
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

async function requireRole(
  tx: Tx,
  actor: Actor,
  roleId: string,
  lock = false,
  thread?: Awaited<ReturnType<typeof requireThread>>,
) {
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
  if (role.sourceThreadId === thread?.id) scoped(actor, thread);
  else await requireThread(tx, actor, role.sourceThreadId);
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

async function validateArtifact(
  tx: Tx,
  actor: Actor,
  ref: RecruitingArtifactRef,
  context?: {
    run: Awaited<ReturnType<typeof requireRun>>;
    thread: Awaited<ReturnType<typeof requireThread>>;
  },
) {
  const artifact = scoped(
    actor,
    await tx.artifact.findFirst({
      where: { id: ref.artifactId, spaceId: actor.spaceId, userId: actor.userId },
    }),
  );
  if (artifact.hash !== ref.sha256 || (!artifact.groupId && !artifact.botId))
    throw new IsolationError();
  const run = artifact.runId
    ? artifact.runId === context?.run.id
      ? scoped(actor, context.run)
      : await requireRun(tx, actor, artifact.runId)
    : null;
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
  if (context && thread.id === context.thread.id) scoped(actor, context.thread);
  else await requireThread(tx, actor, thread.id);
  return artifact;
}

async function validateSources(
  tx: Tx,
  actor: Actor,
  sources: readonly RecruitingSourceRef[],
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
) {
  const artifacts = new Set<string>();
  const messageIds = new Set<string>();
  for (const source of sources) {
    if (source.anchor.kind === "artifact") {
      const key = `${source.anchor.artifact.artifactId}:${source.anchor.artifact.sha256}`;
      if (artifacts.has(key)) continue;
      await validateArtifact(tx, actor, source.anchor.artifact);
      artifacts.add(key);
    } else {
      messageIds.add(source.anchor.messageId);
    }
  }
  const sourceMessageTargets: RecruitingAssessmentSnapshot["sourceMessageTargets"] = [];
  if (!messageIds.size) return sourceMessageTargets;
  const messages = await tx.message.findMany({
    where: { id: { in: [...messageIds] } },
    select: { id: true, threadId: true },
  });
  if (messages.length !== messageIds.size) throw new IsolationError();
  const threads = new Map<string, Awaited<ReturnType<typeof requireThread>>>();
  for (const threadId of new Set(messages.map((message) => message.threadId)))
    threads.set(
      threadId,
      threadId === authorizedThread?.id
        ? scoped(actor, authorizedThread)
        : await requireThread(tx, actor, threadId),
    );
  for (const message of messages) {
    const thread = threads.get(message.threadId)!;
    if (thread.groupId)
      sourceMessageTargets.push({
        messageId: message.id,
        threadId: thread.id,
        target: { groupId: thread.groupId },
      });
    else if (thread.botId)
      sourceMessageTargets.push({
        messageId: message.id,
        threadId: thread.id,
        target: { botId: thread.botId },
      });
  }
  return sourceMessageTargets;
}

function definitionSources(definition: Pick<RecruitingRoleRevision, "sourceRefs" | "criteria">) {
  return [
    ...definition.sourceRefs,
    ...definition.criteria.flatMap((criterion) => criterion.sourceRefs),
  ];
}

async function validateDefinition(
  tx: Tx,
  actor: Actor,
  definition: Pick<RecruitingRoleRevision, "sourceRefs" | "criteria">,
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
) {
  return validateSources(tx, actor, definitionSources(definition), authorizedThread);
}

/** Trusted native storage access, separate from the submitted role definition. */
export type RecruitingRoleMaterialContext = { artifacts: ArtifactStore; context: AdapterContext };

async function loadRoleMaterials(
  prisma: PrismaClient,
  actor: Actor,
  definition: Pick<RecruitingRoleRevision, "sourceRefs" | "criteria">,
  material?: RecruitingRoleMaterialContext,
) {
  const references = new Map<string, RecruitingArtifactRef>();
  for (const source of definitionSources(definition)) {
    if (
      source.readState !== "read" ||
      source.quote === undefined ||
      source.anchor.kind !== "artifact"
    )
      continue;
    const ref = source.anchor.artifact;
    const previous = references.get(ref.artifactId);
    if (previous && previous.sha256 !== ref.sha256) throw new IsolationError();
    references.set(ref.artifactId, ref);
  }
  const bytes = new Map<string, Uint8Array>();
  if (!references.size) return bytes;
  if (
    !material ||
    material.context.spaceId !== actor.spaceId ||
    material.context.userId !== actor.userId
  )
    throw new IsolationError();
  material.context.signal.throwIfAborted();
  // Authorize each exact native Artifact before store access; revalidate it in the mutation transaction.
  const rows = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const ref of references.values()) rows.push(await validateArtifact(tx, actor, ref));
    return rows;
  });
  for (const row of rows) {
    material.context.signal.throwIfAborted();
    bytes.set(row.id, await material.artifacts.get(row.storageKey, material.context));
  }
  material.context.signal.throwIfAborted();
  return bytes;
}

async function validateBriefAuthorship(tx: Tx, definition: CreateRoleInput | ReviseRoleInput) {
  if (!definition.brief) return;
  const sources = new Map(definitionSources(definition).map((source) => [source.id, source]));
  const attributed = [
    ...definition.brief.fields,
    ...definition.brief.rules,
    ...definition.brief.searchFilters,
  ].filter((item) => item.origin === "user_instruction");
  const messageIds = new Set<string>();
  for (const item of attributed) {
    for (const id of item.sourceRefIds) {
      const source = sources.get(id);
      if (!source) throw new IsolationError();
      if (source.anchor.kind !== "message")
        throw new RecruitingPlaybookValidationError(
          "User-instruction facts require human-message sources; keep JD evidence separately attributed.",
        );
      messageIds.add(source.anchor.messageId);
    }
  }
  if (!messageIds.size) return;
  const messages = await tx.message.findMany({
    where: { id: { in: [...messageIds] } },
    include: humanMessageInclude,
  });
  if (
    messages.length !== messageIds.size ||
    messages.some((message) => !isNativeHumanMessage(message))
  )
    throw new IsolationError();
}

function definitionData(input: CreateRoleInput | ReviseRoleInput) {
  return {
    brief: input.brief
      ? ({ ...input.brief, confirmation: null } as Prisma.InputJsonValue)
      : Prisma.DbNull,
    sourceRefs: input.sourceRefs as Prisma.InputJsonValue,
    criteria: input.criteria as Prisma.InputJsonValue,
    preferences: input.preferences as Prisma.InputJsonValue,
    definitionQuestions: input.definitionQuestions as Prisma.InputJsonValue,
  };
}

async function roleSnapshot(
  tx: Tx,
  actor: Actor,
  role: RecruitingRole,
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
): Promise<RoleSnapshot> {
  const row = await tx.recruitingRoleRevision.findFirst({
    where: { id: role.currentRevisionId, roleId: role.id, revision: role.revision },
  });
  if (!row) throw new IsolationError();
  const revision = RecruitingRoleRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  await validateDefinition(tx, actor, revision, authorizedThread);
  if (revision.brief) validateRecruitingBrief(revision.brief, revision);
  const { crmBindingEffectId: _crm, ...publicRole } = role as RecruitingRole & {
    crmBindingEffectId?: string | null;
  };
  return { role: RecruitingRoleSchema.parse(publicRole), revision };
}

export async function createRecruitingRole(
  prisma: PrismaClient,
  actor: Actor,
  untrusted: CreateRoleInput,
  material?: RecruitingRoleMaterialContext,
): Promise<RoleSnapshot> {
  const input = CreateRecruitingRoleInput.parse(untrusted);
  const artifacts = await loadRoleMaterials(prisma, actor, input, material);
  return prisma.$transaction((tx) => createRoleInTransaction(tx, actor, input, artifacts));
}

async function createRoleInTransaction(
  tx: Tx,
  actor: Actor,
  input: CreateRoleInput,
  artifacts: ReadonlyMap<string, Uint8Array>,
) {
  await requireThread(tx, actor, input.sourceThreadId);
  if (input.brief) validateRecruitingBrief(input.brief, input);
  await validateReadSources(tx, actor, definitionSources(input), artifacts);
  await validateBriefAuthorship(tx, input);
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
        ? roleSnapshot(
            tx,
            actor,
            await requireRole(tx, actor, thread.activeRecruitingRoleId, false, thread),
            thread,
          )
        : null;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function reviseRecruitingRole(
  prisma: PrismaClient,
  actor: Actor,
  untrusted: ReviseRoleInput,
  material?: RecruitingRoleMaterialContext,
): Promise<RoleSnapshot> {
  const input = ReviseRecruitingRoleInput.parse(untrusted);
  const artifacts = await loadRoleMaterials(prisma, actor, input, material);
  return prisma.$transaction((tx) => reviseRoleInTransaction(tx, actor, input, artifacts));
}

async function reviseRoleInTransaction(
  tx: Tx,
  actor: Actor,
  input: ReviseRoleInput,
  artifacts: ReadonlyMap<string, Uint8Array>,
) {
  const role = await requireRole(tx, actor, input.roleId, true);
  if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
  if (input.brief) validateRecruitingBrief(input.brief, input);
  await validateReadSources(tx, actor, definitionSources(input), artifacts);
  await validateBriefAuthorship(tx, input);
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

/** Human-only RPC; not exposed as a model tool. CAS, human receipt and revision are atomic. */
export async function confirmRecruitingBrief(
  prisma: PrismaClient,
  actor: Actor,
  raw: unknown,
  material?: RecruitingRoleMaterialContext,
): Promise<RoleSnapshot> {
  const input = ConfirmRecruitingBriefInput.parse(raw);
  const loaded = await getRecruitingWorkspace(prisma, actor, { threadId: input.threadId });
  if (loaded?.role.id !== input.roleId) throw new IsolationError();
  if (loaded.role.revision !== input.expectedRevision) throw new RecruitingConflictError();
  const artifacts = await loadRoleMaterials(prisma, actor, loaded.revision, material);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = ${input.threadId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
    );
    const thread = await requireThread(tx, actor, input.threadId);
    if (thread.activeRecruitingRoleId !== input.roleId) throw new IsolationError();
    const role = await requireRole(tx, actor, input.roleId, true);
    if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
    const workspace = await roleSnapshot(tx, actor, role);
    const { revision } = workspace;
    if (!revision.brief)
      throw new RecruitingPlaybookValidationError(
        "Read the original material and prepare a sourced brief first.",
      );
    validateRecruitingBrief(revision.brief, revision);
    await validateReadSources(tx, actor, definitionSources(revision), artifacts);
    await validateBriefAuthorship(tx, {
      ...revision,
      expectedRevision: role.revision,
      title: role.title,
    });
    if (recruitingBriefClarifications(revision.brief).length)
      throw new RecruitingPlaybookValidationError(
        "Resolve the material brief questions before confirmation.",
      );
    if (
      revision.criteria.some(
        (criterion) => criterion.priority === "hard" && criterion.definitionQuestions.length,
      )
    )
      throw new RecruitingPlaybookValidationError(
        "Resolve the material hard-criterion questions before confirmation.",
      );
    if (revision.brief.confirmation?.revision === role.revision) return workspace;
    const nextRevision = role.revision + 1;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "user",
      blocks: [
        {
          kind: "text",
          text: `Confirm recruiting brief for ${role.title} (requirements version ${role.revision}).`,
        },
      ],
    });
    const brief = {
      ...revision.brief,
      confirmation: {
        revision: nextRevision,
        userId: actor.userId,
        messageId: message.id,
        confirmedAt: new Date().toISOString(),
      },
    };
    const saved = await tx.recruitingRoleRevision.create({
      data: {
        roleId: role.id,
        revision: nextRevision,
        ...definitionData({ ...revision, expectedRevision: role.revision, title: role.title }),
        brief: brief as Prisma.InputJsonValue,
      },
    });
    const changed = await tx.recruitingRole.updateMany({
      where: {
        id: role.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        revision: role.revision,
        currentRevisionId: role.currentRevisionId,
      },
      data: { revision: nextRevision, currentRevisionId: saved.id },
    });
    if (changed.count !== 1) throw new RecruitingConflictError();
    return roleSnapshot(tx, actor, {
      ...role,
      revision: nextRevision,
      currentRevisionId: saved.id,
    });
  });
}

function criterionStatement(expression: RecruitingCriterionExpression): string {
  if (expression.kind === "atom") return expression.statement;
  if (expression.kind === "not") return `NOT (${criterionStatement(expression.item)})`;
  return `(${expression.items.map(criterionStatement).join(expression.kind === "all" ? " AND " : " OR ")})`;
}

/** Human-only edit of existing criteria; native authorship and the role CAS commit together. */
export async function editRecruitingCriteria(
  prisma: PrismaClient,
  actor: Actor,
  raw: unknown,
  material?: RecruitingRoleMaterialContext,
): Promise<RoleSnapshot> {
  const input = EditRecruitingCriteriaInput.parse(raw);
  const loaded = await getRecruitingWorkspace(prisma, actor, { threadId: input.threadId });
  if (loaded?.role.id !== input.roleId) throw new IsolationError();
  if (loaded.role.revision !== input.expectedRevision) throw new RecruitingConflictError();
  const artifacts = await loadRoleMaterials(prisma, actor, loaded.revision, material);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = ${input.threadId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
    );
    const thread = await requireThread(tx, actor, input.threadId);
    if (thread.activeRecruitingRoleId !== input.roleId) throw new IsolationError();
    const role = await requireRole(tx, actor, input.roleId, true);
    if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
    const { revision } = await roleSnapshot(tx, actor, role);
    const changes = input.criteria.flatMap((edit) => {
      const criterion = revision.criteria.find((item) => item.id === edit.criterionId);
      if (!criterion) throw new RecruitingPlaybookValidationError("Unknown criterion.");
      const atoms = new Map(edit.atoms.map((atom) => [atom.atomId, atom]));
      const originalAtoms = new Map<
        string,
        Extract<RecruitingCriterionExpression, { kind: "atom" }>
      >();
      const updatedAtoms = new Map<
        string,
        Extract<RecruitingCriterionExpression, { kind: "atom" }>
      >();
      const update = (expression: RecruitingCriterionExpression): RecruitingCriterionExpression => {
        if (expression.kind === "atom") {
          originalAtoms.set(expression.id, expression);
          const atom = atoms.get(expression.id);
          if (!atom)
            throw new RecruitingPlaybookValidationError("Include every existing criterion atom.");
          let updated = expression;
          if (expression.employmentRule) {
            if (!("employmentRule" in atom))
              throw new RecruitingPlaybookValidationError(
                "Edit the structured employment rule for this atom.",
              );
            if (
              stableJsonValue(expression.employmentRule) !== stableJsonValue(atom.employmentRule)
            ) {
              const rule = atom.employmentRule;
              const cutoff =
                rule.cutoff.kind === "assessment_date"
                  ? "assessment date"
                  : [
                      String(rule.cutoff.date.year).padStart(4, "0"),
                      String(rule.cutoff.date.month).padStart(2, "0"),
                      String(rule.cutoff.date.day).padStart(2, "0"),
                    ].join("-");
              updated = {
                ...expression,
                employmentRule: rule,
                statement: `At least ${rule.minimumMonths} complete calendar months of ${rule.qualificationDefinition}; cutoff: ${cutoff} (UTC).`,
              };
            }
          } else {
            if ("employmentRule" in atom)
              throw new RecruitingPlaybookValidationError("Cannot change an existing atom kind.");
            if (expression.statement !== atom.statement)
              updated = { ...expression, statement: atom.statement };
          }
          updatedAtoms.set(expression.id, updated);
          return updated;
        }
        return expression.kind === "not"
          ? { ...expression, item: update(expression.item) }
          : { ...expression, items: expression.items.map(update) };
      };
      const expression = update(criterion.expression);
      if (originalAtoms.size !== atoms.size)
        throw new RecruitingPlaybookValidationError("Unknown criterion atom.");
      const changedAtoms = edit.atoms.flatMap((atom) => {
        const original = originalAtoms.get(atom.atomId)!;
        const updated = updatedAtoms.get(atom.atomId)!;
        return stableJsonValue(original) === stableJsonValue(updated)
          ? []
          : [`Requirement: ${original.statement} → ${updated.statement}`];
      });
      return criterion.priority === edit.priority && !changedAtoms.length
        ? []
        : [
            {
              criterion: { ...criterion, priority: edit.priority, expression },
              description: [
                ...(criterion.priority !== edit.priority
                  ? [
                      `Priority: ${criterion.priority === "hard" ? "Required" : "Preferred"} → ${edit.priority === "hard" ? "Required" : "Preferred"}`,
                    ]
                  : []),
                ...(changedAtoms.length
                  ? changedAtoms
                  : [`Criterion: ${criterionStatement(expression)}`]),
              ].join("\n"),
            },
          ];
    });
    if (input.searchFilters && !revision.brief)
      throw new RecruitingPlaybookValidationError(
        "Prepare a sourced brief before editing search filters.",
      );
    const originalFilters = revision.brief?.searchFilters;
    const filtersById = new Map(originalFilters?.map((filter) => [filter.id, filter]));
    const changedFilter = (filter: NonNullable<typeof input.searchFilters>[number]) => {
      const original = filtersById.get(filter.id);
      return !original || original.statement !== filter.statement || original.mode !== filter.mode;
    };
    const filtersChanged =
      input.searchFilters !== undefined &&
      (input.searchFilters.length !== originalFilters?.length ||
        input.searchFilters.some(changedFilter));
    if (!changes.length && !filtersChanged) return roleSnapshot(tx, actor, role);
    const changed = new Map(changes.map((change) => [change.criterion.id, change.criterion]));
    const criteria = revision.criteria.map((criterion) => changed.get(criterion.id) ?? criterion);
    // A shared atom ID must still have one definition across all criteria.
    RecruitingRoleRevisionSchema.parse({ ...revision, criteria });
    const text = [
      `Update recruiting requirements for ${role.title} (requirements version ${role.revision} → ${role.revision + 1}):`,
      ...changes.map((change) => change.description),
      ...(filtersChanged
        ? [
            ...input.searchFilters!.filter(changedFilter).map((filter) => {
              const original = filtersById.get(filter.id);
              return original
                ? `Change search filter (${original.mode}): ${original.statement} → (${filter.mode}): ${filter.statement}`
                : `Add search filter (${filter.mode}): ${filter.statement}`;
            }),
            ...originalFilters!
              .filter((filter) => !input.searchFilters!.some((next) => next.id === filter.id))
              .map((filter) => `Remove search filter (${filter.mode}): ${filter.statement}`),
          ]
        : []),
    ].join("\n");
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text }],
    });
    const source: RecruitingSourceRef = {
      id: randomUUID(),
      kind: "recruiter_verified",
      anchor: { kind: "message", messageId: message.id, locator: "blocks[0].text" },
      readState: "read",
      readAt: new Date().toISOString(),
      quote: text,
    };
    return reviseRoleInTransaction(
      tx,
      actor,
      {
        ...revision,
        roleId: role.id,
        expectedRevision: role.revision,
        title: role.title,
        sourceRefs: [...revision.sourceRefs, source],
        criteria: criteria.map((criterion) =>
          changed.has(criterion.id)
            ? { ...criterion, sourceRefs: [...criterion.sourceRefs, source] }
            : criterion,
        ),
        brief: revision.brief
          ? {
              ...revision.brief,
              searchFilters: filtersChanged
                ? input.searchFilters!.map((filter) =>
                    changedFilter(filter)
                      ? {
                          ...filter,
                          origin: "user_instruction" as const,
                          sourceRefIds: [source.id],
                        }
                      : filtersById.get(filter.id)!,
                  )
                : revision.brief.searchFilters,
              rules: revision.brief.rules.map((rule) =>
                changed.has(rule.criterionId)
                  ? {
                      ...rule,
                      origin: "user_instruction",
                      effect:
                        changed.get(rule.criterionId)!.priority === "hard" ? "reject" : "flag",
                      sourceRefIds: [source.id],
                    }
                  : rule,
              ),
            }
          : revision.brief,
      },
      artifacts,
    );
  });
}

export type RecruitingRoleMutationInput = Exclude<RecruitingRoleToolInput, { operation: "read" }>;
export type RecruitingRoleToolResult = {
  status: "current" | "saved" | "needs_clarification";
  workspace: RoleSnapshot | null;
  source: RecruitingSourceRef | null;
  changed: boolean;
};

async function lockLiveRecruitingRun(tx: Tx, actor: Actor, runId: string, requireRunning = true) {
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
  if ((requireRunning && run.status !== "running") || run.threadId !== lockedThreads[0]!.id)
    throw new IsolationError();
  const thread = await requireThread(tx, actor, run.threadId);
  if (!(await runTargetsRecruitingThread(tx, actor, run, thread))) throw new IsolationError();
  return { run, thread };
}

async function runTargetsRecruitingThread(
  tx: Tx,
  actor: Actor,
  run: { botId: string },
  thread: Awaited<ReturnType<typeof requireThread>>,
): Promise<boolean> {
  if (thread.botId && thread.botId !== run.botId) return false;
  if (
    thread.groupId &&
    !(await tx.chatGroupMember.findFirst({ where: { groupId: thread.groupId, botId: run.botId } }))
  )
    return false;
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
    return false;
  return true;
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
  run: Pick<
    Awaited<ReturnType<typeof lockLiveRecruitingRun>>["run"],
    "id" | "botId" | "threadId" | "sourceMessageId" | "trigger"
  >,
  sourceMessageId: string | null,
  quote: string,
  allowOriginalIntent = false,
  ancestors = new Set<string>(),
): Promise<{ source: RecruitingSourceRef; message: SourceMessage }> {
  if (ancestors.has(run.id)) throw new IsolationError();
  ancestors.add(run.id);
  const {
    source: hint,
    steering,
    answers,
  } = await requireRunSource(tx, actor, run, sourceMessageId);
  if (hint.id !== run.sourceMessageId && !isNativeHumanMessage(hint)) throw new IsolationError();
  const latest = answers.reduce(
    (current, answer) => (answer.seq > current.seq ? answer : current),
    hint,
  );
  if (!isNativeHumanMessage(latest)) {
    const { sender } = await requireResearchHandoff(tx, actor, run, latest, true);
    const inherited = await loadRunHumanSources(tx, actor, sender);
    const inheritedLatest = [
      ...inherited.answers,
      ...inherited.steering.map((item) => item.message),
    ]
      .filter(isNativeHumanMessage)
      .reduce<SourceMessage | null>(
        (current, message) => (!current || message.seq > current.seq ? message : current),
        null,
      );
    const human = await requireCurrentHumanSource(
      tx,
      actor,
      sender,
      inheritedLatest?.id ?? sender.sourceMessageId,
      quote,
      allowOriginalIntent,
      ancestors,
    );
    if (human.message.threadId !== latest.threadId || human.message.seq >= latest.seq)
      throw new IsolationError();
    return human;
  }
  const original =
    run.sourceMessageId === latest.id
      ? latest
      : await tx.message.findUnique({
          where: { id: run.sourceMessageId ?? "" },
          include: humanMessageInclude,
        });
  if (allowOriginalIntent && original && answers.some((answer) => answer.seq <= original.seq))
    throw new IsolationError();
  const source =
    allowOriginalIntent &&
    original?.threadId === run.threadId &&
    isNativeHumanMessage(original) &&
    (original.blocks as { kind: string; text?: string }[]).some(
      (block) => block.kind === "text" && block.text?.includes(quote),
    )
      ? original
      : latest;
  if (
    !isNativeHumanMessage(source) ||
    (source.id === run.sourceMessageId &&
      !["user", "follow_up", "reaction"].includes(run.trigger) &&
      !steering.some((item) => item.messageId === source.id) &&
      !answers.some((answer) => answer.id === source.id)) ||
    (original &&
      isNativeHumanMessage(original) &&
      original.threadId === latest.threadId &&
      original.seq > latest.seq) ||
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

function verifiedFeedbackChoice(
  message: SourceMessage,
  roleId: string | undefined,
  revision: number | undefined,
  candidateKeys: readonly string[] | undefined,
) {
  const block = MessageBlockSchema.array()
    .parse(message.blocks)
    .find((item) => item.kind === "text" && item.recruitingFeedback);
  if (block?.kind !== "text" || !block.recruitingFeedback) return undefined;
  const selected = block.recruitingFeedback;
  if (
    selected.roleId !== roleId ||
    selected.expectedRoleRevision !== revision ||
    candidateKeys?.length !== selected.candidateKeys.length ||
    !candidateKeys.every((key) => selected.candidateKeys.includes(key))
  )
    throw new IsolationError();
  return selected.choice;
}

export async function authorizeRecruitingFeedbackMessage(
  tx: Tx,
  actor: Actor,
  threadId: string,
  untrusted: unknown,
) {
  const selected = RecruitingCandidateFeedbackSelectionSchema.parse(untrusted);
  const thread = await requireThread(tx, actor, threadId);
  if (thread.activeRecruitingRoleId !== selected.roleId) throw new IsolationError();
  const role = await requireRole(tx, actor, selected.roleId, true);
  if (
    role.revision !== selected.expectedRoleRevision ||
    role.currentRevisionId !== selected.roleRevisionId
  )
    throw new RecruitingConflictError();
  const candidates = await tx.recruitingCandidate.findMany({
    where: { roleId: role.id, candidateKey: { in: selected.candidateKeys } },
    select: { candidateKey: true },
  });
  if (candidates.length !== selected.candidateKeys.length) throw new IsolationError();
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
    candidateKeys?: readonly string[];
  },
): Promise<{
  source: RecruitingSourceRef;
  workspace: RoleSnapshot | null;
  threadId: string;
  botId: string;
  choice?: "good_example" | "not_fit" | "skip";
}> {
  const intent = RecruitingHumanIntentSchema.parse(input.intent);
  const sourceRefs = RecruitingSourceRefSchema.array().parse(input.sourceRefs);
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, input.runId);
    const { source, message } = await requireCurrentHumanSource(
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
    if (input.candidateKeys) {
      if (
        !workspace ||
        !input.candidateKeys.length ||
        new Set(input.candidateKeys).size !== input.candidateKeys.length
      )
        throw new IsolationError();
      const candidates = await tx.recruitingCandidate.findMany({
        where: { roleId: workspace.role.id, candidateKey: { in: [...input.candidateKeys] } },
        select: { candidateKey: true },
      });
      if (candidates.length !== input.candidateKeys.length) throw new IsolationError();
    }
    let choice: "good_example" | "not_fit" | "skip" | undefined;
    if (intent.basis === "direct") {
      choice = verifiedFeedbackChoice(
        message,
        input.roleId,
        input.expectedRoleRevision,
        input.candidateKeys,
      );
    }
    return {
      source,
      workspace,
      threadId: run.threadId,
      botId: run.botId,
      ...(choice ? { choice } : {}),
    };
  });
}

export async function listRecruitingFeedback(
  prisma: PrismaClient,
  actor: Actor,
  untrusted: { roleId: string; candidateKey?: string; limit?: number; before?: string },
): Promise<{ feedback: RecruitingFeedbackRecord[]; nextCursor: string | null }> {
  const input = ListRecruitingFeedbackInput.parse(untrusted);
  return prisma.$transaction(async (tx) => {
    const role = await requireRole(tx, actor, input.roleId);
    const where: Prisma.ExternalEffectWhereInput = {
      spaceId: actor.spaceId,
      kind: "recruiting_feedback",
      status: "completed",
      run: { userId: actor.userId, spaceId: actor.spaceId },
      AND: [
        { request: { path: ["roleId"], equals: input.roleId } },
        { result: { path: ["status"], equals: "recorded" } },
        ...(input.candidateKey
          ? [{ request: { path: ["candidateKeys"], array_contains: [input.candidateKey] } }]
          : []),
      ],
    };
    const messageWhere: Prisma.MessageWhereInput = {
      role: "user",
      botId: null,
      externalTranscriptFor: null,
      thread: { spaceId: actor.spaceId, userId: actor.userId },
      blocks: {
        array_contains: [
          {
            kind: "text",
            recruitingFeedback: {
              roleId: input.roleId,
              ...(input.candidateKey ? { candidateKeys: [input.candidateKey] } : {}),
            },
          },
        ],
      },
    };
    const before = input.before
      ? ((await tx.message.findFirst({ where: { ...messageWhere, id: input.before } })) ??
        (await tx.externalEffect.findFirst({ where: { ...where, id: input.before } })))
      : null;
    if (input.before && !before) throw new IsolationError();
    const cutoff = before
      ? {
          OR: [
            { createdAt: { lt: before.createdAt } },
            { createdAt: before.createdAt, id: { lt: before.id } },
          ],
        }
      : {};
    const rows = await tx.externalEffect.findMany({
      where: { ...where, ...cutoff },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
    });
    const native = await tx.message.findMany({
      where: { ...messageWhere, ...cutoff },
      include: humanMessageInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
    });
    const feedback: RecruitingFeedbackRecord[] = [];
    for (const message of native) {
      if (!isNativeHumanMessage(message)) throw new IsolationError();
      const blocks = MessageBlockSchema.array().parse(message.blocks);
      const index = blocks.findIndex(
        (item) => item.kind === "text" && item.recruitingFeedback?.roleId === role.id,
      );
      const block = blocks[index];
      if (block?.kind !== "text" || !block.recruitingFeedback) continue;
      const selected = block.recruitingFeedback;
      if (input.candidateKey && !selected.candidateKeys.includes(input.candidateKey))
        throw new IsolationError();
      feedback.push(
        RecruitingFeedbackRecordSchema.parse({
          id: message.id,
          createdAt: message.createdAt.toISOString(),
          roleRevisionId: selected.roleRevisionId,
          choice: selected.choice,
          feedback: {
            target: "candidate",
            operation: "review",
            roleId: role.id,
            expectedRoleRevision: selected.expectedRoleRevision,
            candidateKeys: selected.candidateKeys,
            summary: selected.choice,
            intent: { basis: "direct", quote: block.text },
            sourceRefs: [],
          },
          source: {
            id: `human-message:${message.id}`,
            kind: "original_material",
            anchor: { kind: "message", messageId: message.id, locator: `blocks[${index}].text` },
            quote: block.text,
            readState: "read",
            readAt: message.createdAt.toISOString(),
          },
        }),
      );
    }
    const nativeIds = new Set(feedback.map((record) => record.id));
    for (const row of rows) {
      const result = row.result as {
        feedback?: unknown;
        source?: unknown;
        workspace?: { revision?: { id?: unknown } };
        choice?: unknown;
      } | null;
      const record = RecruitingFeedbackRecordSchema.parse({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        roleRevisionId: result?.workspace?.revision?.id,
        feedback: result?.feedback,
        source: result?.source,
        ...(result?.choice ? { choice: result.choice } : {}),
      });
      if (
        (record.feedback.target !== "candidate" && record.feedback.target !== "round") ||
        record.feedback.roleId !== input.roleId ||
        stableJsonValue(record.feedback) !==
          stableJsonValue(RecruitingFeedbackInputSchema.parse(row.request)) ||
        record.feedback.intent.basis !== "direct" ||
        record.source.quote !== record.feedback.intent.quote ||
        record.source.anchor.kind !== "message"
      )
        throw new IsolationError();
      if (nativeIds.has(record.source.anchor.messageId)) continue;
      feedback.push(record);
    }
    const sourceIds = [
      ...new Set(
        feedback.flatMap((record) =>
          record.source.anchor.kind === "message" && !nativeIds.has(record.source.anchor.messageId)
            ? [record.source.anchor.messageId]
            : [],
        ),
      ),
    ];
    const messages = sourceIds.length
      ? await tx.message.findMany({
          where: {
            id: {
              in: sourceIds,
            },
          },
          include: humanMessageInclude,
        })
      : [];
    const byId = new Map([...native, ...messages].map((message) => [message.id, message]));
    const authorizedThreads = new Set([role.sourceThreadId]);
    for (const record of feedback) {
      const human =
        record.source.anchor.kind === "message"
          ? byId.get(record.source.anchor.messageId)
          : undefined;
      if (!human || !isNativeHumanMessage(human)) throw new IsolationError();
      if (!authorizedThreads.has(human.threadId)) {
        await requireThread(tx, actor, human.threadId);
        authorizedThreads.add(human.threadId);
      }
      if (
        !(human.blocks as { kind: string; text?: string }[]).some(
          (block) => block.kind === "text" && block.text?.includes(record.source.quote!),
        )
      )
        throw new IsolationError();
      if (record.feedback.target !== "candidate" && record.feedback.target !== "round")
        throw new IsolationError();
      if (
        record.choice !==
        verifiedFeedbackChoice(
          human,
          record.feedback.roleId,
          record.feedback.expectedRoleRevision,
          record.feedback.target === "candidate" ? record.feedback.candidateKeys : undefined,
        )
      )
        throw new IsolationError();
    }
    feedback.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    const page = feedback.slice(0, input.limit);
    return ListRecruitingFeedbackOutput.parse({
      feedback: page,
      nextCursor: feedback.length > input.limit ? page.at(-1)!.id : null,
    });
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
    (context.botId !== undefined && context.botId !== run.botId) ||
    (request.scope === "bot" && request.botId !== run.botId)
  )
    throw new IsolationError();
  if (!request.recruiting) {
    const botNote = request.scope === "bot" && request.botId === run.botId;
    const preferenceDocument =
      existing &&
      (await tx.event.findFirst({
        where: {
          spaceId: actor.spaceId,
          type: "memory.revised",
          AND: [
            { payload: { path: ["kind"], equals: "recruiting_preference" } },
            { payload: { path: ["documentId"], equals: existing.id } },
            { payload: { path: ["scope"], equals: request.scope } },
            { payload: { path: ["path"], equals: request.path } },
          ],
        },
        select: { id: true },
      }));
    if ((!thread.activeRecruitingRoleId || botNote) && !preferenceDocument) return;
    throw new IsolationError();
  }
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

/** Runtime-only receipt identity. Direct human API writes keep their own authenticated boundary. */
export type RecruitingRoleMutationContext = {
  runId: string;
  threadId: string;
  botId: string;
  sourceMessageId: string | null;
  leaseOwner: string;
  leaseFence: number;
  effectId: string;
  effectRequest: unknown;
};

export async function executeRecruitingRoleMutation(
  prisma: PrismaClient,
  actor: Actor,
  context: RecruitingRoleMutationContext,
  untrusted: RecruitingRoleMutationInput,
  material?: RecruitingRoleMaterialContext,
): Promise<RecruitingRoleToolResult> {
  const input = RecruitingRoleToolInputSchema.parse(untrusted);
  if (
    input.operation === "read" ||
    stableJsonValue(input) !==
      stableJsonValue(RecruitingRoleToolInputSchema.parse(context.effectRequest))
  )
    throw new IsolationError();
  const artifacts =
    input.operation === "bind"
      ? new Map<string, Uint8Array>()
      : await loadRoleMaterials(prisma, actor, input, material);
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, context.runId, false);
    if (run.threadId !== context.threadId || run.botId !== context.botId)
      throw new IsolationError();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${context.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: context.effectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_role",
      },
    });
    if (!effect || stableJsonValue(effect.request) !== stableJsonValue(context.effectRequest))
      throw new IsolationError();
    if (effect.status === "completed") {
      const saved = effect.result as RecruitingRoleToolResult | null;
      if (
        !saved ||
        !["saved", "needs_clarification"].includes(saved.status) ||
        typeof saved.changed !== "boolean"
      )
        throw new IsolationError();
      const source = RecruitingSourceRefSchema.parse(saved.source);
      if (source.anchor.kind !== "message" || source.quote !== input.intent.quote)
        throw new IsolationError();
      const human = await tx.message.findFirst({
        where: { id: source.anchor.messageId, threadId: run.threadId },
        include: humanMessageInclude,
      });
      if (!human || !isNativeHumanMessage(human)) throw new IsolationError();
      await validateReadSources(tx, actor, [source], artifacts);
      const workspace = saved.workspace
        ? {
            role: RecruitingRoleSchema.parse(saved.workspace.role),
            revision: RecruitingRoleRevisionSchema.parse(saved.workspace.revision),
          }
        : null;
      if (workspace) {
        const role = await requireRole(tx, actor, workspace.role.id);
        const row = await tx.recruitingRoleRevision.findFirst({
          where: {
            id: workspace.revision.id,
            roleId: role.id,
            revision: workspace.revision.revision,
          },
        });
        if (
          !row ||
          workspace.role.spaceId !== role.spaceId ||
          workspace.role.userId !== role.userId ||
          workspace.role.sourceThreadId !== role.sourceThreadId ||
          workspace.role.currentRevisionId !== row.id ||
          workspace.role.revision !== row.revision ||
          // Pre-brief immutable receipts omitted this newly nullable column. Normalize only
          // that legacy absence for comparison; preserve the saved receipt and all other checks.
          stableJsonValue({ ...workspace.revision, brief: workspace.revision.brief ?? null }) !==
            stableJsonValue(
              RecruitingRoleRevisionSchema.parse({
                ...row,
                createdAt: row.createdAt.toISOString(),
              }),
            )
        )
          throw new IsolationError();
        if (saved.status === "saved" && input.operation !== "bind")
          await validateReadSources(tx, actor, definitionSources(workspace.revision), artifacts);
        else await validateDefinition(tx, actor, workspace.revision);
      }
      if (
        saved.status === "saved" &&
        (input.operation === "bind"
          ? (workspace?.role.id ?? null) !== input.roleId
          : !workspace ||
            (input.operation === "create"
              ? workspace.role.revision !== 1 || workspace.role.sourceThreadId !== thread.id
              : workspace.role.id !== input.roleId ||
                workspace.role.revision !== input.expectedRevision + 1))
      )
        throw new IsolationError();
      return { status: saved.status, workspace, source, changed: saved.changed };
    }
    requireResearchLease(run, context);
    if (effect.status !== "executing") throw new IsolationError();
    const { source: humanSource, message: source } = await requireCurrentHumanSource(
      tx,
      actor,
      run,
      context.sourceMessageId,
      input.intent.quote,
      input.operation === "create",
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
    let result: RecruitingRoleToolResult;
    if (input.intent.basis === "inferred")
      result = {
        status: "needs_clarification",
        workspace: current,
        source: humanSource,
        changed: false,
      };
    else {
      let workspace: RoleSnapshot | null;
      if (input.operation === "bind") {
        workspace = await bindRoleInTransaction(tx, actor, {
          threadId: run.threadId,
          roleId: input.roleId,
        });
      } else {
        const definition = {
          title: input.title,
          brief: input.brief,
          sourceRefs: [...input.sourceRefs.filter((ref) => ref.id !== humanSource.id), humanSource],
          criteria: input.criteria,
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
                artifacts,
              )
            : await reviseRoleInTransaction(
                tx,
                actor,
                ReviseRecruitingRoleInput.parse({
                  ...definition,
                  roleId: input.roleId,
                  expectedRevision: input.expectedRevision,
                }),
                artifacts,
              );
      }
      result = {
        status: "saved",
        workspace,
        source: humanSource,
        changed:
          input.operation !== "bind" || current?.role.id !== (workspace?.role.id ?? undefined),
      };
    }
    const completed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        spaceId: actor.spaceId,
        runId: run.id,
        status: "executing",
        run: {
          status: "running",
          leaseOwner: context.leaseOwner,
          leaseFence: context.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
      },
      data: { status: "completed", result: result as unknown as Prisma.InputJsonValue },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: {
        effectId: effect.id,
        tool: "recruiting_role",
        operation: input.operation,
        status: result.status,
        changed: result.changed,
        roleId: result.workspace?.role.id ?? null,
        roleRevisionId: result.workspace?.revision.id ?? null,
      },
    });
    return result;
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
  const revision = await tx.recruitingRoleRevision.findFirst({
    where: { id: row.roleRevisionId, roleId: role.id },
  });
  if (!revision) throw new IsolationError();
  const roleRevision = RecruitingRoleRevisionSchema.parse({
    ...revision,
    createdAt: revision.createdAt.toISOString(),
  });
  await requireRun(tx, actor, row.createdByRunId);
  const sourceMessageTargets = await validateDefinition(tx, actor, {
    sourceRefs: [...assessment.sourceRefs, ...roleRevision.sourceRefs],
    criteria: roleRevision.criteria,
  });
  return {
    assessment,
    roleRevision,
    sourceMessageTargets,
    isCurrent: role.currentRevisionId === assessment.roleRevisionId,
  };
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

/** Native runtime identity, adopted context and effect receipt; never model tool arguments. */
export type RecruitingAssessmentSaveContext = {
  runId: string;
  threadId: string;
  botId: string;
  leaseOwner: string;
  leaseFence: number;
  contextArtifact?: RecruitingArtifactRef;
  effectId: string;
  effectRequest: unknown;
};
export type RecruitingAssessmentArtifactBytes = { artifactId: string; bytes: Uint8Array };
export type RecruitingQuestionPauseContext = {
  actor: Actor;
  effectId: string;
  effectRequest: unknown;
  contextArtifact?: RecruitingArtifactRef;
  artifacts: readonly RecruitingAssessmentArtifactBytes[];
};
type PreparedRecruitingQuestion =
  | { kind: "completed"; eventSeq: number }
  | { kind: "new"; request: RecruitingAssessmentAskInput; effectId: string; askIndex: number };

function questionCard(blocks: unknown, askIndex: number) {
  const parsed = MessageBlockSchema.array().parse(blocks);
  const block = parsed[askIndex];
  if (
    parsed.length !== 1 ||
    block?.kind !== "ask" ||
    block.approvalEffectId ||
    block.credential ||
    block.input === "secret" ||
    !block.actions ||
    new Set(block.actions.map((action) => action.id)).size !== block.actions.length
  )
    throw new IsolationError();
  return block;
}

async function currentQuestionTargets(
  tx: Tx,
  actor: Actor,
  role: RecruitingRole,
  requests: readonly RecruitingAssessmentAskInput[],
) {
  const current = new Set<RecruitingAssessmentAskInput>();
  const matching = requests.filter((request) => role.currentRevisionId === request.roleRevisionId);
  if (!matching.length) return current;
  const definition = (await roleSnapshot(tx, actor, role)).revision;
  const candidates = matching.flatMap((request) =>
    request.target.kind === "candidate" ? [request.target.candidateKey] : [],
  );
  const rows = candidates.length
    ? await tx.recruitingAssessment.findMany({
        where: { roleId: role.id, candidateKey: { in: [...new Set(candidates)] } },
        distinct: ["candidateKey"],
        orderBy: [{ candidateKey: "asc" }, { version: "desc" }],
      })
    : [];
  const byCandidate = new Map(rows.map((row) => [row.candidateKey, row]));
  const verified = new Set<string>();
  const origins = new Set<string>();
  const sources: RecruitingAssessmentSourceRef[] = [];
  for (const request of matching) {
    const ids = request.target.criterionIds;
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !definition.criteria.some((criterion) => criterion.id === id))
    )
      throw new IsolationError();
    if (request.target.kind === "candidate") {
      const row = byCandidate.get(request.target.candidateKey);
      if (
        !row ||
        row.version !== request.target.assessmentVersion ||
        row.roleRevisionId !== request.roleRevisionId
      )
        continue;
      if (!verified.has(row.candidateKey)) {
        const assessment = RecruitingAssessmentSchema.parse({
          ...row,
          createdAt: row.createdAt.toISOString(),
        });
        if (!origins.has(row.createdByRunId)) {
          await requireRun(tx, actor, row.createdByRunId);
          origins.add(row.createdByRunId);
        }
        sources.push(...assessment.sourceRefs);
        verified.add(row.candidateKey);
      }
    }
    current.add(request);
  }
  // The shared current revision and its sources were authorized above; check assessment sources once.
  await validateSources(tx, actor, sources);
  return current;
}

async function questionTargetCurrent(
  tx: Tx,
  actor: Actor,
  role: RecruitingRole,
  request: RecruitingAssessmentAskInput,
) {
  return (await currentQuestionTargets(tx, actor, role, [request])).has(request);
}

async function questionsInTransaction(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; roleId: string; effectId?: string; candidateKey?: string },
): Promise<RecruitingQuestion[]> {
  const thread = await requireThread(tx, actor, input.threadId);
  const role = await requireRole(tx, actor, input.roleId);
  const events = await tx.event.findMany({
    where: {
      spaceId: actor.spaceId,
      threadId: thread.id,
      type: "recruiting.question.asked",
      AND: [
        { payload: { path: ["roleId"], equals: role.id } },
        ...(input.effectId !== undefined
          ? [{ payload: { path: ["effectId"], equals: input.effectId } }]
          : []),
      ],
    },
    orderBy: { seq: "asc" },
  });
  const asked = events.flatMap((event) => {
    const receipt = RecruitingQuestionAskedPayloadSchema.parse(event.payload);
    if (
      !event.runId ||
      (input.candidateKey &&
        receipt.target.kind === "candidate" &&
        receipt.target.candidateKey !== input.candidateKey)
    )
      return [];
    return [{ event, receipt }];
  });
  if (!asked.length) return [];
  // ponytail: batch native proof rows inside this snapshot; never retain authorization across reads.
  const runIds = [...new Set(asked.map(({ event }) => event.runId!))];
  const runs = await tx.run.findMany({
    where: { id: { in: runIds }, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      threadId: true,
      botId: true,
      status: true,
      bot: { select: { spaceId: true, userId: true } },
    },
  });
  const byRun = new Map(runs.map((run) => [run.id, run]));
  for (const id of runIds) {
    const run = scoped(actor, byRun.get(id) ?? null);
    scoped(actor, run.bot);
    if (run.threadId !== thread.id) throw new IsolationError();
  }
  const botIds = [...new Set(runs.map((run) => run.botId))];
  const effects = await tx.externalEffect.findMany({
    where: {
      id: { in: asked.map(({ receipt }) => receipt.effectId) },
      spaceId: actor.spaceId,
      runId: { in: runIds },
      kind: "recruiting_assess",
      status: "completed",
    },
  });
  const byEffect = new Map(effects.map((effect) => [effect.id, effect]));
  const proofRows = await tx.event.findMany({
    where: {
      spaceId: actor.spaceId,
      threadId: thread.id,
      runId: { in: runIds },
      botId: { in: botIds },
      OR: [
        { type: { in: ["thread.choice", "run.waiting_input", "computer.takeover.requested"] } },
        {
          type: "thread.message.created",
          OR: asked.map(({ receipt }) => ({
            payload: { path: ["messageId"], equals: receipt.messageId },
          })),
        },
      ],
    },
    orderBy: { seq: "asc" },
  });
  const created = new Map<string, (typeof proofRows)[number]>();
  const choices = new Map<string, (typeof proofRows)[number]>();
  const receiptsByRun = new Map<string, typeof proofRows>();
  const messageIds = new Set(asked.map(({ receipt }) => receipt.messageId));
  const messageIdsByRun = new Map(runIds.map((id) => [id, new Set<string>()]));
  for (const event of proofRows) {
    const run = byRun.get(event.runId!);
    if (!run || event.botId !== run.botId) continue;
    const payload = event.payload as { messageId?: string; askIndex?: number } | null;
    if (event.type === "thread.message.created") {
      if (typeof payload?.messageId === "string") {
        const key = stableJsonValue([run.id, payload.messageId]);
        if (!created.has(key)) created.set(key, event);
      }
      continue;
    }
    const receipts = receiptsByRun.get(run.id) ?? [];
    receipts.push(event);
    receiptsByRun.set(run.id, receipts);
    if (event.type === "thread.choice") {
      if (typeof payload?.messageId === "string" && typeof payload.askIndex === "number") {
        const key = stableJsonValue([run.id, payload.messageId, payload.askIndex]);
        if (!choices.has(key)) choices.set(key, event);
      }
      const parsed = NativeAskAnswerPayloadSchema.safeParse(payload);
      if (parsed.success) {
        messageIds.add(parsed.data.messageId);
        messageIds.add(parsed.data.answerMessageId);
        messageIdsByRun.get(run.id)!.add(parsed.data.messageId).add(parsed.data.answerMessageId);
      }
    }
  }
  const messages = await tx.message.findMany({
    where: { threadId: thread.id, id: { in: [...messageIds] } },
    include: humanMessageInclude,
  });
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  const answersByRun = new Map<string, Set<string>>();
  const questions = asked.map(({ event, receipt }) => {
    const run = byRun.get(event.runId!)!;
    const effect = byEffect.get(receipt.effectId);
    if (
      !effect ||
      effect.runId !== run.id ||
      stableJsonValue(effect.result) !== stableJsonValue(receipt)
    )
      throw new IsolationError();
    const request = RecruitingAssessmentAskInputSchema.parse(effect.request);
    if (
      event.botId !== run.botId ||
      receipt.roleId !== role.id ||
      receipt.roleRevisionId !== request.roleRevisionId ||
      request.roleId !== role.id ||
      stableJsonValue(request.target) !== stableJsonValue(receipt.target)
    )
      throw new IsolationError();
    const message = byMessage.get(receipt.messageId);
    if (
      !message ||
      message.runId !== run.id ||
      message.botId !== run.botId ||
      message.role !== "bot" ||
      message.clientNonce !== `recruiting-question:${effect.id}`
    )
      throw new IsolationError();
    const block = questionCard(message.blocks, receipt.askIndex);
    const originalEvent = created.get(stableJsonValue([run.id, message.id]));
    const original = originalEvent
      ? questionCard((originalEvent.payload as { blocks?: unknown }).blocks, receipt.askIndex)
      : null;
    const { status: _status, answer: _answer, ...display } = block;
    const { status: _originalStatus, answer: _originalAnswer, ...originalDisplay } = original ?? {};
    if (
      !original ||
      original.status === "answered" ||
      stableJsonValue(display) !== stableJsonValue(originalDisplay)
    )
      throw new IsolationError();
    const proof = choices.get(stableJsonValue([run.id, message.id, receipt.askIndex]));
    if (block.status === "answered") {
      const parsed = NativeAskAnswerPayloadSchema.safeParse(proof?.payload);
      if (!parsed.success || parsed.data.answeredByUserId !== actor.userId)
        throw new IsolationError();
      let answers = answersByRun.get(run.id);
      if (!answers) {
        const human = validateRunHumanSourceRows(
          actor,
          run,
          receiptsByRun.get(run.id) ?? [],
          [...messageIdsByRun.get(run.id)!].flatMap((id) => {
            const message = byMessage.get(id);
            return message ? [message] : [];
          }),
        );
        answers = new Set(human.answers.map((answer) => answer.id));
        answersByRun.set(run.id, answers);
      }
      if (!answers.has(parsed.data.answerMessageId)) throw new IsolationError();
    } else if (proof) throw new IsolationError();
    return { receipt, run, request, block };
  });
  const current =
    thread.activeRecruitingRoleId === role.id
      ? await currentQuestionTargets(
          tx,
          actor,
          role,
          questions.map(({ request }) => request),
        )
      : new Set<RecruitingAssessmentAskInput>();
  const pendingBotIds = [
    ...new Set(
      questions
        .filter(
          ({ request, run, block }) =>
            current.has(request) && run.status === "waiting_input" && block.status !== "answered",
        )
        .map(({ run }) => run.botId),
    ),
  ];
  const members =
    thread.groupId && pendingBotIds.length
      ? await tx.chatGroupMember.findMany({
          where: { groupId: thread.groupId, botId: { in: pendingBotIds } },
          select: { botId: true },
        })
      : [];
  const conversations =
    thread.externalConversationId && pendingBotIds.length
      ? await tx.externalConversation.findMany({
          where: {
            id: thread.externalConversationId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: { in: pendingBotIds },
          },
          select: { botId: true },
        })
      : [];
  const memberBots = new Set(members.map((member) => member.botId));
  const conversationBots = new Set(conversations.map((conversation) => conversation.botId));
  return questions.map(({ receipt, run, request, block }) =>
    RecruitingQuestionSchema.parse({
      ...receipt,
      threadId: thread.id,
      botId: run.botId,
      groupId: thread.groupId,
      runId: run.id,
      block,
      runStatus: run.status,
      isCurrent: current.has(request),
      canAnswer:
        current.has(request) &&
        run.status === "waiting_input" &&
        block.status !== "answered" &&
        (!thread.botId || thread.botId === run.botId) &&
        (!thread.groupId || memberBots.has(run.botId)) &&
        (!thread.externalConversationId || conversationBots.has(run.botId)),
    }),
  );
}

async function questionInTransaction(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; roleId: string; effectId: string },
): Promise<RecruitingQuestion | null> {
  return (await questionsInTransaction(tx, actor, input))[0] ?? null;
}

export async function getRecruitingQuestion(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; roleId: string; effectId: string },
): Promise<RecruitingQuestion | null> {
  return prisma.$transaction((tx) => questionInTransaction(tx, actor, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

export async function listRecruitingQuestions(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; roleId: string; candidateKey?: string },
): Promise<RecruitingQuestion[]> {
  return prisma.$transaction((tx) => questionsInTransaction(tx, actor, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

/** Runs before the native pause clears its lease; completed receipts never create another card. */
export async function prepareRecruitingQuestionInTransaction(
  tx: Tx,
  input: PauseRunForInput,
): Promise<PreparedRecruitingQuestion> {
  const trusted = input.recruitingQuestion;
  if (!trusted || trusted.actor.spaceId !== input.spaceId) throw new IsolationError();
  const actor = trusted.actor;
  const request = RecruitingAssessmentAskInputSchema.parse(trusted.effectRequest);
  const { run, thread } = await lockLiveRecruitingRun(tx, actor, input.runId, false);
  if (run.threadId !== input.threadId || run.botId !== input.botId) throw new IsolationError();
  const role = await requireRole(tx, actor, request.roleId, true);
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${trusted.effectId} FOR UPDATE`,
  );
  const effect = await tx.externalEffect.findFirst({
    where: {
      id: trusted.effectId,
      spaceId: actor.spaceId,
      runId: run.id,
      kind: "recruiting_assess",
    },
  });
  if (!effect || stableJsonValue(effect.request) !== stableJsonValue(trusted.effectRequest))
    throw new IsolationError();
  if (effect.status === "completed") {
    const question = await questionInTransaction(tx, actor, {
      threadId: thread.id,
      roleId: role.id,
      effectId: effect.id,
    });
    if (!question) throw new IsolationError();
    const event = await tx.event.findFirstOrThrow({
      where: {
        spaceId: actor.spaceId,
        threadId: thread.id,
        type: "recruiting.question.asked",
        payload: { path: ["effectId"], equals: effect.id },
      },
    });
    return { kind: "completed", eventSeq: event.seq };
  }
  requireResearchLease(run, input);
  if (
    effect.status !== "executing" ||
    thread.activeRecruitingRoleId !== role.id ||
    !(await questionTargetCurrent(tx, actor, role, request))
  )
    throw new RecruitingConflictError();
  const context = {
    ...input,
    contextArtifact: trusted.contextArtifact,
    effectId: effect.id,
    effectRequest: effect.request,
  };
  await requireAssessmentAdoption(
    tx,
    actor,
    context,
    role,
    new Map(trusted.artifacts.map(({ artifactId, bytes }) => [artifactId, bytes])),
  );
  const card = questionCard(input.blocks, 0);
  if (
    card.status === "answered" ||
    card.actions!.length !== request.options.length ||
    stableJsonValue(input.offeredActions?.map((action) => action.label)) !==
      stableJsonValue(request.options) ||
    stableJsonValue(input.offeredActions?.map((action) => action.id)) !==
      stableJsonValue(card.actions!.map((action) => action.id))
  )
    throw new IsolationError();
  return { kind: "new", request, effectId: effect.id, askIndex: 0 };
}

export async function commitRecruitingQuestionInTransaction(
  tx: Tx,
  input: PauseRunForInput,
  prepared: Extract<PreparedRecruitingQuestion, { kind: "new" }>,
  message: { id: string },
) {
  const payload = {
    roleId: prepared.request.roleId,
    roleRevisionId: prepared.request.roleRevisionId,
    target: prepared.request.target,
    effectId: prepared.effectId,
    messageId: message.id,
    askIndex: prepared.askIndex,
  };
  const completed = await tx.externalEffect.updateMany({
    where: {
      id: prepared.effectId,
      runId: input.runId,
      spaceId: input.spaceId,
      status: "executing",
    },
    data: { status: "completed", result: payload },
  });
  if (completed.count !== 1) throw new IsolationError();
  return appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    runId: input.runId,
    type: "recruiting.question.asked",
    payload,
  });
}

/** One guard protects both card clicks and native composer answers. */
export async function authorizeRecruitingQuestionAnswerInTransaction(
  tx: Tx,
  input: AnswerRunInput,
  message: { clientNonce: string | null },
  askIndex: number,
): Promise<boolean> {
  if (!message.clientNonce?.startsWith("recruiting-question:")) return true;
  const actor: Actor = {
    spaceId: input.spaceId,
    userId: input.answeredByUserId,
    email: "",
    isDeploymentOwner: false,
  };
  try {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, input.runId, false);
    if (run.status !== "waiting_input" || run.threadId !== input.threadId) return false;
    const effectId = message.clientNonce.slice("recruiting-question:".length);
    const event = await tx.event.findFirst({
      where: {
        spaceId: actor.spaceId,
        threadId: thread.id,
        runId: run.id,
        type: "recruiting.question.asked",
        payload: { path: ["effectId"], equals: effectId },
      },
    });
    if (!event) return false;
    const receipt = RecruitingQuestionAskedPayloadSchema.parse(event.payload);
    if (
      thread.activeRecruitingRoleId !== receipt.roleId ||
      receipt.messageId !== input.messageId ||
      receipt.askIndex !== askIndex
    )
      return false;
    await requireRole(tx, actor, receipt.roleId, true);
    const question = await questionInTransaction(tx, actor, {
      threadId: thread.id,
      roleId: receipt.roleId,
      effectId,
    });
    return question?.canAnswer === true;
  } catch (error) {
    if (
      error instanceof IsolationError ||
      error instanceof RecruitingConflictError ||
      (error instanceof Error && error.name === "ZodError")
    )
      return false;
    throw error;
  }
}

function assessmentSelection(text: string, start: number, end: number, quote: string) {
  try {
    validateRecruitingTextSelection(text, start, end, quote);
  } catch {
    throw new IsolationError();
  }
}

function assessmentJsonString(bytes: Uint8Array, path: readonly (string | number)[]): string {
  try {
    return readRecruitingJsonString(bytes, path);
  } catch {
    throw new IsolationError();
  }
}

async function validateReadSources(
  tx: Tx,
  actor: Actor,
  sources: readonly (RecruitingAssessmentSourceRef | RecruitingSourceRef)[],
  artifacts: ReadonlyMap<string, Uint8Array>,
) {
  await validateSources(tx, actor, sources);
  // ponytail: reuse native reads only within this validation call; every reference is checked below.
  const messages = new Map<string, SourceMessage>();
  const rows = new Map<string, Prisma.ArtifactGetPayload<Record<string, never>>>();
  const pdfTexts = new Map<string, string>();
  const provenance = new Map<
    string,
    {
      providerArtifact: boolean;
      readReceipt: Prisma.EventGetPayload<Record<string, never>> | null;
      payload?: RecruitingMaterialReadPayload;
    }
  >();
  const unique = new Map(sources.map((source) => [stableJsonValue(source), source]));
  for (const source of unique.values()) {
    // A role reference without a quote remains a locator; it does not attest to material text.
    if (source.readState === "read" && source.quote === undefined) continue;
    const selection = "selection" in source ? source.selection : undefined;
    if (source.anchor.kind === "message") {
      let message = messages.get(source.anchor.messageId);
      if (!message) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "messages" WHERE "id" = ${source.anchor.messageId} FOR SHARE`,
        );
        const current = await tx.message.findUnique({
          where: { id: source.anchor.messageId },
          include: humanMessageInclude,
        });
        if (!current) throw new IsolationError();
        message = current;
        messages.set(message.id, message);
      }
      if (source.readState !== "read" || source.quote === undefined) continue;
      if (!isNativeHumanMessage(message) || source.kind === "provider_report")
        throw new IsolationError();
      const blocks = MessageBlockSchema.array().parse(message.blocks);
      const locator = /^blocks\[(0|[1-9]\d*)\]\.text$/.exec(source.anchor.locator);
      const blockIndex =
        selection?.kind === "message_text"
          ? selection.blockIndex
          : locator
            ? Number(locator[1])
            : -1;
      const block = blocks[blockIndex];
      if (block?.kind !== "text" || (selection && selection.kind !== "message_text"))
        throw new IsolationError();
      const start = selection?.start ?? block.text.indexOf(source.quote);
      if (start < 0) throw new RecruitingSourceValidationError(source.id, source.anchor.locator);
      assessmentSelection(
        block.text,
        start,
        selection?.end ?? start + source.quote.length,
        source.quote,
      );
    } else {
      let artifact = rows.get(source.anchor.artifact.artifactId);
      if (!artifact) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "artifacts" WHERE "id" = ${source.anchor.artifact.artifactId} FOR SHARE`,
        );
        artifact = await tx.artifact.findUniqueOrThrow({
          where: { id: source.anchor.artifact.artifactId },
        });
        rows.set(artifact.id, artifact);
      }
      if (artifact.hash !== source.anchor.artifact.sha256) throw new IsolationError();
      if (source.readState !== "read" || source.quote === undefined) continue;
      let proof = provenance.get(artifact.id);
      if (!proof) {
        let providerArtifact = await tx.recruitingResearchAction.findFirst({
          where: {
            OR: [
              { receiptArtifactId: artifact.id, receiptArtifactHash: artifact.hash },
              {
                outputArtifacts: {
                  array_contains: [{ artifactId: artifact.id, sha256: artifact.hash }],
                },
              },
            ],
          },
          select: { id: true },
        });
        if (!providerArtifact && artifact.clientNonce?.startsWith("recruiting-observation:")) {
          const page = await tx.recruitingCandidatePage.findUnique({
            where: { effectId: artifact.clientNonce.slice("recruiting-observation:".length) },
          });
          if (page?.taskId === null && page.actionId === null) {
            const source = await candidatePageArtifact(tx, actor, page);
            if (source.id !== artifact.id || source.hash !== artifact.hash)
              throw new IsolationError();
            providerArtifact = { id: page.effectId };
          }
        }
        const readReceipt = artifact.runId
          ? await tx.event.findFirst({
              where: {
                spaceId: actor.spaceId,
                runId: artifact.runId,
                botId: artifact.botId ?? undefined,
                type: "recruiting.material.read",
                AND: [
                  { payload: { path: ["reader"], equals: "web_fetch" } },
                  { payload: { path: ["artifact", "artifactId"], equals: artifact.id } },
                  { payload: { path: ["artifact", "sha256"], equals: artifact.hash } },
                ],
              },
            })
          : null;
        proof = { providerArtifact: !!providerArtifact, readReceipt };
        provenance.set(artifact.id, proof);
      }
      if (
        (proof.providerArtifact && source.kind !== "provider_report") ||
        (!proof.providerArtifact && proof.readReceipt && source.kind !== "original_material") ||
        (!proof.providerArtifact &&
          (source.kind === "provider_report" || (artifact.runId !== null && !proof.readReceipt)))
      )
        throw new IsolationError();
      if (proof.readReceipt) {
        if (!proof.payload) {
          const origin = await requireRun(tx, actor, artifact.runId!);
          const receipt = ProductEventSchema.parse({
            ...proof.readReceipt,
            createdAt: proof.readReceipt.createdAt.toISOString(),
          });
          const payload = RecruitingMaterialReadPayloadSchema.parse(receipt.payload);
          if (origin.threadId !== receipt.threadId || origin.botId !== artifact.botId)
            throw new IsolationError();
          proof.payload = payload;
        }
        if (source.url !== proof.payload.url || source.readAt !== proof.payload.readAt)
          throw new IsolationError();
      }
      const bytes = artifacts.get(artifact.id);
      if (
        !bytes ||
        bytes.byteLength !== artifact.size ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.hash
      )
        throw new IsolationError();
      // ponytail: role references attest only extracted text; other fields need typed selections.
      if (selection?.kind === "message_text" || (!selection && source.anchor.locator !== "text"))
        throw new IsolationError();
      const json = artifact.mimeType === "application/json" || artifact.mimeType.endsWith("+json");
      const pdf = artifact.mimeType === "application/pdf";
      const jsonPath =
        selection?.kind === "artifact_json_string"
          ? selection.path
          : !selection && json
            ? ["text"]
            : undefined;
      if (jsonPath ? !json : (!artifact.mimeType.startsWith("text/") && !pdf) || json)
        throw new IsolationError();
      if (pdf && !pdfTexts.has(artifact.hash)) {
        try {
          pdfTexts.set(artifact.hash, await extractPdfText(bytes));
        } catch {
          throw new IsolationError();
        }
      }
      const text = jsonPath
        ? assessmentJsonString(bytes, jsonPath)
        : pdf
          ? pdfTexts.get(artifact.hash)!
          : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const start = selection?.start ?? text.indexOf(source.quote);
      if (start < 0) throw new RecruitingSourceValidationError(source.id, source.anchor.locator);
      assessmentSelection(text, start, selection?.end ?? start + source.quote.length, source.quote);
    }
  }
}

async function requireAssessmentAdoption(
  tx: Tx,
  actor: Actor,
  context: RecruitingAssessmentSaveContext,
  role: RecruitingRole,
  artifacts: ReadonlyMap<string, Uint8Array>,
) {
  if (!context.contextArtifact) throw new IsolationError();
  const event = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: context.threadId,
      botId: context.botId,
      runId: context.runId,
      type: "recruiting.context.adopted",
    },
    orderBy: { seq: "desc" },
  });
  if (!event) throw new IsolationError();
  const payload = event.payload as {
    roleId?: string;
    roleRevisionId?: string;
    contextArtifact?: RecruitingArtifactRef;
  };
  if (
    payload.roleId !== role.id ||
    payload.roleRevisionId !== role.currentRevisionId ||
    payload.contextArtifact?.artifactId !== context.contextArtifact.artifactId ||
    payload.contextArtifact?.sha256 !== context.contextArtifact.sha256
  )
    throw new RecruitingConflictError();
  await validateArtifact(tx, actor, context.contextArtifact);
  const artifact = await tx.artifact.findUniqueOrThrow({
    where: { id: context.contextArtifact.artifactId },
  });
  const bytes = artifacts.get(artifact.id);
  if (
    artifact.runId !== context.runId ||
    artifact.botId !== context.botId ||
    !bytes ||
    bytes.byteLength !== artifact.size ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.hash
  )
    throw new IsolationError();
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    manifest.version !== 1 ||
    manifest.actor?.spaceId !== actor.spaceId ||
    manifest.actor?.userId !== actor.userId ||
    manifest.runId !== context.runId ||
    manifest.threadId !== context.threadId ||
    manifest.botId !== context.botId ||
    manifest.roleId !== role.id ||
    manifest.roleRevisionId !== role.currentRevisionId ||
    manifest.roleRevision !== role.revision
  )
    throw new IsolationError();
}

/** The immutable snapshot and native effect completion commit together. */
export async function saveRecruitingAssessment(
  prisma: PrismaClient,
  actor: Actor,
  context: RecruitingAssessmentSaveContext,
  untrusted: SaveAssessmentInput,
  trustedArtifacts: readonly RecruitingAssessmentArtifactBytes[],
): Promise<RecruitingAssessmentSnapshot> {
  const request = context.effectRequest as { operation?: unknown } & Record<string, unknown>;
  if (request?.operation !== "save" && request?.operation !== "reassess")
    throw new IsolationError();
  const schema =
    request.operation === "reassess"
      ? ReassessRecruitingAssessmentInput
      : SaveRecruitingAssessmentInput;
  const input = schema.parse(untrusted);
  const { operation: _operation, ...requestInput } = request;
  if (stableJsonValue(schema.parse(requestInput)) !== stableJsonValue(input))
    throw new IsolationError();
  const artifacts = new Map(trustedArtifacts.map(({ artifactId, bytes }) => [artifactId, bytes]));
  if (artifacts.size !== trustedArtifacts.length) throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, context.runId, false);
    if (run.threadId !== context.threadId || run.botId !== context.botId)
      throw new IsolationError();
    // ponytail: one role row lock serializes candidate writes; split by candidate only if contention appears.
    const role = await requireRole(tx, actor, input.roleId, true);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${context.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: context.effectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_assess",
      },
    });
    if (!effect || stableJsonValue(effect.request) !== stableJsonValue(context.effectRequest))
      throw new IsolationError();
    if (effect.status === "completed") {
      const saved = effect.result as { assessment?: unknown; isCurrent?: unknown } | null;
      const assessment = RecruitingAssessmentSchema.parse(saved?.assessment);
      if (
        assessment.roleId !== role.id ||
        assessment.roleRevisionId !== input.roleRevisionId ||
        assessment.candidateKey !== input.candidateKey ||
        assessment.version !== input.expectedRevision + 1 ||
        assessment.createdByRunId !== run.id
      )
        throw new IsolationError();
      const row = await tx.recruitingAssessment.findUnique({
        where: {
          roleId_candidateKey_version: {
            roleId: role.id,
            candidateKey: assessment.candidateKey,
            version: assessment.version,
          },
        },
      });
      if (!row) throw new IsolationError();
      const snapshot = await assessmentSnapshot(tx, actor, role, row);
      if (stableJsonValue(snapshot.assessment) !== stableJsonValue(assessment))
        throw new IsolationError();
      await validateReadSources(tx, actor, assessment.sourceRefs, artifacts);
      return snapshot;
    }
    requireResearchLease(run, context);
    if (effect.status !== "executing" || thread.activeRecruitingRoleId !== role.id)
      throw new IsolationError();
    const revision = await tx.recruitingRoleRevision.findFirst({
      where: { id: input.roleRevisionId, roleId: role.id },
    });
    if (!revision) throw new IsolationError();
    if (role.currentRevisionId !== input.roleRevisionId) throw new RecruitingConflictError();
    const definition = RecruitingRoleRevisionSchema.parse({
      ...revision,
      createdAt: revision.createdAt.toISOString(),
    });
    await validateDefinition(tx, actor, definition);
    await requireAssessmentAdoption(tx, actor, context, role, artifacts);
    const last = await tx.recruitingAssessment.findFirst({
      where: { roleId: role.id, candidateKey: input.candidateKey },
      orderBy: { version: "desc" },
    });
    if ((last?.version ?? 0) !== input.expectedRevision) throw new RecruitingConflictError();
    if (request.operation === "reassess" && !last) throw new RecruitingConflictError();
    const content =
      request.operation === "reassess"
        ? mergeRecruitingReassessment(
            definition,
            (await assessmentSnapshot(tx, actor, role, last!)).assessment,
            input,
          )
        : input;
    await validateReadSources(tx, actor, content.sourceRefs, artifacts);
    const now = new Date();
    const judgments = evaluateRecruitingAssessment(definition, content, {
      precision: "day",
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
    });
    const row = await tx.recruitingAssessment.create({
      data: {
        roleId: role.id,
        candidateKey: input.candidateKey,
        roleRevisionId: input.roleRevisionId,
        version: input.expectedRevision + 1,
        basedOnVersion: input.expectedRevision || null,
        facts: content.facts as Prisma.InputJsonValue,
        judgments: judgments as Prisma.InputJsonValue,
        questions: content.questions as Prisma.InputJsonValue,
        sourceRefs: content.sourceRefs as Prisma.InputJsonValue,
        createdByRunId: run.id,
      },
    });
    await tx.recruitingCandidate.upsert({
      where: { roleId_candidateKey: { roleId: role.id, candidateKey: input.candidateKey } },
      create: { roleId: role.id, candidateKey: input.candidateKey },
      update: {},
    });
    const snapshot = await assessmentSnapshot(tx, actor, role, row);
    const completed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        runId: run.id,
        status: "executing",
        run: {
          status: "running",
          leaseOwner: context.leaseOwner,
          leaseFence: context.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
      },
      data: { status: "completed", result: snapshot as unknown as Prisma.InputJsonValue },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: run.botId,
      runId: run.id,
      type: "recruiting.assessment.saved",
      payload: {
        roleId: role.id,
        roleRevisionId: input.roleRevisionId,
        candidateKey: input.candidateKey,
        version: row.version,
        effectId: effect.id,
      },
    });
    return snapshot;
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

/** Called only by the successful native reader, before returning source references to the model. */
export async function recordRecruitingWebMaterial(
  prisma: PrismaClient,
  actor: Actor,
  context: ResearchLease & { threadId: string; botId: string },
  input: {
    artifact: RecruitingResearchArtifactInput;
    reader: "web_fetch";
    url: string;
    readAt: string;
  },
) {
  if (
    input.reader !== "web_fetch" ||
    !["http:", "https:"].includes(new URL(input.url).protocol) ||
    !Number.isFinite(Date.parse(input.readAt)) ||
    input.artifact.mimeType !== "application/json"
  )
    throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, context.runId);
    requireResearchLease(run, context);
    if (run.threadId !== context.threadId || run.botId !== context.botId)
      throw new IsolationError();
    const retained = await tx.artifact.findUnique({
      where: {
        spaceId_userId_clientNonce: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          clientNonce: input.artifact.clientNonce,
        },
      },
    });
    if (
      retained &&
      (retained.runId !== run.id ||
        retained.botId !== run.botId ||
        retained.groupId !== thread.groupId ||
        retained.hash !== input.artifact.hash ||
        retained.size !== input.artifact.size ||
        retained.name !== input.artifact.name ||
        retained.mimeType !== input.artifact.mimeType ||
        retained.version !== 1 ||
        retained.rootArtifactId !== null)
    )
      throw new IsolationError();
    const artifact =
      retained ?? (await createResearchArtifact(tx, actor, run, thread, input.artifact));
    const existing = await tx.event.findFirst({
      where: {
        spaceId: actor.spaceId,
        runId: run.id,
        threadId: thread.id,
        botId: run.botId,
        type: "recruiting.material.read",
        payload: { path: ["artifact", "artifactId"], equals: artifact.id },
      },
    });
    if (existing) {
      const event = ProductEventSchema.parse({
        ...existing,
        createdAt: existing.createdAt.toISOString(),
      });
      const payload = event.payload as {
        reader: string;
        artifact: RecruitingArtifactRef;
        url: string;
      };
      if (
        payload.reader !== input.reader ||
        payload.artifact.sha256 !== artifact.hash ||
        payload.url !== input.url
      )
        throw new IsolationError();
      return { artifact, event, created: false };
    }
    const row = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: run.botId,
      runId: run.id,
      type: "recruiting.material.read",
      payload: {
        reader: input.reader,
        artifact: { artifactId: artifact.id, sha256: artifact.hash },
        url: input.url,
        readAt: input.readAt,
      },
    });
    return {
      artifact,
      event: ProductEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() }),
      created: true,
    };
  });
}
type RecruitingApprovalContext = {
  runId: string;
  threadId: string;
  botId: string;
  leaseOwner: string;
  leaseFence: number;
};
export type RecruitingApprovalResult = {
  status: "approved";
  stage: RecruitingApprovalToolInput["stage"];
  roleId: string;
  roleRevisionId: string;
  approvalEffectId: string;
  payloadHash: string;
  approvedByUserId: string;
  approvedAt: string;
};

function recruitingApprovalHash(input: unknown) {
  return createHash("sha256").update(stableJsonValue(input)).digest("hex");
}

async function approvalWorkspace(
  tx: Tx,
  actor: Actor,
  threadId: string,
  input: Pick<RecruitingApprovalToolInput, "roleId" | "expectedRoleRevision">,
  current = true,
  requireSelection = current,
) {
  const thread = await requireThread(tx, actor, threadId);
  const role = await requireRole(tx, actor, input.roleId, true);
  if (requireSelection && thread.activeRecruitingRoleId !== role.id) throw new IsolationError();
  if (current && role.revision !== input.expectedRoleRevision) throw new RecruitingConflictError();
  const row = await tx.recruitingRoleRevision.findFirst({
    where: { roleId: role.id, revision: input.expectedRoleRevision },
  });
  if (!row || (current && row.id !== role.currentRevisionId)) throw new RecruitingConflictError();
  const revision = RecruitingRoleRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  await validateDefinition(tx, actor, revision);
  if (revision.brief) validateRecruitingBrief(revision.brief, revision);
  requireRecruitingBriefConfirmation(revision);
  const confirmation = revision.brief!.confirmation!;
  const human = await tx.message.findUnique({
    where: { id: confirmation.messageId },
    include: humanMessageInclude,
  });
  if (confirmation.userId !== actor.userId || !human || !isNativeHumanMessage(human))
    throw new IsolationError();
  await requireThread(tx, actor, human.threadId);
  return { role, revision };
}

async function approvalAnswerProof(
  tx: Tx,
  actor: Actor,
  effect: { id: string; runId: string; request: unknown },
) {
  const run = await requireRun(tx, actor, effect.runId);
  const proof = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.approval.answered",
      payload: { path: ["effectId"], equals: effect.id },
    },
  });
  if (!proof) throw new IsolationError();
  const answer = EffectApprovalAnsweredPayloadSchema.parse(proof.payload);
  if (
    answer.effectId !== effect.id ||
    answer.answer !== "allow" ||
    answer.answeredByUserId !== actor.userId ||
    answer.requestHash !== recruitingApprovalHash(effect.request)
  )
    throw new IsolationError();
  const message = await tx.message.findUnique({ where: { id: answer.messageId } });
  const blocks = MessageBlockSchema.array().safeParse(message?.blocks);
  const card = blocks.success ? blocks.data[answer.askIndex] : undefined;
  if (
    !message ||
    message.threadId !== run.threadId ||
    message.runId !== run.id ||
    message.botId !== run.botId ||
    message.role !== "bot" ||
    card?.kind !== "ask" ||
    card.approvalEffectId !== effect.id ||
    card.status !== "answered" ||
    card.answer !== "allow" ||
    card.input === "secret" ||
    card.credential ||
    !card.actions?.some((action) => action.id === "allow") ||
    card.actions.some((action) => !["allow", "deny"].includes(action.id))
  )
    throw new IsolationError();
  return { run, proof };
}

async function completedRecruitingApproval(
  tx: Tx,
  actor: Actor,
  effectId: string,
  scope: { roleId: string; expectedRoleRevision: number },
  stage: RecruitingApprovalToolInput["stage"],
  current = true,
) {
  const effect = await tx.externalEffect.findFirst({
    where: {
      id: effectId,
      spaceId: actor.spaceId,
      kind: "recruiting_request_approval",
      status: "completed",
    },
  });
  if (effect?.kind !== "recruiting_request_approval" || effect.status !== "completed")
    throw new IsolationError();
  const input = RecruitingApprovalToolInputSchema.parse(effect.request);
  if (
    input.stage !== stage ||
    input.roleId !== scope.roleId ||
    input.expectedRoleRevision !== scope.expectedRoleRevision
  )
    throw new RecruitingConflictError();
  const { run, proof } = await approvalAnswerProof(tx, actor, effect);
  const workspace = await approvalWorkspace(tx, actor, run.threadId, input, current, false);
  const expected: RecruitingApprovalResult = {
    status: "approved",
    stage: input.stage,
    roleId: input.roleId,
    roleRevisionId: workspace.revision.id,
    approvalEffectId: effect.id,
    payloadHash: recruitingApprovalHash(input),
    approvedByUserId: actor.userId,
    approvedAt: proof.createdAt.toISOString(),
  };
  if (stableJsonValue(effect.result) !== stableJsonValue(expected)) throw new IsolationError();
  const recorded = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: { path: ["effectId"], equals: effect.id },
    },
  });
  if (
    !recorded ||
    stableJsonValue(recorded.payload) !==
      stableJsonValue({
        effectId: effect.id,
        tool: "recruiting_request_approval",
        ...expected,
      })
  )
    throw new IsolationError();
  const package_ = await recruitingApprovalPackage(tx, actor, input, current);
  return { input, result: expected, package: package_ };
}

type RecruitingApprovalPackage = {
  files: MessageBlock[];
  documentRefs: RecruitingArtifactRef[];
  sourceRefs: RecruitingAssessmentSourceRef[];
};

async function recruitingApprovalPackage(
  tx: Tx,
  actor: Actor,
  input: RecruitingApprovalToolInput,
  current = true,
  bytes?: ReadonlyMap<string, Uint8Array>,
): Promise<RecruitingApprovalPackage> {
  if (input.stage === "calibration") {
    const documents = await completedRecruitingApproval(
      tx,
      actor,
      input.documentsApprovalEffectId,
      input,
      "documents",
      current,
    );
    const unique = new Set(input.profiles.map((profile) => profile.candidateKey));
    const identities = input.profiles.map((profile) =>
      recruitingCalibrationIdentity(profile.linkedinUrl),
    );
    if (
      unique.size !== 10 ||
      identities.some((identity) => !identity) ||
      new Set(identities).size !== 10
    )
      throw new IsolationError();
    const sources: RecruitingAssessmentSourceRef[] = [];
    for (const profile of input.profiles) {
      const row = await tx.recruitingAssessment.findFirst({
        where: {
          roleId: input.roleId,
          candidateKey: profile.candidateKey,
          ...(current ? {} : { version: profile.assessmentVersion }),
        },
        orderBy: { version: "desc" },
      });
      if (
        !row ||
        row.version !== profile.assessmentVersion ||
        row.roleRevisionId !== documents.result.roleRevisionId
      )
        throw new RecruitingConflictError();
      await requireRun(tx, actor, row.createdByRunId);
      const refs = RecruitingAssessmentSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }).sourceRefs;
      await validateSources(tx, actor, refs);
      for (const url of [profile.linkedinUrl, profile.evidenceUrl]) {
        let observed = false;
        for (const source of refs.filter((ref) => ref.readState === "read" && ref.url === url)) {
          if (extractLinksFromText(source.quote ?? "").includes(url)) {
            observed = true;
            break;
          }
          if (source.anchor.kind !== "artifact") continue;
          const artifact = await validateArtifact(tx, actor, source.anchor.artifact);
          if (!artifact.runId) continue;
          const receipt = await tx.event.findFirst({
            where: {
              spaceId: actor.spaceId,
              runId: artifact.runId,
              botId: artifact.botId ?? undefined,
              type: "recruiting.material.read",
              AND: [
                { payload: { path: ["reader"], equals: "web_fetch" } },
                { payload: { path: ["artifact", "artifactId"], equals: artifact.id } },
                { payload: { path: ["artifact", "sha256"], equals: artifact.hash } },
                { payload: { path: ["url"], equals: url } },
              ],
            },
          });
          if (!receipt) continue;
          const payload = RecruitingMaterialReadPayloadSchema.parse(receipt.payload);
          const origin = await requireRun(tx, actor, artifact.runId);
          if (
            receipt.threadId !== origin.threadId ||
            origin.botId !== artifact.botId ||
            payload.url !== url ||
            payload.readAt !== source.readAt ||
            payload.artifact.artifactId !== artifact.id ||
            payload.artifact.sha256 !== artifact.hash
          )
            throw new IsolationError();
          observed = true;
          break;
        }
        if (!observed) throw new IsolationError();
      }
      sources.push(...refs);
    }
    if (bytes) {
      await recruitingApprovalPackage(tx, actor, documents.input, current, bytes);
      await validateReadSources(tx, actor, sources, bytes);
    }
    return { ...documents.package, sourceRefs: sources };
  }
  const files: MessageBlock[] = [];
  const documentRefs: RecruitingArtifactRef[] = [];
  for (const [kind, ref] of Object.entries(input.documents)) {
    if (!ref) continue;
    const artifact = await validateArtifact(tx, actor, ref);
    const json = artifact.mimeType === "application/json" || artifact.mimeType.endsWith("+json");
    if (
      kind === "jdText"
        ? !artifact.mimeType.startsWith("text/") && !json
        : artifact.mimeType !== "application/pdf"
    )
      throw new IsolationError();
    if (bytes) {
      const body = bytes.get(artifact.id);
      if (
        !body ||
        body.byteLength !== artifact.size ||
        createHash("sha256").update(body).digest("hex") !== artifact.hash
      )
        throw new IsolationError();
      if (kind === "jdText") {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
          if (!text.trim()) throw new IsolationError();
          if (json && !assessmentJsonString(body, ["text"]).trim()) throw new IsolationError();
        } catch {
          throw new IsolationError();
        }
      } else if (new TextDecoder().decode(body.subarray(0, 5)) !== "%PDF-")
        throw new IsolationError();
    }
    documentRefs.push(ref);
    files.push({
      kind: "file",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      name: artifact.name,
      size: artifact.size,
    });
  }
  return { files, documentRefs, sourceRefs: [] };
}

async function loadRecruitingApprovalMaterials(
  prisma: PrismaClient,
  actor: Actor,
  trusted: RecruitingApprovalContext,
  input: RecruitingApprovalToolInput,
  material: RecruitingRoleMaterialContext | undefined,
  replay = false,
) {
  const package_ = await prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    if (!replay) requireResearchLease(run, trusted);
    await approvalWorkspace(tx, actor, trusted.threadId, input, !replay);
    return recruitingApprovalPackage(tx, actor, input, !replay);
  });
  // Reuse the existing native Artifact authorization/store reader; synthetic locators are never persisted.
  return loadRoleMaterials(
    prisma,
    actor,
    {
      criteria: [],
      sourceRefs: [
        ...package_.sourceRefs,
        ...package_.documentRefs.map((ref) => ({
          id: ref.artifactId,
          kind: "original_material" as const,
          anchor: { kind: "artifact" as const, artifact: ref, locator: "approval-package" },
          readState: "read" as const,
          readAt: new Date().toISOString(),
          quote: "approval-package",
        })),
      ],
    },
    material,
  );
}

export async function prepareRecruitingApproval(
  prisma: PrismaClient,
  actor: Actor,
  trusted: RecruitingApprovalContext,
  untrustedInput: unknown,
  material?: RecruitingRoleMaterialContext,
): Promise<{ files: MessageBlock[] }> {
  const input = RecruitingApprovalToolInputSchema.parse(untrustedInput);
  const bytes = await loadRecruitingApprovalMaterials(prisma, actor, trusted, input, material);
  return prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    requireResearchLease(run, trusted);
    await approvalWorkspace(tx, actor, trusted.threadId, input);
    const package_ = await recruitingApprovalPackage(tx, actor, input, true, bytes);
    return { files: package_.files };
  });
}

export async function executeRecruitingApproval(
  prisma: PrismaClient,
  actor: Actor,
  trusted: RecruitingApprovalContext & { effectId: string; effectRequest: unknown },
  untrustedInput: unknown,
  material?: RecruitingRoleMaterialContext,
): Promise<RecruitingApprovalResult> {
  const input = RecruitingApprovalToolInputSchema.parse(untrustedInput);
  if (stableJsonValue(input) !== stableJsonValue(trusted.effectRequest)) throw new IsolationError();
  // Read status only to permit immutable completed receipts after the run/role has advanced.
  const retained = await prisma.$transaction((tx) =>
    tx.externalEffect.findFirst({
      where: {
        id: trusted.effectId,
        spaceId: actor.spaceId,
        runId: trusted.runId,
        kind: "recruiting_request_approval",
      },
    }),
  );
  const replay = retained?.status === "completed";
  const bytes = await loadRecruitingApprovalMaterials(
    prisma,
    actor,
    trusted,
    input,
    material,
    replay,
  );
  return prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${trusted.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: trusted.effectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_request_approval",
      },
    });
    if (
      effect?.kind !== "recruiting_request_approval" ||
      effect.runId !== run.id ||
      stableJsonValue(effect.request) !== stableJsonValue(trusted.effectRequest)
    )
      throw new IsolationError();
    if (effect.status === "completed") {
      const saved = await completedRecruitingApproval(
        tx,
        actor,
        effect.id,
        input,
        input.stage,
        false,
      );
      await recruitingApprovalPackage(tx, actor, input, false, bytes);
      return saved.result;
    }
    requireResearchLease(run, trusted);
    if (effect.status !== "executing") throw new IsolationError();
    const workspace = await approvalWorkspace(tx, actor, trusted.threadId, input);
    const { proof } = await approvalAnswerProof(tx, actor, effect);
    await recruitingApprovalPackage(tx, actor, input, true, bytes);
    const result: RecruitingApprovalResult = {
      status: "approved",
      stage: input.stage,
      roleId: input.roleId,
      roleRevisionId: workspace.revision.id,
      approvalEffectId: effect.id,
      payloadHash: recruitingApprovalHash(input),
      approvedByUserId: actor.userId,
      approvedAt: proof.createdAt.toISOString(),
    };
    const completed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        spaceId: actor.spaceId,
        runId: run.id,
        status: "executing",
        run: {
          status: "running",
          leaseOwner: trusted.leaseOwner,
          leaseFence: trusted.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
      },
      data: { status: "completed", result },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: { effectId: effect.id, tool: "recruiting_request_approval", ...result },
    });
    return result;
  });
}

/** Called only for this tool's native card; stale cards can still be denied. */
export async function authorizeRecruitingApprovalAnswerInTransaction(
  tx: Tx,
  input: AnswerRunInput,
  effectRequest: unknown,
): Promise<boolean> {
  if (input.answer !== "allow") return false;
  const actor: Actor = {
    spaceId: input.spaceId,
    userId: input.answeredByUserId,
    email: "",
    isDeploymentOwner: false,
  };
  try {
    const request = RecruitingApprovalToolInputSchema.parse(effectRequest);
    const { run } = await lockLiveRecruitingRun(tx, actor, input.runId, false);
    if (run.status !== "waiting_input" || run.threadId !== input.threadId) return false;
    await approvalWorkspace(tx, actor, input.threadId, request);
    await recruitingApprovalPackage(tx, actor, request);
    return true;
  } catch (error) {
    if (
      error instanceof IsolationError ||
      error instanceof RecruitingConflictError ||
      error instanceof RecruitingPlaybookValidationError ||
      (error instanceof Error && error.name === "ZodError")
    )
      return false;
    throw error;
  }
}

async function requireRecruitingResearchGate(
  tx: Tx,
  actor: Actor,
  input: { purpose?: string | null; approvalEffectId?: string | null },
  role: RecruitingRole,
) {
  if (!input.approvalEffectId || !["calibration", "scale"].includes(input.purpose ?? ""))
    throw new IsolationError();
  return completedRecruitingApproval(
    tx,
    actor,
    input.approvalEffectId,
    {
      roleId: role.id,
      expectedRoleRevision: role.revision,
    },
    input.purpose === "calibration" ? "documents" : "calibration",
  );
}

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
      purpose: action.purpose ?? null,
      candidateOutputSchema: action.candidateOutputSchema ?? null,
      approvalEffectId: action.approvalEffectId ?? null,
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
  return { ...block, sender };
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
  role: Pick<RecruitingRole, "id" | "currentRevisionId">,
  ref?: RecruitingArtifactRef,
  before?: Date,
  context?: {
    run: Awaited<ReturnType<typeof requireRun>>;
    thread: Awaited<ReturnType<typeof requireThread>>;
  },
) {
  const event = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      runId: run.id,
      botId: run.botId,
      type: "recruiting.context.adopted",
      ...(before ? { createdAt: { lte: before } } : {}),
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
  const artifact = await validateArtifact(tx, actor, payload.contextArtifact, context);
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
  allowCancelledRun = false,
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
      ...(allowCancelledRun ? { allowCancelledRun: true } : {}),
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
  purpose: RecruitingResearchPurpose;
  approvalEffectId: string;
  clientNonce: string;
  recallScope: string | null;
  requestArtifact: RecruitingResearchArtifactInput;
  candidateOutputSchema: typeof RECRUITING_CANDIDATE_OUTPUT_SCHEMA;
  contextArtifact: RecruitingArtifactRef;
};

export async function prepareRecruitingResearchAction(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingResearchPreparationInput,
) {
  const candidateOutputSchema = RecruitingCandidateOutputSchemaId.parse(
    input.candidateOutputSchema,
  );
  return prisma.$transaction(async (tx) => {
    const context = await researchContextInTransaction(tx, actor, {
      ...input,
      toolName: input.kind === "create" ? "research" : "reply",
    });
    const { run, thread, workspace, server, source } = context;
    requireRecruitingBriefConfirmation(workspace.revision);
    await requireRecruitingResearchGate(tx, actor, input, workspace.role);
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
        action.purpose !== input.purpose ||
        action.candidateOutputSchema !== candidateOutputSchema ||
        action.approvalEffectId !== input.approvalEffectId ||
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
        purpose: input.purpose,
        candidateOutputSchema,
        approvalEffectId: input.approvalEffectId,
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
  try {
    requireRecruitingBriefConfirmation(workspace.revision);
  } catch {
    return false;
  }
  if (!task || !action || !server) throw new IsolationError();
  try {
    await requireRecruitingResearchGate(tx, actor, action, workspace.role);
  } catch (error) {
    if (
      error instanceof IsolationError ||
      error instanceof RecruitingConflictError ||
      error instanceof RecruitingPlaybookValidationError ||
      (error instanceof Error && error.name === "ZodError")
    )
      return false;
    throw error;
  }
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
  purpose: RecruitingResearchPurpose;
  approvalEffectId: string;
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
    if (action.purpose !== input.purpose || action.approvalEffectId !== input.approvalEffectId)
      throw new IsolationError();
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

export async function settleUncertainRecruitingResearchAction(
  prisma: PrismaClient,
  actor: Actor,
  input: ResearchLease & {
    taskId: string;
    actionId: string;
    effectId: string;
    effectKind: string;
    effectRequest: Prisma.InputJsonValue;
    result: { error: string; uncertain: true };
  },
) {
  return prisma.$transaction(async (tx) => {
    await lockResearchDispatchThreads(tx, actor, input);
    const { run } = await lockLiveRecruitingRun(tx, actor, input.runId, false);
    const context = await researchContextInTransaction(tx, actor, {
      runId: input.runId,
      taskId: input.taskId,
      actionId: input.actionId,
      historical: true,
    });
    const cancelled = run.status === "cancelled";
    if (cancelled) {
      if (run.leaseFence !== input.leaseFence) throw new IsolationError();
    } else requireResearchLease(run, input);
    let { task, action } = context;
    if (!task || !action || !context.effect || context.effect.id !== input.effectId)
      throw new IsolationError();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${input.effectId} FOR UPDATE`,
    );
    let effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: input.effectId } });
    if (
      effect.spaceId !== actor.spaceId ||
      effect.id !== action.effectId ||
      effect.kind !== input.effectKind ||
      (cancelled && effect.runId !== run.id) ||
      effect.idempotencyKey !== `recruiting-research:${action.id}` ||
      stableJsonValue(effect.request) !== stableJsonValue(input.effectRequest)
    )
      throw new IsolationError();
    if (effect.status === "executing") {
      if (effect.runId !== context.run.id) {
        const owner = await tx.run.findUniqueOrThrow({ where: { id: effect.runId } });
        if (
          ["queued", "leased", "waiting_input"].includes(owner.status) ||
          (owner.status === "running" &&
            owner.leaseExpiresAt &&
            owner.leaseExpiresAt.getTime() > Date.now())
        )
          throw new IsolationError();
      }
      await tx.externalEffect.updateMany({
        where: { id: effect.id, status: "executing" },
        data: { status: "uncertain", result: input.result },
      });
      effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
    }
    if (!["completed", "denied", "uncertain"].includes(effect.status)) throw new IsolationError();
    if (
      effect.status === "uncertain" &&
      context.thread.activeRecruitingRoleId === task.roleId &&
      context.workspace.revision.id === action.roleRevisionId &&
      task.pendingActionId === action.id &&
      action.deliveryState === "sending" &&
      ["active", "unknown"].includes(task.state) &&
      !action.receiptArtifactId
    ) {
      action = await transitionResearchAction(tx, actor, run, action, "unknown", cancelled);
      task = await tx.recruitingResearchTask.update({
        where: { id: task.id },
        data: { state: "unknown" },
      });
    }
    return { effect, task, action };
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
  /** Classified by the native adapter from the exact effect result; raw bytes stay in ArtifactStore. */
  rows?: readonly unknown[];
  outputId?: string | null;
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
      const recorded = await recordedResearchReadArtifact(tx, actor, read);
      const indexed =
        read.toolName === "get_rows"
          ? await tx.recruitingCandidatePage.findUnique({ where: { effectId: effect.id } })
          : true;
      if (!recorded || !indexed)
        pending.push({
          ...(recorded
            ? {
                outputArtifact: {
                  name: recorded.name,
                  mimeType: recorded.mimeType,
                  size: recorded.size,
                  hash: recorded.hash,
                  storageKey: recorded.storageKey,
                  clientNonce: `recruiting-observation:${effect.id}`,
                },
              }
            : {}),
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
      const candidateRows = await indexRecruitingCandidateRows(
        tx,
        actor,
        action,
        task,
        effect,
        recorded,
        read.args,
        input,
      );
      return { task, action, outputArtifact: recorded, candidateRows };
    }
    const outputArtifact = await createResearchArtifact(
      tx,
      actor,
      run,
      thread,
      input.outputArtifact,
    );
    const candidateRows = await indexRecruitingCandidateRows(
      tx,
      actor,
      action,
      task,
      effect,
      outputArtifact,
      read.args,
      input,
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
    return { task: changedTask, action: updated, outputArtifact, candidateRows };
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
      const pages = await tx.recruitingCandidatePage.findMany({
        where: { roleId: role.id, taskId: null, actionId: null },
        orderBy: [{ observedAt: "asc" }, { effectId: "asc" }],
        include: { effect: { select: { runId: true, request: true } } },
      });
      await candidatePageArtifacts(tx, actor, pages);
      const observations = [];
      for (const page of pages) {
        const call = researchReadRequest(page.effect.request, undefined, "get_rows");
        observations.push(
          RecruitingResearchSavedObservationSchema.parse({
            effectId: page.effectId,
            providerTaskId: call.args.task_id,
            roleRevisionId: page.roleRevisionId,
            runId: page.effect.runId,
            rowCount: page.rowCount,
            observedAt: page.observedAt.toISOString(),
            requestCursor: page.requestCursor,
            artifactRef: { artifactId: page.artifactId, sha256: page.artifactHash },
          }),
        );
      }
      return { tasks, actions, observations };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function indexRecruitingCandidateRows(
  tx: Tx,
  actor: Actor,
  action: Pick<ResearchActionRow, "id" | "roleRevisionId" | "candidateOutputSchema"> | null,
  task: Pick<ResearchTaskRow, "id" | "roleId">,
  effect: ResearchEffectRow,
  artifact: { id: string; hash: string },
  request: Prisma.InputJsonObject,
  input: Pick<RecruitingResearchObservationInput, "toolName" | "rows" | "outputId">,
  nativeRevisionId?: string,
) {
  if (input.toolName !== "get_rows") return [];
  if (await tx.recruitingCandidatePage.findUnique({ where: { effectId: effect.id } }))
    return tx.recruitingCandidateOccurrence.findMany({
      where: { pageId: effect.id },
      orderBy: { rowIndex: "asc" },
      select: { rowIndex: true, candidateKey: true },
    });
  const schemaKnown =
    action === null || action.candidateOutputSchema === RECRUITING_CANDIDATE_OUTPUT_SCHEMA;
  const rows = (input.rows ?? []).map((row, rowIndex) => {
    const { candidateKey, ...profile } = normalizeRecruitingCandidateRow(row, {
      schemaKnown,
    });
    return {
      pageId: effect.id,
      rowIndex,
      roleId: task.roleId,
      candidateKey: candidateKey ?? `source-row:${effect.id}:${rowIndex}`,
      ...profile,
      evidenceUrls: profile.evidenceUrls === null ? Prisma.DbNull : [...profile.evidenceUrls],
      issues: [...profile.issues],
    };
  });
  const sourceRows = schemaKnown
    ? (input.rows ?? []).flatMap((row, rowIndex) =>
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        rows[rowIndex]!.name !== null &&
        rows[rowIndex]!.candidateKey === `source-row:${effect.id}:${rowIndex}`
          ? [{ rowIndex, row }]
          : [],
      )
    : [];
  if (sourceRows.length) {
    const call = researchReadRequest(effect.request, undefined, "get_rows");
    // ponytail: compare this authorized read view in SQL; persist row fingerprints
    // only if its growing page history outgrows this scoped scan. Caller holds the role lock.
    const reused = await tx.$queryRaw<Array<{ rowIndex: number; candidateKey: string }>>(
      Prisma.sql`
        WITH incoming_source_rows AS (
          SELECT (item->>'rowIndex')::int AS "rowIndex", item->'row' AS "row",
            row_number() OVER (PARTITION BY item->'row' ORDER BY (item->>'rowIndex')::int) AS ordinal
          FROM jsonb_array_elements(${JSON.stringify(sourceRows)}::jsonb) item
        ), source_pages AS MATERIALIZED (
          SELECT page."effectId", page."observedAt", previous."result",
            CASE WHEN previous."request"->>1 = 'direct' THEN previous."request"->2->'args'
              ELSE previous."request"->2->'arguments' END AS args
          FROM "recruiting_candidate_pages" page
          JOIN "external_effects" previous ON previous."id" = page."effectId"
          JOIN "runs" owner ON owner."id" = previous."runId"
          JOIN "bots" bot ON bot."id" = owner."botId"
          JOIN "threads" thread ON thread."id" = owner."threadId"
          JOIN "artifacts" artifact ON artifact."id" = page."artifactId"
          WHERE page."roleId" = ${task.roleId} AND page."effectId" <> ${effect.id}
            AND previous."spaceId" = ${actor.spaceId} AND previous."status" = 'completed'
            AND owner."spaceId" = ${actor.spaceId} AND owner."userId" = ${actor.userId}
            AND bot."spaceId" = ${actor.spaceId} AND bot."userId" = ${actor.userId}
            AND thread."spaceId" = ${actor.spaceId} AND thread."userId" = ${actor.userId}
            AND artifact."spaceId" = ${actor.spaceId} AND artifact."userId" = ${actor.userId}
            AND artifact."hash" = page."artifactHash" AND artifact."runId" = owner."id"
            AND artifact."botId" = bot."id"
            AND page."outputId" IS NOT DISTINCT FROM ${input.outputId ?? null}::text
            AND previous."request"->>0 = '__rakazoCatalogTool'
            AND (
              (previous."request"->>1 = 'direct'
                AND jsonb_array_length(CASE WHEN jsonb_typeof(previous."request") = 'array'
                  THEN previous."request" ELSE '[]'::jsonb END) = 3
                AND previous."request"->2->'route' = ${JSON.stringify(call.route)}::jsonb
                AND (previous."request"->2->'args') - 'limit' = ${JSON.stringify(call.args)}::jsonb - 'limit')
              OR (previous."request"->>1 IN ('connectors_execute_tool', 'mcp_execute_tool')
                AND jsonb_array_length(CASE WHEN jsonb_typeof(previous."request") = 'array'
                  THEN previous."request" ELSE '[]'::jsonb END) = 4
                AND previous."request"->3 = ${JSON.stringify(call.route)}::jsonb
                AND previous."request"->2->>'id' = ${`${call.route.resourceId}:get_rows`}
                AND (previous."request"->2->'arguments') - 'limit' = ${JSON.stringify(call.args)}::jsonb - 'limit')
            )
        ), read_results AS (
          SELECT * FROM source_pages
          UNION ALL
          SELECT current."id", current."updatedAt", current."result", ${JSON.stringify(call.args)}::jsonb
          FROM "external_effects" current WHERE current."id" = ${effect.id}
            AND current."spaceId" = ${actor.spaceId} AND current."status" = 'completed'
        ), read_views AS MATERIALIZED (
          SELECT saved.*, envelope.body FROM read_results saved
          CROSS JOIN LATERAL (
            SELECT COALESCE(saved."result"->'structuredContent', (
              SELECT CASE WHEN block->>'text' IS JSON OBJECT THEN (block->>'text')::jsonb END
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(saved."result"->'content') = 'array'
                THEN saved."result"->'content' ELSE '[]'::jsonb END) block
              WHERE block->>'type' = 'text' AND block->>'text' IS JSON OBJECT LIMIT 1
            )) AS body
          ) envelope
        ), matched_source_rows AS (
          SELECT DISTINCT ON (incoming."row", page."effectId", occurrence."candidateKey")
            incoming."row", occurrence."candidateKey", page."observedAt", page."effectId",
            occurrence."rowIndex"
          FROM read_views page JOIN read_views current ON current."effectId" = ${effect.id}
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(page.body->'rows') = 'array'
            THEN page.body->'rows' ELSE '[]'::jsonb END) WITH ORDINALITY returned(value, ordinality)
          JOIN "recruiting_candidate_occurrences" occurrence ON occurrence."pageId" = page."effectId"
            AND occurrence."rowIndex" = returned.ordinality - 1
          JOIN incoming_source_rows incoming ON returned.value = incoming."row"
          WHERE page."effectId" <> current."effectId" AND (
              page.args = current.args OR (
                NOT (page.args ? 'cursor') AND NOT (current.args ? 'cursor')
                AND page.body->'next_cursor' = 'null'::jsonb
                AND current.body->'next_cursor' = 'null'::jsonb
                AND jsonb_typeof(current.body->'rows') = 'array'
              )
            )
            AND occurrence."roleId" = ${task.roleId} AND occurrence."name" IS NOT NULL
            AND occurrence."candidateKey" LIKE 'source-row:%'
          ORDER BY incoming."row", page."effectId", occurrence."candidateKey", occurrence."rowIndex"
        ), selected_source_pages AS (
          SELECT DISTINCT ON ("row") "row", "effectId"
          FROM (
            SELECT "row", "effectId", "observedAt", count(*) AS multiplicity
            FROM matched_source_rows GROUP BY "row", "effectId", "observedAt"
          ) pages ORDER BY "row", multiplicity DESC, "observedAt", "effectId"
        ), prior_source_rows AS (
          SELECT matched."row", matched."candidateKey", row_number() OVER (
            PARTITION BY matched."row" ORDER BY matched."rowIndex", matched."candidateKey"
          ) AS ordinal FROM matched_source_rows matched JOIN selected_source_pages selected
            ON matched."row" = selected."row" AND matched."effectId" = selected."effectId"
        )
        SELECT incoming."rowIndex", prior."candidateKey"
        FROM incoming_source_rows incoming JOIN prior_source_rows prior
          ON incoming."row" = prior."row" AND incoming.ordinal = prior.ordinal
      `,
    );
    for (const { rowIndex, candidateKey } of reused) rows[rowIndex]!.candidateKey = candidateKey;
  }
  await tx.recruitingCandidatePage.create({
    data: {
      effectId: effect.id,
      roleId: task.roleId,
      taskId: action ? task.id : null,
      actionId: action?.id ?? null,
      roleRevisionId: action?.roleRevisionId ?? nativeRevisionId!,
      artifactId: artifact.id,
      artifactHash: artifact.hash,
      requestCursor: typeof request.cursor === "string" ? request.cursor : null,
      outputId: input.outputId ?? null,
      // Native completion time orders historical recovery independently of indexing time.
      observedAt: effect.updatedAt,
      rowCount: input.rows === undefined ? null : rows.length,
    },
  });
  if (!rows.length) return [];
  await tx.recruitingCandidate.createMany({
    data: [...new Set(rows.map((row) => row.candidateKey))].map((candidateKey) => ({
      roleId: task.roleId,
      candidateKey,
    })),
    skipDuplicates: true,
  });
  await tx.recruitingCandidateOccurrence.createMany({ data: rows });
  return rows.map(({ rowIndex, candidateKey }) => ({ rowIndex, candidateKey }));
}

type NativeCandidateSaveInput = Extract<RecruitingResearchToolInput, { operation: "save_results" }>;

async function nativeCandidatePage(
  tx: Tx,
  actor: Actor,
  runId: string,
  input: NativeCandidateSaveInput,
  context?: {
    run: Awaited<ReturnType<typeof requireRun>>;
    thread: Awaited<ReturnType<typeof requireThread>>;
  },
) {
  const run = context?.run ?? (await requireRun(tx, actor, runId));
  const thread = context?.thread ?? (await requireThread(tx, actor, run.threadId));
  if (run.id !== runId || thread.id !== run.threadId) throw new IsolationError();
  if (!thread.activeRecruitingRoleId) throw new IsolationError();
  const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, true, thread);
  if (!role.currentRevisionId || role.revision !== input.expectedRoleRevision)
    throw new RecruitingConflictError();
  // ponytail: filter the native JSON receipt; keep the full parser and provenance checks below.
  const effects = await tx.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      runId,
      status: "completed",
      request: { path: ["0"], equals: "__rakazoCatalogTool" },
      OR: ["direct", "connectors_execute_tool", "mcp_execute_tool"].map((tool) => {
        const route = tool === "direct" ? ["2", "route"] : ["3"];
        const args = ["2", tool === "direct" ? "args" : "arguments"];
        return {
          AND: [
            { request: { path: ["1"], equals: tool } },
            { request: { path: [...route, "toolName"], equals: "get_rows" } },
            { request: { path: [...args, "task_id"], equals: input.providerTaskId } },
            { request: { path: [...args, "cursor"], equals: input.cursor ?? Prisma.AnyNull } },
            ...(input.mcpServerId === undefined
              ? []
              : [{ request: { path: [...route, "resourceId"], equals: input.mcpServerId } }]),
          ],
        };
      }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const effect of effects) {
    if (
      effect.runId !== run.id ||
      effect.status !== "completed" ||
      effect.spaceId !== actor.spaceId
    )
      continue;
    let call: ReturnType<typeof researchReadRequest>;
    try {
      call = researchReadRequest(effect.request, undefined, "get_rows");
    } catch (error) {
      if (error instanceof IsolationError) continue;
      throw error;
    }
    if (
      (input.mcpServerId !== undefined && call.route.resourceId !== input.mcpServerId) ||
      call.args.task_id !== input.providerTaskId ||
      (call.args.cursor ?? null) !== input.cursor
    )
      continue;
    await requireResearchAdoption(
      tx,
      actor,
      run,
      { id: role.id, currentRevisionId: role.currentRevisionId },
      undefined,
      effect.createdAt,
      { run, thread },
    );
    return {
      role,
      effect,
      call,
      snapshot: { request: effect.request, providerResult: effect.result },
    };
  }
  throw new IsolationError();
}

/** Read retained native output only; this never dispatches a provider request. */
export async function readNativeRecruitingCandidatePage(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  raw: NativeCandidateSaveInput,
) {
  const input = RecruitingResearchToolInputSchema.parse(raw);
  if (input.operation !== "save_results") throw new IsolationError();
  return prisma.$transaction((tx) => nativeCandidatePage(tx, actor, runId, input));
}

/** Artifact metadata, candidate projection and the native save effect commit together. */
export async function saveNativeRecruitingCandidatePage(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { effectId: string; effectRequest: unknown },
  raw: NativeCandidateSaveInput,
  captured: {
    sourceEffectId: string;
    rows: readonly unknown[];
    outputId?: string | null;
    outputArtifact: RecruitingResearchArtifactInput;
  },
) {
  const input = RecruitingResearchToolInputSchema.parse(raw);
  if (
    input.operation !== "save_results" ||
    stableJsonValue(input) !==
      stableJsonValue(RecruitingResearchToolInputSchema.parse(trusted.effectRequest))
  )
    throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${trusted.effectId} FOR UPDATE`,
    );
    const saving = await tx.externalEffect.findFirst({
      where: {
        id: trusted.effectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_research",
      },
    });
    if (
      saving?.kind !== "recruiting_research" ||
      saving.runId !== run.id ||
      stableJsonValue(RecruitingResearchToolInputSchema.parse(saving.request)) !==
        stableJsonValue(input)
    )
      throw new IsolationError();
    if (saving.status === "completed") return saving.result;
    requireResearchLease(run, trusted);
    if (saving.status !== "executing") throw new IsolationError();
    const source = await nativeCandidatePage(tx, actor, run.id, input, { run, thread });
    const bytes = Buffer.from(stableJsonValue(source.snapshot));
    if (
      source.effect.id !== captured.sourceEffectId ||
      captured.outputArtifact.hash !== createHash("sha256").update(bytes).digest("hex") ||
      captured.outputArtifact.size !== bytes.length ||
      captured.outputArtifact.clientNonce !== `recruiting-observation:${source.effect.id}`
    )
      throw new IsolationError();
    const previous = await tx.recruitingCandidatePage.findUnique({
      where: { effectId: source.effect.id },
    });
    if (
      previous &&
      (previous.taskId !== null ||
        previous.actionId !== null ||
        previous.roleId !== source.role.id ||
        previous.roleRevisionId !== source.role.currentRevisionId ||
        previous.artifactHash !== captured.outputArtifact.hash)
    )
      throw new IsolationError();
    const artifact = previous
      ? await candidatePageArtifact(tx, actor, previous)
      : await createResearchArtifact(tx, actor, run, thread, captured.outputArtifact);
    const candidateRows = await indexRecruitingCandidateRows(
      tx,
      actor,
      null,
      { id: source.effect.id, roleId: source.role.id },
      source.effect,
      artifact,
      source.call.args,
      { toolName: "get_rows", rows: captured.rows, outputId: captured.outputId },
      source.role.currentRevisionId!,
    );
    if (!previous)
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "recruiting.candidates.saved",
        payload: {
          roleId: source.role.id,
          roleRevisionId: source.role.currentRevisionId!,
          effectId: source.effect.id,
          mcpServerId: source.call.route.resourceId,
          serverRevision: source.call.route.resourceRevision,
          providerTaskId: input.providerTaskId,
          requestCursor: input.cursor,
          outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
          candidateOutputSchema: RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
        },
      });
    const result = {
      status: "saved",
      roleId: source.role.id,
      roleRevisionId: source.role.currentRevisionId,
      sourceEffectId: source.effect.id,
      outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
      candidateRows,
    };
    const completed = await tx.externalEffect.updateMany({
      where: {
        id: saving.id,
        spaceId: actor.spaceId,
        runId: run.id,
        status: "executing",
        run: {
          status: "running",
          leaseOwner: trusted.leaseOwner,
          leaseFence: trusted.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
      },
      data: { status: "completed", result },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: { effectId: saving.id, tool: "recruiting_research", ...result },
    });
    return result;
  });
}

/** One provenance check for both historical action pages and native candidate saves. */
async function candidatePageArtifact(
  tx: Tx,
  actor: Actor,
  page: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>,
  canonical = false,
) {
  if (page.taskId === null && page.actionId === null) {
    const artifacts = await candidatePageArtifacts(tx, actor, [page], canonical);
    return artifacts.get(page.effectId)!;
  }
  const effect = await tx.externalEffect.findFirst({
    where: {
      id: page.effectId,
      spaceId: actor.spaceId,
      status: "completed",
    },
  });
  if (effect?.status !== "completed") throw new IsolationError();
  const read = await researchReadBinding(tx, actor, effect);
  if (
    read?.toolName !== "get_rows" ||
    read.binding.taskId !== page.taskId ||
    read.binding.actionId !== page.actionId ||
    read.saved.task?.roleId !== page.roleId ||
    read.saved.action?.roleRevisionId !== page.roleRevisionId ||
    (canonical && read.saved.action.candidateOutputSchema !== RECRUITING_CANDIDATE_OUTPUT_SCHEMA)
  )
    throw new IsolationError();
  const artifact = await recordedResearchReadArtifact(tx, actor, read);
  if (!artifact || artifact.id !== page.artifactId || artifact.hash !== page.artifactHash)
    throw new IsolationError();
  return artifact;
}

async function candidatePageArtifacts(
  tx: Tx,
  actor: Actor,
  pages: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>[],
  canonical = false,
): Promise<Map<string, Prisma.ArtifactGetPayload<Record<string, never>>>> {
  const nativeIds = pages
    .filter((page) => page.taskId === null && page.actionId === null)
    .map((page) => page.effectId);
  type Owner = Pick<Actor, "spaceId" | "userId">;
  type ProofRow = Prisma.ArtifactGetPayload<Record<string, never>> & {
    effectId: string;
    effectStatus: string;
    effectRequest: Prisma.JsonValue;
    effectResult: Prisma.JsonValue;
    effectRun: Owner & {
      id: string;
      threadId: string;
      botId: string;
      bot: Owner;
      thread: Owner & {
        botId: string | null;
        groupId: string | null;
        externalConversationId: string | null;
        bot: Owner;
        group: Owner;
        externalConversation: Owner & { bot: Owner };
      };
    };
  };
  // ponytail: join proof metadata once; ORM includes add serial round trips to the same snapshot.
  const proofs = nativeIds.length
    ? await tx.$queryRaw<ProofRow[]>(Prisma.sql`
        SELECT e."id" AS "effectId", e."status" AS "effectStatus",
          e."request" AS "effectRequest", e."result" AS "effectResult",
          jsonb_build_object(
            'id', r."id", 'spaceId', r."spaceId", 'userId', r."userId",
            'threadId', r."threadId", 'botId', r."botId",
            'bot', jsonb_build_object('spaceId', rb."spaceId", 'userId', rb."userId"),
            'thread', jsonb_build_object(
              'spaceId', t."spaceId", 'userId', t."userId", 'botId', t."botId",
              'groupId', t."groupId", 'externalConversationId', t."externalConversationId",
              'bot', jsonb_build_object('spaceId', tb."spaceId", 'userId', tb."userId"),
              'group', jsonb_build_object('spaceId', g."spaceId", 'userId', g."userId"),
              'externalConversation', jsonb_build_object(
                'spaceId', c."spaceId", 'userId', c."userId",
                'bot', jsonb_build_object('spaceId', cb."spaceId", 'userId', cb."userId")
              )
            )
          ) AS "effectRun", a.*
        FROM "external_effects" e
        LEFT JOIN "runs" r ON r."id" = e."runId"
        LEFT JOIN "bots" rb ON rb."id" = r."botId"
        LEFT JOIN "threads" t ON t."id" = r."threadId"
        LEFT JOIN "bots" tb ON tb."id" = t."botId"
        LEFT JOIN "chat_groups" g ON g."id" = t."groupId"
        LEFT JOIN "external_conversations" c ON c."id" = t."externalConversationId"
        LEFT JOIN "bots" cb ON cb."id" = c."botId"
        LEFT JOIN "recruiting_candidate_pages" p ON p."effectId" = e."id"
        LEFT JOIN "artifacts" a ON a."id" = p."artifactId"
        WHERE e."id" IN (${Prisma.join(nativeIds)})
          AND e."spaceId" = ${actor.spaceId} AND e."status" = 'completed'
      `)
    : [];
  const effects = proofs.map(
    ({
      effectId: id,
      effectStatus: status,
      effectRequest: request,
      effectResult: result,
      effectRun: run,
      ...artifact
    }) => ({
      id,
      status,
      request,
      result,
      run,
      recruitingCandidatePage: artifact.id ? { artifact } : null,
    }),
  );
  const byEffect = new Map(effects.map((effect) => [effect.id, effect]));
  const events = nativeIds.length
    ? await tx.event.findMany({
        where: {
          spaceId: actor.spaceId,
          type: "recruiting.candidates.saved",
          OR: nativeIds.map((id) => ({ payload: { path: ["effectId"], equals: id } })),
        },
      })
    : [];
  const byEvent = new Map<string, typeof events>();
  for (const event of events) {
    const id = (event.payload as { effectId: string }).effectId;
    const saved = byEvent.get(id) ?? [];
    saved.push(event);
    byEvent.set(id, saved);
  }
  const artifacts = new Map<string, Prisma.ArtifactGetPayload<Record<string, never>>>();
  for (const page of pages) {
    if (page.taskId !== null || page.actionId !== null) {
      artifacts.set(page.effectId, await candidatePageArtifact(tx, actor, page, canonical));
      continue;
    }
    const effect = byEffect.get(page.effectId);
    if (effect?.status !== "completed") throw new IsolationError();
    const run = scoped(actor, effect.run);
    scoped(actor, run.bot);
    const thread = scoped(actor, run.thread);
    let parent: Pick<Actor, "spaceId" | "userId">;
    if (thread.botId) parent = scoped(actor, thread.bot);
    else if (thread.groupId) parent = scoped(actor, thread.group);
    else if (thread.externalConversationId) {
      const conversation = scoped(actor, thread.externalConversation);
      scoped(actor, conversation.bot);
      parent = conversation;
    } else throw new IsolationError();
    if (
      run.userId !== actor.userId ||
      thread.userId !== actor.userId ||
      parent.userId !== actor.userId
    )
      throw new IsolationError();
    const call = researchReadRequest(effect.request, undefined, "get_rows");
    const saved = byEvent.get(effect.id) ?? [];
    if (saved.length !== 1) throw new IsolationError();
    const event = saved[0]!;
    const payload = ProductEventSchema.parse({
      ...event,
      createdAt: event.createdAt.toISOString(),
    }).payload;
    const artifact = effect.recruitingCandidatePage?.artifact;
    const bytes = Buffer.from(
      stableJsonValue({ request: effect.request, providerResult: effect.result }),
    );
    if (
      !artifact ||
      artifact.id !== page.artifactId ||
      artifact.spaceId !== actor.spaceId ||
      artifact.userId !== actor.userId ||
      artifact.runId !== run.id ||
      artifact.botId !== run.botId ||
      artifact.clientNonce !== `recruiting-observation:${effect.id}` ||
      artifact.hash !== page.artifactHash ||
      artifact.size !== bytes.length ||
      artifact.hash !== createHash("sha256").update(bytes).digest("hex") ||
      event.runId !== run.id ||
      event.threadId !== run.threadId ||
      event.botId !== run.botId ||
      payload.roleId !== page.roleId ||
      payload.roleRevisionId !== page.roleRevisionId ||
      payload.mcpServerId !== call.route.resourceId ||
      payload.serverRevision !== call.route.resourceRevision ||
      payload.providerTaskId !== call.args.task_id ||
      payload.requestCursor !== (call.args.cursor ?? null) ||
      page.requestCursor !== payload.requestCursor ||
      stableJsonValue(payload.outputArtifact) !==
        stableJsonValue({ artifactId: artifact.id, sha256: artifact.hash })
    )
      throw new IsolationError();
    artifacts.set(page.effectId, artifact);
  }
  return artifacts;
}

type CandidateCursor = { scope: string; value: string; key: string };
function candidateCursorScope(value: unknown): string {
  return createHash("sha256").update(stableJsonValue(value)).digest("hex");
}
function readCandidateCursor(cursor: string | undefined, scope: string): CandidateCursor | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      value.version !== 1 ||
      value.scope !== scope ||
      typeof value.value !== "string" ||
      typeof value.key !== "string" ||
      !value.key
    )
      throw new Error();
    return value;
  } catch {
    throw new RecruitingConflictError();
  }
}
function writeCandidateCursor(scope: string, value: string, key: string): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, value, key })).toString("base64url");
}

/** Latest source projection is selected by native read completion, never by backfill arrival. */
function candidateIndexQuery(
  roleId: string,
  sort?: CandidatesInput["sort"],
  rankDomainPageId?: string,
  displayScope?: Pick<CandidatesInput, "sourceEffectId" | "actionId">,
) {
  // ponytail: parse each saved page once; persist match fields only if large pools outgrow this projection.
  const includeMatches = sort !== undefined;
  const matchSort = sort === "rank" || sort === "tier" || sort === "score";
  const explicitSource =
    displayScope?.sourceEffectId !== undefined || displayScope?.actionId !== undefined;
  const sourceScope = Prisma.sql`${displayScope?.sourceEffectId !== undefined ? Prisma.sql`AND page."effectId" = ${displayScope.sourceEffectId}` : Prisma.empty}
    ${displayScope?.actionId !== undefined ? Prisma.sql`AND page."actionId" = ${displayScope.actionId}` : Prisma.empty}`;
  // ponytail: original ranks and scores are comparable only within one exact saved result.
  const rankCell = Prisma.sql`CASE WHEN returned.value ? 'updated_rank'
        THEN returned.value -> 'updated_rank'
        WHEN returned.value ? 'overall_rank' THEN returned.value -> 'overall_rank'
        WHEN returned.value ? 'rank' THEN returned.value -> 'rank'
        WHEN returned.value ? 'batch_rank' THEN returned.value -> 'batch_rank'
        ELSE returned.value -> 'rank_this_batch_only' END`;
  const matchValue = Prisma.sql`CASE WHEN source.kind = 'rank' THEN
      CASE WHEN jsonb_typeof(match."value") = 'number' THEN
        CASE WHEN (match."value" #>> '{}')::numeric BETWEEN 1 AND 9007199254740991
          AND trunc((match."value" #>> '{}')::numeric) = (match."value" #>> '{}')::numeric
          THEN (match."value" #>> '{}')::numeric::bigint END END
      WHEN source.kind = 'score' THEN
        CASE WHEN jsonb_typeof(match."value") = 'number' THEN
          CASE WHEN abs((match."value" #>> '{}')::numeric) <= ${Number.MAX_VALUE}::numeric
            THEN (match."value" #>> '{}')::numeric END END
      ELSE CASE match."value" #>> '{}'
        WHEN 'Strong' THEN 0 WHEN 'Promising' THEN 1 WHEN 'Partial' THEN 2 WHEN 'Uncertain' THEN 3 END END`;
  const fields = [
    ["name", "name"],
    ["title", "current_title"],
    ["company", "current_company"],
    ["location", "location"],
    ["linkedinUrl", "linkedin_url"],
    ["resumeUrl", "resume_url"],
    ["evidenceUrls", "evidence_urls"],
  ] as const;
  return Prisma.sql`WITH ${
    includeMatches
      ? Prisma.sql`rank_scope AS MATERIALIZED (
    SELECT ${
      rankDomainPageId === undefined
        ? Prisma.sql`(SELECT CASE WHEN count(*) = 1 THEN min("effectId") END FROM (
          SELECT "effectId" FROM "recruiting_candidate_pages" page WHERE "roleId" = ${roleId} ${sourceScope} LIMIT 2
        ) rank_pages)`
        : Prisma.sql`${rankDomainPageId}::text`
    } AS "pageId"
  ), match_rows AS MATERIALIZED (
    SELECT page."effectId" AS "pageId", page."observedAt", (returned.ordinality - 1)::int AS "rowIndex",
      source.kind, ${matchValue} AS value
    FROM "recruiting_candidate_pages" page
    JOIN "external_effects" effect ON effect."id" = page."effectId"
    CROSS JOIN LATERAL (
      SELECT COALESCE(effect."result"->'structuredContent', (
        SELECT CASE WHEN block->>'text' IS JSON OBJECT THEN (block->>'text')::jsonb END
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(effect."result"->'content') = 'array'
          THEN effect."result"->'content' ELSE '[]'::jsonb END) block
        WHERE block->>'type' = 'text' AND block->>'text' IS JSON OBJECT LIMIT 1
      )) AS body
    ) envelope
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(envelope.body->'rows') = 'array'
      THEN envelope.body->'rows' ELSE '[]'::jsonb END) WITH ORDINALITY returned(value, ordinality)
    CROSS JOIN rank_scope
    CROSS JOIN LATERAL (VALUES
      ('rank', ${rankCell},
        (rank_scope."pageId" IS NULL OR page."effectId" = rank_scope."pageId") AND
        (returned.value ? 'updated_rank' OR returned.value ? 'overall_rank' OR
          (rank_scope."pageId" IS NOT NULL AND
            (returned.value ? 'rank' OR returned.value ? 'batch_rank' OR returned.value ? 'rank_this_batch_only')))),
      ('tier', returned.value -> ${"match_tier"}, returned.value ? ${"match_tier"}),
      ('score', CASE WHEN returned.value ? 'match_score' THEN returned.value -> 'match_score'
        ELSE returned.value -> 'score' END,
        (returned.value ? 'match_score' OR returned.value ? 'score') AND
        rank_scope."pageId" IS NOT NULL AND page."effectId" = rank_scope."pageId")
    ) source(kind, cell, present)
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(source.cell) = 'object' AND source.cell ? 'value'
      THEN source.cell->'value' ELSE source.cell END AS "value") match
    WHERE page."roleId" = ${roleId}
      ${sourceScope}
      AND source.present
  ),`
      : Prisma.empty
  } base AS (
    SELECT c."roleId", c."candidateKey", c."shortlisted", c."revision",
      ${includeMatches ? Prisma.sql`match."rankValue", match."tierValue", match."scoreValue",` : Prisma.empty}
      ${matchSort ? Prisma.sql`match.${Prisma.raw(`"${sort}Value"`)} AS "matchValue",` : Prisma.empty}
      p."pageId" AS "sourcePageId", p."rowIndex" AS "sourceRowIndex",
      ${Prisma.join(
        fields.map(([column]) =>
          column === "evidenceUrls"
            ? Prisma.sql`profile.${Prisma.raw(`"${column}"`)}->'value' AS ${Prisma.raw(`"${column}"`)}`
            : Prisma.sql`profile.${Prisma.raw(`"${column}"`)}->>'value' AS ${Prisma.raw(`"${column}"`)}`,
        ),
      )},
      ${explicitSource ? Prisma.sql`profile."identifiedLinkedinUrl"` : Prisma.sql`profile."linkedinUrl"->>'value'`} IS NOT NULL AS "countIdentified",
      ARRAY(SELECT DISTINCT value->>'pageId' FROM (VALUES ${Prisma.join(
        fields.map(([column]) => Prisma.sql`(profile.${Prisma.raw(`"${column}"`)})`),
      )}) fields(value) WHERE value IS NOT NULL
      ${matchSort ? Prisma.sql`UNION SELECT match.${Prisma.raw(`"${sort}PageId"`)} WHERE match.${Prisma.raw(`"${sort}PageId"`)} IS NOT NULL` : Prisma.empty}) AS "profileSourcePageIds",
      COALESCE(p."issues", '[]'::jsonb) AS "issues",
      d."discoveryCount",
      to_char(d."firstDiscoveredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "firstDiscoveredAt",
      to_char(d."lastDiscoveredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastDiscoveredAt",
      a."version" AS "assessmentVersion", a."roleRevisionId" AS "assessmentRoleRevisionId",
      to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assessmentCreatedAt",
      a."judgments"->>'hardGate' AS "hardGate"
    FROM "recruiting_candidates" c
    LEFT JOIN LATERAL (
      SELECT o.* FROM "recruiting_candidate_occurrences" o
      JOIN "recruiting_candidate_pages" page ON page."effectId" = o."pageId"
      WHERE o."roleId" = c."roleId" AND o."candidateKey" = c."candidateKey"
        ${sourceScope}
      ORDER BY page."observedAt" DESC, page."effectId" COLLATE "C" DESC, o."rowIndex" DESC LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT ${Prisma.join(
        fields.map(
          ([column, key]) => Prisma.sql`(array_agg(
            jsonb_build_object('value', o.${Prisma.raw(`"${column}"`)}, 'pageId', o."pageId")
            ORDER BY page."observedAt" DESC, page."effectId" COLLATE "C" DESC, o."rowIndex" DESC
          ) FILTER (WHERE NOT (o."issues" ? ${`missing_field:${key}`}) ${sourceScope}))[1] AS ${Prisma.raw(`"${column}"`)}`,
        ),
      )}
      ${
        explicitSource
          ? Prisma.sql`, (array_agg(o."linkedinUrl"
        ORDER BY page."observedAt" DESC, page."effectId" COLLATE "C" DESC, o."rowIndex" DESC
      ) FILTER (WHERE NOT (o."issues" ? ${"missing_field:linkedin_url"})))[1] AS "identifiedLinkedinUrl"`
          : Prisma.empty
      }
      FROM "recruiting_candidate_occurrences" o
      JOIN "recruiting_candidate_pages" page ON page."effectId" = o."pageId"
      WHERE o."roleId" = c."roleId" AND o."candidateKey" = c."candidateKey"
    ) profile ON true
    ${
      includeMatches
        ? Prisma.sql`LEFT JOIN LATERAL (
      SELECT
        (array_agg(m.value ORDER BY m."observedAt" DESC, m."pageId" COLLATE "C" DESC, m."rowIndex" DESC)
          FILTER (WHERE m.kind = 'rank'))[1] AS "rankValue",
        (array_agg(m.value ORDER BY m."observedAt" DESC, m."pageId" COLLATE "C" DESC, m."rowIndex" DESC)
          FILTER (WHERE m.kind = 'tier'))[1] AS "tierValue",
        (array_agg(m.value ORDER BY m."observedAt" DESC, m."pageId" COLLATE "C" DESC, m."rowIndex" DESC)
          FILTER (WHERE m.kind = 'score'))[1] AS "scoreValue",
        (array_agg(m."pageId" ORDER BY m."observedAt" DESC, m."pageId" COLLATE "C" DESC, m."rowIndex" DESC)
          FILTER (WHERE m.kind = 'rank'))[1] AS "rankPageId",
        (array_agg(m."pageId" ORDER BY m."observedAt" DESC, m."pageId" COLLATE "C" DESC, m."rowIndex" DESC)
          FILTER (WHERE m.kind = 'tier'))[1] AS "tierPageId",
        (array_agg(m."pageId" ORDER BY m."observedAt" DESC, m."pageId" COLLATE "C" DESC, m."rowIndex" DESC)
          FILTER (WHERE m.kind = 'score'))[1] AS "scorePageId"
      FROM "recruiting_candidate_occurrences" o
      JOIN match_rows m ON m."pageId" = o."pageId" AND m."rowIndex" = o."rowIndex"
      WHERE o."roleId" = c."roleId" AND o."candidateKey" = c."candidateKey"
    ) match ON true`
        : Prisma.empty
    }
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS "discoveryCount", min(page."observedAt") AS "firstDiscoveredAt",
        max(page."observedAt") AS "lastDiscoveredAt"
      FROM "recruiting_candidate_occurrences" o
      JOIN "recruiting_candidate_pages" page ON page."effectId" = o."pageId"
      WHERE o."roleId" = c."roleId" AND o."candidateKey" = c."candidateKey"
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT "version", "roleRevisionId", "createdAt", "judgments" FROM "recruiting_assessments" a
      WHERE a."roleId" = c."roleId" AND a."candidateKey" = c."candidateKey"
      ORDER BY "version" DESC LIMIT 1
    ) a ON true
    WHERE c."roleId" = ${roleId}
  )`;
}

type CandidateQueryRow = {
  matchValue?: unknown;
  rankValue?: unknown;
  tierValue?: unknown;
  scoreValue?: unknown;
  sourcePageId: string | null;
  sourceRowIndex: number | null;
  profileSourcePageIds: string[];
  countIdentified: boolean;
  roleId: string;
  candidateKey: string;
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  resumeUrl: string | null;
  evidenceUrls: unknown;
  issues: unknown;
  shortlisted: boolean;
  revision: number;
  discoveryCount: number;
  firstDiscoveredAt: string | null;
  lastDiscoveredAt: string | null;
  assessmentVersion: number | null;
  assessmentRoleRevisionId: string | null;
  assessmentCreatedAt: string | null;
  hardGate: string | null;
  sortValue: string;
};

async function candidateProfilePages(
  tx: Tx,
  actor: Actor,
  roleId: string,
  rows: Pick<CandidateQueryRow, "sourcePageId" | "profileSourcePageIds">[],
) {
  const pageIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.sourcePageId ? [row.sourcePageId] : []),
        ...row.profileSourcePageIds,
      ]),
    ),
  ];
  const pages = new Map(
    (pageIds.length
      ? await tx.recruitingCandidatePage.findMany({
          where: { roleId, effectId: { in: pageIds } },
          include: { effect: { select: { request: true } } },
        })
      : []
    ).map((page) => [page.effectId, page]),
  );
  if (pages.size !== pageIds.length) throw new IsolationError();
  for (const page of pages.values()) {
    if (page.roleId !== roleId) throw new IsolationError();
  }
  await candidatePageArtifacts(tx, actor, [...pages.values()]);
  return pages;
}

async function crmReadTarget(
  tx: Tx,
  actor: Actor,
  run: { threadId: string; botId: string },
  effectId: string,
) {
  const effect = await tx.externalEffect.findFirst({
    where: { id: effectId, spaceId: actor.spaceId, status: "completed" },
  });
  if (!effect) throw new IsolationError();
  const owner = await requireRun(tx, actor, effect.runId);
  const target = extractRecruitingCrmTarget(effect);
  if (!target || owner.threadId !== run.threadId || owner.botId !== run.botId)
    throw new IsolationError();
  return target;
}

async function crmBindingReceipt(tx: Tx, actor: Actor, roleId: string, effectId: string) {
  const effect = await tx.externalEffect.findFirst({
    where: {
      id: effectId,
      spaceId: actor.spaceId,
      status: "completed",
      kind: "recruiting_crm_target",
    },
  });
  if (effect?.kind !== "recruiting_crm_target" || effect.status !== "completed")
    throw new IsolationError();
  const parsed = RecruitingCrmBindingInputSchema.safeParse(effect.request);
  if (!parsed.success || parsed.data.roleId !== roleId) throw new IsolationError();
  const { run } = await approvalAnswerProof(tx, actor, effect);
  const target = await crmReadTarget(tx, actor, run, parsed.data.crmRoleReadEffectId);
  const result = { status: "connected" as const, roleId, bindingEffectId: effect.id, target };
  if (stableJsonValue(effect.result) !== stableJsonValue(result)) throw new IsolationError();
  return result;
}

async function currentCrmServer(
  tx: Tx,
  actor: Actor,
  run: { botId: string },
  target: RecruitingCrmTarget,
) {
  const server = await tx.mcpServer.findFirst({
    where: { id: target.mcpServerId, spaceId: actor.spaceId, userId: actor.userId, enabled: true },
  });
  const assignment = await tx.botMcpServer.findFirst({
    where: {
      botId: run.botId,
      serverId: target.mcpServerId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  const allowed = assignment?.allowedTools;
  if (
    !server?.enabled ||
    server.revision !== target.serverRevision ||
    !assignment ||
    (!assignment.allowAllTools &&
      (!Array.isArray(allowed) ||
        !["get_crm_role", "crm_import_candidate"].every((tool) => allowed.includes(tool))))
  )
    throw new IsolationError();
}

async function nativeMcpReadProof(
  tx: Tx,
  actor: Actor,
  runId: string,
  route: { connectorId: string; resourceId: string; resourceRevision: number; toolName: string },
  args:
    | Record<string, unknown>
    | ((args: Record<string, unknown>, result: Record<string, unknown>) => boolean),
) {
  // ponytail: compare this run's native envelopes in O(n); index by route if long runs require it.
  const effects = await tx.externalEffect.findMany({
    where: { spaceId: actor.spaceId, runId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const seenQueries = new Set<string>();
  for (const effect of effects) {
    if (effect.spaceId !== actor.spaceId || effect.runId !== runId) throw new IsolationError();
    const marker = "__rakazoCatalogTool";
    const direct = boundDirectApprovalDetails(effect.request, marker);
    const catalog = catalogApprovalDetails(effect.request, marker);
    const nativeArgs = direct?.args ?? catalog?.args.arguments;
    if (!nativeArgs || typeof nativeArgs !== "object" || Array.isArray(nativeArgs)) continue;
    const readArgs = nativeArgs as Record<string, unknown>;
    // p_review verifies an additional audit receipt for the same pipeline read. A newer
    // failed verification must block an older successful snapshot too.
    const expectedArgs =
      typeof args === "function"
        ? readArgs
        : route.toolName === "get_crm_candidate_review" && "p_review" in readArgs
          ? { ...args, p_review: readArgs.p_review }
          : args;
    const expected = direct
      ? boundDirectApprovalRequest(route, expectedArgs, marker)
      : catalog && ["connectors_execute_tool", "mcp_execute_tool"].includes(catalog.toolName)
        ? catalogApprovalRequest(
            catalog.toolName,
            {
              id: `${route.resourceId}:${encodeURIComponent(route.toolName)}`,
              arguments: expectedArgs,
            },
            marker,
            route,
          )
        : null;
    if (!expected || stableJsonValue(effect.request) !== stableJsonValue(expected)) continue;
    // Discovery considers only the newest native receipt for each exact query,
    // including failed or empty reads; a different query can still prove the target.
    const queryKey = stableJsonValue(expectedArgs);
    if (seenQueries.has(queryKey)) continue;
    seenQueries.add(queryKey);
    const result = effect.result;
    if (
      effect.status !== "completed" ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (result.isError !== undefined && result.isError !== false) ||
      result.error !== undefined
    ) {
      if (typeof args === "function") continue;
      return null;
    }
    if (typeof args === "function" && !args(readArgs, result)) continue;
    return { effectId: effect.id, result };
  }
  return null;
}

/** Display only a canonical CRM target read by this bot; the write keeps its original payload. */
export async function readNativeCrmWriteApproval(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { threadId: string; botId: string },
  input: {
    route: { connectorId: string; resourceId: string; resourceRevision: number; toolName: string };
    args: Record<string, unknown>;
  },
) {
  const { route, args } = input;
  const stage = route.toolName === "crm_update_candidate_stage";
  const binding = route.toolName === "crm_bind_candidate_role";
  if (
    route.connectorId !== "mcp" ||
    (!binding && !stage && route.toolName !== "crm_append_candidate_note") ||
    !route.resourceId?.trim() ||
    !Number.isSafeInteger(route.resourceRevision) ||
    route.resourceRevision < 1 ||
    ![
      args.p_org,
      args.p_candidate,
      args.p_role,
      ...(binding ? [] : [args.p_expected_updated_at]),
    ].every((value) => typeof value === "string" && value.trim()) ||
    (binding
      ? ![args.p_org, args.p_candidate, args.p_role].every(
          (value) => RecruitingCrmImportArgsSchema.shape.p_org.safeParse(value).success,
        )
      : stage
        ? ![args.p_expected_stage, args.p_stage].every(
            (value) => value === null || typeof value === "string",
          )
        : (args.p_expected_notes !== null && typeof args.p_expected_notes !== "string") ||
          typeof args.p_note !== "string" ||
          !args.p_note.trim())
  )
    throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId);
    requireResearchLease(run, trusted);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    await requireReplyAssignment(tx, actor, run, route.resourceId, route.resourceRevision, [
      ...(binding ? ["list_crm_candidates", "get_crm_role"] : ["get_crm_candidate_review"]),
      route.toolName,
    ]);
    if (binding) {
      const proof = await nativeMcpReadProof(
        tx,
        actor,
        run.id,
        { ...route, toolName: "list_crm_candidates" },
        (readArgs, result) => {
          const data = result.structuredContent as { data?: { rows?: unknown } } | undefined;
          return (
            readArgs.p_org === args.p_org &&
            Array.isArray(data?.data?.rows) &&
            data.data.rows.some(
              (row) =>
                row &&
                typeof row === "object" &&
                !Array.isArray(row) &&
                row.candidate_id === args.p_candidate,
            )
          );
        },
      );
      const rows = (
        proof?.result.structuredContent as
          | { data?: { rows?: Record<string, unknown>[] } }
          | undefined
      )?.data?.rows;
      const candidates = rows?.filter((row) => row?.candidate_id === args.p_candidate);
      const roleProof = await nativeMcpReadProof(
        tx,
        actor,
        run.id,
        { ...route, toolName: "get_crm_role" },
        { p_org: args.p_org, p_role: args.p_role },
      );
      const role = (
        roleProof?.result.structuredContent as { data?: Record<string, unknown> } | undefined
      )?.data;
      if (
        candidates?.length !== 1 ||
        !role ||
        typeof role !== "object" ||
        Array.isArray(role) ||
        role.role_spec_id !== args.p_role ||
        !RecruitingCrmImportArgsSchema.shape.p_org.safeParse(role.client_id).success ||
        ![candidates[0]?.full_name, role.role_label, role.client_label].every(
          (value) =>
            typeof value === "string" && value.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
        )
      )
        throw new IsolationError();
      return {
        candidateName: candidates[0]!.full_name as string,
        roleTitle: role.role_label as string,
        clientName: role.client_label as string,
      };
    }
    const proof = await nativeMcpReadProof(
      tx,
      actor,
      run.id,
      { ...route, toolName: "get_crm_candidate_review" },
      { p_org: args.p_org, p_candidate: args.p_candidate },
    );
    const result = proof?.result;
    const structured =
      result && typeof result === "object" && !Array.isArray(result)
        ? result.structuredContent
        : null;
    const row =
      structured && typeof structured === "object" && !Array.isArray(structured)
        ? structured.data
        : null;
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      row.organization_id !== args.p_org ||
      row.candidate_id !== args.p_candidate ||
      row.role_spec_id !== args.p_role ||
      row.updated_at !== args.p_expected_updated_at ||
      ![row.candidate_full_name, row.canonical_role_title].every(
        (value) =>
          typeof value === "string" && value.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
      ) ||
      (stage ? row.stage !== args.p_expected_stage : row.notes !== args.p_expected_notes)
    )
      throw new IsolationError();
    return {
      candidateName: row.candidate_full_name as string,
      roleTitle: row.canonical_role_title as string,
      ...(stage
        ? {
            currentStage: args.p_expected_stage as string | null,
            newStage: args.p_stage as string | null,
          }
        : { note: args.p_note as string }),
    };
  });
}

/** Retained native source identity only: this grants neither freshness nor send approval. */
export async function readNativeReplyEmailProof(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: {
    route: {
      connectorId: "mcp";
      resourceId: string;
      resourceRevision: number;
      toolName: "reply_to_email";
    };
    replyToEmailId: string;
  },
) {
  const route = input?.route;
  if (
    route?.connectorId !== "mcp" ||
    route.toolName !== "reply_to_email" ||
    typeof route.resourceId !== "string" ||
    !route.resourceId.trim() ||
    !Number.isSafeInteger(route.resourceRevision) ||
    route.resourceRevision < 1 ||
    typeof input.replyToEmailId !== "string" ||
    !input.replyToEmailId.trim()
  )
    throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId);
    requireResearchLease(run, trusted);
    const server = await tx.mcpServer.findFirst({
      where: { id: route.resourceId, spaceId: actor.spaceId, userId: actor.userId, enabled: true },
    });
    const assignment = await tx.botMcpServer.findFirst({
      where: {
        serverId: route.resourceId,
        botId: run.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    });
    const allowed = assignment?.allowedTools;
    if (
      !server?.enabled ||
      server.id !== route.resourceId ||
      server.spaceId !== actor.spaceId ||
      server.userId !== actor.userId ||
      server.revision !== route.resourceRevision ||
      !assignment ||
      (!assignment.allowAllTools &&
        (!Array.isArray(allowed) ||
          !["get_email", "reply_to_email"].every((tool) => allowed.includes(tool))))
    )
      throw new IsolationError();
    const readRoute = {
      connectorId: "mcp",
      resourceId: route.resourceId,
      resourceRevision: route.resourceRevision,
      toolName: "get_email",
    };
    return nativeMcpReadProof(tx, actor, run.id, readRoute, { id: input.replyToEmailId });
  });
}

export async function getRecruitingCrmTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { runId: string; roleId: string },
) {
  return prisma.$transaction(async (tx) => {
    const run = await requireRun(tx, actor, input.runId);
    const thread = await requireThread(tx, actor, run.threadId);
    const role = await requireRole(tx, actor, input.roleId);
    if (thread.activeRecruitingRoleId !== role.id) throw new IsolationError();
    const bound = role.crmBindingEffectId
      ? await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId)
      : null;
    return {
      roleId: role.id,
      bindingEffectId: bound?.bindingEffectId ?? null,
      target: bound?.target ?? null,
    };
  });
}

async function prepareCrmBinding(
  tx: Tx,
  actor: Actor,
  trusted: RecruitingApprovalContext,
  input: ReturnType<typeof RecruitingCrmBindingInputSchema.parse>,
) {
  const { run, thread } = await lockLiveRecruitingRun(tx, actor, trusted.runId);
  requireResearchLease(run, trusted);
  if (run.threadId !== trusted.threadId || run.botId !== trusted.botId) throw new IsolationError();
  const role = await requireRole(tx, actor, input.roleId, true);
  if (thread.activeRecruitingRoleId !== role.id) throw new IsolationError();
  if (
    role.revision !== input.expectedRoleRevision ||
    (role.crmBindingEffectId ?? null) !== input.expectedBindingEffectId
  )
    throw new RecruitingConflictError();
  const target = await crmReadTarget(tx, actor, run, input.crmRoleReadEffectId);
  await currentCrmServer(tx, actor, run, target);
  return { target, roleTitle: role.title, role, run };
}

export async function prepareRecruitingCrmBinding(
  prisma: PrismaClient,
  actor: Actor,
  trusted: RecruitingApprovalContext,
  raw: unknown,
) {
  const input = RecruitingCrmBindingInputSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const { target, roleTitle } = await prepareCrmBinding(tx, actor, trusted, input);
    return { target, roleTitle };
  });
}

export async function executeRecruitingCrmBinding(
  prisma: PrismaClient,
  actor: Actor,
  trusted: RecruitingApprovalContext & { effectId: string; effectRequest: unknown },
  raw: unknown,
) {
  const input = RecruitingCrmBindingInputSchema.parse(raw);
  if (stableJsonValue(input) !== stableJsonValue(trusted.effectRequest)) throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    const role = await requireRole(tx, actor, input.roleId, true);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${trusted.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: trusted.effectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_crm_target",
      },
    });
    if (
      effect?.kind !== "recruiting_crm_target" ||
      effect.runId !== run.id ||
      stableJsonValue(effect.request) !== stableJsonValue(input)
    )
      throw new IsolationError();
    if (effect.status === "completed") return crmBindingReceipt(tx, actor, role.id, effect.id);
    if (effect.status !== "executing") throw new IsolationError();
    const { target } = await prepareCrmBinding(tx, actor, trusted, input);
    await approvalAnswerProof(tx, actor, effect);
    const changed = await tx.recruitingRole.updateMany({
      where: {
        id: role.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        revision: input.expectedRoleRevision,
        currentRevisionId: role.currentRevisionId,
        crmBindingEffectId: input.expectedBindingEffectId,
      },
      data: { crmBindingEffectId: effect.id },
    });
    if (changed.count !== 1) throw new RecruitingConflictError();
    const result = {
      status: "connected" as const,
      roleId: role.id,
      bindingEffectId: effect.id,
      target,
    };
    const completed = await tx.externalEffect.updateMany({
      where: { id: effect.id, spaceId: actor.spaceId, runId: run.id, status: "executing" },
      data: { status: "completed", result },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: { effectId: effect.id, tool: "recruiting_crm_target", ...result },
    });
    return result;
  });
}

async function crmImportSource(tx: Tx, actor: Actor, input: RecruitingCrmImportInput) {
  const occurrence = await tx.recruitingCandidateOccurrence.findUnique({
    where: { pageId_rowIndex: { pageId: input.sourceEffectId, rowIndex: input.rowIndex } },
    include: { page: true },
  });
  if (
    !occurrence ||
    occurrence.roleId !== input.roleId ||
    occurrence.candidateKey !== input.candidateKey
  )
    throw new IsolationError();
  const { page } = occurrence;
  await candidatePageArtifact(tx, actor, page, true);
  if (page.rowCount === null || input.rowIndex >= page.rowCount) throw new IsolationError();
  const identity = occurrence.linkedinUrl
    ? recruitingCalibrationIdentity(occurrence.linkedinUrl)
    : null;
  if (!identity || occurrence.candidateKey !== `linkedin:${identity}` || !occurrence.name?.trim())
    throw new IsolationError();
  return occurrence;
}

function crmImportArgs(
  target: RecruitingCrmTarget,
  source: Prisma.RecruitingCandidateOccurrenceGetPayload<{ include: { page: true } }>,
) {
  return RecruitingCrmImportArgsSchema.parse({
    p_org: target.organizationId,
    p_role: target.crmRoleId,
    p_name: source.name,
    p_linkedin_url: source.linkedinUrl,
    p_source_file: `rakazo:artifact:${source.page.artifactId}:sha256:${source.page.artifactHash}:row:${source.rowIndex}`,
    ...(source.title ? { p_title: source.title } : {}),
    ...(source.company ? { p_company: source.company } : {}),
    ...(source.location ? { p_location: source.location } : {}),
  });
}

function assertCrmImportRequest(
  request: unknown,
  route: { connectorId: string; resourceId: string; resourceRevision: number; toolName: string },
  args: Record<string, unknown>,
) {
  const direct = boundDirectApprovalDetails(request, "__rakazoCatalogTool");
  const catalog = catalogApprovalDetails(request, "__rakazoCatalogTool");
  const expected = direct
    ? boundDirectApprovalRequest(route, args, "__rakazoCatalogTool")
    : catalog
      ? catalogApprovalRequest(
          catalog.toolName,
          { id: `${route.resourceId}:${encodeURIComponent(route.toolName)}`, arguments: args },
          "__rakazoCatalogTool",
          route,
        )
      : null;
  if (!expected || stableJsonValue(request) !== stableJsonValue(expected))
    throw new IsolationError();
}

function crmImportKey(input: RecruitingCrmImportInput) {
  return `recruiting-crm-import:${stableJsonValue([input.bindingEffectId, input.sourceEffectId, input.rowIndex])}`;
}

async function crmImportContext(
  tx: Tx,
  actor: Actor,
  trusted: ResearchLease & { approvedEffectId?: string },
  raw: RecruitingCrmImportInput | null,
) {
  const { run, thread } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
  let input = raw;
  if (trusted.approvedEffectId) {
    const approvedLink = await tx.recruitingCrmImport.findUnique({
      where: { effectId: trusted.approvedEffectId },
      include: { occurrence: true },
    });
    if (approvedLink) {
      const approved = await tx.externalEffect.findFirst({
        where: {
          id: trusted.approvedEffectId,
          spaceId: actor.spaceId,
          runId: run.id,
          status: "approved",
        },
      });
      if (approved?.status !== "approved" || approved.runId !== run.id) throw new IsolationError();
      await approvalAnswerProof(tx, actor, approved);
      input = {
        roleId: approvedLink.occurrence.roleId,
        candidateKey: approvedLink.occurrence.candidateKey,
        bindingEffectId: approvedLink.bindingEffectId,
        sourceEffectId: approvedLink.pageId,
        rowIndex: approvedLink.rowIndex,
      };
    }
  }
  if (input === null) return null;
  input = RecruitingCrmImportInputSchema.parse(input);
  const role = await requireRole(tx, actor, input.roleId, true);
  const binding = await crmBindingReceipt(tx, actor, role.id, input.bindingEffectId);
  const source = await crmImportSource(tx, actor, input);
  const args = crmImportArgs(binding.target, source);
  const route = {
    connectorId: "mcp",
    resourceId: binding.target.mcpServerId,
    resourceRevision: binding.target.serverRevision,
    toolName: "crm_import_candidate",
  };
  const link = await tx.recruitingCrmImport.findUnique({
    where: {
      bindingEffectId_pageId_rowIndex: {
        bindingEffectId: input.bindingEffectId,
        pageId: input.sourceEffectId,
        rowIndex: input.rowIndex,
      },
    },
    include: { effect: true },
  });
  const effect = link?.effect;
  if (effect) {
    await requireRun(tx, actor, effect.runId);
    if (effect.spaceId !== actor.spaceId || effect.idempotencyKey !== crmImportKey(input))
      throw new IsolationError();
    assertCrmImportRequest(effect.request, route, args);
  }
  if (!effect || (effect.runId === run.id && ["intended", "approved"].includes(effect.status))) {
    requireResearchLease(run, trusted);
    if (
      thread.activeRecruitingRoleId !== role.id ||
      role.crmBindingEffectId !== input.bindingEffectId
    )
      throw new RecruitingConflictError();
    await currentCrmServer(tx, actor, run, binding.target);
  } else if (effect.status === "executing") requireResearchLease(run, trusted);
  return { input, target: binding.target, args, route, effect, run };
}

export async function resolveRecruitingCrmImport(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { approvedEffectId?: string },
  input: RecruitingCrmImportInput | null,
) {
  return prisma.$transaction(async (tx) => {
    const resolved = await crmImportContext(tx, actor, trusted, input);
    if (!resolved) return null;
    const { run: _run, ...result } = resolved;
    return result;
  });
}

export async function admitRecruitingCrmImport(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: RecruitingCrmImportInput,
  native: { effectKind: string; effectRequest: unknown },
) {
  return prisma.$transaction(async (tx) => {
    const resolved = await crmImportContext(tx, actor, trusted, input);
    if (!resolved) throw new IsolationError();
    let { effect } = resolved;
    if (!effect) {
      if (!native.effectKind) throw new IsolationError();
      assertCrmImportRequest(native.effectRequest, resolved.route, resolved.args);
      if (await tx.externalEffect.findUnique({ where: { idempotencyKey: crmImportKey(input) } }))
        throw new IsolationError();
      effect = await tx.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: trusted.runId,
          kind: native.effectKind,
          idempotencyKey: crmImportKey(input),
          status: "intended",
          request: native.effectRequest as Prisma.InputJsonValue,
        },
      });
      await tx.recruitingCrmImport.create({
        data: {
          effectId: effect.id,
          bindingEffectId: input.bindingEffectId,
          pageId: input.sourceEffectId,
          rowIndex: input.rowIndex,
        },
      });
    }
    if (effect.status === "completed") return { status: "completed" as const, effect };
    if (effect.status === "denied") return { status: "denied" as const, effect };
    if (effect.status === "uncertain") return { status: "unknown" as const, effect };
    const owner = await tx.run.findUniqueOrThrow({ where: { id: effect.runId } });
    const live =
      ["queued", "leased", "waiting_input"].includes(owner.status) ||
      (owner.status === "running" &&
        owner.leaseExpiresAt &&
        owner.leaseExpiresAt.getTime() > Date.now());
    if (effect.runId !== trusted.runId && live) return { status: "busy" as const, effect };
    if (effect.status === "executing") return { status: "unknown" as const, effect };
    if (
      effect.runId !== trusted.runId ||
      ["cancelled", "failed", "completed"].includes(owner.status)
    )
      return { status: "stopped" as const, effect };
    if (
      !["intended", "approved"].includes(effect.status) ||
      effect.kind !== native.effectKind ||
      stableJsonValue(effect.request) !== stableJsonValue(native.effectRequest)
    )
      throw new IsolationError();
    return { status: "ready" as const, effect };
  });
}

export async function claimRecruitingCrmImport(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: RecruitingCrmImportInput,
  native: {
    effectId: string;
    effectKind: string;
    effectRequest: unknown;
    from: "approved" | "intended";
  },
) {
  return prisma.$transaction(async (tx) => {
    const resolved = await crmImportContext(tx, actor, trusted, input);
    if (!resolved?.effect) throw new IsolationError();
    requireResearchLease(resolved.run, trusted);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${native.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: { id: native.effectId, spaceId: actor.spaceId, runId: trusted.runId },
    });
    if (
      !effect ||
      effect.id !== resolved.effect.id ||
      effect.kind !== native.effectKind ||
      effect.runId !== trusted.runId ||
      stableJsonValue(effect.request) !== stableJsonValue(native.effectRequest)
    )
      throw new IsolationError();
    if (effect.status !== native.from || !["approved", "intended"].includes(native.from))
      return false;
    assertCrmImportRequest(effect.request, resolved.route, resolved.args);
    await approvalAnswerProof(tx, actor, effect);
    const changed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        spaceId: actor.spaceId,
        runId: trusted.runId,
        status: native.from,
        request: { equals: effect.request as Prisma.InputJsonValue },
      },
      data: { status: "executing" },
    });
    return changed.count === 1;
  });
}

type ReplyLink = Prisma.RecruitingReplyGetPayload<{
  include: { effect: true; roleRevision: true };
}>;

function replyNativeCall(request: unknown, operation: string) {
  const direct = boundDirectApprovalDetails(request, "__rakazoCatalogTool");
  const catalog = catalogApprovalDetails(request, "__rakazoCatalogTool");
  const saved = direct?.route ?? catalog?.route;
  const args = direct?.args ?? catalog?.args.arguments;
  if (
    saved?.connectorId !== "mcp" ||
    saved.toolName !== operation ||
    !saved.resourceId.trim() ||
    typeof saved.resourceRevision !== "number" ||
    !Number.isSafeInteger(saved.resourceRevision) ||
    saved.resourceRevision < 1 ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    (catalog && !["connectors_execute_tool", "mcp_execute_tool"].includes(catalog.toolName))
  )
    throw new IsolationError();
  const route = {
    connectorId: "mcp" as const,
    resourceId: saved.resourceId,
    resourceRevision: saved.resourceRevision,
    toolName: operation,
  };
  assertCrmImportRequest(request, route, args as Record<string, unknown>);
  return { route, args: args as Record<string, unknown> };
}

async function replyLinkTarget(tx: Tx, actor: Actor, link: ReplyLink) {
  const owner = await requireRun(tx, actor, link.effect.runId);
  if (link.effect.spaceId !== actor.spaceId) throw new IsolationError();
  const email = await tx.externalEffect.findFirst({
    where: { id: link.emailReadEffectId, spaceId: actor.spaceId, runId: owner.id },
  });
  if (!email || email.spaceId !== actor.spaceId || email.runId !== owner.id)
    throw new IsolationError();
  const call = replyNativeCall(email.request, "get_email");
  if (Object.keys(call.args).length !== 1 || typeof call.args.id !== "string")
    throw new IsolationError();
  const input = RecruitingReplyTargetSchema.parse({
    roleId: link.roleRevision.roleId,
    expectedRoleRevision: link.roleRevision.revision,
    crmImportEffectId: link.crmImportEffectId,
    mcpServerId: call.route.resourceId,
    serverRevision: call.route.resourceRevision,
    replyToEmailId: call.args.id,
  });
  const reply = replyNativeCall(link.effect.request, "reply_to_email");
  if (
    stableJsonValue(reply.route) !== stableJsonValue({ ...call.route, toolName: "reply_to_email" })
  )
    throw new IsolationError();
  return input;
}

async function requireReplyAssignment(
  tx: Tx,
  actor: Actor,
  run: { botId: string },
  serverId: string,
  revision: number,
  tools: readonly string[],
) {
  const server = await tx.mcpServer.findFirst({
    where: { id: serverId, spaceId: actor.spaceId, userId: actor.userId, enabled: true },
  });
  const assignment = await tx.botMcpServer.findFirst({
    where: { serverId, botId: run.botId, spaceId: actor.spaceId, userId: actor.userId },
  });
  const allowed = assignment?.allowedTools;
  if (
    !server?.enabled ||
    server.id !== serverId ||
    server.spaceId !== actor.spaceId ||
    server.userId !== actor.userId ||
    server.revision !== revision ||
    !assignment ||
    (!assignment.allowAllTools &&
      (!Array.isArray(allowed) || !tools.every((tool) => allowed.includes(tool))))
  )
    throw new IsolationError();
}

async function retainedReplyProof(
  tx: Tx,
  actor: Actor,
  runId: string,
  effectId: string,
  route: { connectorId: string; resourceId: string; resourceRevision: number; toolName: string },
  args: Record<string, unknown>,
) {
  const effect = await tx.externalEffect.findFirst({
    where: { id: effectId, spaceId: actor.spaceId, runId, status: "completed" },
  });
  if (
    !effect ||
    effect.spaceId !== actor.spaceId ||
    effect.runId !== runId ||
    effect.status !== "completed"
  )
    throw new IsolationError();
  await requireRun(tx, actor, effect.runId);
  replyNativeCall(effect.request, route.toolName);
  assertCrmImportRequest(effect.request, route, args);
  const result = effect.result;
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result.isError !== undefined && result.isError !== false) ||
    result.error !== undefined
  )
    throw new IsolationError();
  return { effectId: effect.id, result };
}

async function replyContext(
  tx: Tx,
  actor: Actor,
  trusted: ResearchLease & { approvedEffectId?: string },
  raw: RecruitingReplyTarget | null,
) {
  const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
  let input = raw;
  let link: ReplyLink | null = null;
  if (trusted.approvedEffectId) {
    link = await tx.recruitingReply.findUnique({
      where: { effectId: trusted.approvedEffectId },
      include: { effect: true, roleRevision: true },
    });
    if (link) {
      if (link.effect.runId !== run.id || link.effect.status !== "approved")
        throw new IsolationError();
      await approvalAnswerProof(tx, actor, link.effect);
      input = await replyLinkTarget(tx, actor, link);
    }
  }
  if (input === null) return null;
  input = RecruitingReplyTargetSchema.parse(input);
  const role = await requireRole(tx, actor, input.roleId, true);
  if (!link) {
    // ponytail: scan this import's reply links; add an anchor index if long-lived imports require it.
    const links = await tx.recruitingReply.findMany({
      where: { crmImportEffectId: input.crmImportEffectId },
      include: { effect: true, roleRevision: true },
    });
    for (const candidate of links) {
      const saved = await replyLinkTarget(tx, actor, candidate);
      if (
        saved.roleId === input.roleId &&
        saved.mcpServerId === input.mcpServerId &&
        saved.replyToEmailId === input.replyToEmailId
      ) {
        if (link) throw new IsolationError();
        link = candidate;
        input = saved;
      }
    }
  }
  const imported = await tx.recruitingCrmImport.findUnique({
    where: { effectId: input.crmImportEffectId },
    include: { effect: true, occurrence: true },
  });
  if (!imported || imported.occurrence.roleId !== input.roleId) throw new IsolationError();
  const importInput = {
    roleId: input.roleId,
    candidateKey: imported.occurrence.candidateKey,
    bindingEffectId: imported.bindingEffectId,
    sourceEffectId: imported.pageId,
    rowIndex: imported.rowIndex,
  };
  const bound = await crmBindingReceipt(tx, actor, input.roleId, imported.bindingEffectId);
  const source = await crmImportSource(tx, actor, importInput);
  await requireRun(tx, actor, imported.effect.runId);
  if (
    imported.effect.spaceId !== actor.spaceId ||
    imported.effect.idempotencyKey !== crmImportKey(importInput)
  )
    throw new IsolationError();
  const importArgs = crmImportArgs(bound.target, source);
  const crmImportReceipt = parseRecruitingCrmImportReceipt(
    imported.effect,
    bound.target,
    importArgs,
  );
  if (!crmImportReceipt) throw new IsolationError();
  const effect = link?.effect;
  const current =
    !effect || (effect.runId === run.id && ["intended", "approved"].includes(effect.status));
  const workspace = await approvalWorkspace(tx, actor, run.threadId, input, current, current);
  if (current) {
    requireResearchLease(run, trusted);
    if (role.crmBindingEffectId !== imported.bindingEffectId) throw new RecruitingConflictError();
    await requireReplyAssignment(
      tx,
      actor,
      run,
      bound.target.mcpServerId,
      bound.target.serverRevision,
      ["get_crm_candidate_outreach_context"],
    );
    await requireReplyAssignment(tx, actor, run, input.mcpServerId, input.serverRevision, [
      "get_email",
      "list_emails",
      "reply_to_email",
    ]);
  }
  const route = {
    connectorId: "mcp" as const,
    resourceId: input.mcpServerId,
    resourceRevision: input.serverRevision,
    toolName: "reply_to_email" as const,
  };
  const emailRoute = { ...route, toolName: "get_email" };
  const crmRoute = {
    connectorId: "mcp",
    resourceId: bound.target.mcpServerId,
    resourceRevision: bound.target.serverRevision,
    toolName: "get_crm_candidate_outreach_context",
  };
  const crmArgs = {
    p_org: crmImportReceipt.organization_id,
    p_candidate: crmImportReceipt.candidate_id,
  };
  const emailProof = link
    ? await retainedReplyProof(tx, actor, link.effect.runId, link.emailReadEffectId, emailRoute, {
        id: input.replyToEmailId,
      })
    : await nativeMcpReadProof(tx, actor, run.id, emailRoute, { id: input.replyToEmailId });
  const crmProof = link
    ? await retainedReplyProof(
        tx,
        actor,
        link.effect.runId,
        link.crmContextReadEffectId,
        crmRoute,
        crmArgs,
      )
    : await nativeMcpReadProof(tx, actor, run.id, crmRoute, crmArgs);
  if (!emailProof || !crmProof) throw new IsolationError();
  return {
    input,
    target: bound.target,
    crmImportReceipt,
    role: workspace.role,
    roleRevision: workspace.revision,
    route,
    emailProof,
    crmProof,
    effect,
    link,
    run,
  };
}

export async function resolveRecruitingReply(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { approvedEffectId?: string },
  input: RecruitingReplyTarget | null,
) {
  return prisma.$transaction(async (tx) => {
    const resolved = await replyContext(tx, actor, trusted, input);
    if (!resolved) return null;
    const { run: _run, link: _link, ...result } = resolved;
    return result;
  });
}

export type RecruitingReplyNative = {
  effectKind: string;
  effectRequest: unknown;
  identity: {
    providerWorkspaceId: string;
    account: string;
    threadId: string;
    anchorId: string;
    crmCandidateId: string;
  };
  emailReadEffectId: string;
  crmContextReadEffectId: string;
};

function replyKey(identity: RecruitingReplyNative["identity"]) {
  if (
    !identity ||
    [
      identity.providerWorkspaceId,
      identity.account,
      identity.threadId,
      identity.anchorId,
      identity.crmCandidateId,
    ].some((value) => typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value))
  )
    throw new IsolationError();
  const at = identity.account.lastIndexOf("@");
  const account =
    at < 0
      ? identity.account
      : identity.account.slice(0, at + 1) + identity.account.slice(at + 1).toLowerCase();
  return `recruiting-reply:${stableJsonValue([identity.providerWorkspaceId, account, identity.threadId, identity.anchorId])}`;
}

function assertReplyNative(
  resolved: NonNullable<Awaited<ReturnType<typeof replyContext>>>,
  native: RecruitingReplyNative,
) {
  if (
    !native.effectKind.trim() ||
    native.emailReadEffectId !== resolved.emailProof.effectId ||
    native.crmContextReadEffectId !== resolved.crmProof.effectId ||
    native.identity.crmCandidateId !== resolved.crmImportReceipt.candidate_id ||
    native.identity.anchorId !== resolved.input.replyToEmailId
  )
    throw new IsolationError();
  const call = replyNativeCall(native.effectRequest, "reply_to_email");
  if (stableJsonValue(call.route) !== stableJsonValue(resolved.route)) throw new IsolationError();
}

/** One immutable native draft per provider inbound round; this does not authorize a send. */
export async function admitRecruitingReply(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: RecruitingReplyTarget,
  native: RecruitingReplyNative,
) {
  const key = replyKey(native.identity);
  return prisma.$transaction(async (tx) => {
    const resolved = await replyContext(tx, actor, trusted, input);
    if (!resolved) throw new IsolationError();
    assertReplyNative(resolved, native);
    // Reuse native per-key transaction locks so different roles cannot race the global effect key.
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lock"`,
    );
    let effect = await tx.externalEffect.findUnique({ where: { idempotencyKey: key } });
    const existed = !!effect;
    if (!effect) {
      if (resolved.effect) throw new IsolationError();
      effect = await tx.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: trusted.runId,
          kind: native.effectKind,
          idempotencyKey: key,
          status: "intended",
          request: native.effectRequest as Prisma.InputJsonValue,
        },
      });
      await tx.recruitingReply.create({
        data: {
          effectId: effect.id,
          roleRevisionId: resolved.roleRevision.id,
          crmImportEffectId: resolved.input.crmImportEffectId,
          emailReadEffectId: resolved.emailProof.effectId,
          crmContextReadEffectId: resolved.crmProof.effectId,
        },
      });
    } else {
      if (effect.spaceId !== actor.spaceId) throw new IsolationError();
      await requireRun(tx, actor, effect.runId);
      const link = await tx.recruitingReply.findUnique({
        where: { effectId: effect.id },
        include: { effect: true, roleRevision: true },
      });
      if (!link) throw new IsolationError();
      await replyLinkTarget(tx, actor, link);
    }
    if (effect.status === "completed") return { status: "completed" as const, effect };
    if (effect.status === "denied") return { status: "denied" as const, effect };
    if (effect.status === "uncertain") return { status: "unknown" as const, effect };
    const owner = await tx.run.findUniqueOrThrow({ where: { id: effect.runId } });
    const live =
      ["queued", "leased", "waiting_input", "waiting_takeover"].includes(owner.status) ||
      (owner.status === "running" &&
        owner.leaseExpiresAt &&
        owner.leaseExpiresAt.getTime() > Date.now());
    if (effect.runId !== trusted.runId && live) return { status: "busy" as const, effect };
    if (effect.status === "executing") return { status: "unknown" as const, effect };
    if (
      effect.runId !== trusted.runId ||
      ["cancelled", "failed", "completed"].includes(owner.status)
    )
      return { status: "stopped" as const, effect };
    if (!["intended", "approved"].includes(effect.status)) throw new IsolationError();
    if (
      existed &&
      (!resolved.link ||
        resolved.link.effectId !== effect.id ||
        resolved.link.roleRevisionId !== resolved.roleRevision.id ||
        resolved.link.crmImportEffectId !== resolved.input.crmImportEffectId ||
        resolved.link.emailReadEffectId !== native.emailReadEffectId ||
        resolved.link.crmContextReadEffectId !== native.crmContextReadEffectId)
    )
      throw new RecruitingConflictError();
    if (
      effect.kind !== native.effectKind ||
      stableJsonValue(effect.request) !== stableJsonValue(native.effectRequest)
    )
      throw new RecruitingConflictError();
    return { status: "ready" as const, effect };
  });
}

export async function claimRecruitingReply(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: RecruitingReplyTarget,
  native: RecruitingReplyNative & { effectId: string; from: "approved" },
) {
  const key = replyKey(native.identity);
  return prisma.$transaction(async (tx) => {
    const resolved = await replyContext(tx, actor, trusted, input);
    if (!resolved?.effect || !resolved.link) throw new IsolationError();
    requireResearchLease(resolved.run, trusted);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${native.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: { id: native.effectId, spaceId: actor.spaceId, runId: trusted.runId },
    });
    if (
      !effect ||
      effect.id !== resolved.effect.id ||
      effect.runId !== trusted.runId ||
      effect.spaceId !== actor.spaceId ||
      effect.idempotencyKey !== key ||
      effect.kind !== native.effectKind ||
      stableJsonValue(effect.request) !== stableJsonValue(native.effectRequest)
    )
      throw new IsolationError();
    if (native.from !== "approved") throw new IsolationError();
    if (effect.status !== "approved") return false;
    assertReplyNative(resolved, native);
    if (
      resolved.link.roleRevisionId !== resolved.roleRevision.id ||
      resolved.link.crmImportEffectId !== resolved.input.crmImportEffectId ||
      resolved.link.emailReadEffectId !== native.emailReadEffectId ||
      resolved.link.crmContextReadEffectId !== native.crmContextReadEffectId
    )
      throw new IsolationError();
    await approvalAnswerProof(tx, actor, effect);
    const changed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        spaceId: actor.spaceId,
        runId: trusted.runId,
        status: "approved",
        request: { equals: effect.request as Prisma.InputJsonValue },
        run: {
          status: "running",
          leaseOwner: trusted.leaseOwner,
          leaseFence: trusted.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
      },
      data: { status: "executing" },
    });
    return changed.count === 1;
  });
}

async function crmSourceSync(
  tx: Tx,
  actor: Actor,
  link: Prisma.RecruitingCrmImportGetPayload<{ include: { effect: true; occurrence: true } }>,
): Promise<RecruitingCrmCandidateSync> {
  const input = {
    roleId: link.occurrence.roleId,
    candidateKey: link.occurrence.candidateKey,
    bindingEffectId: link.bindingEffectId,
    sourceEffectId: link.pageId,
    rowIndex: link.rowIndex,
  };
  const bound = await crmBindingReceipt(tx, actor, input.roleId, input.bindingEffectId);
  const source = await crmImportSource(tx, actor, input);
  const args = crmImportArgs(bound.target, source);
  const owner = await requireRun(tx, actor, link.effect.runId);
  const ownerState = await tx.run.findUniqueOrThrow({ where: { id: owner.id } });
  if (link.effect.spaceId !== actor.spaceId || link.effect.idempotencyKey !== crmImportKey(input))
    throw new IsolationError();
  assertCrmImportRequest(
    link.effect.request,
    {
      connectorId: "mcp",
      resourceId: bound.target.mcpServerId,
      resourceRevision: bound.target.serverRevision,
      toolName: "crm_import_candidate",
    },
    args,
  );
  const receipt = parseRecruitingCrmImportReceipt(link.effect, bound.target, args);
  const status = deriveRecruitingCrmImportStatus(
    { ...link.effect, ownerRunStatus: ownerState.status },
    bound.target,
    args,
  );
  return {
    effectId: link.effect.id,
    bindingEffectId: link.bindingEffectId,
    sourceEffectId: link.pageId,
    rowIndex: link.rowIndex,
    target: bound.target,
    status:
      status === "syncing" &&
      (!ownerState.leaseExpiresAt || ownerState.leaseExpiresAt.getTime() <= Date.now())
        ? "unknown"
        : status,
    receipt,
  };
}

function candidateSourceReference(
  page: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>> & {
    effect: { request: Prisma.JsonValue };
  },
  rowIndex: number,
) {
  return {
    providerTaskId: researchReadRequest(page.effect.request, undefined, "get_rows").args.task_id,
    taskId: page.taskId,
    actionId: page.actionId,
    roleRevisionId: page.roleRevisionId,
    effectId: page.effectId,
    rowIndex,
    artifactRef: { artifactId: page.artifactId, sha256: page.artifactHash },
    requestCursor: page.requestCursor,
    outputId: page.outputId,
    observedAt: page.observedAt.toISOString(),
  };
}

export async function listRecruitingCandidates(
  prisma: PrismaClient,
  actor: Actor,
  raw: CandidatesInput,
): Promise<CandidatesOutput> {
  const input = ListRecruitingCandidatesInput.parse(raw);
  return prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const sort = input.sort ?? "rank";
      const matchSort = sort === "rank" || sort === "tier" || sort === "score";
      const limit = input.limit ?? 25;
      const explicitSource = input.sourceEffectId !== undefined || input.actionId !== undefined;
      let rankDomainPageId = sort === "rank" || sort === "score" ? input.sourceEffectId : undefined;
      if ((sort === "rank" || sort === "score") && rankDomainPageId === undefined) {
        const pages = await tx.recruitingCandidatePage.findMany({
          where: {
            roleId: role.id,
            ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
          },
          select: { effectId: true },
          take: 2,
        });
        if (pages.length === 1) rankDomainPageId = pages[0]!.effectId;
      }
      const scope = candidateCursorScope({
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        sort,
        // Reject old cursors that treated provider-native match fields as unknown.
        ...(sort === "rank" ? { rankProjection: 3 } : {}),
        ...(sort === "score" ? { scoreProjection: 1 } : {}),
        ...(explicitSource ? { sourceProjection: 2 } : {}),
        ...(input.sourceEffectId === undefined && rankDomainPageId !== undefined
          ? { rankDomainPageId }
          : {}),
        // Reject search cursors that could skip newly matched whitespace variants.
        ...(input.query ? { queryProjection: 1 } : {}),
        query: input.query ?? "",
        assessmentState: input.assessmentState ?? null,
        verdict: input.verdict ?? null,
        shortlisted: input.shortlisted ?? null,
        actionId: input.actionId ?? null,
        sourceEffectId: input.sourceEffectId ?? null,
      });
      const cursor = readCandidateCursor(input.cursor, scope);
      if (
        matchSort &&
        cursor?.value &&
        (sort === "score"
          ? !/^-?\d+(?:\.\d+)?$/.test(cursor.value) || !Number.isFinite(Number(cursor.value))
          : !/^\d+$/.test(cursor.value) ||
            !Number.isSafeInteger(Number(cursor.value)) ||
            Number(cursor.value) < (sort === "rank" ? 1 : 0) ||
            (sort === "tier" && Number(cursor.value) > 3))
      )
        throw new RecruitingConflictError();
      const clauses = [Prisma.sql`true`];
      if (input.query)
        clauses.push(
          Prisma.sql`strpos(lower(regexp_replace(concat_ws(' ', b."name", b."title", b."company", b."location", b."linkedinUrl", b."candidateKey"), '[[:space:]]+', ' ', 'g')), lower(regexp_replace(${input.query}, '[[:space:]]+', ' ', 'g'))) > 0`,
        );
      if (input.assessmentState === "unassessed")
        clauses.push(Prisma.sql`b."assessmentVersion" IS NULL`);
      if (input.assessmentState === "current")
        clauses.push(Prisma.sql`b."assessmentRoleRevisionId" = ${role.currentRevisionId}`);
      if (input.assessmentState === "outdated")
        clauses.push(Prisma.sql`b."assessmentRoleRevisionId" <> ${role.currentRevisionId}`);
      if (input.verdict) clauses.push(Prisma.sql`b."hardGate" = ${input.verdict}`);
      if (input.shortlisted !== undefined)
        clauses.push(Prisma.sql`b."shortlisted" = ${input.shortlisted}`);
      if (explicitSource) clauses.push(Prisma.sql`b."sourcePageId" IS NOT NULL`);
      const filtered = Prisma.sql`${candidateIndexQuery(role.id, sort, rankDomainPageId ?? input.sourceEffectId, input)}, filtered AS (SELECT b.* FROM base b WHERE ${Prisma.join(clauses, " AND ")})`;
      const totals = await tx.$queryRaw<
        Array<{
          total: bigint;
          sourceRows: bigint;
          candidates: bigint;
          identifiedCandidates: bigint;
          unassessed: bigint;
          assessed: bigint;
          shortlisted: bigint;
          rankAvailable: boolean;
          tierAvailable: boolean;
          scoreAvailable: boolean;
        }>
      >(Prisma.sql`${filtered} SELECT (SELECT count(*) FROM filtered) AS "total",
      (SELECT COALESCE(bool_or("rankValue" IS NOT NULL), false) FROM filtered) AS "rankAvailable",
      (SELECT COALESCE(bool_or("tierValue" IS NOT NULL), false) FROM filtered) AS "tierAvailable",
      (SELECT COALESCE(bool_or("scoreValue" IS NOT NULL), false) FROM filtered) AS "scoreAvailable",
      COALESCE(sum("discoveryCount"), 0)::bigint AS "sourceRows", count(*) AS "candidates",
      count(*) FILTER (WHERE "countIdentified") AS "identifiedCandidates",
      count(*) FILTER (WHERE "assessmentVersion" IS NULL) AS "unassessed",
      count(*) FILTER (WHERE "assessmentVersion" IS NOT NULL) AS "assessed",
      count(*) FILTER (WHERE "shortlisted") AS "shortlisted" FROM base`);
      const sortValue = matchSort
        ? Prisma.sql`COALESCE("matchValue"::text, '')`
        : sort === "name"
          ? Prisma.sql`lower(COALESCE(NULLIF("name", ''), "candidateKey")) COLLATE "C"`
          : Prisma.sql`COALESCE("lastDiscoveredAt", '') COLLATE "C"`;
      const direction = sort === "name" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
      const after = cursor
        ? matchSort
          ? cursor.value === ""
            ? Prisma.sql`("matchValue" IS NULL AND "candidateKey" > ${cursor.key} COLLATE "C")`
            : Prisma.sql`("matchValue" IS NULL OR "matchValue" ${sort === "score" ? Prisma.sql`<` : Prisma.sql`>`} ${cursor.value}::numeric OR ("matchValue" = ${cursor.value}::numeric AND "candidateKey" > ${cursor.key} COLLATE "C"))`
          : sort === "name"
            ? Prisma.sql`("sortValue" > ${cursor.value} COLLATE "C" OR ("sortValue" = ${cursor.value} COLLATE "C" AND "candidateKey" > ${cursor.key} COLLATE "C"))`
            : Prisma.sql`("sortValue" < ${cursor.value} COLLATE "C" OR ("sortValue" = ${cursor.value} COLLATE "C" AND "candidateKey" > ${cursor.key} COLLATE "C"))`
        : Prisma.sql`true`;
      const rows = await tx.$queryRaw<CandidateQueryRow[]>(Prisma.sql`${filtered}, ordered AS (
      SELECT *, ${sortValue} AS "sortValue" FROM filtered
    ) SELECT * FROM ordered WHERE ${after}
      ORDER BY ${matchSort ? Prisma.sql`"matchValue" ${sort === "score" ? Prisma.sql`DESC` : Prisma.sql`ASC`} NULLS LAST` : Prisma.sql`"sortValue" ${direction}`}, "candidateKey" COLLATE "C" ASC LIMIT ${limit + 1}`);
      const selected = rows.slice(0, limit);
      const pages = await candidateProfilePages(tx, actor, role.id, selected);
      const last = selected.at(-1);
      const { total, rankAvailable, tierAvailable, scoreAvailable, ...counts } = totals[0]!;
      const bound = role.crmBindingEffectId
        ? await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId)
        : null;
      const syncs = new Map<string, RecruitingCrmCandidateSync>();
      if (bound && selected.length) {
        const imports = await tx.recruitingCrmImport.findMany({
          where: {
            bindingEffectId: bound.bindingEffectId,
            occurrence: {
              roleId: role.id,
              candidateKey: { in: selected.map((row) => row.candidateKey) },
            },
          },
          include: { effect: true, occurrence: true },
          orderBy: [{ effect: { createdAt: "desc" } }, { effectId: "desc" }],
        });
        for (const link of imports)
          if (!syncs.has(link.occurrence.candidateKey))
            syncs.set(link.occurrence.candidateKey, await crmSourceSync(tx, actor, link));
      }
      return ListRecruitingCandidatesOutput.parse({
        sortAvailability: { rank: rankAvailable, tier: tierAvailable, score: scoreAvailable },
        crmTarget: bound ? { bindingEffectId: bound.bindingEffectId, target: bound.target } : null,
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        items: selected.map(
          ({
            assessmentVersion,
            assessmentRoleRevisionId,
            assessmentCreatedAt,
            hardGate,
            matchValue: _match,
            rankValue: _rank,
            tierValue: _tier,
            scoreValue: _score,
            sortValue: _sort,
            sourcePageId,
            sourceRowIndex,
            profileSourcePageIds: _profilePages,
            countIdentified: _identified,
            ...profile
          }) => ({
            ...profile,
            crm: syncs.get(profile.candidateKey) ?? null,
            ...(sourcePageId && sourceRowIndex !== null
              ? {
                  latestSource: candidateSourceReference(pages.get(sourcePageId)!, sourceRowIndex),
                }
              : {}),
            latestAssessment:
              assessmentVersion === null
                ? null
                : {
                    version: assessmentVersion,
                    roleRevisionId: assessmentRoleRevisionId,
                    createdAt: assessmentCreatedAt,
                    isCurrent: assessmentRoleRevisionId === role.currentRevisionId,
                    hardGate,
                  },
          }),
        ),
        nextCursor:
          rows.length > limit && last
            ? writeCandidateCursor(scope, last.sortValue, last.candidateKey)
            : null,
        total: Number(total),
        counts: Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, Number(value)]),
        ),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function setRecruitingCandidateShortlist(
  prisma: PrismaClient,
  actor: Actor,
  raw: ShortlistInput,
): Promise<ShortlistOutput> {
  const input = SetRecruitingCandidateShortlistInput.parse(raw);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = ${input.threadId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
    );
    return setCandidateShortlistInTransaction(tx, actor, input);
  });
}

async function shortlistTarget(
  tx: Tx,
  actor: Actor,
  input: ShortlistInput,
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
) {
  const thread = authorizedThread ?? (await requireThread(tx, actor, input.threadId));
  if (thread.activeRecruitingRoleId !== input.roleId) throw new IsolationError();
  const role = await requireRole(tx, actor, input.roleId, true, thread);
  const candidate = await tx.recruitingCandidate.findUnique({
    where: { roleId_candidateKey: { roleId: role.id, candidateKey: input.candidateKey } },
  });
  if (!candidate) throw new IsolationError();
  if (candidate.revision !== input.expectedRevision) throw new RecruitingConflictError();
  return { thread, role, candidate };
}

async function shortlistProfile(tx: Tx, actor: Actor, roleId: string, candidateKey: string) {
  const [profile] = await tx.$queryRaw<
    Pick<
      CandidateQueryRow,
      "name" | "linkedinUrl" | "resumeUrl" | "sourcePageId" | "profileSourcePageIds"
    >[]
  >(
    Prisma.sql`${candidateIndexQuery(roleId)} SELECT "name", "linkedinUrl", "resumeUrl", "sourcePageId", "profileSourcePageIds" FROM base WHERE "candidateKey" = ${candidateKey}`,
  );
  if (!profile) throw new IsolationError();
  await candidateProfilePages(tx, actor, roleId, [profile]);
  return profile;
}

async function setCandidateShortlistInTransaction(
  tx: Tx,
  actor: Actor,
  input: ShortlistInput,
  native?: { runId: string; botId: string; effectId: string },
  target?: Awaited<ReturnType<typeof shortlistTarget>>,
) {
  const { thread, role, candidate } = target ?? (await shortlistTarget(tx, actor, input));
  if (candidate.shortlisted === input.shortlisted)
    return {
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      shortlisted: candidate.shortlisted,
      revision: candidate.revision,
    };
  const profile = await shortlistProfile(tx, actor, role.id, candidate.candidateKey);
  const identity = [profile.name ?? "Unnamed candidate", profile.linkedinUrl ?? profile.resumeUrl]
    .filter(Boolean)
    .join(" · ");
  const message = await createThreadMessageInTransaction(tx, {
    threadId: thread.id,
    role: native ? "bot" : "user",
    ...(native ? { botId: native.botId, runId: native.runId } : {}),
    clientNonce: `recruiting-shortlist:${native ? native.effectId : JSON.stringify([role.id, role.currentRevisionId, candidate.candidateKey, candidate.revision, input.shortlisted])}`,
    blocks: [
      {
        kind: "text",
        text: `${input.shortlisted ? "Shortlist" : "Remove from shortlist"} ${identity} for ${role.title} (requirements version ${role.revision}).`,
      },
    ],
  });
  const changed = await tx.recruitingCandidate.updateMany({
    where: {
      roleId: role.id,
      candidateKey: candidate.candidateKey,
      revision: input.expectedRevision,
    },
    data: {
      shortlisted: input.shortlisted,
      revision: candidate.revision + 1,
      shortlistMessageId: message.id,
    },
  });
  if (changed.count !== 1) throw new RecruitingConflictError();
  return {
    roleId: role.id,
    candidateKey: candidate.candidateKey,
    shortlisted: input.shortlisted,
    revision: candidate.revision + 1,
  };
}

type NativeShortlistContext = ResearchLease & { threadId: string; botId: string };

async function nativeShortlistTarget(
  tx: Tx,
  actor: Actor,
  trusted: NativeShortlistContext,
  input: ReturnType<typeof RecruitingShortlistToolInputSchema.parse>,
  authorized?: Awaited<ReturnType<typeof lockLiveRecruitingRun>>,
) {
  const { run, thread } = authorized ?? (await lockLiveRecruitingRun(tx, actor, trusted.runId));
  if (run.threadId !== trusted.threadId || run.botId !== trusted.botId) throw new IsolationError();
  requireResearchLease(run, trusted);
  const { expectedRoleRevision, ...selection } = input;
  const target = await shortlistTarget(tx, actor, { ...selection, threadId: thread.id }, thread);
  if (target.role.revision !== expectedRoleRevision) throw new RecruitingConflictError();
  await requireResearchAdoption(tx, actor, run, target.role, undefined, undefined, { run, thread });
  return { ...target, run };
}

export async function prepareNativeRecruitingShortlist(
  prisma: PrismaClient,
  actor: Actor,
  trusted: NativeShortlistContext,
  raw: unknown,
) {
  const input = RecruitingShortlistToolInputSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const { role, candidate } = await nativeShortlistTarget(tx, actor, trusted, input);
    const profile = await shortlistProfile(tx, actor, role.id, candidate.candidateKey);
    if (!profile.name?.trim()) throw new IsolationError();
    return {
      candidateName: profile.name,
      roleTitle: role.title,
      shortlisted: input.shortlisted,
    };
  });
}

export async function executeNativeRecruitingShortlist(
  prisma: PrismaClient,
  actor: Actor,
  trusted: NativeShortlistContext & { effectId: string; effectRequest: unknown },
  raw: unknown,
) {
  const input = RecruitingShortlistToolInputSchema.parse(raw);
  if (stableJsonValue(input) !== stableJsonValue(trusted.effectRequest)) throw new IsolationError();
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${trusted.effectId} FOR UPDATE`,
    );
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: trusted.effectId,
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "recruiting_shortlist",
      },
    });
    if (!effect || stableJsonValue(effect.request) !== stableJsonValue(input))
      throw new IsolationError();
    if (effect.status === "completed") {
      const result = RecruitingShortlistToolResultSchema.parse(effect.result);
      if (
        result.roleId !== input.roleId ||
        result.candidateKey !== input.candidateKey ||
        result.shortlisted !== input.shortlisted
      )
        throw new IsolationError();
      return result;
    }
    if (effect.status !== "executing") throw new IsolationError();
    const target = await nativeShortlistTarget(tx, actor, trusted, input, { run, thread });
    const { expectedRoleRevision: _expectedRoleRevision, ...selection } = input;
    const result = {
      kind: "saved" as const,
      ...(await setCandidateShortlistInTransaction(
        tx,
        actor,
        { ...selection, threadId: run.threadId },
        { runId: run.id, botId: run.botId, effectId: effect.id },
        target,
      )),
    };
    const completed = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        spaceId: actor.spaceId,
        runId: run.id,
        status: "executing",
        run: {
          status: "running",
          leaseOwner: trusted.leaseOwner,
          leaseFence: trusted.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
      },
      data: { status: "completed", result },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: { effectId: effect.id, tool: "recruiting_shortlist", result },
    });
    return result;
  });
}

export async function listRecruitingCandidateSources(
  prisma: PrismaClient,
  actor: Actor,
  raw: CandidateSourcesInput,
): Promise<CandidateSourcesOutput> {
  const input = ListRecruitingCandidateSourcesInput.parse(raw);
  return prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const candidate = await tx.recruitingCandidate.findUnique({
        where: { roleId_candidateKey: { roleId: role.id, candidateKey: input.candidateKey } },
      });
      if (!candidate) throw new IsolationError();
      const scope = candidateCursorScope({
        roleId: role.id,
        candidateKey: candidate.candidateKey,
        kind: "sources",
      });
      const cursor = readCandidateCursor(input.cursor, scope);
      const limit = input.limit ?? 25;
      if (cursor) {
        const rowIndex = Number(cursor.value);
        if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) throw new RecruitingConflictError();
        const anchor = await tx.recruitingCandidateOccurrence.findUnique({
          where: { pageId_rowIndex: { pageId: cursor.key, rowIndex } },
        });
        if (anchor?.roleId !== role.id || anchor.candidateKey !== candidate.candidateKey)
          throw new RecruitingConflictError();
      }
      const where = { roleId: role.id, candidateKey: candidate.candidateKey };
      const total = await tx.recruitingCandidateOccurrence.count({ where });
      const rows = await tx.recruitingCandidateOccurrence.findMany({
        where,
        orderBy: [{ page: { observedAt: "desc" } }, { pageId: "desc" }, { rowIndex: "desc" }],
        ...(cursor
          ? {
              cursor: { pageId_rowIndex: { pageId: cursor.key, rowIndex: Number(cursor.value) } },
              skip: 1,
            }
          : {}),
        take: limit + 1,
        include: { page: { include: { effect: { select: { request: true } } } } },
      });
      const selected = rows.slice(0, limit);
      const pages = new Map<string, (typeof selected)[number]["page"]>();
      for (const { page } of selected) {
        if (page.roleId !== role.id) throw new IsolationError();
        pages.set(page.effectId, page);
      }
      await candidatePageArtifacts(tx, actor, [...pages.values()]);
      const last = selected.at(-1);
      const syncs = new Map<string, RecruitingCrmCandidateSync[]>();
      for (const row of selected) {
        const imports = await tx.recruitingCrmImport.findMany({
          where: { pageId: row.pageId, rowIndex: row.rowIndex },
          include: { effect: true, occurrence: true },
          orderBy: [{ effect: { createdAt: "asc" } }, { effectId: "asc" }],
        });
        const states = [];
        for (const link of imports) states.push(await crmSourceSync(tx, actor, link));
        syncs.set(`${row.pageId}:${row.rowIndex}`, states);
      }
      return ListRecruitingCandidateSourcesOutput.parse({
        roleId: role.id,
        candidateKey: candidate.candidateKey,
        items: selected.map(({ page, rowIndex }) => ({
          crmImports: syncs.get(`${page.effectId}:${rowIndex}`)!,
          ...candidateSourceReference(page, rowIndex),
        })),
        nextCursor:
          rows.length > limit && last
            ? writeCandidateCursor(scope, String(last.rowIndex), last.pageId)
            : null,
        total,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
