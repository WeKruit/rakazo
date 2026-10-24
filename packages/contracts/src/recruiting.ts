import * as z from "zod";
import { ArtifactJsonStringPathSchema } from "./builtin-tools.js";
import { Id, IsoDate } from "./ids.js";
import { RecruitingCrmCandidateSyncSchema, RecruitingCrmTargetSchema } from "./recruiting-crm.js";

export const RecruitingId = Id.refine((value) => value.trim().length > 0, "ID must not be blank");

export const ReadRecruitingSourceInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("role"),
    threadId: Id,
    roleRevisionId: RecruitingId,
    sourceRefId: RecruitingId,
  }),
  z.strictObject({
    kind: z.literal("assessment"),
    roleId: RecruitingId,
    candidateKey: RecruitingId,
    version: z.number().int().positive(),
    sourceRefId: RecruitingId,
  }),
]);
export type ReadRecruitingSourceInput = z.infer<typeof ReadRecruitingSourceInput>;

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
    id: RecruitingId.describe(
      "One local ID identifies one exact full reference across the role and all criteria. Reuse it only with the unchanged full object; different quotes require different IDs, even from the same artifact.",
    ),
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
const SourceRefs = z
  .array(RecruitingSourceRefSchema)
  .readonly()
  .describe(
    "Full source reference objects, never source ID strings. Copy native anchors and read metadata exactly.",
  );
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

const BriefOrigin = z.enum(["user_instruction", "jd", "hm", "inferred"]);
const SearchFilterEdit = z.strictObject({
  id: RecruitingId,
  statement: Text,
  mode: z.enum(["include", "exclude", "prefer"]),
});
const SearchFilters = z
  .array(SearchFilterEdit.extend({ origin: BriefOrigin, sourceRefIds: z.array(RecruitingId) }))
  .refine(
    (filters) => new Set(filters.map((filter) => filter.id)).size === filters.length,
    "Search filter IDs must be unique",
  );

