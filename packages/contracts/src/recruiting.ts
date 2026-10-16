import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const RecruitingId = Id.refine((value) => value.trim().length > 0, "ID must not be blank");
const Text = z.string().trim().min(1);
const Revision = z.number().int().positive();

export const VerdictSchema = z.enum(["met", "unmet", "unknown"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** artifactId is the native Artifact row for one exact version, never a family/name lookup. */
export const RecruitingArtifactRefSchema = z
  .strictObject({
    artifactId: RecruitingId,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .readonly();
export type RecruitingArtifactRef = z.infer<typeof RecruitingArtifactRefSchema>;

/** ACLs and the authenticity of the locator/quote are checked by the reading handler. */
export const RecruitingSourceRefSchema = z
  .strictObject({
    id: RecruitingId,
    kind: z.enum([
      "provider_report",
      "original_material",
      "candidate_statement",
      "recruiter_verified",
    ]),
    anchor: z.discriminatedUnion("kind", [
      z
        .strictObject({ kind: z.literal("message"), messageId: RecruitingId, locator: Text })
        .readonly(),
      z
        .strictObject({
          kind: z.literal("artifact"),
          artifact: RecruitingArtifactRefSchema,
          locator: Text,
        })
        .readonly(),
    ]),
    readState: z.enum(["read", "unread", "unavailable"]),
    readAt: IsoDate.nullable(),
    url: z.httpUrl().optional(),
    quote: Text.optional(),
  })
  .superRefine((source, ctx) => {
    if ((source.readState === "unread") !== (source.readAt === null)) {
      ctx.addIssue({ code: "custom", path: ["readAt"], message: "Record the read/attempt time" });
    }
    if (source.readState !== "read" && source.quote !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Unread material cannot provide a quote",
      });
    }
  })
  .readonly();
export type RecruitingSourceRef = z.infer<typeof RecruitingSourceRefSchema>;
const SourceRefs = z.array(RecruitingSourceRefSchema).readonly();
const Questions = z.array(Text).readonly();

export type RecruitingCriterionExpression =
  | Readonly<{ kind: "atom"; id: string; statement: string }>
  | Readonly<{ kind: "all" | "any"; items: readonly RecruitingCriterionExpression[] }>
  | Readonly<{ kind: "not"; item: RecruitingCriterionExpression }>;

export const RecruitingCriterionExpressionSchema: z.ZodType<RecruitingCriterionExpression> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("atom"), id: RecruitingId, statement: Text }).readonly(),
      z
        .strictObject({
          kind: z.enum(["all", "any"]),
          items: z.array(RecruitingCriterionExpressionSchema).min(1).readonly(),
        })
        .readonly(),
      z
        .strictObject({ kind: z.literal("not"), item: RecruitingCriterionExpressionSchema })
        .readonly(),
    ]),
);

export const RecruitingCriterionSchema = z
  .strictObject({
    id: RecruitingId,
    priority: z.enum(["hard", "preferred"]),
    expression: RecruitingCriterionExpressionSchema,
    sourceRefs: z.array(RecruitingSourceRefSchema).min(1).readonly(),
    definitionQuestions: Questions,
  })
  .readonly();
export type RecruitingCriterion = z.infer<typeof RecruitingCriterionSchema>;

const RoleDefinition = {
  sourceRefs: z.array(RecruitingSourceRefSchema).min(1).readonly(),
  criteria: z
    .array(RecruitingCriterionSchema)
    .superRefine((criteria, ctx) => {
      if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
        ctx.addIssue({ code: "custom", message: "Criterion IDs must be unique" });
      }
      const definitions = new Map<string, string>();
      const pending = criteria.map((criterion) => criterion.expression);
      for (let expression = pending.pop(); expression; expression = pending.pop()) {
        if (expression.kind === "atom") {
          const previous = definitions.get(expression.id);
          if (previous !== undefined && previous !== expression.statement) {
            ctx.addIssue({ code: "custom", message: "An atom ID must have one definition" });
          }
          definitions.set(expression.id, expression.statement);
        } else if (expression.kind === "not") {
          pending.push(expression.item);
        } else {
          pending.push(...expression.items);
        }
      }
    })
    .readonly(),
  preferences: z.array(Text).readonly(),
  definitionQuestions: Questions,
};

