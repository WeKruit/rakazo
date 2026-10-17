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

const EmploymentYear = z.number().int().min(1).max(9999);
const EmploymentMonth = z.number().int().min(1).max(12);
export const RecruitingEmploymentDaySchema = z
  .strictObject({
    precision: z.literal("day"),
    year: EmploymentYear,
    month: EmploymentMonth,
    day: z.number().int().min(1).max(31),
  })
  .refine(
    (date) => {
      const calendar = new Date(0);
      calendar.setUTCFullYear(date.year, date.month - 1, date.day);
      return calendar.getUTCMonth() === date.month - 1;
    },
    { message: "Employment day must be a valid calendar date" },
  )
  .readonly();
export const RecruitingEmploymentDateSchema = z.discriminatedUnion("precision", [
  z.strictObject({ precision: z.literal("year"), year: EmploymentYear }).readonly(),
  z
    .strictObject({ precision: z.literal("month"), year: EmploymentYear, month: EmploymentMonth })
    .readonly(),
  RecruitingEmploymentDaySchema,
]);
export type RecruitingEmploymentDate = z.infer<typeof RecruitingEmploymentDateSchema>;
export type RecruitingEmploymentDay = z.infer<typeof RecruitingEmploymentDaySchema>;

export const RecruitingEmploymentRuleSchema = z
  .strictObject({
    minimumMonths: z.number().int().nonnegative(),
    countingRule: z.literal("complete_calendar_months"),
    qualificationDefinition: Text,
    cutoff: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("fixed"), date: RecruitingEmploymentDaySchema }).readonly(),
      // The server freezes the UTC calendar day at the start of assessment execution.
      z.strictObject({ kind: z.literal("assessment_date") }).readonly(),
    ]),
  })
  .readonly();
export type RecruitingEmploymentRule = z.infer<typeof RecruitingEmploymentRuleSchema>;

export type RecruitingCriterionExpression =
  | Readonly<{
      kind: "atom";
      id: string;
      statement: string;
      employmentRule?: RecruitingEmploymentRule;
    }>
  | Readonly<{ kind: "all" | "any"; items: readonly RecruitingCriterionExpression[] }>
  | Readonly<{ kind: "not"; item: RecruitingCriterionExpression }>;

export const RecruitingCriterionExpressionSchema: z.ZodType<RecruitingCriterionExpression> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z
        .strictObject({
          kind: z.literal("atom"),
          id: RecruitingId,
          statement: Text,
          employmentRule: RecruitingEmploymentRuleSchema.optional(),
        })
        .readonly(),
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

function validateRoleCriteria(
  criteria: readonly Pick<RecruitingCriterion, "id" | "expression">[],
  ctx: z.RefinementCtx,
): void {
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    ctx.addIssue({ code: "custom", message: "Criterion IDs must be unique" });
  }
  const definitions = new Map<string, string>();
  const pending = criteria.map((criterion) => criterion.expression);
  for (let expression = pending.pop(); expression; expression = pending.pop()) {
    if (expression.kind === "atom") {
      const previous = definitions.get(expression.id);
      if (
        previous !== undefined &&
        previous !== JSON.stringify([expression.statement, expression.employmentRule ?? null])
      ) {
        ctx.addIssue({ code: "custom", message: "An atom ID must have one definition" });
      }
      definitions.set(
        expression.id,
        JSON.stringify([expression.statement, expression.employmentRule ?? null]),
      );
    } else if (expression.kind === "not") {
      pending.push(expression.item);
    } else {
      pending.push(...expression.items);
    }
  }
}