export const RecruitingBriefDraftSchema = z.strictObject({
  searchFilters: SearchFilters,
  fields: z.array(
    z.strictObject({
      key: Text,
      value: Text.nullable(),
      origin: BriefOrigin,
      state: z.enum(["known", "missing", "conflict"]),
      consequential: z.boolean(),
      sourceRefIds: z
        .array(RecruitingId)
        .describe(
          "Known non-inferred fields require sourceRefIds naming exact read references with quotes. user_instruction must cite the actual human-message reference, using native current-turn messageId, readAt and text-block metadata; assign its local source ID before creating the role.",
        ),
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
  rules: z
    .array(
      z.strictObject({
        criterionId: RecruitingId,
        origin: BriefOrigin,
        effect: z.enum(["flag", "reject"]),
        sourceRefIds: z.array(RecruitingId),
      }),
    )
    .describe(
      "One rule for every criterion, using its exact criterionId, origin, effect and sourceRefIds. An empty rules array is valid only when criteria is empty; inferred rules are flag-only and require a preferred criterion.",
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

export const EditRecruitingCriteriaInput = z
  .strictObject({
    threadId: RecruitingId,
    roleId: RecruitingId,
    expectedRevision: Revision,
    searchFilters: z
      .array(SearchFilterEdit)
      .refine(
        (filters) => new Set(filters.map((filter) => filter.id)).size === filters.length,
        "Search filter IDs must be unique",
      )
      .optional(),
    criteria: z
      .array(
        z.strictObject({
          criterionId: RecruitingId,
          priority: z.enum(["hard", "preferred"]),
          atoms: z
            .array(
              z.union([
                z.strictObject({ atomId: RecruitingId, statement: Text }),
                z.strictObject({
                  atomId: RecruitingId,
                  employmentRule: RecruitingEmploymentRuleSchema,
                }),
              ]),
            )
            .min(1)
            .refine(
              (atoms) => new Set(atoms.map((atom) => atom.atomId)).size === atoms.length,
              "Atom IDs must be unique",
            ),
        }),
      )
      .refine(
        (criteria) =>
          new Set(criteria.map((criterion) => criterion.criterionId)).size === criteria.length,
        "Criterion IDs must be unique",
      ),
  })
  .superRefine((input, ctx) => {
    if (!input.criteria.length && input.searchFilters === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Provide criteria or search filter edits",
      });
  });
export type EditRecruitingCriteriaInput = z.infer<typeof EditRecruitingCriteriaInput>;

const RoleDefinition = {
  brief: RecruitingBriefDraftSchema.nullable().optional(),
  sourceRefs: z.array(RecruitingSourceRefSchema).readonly(),
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
  /** Playbook stage (intake | calibration_10 | feedback | scale | enrichment | outreach | replies | screening | submission | interview | closed). */
  playbookStage: z.string().optional(),
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
const RecruitingCandidateEvidenceReference = {
  providerTaskId: RecruitingId,
  roleRevisionId: RecruitingId,
  effectId: RecruitingId,
  rowIndex: z.number().int().nonnegative(),
  artifactRef: RecruitingArtifactRefSchema,
};
const RecruitingApprovalProfile = {
  candidateKey: RecruitingId,
  linkedinUrl: z.httpUrl().refine((url) => new URL(url).protocol === "https:"),
  evidenceUrl: z.httpUrl(),
};
const RecruitingDocumentsApprovalInputSchema = z.strictObject({
  ...RecruitingApprovalScope,
  stage: z.literal("documents"),
  documents: z.strictObject({
    jdText: RecruitingArtifactRefSchema,
    namedPdf: RecruitingArtifactRefSchema,
    anonymousPdf: RecruitingArtifactRefSchema.nullable(),
    deck: RecruitingArtifactRefSchema.nullable(),
  }),
});
const RecruitingCalibrationApproval = {
  ...RecruitingApprovalScope,
  stage: z.literal("calibration"),
  documentsApprovalEffectId: RecruitingId,
  ruleChanges: z.array(Text).readonly(),
};
export const RecruitingApprovalToolInputSchema = z.discriminatedUnion("stage", [
  z.strictObject({ ...RecruitingApprovalScope, stage: z.literal("brief") }),
  RecruitingDocumentsApprovalInputSchema,
  z.strictObject({
    ...RecruitingCalibrationApproval,
    profiles: z
      .array(
        z.strictObject({
          ...RecruitingApprovalProfile,
          source: z.strictObject(RecruitingCandidateEvidenceReference),
        }),
      )
      .length(10),
  }),
]);
export type RecruitingApprovalToolInput = z.infer<typeof RecruitingApprovalToolInputSchema>;
/**
 * What the agent sends. A calibration request may omit the documents approval, the profiles and
 * the rule changes: the server fills in this revision's approved documents and the recorded
 * calibration round before the request is saved, so the stored request always matches
 * RecruitingApprovalToolInputSchema.
 */
export const RecruitingApprovalToolCallSchema = z.discriminatedUnion("stage", [
  RecruitingApprovalToolInputSchema.options[0],
  RecruitingApprovalToolInputSchema.options[1],
  RecruitingApprovalToolInputSchema.options[2].extend({
    documentsApprovalEffectId: RecruitingId.optional(),
    profiles: RecruitingApprovalToolInputSchema.options[2].shape.profiles.optional(),
    ruleChanges: RecruitingCalibrationApproval.ruleChanges.default([]),
  }),
]);

/** Decode exact retained requests only; historical assessments are never new native evidence. */
export const RetainedRecruitingApprovalRequestSchema = z.union([
  RecruitingApprovalToolInputSchema,
  z.strictObject({
    ...RecruitingCalibrationApproval,
    profiles: z
      .array(
        z.strictObject({
          ...RecruitingApprovalProfile,
          assessmentVersion: Revision,
        }),
      )
      .length(10),
  }),
]);
export type RetainedRecruitingApprovalRequest = z.infer<
  typeof RetainedRecruitingApprovalRequestSchema
>;

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

export const RECRUITING_CANDIDATE_OUTPUT_SCHEMA = "candidate_output_v1" as const;
export const RecruitingCandidateOutputRowSchema = z.looseObject({
  name: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  current_title: z.string().nullable(),
  current_company: z.string().nullable(),
  location: z.string().nullable(),
  resume_url: z.string().nullable(),
  evidence_urls: z.array(z.string()).readonly().nullable(),
});
export type RecruitingCandidateOutputRow = z.infer<typeof RecruitingCandidateOutputRowSchema>;
export const RECRUITING_CANDIDATE_OUTPUT_JSON_SCHEMA = z.toJSONSchema(
  RecruitingCandidateOutputRowSchema,
);
export const RecruitingCandidateOutputSchemaId = z.literal(RECRUITING_CANDIDATE_OUTPUT_SCHEMA);
export const RecruitingCandidateProfileSchema = z.strictObject({
  name: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  linkedinUrl: z.httpUrl().nullable(),
  resumeUrl: z.httpUrl().nullable(),
  evidenceUrls: z.array(z.httpUrl()).readonly().nullable(),
  issues: z.array(z.string()).readonly(),
});
export type RecruitingCandidateProfile = z.infer<typeof RecruitingCandidateProfileSchema>;

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
  candidateOutputSchema: RecruitingCandidateOutputSchemaId.nullable().optional(),
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

/** One saved native read, not a new search or a provider task state. */
export const RecruitingResearchSavedObservationSchema = z.strictObject({
  effectId: RecruitingId,
  providerTaskId: RecruitingId,
  roleRevisionId: RecruitingId,
  runId: RecruitingId,
  rowCount: z.number().int().nonnegative().nullable(),
  observedAt: IsoDate,
  requestCursor: z.string().nullable(),
  artifactRef: RecruitingArtifactRefSchema,
});

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
  rows: z.array(z.unknown()).optional(),
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
        path: ArtifactJsonStringPathSchema,
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
  sourceRefs: z.array(RecruitingSourceRefSchema).min(1).readonly(),
});
export type CreateRecruitingRoleInput = z.infer<typeof CreateRecruitingRoleInput>;

export const ReviseRecruitingRoleInput = z.strictObject({
  roleId: RecruitingId,
  expectedRevision: Revision,
  title: Text,
  ...RoleDefinition,
  sourceRefs: z.array(RecruitingSourceRefSchema).min(1).readonly(),
});
export type ReviseRecruitingRoleInput = z.infer<typeof ReviseRecruitingRoleInput>;

export const RecruitingHumanIntentSchema = z.strictObject({
  basis: z.enum(["direct", "inferred"]),
  quote: Text.describe(
    "One exact contiguous substring from one actual current human text block, preserving whitespace; do not normalize whitespace or join blocks.",
  ),
});
export type RecruitingHumanIntent = z.infer<typeof RecruitingHumanIntentSchema>;

const PreferenceAnchor = z.union([
  z
    .strictObject({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      quote: z.string().min(1),
    })
    .refine((anchor) => anchor.end > anchor.start, { message: "Anchor end must follow its start" }),
  z.strictObject({ quote: z.string().min(1) }),
]);
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
const CandidateRevisions = z.array(
  z.strictObject({
    candidateKey: RecruitingId,
    expectedRevision: z.number().int().nonnegative(),
  }),
);
function validateCandidateDecision(
  input: {
    candidateKeys: string[];
    candidateRevisions?: { candidateKey: string }[];
    operation?: string;
    choice?: string;
  },
  ctx: z.RefinementCtx,
) {
  const decision = input.operation ?? input.choice;
  if (!["hold", "pass", "resume"].includes(decision ?? "")) return;
  const revisions = input.candidateRevisions;
  if (
    !revisions ||
    revisions.length !== input.candidateKeys.length ||
    new Set(revisions.map((item) => item.candidateKey)).size !== revisions.length ||
    revisions.some((item) => !input.candidateKeys.includes(item.candidateKey))
  )
    ctx.addIssue({
      code: "custom",
      path: ["candidateRevisions"],
      message: "Provide one current revision for every selected candidate",
    });
}
export const RecruitingFeedbackInputSchema = z.discriminatedUnion("target", [
  z.strictObject({ ...ScopedFeedback, target: z.literal("role"), operation: z.literal("revise") }),
  // approve: the recruiter's own words accept the current calibration round and allow scale.
  z.strictObject({
    ...ScopedFeedback,
    target: z.literal("round"),
    operation: z.enum(["scope", "approve"]),
  }),
  z
    .strictObject({
      ...ScopedFeedback,
      target: z.literal("candidate"),
      operation: z.enum(["review", "hold", "pass", "resume"]),
      candidateRevisions: CandidateRevisions.optional(),
      candidateKeys: z
        .array(RecruitingId)
        .min(1)
        .refine((keys) => new Set(keys).size === keys.length, "Candidate keys must be unique"),
    })
    .superRefine(validateCandidateDecision),
  RecruitingPreferenceFeedbackSchema,
]);
export type RecruitingFeedbackInput = z.infer<typeof RecruitingFeedbackInputSchema>;

export const RecruitingFeedbackChoiceSchema = z.enum([
  "good_example",
  "not_fit",
  "skip",
  "hold",
  "pass",
  "resume",
]);
export const RecruitingCandidateFeedbackSelectionSchema = z
  .strictObject({
    roleId: RecruitingId,
    roleRevisionId: RecruitingId,
    expectedRoleRevision: Revision,
    candidateKeys: z
      .array(RecruitingId)
      .min(1)
      .refine((keys) => new Set(keys).size === keys.length, "Candidate keys must be unique"),
    choice: RecruitingFeedbackChoiceSchema,
    candidateRevisions: CandidateRevisions.optional(),
  })
  .superRefine(validateCandidateDecision);
export type RecruitingCandidateFeedbackSelection = z.infer<
  typeof RecruitingCandidateFeedbackSelectionSchema
>;
export const RecruitingFeedbackRecordSchema = z.strictObject({
  id: RecruitingId,
  createdAt: IsoDate,
  roleRevisionId: RecruitingId,
  feedback: RecruitingFeedbackInputSchema,
  source: RecruitingSourceRefSchema,
  choice: RecruitingFeedbackChoiceSchema.optional(),
});
export type RecruitingFeedbackRecord = z.infer<typeof RecruitingFeedbackRecordSchema>;
export const ListRecruitingFeedbackInput = z.strictObject({
  roleId: RecruitingId,
  candidateKey: RecruitingId.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  before: RecruitingId.optional(),
});
export const ListRecruitingFeedbackOutput = z.strictObject({
  feedback: z.array(RecruitingFeedbackRecordSchema),
  nextCursor: RecruitingId.nullable(),
});

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
  // Partial revise: send only what changes; the server merges it onto expectedRevision.
  z.strictObject({
    operation: z.literal("update"),
    roleId: RecruitingId,
    expectedRevision: Revision,
    intent: RecruitingHumanIntentSchema,
    title: Text.optional(),
    brief: RoleToolDefinition.brief,
    sourceRefs: SourceRefs.optional(),
    criteria: z
      .strictObject({
        upsert: z
          .array(RecruitingCriterionSchema.unwrap().extend({ sourceRefs: SourceRefs }))
          .readonly()
          .optional(),
        remove: z.array(RecruitingId).readonly().optional(),
      })
      .optional(),
    preferences: RoleToolDefinition.preferences.optional(),
    definitionQuestions: RoleToolDefinition.definitionQuestions.optional(),
  }),
  // Reversible hide: sets/clears archivedAt without a new revision. Non-empty roles need force.
  z.strictObject({
    operation: z.literal("archive"),
    roleId: RecruitingId,
    expectedRevision: Revision,
    intent: RecruitingHumanIntentSchema,
    force: z.boolean().optional(),
  }),
  z.strictObject({
    operation: z.literal("unarchive"),
    roleId: RecruitingId,
    expectedRevision: Revision,
    intent: RecruitingHumanIntentSchema,
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
export const RECRUITING_CALIBRATION_ROUND_SIZE = 10;
export const RecruitingResearchToolInputSchema = z.discriminatedUnion("operation", [
  // Marks the exact ten saved people this calibration round shows the recruiter.
  z.strictObject({
    operation: z.literal("calibration_round"),
    expectedRoleRevision: Revision,
    candidateKeys: z
      .array(RecruitingId)
      .length(RECRUITING_CALIBRATION_ROUND_SIZE)
      .refine((keys) => new Set(keys).size === keys.length, "Candidate keys must be unique"),
  }),
  z.strictObject({
    operation: z.literal("save_results"),
    expectedRoleRevision: Revision,
    mcpServerId: RecruitingId.optional(),
    providerTaskId: RecruitingId,
    cursor: z.string().min(1).nullable().default(null),
  }),
  // Recruiter-supplied text/csv artifact saved as one unassessed candidate page; values are column names.
  z.strictObject({
    operation: z.literal("import_csv"),
    roleId: RecruitingId,
    expectedRoleRevision: Revision,
    artifactId: RecruitingId,
    mapping: z.strictObject({
      name: ResearchText,
      linkedinUrl: ResearchText.optional(),
      company: ResearchText.optional(),
      title: ResearchText.optional(),
      location: ResearchText.optional(),
      resumeUrl: ResearchText.optional(),
    }),
  }),
  z.strictObject({
    ...ResearchRoundInput,
    operation: z.literal("prepare"),
    mcpServerId: RecruitingId,
  }),
  z.discriminatedUnion("purpose", [
    z.strictObject({
      ...ResearchRoundInput,
      operation: z.literal("continue"),
      purpose: z.literal("calibration"),
      taskId: RecruitingId,
    }),
    z.strictObject({
      ...ResearchRoundInput,
      operation: z.literal("continue"),
      purpose: z.literal("scale"),
      taskId: RecruitingId.optional(),
    }),
  ]),
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

export const ListRecruitingCandidatesInput = z.strictObject({
  roleId: RecruitingId,
  cursor: Text.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().max(240).optional(),
  assessmentState: z.enum(["unassessed", "current", "outdated"]).optional(),
  verdict: VerdictSchema.optional(),
  shortlisted: z.boolean().optional(),
  actionId: RecruitingId.optional(),
  sourceEffectId: RecruitingId.optional(),
  sort: z.enum(["name", "recent", "rank", "tier", "score"]).optional(),
});
export type ListRecruitingCandidatesInput = z.infer<typeof ListRecruitingCandidatesInput>;
// These are transport/provenance fields, not provider observations about the person.
const reportMetadata = new Set([
  "id",
  "taskid",
  "taskids",
  "providertaskid",
  "artifactid",
  "artifactids",
  "artifactref",
  "actionid",
  "effectid",
  "runid",
  "threadid",
  "roleid",
  "rolerevisionid",
  "sourceid",
  "shardid",
  "shardids",
  "outputid",
  "receiptid",
  "request",
  "response",
  "route",
  "routing",
  "cursor",
  "nextcursor",
  "requestcursor",
  "providerresult",
  "observation",
  "metadata",
  "traceid",
  "storagekey",
  "sha256",
  "hash",
  "toolname",
  "connectorid",
  "resourceid",
  "resourcerevision",
  "cataloggroup",
  "clientnonce",
]);

/** The same business/provenance boundary governs report display and retained row equivalence. */
export function isRecruitingCandidateReportField(key: string): boolean {
  return !key.startsWith("_") && !reportMetadata.has(key.replace(/[_-]/g, "").toLowerCase());
}

/** Recruiter-visible source text excludes operational IDs; immutable artifacts remain lossless. */
export function recruitingCandidateSourceText(value: unknown): string | undefined {
  return JSON.stringify(
    value,
    (key, nested) => (!key || isRecruitingCandidateReportField(key) ? nested : undefined),
    2,
  );
}

/** Recruiter-readable projection of one exact retained provider row, never qualification. */
export const RecruitingCandidateReportSchema = z.strictObject({
  fields: z.array(
    z
      .strictObject({
        label: Text,
        value: z.string().nullable(),
        // Retained provider observations, not locally inferred profile facts.
        structuredValue: z.json().optional(),
        sourceIds: z.array(z.string()).optional(),
        sourceUrlsById: z.record(z.string(), z.array(z.httpUrl())).optional(),
        providerStatus: z.enum(["match", "miss", "unclear"]).optional(),
        evidence: z.string().optional(),
        reasoning: z.string().optional(),
        sourceUrls: z.array(z.httpUrl()),
      })
      .refine(
        (field) => field.providerStatus === undefined || field.providerStatus === field.value,
        "Provider display status must preserve the supplied value",
      ),
  ),
  sourceUrls: z.array(z.httpUrl()),
});
export type RecruitingCandidateReport = z.infer<typeof RecruitingCandidateReportSchema>;

const RecruitingCandidateSourceReferenceSchema = z
  .strictObject({
    report: RecruitingCandidateReportSchema.optional(),
    ...RecruitingCandidateEvidenceReference,
    // Null for a recruiter-imported CSV page, which has no provider task.
    providerTaskId: RecruitingId.nullable(),
    taskId: RecruitingId.nullable(),
    actionId: RecruitingId.nullable(),
    requestCursor: z.string().nullable(),
    outputId: z.string().nullable(),
    observedAt: IsoDate,
  })
  .refine((source) => (source.taskId === null) === (source.actionId === null), {
    message: "Task and action references must be present or null together",
  });
export const RecruitingCandidateSourceSchema = RecruitingCandidateSourceReferenceSchema.safeExtend({
  crmImports: z.array(RecruitingCrmCandidateSyncSchema),
});
export type RecruitingCandidateSource = z.infer<typeof RecruitingCandidateSourceSchema>;

// Server-written business state; this snapshot is never accepted as native tool input.
export const RecruitingCandidateConsiderationSchema = z.strictObject({
  operation: z.enum(["hold", "pass", "resume"]),
  source: z.strictObject({
    messageId: RecruitingId,
    threadId: RecruitingId,
    seq: z.number().int().nonnegative(),
    createdAt: IsoDate,
    quote: Text,
    actor: z.strictObject({ userId: RecruitingId, spaceId: RecruitingId }),
  }),
});

export const RecruitingCandidateSchema = z.strictObject({
  latestSource: RecruitingCandidateSourceReferenceSchema.optional(),
  crm: RecruitingCrmCandidateSyncSchema.nullable(),
  roleId: RecruitingId,
  candidateKey: RecruitingId,
  ...RecruitingCandidateProfileSchema.shape,
  shortlisted: z.boolean(),
  shortlistedAt: IsoDate.nullable(),
  /** Provider match cells; rank/score are comparable only within one saved result. */
  match: z
    .strictObject({
      rank: z.number().nullable(),
      tier: z.string().nullable(),
      score: z.number().nullable(),
    })
    .optional(),
  decision: z.enum(["hold", "pass", "resume"]).nullable(),
  decisionReason: RecruitingCandidateConsiderationSchema.shape.source.shape.quote.nullable(),
  decisionAt: RecruitingCandidateConsiderationSchema.shape.source.shape.createdAt.nullable(),
  revision: z.number().int().nonnegative(),
  discoveryCount: z.number().int().nonnegative(),
  firstDiscoveredAt: IsoDate.nullable(),
  lastDiscoveredAt: IsoDate.nullable(),
  latestAssessment: z
    .strictObject({
      version: Revision,
      roleRevisionId: RecruitingId,
      createdAt: IsoDate,
      isCurrent: z.boolean(),
      hardGate: VerdictSchema,
    })
    .nullable(),
});
export type RecruitingCandidate = z.infer<typeof RecruitingCandidateSchema>;
export const ListRecruitingCandidatesOutput = z.strictObject({
  sortAvailability: z.strictObject({ rank: z.boolean(), tier: z.boolean(), score: z.boolean() }),
  crmTarget: z
    .strictObject({ bindingEffectId: RecruitingId.nullable(), target: RecruitingCrmTargetSchema })
    .nullable(),
  roleId: RecruitingId,
  roleRevisionId: RecruitingId,
  items: z.array(RecruitingCandidateSchema),
  nextCursor: Text.nullable(),
  total: z.number().int().nonnegative(),
  counts: z.strictObject({
    sourceRows: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    identifiedCandidates: z.number().int().nonnegative(),
    unassessed: z.number().int().nonnegative(),
    assessed: z.number().int().nonnegative(),
    shortlisted: z.number().int().nonnegative(),
  }),
});
export type ListRecruitingCandidatesOutput = z.infer<typeof ListRecruitingCandidatesOutput>;
/** One merged person per row: Autumn search result and/or the role's CRM contact. */
export const RecruitingRoleCandidatesInputFields = {
  threadId: RecruitingId,
  limit: z.number().int().min(1).max(100).optional(),
  cursor: Text.optional(),
  sort: z.enum(["score", "rank", "name", "recent"]).optional(),
  query: z.string().max(240).optional(),
  shortlistedOnly: z.boolean().optional(),
};
export const RecruitingCrmProfileSchema = z.object({
  history: z.json(),
  summary: z.string(),
  skills: z.array(z.string()),
  sources: z.array(
    z.object({
      id: z.uuid(),
      company: z.string().nullable(),
      title: z.string().nullable(),
      location: z.string().nullable(),
      syncedAt: z.string(),
    }),
  ),
});
export const RecruitingRoleCandidateSchema = z.strictObject({
  key: Text,
  name: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  email: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  autumn: z
    .strictObject({
      candidateKey: RecruitingId,
      score: z.number().nullable(),
      rank: z.number().nullable(),
      tier: z.string().nullable(),
      matchSummary: z.string().nullable(),
      criteria: z.array(
        z.strictObject({
          label: Text,
          status: z.enum(["match", "miss", "unclear"]),
          evidence: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  crm: z
    .strictObject({
      serverId: RecruitingId,
      organizationId: z.uuid(),
      candidateId: z.uuid(),
      stage: z.string().nullable(),
      contactStatus: z.string(),
      outreachStatus: z.string(),
      phone: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      profile: RecruitingCrmProfileSchema.optional(),
      interest: z.string().nullable().optional(),
      reviewed: z.boolean().nullable().optional(),
      lastReplyAt: IsoDate.nullable().optional(),
      resumeReceived: z.boolean().nullable().optional(),
    })
    .nullable(),
  shortlisted: z.boolean(),
  shortlistedAt: IsoDate.nullable(),
});
export type RecruitingRoleCandidate = z.infer<typeof RecruitingRoleCandidateSchema>;
export const RecruitingRoleCandidatesOutputSchema = z.strictObject({
  items: z.array(RecruitingRoleCandidateSchema),
  nextCursor: Text.nullable(),
  total: z.number().int().nonnegative(),
  /** `shortlisted` (Autumn) and `replied` always; plus one count per CRM outreachStatus. */
  counts: z
    .object({
      shortlisted: z.number().int().nonnegative(),
      replied: z.number().int().nonnegative(),
    })
    .catchall(z.number().int().nonnegative()),
  crmStatus: z.enum(["ok", "not_bound", "unavailable"]),
  /** Readability is not completeness: absent/false means CRM counts are observed partial data. */
  crmCountsComplete: z.boolean().optional(),
});
export type RecruitingRoleCandidatesOutput = z.infer<typeof RecruitingRoleCandidatesOutputSchema>;

export const SetRecruitingCandidateShortlistInput = z.strictObject({
  threadId: RecruitingId,
  roleId: RecruitingId,
  candidateKey: RecruitingId,
  expectedRevision: z.number().int().nonnegative(),
  shortlisted: z.boolean(),
});
export type SetRecruitingCandidateShortlistInput = z.infer<
  typeof SetRecruitingCandidateShortlistInput
>;
export const SetRecruitingCandidateShortlistOutput = z.strictObject({
  roleId: RecruitingId,
  candidateKey: RecruitingId,
  shortlisted: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type SetRecruitingCandidateShortlistOutput = z.infer<
  typeof SetRecruitingCandidateShortlistOutput
>;
export const RecruitingShortlistToolInputSchema = SetRecruitingCandidateShortlistInput.omit({
  threadId: true,
}).extend({ expectedRoleRevision: Revision });
export const RecruitingShortlistToolResultSchema = SetRecruitingCandidateShortlistOutput.extend({
  kind: z.literal("saved"),
});
export const ListRecruitingCandidateSourcesInput = z.strictObject({
  roleId: RecruitingId,
  candidateKey: RecruitingId,
  cursor: Text.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListRecruitingCandidateSourcesInput = z.infer<
  typeof ListRecruitingCandidateSourcesInput
>;
export const RecruitingCandidatesToolInputSchema = z.discriminatedUnion("operation", [
  ListRecruitingCandidatesInput.pick({ query: true, cursor: true, limit: true }).extend({
    operation: z.literal("list"),
  }),
  ListRecruitingCandidateSourcesInput.omit({ roleId: true }).extend({
    operation: z.literal("sources"),
  }),
  z.strictObject({ operation: z.literal("resolve"), nameOrEmail: Text.max(240) }),
  z.strictObject({ operation: z.literal("round") }),
  z.strictObject({
    operation: z.literal("replies"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
]);
export type RecruitingCandidatesToolInput = z.infer<typeof RecruitingCandidatesToolInputSchema>;

export const ListRecruitingCandidateSourcesOutput = z.strictObject({
  roleId: RecruitingId,
  candidateKey: RecruitingId,
  items: z.array(RecruitingCandidateSourceSchema),
  nextCursor: Text.nullable(),
  total: z.number().int().nonnegative(),
});
export type ListRecruitingCandidateSourcesOutput = z.infer<
  typeof ListRecruitingCandidateSourcesOutput
>;

/** Editable outreach output only; native artifacts/history own persistence, never sending state. */
export const RecruitingOutreachSequenceSchema = z.strictObject({
  kind: z.literal("wekruit.outreach-sequence"),
  version: z.literal(1),
  roleTitle: Text,
  recipients: z
    .array(
      z.strictObject({
        name: Text,
        linkedinUrl: z.httpUrl().nullable(),
        email: z.email().nullable(),
        steps: z
          .array(
            z.strictObject({
              subject: z.string(),
              body: z.string(),
              dayOffset: z.number().int().nonnegative().nullable(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  revisesArtifactId: RecruitingId.optional(),
});
export type RecruitingOutreachSequence = z.infer<typeof RecruitingOutreachSequenceSchema>;

/** Read-only presentation of retained provider receipts; never a send or booking command. */
const CorrespondenceOriginFields = {
  /** Provider identity evidence only; never inferred from subject or participants. */
  providerThreadId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  eaccount: z.string().nullable().optional(),
  sourceId: Id.max(200),
  providerMessageId: Id.max(1600),
  savedRead: z
    .strictObject({ messageId: Id.max(200), linkedRunId: Id.max(200), effectId: Id.max(200) })
    .nullable(),
};
const CorrespondenceCrmContext = z
  .strictObject({
    serverRevision: Revision,
    organizationId: z.uuid(),
    crmRoleId: z.uuid(),
    candidateId: z.uuid(),
    threadId: z.string().nullable(),
    campaignId: z.string().nullable().optional(),
    direction: z.enum(["sent", "received", "manual"]).nullable(),
    eaccount: z.string().nullable().optional(),
  })
  .optional();
export const RecruitingCorrespondenceReferenceSchema = z
  .strictObject({
    ...CorrespondenceOriginFields,
    crm: CorrespondenceCrmContext,
    threadId: Id.max(200),
    roleId: RecruitingId.max(200),
    emailId: Id.max(1600),
    sourceName: z.string().max(160),
    sender: z.string().max(320).nullable(),
    subject: z.string().max(1000),
    date: IsoDate.nullable(),
    snippet: z.boolean(),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 4096,
    "Email reference exceeds 4096 characters",
  );
export type RecruitingCorrespondenceReference = z.infer<
  typeof RecruitingCorrespondenceReferenceSchema
>;

const ChatContextText = z.string().trim().min(1).max(200);
/** Bounded workbench selection a role chat turn carries; never evidence or authorization. */
export const RecruitingChatContextSchema = z
  .strictObject({
    schedulingPlanId: Id.max(200).optional(),
    roleTitle: ChatContextText.optional(),
    contact: z
      .strictObject({ name: ChatContextText, reference: ChatContextText.optional() })
      .optional(),
  })
  .refine(
    (value) => value.roleTitle || value.contact || value.schedulingPlanId,
    "Chat context is empty",
  );
export type RecruitingChatContext = z.infer<typeof RecruitingChatContextSchema>;

/** Opaque token for offset-paged reads; callers pass back the previous page's `nextCursor` unchanged. */
export const RecruitingOffsetCursorSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,6})$/)
  .refine((value) => Number(value) <= 1_000_000);
export const RecruitingCorrespondenceInputPage = {
  /** Inbox emails per page (default 50); events and contacts keep their own bounds. */
  limit: z.number().int().min(1).max(200).optional(),
  cursor: RecruitingOffsetCursorSchema.optional(),
};
/**
 * The role's bound Instantly campaign, read live through the assigned connection. Statuses are the
 * provider's integers: campaign 0 draft, 1 active, 2 paused, 3 completed; lead 1 active, 2 paused,
 * 3 completed, -1 bounced, -2 unsubscribed.
 */
/** Observed provider fields only; null entries/fields denote unavailable or malformed data. */
export const RecruitingCampaignDetailsSchema = z.strictObject({
  schedules: z
    .array(
      z
        .strictObject({
          name: z.string().nullable(),
          from: z.string().nullable(),
          to: z.string().nullable(),
          timezone: z.string().nullable(),
          days: z.record(z.string(), z.boolean()).nullable(),
        })
        .nullable(),
    )
    .nullable(),
  sequences: z
    .array(
      z
        .strictObject({
          steps: z
            .array(
              z
                .strictObject({
                  type: z.string().nullable(),
                  delay: z.number().nonnegative().nullable(),
                  delayUnit: z.string().nullable(),
                  variants: z
                    .array(
                      z
                        .strictObject({
                          subject: z.string().nullable(),
                          body: z.string().nullable(),
                        })
                        .nullable(),
                    )
                    .nullable(),
                })
                .nullable(),
            )
            .nullable(),
        })
        .nullable(),
    )
    .nullable(),
});
export type RecruitingCampaignDetails = z.infer<typeof RecruitingCampaignDetailsSchema>;

export const RecruitingRoleCampaignSchema = z.strictObject({
  /** Multiple exact role mappings require an explicit selection from roleCampaigns. */
  selectionRequired: z.boolean().optional(),
  status: z.enum(["none", "unavailable", "ready"]),
  /** The assigned Instantly connection; null when none is assigned to this conversation. */
  serverId: z.string().nullable(),
  campaign: z
    .strictObject({
      id: z.string(),
      name: z.string(),
      eaccount: z.string().nullable(),
      status: z.number().int().nullable(),
      stopOnReply: z.boolean().nullable(),
      observedDetails: RecruitingCampaignDetailsSchema.optional(),
    })
    .nullable(),
  /** Whether the lead page proves a complete, valid list; absent means unknown. */
  leadsComplete: z.boolean().optional(),
  leads: z.array(
    z.strictObject({
      candidateKey: z.string().nullable(),
      email: z.string(),
      status: z.number().int().nullable(),
      interestStatus: z.number().int().nullable(),
    }),
  ),
});
export type RecruitingRoleCampaign = z.infer<typeof RecruitingRoleCampaignSchema>;

/** Role setup checklist: what a role still needs before its first outreach works out of the box. */
export const RecruitingRoleSetupSchema = z.strictObject({
  ready: z.boolean(),
  /** A run in this role's conversation is waiting for the human (e.g. the send confirmation). */
  attention: z
    .strictObject({
      kind: z.enum(["approval", "question"]),
      threadId: Id,
      cardId: Id.nullable(),
      createdAt: IsoDate,
    })
    .nullable(),
  /** Where the role is in the recruiting playbook; label and next step are display text. */
  playbookStage: z
    .strictObject({
      stage: z.enum([
        "intake",
        "calibration_10",
        "feedback",
        "scale",
        "enrichment",
        "outreach",
        "replies",
        "screening",
        "submission",
        "interview",
        "closed",
      ]),
      label: z.string(),
      nextStep: z.string().nullable().optional(),
    })
    .optional(),
  items: z.array(
    z.strictObject({
      key: z.enum(["campaign", "sender", "crm", "leads"]),
      state: z.enum(["ready", "missing", "unavailable"]),
      label: z.string().optional(),
      detail: z.record(z.string(), z.unknown()).optional(),
      action: z
        .strictObject({
          kind: z.enum(["ask_agent", "connect", "bind"]),
          prompt: z.string().optional(),
          serverId: z.string().optional(),
          options: z.array(z.strictObject({ orgId: z.string(), roleLabel: z.string() })).optional(),
        })
        .optional(),
    }),
  ),
});
export type RecruitingRoleSetup = z.infer<typeof RecruitingRoleSetupSchema>;

export const RecruitingCorrespondenceSchema = z.strictObject({
  /** Actual reply failures/uncertainty, not a confirmation-to-booking association. */
  operations: z
    .array(
      z.strictObject({
        id: Id,
        kind: z.literal("reply"),
        outcome: z.enum(["failed", "uncertain"]),
        checkedAt: IsoDate,
        sourceName: z.string(),
        sourceId: Id,
        providerMessageId: Id,
      }),
    )
    .optional(),
  roleId: RecruitingId.nullable(),
  status: z.enum(["not_checked", "ready", "empty", "unsupported", "failed"]),
  checkedAt: IsoDate.nullable(),
  connectionChanged: z.boolean(),
  connections: z.array(
    z.strictObject({
      name: z.string(),
      status: z.enum(["configured", "needs_connection", "needs_access", "disabled", "unavailable"]),
      checkIssue: z
        .strictObject({ status: z.enum(["failed", "unsupported"]), checkedAt: IsoDate })
        .nullable(),
    }),
  ),
  emails: z.array(
    z.strictObject({
      id: Id,
      sourceName: z.string(),
      ...CorrespondenceOriginFields,
      /** Optional provider observations, never application viewed-by state or current totals. */
      unread: z.boolean().nullable().optional(),
      leadId: z.uuid().nullable().optional(),
      /** Provider-supplied step text; not an inferred stable step ID. */
      step: z.string().nullable().optional(),
      observedAt: IsoDate.optional(),
      crm: CorrespondenceCrmContext,
      sender: z.string().nullable(),
      recipients: z.array(z.string()),
      subject: z.string(),
      body: z.string(),
      snippet: z.boolean(),
      date: IsoDate.nullable(),
      url: z.httpUrl().nullable(),
    }),
  ),
  events: z.array(
    z.strictObject({
      id: Id,
      kind: z.enum(["event", "availability"]),
      title: z.string().nullable(),
      start: IsoDate,
      end: IsoDate.nullable(),
      timeZone: z.string().nullable(),
      attendees: z.array(z.string()),
      status: z.string().nullable(),
      location: z.string().nullable(),
      url: z.httpUrl().nullable(),
    }),
  ),
  contacts: z.array(
    z.strictObject({
      candidateKey: RecruitingId,
      linkedinUrl: z.httpUrl(),
      emails: z.array(z.strictObject({ address: z.email(), status: z.string().nullable() })),
      phones: z.array(z.strictObject({ number: z.string(), type: z.string().nullable() })),
      source: z.string(),
      checkedAt: IsoDate,
    }),
  ),
  partial: z.boolean(),
  /** Next inbox email page; null on the last page and for interview/contacts views. */
  nextCursor: z.string().nullable(),
});
export type RecruitingCorrespondence = z.infer<typeof RecruitingCorrespondenceSchema>;

/** A retained native operation record, never delivery confirmation or permission to retry. */
export const RecruitingNativeCorrespondenceSchema = z
  .strictObject({
    id: Id,
    roleId: RecruitingId,
    bindingEffectId: Id,
    crmRoleId: z.uuid(),
    candidateId: z.uuid(),
    status: z.enum(["read", "sent_recorded", "scheduled", "unknown"]),
    checkedAt: IsoDate,
    email: RecruitingCorrespondenceSchema.shape.emails.element.nullable(),
  })
  .refine(
    (value) => (value.status === "unknown") === (value.email === null),
    "Only unknown operations have no message record",
  );

const CrmBrowseSource = z.strictObject({
  serverId: Id,
  serverRevision: Revision,
  name: z.string(),
});
const CrmBrowseRole = z.strictObject({
  crmRoleId: z.uuid(),
  clientId: z.uuid(),
  clientLabel: z.string(),
  roleLabel: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable().optional(),
  jdText: z.string().nullable().optional(),
  jdUrl: z.string().nullable().optional(),
});
const CrmBrowseCursor = z.strictObject({
  p_org: z.uuid(),
  p_candidate: z.uuid(),
  linked_offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 51),
  unlinked_offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 51),
});
const CrmRoleMailCursor = z.strictObject({
  p_org: z.uuid(),
  p_role: z.uuid(),
  p_candidate: z.uuid(),
  offset: z.number().int().min(0).max(1_000_000),
});
const CrmMailCursor = z.union([CrmBrowseCursor, CrmRoleMailCursor]);
const CrmBrowseWorkflow = z.enum([
  "waiting_resume",
  "resume_ready",
  "introduced",
  "needs_scheduling",
  "scheduled",
  "awaiting_feedback",
]);
const CrmBrowseImportantStatus = z.enum(["high_signal", ...CrmBrowseWorkflow.options]);
const CrmBrowseCandidate = z.strictObject({
  candidateId: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  location: z.string().nullable(),
  title: z.string().nullable(),
  stage: z.string().nullable(),
  contactStatus: z.string(),
  outreachStatus: z.string(),
  roleSpecId: z.uuid().nullable(),
  legacyClientLabel: z.string(),
  legacyRoleLabel: z.string(),
  /** Present when the connected CRM returns them. */
  interest: z.string().nullable().optional(),
  reviewed: z.boolean().nullable().optional(),
  lastReplyAt: IsoDate.nullable().optional(),
  resumeReceived: z.boolean().nullable().optional(),
  company: z.string().nullable().optional(),
  profile: RecruitingCrmProfileSchema.optional(),
});
const CrmBrowseTracking = z.strictObject({
  roleKey: z.string().min(1),
  clientLabel: z.string(),
  roleLabel: z.string(),
  highSignal: z.boolean(),
  workflowStatus: CrmBrowseWorkflow.nullable(),
  highSignalAt: IsoDate.nullable(),
  statusChangedAt: IsoDate.nullable(),
  updatedAt: IsoDate,
});
const CrmBrowseCampaign = z.strictObject({
  id: Id,
  name: z.string(),
  status: z.number().int().nullable(),
  crmRoleId: z.uuid().nullable(),
  clientId: z.uuid().nullable(),
  syncedAt: IsoDate,
});
const CrmBrowseOutbox = z.array(
  z.strictObject({
    id: z.uuid(),
    body: z.string(),
    status: z.enum(["pending", "processing", "sent", "failed"]),
    polishedBody: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: IsoDate,
    sentAt: IsoDate.nullable(),
  }),
);
const CrmMailItem = z.strictObject({
  campaignId: z.string().nullable().optional(),
  eaccount: z.string().nullable().optional(),
  id: Id,
  providerMessageId: Id,
  threadId: z.string().nullable(),
  direction: z.enum(["sent", "received", "manual"]).nullable(),
  sender: z.string().nullable(),
  recipients: z.array(z.string()),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  date: IsoDate.nullable(),
  partial: z.boolean(),
});
const crmBrowsePinned = { serverId: Id, serverRevision: Revision, organizationId: z.uuid() };
const crmBrowsePage = { limit: z.number().int().min(1).max(50).optional() };
/** Opaque page token for offset-backed CRM reads (the CRM tools page by p_offset); pass back `nextCursor`. */
const crmOffsetPage = {
  offset: z.number().int().min(0).max(1_000_000).optional(),
  cursor: RecruitingOffsetCursorSchema.optional(),
};
const crmNextCursor = { nextCursor: z.string().nullable() };
/** Live authorized CRM reads; these IDs are never local role, group, run or effect IDs. */
export const RecruitingCrmDataInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("memberships"),
      serverId: Id.optional(),
      serverRevision: Revision.optional(),
    })
    .refine(
      (value) => Boolean(value.serverId) === (value.serverRevision !== undefined),
      "Pin both source ID and revision",
    ),
  z.object({ operation: z.literal("roles"), ...crmBrowsePinned }),
  z.object({
    operation: z.literal("presence"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    candidateIds: z.array(z.uuid()).min(1).max(50),
    crmRoleId: z.uuid().optional(),
  }),
  z.object({
    operation: z.literal("candidates"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    crmRoleId: z.uuid().optional(),
    query: z.string().max(500).optional(),
    /** Exact stored CRM pipeline stage, e.g. "Interview". */
    stage: z.string().trim().min(1).max(200).optional(),
    ...crmOffsetPage,
  }),
  z.object({
    operation: z.literal("important"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    status: CrmBrowseImportantStatus.optional(),
    ...crmOffsetPage,
  }),
  z.object({
    operation: z.literal("candidateDetails"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    candidateId: z.uuid(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  }),
  z.object({
    operation: z.literal("roleCampaigns"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    crmRoleId: z.uuid(),
    ...crmOffsetPage,
  }),
  z.object({
    operation: z.literal("mail"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    candidateId: z.uuid(),
    crmRoleId: z.uuid().optional(),
    cursor: CrmMailCursor.optional(),
  }),
  z.object({
    operation: z.literal("roleMail"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    crmRoleId: z.uuid(),
    ...crmOffsetPage,
  }),
  /** Every stored outreach campaign of the organization, including ones with no role. */
  z.object({
    operation: z.literal("campaigns"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    ...crmOffsetPage,
  }),
  /** One stored campaign's lead stats. */
  z.object({
    operation: z.literal("campaignLeads"),
    ...crmBrowsePinned,
    ...crmBrowsePage,
    campaignId: Id,
    ...crmOffsetPage,
  }),
]);
export type RecruitingCrmDataInput = z.infer<typeof RecruitingCrmDataInputSchema>;
export const RecruitingCrmDataOutputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("presence"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    candidateIds: z.array(z.uuid()),
    roleCandidateIds: z.array(z.uuid()).optional(),
  }),
  z.strictObject({
    operation: z.literal("memberships"),
    checkedAt: IsoDate,
    sources: z.array(
      CrmBrowseSource.extend({
        status: z.enum(["ready", "unavailable"]),
        memberships: z.array(
          z.strictObject({
            organizationId: z.uuid(),
            name: z.string().nullable(),
            role: z.string(),
          }),
        ),
      }),
    ),
  }),
  z.strictObject({
    operation: z.literal("roles"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    items: z.array(CrmBrowseRole),
  }),
  z.strictObject({
    operation: z.literal("candidates"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    scope: z.enum(["organization", "legacy_role_labels", "stored_role"]),
    selectedRole: CrmBrowseRole.nullable(),
    items: z.array(CrmBrowseCandidate),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    ...crmNextCursor,
  }),
  z.strictObject({
    operation: z.literal("important"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    scope: z.literal("organization_candidate_roles"),
    items: z.array(CrmBrowseCandidate.extend(CrmBrowseTracking.shape)),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    ...crmNextCursor,
  }),
  z.strictObject({
    operation: z.literal("candidateDetails"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    scope: z.literal("stored_candidate_details"),
    outbox: CrmBrowseOutbox,
    candidateId: z.uuid(),
    review: z
      .strictObject({
        id: z.uuid(),
        crmRoleId: z.uuid().nullable(),
        stage: z.string().nullable(),
        reviewed: z.boolean().nullable(),
        result: z.enum(["approved", "rejected", "pooled"]).nullable(),
        notes: z.string().nullable(),
        updatedAt: IsoDate,
        candidateName: z.string().nullable(),
        roleTitle: z.string().nullable(),
      })
      .nullable(),
    roleTracking: z.array(CrmBrowseTracking),
    roleInterests: z.array(
      z.strictObject({
        roleKey: z.string().min(1),
        clientLabel: z.string(),
        roleLabel: z.string(),
        interest: z.enum(["interested", "declined", "unknown"]),
        source: z.enum(["manual", "ai", "instantly"]).nullable(),
      }),
    ),
    campaignAssociations: z.strictObject({
      leadCampaigns: z.array(
        z.strictObject({
          leadId: Id,
          campaignId: Id.nullable(),
          campaign: CrmBrowseCampaign.nullable(),
        }),
      ),
      pipelineCampaign: CrmBrowseCampaign.nullable(),
      offset: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().nullable(),
    }),
  }),
  z.strictObject({
    operation: z.literal("roleCampaigns"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    scope: z.literal("stored_role_campaigns"),
    crmRoleId: z.uuid(),
    items: z.array(CrmBrowseCampaign.omit({ crmRoleId: true, clientId: true })),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    ...crmNextCursor,
  }),
  z.strictObject({
    operation: z.literal("mail"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    scope: z.literal("stored_candidate_correspondence"),
    outboxScope: z.literal("unavailable_for_role").optional(),
    outbox: CrmBrowseOutbox,
    candidateId: z.uuid(),
    nativeCorrespondence: z.array(RecruitingNativeCorrespondenceSchema),
    items: z.array(CrmMailItem),
    nextCursor: CrmMailCursor.nullable(),
  }),
  z.strictObject({
    operation: z.literal("roleMail"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    scope: z.literal("stored_role_correspondence"),
    crmRoleId: z.uuid(),
    /** False when the connected CRM has no role-wide mail read; callers read per candidate instead. */
    supported: z.boolean(),
    items: z.array(CrmMailItem.extend({ candidateId: z.uuid() })),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    ...crmNextCursor,
  }),
  z.strictObject({
    operation: z.literal("campaigns"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    items: z.array(
      z.strictObject({
        id: Id,
        name: z.string(),
        status: z.number().int().nullable(),
        crmRoleId: z.uuid().nullable(),
        clientId: z.uuid().nullable(),
        createdAt: IsoDate.nullable(),
        updatedAt: IsoDate.nullable(),
        syncedAt: IsoDate,
      }),
    ),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    ...crmNextCursor,
  }),
  z.strictObject({
    operation: z.literal("campaignLeads"),
    source: CrmBrowseSource.extend({ organizationId: z.uuid() }),
    checkedAt: IsoDate,
    campaignId: Id,
    items: z.array(
      z.strictObject({
        id: Id,
        candidateId: z.uuid().nullable(),
        status: z.number().int().nullable(),
        interestStatus: z.number().int().nullable(),
        openCount: z.number().int().nullable(),
        replyCount: z.number().int().nullable(),
        lastContactAt: IsoDate.nullable(),
        lastReplyAt: IsoDate.nullable(),
        syncedAt: IsoDate,
      }),
    ),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    ...crmNextCursor,
  }),
]);
export type RecruitingCrmDataOutput = z.infer<typeof RecruitingCrmDataOutputSchema>;

/** Existing first-party CRM MCP payloads, validated before projecting the live read view. */
export const RecruitingCrmMembershipRowsSchema = z.array(
  z.object({
    organization_id: z.uuid(),
    role: z.string(),
    organizations: z.object({ name: z.string() }).nullable(),
  }),
);
export const RecruitingCrmMessagesReadSchema = z.array(
  z.object({
    id: z.uuid(),
    organization_id: z.uuid(),
    candidate_id: z.uuid(),
    author_user_id: z.uuid(),
    body: z.string(),
    status: z.enum(["pending", "processing", "sent", "failed"]),
    polished_body: z.string().nullable(),
    instantly_email_id: z.string().nullable(),
    error: z.string().nullable(),
    created_at: IsoDate,
    sent_at: IsoDate.nullable(),
  }),
);
const CrmNativeRole = z.object({
  role_spec_id: z.uuid(),
  role_label: z.string(),
  summary: z.string().nullable(),
});
export const RecruitingCrmClientsReadSchema = z.array(
  z.object({ client_id: z.uuid(), client_label: z.string(), roles: z.array(CrmNativeRole) }),
);
export const RecruitingCrmRoleReadSchema = CrmNativeRole.extend({
  client_id: z.uuid(),
  client_label: z.string(),
  description: z.string().nullable(),
  jd_text: z.string().nullable(),
  jd_url: z.string().nullable(),
});
export const RecruitingCrmCandidatesReadSchema = z.object({
  total: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      candidate_id: z.uuid(),
      full_name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      linkedin_url: z.string().nullable(),
      location: z.string().nullable().optional(),
      headline: z.string().nullable().optional(),
      stage: z.string().nullable(),
      contact_status: z.string(),
      outreach_status: z.string(),
      role_spec_id: z.uuid().nullable(),
      client_label: z.string(),
      role_label: z.string(),
      interest: z.string().nullable().optional(),
      reviewed: z.boolean().nullable().optional(),
      last_reply_at: IsoDate.nullable().optional().catch(null),
      resume_received: z.boolean().nullable().optional(),
      company: z.string().nullable().optional(),
      profile: RecruitingCrmProfileSchema.optional(),
    }),
  ),
});
const CrmStoredEmail = z.object({
  id: z.string().min(1),
  organization_id: z.uuid(),
  candidate_id: z.uuid().nullable(),
  lead_email: z.string().nullable(),
  thread_id: z.string().nullable(),
  direction: z.enum(["sent", "received", "manual"]).nullable(),
  timestamp_email: IsoDate.nullable(),
  campaign_id: z.string().nullable(),
  from_address: z.string().nullable(),
  to_address: z.string().nullable(),
  subject: z.string().nullable(),
  body_text: z.string().nullable(),
});
const CrmStoredTime = IsoDate.nullable();
export const RecruitingCrmCampaignsReadSchema = z.object({
  organization_id: z.uuid(),
  campaigns: z.array(
    z.object({
      id: Id,
      name: z.string(),
      status: z.number().int().nullable(),
      role_spec_id: z.uuid().nullable(),
      client_id: z.uuid().nullable(),
      timestamp_created: CrmStoredTime,
      timestamp_updated: CrmStoredTime,
      synced_at: IsoDate,
    }),
  ),
  pagination: z.literal("offset"),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const RecruitingCrmCampaignLeadsReadSchema = z.object({
  organization_id: z.uuid(),
  campaign_id: Id,
  leads: z.array(
    z.object({
      id: Id,
      candidate_id: z.uuid().nullable(),
      status: z.number().int().nullable(),
      interest_status: z.number().int().nullable(),
      email_open_count: z.number().int().nullable(),
      email_reply_count: z.number().int().nullable(),
      timestamp_last_contact: CrmStoredTime,
      timestamp_last_reply: CrmStoredTime,
      synced_at: IsoDate,
    }),
  ),
  pagination: z.literal("offset"),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const RecruitingCrmRoleMailReadSchema = z.object({
  version: z.literal(2),
  candidate_id: z.uuid().nullable().optional(),
  organization_id: z.uuid(),
  role_id: z.uuid(),
  pagination: z.literal("offset"),
  messages: z.array(
    CrmStoredEmail.extend({ candidate_id: z.uuid(), eaccount: z.string().nullable().optional() }),
  ),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const RecruitingCrmMailReadSchema = z.object({
  organization_id: z.uuid(),
  candidate_id: z.uuid(),
  pagination: z.literal("offset"),
  messages: z.array(CrmStoredEmail),
  next_cursor: CrmBrowseCursor.nullable(),
});

const CrmNativeTracking = z.object({
  role_key: z.string().min(1),
  client_label: z.string(),
  role_label: z.string(),
  high_signal: z.boolean(),
  workflow_status: CrmBrowseWorkflow.nullable(),
  high_signal_at: IsoDate.nullable(),
  status_changed_at: IsoDate.nullable(),
  updated_at: IsoDate,
});
const CrmNativeCampaign = z.object({
  id: Id,
  name: z.string(),
  status: z.number().int().nullable(),
  role_spec_id: z.uuid().nullable(),
  client_id: z.uuid().nullable(),
  synced_at: IsoDate,
});
export const RecruitingCrmImportantReadSchema = z.object({
  total: z.number().int().nonnegative(),
  rows: z.array(
    RecruitingCrmCandidatesReadSchema.shape.rows.element.extend({
      role_tracking: z.tuple([CrmNativeTracking.omit({ client_label: true, role_label: true })]),
    }),
  ),
});
export const RecruitingCrmDetailsReadSchema = z.object({
  organization_id: z.uuid(),
  candidate_id: z.uuid(),
  review: z
    .object({
      id: z.uuid(),
      organization_id: z.uuid(),
      candidate_id: z.uuid(),
      role_spec_id: z.uuid().nullable(),
      stage: z.string().nullable(),
      reviewed: z.boolean().nullable(),
      review_result: z.enum(["approved", "rejected", "pooled"]).nullable(),
      notes: z.string().nullable(),
      updated_at: IsoDate,
      candidate_full_name: z.string().nullable(),
      canonical_role_title: z.string().nullable(),
      reviewId: z.uuid().optional(),
    })
    .nullable(),
  role_tracking: z.array(CrmNativeTracking.extend({ candidate_id: z.uuid() })),
  role_interests: z.array(
    z.object({
      role_key: z.string().min(1),
      client_label: z.string(),
      role_label: z.string(),
      interest: z.enum(["interested", "declined", "unknown"]),
      source: z.enum(["manual", "ai", "instantly"]).nullable(),
    }),
  ),
  campaign_associations: z.object({
    lead_campaigns: z.array(
      z.object({ lead_id: Id, campaign_id: Id.nullable(), campaign: CrmNativeCampaign.nullable() }),
    ),
    pipeline_campaign: CrmNativeCampaign.nullable(),
    pagination: z.literal("offset"),
    offset: z.number().int().nonnegative(),
    next_offset: z.number().int().nonnegative().nullable(),
  }),
});
export const RecruitingCrmRoleCampaignsReadSchema = z.object({
  organization_id: z.uuid(),
  role_spec_id: z.uuid(),
  campaigns: z.array(CrmNativeCampaign.omit({ role_spec_id: true, client_id: true })),
  pagination: z.literal("offset"),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
});

// Owner-scoped follow-up reminders (role and/or candidate), shared by RPC and the agent tool.
export const RecruitingReminderStatusSchema = z.enum(["open", "done", "dismissed"]);
const ReminderCandidateKey = Text.max(300).regex(
  /^(autumn|crm):\S+$/,
  'Use "autumn:<key>" or "crm:<id>"',
);
/** Actual profile opens, retained in the existing native event history. */
export const RecruitingProfileActivityInput = z.strictObject({
  roleId: RecruitingId,
  candidateKey: ReminderCandidateKey,
});
export const RecordRecruitingProfileViewInput = RecruitingProfileActivityInput.extend({
  viewId: z.uuid(),
});
export const RecruitingProfileViewSchema = z.strictObject({
  roleTitle: z.string(),
  id: Id,
  at: IsoDate,
  actorName: z.string().nullable(),
});
export const RecruitingProfileActivityOutput = z.strictObject({
  items: z.array(RecruitingProfileViewSchema),
  hasMore: z.boolean(),
});
export type RecruitingProfileView = z.infer<typeof RecruitingProfileViewSchema>;
export type RecruitingProfileActivityInput = z.infer<typeof RecruitingProfileActivityInput>;
export type RecordRecruitingProfileViewInput = z.infer<typeof RecordRecruitingProfileViewInput>;
const ReminderTitle = Text.max(200);
const ReminderNote = z.string().max(4000);
export const RecruitingReminderSchema = z.strictObject({
  id: RecruitingId,
  roleId: RecruitingId.nullable(),
  candidateKey: z.string().nullable(),
  title: z.string(),
  note: z.string().nullable(),
  dueAt: IsoDate,
  status: RecruitingReminderStatusSchema,
  completedAt: IsoDate.nullable(),
  createdBy: z.enum(["user", "agent"]),
  createdAt: IsoDate,
});
export type RecruitingReminder = z.infer<typeof RecruitingReminderSchema>;
export const ListRecruitingRemindersInput = z.strictObject({
  candidateKey: ReminderCandidateKey.optional(),
  /** Match any of these keys (OR with `candidateKey`), e.g. a person's search-result and CRM keys. */
  candidateKeys: z.array(ReminderCandidateKey).max(10).optional(),
  roleId: RecruitingId.optional(),
  status: RecruitingReminderStatusSchema.optional(),
  dueBefore: IsoDate.optional(),
});
export type ListRecruitingRemindersInput = z.infer<typeof ListRecruitingRemindersInput>;
export const ListRecruitingRemindersOutput = z.strictObject({
  items: z.array(RecruitingReminderSchema),
  overdueCount: z.number().int().min(0),
});
export const CreateRecruitingReminderInput = z.strictObject({
  roleId: RecruitingId.optional(),
  candidateKey: ReminderCandidateKey.optional(),
  title: ReminderTitle,
  note: ReminderNote.optional(),
  dueAt: IsoDate,
});
export type CreateRecruitingReminderInput = z.infer<typeof CreateRecruitingReminderInput>;
export const UpdateRecruitingReminderInput = z.strictObject({
  id: RecruitingId,
  title: ReminderTitle.optional(),
  note: ReminderNote.nullable().optional(),
  dueAt: IsoDate.optional(),
  status: RecruitingReminderStatusSchema.optional(),
});
export type UpdateRecruitingReminderInput = z.infer<typeof UpdateRecruitingReminderInput>;
export const DeleteRecruitingReminderInput = z.strictObject({ id: RecruitingId });
export const RecruitingRemindersToolInputSchema = z.discriminatedUnion("operation", [
  ListRecruitingRemindersInput.extend({ operation: z.literal("list") }),
  CreateRecruitingReminderInput.extend({ operation: z.literal("create") }),
  UpdateRecruitingReminderInput.extend({ operation: z.literal("update") }),
  DeleteRecruitingReminderInput.extend({ operation: z.literal("delete") }),
]);
export type RecruitingRemindersToolInput = z.infer<typeof RecruitingRemindersToolInputSchema>;

/** Copies the user's CRM roles, contacts, role links and role mail into the product's own rows. */
export const RecruitingCrmSyncInputFields = {
  /** Reads everything and reports what would change; writes nothing. */
  dryRun: z.boolean().optional(),
  /** Pass back `nextCursor` until it is null; each call does a bounded slice of the reads. */
  cursor: z.string().max(65_536).optional(),
};
const RecruitingCrmSyncCounts = z.strictObject({
  seen: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  restored: z.number().int().nonnegative(),
});
export type RecruitingCrmSyncCounts = z.infer<typeof RecruitingCrmSyncCounts>;
export const RecruitingCrmSyncOutputSchema = z.strictObject({
  dryRun: z.boolean(),
  startedAt: IsoDate,
  nextCursor: z.string().nullable(),
  organizations: z.number().int().nonnegative(),
  roles: RecruitingCrmSyncCounts,
  contacts: RecruitingCrmSyncCounts,
  links: RecruitingCrmSyncCounts,
  messages: RecruitingCrmSyncCounts,
  /** Stored outreach campaigns and their lead stats. Never archived by the sync. */
  campaigns: RecruitingCrmSyncCounts,
  leads: RecruitingCrmSyncCounts,
  /** Reads that could not complete; their rows are left as they were (nothing archived). */
  skipped: z.array(
    z.strictObject({
      organizationId: z.uuid().nullable(),
      crmRoleId: z.uuid().nullable(),
      step: z.enum(["organizations", "roles", "contacts", "links", "mail", "campaigns", "leads"]),
      reason: z.string(),
    }),
  ),
});
export type RecruitingCrmSyncOutput = z.infer<typeof RecruitingCrmSyncOutputSchema>;

/** Server-side progress of a CRM sync, carried between calls; every read it names is re-authorized. */
const CrmSyncCursorCounts = z.object({
  seen: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  restored: z.number().int().nonnegative(),
});
const emptyCrmSyncCursorCounts = () => ({
  seen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  restored: 0,
});
export const RecruitingCrmSyncCursorSchema = z.object({
  v: z.literal(1),
  dryRun: z.boolean(),
  startedAt: z.iso.datetime(),
  orgs: z.array(
    z.object({
      s: z.string(),
      r: z.number().int().positive(),
      o: z.uuid(),
      roles: z.array(z.uuid()),
      /** Filled when this organization's campaign list completes; drives the leads step. */
      campaigns: z.array(Id).optional(),
    }),
  ),
  at: z.object({
    g: z.number().int().nonnegative(),
    step: z.enum(["contacts", "links", "mail", "campaigns", "leads"]),
    j: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    /** Stored active rows this pass has matched so far, for the dry-run archive count. */
    matched: z.number().int().nonnegative(),
    seen: z.array(z.uuid()),
  }),
  totals: z.object({
    roles: CrmSyncCursorCounts,
    contacts: CrmSyncCursorCounts,
    links: CrmSyncCursorCounts,
    messages: CrmSyncCursorCounts,
    // Progress saved before campaigns were synced has no campaign totals yet.
    campaigns: CrmSyncCursorCounts.default(emptyCrmSyncCursorCounts),
    leads: CrmSyncCursorCounts.default(emptyCrmSyncCursorCounts),
  }),
  skipped: RecruitingCrmSyncOutputSchema.shape.skipped,
});
export type RecruitingCrmSyncCursor = z.infer<typeof RecruitingCrmSyncCursorSchema>;

export const RecruitingCrmPresenceReadSchema = z.object({
  version: z.literal(2),
  candidate_ids: z.array(z.uuid()).max(50),
  role_candidate_ids: z.array(z.uuid()).max(50).nullable(),
});
// Owner-scoped candidate notes, shared by RPC and the agent tool. Same candidate keys as reminders.
const NoteBody = Text.max(8000);
export const RecruitingCandidateNoteSchema = z.strictObject({
  id: RecruitingId,
  roleId: RecruitingId.nullable(),
  candidateKey: z.string(),
  body: z.string(),
  createdBy: z.enum(["user", "agent"]),
  authorName: z.string().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type RecruitingCandidateNote = z.infer<typeof RecruitingCandidateNoteSchema>;
export const ListRecruitingCandidateNotesInput = z.strictObject({
  candidateKeys: z.array(ReminderCandidateKey).min(1).max(10),
  roleId: RecruitingId.optional(),
});
export type ListRecruitingCandidateNotesInput = z.infer<typeof ListRecruitingCandidateNotesInput>;
export const ListRecruitingCandidateNotesOutput = z.strictObject({
  items: z.array(RecruitingCandidateNoteSchema),
});
export const CreateRecruitingCandidateNoteInput = z.strictObject({
  candidateKey: ReminderCandidateKey,
  roleId: RecruitingId.optional(),
  body: NoteBody,
});
export type CreateRecruitingCandidateNoteInput = z.infer<typeof CreateRecruitingCandidateNoteInput>;
export const UpdateRecruitingCandidateNoteInput = z.strictObject({
  id: RecruitingId,
  body: NoteBody,
});
export type UpdateRecruitingCandidateNoteInput = z.infer<typeof UpdateRecruitingCandidateNoteInput>;
export const DeleteRecruitingCandidateNoteInput = z.strictObject({ id: RecruitingId });
export const RecruitingNotesToolInputSchema = z.discriminatedUnion("operation", [
  ListRecruitingCandidateNotesInput.extend({ operation: z.literal("list") }),
  CreateRecruitingCandidateNoteInput.extend({ operation: z.literal("create") }),
  UpdateRecruitingCandidateNoteInput.extend({ operation: z.literal("update") }),
  DeleteRecruitingCandidateNoteInput.extend({ operation: z.literal("delete") }),
]);
export type RecruitingNotesToolInput = z.infer<typeof RecruitingNotesToolInputSchema>;
export const RecruitingCalibrationRoundSchema = z.strictObject({
  round: z.number().int().positive(),
  createdAt: IsoDate,
  approvedAt: IsoDate.nullable(),
  candidates: z.array(
    z.strictObject({
      candidateKey: RecruitingId,
      name: z.string().nullable(),
      title: z.string().nullable(),
      company: z.string().nullable(),
      location: z.string().nullable(),
      linkedinUrl: z.string().nullable(),
    }),
  ),
});
export type RecruitingCalibrationRound = z.infer<typeof RecruitingCalibrationRoundSchema>;
export const RecruitingCalibrationRoundOutput = z.strictObject({
  roleId: RecruitingId.nullable(),
  round: RecruitingCalibrationRoundSchema.nullable(),
});
export type RecruitingCalibrationRoundOutput = z.infer<typeof RecruitingCalibrationRoundOutput>;
