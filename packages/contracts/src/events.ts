export * from "./computer-commands.js";

import { MessageRole, ReplyPreviewSchema } from "./thread-message-metadata.js";

export type { ReplyPreview } from "./thread-message-metadata.js";
export {
  canReactToThreadMessage,
  MessageRole,
  ReplyPreviewSchema,
} from "./thread-message-metadata.js";

import * as z from "zod";
import { botSecretDestinationSchema } from "./bot-secrets.js";
import { Id, IsoDate } from "./ids.js";
import { McpTransportSchema } from "./mcp.js";
import {
  RECRUITING_CANDIDATE_OUTPUT_SCHEMA,
  ReadRecruitingSourceInput,
  RecruitingActionDeliveryStateSchema,
  RecruitingArtifactRefSchema,
  RecruitingAssessmentAskTargetSchema,
  RecruitingCandidateFeedbackSelectionSchema,
  RecruitingChatContextSchema,
  RecruitingCorrespondenceReferenceSchema,
  RecruitingId,
  RecruitingProfileActivityInput,
} from "./recruiting.js";
import { RecruitingCrmRoleReferenceSchema } from "./recruiting-crm.js";

export const ProductEventType = z.enum([
  "thread.message.created",
  "thread.cleared",
  "thread.message.updated",
  "thread.message.reaction",
  "thread.progress",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "thread.subagent",
  "thread.cloud_agent",
  "thread.call.ended",
  "run.started",
  "run.requeued",
  "run.steering.claimed",
  "run.checkpointed",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.status",
  "computer.takeover.requested",
  "computer.takeover.granted",
  "computer.takeover.released",
  "computer.command",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "skill.teaching.started",
  "skill.teaching.stopped",
  "skill.draft.created",
  "skill.saved",
  "effect.recorded",
  "effect.approval.answered",
  "agent.tool.called",
  "agent.tool.completed",
  "effect.reconciled",
  "usage.recorded",
  "bot.spawned",
  "bot.updated",
  "bot.archived",
  "bot.deleted",
  "group.created",
  "group.updated",
  "group.handoff",
  "recruiting.changed",
  "recruiting.context.adopted",
  "recruiting.action.transitioned",
  "recruiting.read",
  "recruiting.candidates.saved",
  "recruiting.material.read",
  "recruiting.assessment.saved",
  "recruiting.question.asked",
  "recruiting.searches.planned",
  "recruiting.profile.viewed",
  /** Liveness only: never persisted, never applied to a snapshot, always seq 0. */
  "heartbeat",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

/**
 * Live working display timestamps, on thread.progress and run.completed payloads.
 * `activeSince`: when this attempt began executing on its worker. `resumedAt`: the same
 * instant when the run resumed after a restart or recovery, null when it never resumed.
 */
export const RunTimingSchema = z.object({
  activeSince: IsoDate.optional(),
  resumedAt: IsoDate.nullable().optional(),
});
export type RunTiming = z.infer<typeof RunTimingSchema>;

export const THREAD_PROGRESS_THOUGHT_MAX_CHARS = 200;
/** thread.progress payload: run timing plus one user-safe thinking line on phase "thinking". */
export const ThreadProgressPayloadSchema = RunTimingSchema.extend({
  thought: z.string().max(THREAD_PROGRESS_THOUGHT_MAX_CHARS).optional(),
});
export type ThreadProgressPayload = z.infer<typeof ThreadProgressPayloadSchema>;

export const RunCompletedPayloadSchema = RunTimingSchema.extend({
  startedAt: IsoDate.optional(),
  activeMs: z.number().int().nonnegative().optional(),
  steps: z.array(z.object({ category: z.string(), count: z.number().int().positive() })),
  /** Model calls retried after a stalled stream; absent when none were. */
  modelRetries: z.number().int().positive().optional(),
});
export type RunCompletedPayload = z.infer<typeof RunCompletedPayloadSchema>;

export const BotMessageIntent = z.enum(["request", "result", "question", "status", "fyi"]);
export type BotMessageIntent = z.infer<typeof BotMessageIntent>;

export const MAX_CHART_DATA_ROWS = 5_000;

const ChartSpec = z.record(z.string(), z.any());

function embeddedChartRowCount(spec: Record<string, unknown>): number {
  const specData = Array.isArray(spec.data) ? spec.data.length : 0;
  const markData = Array.isArray(spec.marks)
    ? spec.marks.reduce((total, mark) => {
        if (!mark || typeof mark !== "object" || !Array.isArray(mark.data)) return total;
        return total + mark.data.length;
      }, 0)
    : 0;
  return specData + markData;
}

const ChartBlock = z
  .object({
    kind: z.literal("chart"),
    name: z.string(),
    /** Declarative Observable Plot spec, validated by render_plot before publish.
        z.any keeps the inferred type JSON-assignable for persistence. */
    spec: ChartSpec,
    data: z.array(z.any()).max(MAX_CHART_DATA_ROWS),
  })
  .superRefine((block, ctx) => {
    if (block.data.length + embeddedChartRowCount(block.spec) <= MAX_CHART_DATA_ROWS) return;
    ctx.addIssue({
      code: "custom",
      message: `Chart data exceeds the ${MAX_CHART_DATA_ROWS.toLocaleString("en-US")}-row limit`,
    });
  });

export const SecretAskPurpose = z.enum(["otp", "password", "api_key"]);
export type SecretAskPurpose = z.infer<typeof SecretAskPurpose>;

// ponytail: MCP form-mode's flat vocabulary; expand with upstream fields rather
// than a separate schema engine. Zod's native importer validates formats/bounds.
const formTitle = { title: z.string().optional(), description: z.string().optional() };
const formOption = z.strictObject({ const: z.string(), title: z.string() });
const formString = z.strictObject({
  ...formTitle,
  type: z.literal("string"),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  format: z.enum(["date", "uri", "email", "date-time"]).optional(),
  default: z.string().optional(),
});
export const AskFormFieldSchema = z.union([
  formString,
  z.strictObject({
    ...formTitle,
    type: z.literal("string"),
    enum: z.array(z.string()).min(1),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...formTitle,
    type: z.literal("string"),
    oneOf: z.array(formOption).min(1),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...formTitle,
    type: z.enum(["number", "integer"]),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.strictObject({ ...formTitle, type: z.literal("boolean"), default: z.boolean().optional() }),
  z.strictObject({
    ...formTitle,
    type: z.literal("array"),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    items: z.union([
      z.strictObject({ type: z.literal("string"), enum: z.array(z.string()).min(1) }),
      z.strictObject({ anyOf: z.array(formOption).min(1) }),
    ]),
    default: z.array(z.string()).optional(),
  }),
]);
export type AskFormField = z.infer<typeof AskFormFieldSchema>;
export const AskRequestedSchema = z
  .strictObject({
    type: z.literal("object"),
    properties: z.record(z.string(), AskFormFieldSchema),
    required: z.array(z.string()).optional(),
  })
  .refine(
    (schema) => schema.required?.every((name) => Object.hasOwn(schema.properties, name)) ?? true,
    "Required fields must exist",
  );
export type AskRequestedSchema = z.infer<typeof AskRequestedSchema>;
const AskFormContent = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export type AskFormContent = z.infer<typeof AskFormContent>;
export const AskFormResponseSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), content: AskFormContent }),
  z.strictObject({ action: z.literal("cancel") }),
  z.strictObject({ action: z.literal("decline") }),
]);
export type AskFormResponse = z.infer<typeof AskFormResponseSchema>;
export const AskAnswerSchema = z.union([z.string().min(1), AskFormResponseSchema]);
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export function parseAskFormResponse(
  schema: AskRequestedSchema,
  response: unknown,
): AskFormResponse {
  const parsed = AskFormResponseSchema.parse(response);
  if (parsed.action !== "accept") return parsed;
  // JSON Schema defaults are UI suggestions, not implicit user answers.
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([name, { default: _default, ...field }]) => [
      name,
      field,
    ]),
  );
  const result = z
    .fromJSONSchema({ ...schema, properties, additionalProperties: false })
    .safeParse(parsed.content);
  if (!result.success)
    throw new Error(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    );
  const content = result.data;
  return { action: "accept", content: AskFormContent.parse(content) };
}

