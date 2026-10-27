import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { AiConsentQuerySchema, AiConsentStatusSchema } from "./ai-consent.js";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BASE64_LENGTH,
  ATTACHMENT_MAX_COUNT,
} from "./attachments.js";
import {
  BoardEventSchema,
  BoardSchema,
  CommentTicketInput,
  CreateTicketInput,
  GetTicketInput,
  ListTicketsInput,
  ListTicketsOutput,
  MoveTicketInput,
  RenameBoardInput,
  TicketCommentSchema,
  TicketSchema,
  UpdateTicketInput,
} from "./board.js";
import { BotSecretMetadata, BotSecretPutInput, StoredBotSecretName } from "./bot-secrets.js";
import {
  ActionApprovalRuleSchema,
  ActionAutoReviewSettingsSchema,
  AgentSecretInputSchema,
  AgentSecretSchema,
  AgentSkillCatalogEntrySchema,
  AgentSkillSchema,
  AppBootstrapSchema,
  ArtifactSchema,
  ArtifactVersionSchema,
  ArtifactWithContentSchema,
  AvatarStyleSchema,
  BillingStatusSchema,
  BotMcpServerSchema,
  BotSchema,
  BotSectionSchema,
  CapabilityInstallSchema,
  ComputerModeSchema,
  ComputerReleaseReasonSchema,
  ComputerStatusSchema,
  ComputerUpdateSchema,
  ConnectionCatalogItemSchema,
  ConnectionSchema,
  CreateAgentSkillInput,
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  CreateScratchpadItemInput,
  DeploymentSettingsSchema,
  ExportManifestSchema,
  ExternalConversationPolicySchema,
  GroupDetailSchema,
  GroupSchema,
  IntegrationCatalogResultSchema,
  McpServerConfigInput,
  McpServerSchema,
  MemoryDocumentSchema,
  MemoryRevisionSchema,
  MemoryScopeSchema,
  MeSchema,
  MessagingAgentConnectionSchema,
  MessagingChannelMembershipSchema,
  MessagingLinkedIdentitySchema,
  MessagingStatusSchema,
  ModelBackupChoiceSchema,
  ModelBackupListSchema,
  ModelCatalogEntrySchema,
  ModelConnectInputSchema,
  ModelCredentialSchema,
  ModelOAuthBeginSchema,
  REPLY_QUOTE_MAX_LENGTH,
  ReorderBotsInput,
  RoutineSchema,
  ScratchpadItemSchema,
  ScratchpadItemStatusSchema,
  ServerUpdateCheckSchema,
  ServerUpdateRequestSchema,
  ServerUpdateRunSchema,
  ServerUpdateStatusSchema,
  SkillPlaybookSchema,
  SpaceMemoryConfigSchema,
  SpaceNavigationSchema,
  SpaceSchema,
  TaughtSkillSchema,
  TeachRecordingEventSchema,
  ThinkingLevelSchema,
  ThreadMessagePageSchema,
  ThreadSnapshotSchema,
  UpdateAgentSkillInput,
  UpdateBotInput,
  UpdateExternalConversationPolicyInput,
  UpdateGroupInput,
  UpdateRoutineInput,
  UsageCostsSchema,
  UsageRecordSchema,
  VoiceCatalogEntrySchema,
  VoiceCredentialSchema,
  VoiceInfoSchema,
  VoiceStatusSchema,
} from "./domain.js";
import {
  AskAnswerSchema,
  AskBlockSchema,
  ComputerCommandSchema,
  ProductEventSchema,
} from "./events.js";
import { Id, IsoDate, RunStatus } from "./ids.js";
import {
  IntegrationProviderConfigSchema,
  IntegrationSetupStateSchema,
} from "./integration-settings.js";
import { McpOAuthConfigInput } from "./mcp.js";
import { MessageReactionSchema } from "./reactions.js";
import {
  ConfirmRecruitingBriefInput,
  CreateRecruitingCandidateNoteInput,
  CreateRecruitingReminderInput,
  CreateRecruitingRoleInput,
  DeleteRecruitingCandidateNoteInput,
  DeleteRecruitingReminderInput,
  EditRecruitingCriteriaInput,
  ListRecruitingCandidateNotesInput,
  ListRecruitingCandidateNotesOutput,
  ListRecruitingCandidateSourcesInput,
  ListRecruitingCandidateSourcesOutput,
  ListRecruitingCandidatesInput,
  ListRecruitingCandidatesOutput,
  ListRecruitingFeedbackInput,
  ListRecruitingFeedbackOutput,
  ListRecruitingRemindersInput,
  ListRecruitingRemindersOutput,
  ReadRecruitingSourceInput,
  ReadRecruitingViewInput,
  RecordRecruitingProfileViewInput,
  RecruitingAssessmentAskTargetSchema,
  RecruitingAssessmentSchema,
  RecruitingCalibrationRoundOutput,
  RecruitingCandidateFeedbackSelectionSchema,
  RecruitingCandidateNoteSchema,
  RecruitingCandidateReportSchema,
  RecruitingChatContextSchema,
  RecruitingCorrespondenceInputPage,
  RecruitingCorrespondenceReferenceSchema,
  RecruitingCorrespondenceSchema,
  RecruitingCrmDataInputSchema,
  RecruitingCrmDataOutputSchema,
  RecruitingCrmSyncInputFields,
  RecruitingCrmSyncOutputSchema,
  RecruitingId,
  RecruitingProfileActivityInput,
  RecruitingProfileActivityOutput,
  RecruitingProfileViewSchema,
  RecruitingReminderSchema,
  RecruitingResearchActionSchema,
  RecruitingResearchSavedObservationSchema,
  RecruitingResearchTaskSchema,
  RecruitingRoleCampaignSchema,
  RecruitingRoleCandidatesInputFields,
  RecruitingRoleCandidatesOutputSchema,
  RecruitingRoleRevisionSchema,
  RecruitingRoleSchema,
  RecruitingRoleSetupSchema,
  ReviseRecruitingRoleInput,
  SetRecruitingCandidateShortlistInput,
  SetRecruitingCandidateShortlistOutput,
  UpdateRecruitingCandidateNoteInput,
  UpdateRecruitingReminderInput,
} from "./recruiting.js";
import { RecruitingCrmRoleReferenceSchema } from "./recruiting-crm.js";
import {
  RecruitingSchedulingPlanInputSchema,
  RecruitingSchedulingPlanSchema,
  RecruitingSchedulingSlotSchema,
} from "./recruiting-scheduling.js";
import { RoutineHistorySchema, RoutineRunCursorSchema, RunsListOutputSchema } from "./runs.js";
import { SearchQueryOutputSchema } from "./search.js";

