import * as z from "zod";
import { RecruitingId, VerdictSchema } from "./recruiting-identifiers.js";

const Text = z.string().trim().min(1);

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