/** People-search queries planned on the last recruiting question, run the moment it is answered. */
export const PlannedPeopleSearchesSchema = z.array(z.string().trim().min(3).max(300)).max(4);
const askQuestion = {
  question: z.string().min(1).max(240),
  plannedSearches: PlannedPeopleSearchesSchema.optional().describe(
    "Recruiting intake only, on a clarifying question before the first round: the four people-search queries you would run if this answer were the last one needed. They run the moment the recruiter answers. Pass [] when the recruiter said not to look for people outside their own list.",
  ),
};
export const AskUserInputSchema = z.union([
  z.strictObject({
    ...askQuestion,
    options: z
      .array(z.string().trim().min(1).max(80))
      .min(2)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
  }),
  z.strictObject({ ...askQuestion, requestedSchema: AskRequestedSchema }),
]);
export const AskUserInputJsonSchema = z.toJSONSchema(AskUserInputSchema);

/** An integration the agent needs the user to connect, shown as a connect card. */
export const AskConnectionSchema = z.strictObject({
  /** The MCP server whose existing OAuth flow the card runs. */
  serverId: Id,
  name: z.string().trim().min(1).max(80),
  iconUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "Expected an HTTPS icon URL")
    .optional(),
  /** One sentence on why the agent needs it. */
  reason: z.string().trim().min(1).max(240),
});
export type AskConnection = z.infer<typeof AskConnectionSchema>;
/** The answer a connect card sends; the runtime still verifies the connection itself. */
export const ConnectionAskAnswer = z.enum(["connected", "not_connected"]);
export type ConnectionAskAnswer = z.infer<typeof ConnectionAskAnswer>;

