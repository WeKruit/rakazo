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
  RecruitingProfileActivityInput as ProfileActivityInput,
  RecordRecruitingProfileViewInput as ProfileViewInput,
  RecruitingArtifactRef,
  RecruitingAssessmentAskInput,
  RecruitingAssessmentSnapshot,
  RecruitingAssessmentSourceRef,
  RecruitingCalibrationRound,
  RecruitingCandidateFeedbackSelection,
  RecruitingCriterionExpression,
  RecruitingCrmCandidateSync,
  RecruitingCrmImportInput,
  RecruitingCrmRoleReference,
  RecruitingCrmTarget,
  RecruitingFeedbackInput,
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
  RetainedRecruitingApprovalRequest,
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
  RecordRecruitingProfileViewInput,
  RecruitingArtifactRefSchema,
  RecruitingAssessmentAskInputSchema,
  RecruitingAssessmentSchema,
  RecruitingBriefDraftSchema,
  RecruitingCandidateConsiderationSchema,
  RecruitingCandidateFeedbackSelectionSchema,
  RecruitingCrmBindingInputSchema,
  RecruitingCrmImportArgsSchema,
  RecruitingCrmImportInputSchema,
  RecruitingCrmRoleReferenceSchema,
  RecruitingCrmTargetSchema,
  RecruitingFeedbackChoiceSchema,
  RecruitingFeedbackInputSchema,
  RecruitingFeedbackRecordSchema,
  RecruitingHumanIntentSchema,
  RecruitingMaterialReadPayloadSchema,
  RecruitingPreferenceFeedbackSchema,
  RecruitingProfileActivityInput,
  RecruitingProfileViewedPayloadSchema,
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
  RetainedRecruitingApprovalRequestSchema,
  ReviseRecruitingRoleInput,
  SaveRecruitingAssessmentInput,
  SetRecruitingCandidateShortlistInput,
} from "@rakazo/contracts";
import type { RecruitingPlaybookStage, RecruitingPlaybookStep } from "@rakazo/core";
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
  isRecruitingPlaybookStage,
  laterPlaybookStage,
  mergeRecruitingReassessment,
  nextPlaybookStep,
  normalizeRecruitingCandidateRow,
  parseRecruitingCrmImportReceipt,
  projectRecruitingCandidateReport,
  RECRUITING_PLAYBOOK_STAGES,
  RecruitingPlaybookValidationError,
  readRecruitingJsonString,
  recruitingBriefClarifications,
  recruitingCalibrationIdentity,
  requireRecruitingBriefConfirmation,
  validateRecruitingBrief,
  validateRecruitingTextSelection,
} from "@rakazo/core";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { AnswerRunInput, PauseRunForInput } from "./events.js";
import { appendEventInTransaction } from "./events.js";
import { createGroupInTransaction } from "./groups.js";
import type { SourceMessage } from "./messages.js";
import {
  createThreadMessageInTransaction,
  humanMessageInclude,
  isNativeHumanMessage,
  loadRunHumanSources,
  validateRunHumanSourceRows,
} from "./messages.js";
import { listRecruitingSavedProfiles } from "./recruiting-saved-profiles.js";
import { IsolationError, scoped } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Tx = Prisma.TransactionClient;
type RoleSnapshot = {
  role: RecruitingRole;
  revision: RecruitingRoleRevision;
  /** Short Chinese label of the agent's next playbook step; null when the human owns the move. */
  nextStep?: string | null;
};

/** Stages only advance (playbook S1→S12); a stale writer never regresses a role. */
export async function advanceRecruitingPlaybookStage(
  tx: Pick<Tx, "recruitingRole">,
  roleId: string,
  next: RecruitingPlaybookStage,
): Promise<void> {
  // One conditional write: only a role still at an earlier stage moves.
  const earlier = RECRUITING_PLAYBOOK_STAGES.slice(0, RECRUITING_PLAYBOOK_STAGES.indexOf(next));
  if (!earlier.length) return;
  await tx.recruitingRole.updateMany({
    where: { id: roleId, playbookStage: { in: [...earlier] } },
    data: { playbookStage: next },
  });
}

/** In-memory monotonic step for writers that already hold the role row and its CAS write. */
function stageAfter(role: { playbookStage?: string }, next: RecruitingPlaybookStage) {
  const current = isRecruitingPlaybookStage(role.playbookStage) ? role.playbookStage : "intake";
  return laterPlaybookStage(current, next);
}

const CALIBRATION_FEEDBACK_THRESHOLD = 10;

/** After candidates are saved: ten or more saved people move the role into the feedback loop. */
/** Saved people reach the feedback stage only once a calibration round has shown ten of them. */
// Runs inside the save's locked transaction, where each statement is a round trip: before the
// first round there is nothing to advance, so the count is skipped.
async function advanceStageAfterSave(tx: Tx, roleId: string) {
  const round = await tx.recruitingCalibrationRound.findFirst({
    where: { roleId },
    select: { id: true },
  });
  if (!round) return;
  const saved = await tx.recruitingCandidate.count({ where: { roleId } });
  if (saved >= CALIBRATION_FEEDBACK_THRESHOLD)
    await advanceRecruitingPlaybookStage(tx, roleId, "feedback");
}

/** Stage plus the next playbook step for a role; used by snapshots and the run turn-end guard. */
export async function readRecruitingPlaybookStep(
  tx: Pick<
    Tx,
    | "recruitingRole"
    | "recruitingRoleRevision"
    | "recruitingCandidate"
    | "recruitingCalibrationRound"
  >,
  roleId: string,
): Promise<{
  stage: RecruitingPlaybookStage;
  step: RecruitingPlaybookStep | null;
  savedCandidates: number;
} | null> {
  const role = await tx.recruitingRole.findUnique({
    where: { id: roleId },
    select: { title: true, playbookStage: true, currentRevisionId: true, archivedAt: true },
  });
  if (!role || role.archivedAt) return null;
  const [revision, savedCandidates, acceptedRound, anyRound] = await Promise.all([
    tx.recruitingRoleRevision.findUnique({
      where: { id: role.currentRevisionId },
      select: { brief: true },
    }),
    tx.recruitingCandidate.count({ where: { roleId } }),
    tx.recruitingCalibrationRound.findFirst({
      where: { roleId, approvedAt: { not: null } },
      select: { id: true },
    }),
    tx.recruitingCalibrationRound.findFirst({ where: { roleId }, select: { id: true } }),
  ]);
  const brief = revision?.brief ? RecruitingBriefDraftSchema.safeParse(revision.brief) : null;
  // The stored stage only moves forward from writes made after it shipped. A role that already
  // has a confirmed brief, saved people or an accepted round is at least at that stage, so it
  // is never pushed back to a fresh calibration search.
  let stage = isRecruitingPlaybookStage(role.playbookStage) ? role.playbookStage : "intake";
  const confirmed = (revision?.brief as { confirmation?: unknown } | null)?.confirmation;
  if (confirmed && typeof confirmed === "object")
    stage = laterPlaybookStage(stage, "calibration_10");
  // Saved people mean the brief was searched; feedback starts only once a round showed ten.
  if (savedCandidates >= CALIBRATION_FEEDBACK_THRESHOLD)
    stage = laterPlaybookStage(stage, anyRound ? "feedback" : "calibration_10");
  if (stage === "feedback" && !anyRound) stage = "calibration_10";
  if (acceptedRound) stage = laterPlaybookStage(stage, "scale");
  const openClarifications = brief?.success ? recruitingBriefClarifications(brief.data).length : 0;
  return {
    stage,
    savedCandidates,
    step: nextPlaybookStep(stage, {
      title: role.title,
      hasBrief: Boolean(revision?.brief),
      openClarifications,
      savedCandidates,
    }),
  };
}

export type { RecruitingAssessmentSnapshot } from "@rakazo/contracts";

/** The intent quote is not in the recruiter's current message; says which words to copy. */
export class RecruitingIntentQuoteError extends IsolationError {
  /** A quote the current message does contain, so a save can be repeated without the model. */
  readonly quote: string;
  constructor(text: string, quote = text) {
    const excerpt = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    super(
      `intent.quote must be exact words copied from the recruiter's current message, not from a system or agent message. Their current message reads: ${JSON.stringify(excerpt)}`,
    );
    this.name = "RecruitingIntentQuoteError";
    this.quote = quote;
  }
}

/**
 * A source reference that is the actor's own but does not check out. Still an IsolationError
 * for every caller; its message says what to change so the save can be repeated at once.
 */
export class RecruitingSourceCheckError extends IsolationError {
  constructor(sourceRefId: string, problem: string) {
    super(
      `Source ${JSON.stringify(sourceRefId)}: ${problem} This is a fixable check, not an outage.`,
    );
    this.name = "RecruitingSourceCheckError";
  }
}

export class RecruitingConflictError extends Error {
  constructor(message = "Recruiting revision changed") {
    super(message);
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

async function recordRecruitingChange(
  tx: Tx,
  actor: Actor,
  thread: Awaited<ReturnType<typeof requireThread>>,
  roleId: string | null,
) {
  await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId: thread.id,
    botId: thread.botId ?? thread.id,
    type: "recruiting.changed",
    payload: { roleId },
  });
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

async function requireRun(
  tx: Tx,
  actor: Actor,
  runId: string,
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
) {
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
  if (run.threadId === authorizedThread?.id) scoped(actor, authorizedThread);
  else await requireThread(tx, actor, run.threadId);
  return run;
}

async function validateArtifact(
  tx: Tx,
  actor: Actor,
  ref: RecruitingArtifactRef,
  context?: {
    run?: Awaited<ReturnType<typeof requireRun>>;
    thread: Awaited<ReturnType<typeof requireThread>>;
  },
) {
  const artifact = scoped(
    actor,
    await tx.artifact.findFirst({
      where: { id: ref.artifactId, spaceId: actor.spaceId, userId: actor.userId },
    }),
  );
  if (!artifact.groupId && !artifact.botId) throw new IsolationError();
  if (artifact.hash !== ref.sha256)
    throw new RecruitingSourceCheckError(
      ref.artifactId,
      "sha256 is not this file's fingerprint; cite the file as the reader returned it.",
    );
  const run = artifact.runId
    ? artifact.runId === context?.run?.id
      ? scoped(actor, context.run)
      : await requireRun(tx, actor, artifact.runId, context?.thread)
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
  authorizedRun?: Awaited<ReturnType<typeof requireRun>>,
) {
  const artifacts = new Set<string>();
  const messageIds = new Set<string>();
  for (const source of sources) {
    if (source.anchor.kind === "artifact") {
      const key = `${source.anchor.artifact.artifactId}:${source.anchor.artifact.sha256}`;
      if (artifacts.has(key)) continue;
      await validateArtifact(
        tx,
        actor,
        source.anchor.artifact,
        authorizedThread ? { run: authorizedRun, thread: authorizedThread } : undefined,
      );
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
  authorizedRun?: Awaited<ReturnType<typeof requireRun>>,
) {
  return validateSources(tx, actor, definitionSources(definition), authorizedThread, authorizedRun);
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

function validateBriefAuthorship(
  definition: CreateRoleInput | ReviseRoleInput,
  messages: ReadonlyMap<string, SourceMessage>,
) {
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
  for (const id of messageIds) {
    const message = messages.get(id);
    if (!message || !isNativeHumanMessage(message)) throw new IsolationError();
  }
}

/**
 * Brief facts may cite a recruiter message by its runtime id ("human-message:<messageId>")
 * without repeating the full reference. Supply that reference from the native message itself,
 * quoting its first text block; later validation still checks the quote and human authorship.
 */
async function citedHumanMessageSources(
  tx: Tx,
  threadId: string,
  definition: Pick<RecruitingRoleRevision, "sourceRefs" | "criteria"> & {
    brief?: CreateRoleInput["brief"];
  },
): Promise<RecruitingSourceRef[]> {
  if (!definition.brief) return [];
  const known = new Set(definitionSources(definition).map((source) => source.id));
  const missing = new Map<string, string>();
  for (const item of [
    ...definition.brief.fields,
    ...definition.brief.rules,
    ...definition.brief.searchFilters,
  ])
    for (const id of item.sourceRefIds) {
      const messageId = /^human-message:(.+)$/.exec(id)?.[1];
      if (messageId && !known.has(id)) missing.set(id, messageId);
    }
  if (!missing.size) return [];
  const messages = await tx.message.findMany({
    where: { id: { in: [...missing.values()] }, threadId },
    include: humanMessageInclude,
  });
  const readAt = new Date().toISOString();
  return [...missing].flatMap(([id, messageId]) => {
    const message = messages.find((row) => row.id === messageId);
    if (!message || !isNativeHumanMessage(message)) return [];
    const blocks = message.blocks as { kind: string; text?: string }[];
    const blockIndex = blocks.findIndex((block) => block.kind === "text" && block.text?.trim());
    const quote = blocks[blockIndex]?.text;
    if (!quote) return [];
    return [
      {
        id,
        kind: "original_material" as const,
        anchor: { kind: "message" as const, messageId, locator: `blocks[${blockIndex}].text` },
        readState: "read" as const,
        readAt,
        quote,
      },
    ];
  });
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
  authorizedRun?: Awaited<ReturnType<typeof requireRun>>,
): Promise<RoleSnapshot> {
  const row = await tx.recruitingRoleRevision.findFirst({
    where: { id: role.currentRevisionId, roleId: role.id, revision: role.revision },
  });
  if (!row) throw new IsolationError();
  const revision = RecruitingRoleRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  await validateDefinition(tx, actor, revision, authorizedThread, authorizedRun);
  if (revision.brief) validateRecruitingBrief(revision.brief, revision);
  const {
    crmBindingEffectId: _crm,
    archivedAt: _archived,
    ...publicRole
  } = role as RecruitingRole & {
    crmBindingEffectId?: string | null;
    archivedAt?: Date | null;
  };
  return { role: RecruitingRoleSchema.parse(publicRole), revision };
}

/**
 * The sidebar names a role by its chat group, which the web client creates with a placeholder
 * ("New role"). Keep the group named after the role: always on creation, and on a title change
 * only while the group still carries the previous title (a hand-renamed group is left alone).
 */
async function syncRoleGroupName(
  tx: Tx,
  actor: Actor,
  thread: { groupId: string | null },
  title: string,
  previousTitle?: string,
) {
  if (!thread.groupId || !title.trim() || title === previousTitle) return;
  await tx.chatGroup.updateMany({
    where: {
      id: thread.groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(previousTitle === undefined ? {} : { name: previousTitle }),
    },
    data: { name: title },
  });
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
  const thread = await requireThread(tx, actor, input.sourceThreadId);
  if (input.brief) validateRecruitingBrief(input.brief, input);
  const messages = await validateReadSources(tx, actor, definitionSources(input), artifacts);
  validateBriefAuthorship(input, messages);
  const role = await tx.recruitingRole.create({
    data: {
      id: randomUUID(),
      spaceId: actor.spaceId,
      userId: actor.userId,
      sourceThreadId: input.sourceThreadId,
      title: input.title,
      revision: 1,
      currentRevisionId: randomUUID(),
      playbookStage: input.brief && input.title ? "calibration_10" : "intake",
    },
  });
  await tx.recruitingRoleRevision.create({
    data: { id: role.currentRevisionId, roleId: role.id, revision: 1, ...definitionData(input) },
  });
  await tx.thread.update({
    where: { id: input.sourceThreadId },
    data: { activeRecruitingRoleId: role.id },
  });
  await syncRoleGroupName(tx, actor, thread, input.title);
  await recordRecruitingChange(tx, actor, thread, role.id);
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
  const thread = await requireThread(tx, actor, input.threadId);
  const role = input.roleId ? await requireRole(tx, actor, input.roleId) : null;
  if ((thread.activeRecruitingRoleId ?? null) === (role?.id ?? null))
    return role ? roleSnapshot(tx, actor, role) : null;
  await tx.thread.update({
    where: { id: input.threadId },
    data: { activeRecruitingRoleId: role?.id ?? null },
  });
  await recordRecruitingChange(tx, actor, thread, role?.id ?? null);
  return role ? roleSnapshot(tx, actor, role) : null;
}

/**
 * The authorized thread's current role id, without building the role snapshot.
 * Callers that read role data still authorize the role in their own transaction.
 */
export async function getRecruitingWorkspaceRoleId(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
): Promise<string | null> {
  return (await requireThread(prisma, actor, input.threadId)).activeRecruitingRoleId;
}

/** Stable native conversation identity; never a provider permission or CRM binding receipt. */
export function recruitingCrmConversationId(
  actor: Pick<Actor, "userId" | "spaceId">,
  reference: RecruitingCrmRoleReference,
): string {
  return `recruiting-crm-${createHash("sha256")
    .update(
      JSON.stringify([
        actor.userId,
        actor.spaceId,
        reference.sourceId,
        reference.organizationId,
        reference.crmRoleId,
      ]),
    )
    .digest("hex")}`;
}

/** Display locators only. Actual workspace reads still validate the complete binding and current access. */
export async function getRecruitingGroupCrmReferences(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  groupIds: string[],
): Promise<Map<string, RecruitingCrmRoleReference>> {
  if (!groupIds.length) return new Map();
  const rows = await prisma.$queryRaw<
    Array<{
      groupId: string;
      roleId: string | null;
      bindingEffectId: string | null;
      bindingRequest: unknown;
      bindingResult: unknown;
      readStatus: string | null;
      readRequest: unknown;
      readResult: unknown;
      ownerMatches: boolean;
      reference: unknown;
      sourceRevision: number | null;
    }>
  >(Prisma.sql`
    SELECT g.id AS "groupId", r.id AS "roleId", r."crmBindingEffectId" AS "bindingEffectId",
      e.request AS "bindingRequest", e.result AS "bindingResult", re.status AS "readStatus",
      re.request AS "readRequest", re.result AS "readResult",
      COALESCE(e.kind='recruiting_crm_target' AND e.status='completed'
        AND er."userId"=${actor.userId} AND er."spaceId"=${actor.spaceId}
        AND eb."userId"=${actor.userId} AND eb."spaceId"=${actor.spaceId}
        AND rt."userId"=${actor.userId} AND rt."spaceId"=${actor.spaceId}
        AND rr."userId"=${actor.userId} AND rr."spaceId"=${actor.spaceId}
        AND rr."threadId"=er."threadId" AND rr."botId"=er."botId", false) AS "ownerMatches",
      selected.reference, s.revision AS "sourceRevision"
    FROM chat_groups g JOIN threads t ON t."groupId"=g.id
    LEFT JOIN recruiting_roles r ON r.id=t."activeRecruitingRoleId"
      AND r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId}
    LEFT JOIN external_effects e ON e.id=r."crmBindingEffectId" AND e."spaceId"=${actor.spaceId}
    LEFT JOIN runs er ON er.id=e."runId"
    LEFT JOIN bots eb ON eb.id=er."botId"
    LEFT JOIN threads rt ON rt.id=er."threadId"
    LEFT JOIN external_effects re ON re.id=e.request->>'crmRoleReadEffectId' AND re."spaceId"=${actor.spaceId}
    LEFT JOIN runs rr ON rr.id=re."runId"
    LEFT JOIN LATERAL (
      SELECT ev.payload->'crmRoleReference' AS reference FROM events ev
      WHERE ev."threadId"=t.id AND ev."spaceId"=${actor.spaceId}
        AND ev.type='group.created' AND ev.payload->>'groupId'=g.id
      ORDER BY ev.seq, ev.id LIMIT 1
    ) selected ON true
    LEFT JOIN mcp_servers s ON s.id=selected.reference->>'sourceId'
      AND s."userId"=${actor.userId} AND s."spaceId"=${actor.spaceId}
    WHERE g."userId"=${actor.userId} AND g."spaceId"=${actor.spaceId}
      AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId}
      AND g.id IN (${Prisma.join(groupIds)})
  `);
  const result = new Map<string, RecruitingCrmRoleReference>();
  for (const row of rows) {
    if (row.bindingEffectId) {
      const request = RecruitingCrmBindingInputSchema.safeParse(row.bindingRequest);
      const target = extractRecruitingCrmTarget({
        status: row.readStatus ?? "",
        request: row.readRequest,
        result: row.readResult,
      });
      if (
        !row.ownerMatches ||
        !request.success ||
        request.data.roleId !== row.roleId ||
        !target ||
        stableJsonValue(row.bindingResult) !==
          stableJsonValue({
            status: "connected",
            roleId: row.roleId,
            bindingEffectId: row.bindingEffectId,
            target,
          })
      )
        continue;
      result.set(row.groupId, {
        sourceId: target.mcpServerId,
        serverRevision: target.serverRevision,
        organizationId: target.organizationId,
        crmRoleId: target.crmRoleId,
      });
    } else {
      const reference = RecruitingCrmRoleReferenceSchema.safeParse(row.reference);
      if (reference.success && recruitingCrmConversationId(actor, reference.data) === row.groupId)
        // This UI locator follows its source epoch; actual binding proofs above remain unchanged.
        result.set(row.groupId, {
          ...reference.data,
          serverRevision: row.sourceRevision ?? reference.data.serverRevision,
        });
    }
  }
  return result;
}

export async function authorizeRecruitingCrmRoleReference(
  tx: Tx,
  actor: Actor,
  threadId: string,
  reference: RecruitingCrmRoleReference,
) {
  const thread = await requireThread(tx, actor, threadId);
  if (!thread.groupId) throw new IsolationError();
  if (recruitingCrmConversationId(actor, reference) === thread.groupId) return;
  const current = (await getRecruitingGroupCrmReferences(tx, actor, [thread.groupId])).get(
    thread.groupId,
  );
  if (
    !current ||
    current.sourceId !== reference.sourceId ||
    current.organizationId !== reference.organizationId ||
    current.crmRoleId !== reference.crmRoleId
  )
    throw new IsolationError();
}

/** Resolve only a workspace's explicit, authenticated attachment; never a sidebar locator. */
async function attachedCrmTarget(
  tx: Tx,
  actor: Actor,
  roleId: string,
  threadId: string,
): Promise<RecruitingCrmTarget | null> {
  const attachment = await tx.recruitingCrmWorkspaceAttachment.findUnique({ where: { roleId } });
  if (!attachment) return null;
  if (attachment.userId !== actor.userId || attachment.spaceId !== actor.spaceId)
    throw new IsolationError();
  const target = RecruitingCrmTargetSchema.parse(attachment.target);
  if (
    target.mcpServerId !== attachment.mcpServerId ||
    target.serverRevision !== attachment.serverRevision ||
    target.organizationId !== attachment.organizationId ||
    target.crmRoleId !== attachment.crmRoleId
  )
    throw new IsolationError();
  const role = await requireRole(tx, actor, roleId);
  if (role.archivedAt) throw new RecruitingConflictError();
  if (role.crmBindingEffectId) {
    const bound = await crmBindingReceipt(tx, actor, roleId, role.crmBindingEffectId);
    if (
      bound.target.mcpServerId !== target.mcpServerId ||
      bound.target.organizationId !== target.organizationId ||
      bound.target.crmRoleId !== target.crmRoleId
    )
      throw new RecruitingConflictError();
  }
  const thread = await requireThread(tx, actor, threadId);
  const coordinator =
    thread.botId ??
    (thread.groupId
      ? (
          await tx.chatGroupMember.findFirst({
            where: { groupId: thread.groupId },
            orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
            select: { botId: true },
          })
        )?.botId
      : null);
  const server = await tx.mcpServer.findFirst({
    where: {
      id: target.mcpServerId,
      userId: actor.userId,
      spaceId: actor.spaceId,
      enabled: true,
      revision: target.serverRevision,
    },
  });
  const assignment = coordinator
    ? await tx.botMcpServer.findFirst({
        where: {
          botId: coordinator,
          serverId: target.mcpServerId,
          userId: actor.userId,
          spaceId: actor.spaceId,
        },
      })
    : null;
  if (
    !server ||
    !assignment ||
    (!assignment.allowAllTools &&
      (!Array.isArray(assignment.allowedTools) ||
        !assignment.allowedTools.includes("get_crm_role")))
  )
    throw new IsolationError();
  return target;
}

/** Local provenance only: provider operations must still verify current remote membership/permissions. */
export async function getRecruitingWorkspaceCrmTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
): Promise<RecruitingCrmTarget | null> {
  return prisma.$transaction(async (tx) => {
    const thread = await requireThread(tx, actor, input.threadId);
    if (!thread.activeRecruitingRoleId) return null;
    const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, false, thread);
    const attached = await attachedCrmTarget(tx, actor, role.id, thread.id);
    if (attached) return attached;
    return role.crmBindingEffectId
      ? (await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId)).target
      : null;
  });
}

type RecruitingCrmSourceMaterial = {
  target: RecruitingCrmTarget;
  observedAt: string;
  text: string;
};

async function workspaceCrmSourceMaterial(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; roleId: string },
): Promise<RecruitingCrmSourceMaterial | null> {
  const thread = await requireThread(tx, actor, input.threadId);
  if (thread.activeRecruitingRoleId !== input.roleId) throw new RecruitingConflictError();
  const target = await attachedCrmTarget(tx, actor, input.roleId, input.threadId);
  if (!target) return null;
  const attachment = await tx.recruitingCrmWorkspaceAttachment.findUniqueOrThrow({
    where: { roleId: input.roleId },
  });
  return {
    target,
    observedAt: attachment.observedAt.toISOString(),
    text: attachment.sourceMaterial,
  };
}