export const RecruitingRoleSchema = z.strictObject({
  id: RecruitingId,
  spaceId: RecruitingId,
  userId: RecruitingId,
  sourceThreadId: RecruitingId,
  title: Text,
  revision: Revision,
  currentRevisionId: RecruitingId,
});
export type RecruitingRole = z.infer<typeof RecruitingRoleSchema>;

export const RecruitingRoleRevisionSchema = z
  .strictObject({
    id: RecruitingId,
    roleId: RecruitingId,
    revision: Revision,
    ...RoleDefinition,
    createdAt: IsoDate,
  })
  .readonly();
export type RecruitingRoleRevision = z.infer<typeof RecruitingRoleRevisionSchema>;

export const RecruitingResearchTaskSchema = z.strictObject({
  id: RecruitingId,
  roleId: RecruitingId,
  mcpServerId: RecruitingId,
  serverRevision: Revision,
  providerTaskId: RecruitingId.nullable(),
  pendingActionId: RecruitingId.nullable(),
  state: z.enum(["active", "completed", "closed", "unknown"]),
  createdByRunId: RecruitingId,
});
export type RecruitingResearchTask = z.infer<typeof RecruitingResearchTaskSchema>;

export const RecruitingActionDeliveryStateSchema = z.enum([
  "prepared",
  "sending",
  "accepted",
  "rejected",
  "unknown",
  "superseded",
]);
export type RecruitingActionDeliveryState = z.infer<typeof RecruitingActionDeliveryStateSchema>;

const ResearchRequest = {
  taskId: RecruitingId,
  roleRevisionId: RecruitingId,
  clientNonce: RecruitingId,
  kind: z.enum(["create", "continue"]),
  requestArtifact: RecruitingArtifactRefSchema,
  contextArtifact: RecruitingArtifactRefSchema,
  /** A single round's recall instructions do not change role qualification. */
  recallScope: Text.nullable(),
};
export const RecruitingResearchActionSchema = z
  .strictObject({
    id: RecruitingId,
    ...ResearchRequest,
    runId: RecruitingId,
    sourceMessageId: RecruitingId,
    deliveryState: RecruitingActionDeliveryStateSchema,
    observedProviderState: Text.nullable(),
    receiptArtifact: RecruitingArtifactRefSchema.nullable(),
    outputArtifacts: z.array(RecruitingArtifactRefSchema).readonly(),
    cursor: Text.nullable(),
    effectId: RecruitingId.nullable(),
    usage: z
      .array(
        z
          .strictObject({
            scope: z.enum(["task", "batch", "person"]),
            unit: Text,
            amount: z.number().nonnegative(),
          })
          .readonly(),
      )
      .readonly()
      .nullable(),
  })
  .refine((action) => action.usage === null || action.receiptArtifact !== null, {
    path: ["receiptArtifact"],
    message: "Reported usage requires a receipt reference",
  })
  .readonly();
export type RecruitingResearchAction = z.infer<typeof RecruitingResearchActionSchema>;

export const RecruitingFactSchema = z
  .strictObject({
    id: RecruitingId,
    statement: Text,
    sourceRefIds: z.array(RecruitingId).min(1).readonly(),
  })
  .readonly();
export type RecruitingFact = z.infer<typeof RecruitingFactSchema>;

export const RecruitingJudgmentSchema = z
  .strictObject({
    criterionId: RecruitingId,
    verdict: VerdictSchema,
    factIds: z.array(RecruitingId).readonly(),
    /** IDs in the assessment's sourceRefs; assistant explanations are not evidence. */
    evidence: z.array(RecruitingId).readonly(),
    missing: Questions,
  })
  .readonly();
export type RecruitingJudgment = z.infer<typeof RecruitingJudgmentSchema>;

