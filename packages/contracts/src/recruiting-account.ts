import * as z from "zod";
import { Id, IsoDate } from "./ids.js";
import {
  ListRecruitingCandidatesOutput,
  ListRecruitingFeedbackOutput,
  ListRecruitingRemindersOutput,
  RecruitingCorrespondenceSchema,
  RecruitingRoleCampaignSchema,
  RecruitingRoleCandidatesOutputSchema,
  RecruitingRoleRevisionSchema,
  RecruitingRoleSchema,
} from "./recruiting.js";
import {
  RecruitingSchedulingPlanSchema,
  RecruitingSchedulingSlotSchema,
} from "./recruiting-scheduling.js";

export const RecruitingAccountViewInputSchema = z.strictObject({
  view: z.enum([
    "roles",
    "brief",
    "feedback",
    "shortlist",
    "contacts",
    "sequence",
    "inbox",
    "interview",
    "tasks",
  ]),
  campaignId: Id.optional(),
  campaignServerId: Id.optional(),
  campaignLeadCursor: z.string().min(1).max(1600).optional(),
  roleId: Id.optional(),
  groupId: Id.optional(),
  itemCursor: z.string().min(1).max(10000).optional(),
  cursor: Id.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  since: IsoDate.optional(),
});
export const RecruitingAccountRoleSchema = z.strictObject({
  id: Id,
  title: z.string(),
  threadId: Id,
  groupId: Id.nullable(),
  stage: z.string(),
});
export const RecruitingAccountViewOutputSchema = z.strictObject({
  unassignedReminders: ListRecruitingRemindersOutput.optional(),
  roles: z.array(RecruitingAccountRoleSchema),
  items: z.array(
    z.strictObject({
      roleId: Id,
      workspace: z
        .strictObject({
          role: RecruitingRoleSchema,
          revision: RecruitingRoleRevisionSchema,
          crmTarget: ListRecruitingCandidatesOutput.shape.crmTarget,
        })
        .optional(),
      candidates: RecruitingRoleCandidatesOutputSchema.optional(),
      campaign: RecruitingRoleCampaignSchema.optional(),
      campaigns: z.array(RecruitingRoleCampaignSchema).optional(),
      correspondence: RecruitingCorrespondenceSchema.optional(),
      scheduling: z
        .strictObject({
          plans: z.array(RecruitingSchedulingPlanSchema),
          slots: z.array(RecruitingSchedulingSlotSchema.safeExtend({ observedAt: IsoDate })),
          partial: z.boolean(),
        })
        .optional(),
      reminders: ListRecruitingRemindersOutput.optional(),
      feedback: ListRecruitingFeedbackOutput.optional(),
    }),
  ),
  nextCursor: Id.nullable(),
});
export type RecruitingAccountViewInput = z.infer<typeof RecruitingAccountViewInputSchema>;
export type RecruitingAccountViewOutput = z.infer<typeof RecruitingAccountViewOutputSchema>;