/** Saved provider material is reference data, never a human message or approval. */
export async function getRecruitingWorkspaceCrmSourceMaterial(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; roleId: string },
) {
  return prisma.$transaction((tx) => workspaceCrmSourceMaterial(tx, actor, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

/** Called only after the API's authenticated exact-role read, never with a client-supplied title/target. */
export async function openVerifiedRecruitingCrmWorkspace(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    target: RecruitingCrmTarget;
    verifiedBotId: string;
    botIds: string[];
    roleText: string;
  },
): Promise<{ groupId: string; threadId: string; roleId: string }> {
  const target = RecruitingCrmTargetSchema.parse(input.target);
  const reference: RecruitingCrmRoleReference = {
    sourceId: target.mcpServerId,
    serverRevision: target.serverRevision,
    organizationId: target.organizationId,
    crmRoleId: target.crmRoleId,
  };
  const exact = {
    userId: actor.userId,
    spaceId: actor.spaceId,
    mcpServerId: target.mcpServerId,
    organizationId: target.organizationId,
    crmRoleId: target.crmRoleId,
  };
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([actor.userId, actor.spaceId, target.mcpServerId, target.organizationId, target.crmRoleId])}, 3))`;
      const server = await tx.mcpServer.findFirst({
        where: {
          id: target.mcpServerId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          enabled: true,
          revision: target.serverRevision,
        },
      });
      const assignment = await tx.botMcpServer.findFirst({
        where: {
          serverId: target.mcpServerId,
          botId: input.verifiedBotId,
          userId: actor.userId,
          spaceId: actor.spaceId,
        },
      });
      if (
        !server ||
        !assignment ||
        (!assignment.allowAllTools &&
          (!Array.isArray(assignment.allowedTools) ||
            !assignment.allowedTools.includes("get_crm_role")))
      )
        throw new IsolationError();
      const attachment = await tx.recruitingCrmWorkspaceAttachment.findUnique({
        where: { userId_spaceId_mcpServerId_organizationId_crmRoleId: exact },
      });
      const candidates = await tx.recruitingRole.findMany({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          crmBindingEffect: {
            status: "completed",
            kind: "recruiting_crm_target",
            AND: [
              { result: { path: ["target", "mcpServerId"], equals: target.mcpServerId } },
              { result: { path: ["target", "organizationId"], equals: target.organizationId } },
              { result: { path: ["target", "crmRoleId"], equals: target.crmRoleId } },
            ],
          },
        },
      });
      for (const role of candidates) {
        const proof = await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId!);
        if (
          proof.target.mcpServerId !== target.mcpServerId ||
          proof.target.organizationId !== target.organizationId ||
          proof.target.crmRoleId !== target.crmRoleId
        )
          throw new IsolationError();
      }
      const ids = new Set([
        ...candidates.map((role) => role.id),
        ...(attachment ? [attachment.roleId] : []),
      ]);
      if (ids.size > 1) throw new RecruitingConflictError();
      let roleId = [...ids][0];
      let groupId: string;
      let threadId: string;
      if (roleId) {
        const role = await requireRole(tx, actor, roleId);
        if (role.archivedAt) throw new RecruitingConflictError();
        const thread = await requireThread(tx, actor, role.sourceThreadId);
        if (
          !thread.groupId ||
          (thread.activeRecruitingRoleId && thread.activeRecruitingRoleId !== role.id)
        )
          throw new RecruitingConflictError();
        const group = await tx.chatGroup.findFirst({
          where: {
            id: thread.groupId,
            userId: actor.userId,
            spaceId: actor.spaceId,
            archivedAt: null,
          },
        });
        if (!group) throw new IsolationError();
        groupId = group.id;
        threadId = thread.id;
      } else {
        const group = await createGroupInTransaction(tx, actor, {
          id: recruitingCrmConversationId(actor, reference),
          name: `${target.roleLabel} · ${target.clientLabel}`.slice(0, 80),
          botIds: input.botIds,
          crmRoleReference: reference,
        });
        if (!group.thread) throw new IsolationError();
        groupId = group.id;
        threadId = group.thread.id;
        const thread = await requireThread(tx, actor, threadId);
        // A locator is not a binding. Never overwrite an unrelated or manually created native role.
        if (thread.activeRecruitingRoleId) throw new RecruitingConflictError();
        const snapshot = await createRoleInTransaction(
          tx,
          actor,
          {
            sourceThreadId: threadId,
            expectedRevision: 0,
            title: target.roleLabel,
            sourceRefs: [],
            criteria: [],
            preferences: [],
            definitionQuestions: [],
          },
          new Map(),
        );
        roleId = snapshot.role.id;
      }
      const coordinator = await tx.chatGroupMember.findFirst({
        where: { groupId },
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
        select: { botId: true },
      });
      if (coordinator?.botId !== input.verifiedBotId) throw new IsolationError();
      const priorAttachment = await tx.recruitingCrmWorkspaceAttachment.findUnique({
        where: { roleId },
      });
      if (
        priorAttachment &&
        (priorAttachment.userId !== exact.userId ||
          priorAttachment.spaceId !== exact.spaceId ||
          priorAttachment.mcpServerId !== exact.mcpServerId ||
          priorAttachment.organizationId !== exact.organizationId ||
          priorAttachment.crmRoleId !== exact.crmRoleId)
      )
        throw new RecruitingConflictError();
      await tx.recruitingCrmWorkspaceAttachment.upsert({
        where: { roleId },
        create: {
          ...exact,
          roleId,
          serverRevision: target.serverRevision,
          target,
          sourceMaterial: input.roleText,
          observedAt: new Date(),
        },
        update: {
          serverRevision: target.serverRevision,
          target,
          sourceMaterial: input.roleText,
          observedAt: new Date(),
        },
      });
      await tx.thread.update({ where: { id: threadId }, data: { activeRecruitingRoleId: roleId } });
      return { groupId, threadId, roleId };
    },
    { timeout: 30_000 },
  );
}

/**
 * The role snapshot alone, without the CRM binding receipt reads. Run-start context
 * needs only the role and revision; CRM tools verify their binding at the point of use.
 */
export async function getRecruitingRoleSnapshot(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
): Promise<RoleSnapshot | null> {
  return prisma.$transaction(
    async (tx) => {
      const thread = await requireThread(tx, actor, input.threadId);
      if (!thread.activeRecruitingRoleId) return null;
      const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, false, thread);
      const snapshot = await roleSnapshot(tx, actor, role, thread);
      // Additive display hint; a partial test double without the candidate delegate still snapshots.
      const playbook = await readRecruitingPlaybookStep(tx, role.id).catch(() => null);
      return { ...snapshot, nextStep: playbook?.step?.label ?? null };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function getRecruitingWorkspace(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
): Promise<(RoleSnapshot & Pick<CandidatesOutput, "crmTarget">) | null> {
  return prisma.$transaction(
    async (tx) => {
      const thread = await requireThread(tx, actor, input.threadId);
      if (!thread.activeRecruitingRoleId) return null;
      const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, false, thread);
      const snapshot = await roleSnapshot(tx, actor, role, thread);
      const attached = await attachedCrmTarget(tx, actor, role.id, thread.id);
      const bound = attached
        ? { bindingEffectId: null, target: attached }
        : role.crmBindingEffectId
          ? await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId)
          : null;
      return {
        ...snapshot,
        crmTarget: bound ? { bindingEffectId: bound.bindingEffectId, target: bound.target } : null,
      };
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
  return prisma.$transaction(async (tx) => {
    // Match criteria, confirmation and native writes: lock the thread before the role.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = (SELECT "sourceThreadId" FROM "recruiting_roles" WHERE "id" = ${input.roleId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}) AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
    );
    const role = await requireRole(tx, actor, input.roleId, true);
    const thread = await requireThread(tx, actor, role.sourceThreadId);
    return reviseRoleInTransaction(tx, actor, input, artifacts, role, thread);
  });
}

async function reviseRoleInTransaction(
  tx: Tx,
  actor: Actor,
  input: ReviseRoleInput,
  artifacts: ReadonlyMap<string, Uint8Array>,
  role: Awaited<ReturnType<typeof requireRole>>,
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
) {
  if (role.id !== input.roleId) throw new IsolationError();
  if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
  if (input.brief) validateRecruitingBrief(input.brief, input);
  const messages = await validateReadSources(
    tx,
    actor,
    definitionSources(input),
    artifacts,
    authorizedThread,
  );
  validateBriefAuthorship(input, messages);
  const revision = await tx.recruitingRoleRevision.create({
    data: { roleId: role.id, revision: role.revision + 1, ...definitionData(input) },
  });
  const revisedStage =
    input.brief && input.title ? stageAfter(role, "calibration_10") : role.playbookStage;
  const changed = await tx.recruitingRole.updateMany({
    where: {
      id: role.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      revision: input.expectedRevision,
      currentRevisionId: role.currentRevisionId,
    },
    data: {
      title: input.title,
      revision: revision.revision,
      currentRevisionId: revision.id,
      playbookStage: revisedStage,
    },
  });
  if (changed.count !== 1) throw new RecruitingConflictError();
  const sourceThread = authorizedThread ?? (await requireThread(tx, actor, role.sourceThreadId));
  await syncRoleGroupName(tx, actor, sourceThread, input.title, role.title);
  await recordRecruitingChange(tx, actor, sourceThread, role.id);
  return roleSnapshot(
    tx,
    actor,
    {
      ...role,
      title: input.title,
      revision: revision.revision,
      currentRevisionId: revision.id,
      playbookStage: revisedStage,
    },
    authorizedThread,
  );
}

/** Human RPC and the verified native approval share one atomic confirmation write. */
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
  return prisma.$transaction((tx) =>
    confirmRecruitingBriefInTransaction(tx, actor, input, artifacts),
  );
}

function requireConfirmableBrief(revision: RecruitingRoleRevision) {
  if (!revision.brief)
    throw new RecruitingPlaybookValidationError(
      "Read the original material and prepare a sourced brief first.",
    );
  validateRecruitingBrief(revision.brief, revision);
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
}

async function confirmRecruitingBriefInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: { threadId: string; roleId: string; expectedRevision: number },
  artifacts: ReadonlyMap<string, Uint8Array>,
  approval?: { runId: string; confirmedAt: string },
): Promise<RoleSnapshot> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "threads" WHERE "id" = ${input.threadId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
  );
  const thread = await requireThread(tx, actor, input.threadId);
  if (thread.activeRecruitingRoleId !== input.roleId) throw new IsolationError();
  const role = await requireRole(tx, actor, input.roleId, true, thread);
  if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
  const workspace = await roleSnapshot(tx, actor, role, thread);
  const { revision } = workspace;
  requireConfirmableBrief(revision);
  const messages = await validateReadSources(
    tx,
    actor,
    definitionSources(revision),
    artifacts,
    thread,
  );
  validateBriefAuthorship(
    { ...revision, expectedRevision: role.revision, title: role.title },
    messages,
  );
  if (revision.brief!.confirmation?.revision === role.revision) return workspace;
  const nextRevision = role.revision + 1;
  const message = await createThreadMessageInTransaction(tx, {
    threadId: thread.id,
    role: "user",
    ...(approval ? { runId: approval.runId } : {}),
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
      confirmedAt: approval?.confirmedAt ?? new Date().toISOString(),
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
  const confirmedStage = stageAfter(role, "calibration_10");
  const changed = await tx.recruitingRole.updateMany({
    where: {
      id: role.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      revision: role.revision,
      currentRevisionId: role.currentRevisionId,
    },
    data: { revision: nextRevision, currentRevisionId: saved.id, playbookStage: confirmedStage },
  });
  if (changed.count !== 1) throw new RecruitingConflictError();
  await recordRecruitingChange(tx, actor, thread, role.id);
  return roleSnapshot(tx, actor, {
    ...role,
    revision: nextRevision,
    currentRevisionId: saved.id,
    playbookStage: confirmedStage,
  });
}

function criterionStatement(
  expression: RecruitingCriterionExpression,
  includeEmployment = false,
): string {
  if (expression.kind === "atom") {
    const rule = includeEmployment ? expression.employmentRule : undefined;
    if (!rule) return expression.statement;
    const cutoff =
      rule.cutoff.kind === "fixed"
        ? `${rule.cutoff.date.year}-${String(rule.cutoff.date.month).padStart(2, "0")}-${String(rule.cutoff.date.day).padStart(2, "0")}`
        : "assessment date";
    return `${expression.statement} (minimum ${rule.minimumMonths} complete calendar months; ${rule.qualificationDefinition}; cutoff: ${cutoff})`;
  }
  if (expression.kind === "not")
    return `NOT (${criterionStatement(expression.item, includeEmployment)})`;
  return `(${expression.items.map((item) => criterionStatement(item, includeEmployment)).join(expression.kind === "all" ? " AND " : " OR ")})`;
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
    const role = await requireRole(tx, actor, input.roleId, true, thread);
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
      role,
      thread,
    );
  });
}

export type RecruitingRoleMutationInput = Exclude<RecruitingRoleToolInput, { operation: "read" }>;
type RoleArchiveInput = Extract<
  RecruitingRoleMutationInput,
  { operation: "archive" | "unarchive" }
>;
type RecruitingRoleDefinitionInput = Exclude<
  RecruitingRoleMutationInput,
  { operation: "update" | "archive" | "unarchive" }
>;

/** Reversible hide: CAS on revision, no new revision. A role with candidates or research needs force. */
async function archiveRoleInTransaction(
  tx: Tx,
  actor: Actor,
  input: RoleArchiveInput,
): Promise<RoleSnapshot> {
  const role = await requireRole(tx, actor, input.roleId, true);
  if (role.revision !== input.expectedRevision) throw new RecruitingConflictError();
  const archiving = input.operation === "archive";
  if (archiving && !input.force) {
    const [candidates, tasks] = await Promise.all([
      tx.recruitingCandidate.count({ where: { roleId: role.id } }),
      tx.recruitingResearchTask.count({ where: { roleId: role.id } }),
    ]);
    if (candidates > 0 || tasks > 0)
      throw new RecruitingConflictError("Role has candidates or research; pass force to archive");
  }
  const changed = await tx.recruitingRole.updateMany({
    where: {
      id: role.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      revision: input.expectedRevision,
    },
    data: { archivedAt: archiving ? new Date() : null },
  });
  if (changed.count !== 1) throw new RecruitingConflictError();
  return roleSnapshot(tx, actor, await requireRole(tx, actor, role.id));
}

export async function setRecruitingRoleArchived(
  prisma: PrismaClient,
  actor: Actor,
  untrusted: (RoleArchiveInput extends infer T
    ? T extends unknown
      ? Omit<T, "intent">
      : never
    : never) & {
    intent?: RoleArchiveInput["intent"];
  },
): Promise<RoleSnapshot> {
  const input = RecruitingRoleToolInputSchema.parse({
    intent: { basis: "direct", quote: "archive" },
    ...untrusted,
  }) as RoleArchiveInput;
  return prisma.$transaction((tx) => archiveRoleInTransaction(tx, actor, input));
}

/** Roles the UI/agent may list; archived roles stay readable by id (requireRole). */
export function listRecruitingRoles(prisma: PrismaClient, actor: Actor) {
  return prisma.recruitingRole.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    orderBy: { id: "asc" },
  });
}

/** Full revise input: the expected revision with only the supplied fields changed. */
export function mergeRecruitingRoleUpdate(
  current: RoleSnapshot,
  update: Extract<RecruitingRoleMutationInput, { operation: "update" }>,
): Extract<RecruitingRoleDefinitionInput, { operation: "revise" }> {
  const saved = current.revision;
  const removed = new Set(update.criteria?.remove ?? []);
  const upserts = new Map((update.criteria?.upsert ?? []).map((item) => [item.id, item]));
  const criteria = saved.criteria
    .filter((item) => !removed.has(item.id))
    .map((item) => upserts.get(item.id) ?? item);
  for (const item of upserts.values())
    if (!saved.criteria.some((existing) => existing.id === item.id)) criteria.push(item);
  const replaced = new Set((update.sourceRefs ?? []).map((ref) => ref.id));
  // A new revision starts unconfirmed, exactly as a full revise resubmits the draft.
  const savedBrief = saved.brief
    ? (({ confirmation: _, ...draft }) => draft)(saved.brief)
    : saved.brief;
  const merged = RecruitingRoleToolInputSchema.parse({
    operation: "revise",
    roleId: update.roleId,
    expectedRevision: update.expectedRevision,
    title: update.title ?? current.role.title,
    brief: update.brief === undefined ? savedBrief : update.brief,
    sourceRefs: [
      ...saved.sourceRefs.filter((ref) => !replaced.has(ref.id)),
      ...(update.sourceRefs ?? []),
    ],
    criteria,
    preferences: update.preferences ?? saved.preferences,
    definitionQuestions: update.definitionQuestions ?? saved.definitionQuestions,
    intent: update.intent,
  });
  if (merged.operation !== "revise") throw new IsolationError();
  return merged;
}
export type RecruitingRoleToolResult = {
  status: "current" | "saved" | "needs_clarification";
  workspace: RoleSnapshot | null;
  source: RecruitingSourceRef | null;
  changed: boolean;
  /** A new role was saved without its brief, which failed this check; fix it with an update. */
  briefError?: string;
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
      omit: { checkpoint: true },
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

function compareHumanMessages(
  left: Pick<SourceMessage, "threadId" | "seq" | "createdAt">,
  right: Pick<SourceMessage, "threadId" | "seq" | "createdAt">,
): number {
  return left.threadId === right.threadId
    ? left.seq - right.seq
    : left.createdAt.getTime() - right.createdAt.getTime();
}

/**
 * A turn-end auto-continue acts for the recruiter's last message: the system nudge carries no
 * authority of its own, so resolve the newest native human message before it in the thread.
 */
async function autoContinuedHumanMessage(
  tx: Tx,
  run: { threadId: string; sourceMessageId: string | null },
  message: SourceMessage,
): Promise<SourceMessage | null> {
  if (
    message.id !== run.sourceMessageId ||
    message.threadId !== run.threadId ||
    !message.clientNonce?.startsWith("autocontinue:")
  )
    return null;
  const previous = await tx.message.findFirst({
    where: {
      threadId: run.threadId,
      seq: { lt: message.seq },
      role: "user",
      botId: null,
      OR: [{ clientNonce: null }, { NOT: { clientNonce: { startsWith: "autocontinue:" } } }],
    },
    orderBy: { seq: "desc" },
    include: humanMessageInclude,
  });
  return previous && isNativeHumanMessage(previous) ? previous : null;
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
  const newest = answers.reduce(
    (current, answer) => (answer.seq > current.seq ? answer : current),
    hint,
  );
  const latest = (await autoContinuedHumanMessage(tx, run, newest)) ?? newest;
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
  const sourceBlocks = source.blocks as { kind: string; text?: string }[];
  const quoteIndex = sourceBlocks.findIndex(
    (block) =>
      block.kind === "text" && typeof block.text === "string" && block.text.includes(quote),
  );
  if (quoteIndex < 0) {
    const texts = sourceBlocks.flatMap((block) =>
      block.kind === "text" && block.text ? [block.text] : [],
    );
    throw new RecruitingIntentQuoteError(texts.join("\n"), texts[0]);
  }
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

function candidateConsideration(actor: Actor, value: Prisma.JsonValue | null) {
  if (value === null) return null;
  const state = RecruitingCandidateConsiderationSchema.parse(value);
  if (state.source.actor.userId !== actor.userId || state.source.actor.spaceId !== actor.spaceId)
    throw new IsolationError();
  return state;
}

async function requireCandidateConsideration(
  tx: Tx,
  actor: Actor,
  roleId: string,
  candidateKey: string,
) {
  const candidate = await tx.recruitingCandidate.findUnique({
    where: { roleId_candidateKey: { roleId, candidateKey } },
  });
  if (!candidate) throw new IsolationError();
  const state = candidateConsideration(actor, candidate.consideration);
  if (state?.operation === "hold" || state?.operation === "pass")
    throw new RecruitingConflictError(
      state.operation === "hold"
        ? "Candidate is on hold for this role"
        : "Candidate is not being pursued for this role",
    );
}

async function candidateDecisionTarget(
  tx: Tx,
  actor: Actor,
  roleId: string,
  keys: readonly string[],
  revisions: { candidateKey: string; expectedRevision: number }[],
  operation: "hold" | "pass" | "resume",
  human: SourceMessage,
  quote: string,
  allowRecorded = false,
) {
  if (
    !isNativeHumanMessage(human) ||
    !(human.blocks as { kind: string; text?: string }[]).some(
      (block) => block.kind === "text" && block.text?.includes(quote),
    )
  )
    throw new IsolationError();
  const candidates = await tx.recruitingCandidate.findMany({
    where: { roleId, candidateKey: { in: [...keys] } },
    select: { candidateKey: true, revision: true, consideration: true },
  });
  if (candidates.length !== keys.length) throw new IsolationError();
  const existing = new Map(
    candidates.map((candidate) => [
      candidate.candidateKey,
      candidateConsideration(actor, candidate.consideration),
    ]),
  );
  const recorded = candidates.filter((candidate) => {
    const prior = existing.get(candidate.candidateKey);
    return prior?.source.messageId === human.id && prior.operation === operation;
  });
  if (allowRecorded && recorded.length) {
    if (recorded.length !== keys.length) throw new RecruitingConflictError();
    return { candidates, recorded: true };
  }
  for (const candidate of candidates) {
    const expected = revisions.find((item) => item.candidateKey === candidate.candidateKey)!;
    const prior = existing.get(candidate.candidateKey);
    if (
      candidate.revision !== expected.expectedRevision ||
      (prior &&
        (prior.source.messageId === human.id ||
          compareHumanMessages(human, {
            ...prior.source,
            createdAt: new Date(prior.source.createdAt),
          }) <= 0))
    )
      throw new RecruitingConflictError();
  }
  return { candidates, recorded: false };
}

async function setCandidateDecisionInTransaction(
  tx: Tx,
  actor: Actor,
  roleId: string,
  keys: readonly string[],
  revisions: { candidateKey: string; expectedRevision: number }[],
  operation: "hold" | "pass" | "resume",
  human: SourceMessage,
  quote: string,
  allowRecorded = false,
) {
  const { candidates, recorded } = await candidateDecisionTarget(
    tx,
    actor,
    roleId,
    keys,
    revisions,
    operation,
    human,
    quote,
    allowRecorded,
  );
  if (recorded) return "already_recorded" as const;
  const consideration = RecruitingCandidateConsiderationSchema.parse({
    operation,
    source: {
      messageId: human.id,
      threadId: human.threadId,
      seq: human.seq,
      createdAt: human.createdAt.toISOString(),
      quote,
      actor: { userId: actor.userId, spaceId: actor.spaceId },
    },
  });
  for (const candidate of candidates) {
    const changed = await tx.recruitingCandidate.updateMany({
      where: { roleId, candidateKey: candidate.candidateKey, revision: candidate.revision },
      data: { revision: { increment: 1 }, consideration },
    });
    if (changed.count !== 1) throw new RecruitingConflictError();
  }
  return "recorded" as const;
}

export async function authorizeRecruitingFeedbackMessage(
  tx: Tx,
  actor: Actor,
  threadId: string,
  untrusted: unknown,
  messageId?: string,
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
  if (selected.choice === "hold" || selected.choice === "pass" || selected.choice === "resume") {
    const message = messageId
      ? await tx.message.findFirst({
          where: { id: messageId, threadId },
          include: humanMessageInclude,
        })
      : null;
    if (
      !message ||
      !isNativeHumanMessage(message) ||
      verifiedFeedbackChoice(message, role.id, role.revision, selected.candidateKeys) !==
        selected.choice
    )
      throw new IsolationError();
    const block = MessageBlockSchema.array()
      .parse(message.blocks)
      .find((item) => item.kind === "text" && item.recruitingFeedback);
    if (block?.kind !== "text") throw new IsolationError();
    await setCandidateDecisionInTransaction(
      tx,
      actor,
      role.id,
      selected.candidateKeys,
      selected.candidateRevisions!,
      selected.choice,
      message,
      block.text,
    );
    return;
  }
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
  choice?: RecruitingCandidateFeedbackSelection["choice"];
}> {
  return prisma.$transaction(async (tx) => {
    const { message: _message, ...result } = await feedbackContextInTransaction(tx, actor, input);
    return result;
  });
}

async function feedbackContextInTransaction(
  tx: Tx,
  actor: Actor,
  input: Parameters<typeof readRecruitingFeedbackContext>[2],
  authorized?: Awaited<ReturnType<typeof lockLiveRecruitingRun>>,
) {
  const intent = RecruitingHumanIntentSchema.parse(input.intent);
  const sourceRefs = RecruitingSourceRefSchema.array().parse(input.sourceRefs);
  const { run, thread } = authorized ?? (await lockLiveRecruitingRun(tx, actor, input.runId));
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
    if (workspace.role.revision !== input.expectedRoleRevision) throw new RecruitingConflictError();
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
  let choice: RecruitingCandidateFeedbackSelection["choice"] | undefined;
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
    message,
    workspace,
    threadId: run.threadId,
    botId: run.botId,
    ...(choice ? { choice } : {}),
  };
}

type NativeCandidateDecisionContext = ResearchLease & {
  threadId: string;
  botId: string;
  sourceMessageId: string | null;
};

async function nativeCandidateDecisionContext(
  tx: Tx,
  actor: Actor,
  trusted: NativeCandidateDecisionContext,
  input: Extract<RecruitingFeedbackInput, { target: "candidate" }>,
  authorized?: Awaited<ReturnType<typeof lockLiveRecruitingRun>>,
) {
  const current = authorized ?? (await lockLiveRecruitingRun(tx, actor, trusted.runId));
  if (current.run.threadId !== trusted.threadId || current.run.botId !== trusted.botId)
    throw new IsolationError();
  requireResearchLease(current.run, trusted);
  const context = await feedbackContextInTransaction(
    tx,
    actor,
    { ...input, runId: trusted.runId, sourceMessageId: trusted.sourceMessageId },
    current,
  );
  if (!context.workspace || (context.choice && context.choice !== input.operation))
    throw new IsolationError();
  return { ...context, workspace: context.workspace };
}

export async function prepareNativeRecruitingCandidateDecision(
  prisma: PrismaClient,
  actor: Actor,
  trusted: NativeCandidateDecisionContext,
  raw: unknown,
) {
  const input = RecruitingFeedbackInputSchema.parse(raw);
  if (
    input.target !== "candidate" ||
    input.operation === "review" ||
    input.intent.basis !== "direct"
  )
    throw new IsolationError();
  const operation = input.operation;
  return prisma.$transaction(async (tx) => {
    const context = await nativeCandidateDecisionContext(tx, actor, trusted, input);
    await candidateDecisionTarget(
      tx,
      actor,
      input.roleId,
      input.candidateKeys,
      input.candidateRevisions!,
      operation,
      context.message,
      input.intent.quote,
      true,
    );
    const profiles = await candidateProfiles(tx, actor, input.roleId, input.candidateKeys);
    if (profiles.some((profile) => !profile.name?.trim()) || !context.workspace.role.title.trim())
      throw new IsolationError();
    return {
      candidateNames: profiles.map((profile) => profile.name!),
      roleTitle: context.workspace.role.title,
      operation,
    };
  });
}

export async function executeNativeRecruitingCandidateDecision(
  prisma: PrismaClient,
  actor: Actor,
  trusted: NativeCandidateDecisionContext & { effectId: string; effectRequest: unknown },
  raw: unknown,
) {
  const input = RecruitingFeedbackInputSchema.parse(raw);
  if (
    input.target !== "candidate" ||
    input.operation === "review" ||
    input.intent.basis !== "direct" ||
    stableJsonValue(input) !== stableJsonValue(trusted.effectRequest)
  )
    throw new IsolationError();
  const decision = input.operation;
  return prisma.$transaction(async (tx) => {
    const authorized = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    const { run } = authorized;
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
        kind: "recruiting_feedback",
      },
    });
    if (!effect || stableJsonValue(effect.request) !== stableJsonValue(input))
      throw new IsolationError();
    if (effect.status === "completed") {
      const result = effect.result as {
        status?: unknown;
        feedback?: unknown;
        source?: unknown;
        workspace?: { role?: unknown; revision?: unknown };
        choice?: unknown;
      } | null;
      if (
        !result ||
        !["recorded", "already_recorded"].includes(String(result.status)) ||
        stableJsonValue(RecruitingFeedbackInputSchema.parse(result.feedback)) !==
          stableJsonValue(input)
      )
        throw new IsolationError();
      const workspace = {
        role: RecruitingRoleSchema.parse(result.workspace?.role),
        revision: RecruitingRoleRevisionSchema.parse(result.workspace?.revision),
      };
      if (workspace.role.id !== input.roleId) throw new IsolationError();
      return {
        feedback: input,
        source: RecruitingSourceRefSchema.parse(result.source),
        workspace,
        status: result.status as "recorded" | "already_recorded",
        ...(result.choice ? { choice: RecruitingFeedbackChoiceSchema.parse(result.choice) } : {}),
      };
    }
    if (effect.status !== "executing") throw new IsolationError();
    const context = await nativeCandidateDecisionContext(tx, actor, trusted, input, authorized);
    const status = await setCandidateDecisionInTransaction(
      tx,
      actor,
      input.roleId,
      input.candidateKeys,
      input.candidateRevisions!,
      decision,
      context.message,
      input.intent.quote,
      true,
    );
    const result = {
      feedback: input,
      source: context.source,
      workspace: context.workspace,
      status,
      ...(context.choice ? { choice: context.choice } : {}),
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
      data: { status: "completed", result: result as unknown as Prisma.InputJsonValue },
    });
    if (completed.count !== 1) throw new IsolationError();
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.recorded",
      payload: { effectId: effect.id, tool: "recruiting_feedback", result },
    });
    return result;
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
            operation: ["hold", "pass", "resume"].includes(selected.choice)
              ? selected.choice
              : "review",
            ...(selected.candidateRevisions
              ? { candidateRevisions: selected.candidateRevisions }
              : {}),
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
    const verified = new Set<string>();
    for (const record of feedback) {
      const human =
        record.source.anchor.kind === "message"
          ? byId.get(record.source.anchor.messageId)
          : undefined;
      // Chat deletion removes navigable proof, not the independent candidate consideration.
      if (!human) continue;
      if (!isNativeHumanMessage(human)) throw new IsolationError();
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
      verified.add(record.id);
    }
    feedback.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    const page = feedback.slice(0, input.limit);
    return ListRecruitingFeedbackOutput.parse({
      feedback: page.filter((record) => verified.has(record.id)),
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
    previousAnchor: edit.previousAnchor,
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
  // A partial update is merged onto its expected revision before materials load; the locked
  // transaction below still rejects it if that revision is no longer current.
  const archiveInput =
    input.operation === "archive" || input.operation === "unarchive" ? input : undefined;
  let definitionInput: RecruitingRoleDefinitionInput | undefined =
    input.operation === "update" || input.operation === "archive" || input.operation === "unarchive"
      ? undefined
      : input;
  let materialSource: Pick<RecruitingRoleRevision, "sourceRefs" | "criteria"> | undefined =
    input.operation === "bind" ||
    input.operation === "update" ||
    input.operation === "archive" ||
    input.operation === "unarchive"
      ? undefined
      : input;
  if (input.operation === "update") {
    const current = await prisma.$transaction((tx) =>
      requireRole(tx, actor, input.roleId).then((role) => roleSnapshot(tx, actor, role)),
    );
    if (current.role.revision === input.expectedRevision)
      definitionInput = mergeRecruitingRoleUpdate(current, input);
    materialSource = definitionInput?.operation === "revise" ? definitionInput : current.revision;
  }
  const artifacts = materialSource
    ? await loadRoleMaterials(prisma, actor, materialSource, material)
    : new Map<string, Uint8Array>();
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
        if (saved.status === "saved" && input.operation !== "bind" && !archiveInput)
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
                workspace.role.revision !== input.expectedRevision + (archiveInput ? 0 : 1)))
      )
        throw new IsolationError();
      return { status: saved.status, workspace, source, changed: saved.changed };
    }
    requireResearchLease(run, context);
    if (effect.status !== "executing") throw new IsolationError();
    if (!definitionInput && !archiveInput) throw new RecruitingConflictError();
    const { source: humanSource, message: source } = await requireCurrentHumanSource(
      tx,
      actor,
      run,
      context.sourceMessageId,
      input.intent.quote,
      input.operation === "create",
    );
    const currentRole = thread.activeRecruitingRoleId
      ? await requireRole(tx, actor, thread.activeRecruitingRoleId, true, thread)
      : null;
    const current = currentRole ? await roleSnapshot(tx, actor, currentRole, thread) : null;
    if (definitionInput?.operation === "revise") {
      if (current?.role.id !== definitionInput.roleId) throw new IsolationError();
      if (current.role.revision !== definitionInput.expectedRevision)
        throw new RecruitingConflictError();
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
    let briefError: string | undefined;
    if (input.intent.basis === "inferred")
      result = {
        status: "needs_clarification",
        workspace: current,
        source: humanSource,
        changed: false,
      };
    else {
      let workspace: RoleSnapshot | null;
      if (archiveInput) {
        workspace = await archiveRoleInTransaction(tx, actor, archiveInput);
      } else if (!definitionInput) {
        throw new RecruitingConflictError();
      } else if (definitionInput.operation === "bind") {
        workspace = await bindRoleInTransaction(tx, actor, {
          threadId: run.threadId,
          roleId: definitionInput.roleId,
        });
      } else {
        const definition = {
          title: definitionInput.title,
          brief: definitionInput.brief,
          sourceRefs: [
            ...definitionInput.sourceRefs.filter((ref) => ref.id !== humanSource.id),
            humanSource,
          ],
          criteria: definitionInput.criteria,
          preferences: definitionInput.preferences,
          definitionQuestions: definitionInput.definitionQuestions,
        };
        definition.sourceRefs.push(
          ...(await citedHumanMessageSources(tx, run.threadId, definition)),
        );
        const create = async (brief: typeof definition.brief) =>
          createRoleInTransaction(
            tx,
            actor,
            CreateRecruitingRoleInput.parse({
              ...definition,
              brief,
              expectedRevision: 0,
              sourceThreadId: run.threadId,
            }),
            artifacts,
          );
        // A new role is the anchor every later step needs. When only its brief fails a check
        // (they run before any write), save the role without it and return what to fix.
        workspace =
          definitionInput.operation === "create"
            ? await create(definition.brief).catch((error: unknown) => {
                if (
                  !definition.brief ||
                  !(
                    error instanceof RecruitingPlaybookValidationError ||
                    (error instanceof Error && error.name === "ZodError")
                  )
                )
                  throw error;
                briefError = error.message;
                return create(null);
              })
            : await reviseRoleInTransaction(
                tx,
                actor,
                ReviseRecruitingRoleInput.parse({
                  ...definition,
                  roleId: definitionInput.roleId,
                  expectedRevision: definitionInput.expectedRevision,
                }),
                artifacts,
                currentRole!,
                thread,
              );
      }
      result = {
        status: "saved",
        workspace,
        source: humanSource,
        changed:
          input.operation !== "bind" || current?.role.id !== (workspace?.role.id ?? undefined),
        ...(briefError ? { briefError } : {}),
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
    crmSourceMaterial?: RecruitingCrmSourceMaterial;
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
    if (input.crmSourceMaterial) {
      const current = await workspaceCrmSourceMaterial(tx, actor, input);
      if (stableJsonValue(current) !== stableJsonValue(input.crmSourceMaterial))
        throw new RecruitingConflictError();
    }
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
  authorizedThread?: Awaited<ReturnType<typeof requireThread>>,
) {
  await validateSources(tx, actor, sources, authorizedThread);
  const unique = new Map(sources.map((source) => [stableJsonValue(source), source]));
  const messageIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const source of unique.values()) {
    if (source.readState === "read" && source.quote === undefined) continue;
    if (source.anchor.kind === "message") messageIds.add(source.anchor.messageId);
    else artifactIds.add(source.anchor.artifact.artifactId);
  }
  if (messageIds.size)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "messages" WHERE "id" IN (${Prisma.join([...messageIds].sort())}) ORDER BY "id" FOR SHARE`,
    );
  if (artifactIds.size)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "artifacts" WHERE "id" IN (${Prisma.join([...artifactIds].sort())}) ORDER BY "id" FOR SHARE`,
    );
  // ponytail: reuse locked rows only within this validation call; every quote is checked below.
  const loadedMessages = messageIds.size
    ? await tx.message.findMany({
        where: { id: { in: [...messageIds] } },
        include: humanMessageInclude,
      })
    : [];
  if (loadedMessages.length !== messageIds.size) throw new IsolationError();
  const messages = new Map(loadedMessages.map((message) => [message.id, message]));
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
  for (const source of unique.values()) {
    // A role reference without a quote remains a locator; it does not attest to material text.
    if (source.readState === "read" && source.quote === undefined) continue;
    const selection = "selection" in source ? source.selection : undefined;
    if (source.anchor.kind === "message") {
      const message = messages.get(source.anchor.messageId);
      if (!message) throw new IsolationError();
      if (source.readState !== "read" || source.quote === undefined) continue;
      if (!isNativeHumanMessage(message) || source.kind === "provider_report")
        throw new RecruitingSourceCheckError(
          source.id,
          "only a message the recruiter wrote can be cited, as original_material.",
        );
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
        throw new RecruitingSourceCheckError(
          source.id,
          'locator must name a text block of that message, such as "blocks[0].text".',
        );
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
        artifact = await tx.artifact.findUniqueOrThrow({
          where: { id: source.anchor.artifact.artifactId },
        });
        rows.set(artifact.id, artifact);
      }
      if (artifact.hash !== source.anchor.artifact.sha256)
        throw new RecruitingSourceCheckError(
          source.id,
          "sha256 is not this file's fingerprint; cite the file as the reader returned it.",
        );
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
        proof.providerArtifact
          ? source.kind !== "provider_report"
          : source.kind === "provider_report" ||
            (proof.readReceipt !== null && source.kind !== "original_material")
      )
        throw new RecruitingSourceCheckError(
          source.id,
          `kind must be ${proof.providerArtifact ? "provider_report for a research result" : "original_material for a page or file you read"}.`,
        );
      if (!proof.providerArtifact && artifact.runId !== null && !proof.readReceipt)
        throw new RecruitingSourceCheckError(
          source.id,
          "this file has no read receipt; read the page with web_fetch and cite what it returned, or cite the recruiter's message.",
        );
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
          throw new RecruitingSourceCheckError(
            source.id,
            `url and readAt must be the reader's: ${JSON.stringify(proof.payload.url)} and ${JSON.stringify(proof.payload.readAt)}.`,
          );
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
        throw new RecruitingSourceCheckError(source.id, 'locator must be "text" for a file.');
      const json = artifact.mimeType === "application/json" || artifact.mimeType.endsWith("+json");
      const pdf = artifact.mimeType === "application/pdf";
      const jsonPath =
        selection?.kind === "artifact_json_string"
          ? selection.path
          : !selection && json
            ? ["text"]
            : undefined;
      if (jsonPath ? !json : (!artifact.mimeType.startsWith("text/") && !pdf) || json)
        throw new RecruitingSourceCheckError(
          source.id,
          "this file type has no quotable text; quote the page text or the recruiter's message.",
        );
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
  return messages;
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