export const AskBlockSchema = z
  .object({
    kind: z.literal("ask"),
    text: z.string(),
    approvalEffectId: Id.optional(),
    approvalEvidenceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    detail: z.string().optional(),
    input: z.enum(["text", "secret"]).optional(),
    /** Why the secret is needed; drives field label on the masked card. */
    purpose: SecretAskPurpose.optional(),
    // Records what the runtime could produce under either deployment mode, so
    // an ask persisted before an owner toggles the private-HTTP flag still
    // validates on replay.
    credential: botSecretDestinationSchema({ allowPrivateHttpOrigin: true }).optional(),
    status: z.enum(["pending", "answered"]).optional(),
    answer: z.string().optional(),
    requestedSchema: AskRequestedSchema.optional(),
    formResponse: AskFormResponseSchema.optional(),
    connection: AskConnectionSchema.optional(),
    actions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          outcome: z.enum(["created", "cancelled"]).optional(),
        }),
      )
      .optional(),
  })
  .refine(
    (block) =>
      !block.requestedSchema ||
      (!block.approvalEffectId &&
        block.input !== "secret" &&
        !block.purpose &&
        !block.credential &&
        !block.actions?.length),
    "A form cannot be an approval, secret or choice card",
  )
  .refine(
    (block) =>
      !block.connection ||
      (!block.requestedSchema &&
        !block.approvalEffectId &&
        block.input !== "secret" &&
        !block.purpose &&
        !block.credential &&
        !block.actions?.length),
    "A connect card cannot be a form, approval, secret or choice card",
  )
  .refine(
    (block) => !block.formResponse || Boolean(block.requestedSchema && block.status === "answered"),
    "A form response belongs to an answered form",
  );