export const RecruitingBriefDraftSchema = z.strictObject({
  fields: z.array(
    z.strictObject({
      key: Text,
      value: Text.nullable(),
      origin: z.enum(["user_instruction", "jd", "hm", "inferred"]),
      state: z.enum(["known", "missing", "conflict"]),
      consequential: z.boolean(),
      sourceRefIds: z.array(RecruitingId),
    }),
  ),
  questions: z.array(
    z.strictObject({
      id: RecruitingId,
      fieldKey: Text,
      question: Text,
      answeredBySourceRefId: RecruitingId.nullable(),
    }),
  ),
  rules: z.array(
    z.strictObject({
      criterionId: RecruitingId,
      origin: z.enum(["user_instruction", "jd", "hm", "inferred"]),
      effect: z.enum(["flag", "reject"]),
      sourceRefIds: z.array(RecruitingId),
    }),
  ),
});
export type RecruitingBriefDraft = z.infer<typeof RecruitingBriefDraftSchema>;
export const RecruitingBriefSchema = RecruitingBriefDraftSchema.extend({
  confirmation: z
    .strictObject({
      revision: Revision,
      userId: RecruitingId,
      messageId: RecruitingId,
      confirmedAt: IsoDate,
    })
    .nullable(),
});
export type RecruitingBrief = z.infer<typeof RecruitingBriefSchema>;
export const ConfirmRecruitingBriefInput = z.strictObject({
  threadId: RecruitingId,
  roleId: RecruitingId,
  expectedRevision: Revision,
});

const RoleDefinition = {
  brief: RecruitingBriefDraftSchema.nullable().optional(),
  sourceRefs: z.array(RecruitingSourceRefSchema).min(1).readonly(),
  criteria: z.array(RecruitingCriterionSchema).superRefine(validateRoleCriteria).readonly(),
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
    brief: RecruitingBriefSchema.nullable().optional(),
    createdAt: IsoDate,
  })
  .readonly();
export type RecruitingRoleRevision = z.infer<typeof RecruitingRoleRevisionSchema>;

export const RecruitingResearchPurposeSchema = z.enum(["calibration", "scale"]);
export type RecruitingResearchPurpose = z.infer<typeof RecruitingResearchPurposeSchema>;

const RecruitingApprovalScope = {
  roleId: RecruitingId,
  expectedRoleRevision: Revision,
};
export const RecruitingApprovalToolInputSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    ...RecruitingApprovalScope,
    stage: z.literal("documents"),
    documents: z.strictObject({
      jdText: RecruitingArtifactRefSchema,
      namedPdf: RecruitingArtifactRefSchema,
      anonymousPdf: RecruitingArtifactRefSchema.nullable(),
      deck: RecruitingArtifactRefSchema.nullable(),
    }),
  }),
  z.strictObject({
    ...RecruitingApprovalScope,
    stage: z.literal("calibration"),
    documentsApprovalEffectId: RecruitingId,
    profiles: z
      .array(
        z.strictObject({
          candidateKey: RecruitingId,
          assessmentVersion: Revision,
          linkedinUrl: z.httpUrl().refine((url) => new URL(url).protocol === "https:"),
          evidenceUrl: z.httpUrl(),
        }),
      )
      .length(10),
    ruleChanges: z.array(Text).readonly(),
  }),
]);
export type RecruitingApprovalToolInput = z.infer<typeof RecruitingApprovalToolInputSchema>;

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
  /** Null identifies historical actions whose purpose was never recorded. */
  purpose: RecruitingResearchPurposeSchema.nullable().optional(),
  approvalEffectId: RecruitingId.nullable().optional(),
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

