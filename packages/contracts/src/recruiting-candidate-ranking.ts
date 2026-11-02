import * as z from "zod";

export const RecruitingCandidateRankingGroupSchema = z.enum([
  "strong_match",
  "worth_talking",
  "partial",
  "uncertain",
  "outdated",
  "unreviewed",
  "unscored",
]);
export const RecruitingCandidateRankingSchema = z.strictObject({
  source: z.enum(["reviewer", "provider", "none"]),
  state: z.enum(["current", "outdated", "unreviewed"]),
  roleRevisionId: z.string().nullable(),
  sourceEffectId: z.string().nullable(),
  grade: z.string().nullable(),
  score: z.number().nullable(),
  group: RecruitingCandidateRankingGroupSchema,
});
export type RecruitingCandidateRanking = z.infer<typeof RecruitingCandidateRankingSchema>;

/** Presentation of saved grades only: never infer Reviewer authorship from a tier or score. */
export function recruitingCandidateRanking(input: {
  source: RecruitingCandidateRanking["source"];
  grade: string | null;
  score: number | null;
  roleRevisionId: string | null;
  sourceEffectId: string | null;
  currentRoleRevisionId: string;
}): RecruitingCandidateRanking {
  const { source, grade, score, roleRevisionId, sourceEffectId } = input;
  const state =
    source === "reviewer"
      ? roleRevisionId === input.currentRoleRevisionId
        ? "current"
        : "outdated"
      : "unreviewed";
  const group =
    state === "outdated"
      ? "outdated"
      : state === "current"
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