type LooseRecord = Record<string, unknown>;
const looseRecord = (value: unknown): value is LooseRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);
const looseArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Fill a role save from the server's own records before it is checked, so a value the model
 * copied imperfectly never rejects the save. Ownership is unchanged: every artifact, message and
 * role read here is scoped to the actor, and the save still runs every isolation check.
 * - A file reference takes its fingerprint from the file row and its url and read time from the
 *   native read receipt; a role reference without a selection reads the extracted text.
 * - An update or revise acts on the conversation's current role.
 * - A brief that cites a source id the save does not define cites the recruiter's message that
 *   holds that value (else their latest message) for their own words, or the role's only
 *   material for JD facts.
 * - A criterion with no brief rule gets the rule its priority implies.
 */
export async function fillRecruitingRoleArgs(
  prisma: PrismaClient,
  actor: Actor,
  context: { threadId: string },
  args: LooseRecord,
): Promise<LooseRecord> {
  if (args.operation !== "create" && args.operation !== "update" && args.operation !== "revise")
    return args;
  const ids = new Set<string>();
  const artifactOf = (value: unknown) => {
    const anchor = looseRecord(value) ? value.anchor : undefined;
    return looseRecord(anchor) &&
      anchor.kind === "artifact" &&
      looseRecord(anchor.artifact) &&
      typeof anchor.artifact.artifactId === "string"
      ? anchor.artifact.artifactId
      : null;
  };
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (looseRecord(value)) {
      const id = artifactOf(value);
      if (id) ids.add(id);
      Object.values(value).forEach(collect);
    }
  };
  collect(args);
  const [thread, files, events] = await Promise.all([
    prisma.thread
      .findUniqueOrThrow({
        where: { id: context.threadId },
        select: { spaceId: true, userId: true, activeRecruitingRoleId: true },
      })
      .then((row) => (row.spaceId === actor.spaceId && row.userId === actor.userId ? row : null)),
    ids.size
      ? prisma.artifact.findMany({
          where: { id: { in: [...ids] }, spaceId: actor.spaceId, userId: actor.userId },
          select: { id: true, hash: true },
        })
      : [],
    ids.size
      ? prisma.event.findMany({
          where: {
            spaceId: actor.spaceId,
            type: "recruiting.material.read",
            OR: [...ids].map((id) => ({
              payload: { path: ["artifact", "artifactId"], equals: id },
            })),
          },
          select: { payload: true },
        })
      : [],
  ]);
  const hashes = new Map(files.map((file) => [file.id, file.hash]));
  const receipts = new Map<string, { url: string; readAt: string }>();
  for (const event of events) {
    const payload = RecruitingMaterialReadPayloadSchema.safeParse(event.payload);
    if (
      payload.success &&
      hashes.get(payload.data.artifact.artifactId) === payload.data.artifact.sha256
    )
      receipts.set(payload.data.artifact.artifactId, {
        url: payload.data.url,
        readAt: payload.data.readAt,
      });
  }
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (!looseRecord(value)) return value;
    const record = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item)]),
    );
    const id = artifactOf(value);
    const hash = id ? hashes.get(id) : undefined;
    if (!id || !hash || !looseRecord(record.anchor)) return record;
    const anchor = record.anchor as LooseRecord;
    const filled: LooseRecord = {
      ...record,
      anchor: {
        ...anchor,
        artifact: { ...(anchor.artifact as LooseRecord), sha256: hash },
        ...(record.selection === undefined ? { locator: "text" } : {}),
      },
    };
    const receipt = receipts.get(id);
    return receipt && record.kind === "original_material" ? { ...filled, ...receipt } : filled;
  };
  let filled = fill(args) as LooseRecord;
  // A citation of a message outside this conversation (a made-up or mistyped id) cites the
  // recruiter's latest message instead, as a plain locator, so the save does not fail on it.
  const messageIds = new Set<string>();
  const messageOf = (value: unknown) => {
    const anchor = looseRecord(value) ? value.anchor : undefined;
    return looseRecord(anchor) && anchor.kind === "message" && typeof anchor.messageId === "string"
      ? anchor.messageId
      : null;
  };
  const collectMessages = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collectMessages);
    else if (looseRecord(value)) {
      const id = messageOf(value);
      if (id) messageIds.add(id);
      Object.values(value).forEach(collectMessages);
    }
  };
  collectMessages(filled);
  if (messageIds.size && thread) {
    const [present, latest] = await Promise.all([
      prisma.message.findMany({
        where: { id: { in: [...messageIds] }, threadId: context.threadId },
        select: { id: true },
      }),
      prisma.message.findFirst({
        where: { threadId: context.threadId, role: "user" },
        orderBy: { seq: "desc" },
        select: { id: true },
      }),
    ]);
    const known = new Set(present.map((message) => message.id));
    const repoint = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(repoint);
      if (!looseRecord(value)) return value;
      const record = Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, repoint(item)]),
      );
      const id = messageOf(value);
      if (!id || known.has(id) || !latest) return record;
      getLogger().warn("recruiting.source.repaired", { reason: "message_not_in_thread" });
      const { quote: _quote, ...rest } = record;
      return {
        ...rest,
        anchor: { kind: "message", messageId: latest.id, locator: "blocks[0].text" },
      };
    };
    filled = repoint(filled) as LooseRecord;
  }
  if (
    (filled.operation === "update" || filled.operation === "revise") &&
    thread?.activeRecruitingRoleId
  )
    filled.roleId = thread.activeRecruitingRoleId;
  const saved =
    filled.operation === "update" && thread?.activeRecruitingRoleId
      ? await prisma.recruitingRole
          .findFirst({
            where: {
              id: thread.activeRecruitingRoleId,
              spaceId: actor.spaceId,
              userId: actor.userId,
            },
            select: { currentRevisionId: true },
          })
          .then((role) =>
            role
              ? prisma.recruitingRoleRevision.findUnique({
                  where: { id: role.currentRevisionId },
                  select: { sourceRefs: true, criteria: true },
                })
              : null,
          )
      : null;
  // One source ID names one reference. A reused ID on a different reference (another quote) gets
  // a fresh ID instead of failing the save; citations by the old ID keep the first reference.
  const byId = new Map<string, string>();
  for (const source of [
    ...looseArray(saved?.sourceRefs),
    ...looseArray(saved?.criteria).flatMap((criterion) =>
      looseRecord(criterion) ? looseArray(criterion.sourceRefs) : [],
    ),
  ])
    if (looseRecord(source) && typeof source.id === "string")
      byId.set(source.id, stableJsonValue(source));
  const distinct = (references: unknown) =>
    Array.isArray(references)
      ? references.map((source) => {
          if (!looseRecord(source) || typeof source.id !== "string") return source;
          const value = stableJsonValue(source);
          let id = source.id;
          for (let n = 2; byId.has(id) && byId.get(id) !== value; n++) id = `${source.id}-${n}`;
          byId.set(id, value);
          return id === source.id ? source : { ...source, id };
        })
      : references;
  filled.sourceRefs = distinct(filled.sourceRefs);
  if (filled.sourceRefs === undefined) delete filled.sourceRefs;
  const criterionList = looseRecord(filled.criteria)
    ? looseArray(filled.criteria.upsert)
    : looseArray(filled.criteria);
  const deduped = criterionList.map((criterion) =>
    looseRecord(criterion)
      ? { ...criterion, sourceRefs: distinct(criterion.sourceRefs) }
      : criterion,
  );
  if (Array.isArray(filled.criteria)) filled.criteria = deduped;
  else if (looseRecord(filled.criteria) && Array.isArray(filled.criteria.upsert))
    filled.criteria = { ...filled.criteria, upsert: deduped };
  if (!looseRecord(filled.brief)) return filled;
  // Brief citations and rules resolve against the sources this save (and, for an update, the
  // current revision) defines.
  const criteria = [
    ...looseArray(filled.criteria),
    ...(looseRecord(filled.criteria) ? looseArray(filled.criteria.upsert) : []),
    ...looseArray(saved?.criteria),
  ].filter(looseRecord);
  const sources = [
    ...looseArray(filled.sourceRefs),
    ...criteria.flatMap((criterion) => looseArray(criterion.sourceRefs)),
    ...looseArray(saved?.sourceRefs),
  ].filter(looseRecord);
  const known = new Set(sources.map((source) => source.id));
  // The role's material: read pages first, then pasted messages, in the order the role lists them.
  const quoted = sources.filter(
    (source) => source.kind === "original_material" && typeof source.quote === "string",
  );
  const onPage = (source: LooseRecord) =>
    looseRecord(source.anchor) && source.anchor.kind === "artifact";
  const material = [
    ...new Map(
      [...quoted.filter(onPage), ...quoted.filter((source) => !onPage(source))].map((source) => [
        source.id,
        source,
      ]),
    ).values(),
  ];
  let humans: { id: string; text: string }[] | undefined;
  const humanMessages = async () => {
    humans ??= (
      await prisma.message.findMany({
        where: { threadId: context.threadId, role: "user", botId: null },
        include: humanMessageInclude,
        orderBy: { seq: "desc" },
        take: 50,
      })
    )
      .filter(isNativeHumanMessage)
      .map((message) => ({
        id: message.id,
        text: (message.blocks as { kind: string; text?: string }[])
          .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
          .join("\n"),
      }));
    return humans;
  };
  const resolve = async (id: unknown, origin: unknown, value: unknown) => {
    if (typeof id !== "string" || known.has(id) || /^human-message:.+/.test(id)) return id;
    const fromMaterial = origin === "jd" || origin === "hm" || !/^human/i.test(id);
    if (origin !== "user_instruction" && fromMaterial) {
      const text = typeof value === "string" ? value.trim() : "";
      const holder =
        (text && material.find((source) => String(source.quote).includes(text))) || material[0];
      return holder ? holder.id : id;
    }
    const messages = await humanMessages();
    const text = typeof value === "string" ? value.trim() : "";
    const holder = (text && messages.find((message) => message.text.includes(text))) || messages[0];
    return holder ? `human-message:${holder.id}` : id;
  };
  const brief = { ...filled.brief } as LooseRecord;
  for (const key of ["fields", "searchFilters", "rules"] as const) {
    if (!Array.isArray(brief[key])) continue;
    brief[key] = await Promise.all(
      (brief[key] as unknown[]).map(async (item) => {
        if (!looseRecord(item)) return item;
        const value = item.value ?? item.statement;
        const given = looseArray(item.sourceRefIds);
        // A sourced fact without a citation cites what holds it; "human" and "jd" are placeholders
        // that resolve() maps to the recruiter's message or the role's material.
        const wanted =
          given.length || item.origin === "inferred" || item.state === "missing"
            ? given
            : [item.origin === "user_instruction" ? "human" : "jd"];
        const refs = await Promise.all(wanted.map((ref) => resolve(ref, item.origin, value)));
        return {
          ...item,
          sourceRefIds: [...new Set(refs)].filter(
            (ref) =>
              given.includes(ref) ||
              known.has(ref as string) ||
              /^human-message:/.test(String(ref)),
          ),
        };
      }),
    );
  }
  // A question must ask about a field of this brief: one on a near-miss key ("Locations",
  // "work-location") moves to that field, and one on a field the brief lacks is dropped.
  if (Array.isArray(brief.questions) && Array.isArray(brief.fields)) {
    const loose = (key: unknown) =>
      String(key)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .replace(/s$/, "");
    const keys = brief.fields.flatMap((field) =>
      looseRecord(field) && typeof field.key === "string" ? [field.key] : [],
    );
    brief.questions = brief.questions.flatMap((question) => {
      if (!looseRecord(question) || keys.includes(question.fieldKey as string)) return [question];
      const key = keys.find((candidate) => loose(candidate) === loose(question.fieldKey));
      return key ? [{ ...question, fieldKey: key }] : [];
    });
  }
  if (Array.isArray(brief.questions))
    brief.questions = await Promise.all(
      brief.questions.map(async (question) =>
        looseRecord(question) && typeof question.answeredBySourceRefId === "string"
          ? {
              ...question,
              answeredBySourceRefId: await resolve(
                question.answeredBySourceRefId,
                "user_instruction",
                undefined,
              ),
            }
          : question,
      ),
    );
  const rules = Array.isArray(brief.rules) ? brief.rules : [];
  brief.rules = rules;
  const ruled = new Set(rules.flatMap((rule) => (looseRecord(rule) ? [rule.criterionId] : [])));
  const removed = new Set(looseRecord(filled.criteria) ? looseArray(filled.criteria.remove) : []);
  for (const criterion of criteria) {
    if (ruled.has(criterion.id) || removed.has(criterion.id)) continue;
    const cited = looseArray(criterion.sourceRefs).find(
      (source) => looseRecord(source) && typeof source.quote === "string",
    ) as LooseRecord | undefined;
    const source = cited ?? material[0];
    if (typeof source?.id !== "string") continue;
    ruled.add(criterion.id);
    rules.push({
      criterionId: criterion.id,
      origin:
        looseRecord(source.anchor) && source.anchor.kind === "message" ? "user_instruction" : "jd",
      effect: criterion.priority === "hard" ? "reject" : "flag",
      sourceRefIds: [source.id],
    });
  }
  return { ...filled, brief };
}

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
  stage: RetainedRecruitingApprovalRequest["stage"];
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
  input: Pick<RetainedRecruitingApprovalRequest, "roleId" | "expectedRoleRevision"> & {
    stage?: RetainedRecruitingApprovalRequest["stage"];
  },
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
  if (input.stage === "brief") {
    requireConfirmableBrief(revision);
    if (revision.brief!.confirmation) throw new RecruitingConflictError();
    return { role, revision, thread };
  }
  requireRecruitingBriefConfirmation(revision);
  const confirmation = revision.brief!.confirmation!;
  const human = await tx.message.findUnique({
    where: { id: confirmation.messageId },
    include: humanMessageInclude,
  });
  if (confirmation.userId !== actor.userId || !human || !isNativeHumanMessage(human))
    throw new IsolationError();
  await requireThread(tx, actor, human.threadId);
  return { role, revision, thread };
}