export const RecruitingResearchObservationSchema = z.strictObject({
  deliveryState: z.enum(["accepted", "rejected", "unknown"]),
  providerTaskId: RecruitingId.nullable(),
  observedProviderState: z.string().nullable(),
  done: z.boolean().nullable(),
  // No inspected receipt proves application of an exact local role revision.
  providerApplicationConfirmed: z.literal(false),
  automaticRetry: z.literal(false),
  usage: z
    .array(
      z.strictObject({
        scope: z.literal("task"),
        unit: z.literal("credits"),
        amount: z.number().nonnegative(),
      }),
    )
    .nullable(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  nextCursor: z.string().nullable().optional(),
  outputId: z.string().nullable().optional(),
  refusalCode: z.string().optional(),
  retryAfterSeconds: z.number().nonnegative().optional(),
});
export type RecruitingResearchObservation = z.infer<typeof RecruitingResearchObservationSchema>;

/** Existing immutable native read Artifact bytes, including the original opaque request. */
export const RecruitingResearchReadArtifactSchema = z
  .strictObject({
    version: z.literal(1),
    taskId: RecruitingId,
    actionId: RecruitingId,
    operation: z.enum(["status", "rows"]),
    effectId: RecruitingId,
    request: z.record(z.string(), z.unknown()),
    providerResult: z.unknown(),
    observation: RecruitingResearchObservationSchema,
  })
  .superRefine((snapshot, ctx) => {
    const { rows, nextCursor, outputId, deliveryState } = snapshot.observation;
    if (
      (snapshot.operation === "rows" && deliveryState === "accepted" && rows === undefined) ||
      ((snapshot.operation !== "rows" || deliveryState !== "accepted") &&
        (rows !== undefined || nextCursor !== undefined || outputId !== undefined))
    )
      ctx.addIssue({
        code: "custom",
        path: ["observation", "rows"],
        message: "Only accepted rows receipts provide result rows",
      });
  });
export type RecruitingResearchReadArtifact = z.infer<typeof RecruitingResearchReadArtifactSchema>;

const SelectionRange = {
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
};
export const RecruitingSourceSelectionSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z.literal("message_text"),
        blockIndex: z.number().int().nonnegative(),
        ...SelectionRange,
      })
      .readonly(),
    z.strictObject({ kind: z.literal("artifact_text"), ...SelectionRange }).readonly(),
    z
      .strictObject({
        kind: z.literal("artifact_json_string"),
        path: z.array(z.union([z.string(), z.number().int().nonnegative()])).readonly(),
        ...SelectionRange,
      })
      .readonly(),
  ])
  .refine((selection) => selection.end > selection.start, {
    message: "Selection end must follow its start",
  });
export type RecruitingSourceSelection = z.infer<typeof RecruitingSourceSelectionSchema>;

/** Selection offsets are UTF-16 positions in one native text block or exact artifact string. */
export const RecruitingAssessmentSourceRefSchema = RecruitingSourceRefSchema.unwrap()
  .safeExtend({
    quote: z.string().min(1).optional(),
    selection: RecruitingSourceSelectionSchema.optional(),
  })
  .superRefine((source, ctx) => {
    if (source.readState === "read") {
      if (source.quote === undefined || source.selection === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Read assessment evidence requires an exact quote and selection",
        });
      } else if (
        (source.anchor.kind === "message") !==
        (source.selection.kind === "message_text")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["selection"],
          message: "Selection must match its source anchor",
        });
      }
    } else if (source.quote !== undefined || source.selection !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Unread or unavailable evidence cannot provide a quote or selection",
      });
    }
  })
  .readonly();
export type RecruitingAssessmentSourceRef = z.infer<typeof RecruitingAssessmentSourceRefSchema>;

const FactContent = {
  id: RecruitingId,
  statement: Text,
  sourceRefIds: z.array(RecruitingId).min(1).readonly(),
};
export const RecruitingFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...FactContent, kind: z.literal("statement") }).readonly(),
  z
    .strictObject({
      ...FactContent,
      kind: z.literal("employment"),
      start: RecruitingEmploymentDateSchema.nullable(),
      end: z.union([RecruitingEmploymentDateSchema, z.literal("present"), z.null()]),
      employmentType: Text,
    })
    .readonly(),
  z
    .strictObject({
      ...FactContent,
      kind: z.literal("history_completeness"),
      complete: z.boolean(),
      asOf: RecruitingEmploymentDaySchema,
    })
    .readonly(),
]);
export type RecruitingFact = z.infer<typeof RecruitingFactSchema>;

const JudgmentContent = {
  verdict: VerdictSchema,
  factIds: z.array(RecruitingId).readonly(),
  /** IDs in the assessment's sourceRefs; assistant explanations are not evidence. */
  evidence: z.array(RecruitingId).readonly(),
  missing: Questions,
};
export const RecruitingJudgmentSchema = z
  .strictObject({ criterionId: RecruitingId, ...JudgmentContent })
  .readonly();
export type RecruitingJudgment = z.infer<typeof RecruitingJudgmentSchema>;
export const RecruitingAtomJudgmentSchema = z
  .strictObject({ atomId: RecruitingId, ...JudgmentContent })
  .readonly();
export type RecruitingAtomJudgment = z.infer<typeof RecruitingAtomJudgmentSchema>;