export const MessageBlock = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    recruitingFeedback: RecruitingCandidateFeedbackSelectionSchema.optional(),
    correspondenceReference: RecruitingCorrespondenceReferenceSchema.optional(),
    crmRoleReference: RecruitingCrmRoleReferenceSchema.optional(),
    recruitingContext: RecruitingChatContextSchema.optional(),
  }),
  z.object({
    kind: z.literal("card"),
    lines: z.array(z.object({ k: z.string(), v: z.string() })),
  }),
  AskBlockSchema,
  z.object({
    kind: z.literal("choice"),
    question: z.string(),
    subtitle: z.string().optional(),
    options: z.array(z.object({ id: z.string(), letter: z.string(), label: z.string() })),
    /** Set once the user picks an option; renders the picker as answered. */
    answerId: z.string().optional(),
  }),
  z.object({
    /** Inline app authorization card (Composio-backed): logo, name, one-line
        description, and an Authorize button that flips to connected. */
    kind: z.literal("app_connect"),
    connectorId: z.string().optional(),
    provider: z.string(),
    name: z.string(),
    description: z.string(),
    logo: z.string().nullable(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("connect"),
    name: z.string(),
    initial: z.string(),
    color: z.string(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("computer"),
    state: z.string(),
    text: z.string(),
  }),
  z.object({
    /** Transcript card left in the thread when the bot hangs up a voice call. */
    kind: z.literal("voice_call"),
    /** Absent when the call had no client nonce to derive an id from. */
    callId: z.string().optional(),
    title: z.string(),
    farewell: z.string(),
  }),
  z.object({ kind: z.literal("meta"), text: z.string() }),
  z.object({
    kind: z.literal("progress"),
    text: z.string(),
    /** Provider-generated tool status rather than assistant-authored narration. */
    activity: z.literal(true).optional(),
    pendingToolNames: z.array(z.string()).optional(),
    /** Set while the runtime compacts context; cleared by the next progress update. */
    phase: z.enum(["compacting", "thinking", "retrying"]).optional(),
    /** User-safe label for the thinking phase; never raw reasoning. */
    summary: z.string().max(80).optional(),
    at: z.string().optional(),
  }),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(z.object({ label: z.string(), count: z.number().int().positive() })),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("subagent"),
    agentId: z.string(),
    name: z.string(),
    task: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    progress: z.string().optional(),
    result: z.string().optional(),
  }),
  z.object({
    kind: z.literal("child_bot"),
    botId: z.string(),
    name: z.string(),
    title: z.string().optional(),
    status: z.enum(["created", "archived", "deleted"]),
  }),
  z.object({
    /** Compact card for a remote cloud coding agent (not the bot computer). */
    kind: z.literal("cloud_agent"),
    agentId: z.string(),
    title: z.string(),
    status: z.enum(["running", "finished", "failed", "cancelled"]),
    url: z.string(),
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    latestRunId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("skill_draft"),
    skillId: Id,
    name: z.string(),
    goal: z.string(),
    playbook: z.object({
      whenToUse: z.string(),
      inputs: z.array(z.string()),
      steps: z.array(z.string()),
      howToCheck: z.string(),
      whatToReturn: z.string(),
      approvalBoundaries: z.string(),
      failureHandling: z.string(),
    }),
    status: z.enum(["draft", "saved"]),
  }),
  ChartBlock,
  z.object({
    /** Approval card for an agent-created MCP server. The user completes the
        OAuth popup (or confirms no authorization is needed) in the UI. The
        status persists so the card renders its decision after a remount. */
    kind: z.literal("mcp_approval"),
    name: z.string(),
    serverId: Id,
    transport: McpTransportSchema,
    endpoint: z.string().nullable(),
    needsOAuth: z.boolean(),
    status: z.enum(["pending", "connected", "dismissed"]).default("pending"),
  }),
  z.object({
    kind: z.literal("image"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("file"),
    artifactId: Id,
    mimeType: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
    preview: z
      .object({ label: z.string(), source: ReadRecruitingSourceInput.nullable() })
      .optional(),
  }),
  z.object({
    kind: z.literal("handoff"),
    fromBotId: Id,
    toBotId: Id,
    text: z.string(),
    /** Links ownership transfers in one user-started group turn. */
    hop: z.number().int().positive().optional(),
  }),
  z.object({
    /** A group-chat message delivered into a member bot's own thread. */
    kind: z.literal("channel_message"),
    provider: z.string(),
    /** Per-message network when a provider spans multiple transports. */
    transport: z.string().optional(),
    channelId: Id,
    fromAddress: z.string(),
    fromLabel: z.string(),
    text: z.string(),
    hop: z.number().int().nonnegative().optional(),
  }),
  z.object({
    /** Shown in the sending bot's own chat, so the user can see what it sent. */
    kind: z.literal("bot_message_sent"),
    toBotId: Id,
    toBotName: z.string(),
    text: z.string(),
    intent: BotMessageIntent.optional(),
  }),
  z.object({
    /** Delivered into the receiving bot's own chat as the prompt that woke it. */
    kind: z.literal("bot_message_received"),
    fromBotId: Id,
    fromBotName: z.string(),
    text: z.string(),
    intent: BotMessageIntent.optional(),
    /** Sender-thread echo this delivery answers, when applicable. */
    returnToMessageId: Id.optional(),
    /** Links in a bot-started chain; absent when a person started it. */
    hop: z.number().int().nonnegative().optional(),
  }),
]);
export type MessageBlock = z.infer<typeof MessageBlock>;