async function approvalAnswerProof(
  tx: Tx,
  actor: Actor,
  effect: { id: string; runId: string; request: unknown },
  authorizedRun?: Awaited<ReturnType<typeof requireRun>>,
) {
  const run =
    authorizedRun?.id === effect.runId ? authorizedRun : await requireRun(tx, actor, effect.runId);
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

/** This role revision's latest approved documents package, for a calibration request that omits it. */
export async function latestRecruitingDocumentsApprovalId(
  prisma: Pick<PrismaClient, "externalEffect">,
  actor: Actor,
  input: { roleId: string; expectedRoleRevision: number },
): Promise<string | null> {
  const effect = await prisma.externalEffect.findFirst({
    where: {
      spaceId: actor.spaceId,
      kind: "recruiting_request_approval",
      status: "completed",
      AND: [
        { request: { path: ["stage"], equals: "documents" } },
        { request: { path: ["roleId"], equals: input.roleId } },
        { request: { path: ["expectedRoleRevision"], equals: input.expectedRoleRevision } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return effect?.id ?? null;
}

/**
 * The ten profiles of the latest unapproved calibration round, with their exact saved sources,
 * so a calibration approval need not copy long source ids by hand. Null when no complete round
 * of this revision is recorded. prepareRecruitingApproval still verifies every field.
 */
export async function latestRecruitingCalibrationProfiles(
  prisma: Pick<PrismaClient, "recruitingRoleRevision" | "recruitingCalibrationRound"> & {
    recruitingCandidateOccurrence: Pick<PrismaClient["recruitingCandidateOccurrence"], "findFirst">;
  },
  actor: Actor,
  input: { roleId: string; expectedRoleRevision: number },
) {
  const revision = await prisma.recruitingRoleRevision.findFirst({
    where: {
      roleId: input.roleId,
      revision: input.expectedRoleRevision,
      role: { spaceId: actor.spaceId },
    },
    select: { id: true },
  });
  if (!revision) return null;
  const round = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId: input.roleId, approvedAt: null },
    orderBy: { round: "desc" },
    select: { candidateKeys: true },
  });
  if (round?.candidateKeys.length !== 10) return null;
  const profiles = [];
  for (const candidateKey of round.candidateKeys) {
    const occurrence = await prisma.recruitingCandidateOccurrence.findFirst({
      where: {
        roleId: input.roleId,
        candidateKey,
        linkedinUrl: { not: null },
        page: { roleRevisionId: revision.id, taskId: null, actionId: null },
      },
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
      include: { page: { include: { effect: { select: { request: true } } } } },
    });
    if (!occurrence?.linkedinUrl || unassessedPageRequest(occurrence.page.effect.request))
      return null;
    let reference: ReturnType<typeof candidateSourceReference>;
    try {
      reference = candidateSourceReference(occurrence.page, occurrence.rowIndex);
    } catch (error) {
      if (error instanceof IsolationError) return null;
      throw error;
    }
    const { providerTaskId, roleRevisionId, effectId, rowIndex, artifactRef } = reference;
    if (!providerTaskId) return null;
    const evidence = Array.isArray(occurrence.evidenceUrls)
      ? occurrence.evidenceUrls.find(
          (url): url is string => typeof url === "string" && url.startsWith("https://"),
        )
      : undefined;
    profiles.push({
      candidateKey,
      linkedinUrl: occurrence.linkedinUrl,
      evidenceUrl: evidence ?? occurrence.linkedinUrl,
      source: { providerTaskId, roleRevisionId, effectId, rowIndex, artifactRef },
    });
  }
  return profiles;
}

async function completedRecruitingApproval(
  tx: Tx,
  actor: Actor,
  effectId: string,
  scope: { roleId: string; expectedRoleRevision: number },
  stage: RetainedRecruitingApprovalRequest["stage"],
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
  const input = RetainedRecruitingApprovalRequestSchema.parse(effect.request);
  if (
    input.stage !== stage ||
    input.roleId !== scope.roleId ||
    input.expectedRoleRevision !== scope.expectedRoleRevision
  )
    throw new RecruitingConflictError();
  const { run, proof } = await approvalAnswerProof(tx, actor, effect);
  const workspace = await approvalWorkspace(tx, actor, run.threadId, input, current, false);
  let approvedRevisionId = workspace.revision.id;
  if (input.stage === "brief") {
    const row = await tx.recruitingRoleRevision.findFirst({
      where: { roleId: input.roleId, revision: input.expectedRoleRevision + 1 },
    });
    if (!row) throw new IsolationError();
    const revision = RecruitingRoleRevisionSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
    });
    const confirmation = revision.brief?.confirmation;
    const human =
      confirmation &&
      (await tx.message.findUnique({
        where: { id: confirmation.messageId },
        include: humanMessageInclude,
      }));
    if (
      !confirmation ||
      confirmation.revision !== input.expectedRoleRevision + 1 ||
      confirmation.userId !== actor.userId ||
      confirmation.confirmedAt !== proof.createdAt.toISOString() ||
      !human ||
      !isNativeHumanMessage(human) ||
      human.threadId !== run.threadId ||
      human.runId !== run.id ||
      stableJsonValue(
        definitionData({
          ...revision,
          expectedRevision: revision.revision,
          title: workspace.role.title,
        }),
      ) !==
        stableJsonValue(
          definitionData({
            ...workspace.revision,
            expectedRevision: input.expectedRoleRevision,
            title: workspace.role.title,
          }),
        )
    )
      throw new IsolationError();
    approvedRevisionId = revision.id;
  }
  const expected: RecruitingApprovalResult = {
    status: "approved",
    stage: input.stage,
    roleId: input.roleId,
    roleRevisionId: approvedRevisionId,
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
  const package_ = await recruitingApprovalPackage(tx, actor, input, current, undefined, workspace);
  return { input, result: expected, package: package_, workspace };
}

type RecruitingApprovalPackage = {
  files: MessageBlock[];
  documentRefs: RecruitingArtifactRef[];
  sourceRefs: RecruitingAssessmentSourceRef[];
  profiles?: { name: string; linkedinUrl: string; evidenceUrl: string }[];
  requirements?: string;
};

async function recruitingApprovalPackage(
  tx: Tx,
  actor: Actor,
  input: RetainedRecruitingApprovalRequest,
  current = true,
  bytes?: ReadonlyMap<string, Uint8Array>,
  workspace?: Awaited<ReturnType<typeof approvalWorkspace>>,
): Promise<RecruitingApprovalPackage> {
  if (input.stage === "brief") {
    if (!workspace || workspace.revision.revision !== input.expectedRoleRevision)
      throw new IsolationError();
    const { revision, role, thread } = workspace;
    requireConfirmableBrief(revision);
    if (bytes) {
      const messages = await validateReadSources(
        tx,
        actor,
        definitionSources(revision),
        bytes,
        thread,
      );
      validateBriefAuthorship(
        { ...revision, title: role.title, expectedRevision: revision.revision },
        messages,
      );
    }
    const brief = revision.brief!;
    return {
      files: [],
      documentRefs: [],
      sourceRefs: definitionSources(revision),
      requirements: [
        ...brief.fields.map(
          (field) =>
            `${field.key.replaceAll("_", " ")}: ${field.value ?? "Unknown"}${field.state === "conflict" ? " (Conflicting information)" : field.state === "missing" && field.value !== null ? " (Unconfirmed)" : ""}${field.origin === "inferred" ? " (Assumption)" : ""}`,
        ),
        ...brief.searchFilters.map(
          (filter) =>
            `Search ${filter.mode}: ${filter.statement}${filter.origin === "inferred" ? " (Assumption)" : ""}`,
        ),
        ...revision.criteria.map((criterion) => {
          const rule = brief.rules.find((rule) => rule.criterionId === criterion.id)!;
          return `${criterion.priority === "hard" ? "Required" : "Preferred"}: ${criterionStatement(criterion.expression, true)} (${rule.effect === "reject" ? "Reject if not met" : "Flag for review"}${rule.origin === "inferred" ? "; Assumption" : ""})`;
        }),
        ...revision.preferences.map((preference) => `Preference: ${preference}`),
        ...revision.definitionQuestions.map((question) => `Open question: ${question}`),
        ...revision.criteria.flatMap((criterion) =>
          criterion.definitionQuestions.map((question) => `Open question: ${question}`),
        ),
      ].join("\n"),
    };
  }
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
    const nativeRefs = input.profiles.flatMap((profile) =>
      "source" in profile ? [profile.source] : [],
    );
    const pageIds = [...new Set(nativeRefs.map((ref) => ref.effectId))];
    const pages = pageIds.length
      ? await tx.recruitingCandidatePage.findMany({
          where: { roleId: input.roleId, effectId: { in: pageIds } },
          include: { effect: { select: { request: true, result: true } } },
        })
      : [];
    if (pages.length !== pageIds.length) throw new IsolationError();
    const artifacts = await candidatePageArtifacts(tx, actor, pages, true);
    const savedPages = new Map(pages.map((page) => [page.effectId, page]));
    const profiles: NonNullable<RecruitingApprovalPackage["profiles"]> = [];
    const sources: RecruitingAssessmentSourceRef[] = [];
    for (const profile of input.profiles) {
      if ("source" in profile) {
        const ref = profile.source;
        const page = savedPages.get(ref.effectId);
        const artifact = artifacts.get(ref.effectId);
        if (
          !page ||
          !artifact ||
          page.roleId !== input.roleId ||
          page.roleRevisionId !== documents.result.roleRevisionId ||
          ref.roleRevisionId !== page.roleRevisionId ||
          artifact.id !== ref.artifactRef.artifactId ||
          artifact.hash !== ref.artifactRef.sha256 ||
          page.rowCount === null ||
          ref.rowIndex >= page.rowCount ||
          researchReadRequest(page.effect.request, undefined, "get_rows").args.task_id !==
            ref.providerTaskId
        )
          throw new IsolationError();
        const occurrence = await tx.recruitingCandidateOccurrence.findUnique({
          where: { pageId_rowIndex: { pageId: ref.effectId, rowIndex: ref.rowIndex } },
        });
        const result = page.effect.result;
        const body = mcpObject(result);
        if (
          !body ||
          !Array.isArray(body.rows) ||
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          (result.isError !== undefined && result.isError !== false) ||
          result.error !== undefined ||
          body.error !== undefined ||
          (body.task_id !== undefined && body.task_id !== ref.providerTaskId) ||
          body.rows.length !== page.rowCount
        )
          throw new IsolationError();
        const raw = body.rows[ref.rowIndex];
        const normalized = normalizeRecruitingCandidateRow(raw, { schemaKnown: true });
        const urls = projectRecruitingCandidateReport(raw).sourceUrls;
        if (
          !occurrence ||
          occurrence.roleId !== input.roleId ||
          occurrence.candidateKey !== profile.candidateKey ||
          normalized.candidateKey !== profile.candidateKey ||
          !normalized.name?.trim() ||
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized.name) ||
          normalized.name !== occurrence.name ||
          normalized.linkedinUrl !== occurrence.linkedinUrl ||
          profile.candidateKey !==
            `linkedin:${recruitingCalibrationIdentity(profile.linkedinUrl)}` ||
          !urls.includes(profile.linkedinUrl) ||
          !urls.includes(profile.evidenceUrl)
        )
          throw new IsolationError();
        if (bytes) {
          const original = bytes.get(artifact.id);
          if (
            !original ||
            original.byteLength !== artifact.size ||
            createHash("sha256").update(original).digest("hex") !== artifact.hash ||
            stableJsonValue(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original)),
            ) !== stableJsonValue({ request: page.effect.request, providerResult: result })
          )
            throw new IsolationError();
        }
        profiles.push({
          name: normalized.name,
          linkedinUrl: urls.find((url) => url === profile.linkedinUrl)!,
          evidenceUrl: urls.find((url) => url === profile.evidenceUrl)!,
        });
        continue;
      }
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
    return {
      ...documents.package,
      sourceRefs: sources,
      documentRefs: [
        ...documents.package.documentRefs,
        ...nativeRefs.map((ref) => ref.artifactRef),
      ],
      ...(profiles.length ? { profiles } : {}),
    };
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
  input: RetainedRecruitingApprovalRequest,
  material: RecruitingRoleMaterialContext | undefined,
  replay = false,
) {
  const package_ = await prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    if (!replay) requireResearchLease(run, trusted);
    if (
      input.stage === "calibration" &&
      input.profiles.some((profile) => "assessmentVersion" in profile)
    ) {
      const retained = await tx.externalEffect.findFirst({
        where: {
          spaceId: actor.spaceId,
          runId: run.id,
          kind: "recruiting_request_approval",
          request: { equals: input as Prisma.InputJsonValue },
          status: { in: ["intended", "approved", "executing", "completed"] },
        },
      });
      if (
        !retained ||
        retained.runId !== run.id ||
        retained.spaceId !== actor.spaceId ||
        retained.kind !== "recruiting_request_approval" ||
        !["intended", "approved", "executing", "completed"].includes(retained.status) ||
        stableJsonValue(retained.request) !== stableJsonValue(input)
      )
        throw new IsolationError();
    }
    const workspace = await approvalWorkspace(tx, actor, trusted.threadId, input, !replay);
    return recruitingApprovalPackage(tx, actor, input, !replay, undefined, workspace);
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
): Promise<{
  files: MessageBlock[];
  roleTitle: string;
  profiles?: RecruitingApprovalPackage["profiles"];
  requirements?: string;
}> {
  const input = RetainedRecruitingApprovalRequestSchema.parse(untrustedInput);
  const bytes = await loadRecruitingApprovalMaterials(prisma, actor, trusted, input, material);
  return prisma.$transaction(async (tx) => {
    const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId);
    if (run.threadId !== trusted.threadId || run.botId !== trusted.botId)
      throw new IsolationError();
    requireResearchLease(run, trusted);
    const workspace = await approvalWorkspace(tx, actor, trusted.threadId, input);
    const { role } = workspace;
    const package_ = await recruitingApprovalPackage(tx, actor, input, true, bytes, workspace);
    return {
      files: package_.files,
      roleTitle: role.title,
      ...(package_.profiles ? { profiles: package_.profiles } : {}),
      ...(package_.requirements ? { requirements: package_.requirements } : {}),
    };
  });
}

export async function executeRecruitingApproval(
  prisma: PrismaClient,
  actor: Actor,
  trusted: RecruitingApprovalContext & { effectId: string; effectRequest: unknown },
  untrustedInput: unknown,
  material?: RecruitingRoleMaterialContext,
): Promise<RecruitingApprovalResult> {
  const input = RetainedRecruitingApprovalRequestSchema.parse(untrustedInput);
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
      await recruitingApprovalPackage(tx, actor, input, false, bytes, saved.workspace);
      return saved.result;
    }
    requireResearchLease(run, trusted);
    if (effect.status !== "executing") throw new IsolationError();
    const workspace = await approvalWorkspace(tx, actor, trusted.threadId, input);
    const { proof } = await approvalAnswerProof(tx, actor, effect);
    let approvedRevisionId = workspace.revision.id;
    if (input.stage === "brief") {
      const confirmed = await confirmRecruitingBriefInTransaction(
        tx,
        actor,
        {
          threadId: trusted.threadId,
          roleId: input.roleId,
          expectedRevision: input.expectedRoleRevision,
        },
        bytes,
        { runId: run.id, confirmedAt: proof.createdAt.toISOString() },
      );
      approvedRevisionId = confirmed.revision.id;
    } else await recruitingApprovalPackage(tx, actor, input, true, bytes);
    // An approved ten-profile calibration accepts the round it showed and opens the next stage,
    // so the round panel stops asking for feedback on a round the recruiter already approved.
    if (input.stage === "calibration") {
      const latest = await tx.recruitingCalibrationRound.findFirst({
        where: { roleId: input.roleId },
        orderBy: { round: "desc" },
        select: { id: true },
      });
      await tx.recruitingCalibrationRound.updateMany({
        where: { id: latest?.id ?? "", approvedAt: null },
        data: {
          approvedAt: proof.createdAt,
          approvedByUserId: actor.userId,
          approvalSource: { kind: "approval", effectId: effect.id },
        },
      });
      await advanceRecruitingPlaybookStage(tx, input.roleId, "scale");
    }
    const result: RecruitingApprovalResult = {
      status: "approved",
      stage: input.stage,
      roleId: input.roleId,
      roleRevisionId: approvedRevisionId,
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
    const request = RetainedRecruitingApprovalRequestSchema.parse(effectRequest);
    const { run } = await lockLiveRecruitingRun(tx, actor, input.runId, false);
    if (run.status !== "waiting_input" || run.threadId !== input.threadId) return false;
    const workspace = await approvalWorkspace(tx, actor, input.threadId, request);
    await recruitingApprovalPackage(tx, actor, request, true, undefined, workspace);
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
  purpose?: RecruitingResearchPurpose;
  approvalEffectId?: string;
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
  // Internal only (never from caller input): page-provenance reads skip re-validating the
  // action's request/context/receipt/output artifacts; run, thread, role, task, action, source
  // message and effect isolation checks below still run.
  skipActionArtifacts = false,
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
  const role = await requireRole(tx, actor, roleId, true, thread);
  if (action)
    action = await tx.recruitingResearchAction.findUniqueOrThrow({ where: { id: action.id } });
  if (task) task = await tx.recruitingResearchTask.findUniqueOrThrow({ where: { id: task.id } });
  if (!action && task && !input.actionId && !input.clientNonce) {
    action = task.pendingActionId
      ? await tx.recruitingResearchAction.findUnique({ where: { id: task.pendingActionId } })
      : await tx.recruitingResearchAction.findFirst({
          where: { taskId: task.id },
          orderBy: { id: "desc" },
        });
    if (!action || action.taskId !== task.id) throw new IsolationError();
  }
  if (input.expectedRoleRevision !== undefined && role.revision !== input.expectedRoleRevision)
    throw new RecruitingConflictError();
  const workspace = await roleSnapshot(tx, actor, role, thread, run);
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
  if ((taskId && !task) || (task && task.roleId !== role.id)) throw new IsolationError();
  if (task && task.createdByRunId !== run.id)
    await requireRun(tx, actor, task.createdByRunId, thread);
  const boundServerId = task?.mcpServerId;
  if (input.mcpServerId && boundServerId && input.mcpServerId !== boundServerId)
    throw new IsolationError();
  const serverId = boundServerId ?? input.mcpServerId;
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
    const origin =
      action.runId === run.id ? run : await requireRun(tx, actor, action.runId, thread);
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
    if (!skipActionArtifacts)
      for (const ref of [
        snapshot.requestArtifact,
        snapshot.contextArtifact,
        ...(snapshot.receiptArtifact ? [snapshot.receiptArtifact] : []),
        ...snapshot.outputArtifacts,
      ])
        await validateArtifact(tx, actor, ref, { run, thread });
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
      if (effect.runId !== run.id) await requireRun(tx, actor, effect.runId, thread);
    }
  }
  return {
    run,
    thread,
    workspace,
    server,
    task,
    action,
    effect,
    requestArtifact,
    source,
  };
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