export const RecruitingEmploymentEvaluationSchema = z
  .strictObject({
    atomId: RecruitingId,
    intervals: z
      .array(
        z
          .strictObject({
            factId: RecruitingId,
            qualifyingFullTime: VerdictSchema,
            evidence: z.array(RecruitingId).readonly(),
            missing: Questions,
          })
          .readonly(),
      )
      .readonly(),
    historyCompletenessFactId: RecruitingId.nullable(),
    evidence: z.array(RecruitingId).readonly(),
    missing: Questions,
  })
  .readonly();
export type RecruitingEmploymentEvaluation = z.infer<typeof RecruitingEmploymentEvaluationSchema>;
export const RecruitingEmploymentJudgmentSchema = RecruitingEmploymentEvaluationSchema.unwrap()
  .extend({
    cutoff: RecruitingEmploymentDaySchema,
    minimumMonths: z.number().int().nonnegative(),
    countingRule: z.literal("complete_calendar_months"),
    qualificationDefinition: Text,
    lowerMonths: z.number().int().nonnegative(),
    upperMonths: z.number().int().nonnegative().nullable(),
    verdict: VerdictSchema,
    factIds: z.array(RecruitingId).readonly(),
  })
  .readonly();
export type RecruitingEmploymentJudgment = z.infer<typeof RecruitingEmploymentJudgmentSchema>;
export const RecruitingAssessmentJudgmentsSchema = z
  .strictObject({
    atoms: z.array(RecruitingAtomJudgmentSchema).readonly(),
    employment: z.array(RecruitingEmploymentJudgmentSchema).readonly(),
    criteria: z.array(RecruitingJudgmentSchema).readonly(),
    hardGate: VerdictSchema,
  })
  .readonly();
export type RecruitingAssessmentJudgments = z.infer<typeof RecruitingAssessmentJudgmentsSchema>;

const AssessmentContent = {
  roleId: RecruitingId,
  candidateKey: RecruitingId,
  roleRevisionId: RecruitingId,
  facts: z.array(RecruitingFactSchema).readonly(),
  questions: Questions,
  sourceRefs: z.array(RecruitingAssessmentSourceRefSchema).readonly(),
};

function assessmentDependencies(
  assessment: {
    facts: readonly RecruitingFact[];
    sourceRefs: readonly RecruitingAssessmentSourceRef[];
  },
  judgments: readonly { factIds: readonly string[]; evidence: readonly string[] }[],
  ctx: z.RefinementCtx,
): void {
  const facts = new Set(assessment.facts.map((fact) => fact.id));
  const sources = new Map(assessment.sourceRefs.map((source) => [source.id, source]));
  if (facts.size !== assessment.facts.length || sources.size !== assessment.sourceRefs.length)
    ctx.addIssue({ code: "custom", message: "Fact and source IDs must be unique" });
  for (const fact of assessment.facts) {
    if (
      new Set(fact.sourceRefIds).size !== fact.sourceRefIds.length ||
      fact.sourceRefIds.some((id) => !sources.has(id))
    )
      ctx.addIssue({
        code: "custom",
        path: ["facts"],
        message: "Unknown or duplicate fact source ID",
      });
  }
  for (const judgment of judgments) {
    if (
      new Set(judgment.factIds).size !== judgment.factIds.length ||
      new Set(judgment.evidence).size !== judgment.evidence.length ||
      judgment.factIds.some((id) => !facts.has(id)) ||
      judgment.evidence.some((id) => sources.get(id)?.readState !== "read")
    )
      ctx.addIssue({ code: "custom", message: "Unknown, duplicate or unread judgment dependency" });
  }
}

export const RecruitingAssessmentSchema = z
  .strictObject({
    ...AssessmentContent,
    judgments: RecruitingAssessmentJudgmentsSchema,
    version: Revision,
    basedOnVersion: Revision.nullable(),
    createdByRunId: RecruitingId,
    createdAt: IsoDate,
  })
  .superRefine((assessment, ctx) => {
    if (assessment.version !== (assessment.basedOnVersion ?? 0) + 1)
      ctx.addIssue({
        code: "custom",
        path: ["basedOnVersion"],
        message: "An assessment must follow the version it is based on",
      });
    assessmentDependencies(
      assessment,
      [
        ...assessment.judgments.atoms,
        ...assessment.judgments.employment,
        ...assessment.judgments.criteria,
      ],
      ctx,
    );
    for (const [field, ids] of [
      ["atoms", assessment.judgments.atoms.map((judgment) => judgment.atomId)],
      ["employment", assessment.judgments.employment.map((judgment) => judgment.atomId)],
      ["criteria", assessment.judgments.criteria.map((judgment) => judgment.criterionId)],
    ] as const)
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: "custom",
          path: ["judgments", field],
          message: "Judgment IDs must be unique",
        });
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