const listPageFields = { offset: z.number().int().min(0).max(1000000).optional() };

const sidebarPage = z.object({
  offset: z.number().int().min(0).default(0),
  archived: z.boolean().default(false),
});

const botId = z.object({ botId: Id });
const groupId = z.object({ groupId: Id });
const recruitingWorkspace = z.strictObject({
  role: RecruitingRoleSchema,
  revision: RecruitingRoleRevisionSchema,
});
export const RecruitingAssessmentSnapshotSchema = z
  .strictObject({
    assessment: RecruitingAssessmentSchema,
    roleRevision: RecruitingRoleRevisionSchema,
    isCurrent: z.boolean(),
    sourceMessageTargets: z.array(
      z.strictObject({
        messageId: Id,
        threadId: Id,
        target: z.union([z.strictObject({ botId: Id }), z.strictObject({ groupId: Id })]),
      }),
    ),
  })
  .refine(
    (snapshot) =>
      snapshot.roleRevision.id === snapshot.assessment.roleRevisionId &&
      snapshot.roleRevision.roleId === snapshot.assessment.roleId,
    {
      message: "Assessment role revision must match its saved snapshot",
      path: ["roleRevision"],
    },
  );
export type RecruitingAssessmentSnapshot = z.infer<typeof RecruitingAssessmentSnapshotSchema>;

export const RecruitingQuestionSchema = z.strictObject({
  effectId: RecruitingId,
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  target: RecruitingAssessmentAskTargetSchema,
  threadId: Id,
  botId: Id,
  groupId: Id.nullable(),
  runId: Id,
  messageId: Id,
  askIndex: z.number().int().nonnegative(),
  block: AskBlockSchema,
  runStatus: RunStatus,
  isCurrent: z.boolean(),
  canAnswer: z.boolean(),
});
export type RecruitingQuestion = z.infer<typeof RecruitingQuestionSchema>;

const threadTarget = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });

const structuredMentionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: Id }),
  z.object({ kind: z.literal("group"), id: Id }),
  z.object({ kind: z.literal("routine"), id: Id }),
  z.object({ kind: z.literal("connector"), id: Id }),
]);

const threadSendInput = threadTarget
  .safeExtend({
    text: z.string().optional(),
    correspondenceReference: RecruitingCorrespondenceReferenceSchema.optional(),
    recruitingContext: RecruitingChatContextSchema.optional(),
    artifactIds: z.array(Id).max(ATTACHMENT_MAX_COUNT).optional(),
    addressing: z.enum(["coordinator", "mentions"]).optional(),
    /** Bare bot ids (legacy) or typed mention chips from the composer. */
    mentions: z
      .array(z.union([Id, structuredMentionTarget]))
      .max(64)
      .optional(),
    replyToMessageId: Id.optional(),
    replyQuote: z.string().trim().min(1).max(REPLY_QUOTE_MAX_LENGTH).optional(),
    clientNonce: z.string().min(1).max(200).optional(),
    /** Interject: interrupt the bot's live reply with this message instead of waiting for it. */
    interrupt: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.addressing && !input.groupId) {
      ctx.addIssue({
        code: "custom",
        message: "Addressing mode requires a group",
        path: ["addressing"],
      });
    }
    const text = input.text?.trim() ?? "";
    const artifactIds = input.artifactIds ?? [];
    if (!text && artifactIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Provide text or at least one attachment",
        path: ["text"],
      });
    }
    if (input.replyQuote && !input.replyToMessageId) {
      ctx.addIssue({
        code: "custom",
        message: "replyQuote requires replyToMessageId",
        path: ["replyQuote"],
      });
    }
  });

const spaceName = z.string().trim().min(1).max(60);

export const SIDEBAR_PREVIEW_MAX_LENGTH = 120;
/** One sidebar frame: a bot's busy state, unread flag and redacted preview as of `updatedAt`. */
export const SidebarBotStateSchema = z.object({
  botId: Id.optional(),
  status: z.enum(["idle", "queued", "running", "waiting"]).optional(),
  unread: z.boolean().optional(),
  preview: z.string().max(SIDEBAR_PREVIEW_MAX_LENGTH).optional(),
  updatedAt: IsoDate,
});
export type SidebarBotState = z.infer<typeof SidebarBotStateSchema>;