const AssessmentContent = z
  .strictObject({
    roleId: RecruitingId,
    candidateKey: RecruitingId,
    roleRevisionId: RecruitingId,
    facts: z.array(RecruitingFactSchema).readonly(),
    judgments: z.array(RecruitingJudgmentSchema).readonly(),
    questions: Questions,
    sourceRefs: SourceRefs,
  })
  .superRefine((assessment, ctx) => {
    const facts = new Set(assessment.facts.map((fact) => fact.id));
    const sources = new Map(assessment.sourceRefs.map((source) => [source.id, source]));
    const criteria = new Set(assessment.judgments.map((judgment) => judgment.criterionId));
    if (
      facts.size !== assessment.facts.length ||
      sources.size !== assessment.sourceRefs.length ||
      criteria.size !== assessment.judgments.length
    ) {
      ctx.addIssue({ code: "custom", message: "Fact, source, and judgment IDs must be unique" });
    }
    for (const fact of assessment.facts) {
      if (fact.sourceRefIds.some((id) => !sources.has(id))) {
        ctx.addIssue({ code: "custom", path: ["facts"], message: "Unknown fact source ID" });
      }
    }
    for (const judgment of assessment.judgments) {
      if (
        judgment.factIds.some((id) => !facts.has(id)) ||
        judgment.evidence.some((id) => sources.get(id)?.readState !== "read")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["judgments"],
          message: "Unknown fact or unread evidence",
        });
      }
    }
  });

export const RecruitingAssessmentSchema = AssessmentContent.safeExtend({
  version: Revision,
  basedOnVersion: Revision.nullable(),
  createdByRunId: RecruitingId,
  createdAt: IsoDate,
})
  .refine((assessment) => assessment.version === (assessment.basedOnVersion ?? 0) + 1, {
    path: ["basedOnVersion"],
    message: "An assessment must follow the version it is based on",
  })
  .readonly();
export type RecruitingAssessment = z.infer<typeof RecruitingAssessmentSchema>;

// Runtime supplies identity. Closed inputs also reject identity fields rather than stripping them.
export const CreateRecruitingRoleInput = z.strictObject({
  sourceThreadId: RecruitingId,
  expectedRevision: z.literal(0),
  title: Text,
  ...RoleDefinition,
});
export type CreateRecruitingRoleInput = z.infer<typeof CreateRecruitingRoleInput>;

export const ReviseRecruitingRoleInput = z.strictObject({
  roleId: RecruitingId,
  expectedRevision: Revision,
  title: Text,
  ...RoleDefinition,
});
export type ReviseRecruitingRoleInput = z.infer<typeof ReviseRecruitingRoleInput>;

const RoleToolIntent = z.strictObject({ basis: z.enum(["direct", "inferred"]), quote: Text });
const RoleToolDefinition = {
  ...RoleDefinition,
  // Runtime adds the verified human source; supplied JD/material references retain their ACLs.
  sourceRefs: SourceRefs,
  criteria: z
    .array(RecruitingCriterionSchema.unwrap().extend({ sourceRefs: SourceRefs }))
    .readonly(),
  intent: RoleToolIntent,
};

export const RecruitingRoleToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read") }),
  z.strictObject({
    operation: z.literal("create"),
    expectedRevision: z.literal(0),
    title: Text,
    ...RoleToolDefinition,
  }),
  z.strictObject({
    operation: z.literal("revise"),
    roleId: RecruitingId,
    expectedRevision: Revision,
    title: Text,
    ...RoleToolDefinition,
  }),
  z.strictObject({
    operation: z.literal("bind"),
    roleId: RecruitingId.nullable(),
    intent: RoleToolIntent,
  }),
]);
export type RecruitingRoleToolInput = z.infer<typeof RecruitingRoleToolInputSchema>;

export const PrepareRecruitingResearchActionInput = z.strictObject({
  ...ResearchRequest,
  /** Expected role revision; later dispatch checks the current role and adoption atomically. */
  expectedRevision: Revision,
});
export type PrepareRecruitingResearchActionInput = z.infer<
  typeof PrepareRecruitingResearchActionInput
>;

export const SaveRecruitingAssessmentInput = AssessmentContent.safeExtend({
  /** Expected candidate assessment version; zero creates its first snapshot. */
  expectedRevision: z.number().int().nonnegative(),
});
export type SaveRecruitingAssessmentInput = z.infer<typeof SaveRecruitingAssessmentInput>;