export const RecruitingHumanIntentSchema = z.strictObject({
  basis: z.enum(["direct", "inferred"]),
  quote: Text.describe(
    "One exact contiguous substring from one actual current human text block, preserving whitespace; do not normalize whitespace or join blocks.",
  ),
});
export type RecruitingHumanIntent = z.infer<typeof RecruitingHumanIntentSchema>;

const PreferenceAnchor = z
  .strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1),
  })
  .refine((anchor) => anchor.end > anchor.start, { message: "Anchor end must follow its start" });
const PreferenceContent = z.string().refine((content) => content.trim().length > 0, {
  message: "Preference content must not be blank",
});
const PreferenceFeedback = {
  target: z.literal("preference"),
  scope: z.enum(["bot", "user"]),
  path: Text,
  expectedRevision: z.number().int().nonnegative(),
  intent: RecruitingHumanIntentSchema,
  sourceRefs: SourceRefs,
};
export const RecruitingPreferenceFeedbackSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...PreferenceFeedback,
    operation: z.literal("add"),
    content: PreferenceContent,
  }),
  z.strictObject({
    ...PreferenceFeedback,
    operation: z.literal("replace"),
    anchor: PreferenceAnchor,
    content: PreferenceContent,
  }),
  z.strictObject({
    ...PreferenceFeedback,
    operation: z.literal("revoke"),
    anchor: PreferenceAnchor,
  }),
]);
export type RecruitingPreferenceFeedbackInput = z.infer<typeof RecruitingPreferenceFeedbackSchema>;

const ScopedFeedback = {
  roleId: RecruitingId,
  expectedRoleRevision: Revision,
  summary: Text,
  intent: RecruitingHumanIntentSchema,
  sourceRefs: SourceRefs,
};
export const RecruitingFeedbackInputSchema = z.discriminatedUnion("target", [
  z.strictObject({ ...ScopedFeedback, target: z.literal("role"), operation: z.literal("revise") }),
  z.strictObject({ ...ScopedFeedback, target: z.literal("round"), operation: z.literal("scope") }),
  z.strictObject({
    ...ScopedFeedback,
    target: z.literal("candidate"),
    operation: z.literal("fact"),
    candidateKey: RecruitingId,
    expectedAssessmentVersion: z.number().int().nonnegative(),
  }),
  RecruitingPreferenceFeedbackSchema,
]);
export type RecruitingFeedbackInput = z.infer<typeof RecruitingFeedbackInputSchema>;

const RoleToolDefinition = {
  ...RoleDefinition,
  // Runtime adds the verified human source; supplied JD/material references retain their ACLs.
  sourceRefs: SourceRefs,
  criteria: z
    .array(RecruitingCriterionSchema.unwrap().extend({ sourceRefs: SourceRefs }))
    .superRefine(validateRoleCriteria)
    .readonly(),
  intent: RecruitingHumanIntentSchema,
};

export const RecruitingRoleToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read") }),
  z.strictObject({
    operation: z.literal("create"),
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
    intent: RecruitingHumanIntentSchema,
  }),
]);
export type RecruitingRoleToolInput = z.infer<typeof RecruitingRoleToolInputSchema>;

const ResearchText = z.string().regex(/\S/, "Text must not be blank");
const ResearchRoundInput = {
  expectedRoleRevision: Revision,
  purpose: RecruitingResearchPurposeSchema,
  approvalEffectId: RecruitingId,
  clientNonce: RecruitingId,
  instructions: ResearchText,
  output: ResearchText,
  recallScope: ResearchText.nullable(),
  intent: RecruitingHumanIntentSchema,
};
export const RecruitingResearchToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...ResearchRoundInput,
    operation: z.literal("prepare"),
    mcpServerId: RecruitingId,
  }),
  z.strictObject({ ...ResearchRoundInput, operation: z.literal("continue"), taskId: RecruitingId }),
  z.strictObject({ operation: z.literal("start"), actionId: RecruitingId }),
  z.strictObject({ operation: z.literal("status"), taskId: RecruitingId }),
  z.strictObject({
    operation: z.literal("rows"),
    taskId: RecruitingId,
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  }),
]);
export type RecruitingResearchToolInput = z.infer<typeof RecruitingResearchToolInputSchema>;

