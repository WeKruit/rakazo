import * as z from "zod";
import { RecruitingCandidateRankingGroupSchema } from "./recruiting-candidate-ranking.js";
import { RecruitingId, VerdictSchema } from "./recruiting-identifiers.js";

const Text = z.string().trim().min(1);

export const ListRecruitingCandidatesInput = z.strictObject({
  roleId: RecruitingId,
  cursor: Text.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  /** Rows to skip for a numbered page; a cursor takes precedence. */
  offset: z.number().int().min(0).max(6000).optional(),
  query: z.string().max(240).optional(),
  assessmentState: z.enum(["unassessed", "current", "outdated"]).optional(),
  verdict: VerdictSchema.optional(),
  shortlisted: z.boolean().optional(),
  shortlistedSince: z.iso.datetime().optional(),
  actionId: RecruitingId.optional(),
  sourceEffectId: RecruitingId.optional(),
  rankingGroup: RecruitingCandidateRankingGroupSchema.optional(),
  sort: z.enum(["name", "recent", "rank", "tier", "score", "ranking"]).optional(),
});
export type ListRecruitingCandidatesInput = z.infer<typeof ListRecruitingCandidatesInput>;