/**
 * Request-local memo for repeated proof lookups while verifying several saved pages in one call.
 * Created per call and dropped with it; never shared across requests or transactions.
 */
type ProofMemo = <T>(key: string, load: () => Promise<T>) => Promise<T>;
const unmemoized: ProofMemo = (_key, load) => load();
function proofMemo(): ProofMemo {
  const loaded = new Map<string, Promise<unknown>>();
  return <T>(key: string, load: () => Promise<T>) => {
    let value = loaded.get(key);
    if (!value) {
      value = load();
      loaded.set(key, value);
    }
    return value as Promise<T>;
  };
}

async function researchReadBinding(
  tx: Tx,
  actor: Actor,
  effect: ResearchEffectRow,
  lease?: ResearchLease,
  memo: ProofMemo = unmemoized,
  pageOnly = false,
) {
  const owner = await memo(`run:${effect.runId}`, () => requireRun(tx, actor, effect.runId));
  const events = await memo(`read-events:${owner.id}:${effect.id}`, () =>
    tx.event.findMany({
      where: {
        spaceId: actor.spaceId,
        // The binding must belong to the owner run (checked below); index-scoped, not space-wide.
        runId: owner.id,
        type: "recruiting.read",
        payload: { path: ["effectId"], equals: effect.id },
      },
    }),
  );
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
  const context = {
    runId: owner.id,
    actionId: binding.actionId,
    toolName: binding.toolName,
    historical: !lease,
  };
  const saved = await memo(`context:${pageOnly}:${stableJsonValue(context)}`, () =>
    researchContextInTransaction(tx, actor, context, false, pageOnly),
  );
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
  memo: ProofMemo = unmemoized,
) {
  const clientNonce = `recruiting-observation:${read.effect.id}`;
  const artifact = await memo(`artifact:${clientNonce}`, () =>
    tx.artifact.findUnique({
      where: {
        spaceId_userId_clientNonce: { spaceId: actor.spaceId, userId: actor.userId, clientNonce },
      },
    }),
  );
  if (!artifact && !read.recorded) return null;
  if (!artifact || !read.recorded) throw new IsolationError();
  const { event, payload } = read.recorded;
  if (!event.runId) throw new IsolationError();
  const runId = event.runId;
  const owner = await memo(`run:${runId}`, () => requireRun(tx, actor, runId));
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
  await memo(`valid:${payload.outputArtifact.artifactId}:${payload.outputArtifact.sha256}`, () =>
    validateArtifact(tx, actor, payload.outputArtifact),
  );
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
  const afterRead: Array<() => void> = [];
  const result = await prisma.$transaction(
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
      await candidatePageArtifacts(tx, actor, pages, false, afterRead);
      const observations = [];
      for (const page of pages) {
        // CSV imports and people searches are unassessed lists, not provider observations.
        if (unassessedPageRequest(page.effect.request)) continue;
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
  for (const verify of afterRead) verify();
  return result;
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
  await advanceStageAfterSave(tx, task.roleId);
  await tx.recruitingCandidateOccurrence.createMany({ data: rows });
  await fillCandidateMatchFields(tx, Prisma.sql`o."pageId" = ${effect.id}`);
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

type CsvImportInput = Extract<RecruitingResearchToolInput, { operation: "import_csv" }>;

/**
 * Non-null for a CSV import or people-search save effect: an unassessed page with no provider
 * task, whose artifact proof differs from a provider observation's.
 */
function unassessedPageRequest(request: unknown): CsvImportInput | PeopleSearchInput | null {
  const parsed = RecruitingResearchToolInputSchema.safeParse(request);
  return parsed.success &&
    (parsed.data.operation === "import_csv" || parsed.data.operation === "save_search")
    ? parsed.data
    : null;
}

/** Canonical receipt bytes for one CSV import; recomputed here, never trusted from the caller. */
export function recruitingCsvImportReceipt(
  input: CsvImportInput,
  captured: {
    artifactSha256: string;
    header: readonly string[];
    /** rowIndex is the dense page row; csvRowIndex is the 0-based CSV data row (header excluded). */
    rows: ReadonlyArray<{ rowIndex: number; csvRowIndex: number; row: Record<string, string> }>;
    skipped: ReadonlyArray<{ csvRowIndex: number; reason: string }>;
    truncated: boolean;
  },
) {
  return {
    version: 1,
    kind: "csv_import",
    request: input,
    source: { artifactId: input.artifactId, artifactSha256: captured.artifactSha256 },
    header: captured.header,
    rows: captured.rows,
    skipped: captured.skipped,
    truncated: captured.truncated,
  };
}

/**
 * Save a recruiter-supplied CSV as one candidate page on the current role. Rows go through the
 * same identity normalization as provider pages; nothing is scored or rejected.
 */
export async function saveRecruitingCandidateCsvImport(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { effectId: string; effectRequest: unknown },
  raw: CsvImportInput,
  captured: Parameters<typeof recruitingCsvImportReceipt>[1] & {
    outputArtifact: RecruitingResearchArtifactInput;
  },
) {
  const input = RecruitingResearchToolInputSchema.parse(raw);
  if (
    input.operation !== "import_csv" ||
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
    if (thread.activeRecruitingRoleId !== input.roleId) throw new IsolationError();
    const role = await requireRole(tx, actor, input.roleId, true, thread);
    if (!role.currentRevisionId || role.revision !== input.expectedRoleRevision)
      throw new RecruitingConflictError();
    // Same owner check as artifact_read; the adapter verified the stored bytes against this hash.
    const csv = await tx.artifact.findFirst({
      where: { id: input.artifactId, spaceId: actor.spaceId, userId: actor.userId },
    });
    if (!csv || csv.hash !== captured.artifactSha256) throw new IsolationError();
    const bytes = Buffer.from(stableJsonValue(recruitingCsvImportReceipt(input, captured)));
    const file = captured.outputArtifact;
    if (
      file.hash !== createHash("sha256").update(bytes).digest("hex") ||
      file.size !== bytes.length ||
      file.clientNonce !== `recruiting-csv-import:${saving.id}`
    )
      throw new IsolationError();
    return saveUnassessedCandidatePage(
      tx,
      actor,
      { run, thread, role, saving, trusted, file },
      {
        rows: captured.rows,
        describe: ({ artifact, observedAt, candidateRows }) => ({
          source: {
            kind: "csv_import",
            artifactId: csv.id,
            artifactSha256: csv.hash,
            importedBy: { userId: actor.userId, runId: run.id },
            observedAt: observedAt.toISOString(),
          },
          outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
          candidateRows: candidateRows.map((row) => ({
            ...row,
            csvRowIndex: captured.rows[row.rowIndex]!.csvRowIndex,
          })),
          skipped: captured.skipped,
          truncated: captured.truncated,
        }),
      },
    );
  });
}

type PeopleSearchInput = Extract<RecruitingResearchToolInput, { operation: "save_search" }>;

/** Canonical receipt bytes for one people-search save; recomputed here, never trusted from the caller. */
export function recruitingPeopleSearchReceipt(
  input: PeopleSearchInput,
  captured: {
    /** Completed connector calls of this run the rows were read from. */
    sources: ReadonlyArray<{ effectId: string; toolName: string; host: string }>;
    rows: ReadonlyArray<{ rowIndex: number; sourceEffectId: string; row: Record<string, string> }>;
    truncated: boolean;
  },
) {
  return {
    version: 1,
    kind: "people_search",
    request: input,
    sources: captured.sources,
    rows: captured.rows,
    truncated: captured.truncated,
  };
}

/**
 * Save the people a people-search connector returned earlier in this run as one unassessed
 * candidate page on the thread's role. Every source must be a completed call of this run.
 */
export async function saveRecruitingCandidatePeopleSearch(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { effectId: string; effectRequest: unknown },
  raw: PeopleSearchInput,
  captured: Parameters<typeof recruitingPeopleSearchReceipt>[1] & {
    outputArtifact: RecruitingResearchArtifactInput;
  },
) {
  const input = RecruitingResearchToolInputSchema.parse(raw);
  if (
    input.operation !== "save_search" ||
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
    if (saving.status !== "executing" || !thread.activeRecruitingRoleId) throw new IsolationError();
    const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, true, thread);
    if (!role.currentRevisionId || role.revision !== input.expectedRoleRevision)
      throw new RecruitingConflictError();
    const sourceIds = [...new Set(captured.sources.map((source) => source.effectId))];
    const completedSources = await tx.externalEffect.count({
      where: { id: { in: sourceIds }, spaceId: actor.spaceId, runId: run.id, status: "completed" },
    });
    if (
      !sourceIds.length ||
      completedSources !== sourceIds.length ||
      captured.rows.some((row) => !sourceIds.includes(row.sourceEffectId))
    )
      throw new IsolationError();
    const bytes = Buffer.from(stableJsonValue(recruitingPeopleSearchReceipt(input, captured)));
    const file = captured.outputArtifact;
    if (
      file.hash !== createHash("sha256").update(bytes).digest("hex") ||
      file.size !== bytes.length ||
      file.clientNonce !== `recruiting-people-search:${saving.id}`
    )
      throw new IsolationError();
    return saveUnassessedCandidatePage(
      tx,
      actor,
      { run, thread, role, saving, trusted, file },
      {
        rows: captured.rows,
        describe: ({ artifact, observedAt, candidateRows }) => ({
          source: {
            kind: "people_search",
            searchedBy: { userId: actor.userId, runId: run.id },
            observedAt: observedAt.toISOString(),
          },
          /** People never returned before for this role; only they may fill a later round. */
          newPeople: candidateRows.filter((row) => !row.alreadyInPool).length,
          outputArtifact: { artifactId: artifact.id, sha256: artifact.hash },
          candidateRows: candidateRows.map((row) => {
            const saved = captured.rows[row.rowIndex]!.row;
            return {
              ...row,
              name: saved.name ?? null,
              title: saved.current_title ?? null,
              company: saved.current_company ?? null,
              location: saved.location ?? null,
              snippet: saved.snippet ?? null,
            };
          }),
          truncated: captured.truncated,
        }),
      },
    );
  });
}

type UnassessedPageContext = {
  run: { id: string; botId: string; threadId: string };
  thread: { groupId: string | null };
  role: { id: string; currentRevisionId: string | null };
  saving: { id: string };
  trusted: ResearchLease;
  file: RecruitingResearchArtifactInput;
};

/**
 * Store one unassessed candidate page (CSV import or people search) and complete its effect in
 * the caller's transaction. Rows go through the same identity normalization as provider pages;
 * nothing is scored or rejected.
 */
async function saveUnassessedCandidatePage(
  tx: Tx,
  actor: Actor,
  { run, thread, role, saving, trusted, file }: UnassessedPageContext,
  input: {
    rows: ReadonlyArray<{ rowIndex: number; row: Record<string, string> }>;
    describe: (saved: {
      artifact: { id: string; hash: string };
      observedAt: Date;
      candidateRows: Array<{ rowIndex: number; candidateKey: string; alreadyInPool: boolean }>;
    }) => Record<string, unknown>;
  },
) {
  if (!role.currentRevisionId) throw new RecruitingConflictError();
  const artifact = await createResearchArtifact(tx, actor, run, thread, file);
  if (input.rows.some((row, index) => row.rowIndex !== index)) throw new IsolationError();
  const rows = input.rows.map(({ rowIndex, row }) => {
    // Unmapped or blank columns stay absent (missing_field), so they never mask older values.
    const { candidateKey, ...profile } = normalizeRecruitingCandidateRow(row, {
      schemaKnown: true,
    });
    return {
      pageId: saving.id,
      rowIndex,
      roleId: role.id,
      candidateKey: candidateKey ?? `source-row:${saving.id}:${rowIndex}`,
      ...profile,
      evidenceUrls: Prisma.DbNull,
      issues: [...profile.issues],
    };
  });
  const observedAt = new Date();
  await tx.recruitingCandidatePage.create({
    data: {
      effectId: saving.id,
      roleId: role.id,
      taskId: null,
      actionId: null,
      roleRevisionId: role.currentRevisionId,
      artifactId: artifact.id,
      artifactHash: artifact.hash,
      requestCursor: null,
      outputId: null,
      observedAt,
      rowCount: rows.length,
    },
  });
  const keys = [...new Set(rows.map((row) => row.candidateKey))];
  // One statement both adds new people and tells them apart: a key it did not insert was
  // already in the role's pool.
  const added = new Set(
    rows.length
      ? (
          await tx.recruitingCandidate.createManyAndReturn({
            data: keys.map((candidateKey) => ({ roleId: role.id, candidateKey })),
            skipDuplicates: true,
            select: { candidateKey: true },
          })
        ).map((candidate) => candidate.candidateKey)
      : [],
  );
  if (rows.length) {
    await tx.recruitingCandidateOccurrence.createMany({ data: rows });
    await fillCandidateMatchFields(tx, Prisma.sql`o."pageId" = ${saving.id}`);
    await advanceStageAfterSave(tx, role.id);
  }
  const result = {
    status: "saved",
    roleId: role.id,
    roleRevisionId: role.currentRevisionId,
    sourceEffectId: saving.id,
    ...input.describe({
      artifact,
      observedAt,
      candidateRows: rows.map(({ rowIndex, candidateKey }) => ({
        rowIndex,
        candidateKey,
        alreadyInPool: !added.has(candidateKey),
      })),
    }),
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
}

/** One provenance check for both historical action pages and native candidate saves. */
/**
 * Loads the per-page proof rows of research-action pages in three `IN` queries and seeds a
 * call-local memo with exactly the rows the per-page lookups would have read; every per-page
 * check in candidatePageArtifact still runs unchanged against them.
 */
async function researchPageProofs(
  tx: Tx,
  actor: Actor,
  pages: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>[],
): Promise<ProofMemo> {
  const memo = proofMemo();
  if (pages.length < 2) return memo;
  const ids = pages.map((page) => page.effectId);
  const effects = await tx.externalEffect.findMany({
    where: { id: { in: ids }, spaceId: actor.spaceId, status: "completed" },
  });
  const runIds = [...new Set(effects.map((effect) => effect.runId))];
  const nonces = ids.map((id) => `recruiting-observation:${id}`);
  const [events, artifacts] = await Promise.all([
    tx.event.findMany({
      where: {
        spaceId: actor.spaceId,
        runId: { in: runIds },
        type: "recruiting.read",
        OR: ids.map((id) => ({ payload: { path: ["effectId"], equals: id } })),
      },
    }),
    tx.artifact.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce: { in: nonces } },
    }),
  ]);
  for (const id of ids) {
    const effect = effects.find((row) => row.id === id) ?? null;
    void memo(`effect:${id}`, async () => effect);
    if (effect)
      void memo(`read-events:${effect.runId}:${id}`, async () =>
        events.filter(
          (event) =>
            event.runId === effect.runId &&
            (event.payload as { effectId?: unknown } | null)?.effectId === id,
        ),
      );
  }
  for (const nonce of nonces)
    void memo(
      `artifact:${nonce}`,
      async () => artifacts.find((artifact) => artifact.clientNonce === nonce) ?? null,
    );
  return memo;
}

async function candidatePageArtifact(
  tx: Tx,
  actor: Actor,
  page: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>,
  canonical = false,
  memo: ProofMemo = unmemoized,
  pageOnly = false,
) {
  if (page.taskId === null && page.actionId === null) {
    const artifacts = await candidatePageArtifacts(tx, actor, [page], canonical);
    return artifacts.get(page.effectId)!;
  }
  const effect = await memo(`effect:${page.effectId}`, () =>
    tx.externalEffect.findFirst({
      where: {
        id: page.effectId,
        spaceId: actor.spaceId,
        status: "completed",
      },
    }),
  );
  if (effect?.status !== "completed") throw new IsolationError();
  const read = await researchReadBinding(tx, actor, effect, undefined, memo, pageOnly);
  if (
    read?.toolName !== "get_rows" ||
    read.binding.taskId !== page.taskId ||
    read.binding.actionId !== page.actionId ||
    read.saved.task?.roleId !== page.roleId ||
    read.saved.action?.roleRevisionId !== page.roleRevisionId ||
    (canonical && read.saved.action.candidateOutputSchema !== RECRUITING_CANDIDATE_OUTPUT_SCHEMA)
  )
    throw new IsolationError();
  const artifact = await recordedResearchReadArtifact(tx, actor, read, memo);
  if (!artifact || artifact.id !== page.artifactId || artifact.hash !== page.artifactHash)
    throw new IsolationError();
  return artifact;
}