export const PrepareRecruitingResearchActionInput = z.strictObject({
  ...ResearchRequest,
  purpose: RecruitingResearchPurposeSchema,
  approvalEffectId: RecruitingId,
  /** Expected role revision; later dispatch checks the current role and adoption atomically. */
  expectedRevision: Revision,
});
export type PrepareRecruitingResearchActionInput = z.infer<
  typeof PrepareRecruitingResearchActionInput
>;

export const SaveRecruitingAssessmentInput = z
  .strictObject({
    ...AssessmentContent,
    atomJudgments: z.array(RecruitingAtomJudgmentSchema).readonly(),
    employmentEvaluations: z.array(RecruitingEmploymentEvaluationSchema).readonly(),
    /** Expected candidate assessment version; zero creates its first snapshot. */
    expectedRevision: z.number().int().nonnegative(),
  })
  .superRefine((assessment, ctx) => {
    assessmentDependencies(
      assessment,
      [
        ...assessment.atomJudgments,
        ...assessment.employmentEvaluations.map((evaluation) => ({
          factIds: [
            ...evaluation.intervals.map((interval) => interval.factId),
            ...(evaluation.historyCompletenessFactId === null
              ? []
              : [evaluation.historyCompletenessFactId]),
          ],
          evidence: evaluation.evidence,
        })),
        ...assessment.employmentEvaluations.flatMap((evaluation) =>
          evaluation.intervals.map((interval) => ({
            factIds: [interval.factId],
            evidence: interval.evidence,
          })),
        ),
      ],
      ctx,
    );
    const ids = [...assessment.atomJudgments, ...assessment.employmentEvaluations].map(
      (judgment) => judgment.atomId,
    );
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "An atom must have exactly one judgment input" });
  });
export type SaveRecruitingAssessmentInput = z.infer<typeof SaveRecruitingAssessmentInput>;

/** Full next facts and sources, with only affected semantic inputs supplied again. */
export const ReassessRecruitingAssessmentInput = SaveRecruitingAssessmentInput.safeExtend({
  expectedRevision: Revision,
});
export type ReassessRecruitingAssessmentInput = z.infer<typeof ReassessRecruitingAssessmentInput>;

export const RecruitingAssessmentAskTargetSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({ kind: z.literal("role"), criterionIds: z.array(RecruitingId).readonly() })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("candidate"),
      candidateKey: RecruitingId,
      assessmentVersion: Revision,
      criterionIds: z.array(RecruitingId).readonly(),
    })
    .readonly(),
]);
export type RecruitingAssessmentAskTarget = z.infer<typeof RecruitingAssessmentAskTargetSchema>;

export const RecruitingAssessmentAskInputSchema = z.strictObject({
  operation: z.literal("ask"),
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  target: RecruitingAssessmentAskTargetSchema,
  question: z.string().min(1).max(240).regex(/\S/, "Question must not be blank"),
  options: z
    .array(z.string().min(1).max(80).regex(/\S/, "Option must not be blank"))
    .min(2)
    .max(4)
    .refine((options) => new Set(options).size === options.length, {
      message: "Ask options must be unique",
    })
    .readonly(),
});
export type RecruitingAssessmentAskInput = z.infer<typeof RecruitingAssessmentAskInputSchema>;

export const RecruitingAssessmentToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read"), candidateKey: RecruitingId }),
  SaveRecruitingAssessmentInput.safeExtend({ operation: z.literal("save") }),
  ReassessRecruitingAssessmentInput.safeExtend({ operation: z.literal("reassess") }),
  RecruitingAssessmentAskInputSchema,
]);
export type RecruitingAssessmentToolInput = z.infer<typeof RecruitingAssessmentToolInputSchema>;