export const RecruitingChangedPayloadSchema = z.strictObject({
  roleId: RecruitingId.nullable(),
});
export type RecruitingChangedPayload = z.infer<typeof RecruitingChangedPayloadSchema>;

export const RecruitingContextAdoptedPayloadSchema = z.strictObject({
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  contextArtifact: RecruitingArtifactRefSchema,
});
export type RecruitingContextAdoptedPayload = z.infer<typeof RecruitingContextAdoptedPayloadSchema>;

export const RecruitingActionTransitionedPayloadSchema = z.strictObject({
  taskId: RecruitingId,
  actionId: RecruitingId,
  from: RecruitingActionDeliveryStateSchema.nullable(),
  to: RecruitingActionDeliveryStateSchema,
});
export type RecruitingActionTransitionedPayload = z.infer<
  typeof RecruitingActionTransitionedPayloadSchema
>;

export const RecruitingReadPayloadSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("bound"),
    taskId: RecruitingId,
    actionId: RecruitingId,
    effectId: RecruitingId,
    toolName: z.enum(["get_task", "get_rows"]),
  }),
  z.strictObject({
    phase: z.literal("recorded"),
    taskId: RecruitingId,
    actionId: RecruitingId,
    effectId: RecruitingId,
    outputArtifact: RecruitingArtifactRefSchema,
  }),
]);
export type RecruitingReadPayload = z.infer<typeof RecruitingReadPayloadSchema>;

export const RecruitingCandidatesSavedPayloadSchema = z.strictObject({
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  effectId: RecruitingId,
  mcpServerId: RecruitingId,
  serverRevision: z.number().int().positive(),
  providerTaskId: RecruitingId,
  requestCursor: z.string().nullable(),
  outputArtifact: RecruitingArtifactRefSchema,
  candidateOutputSchema: z.literal(RECRUITING_CANDIDATE_OUTPUT_SCHEMA),
});
export type RecruitingCandidatesSavedPayload = z.infer<
  typeof RecruitingCandidatesSavedPayloadSchema
>;

export const RecruitingMaterialReadPayloadSchema = z.strictObject({
  reader: z.literal("web_fetch"),
  artifact: RecruitingArtifactRefSchema,
  url: z.httpUrl(),
  readAt: IsoDate,
});
export type RecruitingMaterialReadPayload = z.infer<typeof RecruitingMaterialReadPayloadSchema>;

export const RecruitingSearchesPlannedPayloadSchema = z.strictObject({
  queries: PlannedPeopleSearchesSchema,
});

export const RecruitingAssessmentSavedPayloadSchema = z.strictObject({
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  candidateKey: RecruitingId,
  version: z.number().int().positive(),
  effectId: RecruitingId,
});
export type RecruitingAssessmentSavedPayload = z.infer<
  typeof RecruitingAssessmentSavedPayloadSchema
>;