async function candidatePageArtifacts(
  tx: Tx,
  actor: Actor,
  pages: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>[],
  canonical = false,
  afterRead?: Array<() => void>,
  pageOnly = false,
): Promise<Map<string, Prisma.ArtifactGetPayload<Record<string, never>>>> {
  const nativeIds = pages
    .filter((page) => page.taskId === null && page.actionId === null)
    .map((page) => page.effectId);
  type Owner = Pick<Actor, "spaceId" | "userId">;
  type ProofRow = Prisma.ArtifactGetPayload<Record<string, never>> & {
    effectId: string;
    effectStatus: string;
    effectRequest: Prisma.JsonValue;
    effectResult: string | null;
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
  // Read large provider JSON as text, then parse once instead of Prisma's raw JSON conversion.
  const proofs = nativeIds.length
    ? await tx.$queryRaw<ProofRow[]>(Prisma.sql`
        SELECT e."id" AS "effectId", e."status" AS "effectStatus",
          e."request" AS "effectRequest", e."result"::text AS "effectResult",
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
      effectResult: resultJson,
      effectRun: run,
      ...artifact
    }) => ({
      id,
      status,
      request,
      resultJson,
      run,
      recruitingCandidatePage: artifact.id ? { artifact } : null,
    }),
  );
  const byEffect = new Map(effects.map((effect) => [effect.id, effect]));
  // Proof events carry the effect's run (checked below); scoping by runId hits the
  // (runId, type, seq) index instead of JSON-scanning every event in the space while the
  // read transaction holds one of the few pooled connections.
  const runIds = [...new Set(effects.flatMap((effect) => (effect.run?.id ? [effect.run.id] : [])))];
  const events = runIds.length
    ? await tx.event.findMany({
        where: {
          spaceId: actor.spaceId,
          runId: { in: runIds },
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
  const memo = await researchPageProofs(
    tx,
    actor,
    pages.filter((page) => page.taskId !== null || page.actionId !== null),
  );
  for (const page of pages) {
    if (page.taskId !== null || page.actionId !== null) {
      artifacts.set(
        page.effectId,
        await candidatePageArtifact(tx, actor, page, canonical, memo, pageOnly),
      );
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
    const imported = unassessedPageRequest(effect.request);
    if (imported) {
      // ponytail: metadata proof only; the receipt bytes stay in ArtifactStore (adapter-verified
      // at import). Re-read them here only if a reader needs the raw CSV rows.
      const artifact = effect.recruitingCandidatePage?.artifact;
      const result = effect.resultJson === null ? null : JSON.parse(effect.resultJson);
      if (
        !artifact ||
        artifact.id !== page.artifactId ||
        artifact.spaceId !== actor.spaceId ||
        artifact.userId !== actor.userId ||
        artifact.runId !== run.id ||
        artifact.botId !== run.botId ||
        artifact.clientNonce !==
          (imported.operation === "import_csv"
            ? `recruiting-csv-import:${effect.id}`
            : `recruiting-people-search:${effect.id}`) ||
        artifact.hash !== page.artifactHash ||
        (imported.operation === "import_csv" ? imported.roleId : result?.roleId) !== page.roleId ||
        result?.roleRevisionId !== page.roleRevisionId ||
        result?.outputArtifact?.artifactId !== artifact.id ||
        result?.outputArtifact?.sha256 !== artifact.hash
      )
        throw new IsolationError();
      artifacts.set(page.effectId, artifact);
      continue;
    }
    const call = researchReadRequest(effect.request, undefined, "get_rows");
    const saved = byEvent.get(effect.id) ?? [];
    if (saved.length !== 1) throw new IsolationError();
    const event = saved[0]!;
    const payload = ProductEventSchema.parse({
      ...event,
      createdAt: event.createdAt.toISOString(),
    }).payload;
    const artifact = effect.recruitingCandidatePage?.artifact;
    if (
      !artifact ||
      artifact.id !== page.artifactId ||
      artifact.spaceId !== actor.spaceId ||
      artifact.userId !== actor.userId ||
      artifact.runId !== run.id ||
      artifact.botId !== run.botId ||
      artifact.clientNonce !== `recruiting-observation:${effect.id}` ||
      artifact.hash !== page.artifactHash ||
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
    const verifyBytes = () => {
      const bytes = Buffer.from(
        stableJsonValue({
          request: effect.request,
          providerResult: effect.resultJson === null ? null : JSON.parse(effect.resultJson),
        }),
      );
      if (
        artifact.size !== bytes.length ||
        artifact.hash !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new IsolationError();
    };
    // Read-only callers verify captured bytes before return without holding the database snapshot.
    // Mutating callers omit afterRead and keep this check inside their atomic transaction.
    if (afterRead) afterRead.push(verifyBytes);
    else verifyBytes();
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

// The saved provider envelope of `effect`: structuredContent, else the first JSON text block.
const savedProviderBody = Prisma.sql`COALESCE(effect."result"->'structuredContent', (
  SELECT CASE WHEN block->>'text' IS JSON OBJECT THEN (block->>'text')::jsonb END
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(effect."result"->'content') = 'array'
    THEN effect."result"->'content' ELSE '[]'::jsonb END) block
  WHERE block->>'type' = 'text' AND block->>'text' IS JSON OBJECT LIMIT 1
))`;
// Occurrence `o`'s own saved row inside `body`; {} when the row is absent or not an object.
const savedProviderRow = (body: Prisma.Sql) =>
  Prisma.sql`CASE WHEN jsonb_typeof(${body}->'rows'->o."rowIndex") = 'object'
    THEN ${body}->'rows'->o."rowIndex" ELSE '{}'::jsonb END`;
const candidateMatchKeys = [
  "updated_rank",
  "overall_rank",
  "rank",
  "batch_rank",
  "rank_this_batch_only",
  "match_tier",
  "match_score",
  "score",
];
/**
 * Copies each saved provider row's match cells onto its occurrence, once. Rows without such
 * cells get {} so NULL always means "not filled yet". Idempotent; `scope` filters alias `o`.
 */
async function fillCandidateMatchFields(db: Pick<Tx, "$executeRaw">, scope: Prisma.Sql) {
  await db.$executeRaw(Prisma.sql`WITH bodies AS MATERIALIZED (
    SELECT page."effectId", ${savedProviderBody} AS body
    FROM "recruiting_candidate_pages" page
    JOIN "external_effects" effect ON effect."id" = page."effectId"
    WHERE page."effectId" IN (
      SELECT o."pageId" FROM "recruiting_candidate_occurrences" o
      WHERE ${scope} AND o."matchFields" IS NULL
    )
  ), filled AS (
    SELECT o."pageId", o."rowIndex", COALESCE((
      SELECT jsonb_object_agg(cell.key, cell.value)
      FROM jsonb_each(${savedProviderRow(Prisma.sql`b.body`)}) cell
      WHERE cell.key IN (${Prisma.join(candidateMatchKeys)})
    ), '{}'::jsonb) AS "matchFields"
    FROM "recruiting_candidate_occurrences" o JOIN bodies b ON b."effectId" = o."pageId"
    WHERE ${scope} AND o."matchFields" IS NULL
  )
  UPDATE "recruiting_candidate_occurrences" o SET "matchFields" = filled."matchFields"
  FROM filled
  WHERE o."pageId" = filled."pageId" AND o."rowIndex" = filled."rowIndex" AND o."matchFields" IS NULL`);
}

/**
 * One stored score cell (match_score, else score; a {value} object is unwrapped) as numeric.
 * "plain" is a bare number or numeric string on the result's own scale; "fraction" is an
 * explicit "8/10" or "72%" already converted to 0–100. Anything else is NULL.
 */
function scoreCellPart(fields: Prisma.Sql, part: "plain" | "fraction") {
  const cell = Prisma.sql`(CASE WHEN jsonb_typeof(cell.c) = 'object' AND cell.c ? 'value'
    THEN cell.c->'value' ELSE cell.c END)`;
  const text = Prisma.sql`(${cell} #>> '{}')`;
  const num = "[[:space:]]*-?[0-9]{1,30}([.][0-9]{1,30})?[[:space:]]*";
  const value =
    part === "plain"
      ? Prisma.sql`CASE WHEN jsonb_typeof(${cell}) = 'number' OR (jsonb_typeof(${cell}) = 'string'
          AND ${text} ~ ${`^${num}$`}) THEN trim(${text})::numeric END`
      : Prisma.sql`CASE WHEN jsonb_typeof(${cell}) <> 'string' THEN NULL
          WHEN ${text} ~ ${`^${num}/${num}$`} THEN CASE
            WHEN trim(split_part(${text}, '/', 2))::numeric > 0
            THEN 100 * trim(split_part(${text}, '/', 1))::numeric
              / trim(split_part(${text}, '/', 2))::numeric END
          WHEN ${text} ~ ${`^${num}%[[:space:]]*$`} THEN trim(replace(${text}, '%', ''))::numeric END`;
  return Prisma.sql`(SELECT ${value} FROM (SELECT CASE WHEN ${fields} ? 'match_score'
    THEN ${fields}->'match_score' ELSE ${fields}->'score' END AS c) cell)`;
}

/** Latest source projection is selected by native read completion, never by backfill arrival. */
function candidateIndexQuery(
  roleId: string,
  sort?: CandidatesInput["sort"],
  rankDomainPageId?: string,
  displayScope?: Pick<CandidatesInput, "sourceEffectId" | "actionId">,
) {
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
  // Providers send numbers either as JSON numbers or as plain numeric strings ("45"); both are
  // the same provider value. Anything else ("Unknown", "45/100") stays NULL.
  const numericCell = Prisma.sql`CASE WHEN jsonb_typeof(match."value") = 'number' OR
      (jsonb_typeof(match."value") = 'string' AND
        match."value" #>> '{}' ~ '^-?[0-9]{1,30}([.][0-9]{1,30})?$')
      THEN (match."value" #>> '{}')::numeric END`;
  const matchValue = Prisma.sql`CASE WHEN source.kind = 'rank' THEN
      CASE WHEN ${numericCell} BETWEEN 1 AND 9007199254740991
        AND trunc(${numericCell}) = ${numericCell}
        THEN (${numericCell})::bigint END
      WHEN source.kind = 'score' THEN (SELECT round(LEAST(100, GREATEST(0, s.v))) FROM (SELECT COALESCE(
        ${scoreCellPart(Prisma.sql`returned.value`, "fraction")},
        ${scoreCellPart(Prisma.sql`returned.value`, "plain")} * rank_scope."scoreScale") AS v) s
        WHERE s.v IS NOT NULL)
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
      ? Prisma.sql`rank_page AS MATERIALIZED (
    SELECT ${
      displayScope?.sourceEffectId === undefined
        ? Prisma.sql`COALESCE((
        -- Scores compare within the newest saved result that carries them, so a later result
        -- without scores (a re-check, a contact lookup) does not hide the role's scores.
        SELECT page."effectId" FROM "recruiting_candidate_pages" page
        WHERE page."roleId" = ${roleId} ${sourceScope} AND EXISTS (
          SELECT 1 FROM "recruiting_candidate_occurrences" scored
          WHERE scored."pageId" = page."effectId"
            AND (scored."matchFields" ? 'match_score' OR scored."matchFields" ? 'score'))
        ORDER BY page."observedAt" DESC, page."effectId" DESC LIMIT 1), `
        : Prisma.empty
    }${
      rankDomainPageId === undefined
        ? Prisma.sql`(SELECT CASE WHEN count(*) = 1 THEN min("effectId") END FROM (
          SELECT "effectId" FROM "recruiting_candidate_pages" page WHERE "roleId" = ${roleId} ${sourceScope} LIMIT 2
        ) rank_pages)`
        : Prisma.sql`${rankDomainPageId}::text`
    }${displayScope?.sourceEffectId === undefined ? Prisma.sql`)` : Prisma.empty} AS "pageId"
  ), rank_scope AS MATERIALIZED (
    -- Scores are shown on 0–100. A saved result whose plain scores all fit 0–10 (or 0–1 with a
    -- fraction) was answered on that scale; this converts units only and never rescores.
    SELECT rank_page."pageId", COALESCE((
      SELECT CASE WHEN max(plain.v) <= 1 AND bool_or(plain.v <> trunc(plain.v)) THEN 100
        WHEN max(plain.v) <= 10 THEN 10 ELSE 1 END
      FROM "recruiting_candidate_occurrences" scored
      CROSS JOIN LATERAL (SELECT ${scoreCellPart(Prisma.sql`scored."matchFields"`, "plain")} AS v) plain
      WHERE scored."pageId" = rank_page."pageId" AND plain.v IS NOT NULL
    ), 1) AS "scoreScale"
    FROM rank_page
  ),`
      : Prisma.empty
  } base AS (
    SELECT c."roleId", c."candidateKey", c."shortlisted",
      to_char(c."shortlistedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "shortlistedAt",
      c."revision", c."consideration",
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
      FROM (
        -- Reads the match cells stored on each occurrence; saved page JSON is never parsed here.
        SELECT o."pageId", page."observedAt", o."rowIndex", source.kind, ${matchValue} AS value
        FROM "recruiting_candidate_occurrences" o
        JOIN "recruiting_candidate_pages" page ON page."effectId" = o."pageId"
        -- Legacy NULL rows are backfilled before the read (listRecruitingCandidates); parsing the
        -- saved page per row here cost ~20 s on a 134-candidate role and expired the transaction.
        CROSS JOIN LATERAL (SELECT COALESCE(o."matchFields", '{}'::jsonb) AS value) returned
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
        WHERE o."roleId" = c."roleId" AND o."candidateKey" = c."candidateKey"
          ${sourceScope}
          AND source.present
      ) m
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
  consideration: Prisma.JsonValue | null;
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
  shortlistedAt: string | null;
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
  afterRead?: Array<() => void>,
  pageOnly = false,
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
  await candidatePageArtifacts(tx, actor, [...pages.values()], false, afterRead, pageOnly);
  return pages;
}

async function crmReadTarget(
  tx: Tx,
  actor: Actor,
  run: { id: string; threadId: string; botId: string },
  effectId: string,
) {
  const effect = await tx.externalEffect.findFirst({
    where: { id: effectId, spaceId: actor.spaceId, status: "completed" },
  });
  if (!effect) throw new IsolationError();
  const owner = effect.runId === run.id ? run : await requireRun(tx, actor, effect.runId);
  const target = extractRecruitingCrmTarget(effect);
  if (!target || owner.threadId !== run.threadId || owner.botId !== run.botId)
    throw new IsolationError();
  return target;
}

async function internalCrmEffectRun(
  tx: Tx,
  actor: Actor,
  effect: { id: string; runId: string; status: string; request: unknown },
  authorizedRun?: Awaited<ReturnType<typeof requireRun>>,
) {
  const run =
    authorizedRun?.id === effect.runId ? authorizedRun : await requireRun(tx, actor, effect.runId);
  const card = await tx.message.findFirst({
    where: {
      runId: run.id,
      role: "bot",
      blocks: { array_contains: [{ approvalEffectId: effect.id }] },
    },
    select: { id: true },
  });
  const answer = await tx.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "effect.approval.answered",
      payload: { path: ["effectId"], equals: effect.id },
    },
  });
  // Internal record keeping is autonomous; an existing card still owns its exact decision.
  const requiresHumanApproval = effect.status === "approved" || Boolean(card || answer);
  if (requiresHumanApproval) await approvalAnswerProof(tx, actor, effect, run);
  return { run, requiresHumanApproval };
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
  const { run } = await internalCrmEffectRun(tx, actor, effect);
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
    const attached = await attachedCrmTarget(tx, actor, role.id, thread.id);
    const bound = role.crmBindingEffectId
      ? await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId)
      : null;
    return {
      roleId: role.id,
      bindingEffectId: bound?.bindingEffectId ?? null,
      target: attached ?? bound?.target ?? null,
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
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([actor.userId, actor.spaceId, target.mcpServerId, target.organizationId, target.crmRoleId])}, 3))`;
  const attachments = await tx.recruitingCrmWorkspaceAttachment.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      OR: [
        { roleId: role.id },
        {
          mcpServerId: target.mcpServerId,
          organizationId: target.organizationId,
          crmRoleId: target.crmRoleId,
        },
      ],
    },
  });
  if (
    attachments.some(
      (row) =>
        row.roleId !== role.id ||
        row.mcpServerId !== target.mcpServerId ||
        row.organizationId !== target.organizationId ||
        row.crmRoleId !== target.crmRoleId,
    )
  )
    throw new RecruitingConflictError();
  const duplicate = await tx.recruitingRole.findFirst({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      id: { not: role.id },
      crmBindingEffect: {
        status: "completed",
        kind: "recruiting_crm_target",
        AND: [
          { result: { path: ["target", "mcpServerId"], equals: target.mcpServerId } },
          { result: { path: ["target", "organizationId"], equals: target.organizationId } },
          { result: { path: ["target", "crmRoleId"], equals: target.crmRoleId } },
        ],
      },
    },
  });
  if (duplicate) throw new RecruitingConflictError();
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
    await internalCrmEffectRun(tx, actor, effect, run);
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

