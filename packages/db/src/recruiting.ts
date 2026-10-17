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
  RecruitingHumanIntent,
  RecruitingMaterialReadPayload,
  RecruitingPreferenceFeedbackInput,
  RecruitingQuestion,
  RecruitingReadPayload,
  RecruitingResearchAction,
  RecruitingResearchPurpose,
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
  MessageBlock as MessageBlockSchema,
  NativeAskAnswerPayloadSchema,
  ProductEventSchema,
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  ReassessRecruitingAssessmentInput,
  RecruitingApprovalToolInputSchema,
  RecruitingArtifactRefSchema,
  RecruitingAssessmentAskInputSchema,
  RecruitingAssessmentSchema,
  RecruitingCandidateOutputSchemaId,
  RecruitingHumanIntentSchema,
  RecruitingMaterialReadPayloadSchema,
  RecruitingPreferenceFeedbackSchema,
  RecruitingQuestionAskedPayloadSchema,
  RecruitingQuestionSchema,
  RecruitingResearchActionSchema,
  RecruitingResearchTaskSchema,
  RecruitingRoleRevisionSchema,
  RecruitingRoleSchema,
  RecruitingRoleToolInputSchema,
  RecruitingSourceRefSchema,
  ReviseRecruitingRoleInput,
  SaveRecruitingAssessmentInput,
  SetRecruitingCandidateShortlistInput,
} from "@rakazo/contracts";
import {
  applyRecruitingPreferenceEdit,
  evaluateRecruitingAssessment,
  extractLinksFromText,
  mergeRecruitingReassessment,
  normalizeRecruitingCandidateRow,
  RecruitingPlaybookValidationError,
  readRecruitingJsonString,
  recruitingBriefClarifications,
  recruitingCalibrationIdentity,
  requireRecruitingBriefConfirmation,
  validateRecruitingBrief,
  validateRecruitingTextSelection,
} from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
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
  return artifact;
}

async function validateSources(tx: Tx, actor: Actor, sources: readonly RecruitingSourceRef[]) {
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
    threads.set(threadId, await requireThread(tx, actor, threadId));
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
) {
  return validateSources(tx, actor, definitionSources(definition));
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
  const attributed = [...definition.brief.fields, ...definition.brief.rules].filter(
    (item) => item.origin === "user_instruction",
  );
  const messageIds = new Set<string>();
  for (const item of attributed) {
    for (const id of item.sourceRefIds) {
      const source = sources.get(id);
      if (source?.anchor.kind !== "message") throw new IsolationError();
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
  if (revision.brief) validateRecruitingBrief(revision.brief, revision);
  return { role: RecruitingRoleSchema.parse(role), revision };
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
    const { revision } = await roleSnapshot(tx, actor, role);
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
    if (revision.brief.confirmation?.revision === role.revision) return { role, revision };
    const nextRevision = role.revision + 1;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: `Confirm recruiting brief revision ${role.revision}.` }],
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
        const updated = updatedAtoms.get(atom.atomId)!;
        return stableJsonValue(originalAtoms.get(atom.atomId)) === stableJsonValue(updated)
          ? []
          : [
              {
                atomId: atom.atomId,
                ...(updated.employmentRule ? { employmentRule: updated.employmentRule } : {}),
                statement: updated.statement,
              },
            ];
      });
      return criterion.priority === edit.priority && !changedAtoms.length
        ? []
        : [
            {
              criterion: { ...criterion, priority: edit.priority, expression },
              edit: {
                criterionId: criterion.id,
                ...(criterion.priority !== edit.priority ? { priority: edit.priority } : {}),
                ...(changedAtoms.length ? { atoms: changedAtoms } : {}),
              },
            },
          ];
    });
    if (!changes.length) return { role: RecruitingRoleSchema.parse(role), revision };
    const changed = new Map(changes.map((change) => [change.criterion.id, change.criterion]));
    const criteria = revision.criteria.map((criterion) => changed.get(criterion.id) ?? criterion);
    // A shared atom ID must still have one definition across all criteria.
    RecruitingRoleRevisionSchema.parse({ ...revision, criteria });
    const text = `Edit recruiting criteria revision ${role.revision}:\n${JSON.stringify(changes.map((change) => change.edit))}`;
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