export const RecruitingQuestionAskedPayloadSchema = z.strictObject({
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  target: RecruitingAssessmentAskTargetSchema,
  effectId: RecruitingId,
  messageId: Id,
  askIndex: z.number().int().nonnegative(),
});
export type RecruitingQuestionAskedPayload = z.infer<typeof RecruitingQuestionAskedPayloadSchema>;

export const RecruitingProfileViewedPayloadSchema = RecruitingProfileActivityInput.extend({
  roleTitle: z.string(),
  /** Exact imported attachment provenance; never an execution or approval receipt. */
  crmSource: RecruitingCrmRoleReferenceSchema.optional(),
  crmBindingEffectId: Id.nullable(),
  viewId: z.uuid(),
  actorUserId: Id,
  actorName: z.string().nullable(),
});

export const NativeAskAnswerPayloadSchema = z.strictObject({
  messageId: Id,
  askIndex: z.number().int().nonnegative(),
  answerMessageId: Id,
  answeredByUserId: Id,
});
export type NativeAskAnswerPayload = z.infer<typeof NativeAskAnswerPayloadSchema>;

export const EffectApprovalAnsweredPayloadSchema = z.strictObject({
  approvalEvidenceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  effectId: Id,
  messageId: Id,
  askIndex: z.number().int().nonnegative(),
  answeredByUserId: Id,
  answer: z.enum(["allow", "always", "deny"]),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EffectApprovalAnsweredPayload = z.infer<typeof EffectApprovalAnsweredPayloadSchema>;

const RunRequeuedPayloadSchema = z.strictObject({
  status: z.enum(["queued", "waiting_takeover"]),
});

export const ProductEventSchema = z
  .object({
    id: Id,
    spaceId: Id,
    threadId: Id,
    botId: Id,
    seq: z.number().int().nonnegative(),
    type: ProductEventType,
    runId: Id.optional(),
    createdAt: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((event, ctx) => {
    if (event.type === "run.requeued" && !event.runId) {
      ctx.addIssue({ code: "custom", path: ["runId"], message: "Requeue requires its run" });
    }
    const schema =
      event.type === "recruiting.profile.viewed"
        ? RecruitingProfileViewedPayloadSchema
        : event.type === "recruiting.changed"
          ? RecruitingChangedPayloadSchema
          : event.type === "recruiting.context.adopted"
            ? RecruitingContextAdoptedPayloadSchema
            : event.type === "recruiting.action.transitioned"
              ? RecruitingActionTransitionedPayloadSchema
              : event.type === "recruiting.read"
                ? RecruitingReadPayloadSchema
                : event.type === "recruiting.candidates.saved"
                  ? RecruitingCandidatesSavedPayloadSchema
                  : event.type === "recruiting.material.read"
                    ? RecruitingMaterialReadPayloadSchema
                    : event.type === "recruiting.assessment.saved"
                      ? RecruitingAssessmentSavedPayloadSchema
                      : event.type === "recruiting.question.asked"
                        ? RecruitingQuestionAskedPayloadSchema
                        : event.type === "recruiting.searches.planned"
                          ? RecruitingSearchesPlannedPayloadSchema
                          : event.type === "thread.choice"
                            ? NativeAskAnswerPayloadSchema
                            : event.type === "effect.approval.answered"
                              ? EffectApprovalAnsweredPayloadSchema
                              : event.type === "run.requeued"
                                ? RunRequeuedPayloadSchema
                                : event.type === "run.completed"
                                  ? RunCompletedPayloadSchema
                                  : event.type === "thread.progress"
                                    ? ThreadProgressPayloadSchema
                                    : null;
    if (!schema) return;
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ["payload", ...issue.path] });
      }
    }
  });
export type ProductEvent = z.infer<typeof ProductEventSchema>;

export const ThreadMessageSchema = z.object({
  /** Server-generated continuation; retained for history but hidden in conversation views. */
  internal: z.boolean().optional(),
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: z.array(MessageBlock),
  botId: Id.optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().optional(),
  replyPreview: ReplyPreviewSchema.nullable().optional(),
  runId: Id.optional(),
  /** Set when the message was sent from a live voice call; groups one call's transcript. */
  callId: z.string().optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
