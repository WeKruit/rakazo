import * as z from "zod";

export const RecruitingCandidateRankingGroupSchema = z.enum([
  "strong_match",
  "worth_talking",
  "partial",
  "uncertain",
  "unreviewed",
  "unscored",
]);
export const RecruitingCandidateRankingSchema = z.strictObject({
  source: z.enum(["reviewer", "provider", "none"]),
  state: z.enum(["current", "unreviewed"]),
  roleRevisionId: z.string().nullable(),
  sourceEffectId: z.string().nullable(),
  grade: z.string().nullable(),
  score: z.number().nullable(),
  group: RecruitingCandidateRankingGroupSchema,
});
export type RecruitingCandidateRanking = z.infer<typeof RecruitingCandidateRankingSchema>;

/**
 * Presentation of saved grades only. Source "reviewer" is a person's newest saved tier, whoever
 * gave it (the search grades the people it returns); "provider" is a bare score with no tier. A
 * person keeps their latest grade when the role's requirements change: grades are never
 * redone or marked stale (big-ask 11-25: one loosened requirement showed all 123 people as
 * needing a new review and hid the 70 Strong/Promising).
 */
export function recruitingCandidateRanking(input: {
  source: RecruitingCandidateRanking["source"];
  grade: string | null;
  score: number | null;
  roleRevisionId: string | null;
  sourceEffectId: string | null;
  currentRoleRevisionId: string;
}): RecruitingCandidateRanking {
  const { source, grade, score, roleRevisionId, sourceEffectId } = input;
  const state = source === "reviewer" ? "current" : "unreviewed";
  const group =
    state === "current"
      ? ((
          {
            Strong: "strong_match",
            Promising: "worth_talking",
            Partial: "partial",
            Uncertain: "uncertain",
          } as const
        )[grade as "Strong"] ?? "uncertain")
      : score === null
        ? "unscored"
        : "unreviewed";
  return { source, state, roleRevisionId, sourceEffectId, grade, score, group };
}