async function questionTargetCurrent(
  tx: Tx,
  actor: Actor,
  role: RecruitingRole,
  request: RecruitingAssessmentAskInput,
) {
  if (role.currentRevisionId !== request.roleRevisionId) return false;
  const definition = (await roleSnapshot(tx, actor, role)).revision;
  const ids = request.target.criterionIds;
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !definition.criteria.some((criterion) => criterion.id === id))
  )
    throw new IsolationError();
  if (request.target.kind === "role") return true;
  const row = await tx.recruitingAssessment.findFirst({
    where: { roleId: role.id, candidateKey: request.target.candidateKey },
    orderBy: { version: "desc" },
  });
  if (
    !row ||
    row.version !== request.target.assessmentVersion ||
    row.roleRevisionId !== request.roleRevisionId
  )
    return false;
  await assessmentSnapshot(tx, actor, role, row);
  return true;
}

async function questionInTransaction(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; roleId: string; effectId: string },
): Promise<RecruitingQuestion | null> {
  const thread = await requireThread(tx, actor, input.threadId);
  const role = await requireRole(tx, actor, input.roleId);
  const event = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: thread.id,
      type: "recruiting.question.asked",
      AND: [
        { payload: { path: ["roleId"], equals: role.id } },
        { payload: { path: ["effectId"], equals: input.effectId } },
      ],
    },
  });
  if (!event?.runId) return null;
  const receipt = RecruitingQuestionAskedPayloadSchema.parse(event.payload);
  const run = await requireRun(tx, actor, event.runId);
  const status = await tx.run.findUniqueOrThrow({
    where: { id: run.id },
    select: { status: true },
  });
  const effect = await tx.externalEffect.findFirst({
    where: {
      id: receipt.effectId,
      runId: run.id,
      spaceId: actor.spaceId,
      kind: "recruiting_assess",
      status: "completed",
    },
  });
  if (!effect || stableJsonValue(effect.result) !== stableJsonValue(receipt))
    throw new IsolationError();
  const request = RecruitingAssessmentAskInputSchema.parse(effect.request);
  if (
    run.threadId !== thread.id ||
    event.botId !== run.botId ||
    receipt.roleId !== role.id ||
    receipt.roleRevisionId !== request.roleRevisionId ||
    request.roleId !== role.id ||
    stableJsonValue(request.target) !== stableJsonValue(receipt.target)
  )
    throw new IsolationError();
  const message = await tx.message.findFirst({
    where: {
      id: receipt.messageId,
      threadId: thread.id,
      runId: run.id,
      botId: run.botId,
      role: "bot",
      clientNonce: `recruiting-question:${effect.id}`,
    },
  });
  if (!message) throw new IsolationError();
  const block = questionCard(message.blocks, receipt.askIndex);
  const created = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: thread.id,
      runId: run.id,
      botId: run.botId,
      type: "thread.message.created",
      payload: { path: ["messageId"], equals: message.id },
    },
  });
  const original = created
    ? questionCard((created.payload as { blocks?: unknown }).blocks, receipt.askIndex)
    : null;
  const { status: _status, answer: _answer, ...display } = block;
  const { status: _originalStatus, answer: _originalAnswer, ...originalDisplay } = original ?? {};
  if (
    !original ||
    original.status === "answered" ||
    stableJsonValue(display) !== stableJsonValue(originalDisplay)
  )
    throw new IsolationError();
  const proof = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: run.botId,
      runId: run.id,
      type: "thread.choice",
      AND: [
        { payload: { path: ["messageId"], equals: message.id } },
        { payload: { path: ["askIndex"], equals: receipt.askIndex } },
      ],
    },
  });
  if (block.status === "answered") {
    const parsed = NativeAskAnswerPayloadSchema.safeParse(proof?.payload);
    if (!parsed.success || parsed.data.answeredByUserId !== actor.userId)
      throw new IsolationError();
    const human = await loadRunHumanSources(tx, actor, run);
    if (!human.answers.some((answer) => answer.id === parsed.data.answerMessageId))
      throw new IsolationError();
  } else if (proof) throw new IsolationError();
  const isCurrent =
    thread.activeRecruitingRoleId === role.id &&
    (await questionTargetCurrent(tx, actor, role, request));
  return RecruitingQuestionSchema.parse({
    ...receipt,
    threadId: thread.id,
    botId: run.botId,
    groupId: thread.groupId,
    runId: run.id,
    block,
    runStatus: status.status,
    isCurrent,
    canAnswer:
      isCurrent &&
      status.status === "waiting_input" &&
      block.status !== "answered" &&
      (await runTargetsRecruitingThread(tx, actor, run, thread)),
  });
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
  return prisma.$transaction(
    async (tx) => {
      await requireThread(tx, actor, input.threadId);
      await requireRole(tx, actor, input.roleId);
      const events = await tx.event.findMany({
        where: {
          spaceId: actor.spaceId,
          threadId: input.threadId,
          type: "recruiting.question.asked",
          payload: { path: ["roleId"], equals: input.roleId },
        },
        orderBy: { seq: "asc" },
      });
      const questions: RecruitingQuestion[] = [];
      // ponytail: one authoritative proof read per question; batch native proof reads if history grows.
      for (const event of events) {
        const receipt = RecruitingQuestionAskedPayloadSchema.parse(event.payload);
        if (
          input.candidateKey &&
          receipt.target.kind === "candidate" &&
          receipt.target.candidateKey !== input.candidateKey
        )
          continue;
        const question = await questionInTransaction(tx, actor, {
          ...input,
          effectId: receipt.effectId,
        });
        if (question) questions.push(question);
      }
      return questions;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
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
        const providerArtifact = await tx.recruitingResearchAction.findFirst({
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
      // ponytail: role references attest only the native text field; other fields need typed selections.
      if (selection?.kind === "message_text" || (!selection && source.anchor.locator !== "text"))
        throw new IsolationError();
      const json = artifact.mimeType === "application/json" || artifact.mimeType.endsWith("+json");
      const jsonPath =
        selection?.kind === "artifact_json_string"
          ? selection.path
          : !selection && json
            ? ["text"]
            : undefined;
      if (jsonPath ? !json : !artifact.mimeType.startsWith("text/") || json)
        throw new IsolationError();
      const text = jsonPath
        ? assessmentJsonString(bytes, jsonPath)
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
  input: RecruitingApprovalToolInput,
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
      return { tasks, actions };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function indexRecruitingCandidateRows(
  tx: Tx,
  action: ResearchActionRow,
  task: ResearchTaskRow,
  effect: ResearchEffectRow,
  artifact: { id: string; hash: string },
  request: Prisma.InputJsonObject,
  input: RecruitingResearchObservationInput,
) {
  if (input.toolName !== "get_rows") return [];
  if (await tx.recruitingCandidatePage.findUnique({ where: { effectId: effect.id } }))
    return tx.recruitingCandidateOccurrence.findMany({
      where: { pageId: effect.id },
      orderBy: { rowIndex: "asc" },
      select: { rowIndex: true, candidateKey: true },
    });
  const rows = (input.rows ?? []).map((row, rowIndex) => {
    const { candidateIdentity, ...profile } = normalizeRecruitingCandidateRow(row, {
      schemaKnown: action.candidateOutputSchema === RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
    });
    return {
      pageId: effect.id,
      rowIndex,
      roleId: task.roleId,
      candidateKey: candidateIdentity
        ? `linkedin:${candidateIdentity}`
        : `source-row:${effect.id}:${rowIndex}`,
      ...profile,
      evidenceUrls: profile.evidenceUrls === null ? Prisma.DbNull : [...profile.evidenceUrls],
      issues: [...profile.issues],
    };
  });
  await tx.recruitingCandidatePage.create({
    data: {
      effectId: effect.id,
      roleId: task.roleId,
      taskId: task.id,
      actionId: action.id,
      roleRevisionId: action.roleRevisionId,
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
function candidateIndexQuery(roleId: string) {
  return Prisma.sql`WITH base AS (
    SELECT c."roleId", c."candidateKey", c."shortlisted", c."revision",
      p."name", p."title", p."company", p."location", p."linkedinUrl", p."resumeUrl", p."evidenceUrls",
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
      ORDER BY page."observedAt" DESC, page."effectId" COLLATE "C" DESC, o."rowIndex" DESC LIMIT 1
    ) p ON true
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

export async function listRecruitingCandidates(
  prisma: PrismaClient,
  actor: Actor,
  raw: CandidatesInput,
): Promise<CandidatesOutput> {
  const input = ListRecruitingCandidatesInput.parse(raw);
  return prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const sort = input.sort ?? "recent";
      const limit = input.limit ?? 25;
      const scope = candidateCursorScope({
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        sort,
        query: input.query ?? "",
        assessmentState: input.assessmentState ?? null,
        verdict: input.verdict ?? null,
        shortlisted: input.shortlisted ?? null,
        actionId: input.actionId ?? null,
      });
      const cursor = readCandidateCursor(input.cursor, scope);
      const clauses = [Prisma.sql`true`];
      if (input.query)
        clauses.push(
          Prisma.sql`strpos(lower(concat_ws(' ', b."name", b."title", b."company", b."location", b."linkedinUrl", b."candidateKey")), lower(${input.query})) > 0`,
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
      if (input.actionId)
        clauses.push(
          Prisma.sql`EXISTS (SELECT 1 FROM "recruiting_candidate_occurrences" o JOIN "recruiting_candidate_pages" p ON p."effectId" = o."pageId" WHERE o."roleId" = b."roleId" AND o."candidateKey" = b."candidateKey" AND p."actionId" = ${input.actionId})`,
        );
      const filtered = Prisma.sql`${candidateIndexQuery(role.id)}, filtered AS (SELECT b.* FROM base b WHERE ${Prisma.join(clauses, " AND ")})`;
      const totals = await tx.$queryRaw<
        Array<{
          total: bigint;
          sourceRows: bigint;
          candidates: bigint;
          identifiedCandidates: bigint;
          unassessed: bigint;
          assessed: bigint;
          shortlisted: bigint;
        }>
      >(Prisma.sql`${filtered} SELECT (SELECT count(*) FROM filtered) AS "total",
      COALESCE(sum("discoveryCount"), 0)::bigint AS "sourceRows", count(*) AS "candidates",
      count(*) FILTER (WHERE "linkedinUrl" IS NOT NULL) AS "identifiedCandidates",
      count(*) FILTER (WHERE "assessmentVersion" IS NULL) AS "unassessed",
      count(*) FILTER (WHERE "assessmentVersion" IS NOT NULL) AS "assessed",
      count(*) FILTER (WHERE "shortlisted") AS "shortlisted" FROM base`);
      const sortValue =
        sort === "name"
          ? Prisma.sql`lower(COALESCE(NULLIF("name", ''), "candidateKey")) COLLATE "C"`
          : Prisma.sql`COALESCE("lastDiscoveredAt", '') COLLATE "C"`;
      const direction = sort === "name" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
      const after = cursor
        ? sort === "name"
          ? Prisma.sql`("sortValue" > ${cursor.value} COLLATE "C" OR ("sortValue" = ${cursor.value} COLLATE "C" AND "candidateKey" > ${cursor.key} COLLATE "C"))`
          : Prisma.sql`("sortValue" < ${cursor.value} COLLATE "C" OR ("sortValue" = ${cursor.value} COLLATE "C" AND "candidateKey" > ${cursor.key} COLLATE "C"))`
        : Prisma.sql`true`;
      const rows = await tx.$queryRaw<CandidateQueryRow[]>(Prisma.sql`${filtered}, ordered AS (
      SELECT *, ${sortValue} AS "sortValue" FROM filtered
    ) SELECT * FROM ordered WHERE ${after}
      ORDER BY "sortValue" ${direction}, "candidateKey" COLLATE "C" ASC LIMIT ${limit + 1}`);
      const selected = rows.slice(0, limit);
      const last = selected.at(-1);
      const { total, ...counts } = totals[0]!;
      return ListRecruitingCandidatesOutput.parse({
        roleId: role.id,
        roleRevisionId: role.currentRevisionId,
        items: selected.map(
          ({
            assessmentVersion,
            assessmentRoleRevisionId,
            assessmentCreatedAt,
            hardGate,
            sortValue: _sort,
            ...profile
          }) => ({
            ...profile,
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
    const thread = await requireThread(tx, actor, input.threadId);
    if (thread.activeRecruitingRoleId !== input.roleId) throw new IsolationError();
    const role = await requireRole(tx, actor, input.roleId, true);
    const candidate = await tx.recruitingCandidate.findUnique({
      where: { roleId_candidateKey: { roleId: role.id, candidateKey: input.candidateKey } },
    });
    if (!candidate) throw new IsolationError();
    if (candidate.revision !== input.expectedRevision) throw new RecruitingConflictError();
    if (candidate.shortlisted === input.shortlisted)
      return {
        roleId: role.id,
        candidateKey: candidate.candidateKey,
        shortlisted: candidate.shortlisted,
        revision: candidate.revision,
      };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "user",
      blocks: [
        {
          kind: "text",
          text: `${input.shortlisted ? "Shortlist" : "Remove from shortlist"} candidate ${candidate.candidateKey} for role ${role.id}, criteria revision ${role.revision}, candidate revision ${candidate.revision}.`,
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
        orderBy: [{ pageId: "asc" }, { rowIndex: "asc" }],
        ...(cursor
          ? {
              cursor: { pageId_rowIndex: { pageId: cursor.key, rowIndex: Number(cursor.value) } },
              skip: 1,
            }
          : {}),
        take: limit + 1,
        include: { page: true },
      });
      const selected = rows.slice(0, limit);
      const checked = new Set<string>();
      for (const { page } of selected) {
        if (checked.has(page.effectId)) continue;
        const effect = await tx.externalEffect.findFirst({
          where: { id: page.effectId, spaceId: actor.spaceId, status: "completed" },
        });
        if (!effect) throw new IsolationError();
        const read = await researchReadBinding(tx, actor, effect);
        if (
          read?.toolName !== "get_rows" ||
          read.binding.taskId !== page.taskId ||
          read.binding.actionId !== page.actionId ||
          read.saved.task?.roleId !== role.id ||
          read.saved.action?.roleRevisionId !== page.roleRevisionId
        )
          throw new IsolationError();
        const artifact = await recordedResearchReadArtifact(tx, actor, read);
        if (!artifact || artifact.id !== page.artifactId || artifact.hash !== page.artifactHash)
          throw new IsolationError();
        checked.add(page.effectId);
      }
      const last = selected.at(-1);
      return ListRecruitingCandidateSourcesOutput.parse({
        roleId: role.id,
        candidateKey: candidate.candidateKey,
        items: selected.map(({ page, rowIndex }) => ({
          taskId: page.taskId,
          actionId: page.actionId,
          roleRevisionId: page.roleRevisionId,
          effectId: page.effectId,
          rowIndex,
          artifactRef: { artifactId: page.artifactId, sha256: page.artifactHash },
          requestCursor: page.requestCursor,
          outputId: page.outputId,
          observedAt: page.observedAt.toISOString(),
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