export const appContract = {
  aiConsent: {
    status: oc.input(AiConsentQuerySchema).output(AiConsentStatusSchema),
    allow: oc
      .input(
        z.object({
          scope: z.string(),
          version: z.string(),
          keys: z.array(z.string()).min(1).max(200),
        }),
      )
      .output(AiConsentStatusSchema),
    revoke: oc.input(z.object({ key: z.string().nullable() })).output(AiConsentStatusSchema),
  },
  health: oc.output(z.object({ ok: z.literal(true), version: z.string() })),
  me: oc.output(MeSchema),
  billing: {
    status: oc.output(BillingStatusSchema),
    checkout: oc.output(z.object({ url: z.string().url() })),
    portal: oc.output(z.object({ url: z.string().url() })),
  },
  preferences: {
    update: oc.input(z.object({ avatarStyle: AvatarStyleSchema })).output(MeSchema),
  },
  spaces: {
    list: oc
      .input(z.object({ offset: z.number().int().min(0).max(1000000).optional() }).optional())
      .output(SpaceNavigationSchema),
    /**
     * Sidebar live state for the caller's own bots in the current space. Opens with every bot's
     * current state (durable rows, not replayed events), then one frame per change; a frame
     * without `botId` is a liveness heartbeat. A `botId` the client does not know means the
     * roster changed: refetch `spaces.list`.
     */
    subscribe: oc
      .input(z.object({ since: IsoDate.optional() }))
      .output(eventIterator(SidebarBotStateSchema)),
    create: oc.input(z.object({ name: spaceName })).output(SpaceSchema),
    rename: oc
      .input(z.object({ spaceId: Id, name: spaceName }))
      .output(z.object({ id: Id, name: z.string() })),
    remove: oc
      .input(z.object({ spaceId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
  },
  bootstrap: oc
    .input(
      z
        .object({
          botId: Id.optional(),
          groupId: Id.optional(),
          offset: z.number().int().min(0).max(1000000).optional(),
        })
        .refine((input) => !(input.botId && input.groupId), {
          message: "Provide at most one of botId or groupId",
          path: ["botId"],
        }),
    )
    .output(AppBootstrapSchema),
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
          computerHost: z.enum(["docker", "this-mac"]).nullable().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
    /** The owner adds an allowlisted person directly when the deployment cannot send email. */
    createAccount: oc
      .input(
        z.object({
          email: z.string().email().max(320),
          name: z.string().max(200).default(""),
          password: z.string().min(12).max(128),
        }),
      )
      .output(z.object({ userId: Id })),
  },
  /**
   * Deployment-owner product updates. When the Compose updater sidecar is reachable, these proxy
   * to its `/state` `/plan` `/apply` contract. Rollback stays on the sidecar for ops only and is
   * not exposed here. Never git-fetch from the API process.
   */
  updater: {
    status: oc.output(ServerUpdateStatusSchema),
    check: oc.input(ServerUpdateRequestSchema).output(ServerUpdateCheckSchema),
    apply: oc.input(ServerUpdateRequestSchema).output(ServerUpdateRunSchema),
  },
  models: {
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(ModelCatalogEntrySchema)),
    credentials: oc
      .input(z.object(listPageFields).nullish())
      .output(z.array(ModelCredentialSchema)),
    backups: oc.input(z.object(listPageFields).nullish()).output(z.array(ModelBackupChoiceSchema)),
    setBackups: oc.input(ModelBackupListSchema).output(z.object({ ok: z.literal(true) })),
    connect: oc.input(ModelConnectInputSchema).output(ModelCredentialSchema),
    probeOpenAiCompatible: oc
      .input(
        z.object({
          baseUrl: z.string(),
          apiKey: z.string().optional(),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    probeCatalog: oc
      .input(
        z.object({
          provider: z.string().trim().min(1),
          apiKey: z.string().trim().min(8),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    beginOAuth: oc
      .input(
        z.object({
          provider: z.string(),
          label: z.string().optional(),
          modelId: z.string().optional(),
          thinkingLevel: ThinkingLevelSchema.nullable().optional(),
        }),
      )
      .output(ModelOAuthBeginSchema),
    submitOAuthCode: oc
      .input(z.object({ loginId: z.string(), code: z.string().trim().min(1).max(8_192) }))
      .output(z.object({ ok: z.literal(true) })),
    completeOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("pending") }),
          z.object({ status: z.literal("ready") }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      ),
    finishOAuth: oc.input(z.object({ loginId: z.string() })).output(ModelCredentialSchema),
    cancelOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    setDefault: oc
      .input(
        z.object({
          provider: z.string(),
          modelId: z.string(),
          thinkingLevel: ThinkingLevelSchema.nullable().optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    disconnect: oc
      .input(z.object({ provider: z.string().trim().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  bots: {
    page: oc
      .input(sidebarPage)
      .output(
        z.object({ items: z.array(BotSchema).max(200), nextOffset: z.number().int().nullable() }),
      ),
    list: oc.output(z.array(BotSchema).max(200)),
    listArchived: oc.output(z.array(BotSchema).max(200)),
    get: oc.input(botId).output(BotSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    duplicate: oc.input(botId).output(BotSchema),
    reorder: oc.input(ReorderBotsInput).output(z.object({ ok: z.literal(true) })),
    update: oc.input(UpdateBotInput).output(BotSchema),
    setComputer: oc.input(z.object({ botId: Id, mode: ComputerModeSchema })).output(BotSchema),
    archive: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    remove: oc
      .input(z.object({ botId: Id, deleteMemories: z.boolean().default(false) }))
      .output(z.object({ ok: z.literal(true) })),
    rotateWebhookSecret: oc.input(botId).output(
      z.object({
        secret: z.string(),
        path: z.string(),
        webhookConfigured: z.literal(true),
      }),
    ),
  },
  groups: {
    create: oc.input(CreateGroupInput).output(GroupSchema),
    page: oc
      .input(sidebarPage)
      .output(
        z.object({ items: z.array(GroupSchema).max(200), nextOffset: z.number().int().nullable() }),
      ),
    list: oc.output(z.array(GroupSchema).max(200)),
    listArchived: oc.output(z.array(GroupSchema).max(200)),
    get: oc.input(groupId).output(GroupDetailSchema),
    duplicate: oc.input(groupId).output(GroupSchema),
    update: oc.input(UpdateGroupInput).output(GroupSchema),
    archive: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    remove: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
  },
  botSections: {
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(BotSectionSchema)),
    create: oc
      .input(threadTarget.safeExtend({ name: z.string().trim().min(1).max(60) }))
      .output(BotSectionSchema),
    update: oc
      .input(z.object({ sectionId: Id, name: z.string().trim().min(1).max(60) }))
      .output(BotSectionSchema),
  },
  threads: {
    head: oc.input(threadTarget).output(
      z.object({
        threadId: Id,
        cursor: z.number().int().min(-1),
      }),
    ),
    get: oc.input(threadTarget).output(ThreadSnapshotSchema),
    messages: oc
      .input(
        threadTarget.safeExtend({
          before: z.number().int().nonnegative().optional(),
          includePeerRuns: z.boolean().optional(),
          includePeerReceipts: z.boolean().optional(),
          around: z
            .object({
              messageId: Id.optional(),
              seq: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    subscribe: oc
      .input(threadTarget.safeExtend({ cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc.input(threadSendInput).output(
      z.object({
        taskId: Id,
        runId: Id,
        seq: z.number().int(),
        runIds: z.array(Id).optional(),
      }),
    ),
    react: oc
      .input(
        threadTarget.safeExtend({
          messageId: Id,
          reaction: MessageReactionSchema,
          clientNonce: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    stop: oc
      .input(threadTarget.safeExtend({ runId: Id.optional() }))
      .output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(
        threadTarget.safeExtend({
          text: z.string().min(1),
          artifactIds: z.array(Id).max(ATTACHMENT_MAX_COUNT).optional(),
          recruitingFeedback: RecruitingCandidateFeedbackSelectionSchema.optional(),
          crmRoleReference: RecruitingCrmRoleReferenceSchema.optional(),
          recruitingContext: RecruitingChatContextSchema.optional(),
          mentions: z.array(Id).max(64).optional(),
          /** Carries the call id, so a turn taken mid-run stays in the call's card. */
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** The client hung up: close the call card and let the bot finish what was asked on it. */
    endCall: oc
      // ":" separates the call id from the nonce suffix, so it can never appear inside one.
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    clear: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(
        threadTarget.safeExtend({
          runId: Id,
          messageId: Id,
          answer: AskAnswerSchema,
          /** Carries the call id for an answer spoken during a call. */
          clientNonce: z.string().min(1).max(200).optional(),
          /** Only for a login card; `answer` carries its password. */
          username: z.string().min(1).max(512).optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    markRead: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    markUnread: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
  },
  computer: {
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    recover: oc.input(botId).output(ComputerUpdateSchema),
    reset: oc.input(botId).output(ComputerStatusSchema),
    update: oc.input(botId).output(ComputerUpdateSchema),
    updates: oc.input(z.object(listPageFields).nullish()).output(z.array(ComputerUpdateSchema)),
    releaseInterrupted: oc
      .input(z.object({ id: Id, workersStopped: z.literal(true) }))
      .output(z.object({ ok: z.literal(true) })),
    dismissUpdate: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc
      .input(
        z.object({
          botId: Id,
          reason: ComputerReleaseReasonSchema.optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard", "scroll"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    files: oc
      .input(z.object({ botId: Id, path: z.string().default("/") }))
      .output(
        z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), size: z.number() })),
      ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    downloadFile: oc
      .input(z.object({ botId: Id, path: z.string().min(1) }))
      .output(z.object({ path: z.string(), contentBase64: z.string() })),
    uploadFile: oc
      .input(
        z.object({
          botId: Id,
          path: z.string().min(1),
          contentBase64: z.string().max(ATTACHMENT_MAX_BASE64_LENGTH),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    terminalUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    commands: oc
      .input(botId)
      .output(z.array(ComputerCommandSchema.extend({ createdAt: z.string() }))),
    screenUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    heartbeat: oc.input(botId).output(z.object({ ok: z.literal(true) })),
  },
  recruiting: {
    profileActivity: {
      list: oc.input(RecruitingProfileActivityInput).output(RecruitingProfileActivityOutput),
      recordView: oc.input(RecordRecruitingProfileViewInput).output(RecruitingProfileViewSchema),
    },
    crmData: oc
      .input(z.intersection(threadTarget, RecruitingCrmDataInputSchema))
      .output(RecruitingCrmDataOutputSchema),
    schedulingPlans: oc.input(z.object({ threadId: Id }).safeExtend(listPageFields)).output(
      z.object({
        plans: z.array(RecruitingSchedulingPlanSchema),
        slots: z.array(RecruitingSchedulingSlotSchema.safeExtend({ observedAt: IsoDate })),
        partial: z.boolean(),
      }),
    ),
    saveSchedulingPlan: oc
      .input(RecruitingSchedulingPlanInputSchema)
      .output(RecruitingSchedulingPlanSchema),
    correspondence: oc
      .input(
        threadTarget.safeExtend({
          view: z.enum(["inbox", "interview", "contacts"]),
          ...RecruitingCorrespondenceInputPage,
        }),
      )
      .output(RecruitingCorrespondenceSchema),
    roleCampaign: oc
      .input(
        threadTarget.and(
          z
            .object({
              campaignId: Id.optional(),
              campaignOffset: z.number().int().min(0).max(1_000_000).optional(),
            })
            .refine(
              (input) => input.campaignOffset === undefined || input.campaignId !== undefined,
              "Campaign offset requires an exact campaign selection",
            ),
        ),
      )
      .output(RecruitingRoleCampaignSchema),
    roleSetup: oc.input(threadTarget).output(RecruitingRoleSetupSchema),
    /** The latest calibration review round of the thread's role (the ten people it showed). */
    calibrationRound: oc.input(threadTarget).output(RecruitingCalibrationRoundOutput),
    /** The recruiter accepts that round; the role moves on to finding more people. */
    approveCalibrationRound: oc
      .input(threadTarget.safeExtend({ round: z.number().int().positive() }))
      .output(z.strictObject({ round: z.number().int().positive(), approvedAt: IsoDate })),
    listFeedback: oc.input(ListRecruitingFeedbackInput).output(ListRecruitingFeedbackOutput),
    readSource: oc.input(ReadRecruitingSourceInput).output(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("text"),
          text: z.string(),
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
        }),
        z.strictObject({ kind: z.literal("report"), report: RecruitingCandidateReportSchema }),
      ]),
    ),
    listCandidates: oc.input(ListRecruitingCandidatesInput).output(ListRecruitingCandidatesOutput),
    readView: oc
      .input(ReadRecruitingViewInput)
      .output(
        z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("candidates"),
            workspace: recruitingWorkspace
              .extend({ crmTarget: ListRecruitingCandidatesOutput.shape.crmTarget })
              .nullable(),
            data: ListRecruitingCandidatesOutput.nullable(),
          }),
          z.strictObject({
            kind: z.literal("research"),
            workspace: recruitingWorkspace
              .extend({ crmTarget: ListRecruitingCandidatesOutput.shape.crmTarget })
              .nullable(),
            data: z
              .strictObject({
                tasks: z.array(RecruitingResearchTaskSchema),
                actions: z.array(RecruitingResearchActionSchema),
                observations: z.array(RecruitingResearchSavedObservationSchema),
              })
              .nullable(),
          }),
        ]),
      ),

    roleCandidates: oc
      .input(threadTarget.safeExtend(RecruitingRoleCandidatesInputFields))
      .output(RecruitingRoleCandidatesOutputSchema),
    crmSync: oc
      .input(threadTarget.safeExtend(RecruitingCrmSyncInputFields))
      .output(RecruitingCrmSyncOutputSchema),
    listCandidateSources: oc
      .input(ListRecruitingCandidateSourcesInput)
      .output(ListRecruitingCandidateSourcesOutput),
    setCandidateShortlist: oc
      .input(SetRecruitingCandidateShortlistInput)
      .output(SetRecruitingCandidateShortlistOutput),
    listQuestions: oc
      .input(z.strictObject({ threadId: Id, roleId: RecruitingId }).safeExtend(listPageFields))
      .output(z.strictObject({ questions: z.array(RecruitingQuestionSchema) })),
    createRole: oc.input(CreateRecruitingRoleInput).output(recruitingWorkspace),
    bindRole: oc
      .input(z.strictObject({ threadId: RecruitingId, roleId: RecruitingId.nullable() }))
      .output(recruitingWorkspace.nullable()),
    getWorkspace: oc
      .input(z.strictObject({ threadId: RecruitingId }))
      .output(
        recruitingWorkspace
          .extend({ crmTarget: ListRecruitingCandidatesOutput.shape.crmTarget })
          .nullable(),
      ),
    reviseRole: oc.input(ReviseRecruitingRoleInput).output(recruitingWorkspace),
    archiveRole: oc
      .input(
        z.strictObject({
          roleId: RecruitingId,
          expectedRevision: z.number().int().min(1),
          archived: z.boolean(),
          force: z.boolean().optional(),
        }),
      )
      .output(recruitingWorkspace),
    reminders: {
      list: oc.input(ListRecruitingRemindersInput).output(ListRecruitingRemindersOutput),
      create: oc.input(CreateRecruitingReminderInput).output(RecruitingReminderSchema),
      update: oc.input(UpdateRecruitingReminderInput).output(RecruitingReminderSchema),
      delete: oc
        .input(DeleteRecruitingReminderInput)
        .output(z.strictObject({ ok: z.literal(true) })),
    },
    notes: {
      list: oc.input(ListRecruitingCandidateNotesInput).output(ListRecruitingCandidateNotesOutput),
      create: oc.input(CreateRecruitingCandidateNoteInput).output(RecruitingCandidateNoteSchema),
      update: oc.input(UpdateRecruitingCandidateNoteInput).output(RecruitingCandidateNoteSchema),
      delete: oc
        .input(DeleteRecruitingCandidateNoteInput)
        .output(z.strictObject({ ok: z.literal(true) })),
    },
    confirmBrief: oc.input(ConfirmRecruitingBriefInput).output(recruitingWorkspace),
    editCriteria: oc.input(EditRecruitingCriteriaInput).output(recruitingWorkspace),
    listAssessments: oc
      .input(z.strictObject({ roleId: RecruitingId }).safeExtend(listPageFields))
      .output(z.array(RecruitingAssessmentSnapshotSchema)),
    getAssessment: oc
      .input(
        z.strictObject({
          roleId: RecruitingId,
          candidateKey: RecruitingId,
          version: z.number().int().positive().optional(),
        }),
      )
      .output(RecruitingAssessmentSnapshotSchema.nullable()),
    listResearch: oc
      .input(z.strictObject({ roleId: RecruitingId }).safeExtend(listPageFields))
      .output(
        z.strictObject({
          tasks: z.array(RecruitingResearchTaskSchema),
          actions: z.array(RecruitingResearchActionSchema),
          observations: z.array(RecruitingResearchSavedObservationSchema),
        }),
      ),
  },
  memory: {
    list: oc
      .input(
        z
          .object({ botId: Id.optional(), scope: z.enum(["bot", "user"]).optional() })
          .safeExtend(listPageFields),
      )
      .output(z.array(MemoryDocumentSchema)),
    update: oc
      .input(
        z.object({
          documentId: Id,
          content: z.string(),
          expectedRevision: z.number().int().nonnegative(),
        }),
      )
      .output(MemoryDocumentSchema),
    history: oc
      .input(z.object({ documentId: Id }).safeExtend(listPageFields))
      .output(z.array(MemoryRevisionSchema)),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
    providerConfig: oc.output(SpaceMemoryConfigSchema.nullable()),
    connectProvider: oc
      .input(
        z.object({
          provider: z.string().min(1),
          settings: z.record(z.string(), z.string()),
          credentials: z.record(z.string(), z.string()),
          defaultMemoryScope: MemoryScopeSchema.default("isolated"),
        }),
      )
      .output(SpaceMemoryConfigSchema),
    setDefaultScope: oc
      .input(z.object({ defaultMemoryScope: MemoryScopeSchema }))
      .output(SpaceMemoryConfigSchema),
    disconnectProvider: oc.output(z.object({ ok: z.literal(true) })),
  },
  routines: {
    list: oc.input(botId.safeExtend(listPageFields)).output(z.array(RoutineSchema)),
    history: oc
      .input(z.object({ routineId: Id, before: RoutineRunCursorSchema.optional() }))
      .output(RoutineHistorySchema),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc.input(UpdateRoutineInput).output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc
      .input(
        z.object({
          routineId: Id,
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ runId: Id })),
  },
  scratchpad: {
    list: oc
      .input(
        z
          .object({
            botId: Id,
            status: ScratchpadItemStatusSchema.optional(),
            includeDone: z.boolean().optional(),
          })
          .safeExtend(listPageFields),
      )
      .output(z.array(ScratchpadItemSchema)),
    create: oc.input(CreateScratchpadItemInput).output(ScratchpadItemSchema),
    update: oc
      .input(
        z.object({
          itemId: Id,
          title: z.string().min(1).max(200).optional(),
          status: ScratchpadItemStatusSchema.optional(),
          notes: z.string().max(4_000).optional(),
        }),
      )
      .output(ScratchpadItemSchema),
    remove: oc.input(z.object({ itemId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  boards: {
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(BoardSchema)),
    get: oc.output(BoardSchema),
    rename: oc.input(RenameBoardInput).output(BoardSchema),
    subscribe: oc.output(eventIterator(BoardEventSchema)),
  },
  tickets: {
    list: oc.input(ListTicketsInput.safeExtend(listPageFields)).output(ListTicketsOutput),
    get: oc.input(GetTicketInput).output(TicketSchema),
    create: oc.input(CreateTicketInput).output(TicketSchema),
    update: oc.input(UpdateTicketInput).output(TicketSchema),
    move: oc.input(MoveTicketInput).output(TicketSchema),
    comment: oc.input(CommentTicketInput).output(TicketCommentSchema),
    comments: oc
      .input(z.object({ ticketId: Id }).safeExtend(listPageFields))
      .output(z.array(TicketCommentSchema)),
  },
  skills: {
    list: oc.input(botId.safeExtend(listPageFields)).output(z.array(TaughtSkillSchema)),
    get: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    start: oc
      .input(z.object({ botId: Id, goal: z.string().min(1).max(4000) }))
      .output(TaughtSkillSchema),
    appendEvent: oc
      .input(z.object({ skillId: Id, event: TeachRecordingEventSchema }))
      .output(TaughtSkillSchema),
    snapshot: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    stop: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    updateDraft: oc
      .input(
        z.object({
          skillId: Id,
          name: z.string().optional(),
          playbook: SkillPlaybookSchema,
        }),
      )
      .output(TaughtSkillSchema),
    save: oc
      .input(z.object({ skillId: Id, name: z.string().optional() }))
      .output(TaughtSkillSchema),
    testRun: oc
      .input(z.object({ skillId: Id, prompt: z.string().optional() }))
      .output(z.object({ runId: Id })),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Claude Agent Skills (SKILL.md recipes) shared across assistants (not taught/demo skills). Pi already understands this format; we persist and inject them. */
  agentSkills: {
    list: oc
      .input(z.object(listPageFields).nullish())
      .output(z.array(AgentSkillCatalogEntrySchema)),
    get: oc
      .input(
        z
          .object({ skillId: Id.optional(), name: z.string().min(1).max(80).optional() })
          .superRefine((input, ctx) => {
            if (!input.skillId && !input.name?.trim()) {
              ctx.addIssue({
                code: "custom",
                message: "Provide skillId or name",
                path: ["skillId"],
              });
            }
          }),
      )
      .output(AgentSkillSchema),
    create: oc.input(CreateAgentSkillInput).output(AgentSkillSchema),
    update: oc.input(UpdateAgentSkillInput).output(AgentSkillSchema),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  capabilities: {
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(CapabilityInstallSchema)),
    catalogSearch: oc
      .input(
        z.object({
          query: z.string().trim().max(253).default(""),
          usePublicCatalog: z.boolean().default(false),
        }),
      )
      .output(
        z.object({
          enabled: z.boolean(),
          results: z.array(IntegrationCatalogResultSchema),
        }),
      ),
    install: oc
      .input(
        z.object({
          kind: z.enum(["skill", "plugin", "mcp", "api", "graphql"]),
          name: z.string().min(1).max(120),
          source: z.string().min(1).max(2048),
          config: z.record(z.string(), z.unknown()).default({}),
          credential: z.string().max(16_384).optional(),
        }),
      )
      .output(CapabilityInstallSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  mcp: {
    servers: {
      list: oc.input(z.object(listPageFields).nullish()).output(z.array(McpServerSchema)),
      create: oc.input(McpServerConfigInput).output(McpServerSchema),
      update: oc
        .input(
          z.union([
            z.object({ id: Id, config: McpServerConfigInput }),
            z.object({ id: Id, secret: z.string().min(1).max(16384) }),
          ]),
        )
        .output(McpServerSchema),
      remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    },
    assignments: {
      list: oc.input(botId.safeExtend(listPageFields)).output(z.array(BotMcpServerSchema)),
      all: oc.input(z.object(listPageFields).nullish()).output(z.array(BotMcpServerSchema)),
      approve: oc
        .input(
          z.object({
            botId: Id,
            serverId: Id,
            threadId: Id.optional(),
            allowedTools: z.array(z.string().min(1).max(200)).max(500).optional(),
          }),
        )
        .output(BotMcpServerSchema),
      dismiss: oc
        .input(z.object({ botId: Id, serverId: Id, threadId: Id.optional() }))
        .output(z.object({ ok: z.literal(true) })),
      replace: oc
        .input(
          z.object({
            botId: Id,
            assignments: z.array(
              z.object({
                serverId: Id,
                allowAllTools: z.boolean().default(true),
                allowedTools: z.array(z.string().min(1).max(200)).max(500).default([]),
              }),
            ),
          }),
        )
        .output(z.array(BotMcpServerSchema)),
    },
    oauth: {
      begin: oc
        .input(
          z.object({
            serverId: Id,
            redirectUri: z.string().url(),
            oauth: McpOAuthConfigInput.optional(),
          }),
        )
        .output(
          z.discriminatedUnion("status", [
            z.object({
              status: z.literal("authorization_required"),
              sessionId: Id,
              authorizationUrl: z.string().url(),
            }),
            z.object({
              status: z.enum([
                "already_connected",
                "authorization_not_requested",
                "product_sign_in_required",
              ]),
            }),
          ]),
        ),
      complete: oc
        .input(
          z.object({
            sessionId: Id,
            code: z.string().min(1),
            state: z.string().min(1),
            iss: z.string().min(1).optional(),
          }),
        )
        .output(z.object({ ok: z.literal(true) })),
      disconnect: oc.input(z.object({ serverId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  onboarding: {
    ensureRecruiting: oc.input(z.object({})).output(z.object({ botId: Id, groupId: Id })),
    /** Seed the first-run greeting into the bot's thread (focus card is separate). */
    start: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Post the focus choice card when the thread is still idle. */
    promptFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Answer the focus choice; posts the app cards. Does not rename the bot. */
    choose: oc
      .input(z.object({ botId: Id, optionId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Dismiss the unanswered focus card without choosing an option. */
    dismissFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Flip an app_connect card to connected after authorization completes. */
    appConnected: oc
      .input(
        z.object({ botId: Id, provider: z.string(), connectorId: z.string().default("composio") }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  integrationSetup: {
    get: oc.output(IntegrationSetupStateSchema),
    save: oc.input(IntegrationProviderConfigSchema).output(z.object({ ok: z.literal(true) })),
  },
  connections: {
    catalog: oc
      .input(
        z
          .object({ query: z.string().optional(), connectorId: z.string().optional() })
          .safeExtend(listPageFields),
      )
      .output(z.array(ConnectionCatalogItemSchema)),
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(ConnectionSchema)),
    begin: oc
      .input(
        z.object({
          connectorId: z.string().default("composio"),
          provider: z.string(),
          displayName: z.string(),
        }),
      )
      .output(z.object({ connectionId: Id, authorizationUrl: z.string().nullable() })),
    complete: oc
      .input(z.object({ connectionId: Id, code: z.string().optional() }))
      .output(ConnectionSchema),
    rename: oc
      .input(z.object({ connectionId: Id, displayName: z.string().trim().min(1).max(80) }))
      .output(ConnectionSchema),
    revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Tools the connected provider exposes. Read-only; no per-tool allowlist yet. */
    tools: oc
      .input(z.object({ connectorId: z.string(), provider: z.string() }).safeExtend(listPageFields))
      .output(
        z.array(
          z.object({
            name: z.string(),
            description: z.string(),
          }),
        ),
      ),
  },
  /** External messaging surface: link state, group channels, agent connections. */
  messaging: {
    status: oc.output(MessagingStatusSchema),
    link: {
      /** Issue a short-lived code the user sends to the line from a chat app. */
      start: oc
        .input(z.object({ botId: Id }))
        .output(z.object({ code: z.string(), expiresAt: z.string() })),
    },
    identities: {
      setBot: oc
        .input(z.object({ identityId: Id, botId: Id }))
        .output(MessagingLinkedIdentitySchema),
      unlink: oc.input(z.object({ identityId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    channels: {
      list: oc
        .input(z.object(listPageFields).nullish())
        .output(z.array(MessagingChannelMembershipSchema)),
      // Addressed by membership, not channel: one user can have two linked
      // chat apps in the same group, and each answers for its own agent.
      respond: oc
        .input(z.object({ membershipId: Id, accept: z.boolean() }))
        .output(MessagingChannelMembershipSchema),
      leave: oc.input(z.object({ membershipId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    connections: {
      list: oc
        .input(z.object(listPageFields).nullish())
        .output(z.array(MessagingAgentConnectionSchema)),
      respond: oc
        .input(z.object({ connectionId: Id, accept: z.boolean() }))
        .output(MessagingAgentConnectionSchema),
      revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  approvalRules: {
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(ActionApprovalRuleSchema)),
    set: oc
      .input(
        z.object({
          effect: z.enum(["always_allow", "require_approval"]),
          matchKind: z.enum(["tool", "connector", "category"]),
          matchValue: z.string().min(1),
        }),
      )
      .output(ActionApprovalRuleSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  autoReview: {
    get: oc.output(ActionAutoReviewSettingsSchema),
    set: oc.input(z.object({ enabled: z.boolean() })).output(ActionAutoReviewSettingsSchema),
  },
  artifacts: {
    list: oc
      .input(
        botId.extend({ includeDiagnostics: z.boolean().optional() }).safeExtend(listPageFields),
      )
      .output(z.array(ArtifactSchema)),
    listSpace: oc
      .input(
        z.object({
          botId: Id.optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(60).optional(),
          includeDiagnostics: z.boolean().optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(ArtifactSchema.extend({ versionCount: z.number().int() })),
          nextCursor: z.string().nullable(),
        }),
      ),
    listVersions: oc
      .input(
        z
          .object({ familyId: Id, includeDiagnostics: z.boolean().optional() })
          .safeExtend(listPageFields),
      )
      .output(z.array(ArtifactVersionSchema)),
    create: oc
      .input(
        threadTarget.and(
          z.object({
            name: z.string().min(1).max(ARTIFACT_NAME_MAX_LENGTH),
            description: z.string().max(ARTIFACT_DESCRIPTION_MAX_LENGTH).optional(),
            mimeType: z.string().min(1),
            contentBase64: z.string().min(1).max(ATTACHMENT_MAX_BASE64_LENGTH),
            /** Unique per upload; a retry with the same nonce returns the artifact it created. */
            clientNonce: z.string().min(1).max(200).optional(),
          }),
        ),
      )
      .output(ArtifactSchema),
    get: oc
      .input(
        threadTarget.and(z.object({ artifactId: Id, includeDiagnostics: z.boolean().optional() })),
      )
      .output(ArtifactWithContentSchema),
    getById: oc
      .input(z.object({ artifactId: Id, includeDiagnostics: z.boolean().optional() }))
      .output(ArtifactWithContentSchema),
    remove: oc.input(z.object({ artifactId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  usage: {
    list: oc.output(z.array(UsageRecordSchema)),
    summary: oc.output(
      z.object({
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        totalTokens: z.number().nullable().optional(),
        modelCalls: z.number().optional(),
        runs: z.number(),
      }),
    ),
    costs: oc.output(UsageCostsSchema),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
  },
  notifications: {
    registerPush: oc
      // No whitespace: the token store keeps the registering session on the next line.
      .input(z.object({ token: z.string().min(8).max(512).regex(/^\S+$/) }))
      .output(z.object({ ok: z.literal(true) })),
    unregisterPush: oc.output(z.object({ ok: z.literal(true) })),
  },
  search: {
    query: oc.input(z.object({ q: z.string().max(200) })).output(SearchQueryOutputSchema),
  },
  links: {
    /**
     * The site icon for a link's origin as a small data URL, resolved and cached by the server.
     * `retry` means the server was too busy to look; the origin may still have an icon.
     */
    favicon: oc
      // The longest origin: a scheme, a 253-character host name and a port.
      .input(z.object({ origin: z.string().max("https://".length + 253 + ":65535".length) }))
      .output(z.object({ icon: z.string().nullable(), retry: z.boolean().optional() })),
  },
  runs: {
    list: oc
      .input(z.object({ filter: z.enum(["active", "recent"]) }).safeExtend(listPageFields))
      .output(RunsListOutputSchema),
  },
  voice: {
    catalog: oc.input(z.object(listPageFields).nullish()).output(z.array(VoiceCatalogEntrySchema)),
    status: oc.output(VoiceStatusSchema),
    credentials: oc
      .input(z.object(listPageFields).nullish())
      .output(z.array(VoiceCredentialSchema)),
    connect: oc
      .input(
        z.object({
          provider: z.string(),
          apiKey: z.string().min(8),
          voiceId: z.string().max(120).optional(),
          speechModel: z.string().max(64).optional(),
        }),
      )
      .output(VoiceCredentialSchema),
    disconnect: oc
      .input(z.object({ provider: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    setVoice: oc
      .input(z.object({ voiceId: z.string().min(1).max(120), provider: z.string().optional() }))
      .output(VoiceStatusSchema),
    setSpeechModel: oc
      .input(z.object({ provider: z.string().min(1), speechModel: z.string().max(64) }))
      .output(VoiceCredentialSchema),
    voices: oc
      .input(z.object({ provider: z.string().optional() }).safeExtend(listPageFields))
      .output(z.array(VoiceInfoSchema)),
    prepare: oc
      .input(
        z.object({
          text: z.string().max(20000),
          voiceId: z.string().max(120).optional(),
          botId: Id.optional(),
        }),
      )
      .output(z.object({ ready: z.boolean(), utterances: z.array(z.string()) })),
  },
  externalConversations: {
    updatePolicy: oc
      .input(UpdateExternalConversationPolicyInput)
      .output(ExternalConversationPolicySchema),
  },
  agentSecrets: {
    list: oc.input(z.object(listPageFields).nullish()).output(z.array(AgentSecretSchema)),
    put: oc.input(AgentSecretInputSchema).output(AgentSecretSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  botSecrets: {
    list: oc
      .input(z.object({ botId: Id }).safeExtend(listPageFields))
      .output(z.array(BotSecretMetadata)),
    put: oc.input(BotSecretPutInput).output(BotSecretMetadata),
    remove: oc
      .input(z.object({ botId: Id, name: StoredBotSecretName }))
      .output(z.object({ ok: z.literal(true) })),
  },
};

export type AppContract = typeof appContract;