async function crmImportSource(
  tx: Tx,
  actor: Actor,
  input: RecruitingCrmImportInput,
  verifiedPages?: ReadonlyMap<
    string,
    Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>
  >,
  source?: Prisma.RecruitingCandidateOccurrenceGetPayload<{ include: { page: true } }>,
) {
  const occurrence =
    source ??
    (await tx.recruitingCandidateOccurrence.findUnique({
      where: { pageId_rowIndex: { pageId: input.sourceEffectId, rowIndex: input.rowIndex } },
      include: { page: true },
    }));
  if (
    !occurrence ||
    occurrence.pageId !== input.sourceEffectId ||
    occurrence.rowIndex !== input.rowIndex ||
    occurrence.roleId !== input.roleId ||
    occurrence.candidateKey !== input.candidateKey
  )
    throw new IsolationError();
  const { page } = occurrence;
  const verified = verifiedPages?.get(page.effectId);
  if (
    !verified ||
    page.taskId !== null ||
    page.actionId !== null ||
    verified.taskId !== null ||
    verified.actionId !== null ||
    verified.effectId !== page.effectId ||
    verified.roleId !== input.roleId ||
    verified.roleId !== page.roleId ||
    verified.roleRevisionId !== page.roleRevisionId ||
    verified.artifactId !== page.artifactId ||
    verified.artifactHash !== page.artifactHash ||
    verified.rowCount !== page.rowCount ||
    verified.requestCursor !== page.requestCursor
  )
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
  const role = await requireRole(tx, actor, input.roleId, true, thread);
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
    if (effect.runId !== run.id) await requireRun(tx, actor, effect.runId, thread);
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
    const owner =
      effect.runId === resolved.run.id
        ? resolved.run
        : await tx.run.findUniqueOrThrow({
            where: { id: effect.runId },
            select: { status: true, leaseExpiresAt: true },
          });
    const live =
      ["queued", "leased", "waiting_input"].includes(owner.status) ||
      (owner.status === "running" &&
        owner.leaseExpiresAt &&
        owner.leaseExpiresAt.getTime() > Date.now());
    if (effect.runId !== trusted.runId && live) return { status: "busy" as const, effect };
    if (effect.status === "executing") return { status: "unknown" as const, effect };
    if (
      effect.runId !== trusted.runId &&
      effect.status === "intended" &&
      ["failed", "completed"].includes(owner.status)
    ) {
      requireResearchLease(resolved.run, trusted);
      const thread = await requireThread(tx, actor, resolved.run.threadId);
      const role = await requireRole(tx, actor, input.roleId, false, thread);
      if (
        thread.activeRecruitingRoleId !== role.id ||
        role.crmBindingEffectId !== input.bindingEffectId
      )
        throw new RecruitingConflictError();
      await currentCrmServer(tx, actor, resolved.run, resolved.target);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "external_effects" WHERE "id" = ${effect.id} FOR UPDATE`,
      );
      const pending = await tx.externalEffect.findFirst({
        where: { id: effect.id, spaceId: actor.spaceId, runId: effect.runId, status: "intended" },
      });
      if (!pending) return { status: "busy" as const, effect };
      if (
        pending.kind !== native.effectKind ||
        pending.idempotencyKey !== crmImportKey(input) ||
        stableJsonValue(pending.request) !== stableJsonValue(native.effectRequest)
      )
        throw new IsolationError();
      assertCrmImportRequest(pending.request, resolved.route, resolved.args);
      const history = await internalCrmEffectRun(tx, actor, pending);
      if (
        history.run.threadId !== resolved.run.threadId ||
        history.run.botId !== resolved.run.botId
      )
        throw new IsolationError();
      if (history.requiresHumanApproval) return { status: "stopped" as const, effect };
      const transferred = await tx.externalEffect.updateMany({
        where: {
          id: pending.id,
          spaceId: actor.spaceId,
          runId: history.run.id,
          status: "intended",
          kind: native.effectKind,
          request: { equals: pending.request as Prisma.InputJsonValue },
          run: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            threadId: resolved.run.threadId,
            botId: resolved.run.botId,
            status: { in: ["failed", "completed"] },
          },
        },
        data: { runId: resolved.run.id },
      });
      if (transferred.count !== 1) return { status: "busy" as const, effect };
      effect = { ...pending, runId: resolved.run.id };
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: resolved.run.threadId,
        botId: resolved.run.botId,
        runId: resolved.run.id,
        type: "effect.reconciled",
        payload: { effectId: effect.id, previousRunId: history.run.id, kind: effect.kind },
      });
      return { status: "ready" as const, effect };
    }
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
    await internalCrmEffectRun(tx, actor, effect, resolved.run);
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

type NativeReplyTarget = Pick<
  RecruitingReplyTarget,
  "mcpServerId" | "serverRevision" | "replyToEmailId"
> & { recipient: string };
type ReplyTarget = RecruitingReplyTarget | NativeReplyTarget;
type NativeReplyScope = {
  roleId: string;
  roleRevisionId: string;
  expectedRoleRevision: number;
  bindingEffectId: string;
  candidateId: string;
  emailReadEffectId: string;
  crmContextReadEffectId: string;
  membershipReadEffectId: string;
};

// Server-owned evidence lives beside the native envelope, never in provider arguments.
function replyScope(request: unknown): NativeReplyScope | undefined {
  if (!Array.isArray(request)) return;
  const payload = request[request.length === 4 ? 3 : 2];
  return payload && typeof payload === "object" ? payload.recruitingReply : undefined;
}
function replyEnvelope(request: unknown, scope?: NativeReplyScope) {
  if (!Array.isArray(request)) throw new IsolationError();
  const index = request.length === 4 ? 3 : 2;
  const payload = request[index];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new IsolationError();
  const { recruitingReply: _scope, ...native } = payload;
  const result = [...request];
  result[index] = scope ? { ...native, recruitingReply: scope } : native;
  return result;
}

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
  assertCrmImportRequest(replyEnvelope(request), route, args as Record<string, unknown>);
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

/** Capture authorized immutable native reply evidence; parsing runs after the read transaction. */
export async function readRecruitingNativeCorrespondence(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    threadId: string;
    roleId?: string;
    target?: Pick<
      RecruitingCrmTarget,
      "mcpServerId" | "serverRevision" | "organizationId" | "crmRoleId"
    >;
  },
) {
  const captured = await prisma.$transaction(
    async (tx) => {
      const thread = await requireThread(tx, actor, input.threadId);
      if (!thread.activeRecruitingRoleId) return null;
      if (input.roleId && input.roleId !== thread.activeRecruitingRoleId)
        throw new IsolationError();
      const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, false, thread);
      if (!role.crmBindingEffectId) return null;
      const binding = await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId);
      if (
        input.target &&
        Object.entries(input.target).some(
          ([key, value]) => binding.target[key as keyof RecruitingCrmTarget] !== value,
        )
      )
        return null;
      const where = {
        spaceId: actor.spaceId,
        run: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          threadId: thread.id,
          bot: { userId: actor.userId, spaceId: actor.spaceId },
        },
      };
      const include = {
        run: {
          select: {
            id: true,
            botId: true,
            userId: true,
            spaceId: true,
            threadId: true,
            sourceMessageId: true,
          },
        },
      } as const;
      // ponytail: retain 200 scoped operations; native fresh reads provide newer coverage without replay.
      const effects = await tx.externalEffect.findMany({
        where: {
          ...where,
          OR: [
            { request: { path: ["2", "recruitingReply", "roleId"], equals: role.id } },
            { request: { path: ["3", "recruitingReply", "roleId"], equals: role.id } },
          ],
        },
        include,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 201,
      });
      const scopedEffects = effects.slice(0, 200).filter((effect) => replyScope(effect.request));
      if (!scopedEffects.length) return null;
      const proofIds = [
        ...new Set(
          scopedEffects.flatMap((effect) => {
            const saved = replyScope(effect.request)!;
            return [
              saved.emailReadEffectId,
              saved.crmContextReadEffectId,
              saved.membershipReadEffectId,
            ];
          }),
        ),
      ];
      const records = await tx.externalEffect.findMany({
        where: { ...where, id: { in: proofIds } },
        include,
      });
      const revisions = await tx.recruitingRoleRevision.findMany({
        where: {
          id: {
            in: [
              ...new Set(scopedEffects.map((effect) => replyScope(effect.request)!.roleRevisionId)),
            ],
          },
          roleId: role.id,
        },
        select: { id: true, roleId: true, revision: true },
      });
      const serverIds = [
        ...new Set([
          binding.target.mcpServerId,
          ...scopedEffects.flatMap((effect) => {
            const route =
              boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool")?.route ??
              catalogApprovalDetails(effect.request, "__rakazoCatalogTool")?.route;
            return route?.connectorId === "mcp" && typeof route.resourceId === "string"
              ? [route.resourceId]
              : [];
          }),
        ]),
      ];
      const observations = await tx.externalEffect.findMany({
        where: {
          ...where,
          OR: serverIds.flatMap((serverId) =>
            ["get_email", "list_crm_candidate_roles"].flatMap((tool) => [
              {
                AND: [
                  { request: { path: ["2", "route", "resourceId"], equals: serverId } },
                  { request: { path: ["2", "route", "toolName"], equals: tool } },
                ],
              },
              {
                AND: [
                  { request: { path: ["3", "resourceId"], equals: serverId } },
                  { request: { path: ["3", "toolName"], equals: tool } },
                ],
              },
            ]),
          ),
        },
        include,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 201,
      });
      const servers = await tx.mcpServer.findMany({
        where: {
          id: { in: serverIds },
          userId: actor.userId,
          spaceId: actor.spaceId,
          enabled: true,
        },
      });
      const assignments = await tx.botMcpServer.findMany({
        where: {
          serverId: { in: serverIds },
          botId: {
            in: [...new Set([...scopedEffects, ...observations].map((effect) => effect.run.botId))],
          },
          userId: actor.userId,
          spaceId: actor.spaceId,
        },
      });
      return {
        ...binding,
        effects: scopedEffects,
        records,
        revisions,
        observations: observations.slice(0, 200),
        servers,
        assignments,
        partial: effects.length > 200 || observations.length > 200,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!captured) return null;
  const authorizations = new Map<
    string,
    { server: (typeof captured.servers)[number]; botId: string; tool: string }
  >();
  const authorized = (effect: (typeof captured.records)[number], operation: string) => {
    if (
      effect.spaceId !== actor.spaceId ||
      effect.run.userId !== actor.userId ||
      effect.run.spaceId !== actor.spaceId ||
      effect.run.threadId !== input.threadId ||
      effect.run.id !== effect.runId
    )
      throw new IsolationError();
    const call = replyNativeCall(effect.request, operation);
    const server = captured.servers.find((row) => row.id === call.route.resourceId);
    const assignment = captured.assignments.find(
      (row) => row.serverId === server?.id && row.botId === effect.run.botId,
    );
    if (
      !server?.enabled ||
      server.userId !== actor.userId ||
      server.spaceId !== actor.spaceId ||
      server.revision !== call.route.resourceRevision ||
      !assignment ||
      assignment.userId !== actor.userId ||
      assignment.spaceId !== actor.spaceId ||
      (!assignment.allowAllTools &&
        (!Array.isArray(assignment.allowedTools) || !assignment.allowedTools.includes(operation)))
    )
      throw new IsolationError();
    authorizations.set(stableJsonValue([server.id, effect.run.botId, operation]), {
      server,
      botId: effect.run.botId,
      tool: operation,
    });
    return { ...call, server };
  };
  const successful = (effect: (typeof captured.records)[number]) => {
    const result = effect.result;
    return (
      effect.status === "completed" &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.error === undefined &&
      (result.isError === undefined || result.isError === false)
    );
  };
  const byId = new Map(captured.records.map((effect) => [effect.id, effect]));
  const latest = new Map<string, (typeof captured.records)[number]>();
  for (const effect of captured.observations) {
    for (const tool of ["get_email", "list_crm_candidate_roles"]) {
      try {
        const call = authorized(effect, tool);
        const key = stableJsonValue([call.route, call.args]);
        if (!latest.has(key)) latest.set(key, effect);
      } catch {
        /* Other tools or revoked sources cannot establish a current association. */
      }
    }
  }
  const records = (captured.effects ?? []).flatMap((effect) => {
    try {
      const scope = replyScope(effect.request)!;
      if (
        scope.roleId !== captured.roleId ||
        scope.bindingEffectId !== captured.bindingEffectId ||
        [
          scope.candidateId,
          scope.roleRevisionId,
          scope.emailReadEffectId,
          scope.crmContextReadEffectId,
          scope.membershipReadEffectId,
        ].some((id) => typeof id !== "string" || !id.trim()) ||
        !captured.revisions.some(
          (row) =>
            row.id === scope.roleRevisionId &&
            row.roleId === captured.roleId &&
            row.revision === scope.expectedRoleRevision,
        )
      )
        throw new IsolationError();
      const reply = authorized(effect, "reply_to_email");
      const proof = (
        id: string,
        tool: string,
        route: typeof reply.route,
        args: Record<string, unknown>,
      ) => {
        const value = byId.get(id);
        if (!value || value.runId !== effect.runId || !successful(value))
          throw new IsolationError();
        authorized(value, tool);
        assertCrmImportRequest(value.request, { ...route, toolName: tool }, args);
        return value;
      };
      const crmRoute = {
        connectorId: "mcp" as const,
        resourceId: captured.target.mcpServerId,
        resourceRevision: captured.target.serverRevision,
        toolName: "get_crm_candidate_outreach_context",
      };
      const crmArgs = { p_org: captured.target.organizationId, p_candidate: scope.candidateId };
      const emailRead = proof(scope.emailReadEffectId, "get_email", reply.route, {
        id: reply.args.reply_to_uuid,
      });
      const crmRead = proof(scope.crmContextReadEffectId, crmRoute.toolName, crmRoute, crmArgs);
      proof(scope.membershipReadEffectId, "list_crm_candidate_roles", crmRoute, crmArgs);
      const membershipRoute = { ...crmRoute, toolName: "list_crm_candidate_roles" };
      const membership = latest.get(stableJsonValue([membershipRoute, crmArgs]));
      if (!membership || !successful(membership)) throw new IsolationError();
      const members = mcpObject(membership.result)?.data;
      const candidate = (
        mcpObject(crmRead.result)?.data as { candidate?: Record<string, unknown> } | undefined
      )?.candidate;
      if (
        !candidate ||
        candidate.id !== scope.candidateId ||
        candidate.organization_id !== captured.target.organizationId ||
        candidate.email !== reply.args.to ||
        !Array.isArray(members) ||
        members.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            row.organization_id !== captured.target.organizationId ||
            row.candidate_id !== scope.candidateId ||
            typeof row.membership_id !== "string",
        ) ||
        !members.some(
          (row) =>
            row.role_spec_id === captured.target.crmRoleId &&
            row.client_id === captured.target.crmClientId,
        )
      )
        throw new IsolationError();
      return [
        {
          effect,
          scope,
          source: reply.server,
          args: reply.args,
          emailRead,
          reads: [...latest.values()].filter((read) => {
            try {
              const call = authorized(read, "get_email");
              return (
                call.route.resourceId === reply.route.resourceId &&
                call.route.resourceRevision === reply.route.resourceRevision
              );
            } catch {
              return false;
            }
          }),
        },
      ];
    } catch (error) {
      if (!(error instanceof IsolationError)) throw error;
      captured.partial = true;
      return [];
    }
  });
  const crmSource = captured.servers.find((server) => server.id === captured.target.mcpServerId);
  return {
    roleId: captured.roleId,
    bindingEffectId: captured.bindingEffectId,
    target: captured.target,
    crmSource,
    authorizations: [...authorizations.values()],
    partial: captured.partial,
    records,
  };
}

async function nativeReplyContext(
  tx: Tx,
  actor: Actor,
  trusted: ResearchLease & { approvedEffectId?: string },
  raw: NativeReplyTarget | null,
  run: Awaited<ReturnType<typeof lockLiveRecruitingRun>>["run"],
) {
  let effect = trusted.approvedEffectId
    ? await tx.externalEffect.findFirst({
        where: { id: trusted.approvedEffectId, spaceId: actor.spaceId, runId: run.id },
      })
    : null;
  let saved = effect ? replyScope(effect.request) : undefined;
  if (!raw && !saved) return null;
  if (saved) {
    if (effect?.status !== "approved") throw new IsolationError();
    await approvalAnswerProof(tx, actor, effect);
    const call = replyNativeCall(effect.request, "reply_to_email");
    raw = {
      mcpServerId: call.route.resourceId,
      serverRevision: call.route.resourceRevision,
      replyToEmailId: call.args.reply_to_uuid as string,
      recipient: call.args.to as string,
    };
  }
  if (
    !raw ||
    Object.keys(raw).some(
      (key) => !["mcpServerId", "serverRevision", "replyToEmailId", "recipient"].includes(key),
    ) ||
    [raw.mcpServerId, raw.replyToEmailId, raw.recipient].some(
      (value) => typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value),
    ) ||
    !Number.isSafeInteger(raw.serverRevision) ||
    raw.serverRevision < 1
  )
    throw new IsolationError();
  if (!effect) {
    const effects = await tx.externalEffect.findMany({
      where: { spaceId: actor.spaceId, runId: run.id },
    });
    effect =
      effects.find((item) => {
        if (!replyScope(item.request)) return false;
        const call = replyNativeCall(item.request, "reply_to_email");
        return (
          call.route.resourceId === raw!.mcpServerId &&
          call.args.reply_to_uuid === raw!.replyToEmailId
        );
      }) ?? null;
    saved = effect ? replyScope(effect.request) : undefined;
  }
  requireResearchLease(run, trusted);
  const thread = await requireThread(tx, actor, run.threadId);
  if (!thread.activeRecruitingRoleId || (saved && saved.roleId !== thread.activeRecruitingRoleId))
    throw new IsolationError();
  const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, true);
  if (!role.crmBindingEffectId) throw new IsolationError();
  const bound = await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId);
  const row = await tx.recruitingRoleRevision.findFirst({
    where: { roleId: role.id, revision: role.revision },
  });
  if (!row || row.id !== role.currentRevisionId) throw new RecruitingConflictError();
  const roleRevision = RecruitingRoleRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
  await requireReplyAssignment(
    tx,
    actor,
    run,
    bound.target.mcpServerId,
    bound.target.serverRevision,
    ["get_crm_candidate_outreach_context", "list_crm_candidate_roles"],
  );
  await requireReplyAssignment(tx, actor, run, raw.mcpServerId, raw.serverRevision, [
    "get_email",
    "list_emails",
    "reply_to_email",
  ]);
  const route = {
    connectorId: "mcp" as const,
    resourceId: raw.mcpServerId,
    resourceRevision: raw.serverRevision,
    toolName: "reply_to_email" as const,
  };
  const crmRoute = {
    connectorId: "mcp",
    resourceId: bound.target.mcpServerId,
    resourceRevision: bound.target.serverRevision,
    toolName: "get_crm_candidate_outreach_context",
  };
  const crmProof = saved
    ? await retainedReplyProof(tx, actor, run.id, saved.crmContextReadEffectId, crmRoute, {
        p_org: bound.target.organizationId,
        p_candidate: saved.candidateId,
      })
    : await nativeMcpReadProof(tx, actor, run.id, crmRoute, (args, result) => {
        const data = mcpObject(result)?.data as { candidate?: Record<string, unknown> } | undefined;
        const candidate = data?.candidate;
        return (
          Object.keys(args).length === 2 &&
          args.p_org === bound.target.organizationId &&
          typeof args.p_candidate === "string" &&
          candidate?.id === args.p_candidate &&
          candidate.organization_id === args.p_org &&
          typeof candidate.email === "string" &&
          candidate.email === raw!.recipient
        );
      });
  if (!crmProof) throw new IsolationError();
  const data = mcpObject(crmProof.result)?.data as
    | { candidate?: Record<string, unknown> }
    | undefined;
  const candidate = data?.candidate;
  if (!candidate || typeof candidate.id !== "string") throw new IsolationError();
  const candidateId = candidate.id;
  if (
    candidate.organization_id !== bound.target.organizationId ||
    candidate.email !== raw.recipient
  )
    throw new IsolationError();
  if (saved)
    await retainedReplyProof(
      tx,
      actor,
      run.id,
      saved.membershipReadEffectId,
      { ...crmRoute, toolName: "list_crm_candidate_roles" },
      { p_org: bound.target.organizationId, p_candidate: candidateId },
    );
  const membershipProof = await nativeMcpReadProof(
    tx,
    actor,
    run.id,
    { ...crmRoute, toolName: "list_crm_candidate_roles" },
    { p_org: bound.target.organizationId, p_candidate: candidateId },
  );
  const rows = membershipProof && mcpObject(membershipProof.result)?.data;
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.some(
      (value) =>
        !value ||
        typeof value !== "object" ||
        value.organization_id !== bound.target.organizationId ||
        value.candidate_id !== candidateId ||
        typeof value.membership_id !== "string",
    ) ||
    !rows.some(
      (value) =>
        value.role_spec_id === bound.target.crmRoleId &&
        value.client_id === bound.target.crmClientId,
    )
  )
    throw new IsolationError();
  const emailProof = saved
    ? await retainedReplyProof(
        tx,
        actor,
        run.id,
        saved.emailReadEffectId,
        { ...route, toolName: "get_email" },
        { id: raw.replyToEmailId },
      )
    : await nativeMcpReadProof(
        tx,
        actor,
        run.id,
        { ...route, toolName: "get_email" },
        { id: raw.replyToEmailId },
      );
  if (!emailProof || !membershipProof) throw new IsolationError();
  // A native CRM member need not have an Autumn occurrence; existing local hold/pass still applies.
  if (
    typeof candidate.linkedin_identity === "string" &&
    /^\/in\/[^/]+$/.test(candidate.linkedin_identity)
  ) {
    const key = `linkedin:${candidate.linkedin_identity}`;
    const local = await tx.recruitingCandidate.findUnique({
      where: { roleId_candidateKey: { roleId: role.id, candidateKey: key } },
    });
    if (local) await requireCandidateConsideration(tx, actor, role.id, key);
  }
  const nativeScope: NativeReplyScope = {
    roleId: role.id,
    roleRevisionId: roleRevision.id,
    expectedRoleRevision: role.revision,
    bindingEffectId: role.crmBindingEffectId,
    candidateId,
    emailReadEffectId: emailProof.effectId,
    crmContextReadEffectId: crmProof.effectId,
    membershipReadEffectId: saved?.membershipReadEffectId ?? membershipProof.effectId,
  };
  if (saved && stableJsonValue(saved) !== stableJsonValue(nativeScope))
    throw new RecruitingConflictError();
  return {
    input: raw,
    target: bound.target,
    crmImportReceipt: null,
    candidateId,
    membershipProof,
    nativeScope,
    role,
    roleRevision,
    route,
    emailProof,
    crmProof,
    effect: effect ?? undefined,
    link: null,
    run,
  };
}

async function replyContext(
  tx: Tx,
  actor: Actor,
  trusted: ResearchLease & { approvedEffectId?: string },
  raw: ReplyTarget | null,
) {
  const { run } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
  let input: RecruitingReplyTarget | null = raw && "crmImportEffectId" in raw ? raw : null;
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
  if (!input && !link)
    return nativeReplyContext(tx, actor, trusted, raw as NativeReplyTarget | null, run);
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
    await requireCandidateConsideration(tx, actor, role.id, imported.occurrence.candidateKey);
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
    candidateId: crmImportReceipt.candidate_id,
    membershipProof: null,
    nativeScope: undefined,
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
  input: ReplyTarget | null,
) {
  return prisma.$transaction(async (tx) => {
    const resolved = await replyContext(tx, actor, trusted, input);
    if (!resolved) return null;
    const { run: _run, link: _link, ...result } = resolved;
    return result;
  });
}

/**
 * A reply recipient who is a lead of the role's own outreach campaign. Roles without a CRM
 * record for the person (or with no CRM role linked at all) still get the native reply path:
 * the proof is the role's campaign binding plus either this run's list_leads read naming the
 * address or the binding's own recorded leads. Returns null when the address is neither.
 */
export async function resolveRecruitingCampaignLead(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: { mcpServerId: string; serverRevision: number; recipient: string },
) {
  return prisma.$transaction(async (tx) => {
    const { run, thread } = await lockLiveRecruitingRun(tx, actor, trusted.runId, false);
    requireResearchLease(run, trusted);
    if (!thread.activeRecruitingRoleId) return null;
    const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, true, thread);
    const binding = await tx.externalEffect.findUnique({
      where: { idempotencyKey: `instantly-role-campaign:${input.mcpServerId}:${role.id}` },
    });
    if (
      !binding ||
      binding.spaceId !== actor.spaceId ||
      binding.kind !== "instantly_role_campaign" ||
      binding.status !== "completed"
    )
      return null;
    const bound = binding.result as {
      campaignId?: unknown;
      eaccount?: unknown;
      leads?: Record<string, { leadId?: unknown; email?: unknown }>;
    } | null;
    const campaignId = bound?.campaignId;
    if (typeof campaignId !== "string" || !campaignId) return null;
    const email = input.recipient.trim().toLowerCase();
    if (!email) return null;
    const same = (value: unknown) =>
      typeof value === "string" && value.trim().toLowerCase() === email;
    const leadOf = (lead: unknown) => {
      const row = lead as { email?: unknown; campaign?: unknown; id?: unknown } | null;
      return Boolean(
        row &&
          typeof row === "object" &&
          same(row.email) &&
          (row.campaign === undefined || row.campaign === null || row.campaign === campaignId),
      );
    };
    let leadId: string | null = null;
    const proof = await nativeMcpReadProof(
      tx,
      actor,
      run.id,
      {
        connectorId: "mcp",
        resourceId: input.mcpServerId,
        resourceRevision: input.serverRevision,
        toolName: "native_instantly_list_leads",
      },
      (args, result) => {
        if (args.campaign_id !== campaignId && !same(args.email)) return false;
        const items = (mcpObject(result)?.result as { items?: unknown } | undefined)?.items;
        const lead = Array.isArray(items) ? items.find(leadOf) : undefined;
        if (!lead) return false;
        leadId = typeof lead.id === "string" ? lead.id : null;
        return true;
      },
    );
    const recorded = Object.values(bound?.leads ?? {}).find((lead) => same(lead?.email));
    if (!proof && !recorded) return null;
    return {
      roleId: role.id,
      campaignId,
      eaccount: typeof bound?.eaccount === "string" ? bound.eaccount : null,
      email,
      leadId: leadId ?? (typeof recorded?.leadId === "string" ? recorded.leadId : null),
      // Stable surrogate for a person who has no CRM candidate id.
      identity: `lead:${campaignId}:${email}`,
      leadReadEffectId: proof?.effectId ?? binding.id,
    };
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
    native.identity.crmCandidateId !== resolved.candidateId ||
    native.identity.anchorId !== resolved.input.replyToEmailId
  )
    throw new IsolationError();
  const scope = replyScope(native.effectRequest);
  if (
    scope &&
    (!resolved.nativeScope || stableJsonValue(scope) !== stableJsonValue(resolved.nativeScope))
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
  input: ReplyTarget,
  native: RecruitingReplyNative,
) {
  const key = replyKey(native.identity);
  return prisma.$transaction(async (tx) => {
    const resolved = await replyContext(tx, actor, trusted, input);
    if (!resolved) throw new IsolationError();
    assertReplyNative(resolved, native);
    const request = resolved.nativeScope
      ? replyEnvelope(native.effectRequest, resolved.nativeScope)
      : native.effectRequest;
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
          request: request as Prisma.InputJsonValue,
        },
      });
      if ("crmImportEffectId" in resolved.input)
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
      if (link) await replyLinkTarget(tx, actor, link);
      else if (!replyScope(effect.request)) throw new IsolationError();
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
      !resolved.nativeScope &&
      (!resolved.link ||
        resolved.link.effectId !== effect.id ||
        resolved.link.roleRevisionId !== resolved.roleRevision.id ||
        resolved.link.crmImportEffectId !==
          ("crmImportEffectId" in resolved.input ? resolved.input.crmImportEffectId : null) ||
        resolved.link.emailReadEffectId !== native.emailReadEffectId ||
        resolved.link.crmContextReadEffectId !== native.crmContextReadEffectId)
    )
      throw new RecruitingConflictError();
    if (
      effect.kind !== native.effectKind ||
      stableJsonValue(effect.request) !== stableJsonValue(request)
    )
      throw new RecruitingConflictError();
    return { status: "ready" as const, effect };
  });
}

export async function claimRecruitingReply(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease,
  input: ReplyTarget,
  native: RecruitingReplyNative & {
    effectId: string;
    from: "approved";
    crmPreflightReadEffectId: string;
  },
) {
  const key = replyKey(native.identity);
  return prisma.$transaction(async (tx) => {
    const resolved = await replyContext(tx, actor, trusted, input);
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
      resolved.link &&
      (resolved.link.roleRevisionId !== resolved.roleRevision.id ||
        resolved.link.crmImportEffectId !==
          ("crmImportEffectId" in resolved.input ? resolved.input.crmImportEffectId : null) ||
        resolved.link.emailReadEffectId !== native.emailReadEffectId ||
        resolved.link.crmContextReadEffectId !== native.crmContextReadEffectId)
    )
      throw new IsolationError();
    await approvalAnswerProof(tx, actor, effect);
    // The card freezes original evidence; dispatch must still use the last clear observation.
    const currentCrm = await nativeMcpReadProof(
      tx,
      actor,
      trusted.runId,
      {
        connectorId: "mcp",
        resourceId: resolved.target.mcpServerId,
        resourceRevision: resolved.target.serverRevision,
        toolName: "get_crm_candidate_outreach_context",
      },
      { p_org: resolved.target.organizationId, p_candidate: resolved.candidateId },
    );
    if (!currentCrm || currentCrm.effectId !== native.crmPreflightReadEffectId)
      throw new RecruitingConflictError("CRM context changed after this reply's preflight");
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
  links: Prisma.RecruitingCrmImportGetPayload<{ include: { effect: true; occurrence: true } }>[],
  verified: {
    pages: ReadonlyMap<string, Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>>;
    sources: readonly Prisma.RecruitingCandidateOccurrenceGetPayload<{
      include: { page: true };
    }>[];
    binding?: Awaited<ReturnType<typeof crmBindingReceipt>>;
  },
  afterRead?: Array<() => void>,
): Promise<Map<string, RecruitingCrmCandidateSync>> {
  const syncs = new Map<string, RecruitingCrmCandidateSync>();
  if (!links.length) return syncs;
  // ponytail: batch retained read proofs inside this snapshot, never cache authorization across reads.
  const sources = new Map(
    verified.sources.map((source) => [`${source.pageId}:${source.rowIndex}`, source]),
  );
  const pages = new Map(verified.pages);
  const missing = new Map<
    string,
    Prisma.RecruitingCandidatePageGetPayload<Record<string, never>>
  >();
  for (const link of links) {
    const source = sources.get(`${link.pageId}:${link.rowIndex}`);
    if (!source) throw new IsolationError();
    const page = source.page;
    if (page.taskId === null && page.actionId === null && !pages.has(page.effectId))
      missing.set(page.effectId, page);
  }
  await candidatePageArtifacts(tx, actor, [...missing.values()], true, afterRead);
  for (const [id, page] of missing) pages.set(id, page);
  const ownerScope = { spaceId: actor.spaceId, userId: actor.userId };
  const owners = new Map(
    (
      await tx.run.findMany({
        where: {
          ...ownerScope,
          id: { in: [...new Set(links.map((link) => link.effect.runId))] },
          bot: ownerScope,
          thread: {
            ...ownerScope,
            OR: [
              { botId: { not: null }, bot: ownerScope },
              { botId: null, groupId: { not: null }, group: ownerScope },
              {
                botId: null,
                groupId: null,
                externalConversationId: { not: null },
                externalConversation: { ...ownerScope, bot: ownerScope },
              },
            ],
          },
        },
        select: { id: true, spaceId: true, userId: true, status: true, leaseExpiresAt: true },
      })
    ).map((run) => [run.id, run]),
  );
  const bindings = new Map<string, Awaited<ReturnType<typeof crmBindingReceipt>>>();
  for (const link of links) {
    const input = {
      roleId: link.occurrence.roleId,
      candidateKey: link.occurrence.candidateKey,
      bindingEffectId: link.bindingEffectId,
      sourceEffectId: link.pageId,
      rowIndex: link.rowIndex,
    };
    let bound = bindings.get(link.bindingEffectId);
    if (!bound || bound.roleId !== input.roleId) {
      bound =
        verified.binding?.roleId === input.roleId &&
        verified.binding.bindingEffectId === input.bindingEffectId
          ? verified.binding
          : await crmBindingReceipt(tx, actor, input.roleId, input.bindingEffectId);
      bindings.set(link.bindingEffectId, bound);
    }
    const source = await crmImportSource(
      tx,
      actor,
      input,
      pages,
      sources.get(`${link.pageId}:${link.rowIndex}`),
    );
    const args = crmImportArgs(bound.target, source);
    const ownerState = scoped(actor, owners.get(link.effect.runId) ?? null);
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
    syncs.set(link.effect.id, {
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
    });
  }
  return syncs;
}

export async function getRecruitingCrmCandidateSyncs(
  prisma: PrismaClient,
  actor: Actor,
  input: { roleId: string; effectIds: readonly string[] },
): Promise<RecruitingCrmCandidateSync[]> {
  if (
    typeof input.roleId !== "string" ||
    !input.roleId.trim() ||
    !Array.isArray(input.effectIds) ||
    input.effectIds.length > 200 ||
    input.effectIds.some((id) => typeof id !== "string" || !id.trim())
  )
    throw new IsolationError();
  const ids = new Set(input.effectIds);
  if (!ids.size) return [];
  const afterRead: Array<() => void> = [];
  const result = await prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      if (!role.crmBindingEffectId) throw new IsolationError();
      const binding = await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId);
      const imports = await tx.recruitingCrmImport.findMany({
        where: {
          effectId: { in: [...ids] },
          bindingEffectId: binding.bindingEffectId,
          occurrence: { roleId: role.id },
          effect: {
            spaceId: actor.spaceId,
            run: { spaceId: actor.spaceId, userId: actor.userId },
          },
        },
        include: { effect: true, occurrence: { include: { page: true } } },
      });
      if (
        imports.length !== ids.size ||
        imports.some(
          (link) =>
            !ids.has(link.effectId) ||
            link.bindingEffectId !== binding.bindingEffectId ||
            link.effect.id !== link.effectId ||
            link.effect.spaceId !== actor.spaceId ||
            link.occurrence.roleId !== role.id ||
            link.occurrence.page.roleId !== role.id ||
            link.occurrence.page.effectId !== link.pageId,
        )
      )
        throw new IsolationError();
      const syncs = await crmSourceSync(
        tx,
        actor,
        imports,
        { pages: new Map(), sources: imports.map((link) => link.occurrence), binding },
        afterRead,
      );
      return [...ids].map((id) => syncs.get(id)!);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  for (const verify of afterRead) verify();
  return result;
}

function candidateSourceReference(
  page: Prisma.RecruitingCandidatePageGetPayload<Record<string, never>> & {
    effect: { request: Prisma.JsonValue };
  },
  rowIndex: number,
) {
  return {
    providerTaskId: unassessedPageRequest(page.effect.request)
      ? null
      : researchReadRequest(page.effect.request, undefined, "get_rows").args.task_id,
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
  const afterRead: Array<() => void> = [];
  // Fill legacy NULL matchFields BEFORE the RepeatableRead snapshot, as its own autocommit
  // statement (page bodies parsed once per page, not per row), so the read never parses saved
  // pages. Owner-scoped; idempotent and a cheap no-op once filled. Unauthorized ids match no row.
  await fillCandidateMatchFields(
    prisma,
    Prisma.sql`o."roleId" = (SELECT r."id" FROM "recruiting_roles" r WHERE r."id" = ${input.roleId} AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId})`,
  );
  const result = await prisma.$transaction(
    async (tx) => {
      const role = await requireRole(tx, actor, input.roleId);
      const sort = input.sort ?? "rank";
      const matchSort = sort === "rank" || sort === "tier" || sort === "score";
      const limit = input.limit ?? 25;
      const explicitSource = input.sourceEffectId !== undefined || input.actionId !== undefined;
      // Every sort reads the same domain, so availability does not depend on the current sort
      // (a list sorted by name still reports that scores can sort it).
      let rankDomainPageId = input.sourceEffectId;
      if (rankDomainPageId === undefined) {
        const pages = await tx.recruitingCandidatePage.findMany({
          where: {
            roleId: role.id,
            ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
          },
          select: { effectId: true },
          // Ranks and scores compare only within one saved result; with several results the
          // newest one is the role's current ordering (older pages sort after it, unscored).
          orderBy: [{ observedAt: "desc" }, { effectId: "desc" }],
          take: 1,
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
      const order = Prisma.sql`${matchSort ? Prisma.sql`"matchValue" ${sort === "score" ? Prisma.sql`DESC` : Prisma.sql`ASC`} NULLS LAST` : Prisma.sql`"sortValue" ${direction}`}, "candidateKey" COLLATE "C" ASC`;
      // ponytail: totals and the bounded page share one provider/profile projection and snapshot.
      const result = await tx.$queryRaw<
        Array<
          {
            total: bigint;
            sourceRows: bigint;
            candidates: bigint;
            identifiedCandidates: bigint;
            unassessed: bigint;
            assessed: bigint;
            shortlistedCount: bigint;
            rankAvailable: boolean;
            tierAvailable: boolean;
            scoreAvailable: boolean;
          } & (CandidateQueryRow | { [Key in keyof CandidateQueryRow]: null })
        >
      >(Prisma.sql`${filtered}, ordered AS (
        SELECT *, ${sortValue} AS "sortValue" FROM filtered
      ), candidate_page AS (
        SELECT * FROM ordered WHERE ${after} ORDER BY ${order} LIMIT ${limit + 1}
      ), totals AS (
        SELECT (SELECT count(*) FROM filtered) AS "total",
          (SELECT COALESCE(bool_or("rankValue" IS NOT NULL), false) FROM filtered) AS "rankAvailable",
          (SELECT COALESCE(bool_or("tierValue" IS NOT NULL), false) FROM filtered) AS "tierAvailable",
          (SELECT COALESCE(bool_or("scoreValue" IS NOT NULL), false) FROM filtered) AS "scoreAvailable",
          COALESCE(sum("discoveryCount"), 0)::bigint AS "sourceRows", count(*) AS "candidates",
          count(*) FILTER (WHERE "countIdentified") AS "identifiedCandidates",
          count(*) FILTER (WHERE "assessmentVersion" IS NULL) AS "unassessed",
          count(*) FILTER (WHERE "assessmentVersion" IS NOT NULL) AS "assessed",
          count(*) FILTER (WHERE "shortlisted") AS "shortlistedCount" FROM base
      ) SELECT totals.*, candidate_page.* FROM totals LEFT JOIN candidate_page ON true
        ORDER BY ${order}`);
      const rows = result.flatMap(
        ({
          total: _total,
          sourceRows: _sourceRows,
          candidates: _candidates,
          identifiedCandidates: _identifiedCandidates,
          unassessed: _unassessed,
          assessed: _assessed,
          shortlistedCount: _shortlisted,
          rankAvailable: _rankAvailable,
          tierAvailable: _tierAvailable,
          scoreAvailable: _scoreAvailable,
          ...row
        }) => (row.candidateKey === null ? [] : [row]),
      );
      const selected = rows.slice(0, limit);
      // The list renders match fields and page provenance only, never action artifacts.
      const pages = await candidateProfilePages(tx, actor, role.id, selected, afterRead, true);

      const last = selected.at(-1);
      const {
        total,
        rankAvailable,
        tierAvailable,
        scoreAvailable,
        sourceRows,
        candidates,
        identifiedCandidates,
        unassessed,
        assessed,
        shortlistedCount,
      } = result[0]!;
      const counts = {
        sourceRows,
        candidates,
        identifiedCandidates,
        unassessed,
        assessed,
        shortlisted: shortlistedCount,
      };
      const attached = await attachedCrmTarget(tx, actor, role.id, role.sourceThreadId);
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
          include: { effect: true, occurrence: { include: { page: true } } },
          orderBy: [{ effect: { createdAt: "desc" } }, { effectId: "desc" }],
        });
        const latest = new Map<string, (typeof imports)[number]>();
        for (const link of imports)
          if (!latest.has(link.occurrence.candidateKey))
            latest.set(link.occurrence.candidateKey, link);
        const projected = await crmSourceSync(
          tx,
          actor,
          [...latest.values()],
          { pages, sources: imports.map((link) => link.occurrence), binding: bound },
          afterRead,
        );
        for (const [key, link] of latest) syncs.set(key, projected.get(link.effectId)!);
      }
      const savedProfiles = await listRecruitingSavedProfiles(
        tx,
        actor,
        selected.map((row) => row.candidateKey),
      );
      return ListRecruitingCandidatesOutput.parse({
        sortAvailability: { rank: rankAvailable, tier: tierAvailable, score: scoreAvailable },
        crmTarget: attached
          ? { bindingEffectId: null, target: attached }
          : bound
            ? { bindingEffectId: bound.bindingEffectId, target: bound.target }
            : null,
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
            consideration,
            ...profile
          }) => {
            const decision = candidateConsideration(actor, consideration);
            const numeric = (value: unknown) =>
              value === null || value === undefined ? null : Number(value);
            return {
              ...profile,
              match: {
                rank: numeric(_rank),
                tier: ["Strong", "Promising", "Partial", "Uncertain"][numeric(_tier) ?? -1] ?? null,
                score: numeric(_score),
              },
              crm: syncs.get(profile.candidateKey) ?? null,
              savedProfile: savedProfiles.get(profile.candidateKey) ?? null,
              decision: decision?.operation ?? null,
              decisionReason: decision?.source.quote ?? null,
              decisionAt: decision?.source.createdAt ?? null,
              ...(sourcePageId && sourceRowIndex !== null
                ? {
                    latestSource: candidateSourceReference(
                      pages.get(sourcePageId)!,
                      sourceRowIndex,
                    ),
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
            };
          },
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
  for (const verify of afterRead) verify();
  return result;
}

/** Every LinkedIn URL Autumn observed for a role (owner-fenced); identity only, never a profile. */
export async function listRecruitingCandidateLinkedinUrls(
  prisma: PrismaClient,
  actor: Actor,
  roleId: string,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const role = await requireRole(tx, actor, roleId);
    const rows = await tx.recruitingCandidateOccurrence.findMany({
      where: { roleId: role.id, linkedinUrl: { not: null } },
      select: { linkedinUrl: true },
      distinct: ["linkedinUrl"],
    });
    return rows.flatMap((row) => (row.linkedinUrl ? [row.linkedinUrl] : []));
  });
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

async function candidateProfiles(
  tx: Tx,
  actor: Actor,
  roleId: string,
  candidateKeys: readonly string[],
) {
  const profiles = await tx.$queryRaw<
    Pick<
      CandidateQueryRow,
      "name" | "linkedinUrl" | "resumeUrl" | "sourcePageId" | "profileSourcePageIds"
    >[]
  >(
    Prisma.sql`${candidateIndexQuery(roleId)} SELECT "name", "linkedinUrl", "resumeUrl", "sourcePageId", "profileSourcePageIds" FROM base WHERE "candidateKey" IN (${Prisma.join(candidateKeys)})`,
  );
  if (profiles.length !== candidateKeys.length) throw new IsolationError();
  await candidateProfilePages(tx, actor, roleId, profiles);
  return profiles;
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
  const profile = (await candidateProfiles(tx, actor, role.id, [candidate.candidateKey]))[0]!;
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
      shortlistedAt: input.shortlisted ? (candidate.shortlistedAt ?? new Date()) : null,
      revision: candidate.revision + 1,
      shortlistMessageId: message.id,
    },
  });
  if (changed.count !== 1) throw new RecruitingConflictError();
  await recordRecruitingChange(tx, actor, thread, role.id);
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
    const profile = (await candidateProfiles(tx, actor, role.id, [candidate.candidateKey]))[0]!;
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
  const afterRead: Array<() => void> = [];
  const result = await prisma.$transaction(
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
      await candidatePageArtifacts(tx, actor, [...pages.values()], false, afterRead);
      const last = selected.at(-1);
      const syncs = new Map<string, RecruitingCrmCandidateSync[]>(
        selected.map((row) => [`${row.pageId}:${row.rowIndex}`, []]),
      );
      const imports = selected.length
        ? await tx.recruitingCrmImport.findMany({
            where: {
              occurrence: where,
              OR: selected.map((row) => ({ pageId: row.pageId, rowIndex: row.rowIndex })),
            },
            include: { effect: true, occurrence: true },
            orderBy: [{ effect: { createdAt: "asc" } }, { effectId: "asc" }],
          })
        : [];
      for (const link of imports) {
        if (
          !syncs.has(`${link.pageId}:${link.rowIndex}`) ||
          link.occurrence.roleId !== role.id ||
          link.occurrence.candidateKey !== candidate.candidateKey
        )
          throw new IsolationError();
      }
      const projected = await crmSourceSync(
        tx,
        actor,
        imports,
        { pages, sources: selected },
        afterRead,
      );
      for (const link of imports)
        syncs.get(`${link.pageId}:${link.rowIndex}`)!.push(projected.get(link.effectId)!);
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
  for (const verify of afterRead) verify();
  return result;
}

// ---------------------------------------------------------------------------
// Calibration review rounds: which ten saved people each round showed the recruiter, and the
// recruiter's decision to move on to finding more people. Autumn owns matching; this only keeps
// identity, ordering and the human decision.
// ---------------------------------------------------------------------------

/** A round rule the agent can fix by asking Autumn again; the message is safe to show the agent. */
export class RecruitingCalibrationRoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecruitingCalibrationRoundError";
  }
}

type CalibrationRoundInput = Extract<
  RecruitingResearchToolInput,
  { operation: "calibration_round" }
>;

/**
 * Record the ten saved people a calibration round shows. After the first round every person must
 * be new: returned after the previous round and never shown before (the playbook's
 * "exclude everyone already seen").
 */
export async function saveRecruitingCalibrationRound(
  prisma: PrismaClient,
  actor: Actor,
  trusted: ResearchLease & { effectId: string; effectRequest: unknown },
  raw: CalibrationRoundInput,
) {
  const input = RecruitingResearchToolInputSchema.parse(raw);
  if (
    input.operation !== "calibration_round" ||
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
      !saving ||
      stableJsonValue(RecruitingResearchToolInputSchema.parse(saving.request)) !==
        stableJsonValue(input)
    )
      throw new IsolationError();
    if (saving.status === "completed") return saving.result;
    requireResearchLease(run, trusted);
    if (saving.status !== "executing" || !thread.activeRecruitingRoleId) throw new IsolationError();
    const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, true, thread);
    if (role.revision !== input.expectedRoleRevision) throw new RecruitingConflictError();
    const keys = input.candidateKeys;
    const saved = await tx.recruitingCandidate.findMany({
      where: { roleId: role.id, candidateKey: { in: [...keys] } },
      select: { candidateKey: true },
    });
    if (saved.length !== keys.length) {
      const known = new Set(saved.map((row) => row.candidateKey));
      const missing = keys.filter((key) => !known.has(key));
      // A key cut short that several saved people continue: name them so the retry picks one.
      const notes = await Promise.all(
        missing.map(async (key) => {
          const near = await tx.recruitingCandidate.findMany({
            where: { roleId: role.id, candidateKey: { startsWith: key } },
            select: { candidateKey: true },
            orderBy: { candidateKey: "asc" },
            take: 6,
          });
          if (near.length === 1) return `${key} (use ${near[0]?.candidateKey})`;
          if (near.length >= 2 && near.length <= 5)
            return `${key} (saved keys starting with it: ${near.map((row) => row.candidateKey).join(", ")})`;
          // A key spelled from a name several saved people share: choose by profile, never by name.
          const name = (key.split("/").pop() ?? "")
            .replace(/-[^-]*\d[^-]*$/, "")
            .replace(/-/g, " ");
          const namesakes = name.includes(" ")
            ? await tx.recruitingCandidateOccurrence.findMany({
                where: { roleId: role.id, name: { equals: name, mode: "insensitive" } },
                select: { candidateKey: true },
                distinct: ["candidateKey"],
                orderBy: { candidateKey: "asc" },
                take: 6,
              })
            : [];
          if (namesakes.length === 1) return `${key} (use ${namesakes[0]?.candidateKey})`;
          return namesakes.length >= 2
            ? `${key} (saved people with this name, choose by profile: ${namesakes.map((row) => row.candidateKey).join(", ")})`
            : key;
        }),
      );
      // The exact keys to pick from, so one retry is enough instead of guessing keys from names.
      const others = await tx.recruitingCandidateOccurrence.findMany({
        where: { roleId: role.id, candidateKey: { notIn: [...known] } },
        select: { candidateKey: true, name: true, company: true },
        distinct: ["candidateKey"],
        orderBy: { candidateKey: "asc" },
        take: 20,
      });
      const choices = others
        .map(
          (row) =>
            `${row.name ?? "?"}${row.company ? ` (${row.company})` : ""} = ${row.candidateKey}`,
        )
        .join("; ");
      throw new RecruitingCalibrationRoundError(
        `Every person in a calibration round must be a saved candidate of this role. Not saved: ${notes.join(", ")}. Use the exact candidateKey of a saved people row instead (the rows are already saved; no save_search is needed).${choices ? ` Saved people not yet in this round, in key order, to look up the key of the person you meant (never pick someone because they are listed here; every pick still fits every requirement and is not at the hiring company): ${choices}.` : ""}`,
      );
    }
    const previous = await tx.recruitingCalibrationRound.findFirst({
      where: { roleId: role.id },
      orderBy: { round: "desc" },
    });
    if (previous?.approvedAt)
      throw new RecruitingCalibrationRoundError(
        "The recruiter already approved the calibration. Continue with finding more people instead of another calibration round.",
      );
    if (previous) {
      const shown = new Set(
        (
          await tx.recruitingCalibrationRound.findMany({
            where: { roleId: role.id },
            select: { candidateKeys: true },
          })
        ).flatMap((round) => round.candidateKeys),
      );
      const pages = await tx.recruitingCandidateOccurrence.findMany({
        where: { roleId: role.id, candidateKey: { in: [...keys] } },
        select: { candidateKey: true, page: { select: { observedAt: true } } },
      });
      const earliest = new Map<string, number>();
      for (const row of pages) {
        const at = row.page.observedAt.getTime();
        earliest.set(row.candidateKey, Math.min(earliest.get(row.candidateKey) ?? at, at));
      }
      const seen = keys.filter(
        (key) => shown.has(key) || (earliest.get(key) ?? 0) <= previous.createdAt.getTime(),
      );
      if (seen.length)
        throw new RecruitingCalibrationRoundError(
          `Round ${previous.round + 1} must show only new people, but ${seen.length} of these ten were already returned before round ${previous.round}. Run a new quick people search with the round feedback that excludes everyone already returned for this role, save it with save_search, and record ten people whose alreadyInPool is false.`,
        );
    }
    const round = await tx.recruitingCalibrationRound.create({
      data: {
        roleId: role.id,
        round: (previous?.round ?? 0) + 1,
        candidateKeys: [...keys],
        effectId: saving.id,
      },
    });
    await advanceRecruitingPlaybookStage(tx, role.id, "feedback");
    const result = {
      status: "saved",
      roleId: role.id,
      round: round.round,
      candidateKeys: round.candidateKeys,
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

async function calibrationRoundView(
  tx: Pick<Tx, "recruitingCalibrationRound" | "recruitingCandidateOccurrence">,
  roleId: string,
): Promise<RecruitingCalibrationRound | null> {
  const round = await tx.recruitingCalibrationRound.findFirst({
    where: { roleId },
    orderBy: { round: "desc" },
  });
  if (!round) return null;
  // Newest saved row per person; display only.
  const rows = await tx.recruitingCandidateOccurrence.findMany({
    where: { roleId, candidateKey: { in: round.candidateKeys } },
    select: {
      candidateKey: true,
      name: true,
      title: true,
      company: true,
      location: true,
      linkedinUrl: true,
      page: { select: { observedAt: true } },
    },
    orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.candidateKey)) latest.set(row.candidateKey, row);
  return {
    round: round.round,
    createdAt: round.createdAt.toISOString(),
    approvedAt: round.approvedAt?.toISOString() ?? null,
    candidates: round.candidateKeys.map((candidateKey) => {
      const row = latest.get(candidateKey);
      return {
        candidateKey,
        name: row?.name ?? null,
        title: row?.title ?? null,
        company: row?.company ?? null,
        location: row?.location ?? null,
        linkedinUrl: row?.linkedinUrl ?? null,
      };
    }),
  };
}

/** The latest calibration round of the thread's active role, for the panel and the agent. */
export async function readRecruitingCalibrationRound(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
): Promise<{ roleId: string | null; round: RecruitingCalibrationRound | null }> {
  return prisma.$transaction(async (tx) => {
    const thread = await requireThread(tx, actor, input.threadId);
    if (!thread.activeRecruitingRoleId) return { roleId: null, round: null };
    const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, false, thread);
    return { roleId: role.id, round: await calibrationRoundView(tx, role.id) };
  });
}

async function approveLatestCalibrationRound(
  tx: Tx,
  actor: Actor,
  roleId: string,
  round: number | null,
  source: Prisma.InputJsonValue,
) {
  const latest = await tx.recruitingCalibrationRound.findFirst({
    where: { roleId },
    orderBy: { round: "desc" },
  });
  if (!latest)
    throw new RecruitingCalibrationRoundError(
      "No calibration round has been recorded for this role yet, so there is nothing to accept. Record the ten first (recruiting_research operation calibration_round with ten exact candidateKeys of saved people; recruiting_candidates list returns them), then call this again with the recruiter's words.",
    );
  if (round !== null && latest.round !== round)
    throw new RecruitingConflictError("A newer calibration round replaced this one");
  if (latest.approvedAt)
    return { round: latest.round, approvedAt: latest.approvedAt.toISOString(), already: true };
  const approvedAt = new Date();
  const updated = await tx.recruitingCalibrationRound.updateMany({
    where: { id: latest.id, approvedAt: null },
    data: { approvedAt, approvedByUserId: actor.userId, approvalSource: source },
  });
  if (updated.count !== 1) throw new RecruitingConflictError();
  await advanceRecruitingPlaybookStage(tx, roleId, "scale");
  return { round: latest.round, approvedAt: approvedAt.toISOString(), already: false };
}

/** The signed-in recruiter accepts the round from the panel control. */
export async function approveRecruitingCalibrationRound(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; round: number },
) {
  return prisma.$transaction(async (tx) => {
    const thread = await requireThread(tx, actor, input.threadId);
    if (!thread.activeRecruitingRoleId) throw new IsolationError();
    const role = await requireRole(tx, actor, thread.activeRecruitingRoleId, true, thread);
    const { round, approvedAt } = await approveLatestCalibrationRound(
      tx,
      actor,
      role.id,
      input.round,
      { kind: "control" },
    );
    return { round, approvedAt };
  });
}

/**
 * The recruiter accepted the round in their own words; the quote must come from the run's
 * current human message, exactly like other direct recruiting decisions.
 */
export async function approveRecruitingCalibrationRoundFromMessage(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    runId: string;
    sourceMessageId: string | null;
    intent: RecruitingHumanIntent;
    roleId: string;
    expectedRoleRevision: number;
  },
) {
  return prisma.$transaction(async (tx) => {
    const { message } = await feedbackContextInTransaction(tx, actor, {
      ...input,
      sourceRefs: [],
    });
    await requireRole(tx, actor, input.roleId, true);
    return approveLatestCalibrationRound(tx, actor, input.roleId, null, {
      kind: "message",
      messageId: message.id,
    });
  });
}

/** Validate the actual saved person before reading or recording any profile history. */
async function profileActivityTarget(tx: Tx, actor: Actor, input: ProfileActivityInput) {
  const role = await requireRole(tx, actor, input.roleId);
  let profileCrmSource: RecruitingCrmRoleReference | undefined;
  if (input.candidateKey.startsWith("autumn:")) {
    const candidate = await tx.recruitingCandidate.findUnique({
      where: {
        roleId_candidateKey: { roleId: role.id, candidateKey: input.candidateKey.slice(7) },
      },
      select: { candidateKey: true },
    });
    if (!candidate) throw new IsolationError();
  } else {
    const attached = await attachedCrmTarget(tx, actor, role.id, role.sourceThreadId);
    const target =
      attached ??
      (role.crmBindingEffectId
        ? (await crmBindingReceipt(tx, actor, role.id, role.crmBindingEffectId)).target
        : null);
    if (!target) throw new IsolationError();
    {
      const thread = await requireThread(tx, actor, role.sourceThreadId);
      const botId =
        thread.botId ??
        (thread.groupId
          ? (
              await tx.chatGroupMember.findFirst({
                where: { groupId: thread.groupId },
                orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
                select: { botId: true },
              })
            )?.botId
          : null);
      if (!botId) throw new IsolationError();
      const server = await tx.mcpServer.findFirst({
        where: {
          id: target.mcpServerId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          enabled: true,
          revision: target.serverRevision,
        },
      });
      if (!server) throw new IsolationError();
      const assignment = botId
        ? await tx.botMcpServer.findFirst({
            where: {
              botId,
              serverId: target.mcpServerId,
              userId: actor.userId,
              spaceId: actor.spaceId,
            },
          })
        : null;
      const allowedTools = assignment?.allowedTools;
      if (
        !assignment ||
        (!assignment.allowAllTools &&
          (!Array.isArray(allowedTools) ||
            !["get_crm_role", "list_crm_candidates"].every((tool) => allowedTools.includes(tool))))
      )
        throw new IsolationError();
      if (attached)
        profileCrmSource = {
          sourceId: target.mcpServerId,
          serverRevision: target.serverRevision,
          organizationId: target.organizationId,
          crmRoleId: target.crmRoleId,
        };
    }
    const scope = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      mcpServerId: target.mcpServerId,
      organizationId: target.organizationId,
      archivedAt: null,
    };
    const contact = await tx.recruitingCrmRoleContact.findFirst({
      where: {
        archivedAt: null,
        role: { ...scope, crmRoleId: target.crmRoleId },
        contact: { ...scope, crmCandidateId: input.candidateKey.slice(4) },
      },
      select: { contactId: true },
    });
    if (!contact) throw new IsolationError();
  }
  return {
    ...role,
    profileCrmSource,
    profileBindingEffectId: profileCrmSource ? null : role.crmBindingEffectId,
  };
}

function profileEventWhere(
  actor: Actor,
  roleId: string,
  candidateKey: string,
  threadId: string,
  bindingEffectId: string | null,
  crmSource?: RecruitingCrmRoleReference,
) {
  return {
    spaceId: actor.spaceId,
    threadId,
    thread: { userId: actor.userId, spaceId: actor.spaceId },
    type: "recruiting.profile.viewed",
    AND: [
      ...(crmSource ? [{ payload: { path: ["crmSource"], equals: crmSource } }] : []),
      { payload: { path: ["roleId"], equals: roleId } },
      { payload: { path: ["candidateKey"], equals: candidateKey } },
      { payload: { path: ["actorUserId"], equals: actor.userId } },
      {
        payload: {
          path: ["crmBindingEffectId"],
          equals: candidateKey.startsWith("crm:")
            ? (bindingEffectId ?? Prisma.JsonNull)
            : Prisma.JsonNull,
        },
      },
    ],
  };
}

function profileView(event: { id: string; createdAt: Date; payload: unknown }) {
  const payload = RecruitingProfileViewedPayloadSchema.parse(event.payload);
  return {
    id: event.id,
    at: event.createdAt.toISOString(),
    actorName: payload.actorName,
    roleTitle: payload.roleTitle,
  };
}

/** A bounded read of actual native view events; it never synthesizes historical activity. */
export async function listRecruitingProfileActivity(
  prisma: PrismaClient,
  actor: Actor,
  raw: ProfileActivityInput,
) {
  const input = RecruitingProfileActivityInput.parse(raw);
  return prisma.$transaction(async (tx) => {
    const role = await profileActivityTarget(tx, actor, input);
    const rows = await tx.event.findMany({
      where: profileEventWhere(
        actor,
        role.id,
        input.candidateKey,
        role.sourceThreadId,
        role.profileBindingEffectId,
        role.profileCrmSource,
      ),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      select: { id: true, createdAt: true, payload: true },
    });
    return { items: rows.slice(0, 50).map(profileView), hasMore: rows.length > 50 };
  });
}

/**
 * One actual open, retried with the same viewId. The existing thread row serializes the
 * duplicate check and append across processes; neither the actor nor time comes from the UI.
 */
export async function recordRecruitingProfileView(
  prisma: PrismaClient,
  actor: Actor,
  raw: ProfileViewInput,
) {
  const input = RecordRecruitingProfileViewInput.parse(raw);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const role = await profileActivityTarget(tx, actor, input);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "threads"
        WHERE "id" = ${role.sourceThreadId} AND "spaceId" = ${actor.spaceId}
          AND "userId" = ${actor.userId} FOR UPDATE
      `);
      // Recheck role, candidate and source ownership after waiting for the serialization lock.
      const currentRole = await profileActivityTarget(tx, actor, input);
      if (
        currentRole.sourceThreadId !== role.sourceThreadId ||
        currentRole.profileBindingEffectId !== role.profileBindingEffectId ||
        stableJsonValue(currentRole.profileCrmSource ?? null) !==
          stableJsonValue(role.profileCrmSource ?? null)
      )
        throw new IsolationError();
      const thread = await requireThread(tx, actor, role.sourceThreadId);
      const where = profileEventWhere(
        actor,
        role.id,
        input.candidateKey,
        thread.id,
        currentRole.profileBindingEffectId,
        currentRole.profileCrmSource,
      );
      const existing = await tx.event.findFirst({
        where: {
          ...where,
          AND: [...where.AND, { payload: { path: ["viewId"], equals: input.viewId } }],
        },
        select: { id: true, createdAt: true, payload: true },
      });
      if (existing) return profileView(existing);
      const user = await tx.user.findUnique({
        where: { id: actor.userId },
        select: { name: true },
      });
      if (!user) throw new IsolationError();
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId: thread.botId ?? thread.id,
        type: "recruiting.profile.viewed",
        payload: {
          roleId: role.id,
          candidateKey: input.candidateKey,
          roleTitle: currentRole.title,
          crmBindingEffectId: input.candidateKey.startsWith("crm:")
            ? currentRole.profileBindingEffectId
            : null,
          ...(currentRole.profileCrmSource ? { crmSource: currentRole.profileCrmSource } : {}),
          viewId: input.viewId,
          actorUserId: actor.userId,
          actorName: user.name || null,
        },
      });
      return profileView(event);
    }),
  );
}
