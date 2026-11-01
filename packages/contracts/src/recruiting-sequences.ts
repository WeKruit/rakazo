import { z } from "zod";
import { RecruitingBriefDraftSchema, RecruitingCampaignDetailsSchema } from "./recruiting.js";

export const RecruitingSequenceStepSchema = z.strictObject({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
  delay_days: z.number().int().min(0).max(366),
});
export const RecruitingSequenceDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  eaccount: z.email().max(254),
  steps: z.array(RecruitingSequenceStepSchema).min(1).max(10),
  timezone: z.string().min(1).max(64),
  send_hours: z.enum(["weekdays_9_to_5", "any_time"]),
});
const Scope = z.strictObject({ roleId: z.string().min(1), serverId: z.string().min(1) });
export const RecruitingSequenceInputSchema = z.discriminatedUnion("operation", [
  Scope.extend({ operation: z.literal("read"), campaignId: z.uuid().optional() }),
  Scope.extend({
    operation: z.literal("create"),
    clientNonce: z.string().min(1).max(200),
    draft: RecruitingSequenceDraftSchema,
  }),
  Scope.extend({
    operation: z.literal("save"),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    campaignId: z.uuid(),
    draft: RecruitingSequenceDraftSchema,
  }),
  Scope.extend({ operation: z.literal("pause"), campaignId: z.uuid() }),
  Scope.extend({
    operation: z.literal("response"),
    campaignId: z.uuid(),
    email: z.email(),
    response: z.enum(["none", "interested", "not_interested"]),
  }),
  Scope.extend({
    operation: z.literal("clone"),
    clientNonce: z.string().min(1).max(200),
    campaignId: z.uuid(),
    name: z.string().trim().min(1).max(200),
  }),
]);
export type RecruitingSequenceInput = z.infer<typeof RecruitingSequenceInputSchema>;
export type RecruitingSequenceDraft = z.infer<typeof RecruitingSequenceDraftSchema>;
export const RecruitingSequenceOutputSchema = z.strictObject({
  roleId: z.string(),
  response: z
    .strictObject({
      email: z.email(),
      interest: z.number().int().nullable(),
      state: z.enum(["saved", "pending"]),
    })
    .optional(),
  roleTitle: z.string(),
  roleBrief: RecruitingBriefDraftSchema.nullable().optional(),
  mailboxes: z.array(z.string()),
  unconfirmedDrafts: z.number().int().nonnegative().optional(),
  campaigns: z.array(z.strictObject({ id: z.uuid(), name: z.string() })).optional(),
  campaign: z
    .strictObject({
      id: z.uuid(),
      name: z.string(),
      status: z.number().int().nullable(),
      editable: z.boolean(),
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      observedDetails: RecruitingCampaignDetailsSchema.optional(),
      stopOnReply: z.boolean().nullable().optional(),
      eaccount: z.string().nullable(),
      steps: z.array(RecruitingSequenceStepSchema),
      timezone: z.string().nullable(),
      send_hours: z.enum(["weekdays_9_to_5", "any_time"]).nullable(),
    })
    .nullable(),
});
export type RecruitingSequenceOutput = z.infer<typeof RecruitingSequenceOutputSchema>;
