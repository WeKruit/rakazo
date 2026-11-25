import type { PrismaClient } from "@rakazo/db";
import { listRecruitingGradedCandidateKeys } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CriterionVerdict, TextJudge } from "./judge.js";
import { linkedinPersonKey } from "./recruiting-profiles.js";
import { roundCriteria } from "./recruiting-round-check.js";

/**
 * Each person a search returned is checked once against everything the recruiter asked for: one
 * judge request per person answers every requirement. A person nobody graded gets their grade
 * from it; a person the search graded keeps the search's score and loses the fit only when the
 * profile clearly lacks a requirement. People already graded for the role are left alone, so a
 * grade changes only when the recruiter asks for it.
 */

/** A requirement counts as missing only when the judge is this sure the profile lacks it. */
const CLEARLY_ABSENT = 0.8;
/** A Worker keeps six outgoing requests open at once, so six people are judged together. */
const TOGETHER = 6;
const PROFILE_CHARS = 6_000;
/** A search that returns more people than this grades them itself. */
const MOST_PEOPLE = 120;

export type CriteriaCheck = {
  /** The role revision whose requirements judged this person. */
  requirementsRevision: number;
  criteria: Array<{ id: string; statement: string; level: string; confidence: number }>;
  match_tier: string;
  match_score: number;
};

/** The grade a person's verdicts give: who clearly lacks a requirement is not a fit. */
export function criteriaGrade(
  verdicts: readonly CriterionVerdict[],
  searched?: { tier: string; score: number },
): { match_tier: string; match_score: number } {
  const missing = verdicts.some((verdict) => verdict.absent >= CLEARLY_ABSENT);
  if (searched)
    return {
      match_tier:
        missing && (searched.tier === "Strong" || searched.tier === "Promising")
          ? "Partial"
          : searched.tier,
      match_score: searched.score,
    };
  const shown = verdicts.reduce((sum, verdict) => sum + (1 - verdict.absent), 0);
  return {
    match_tier: missing
      ? "Partial"
      : verdicts.every((verdict) => verdict.level !== "absent")
        ? "Strong"
        : "Promising",
    match_score: Math.round((100 * shown) / verdicts.length),
  };
}

function profileState(row: Record<string, unknown>): Record<string, unknown> {
  const { _profile, profile_image_url, email, match_score, match_tier, ...shown } = row;
  const text = JSON.stringify(shown);
  return text.length > PROFILE_CHARS ? { profile: text.slice(0, PROFILE_CHARS) } : shown;
}

/**
 * Judges the entries' people and writes each one's check beside their row. Any failure, or a
 * deployment without a judge, leaves the entries as they were.
 */
export async function checkPeopleCriteria(
  judgeSettings: { resolve(): Promise<TextJudge | undefined> } | undefined,
  prisma: PrismaClient,
  role: { roleId: string; spaceId: string; revision: number; request?: string },
  entries: Array<{ row: Record<string, unknown>; check?: CriteriaCheck }>,
): Promise<void> {
  try {
    const judge = await judgeSettings?.resolve();
    if (!judge?.criteria || !entries.length || entries.length > MOST_PEOPLE) {
      getLogger().info("recruiting.criteria.check skipped", {
        judge: !!judge?.criteria,
        people: entries.length,
      });
      return;
    }
    const stated = (await roundCriteria(prisma, role)).map(({ id, statement }) => ({
      id,
      statement,
    }));
    // A role with nothing saved yet is judged on what the search itself asked for.
    const requirements = stated.length
      ? stated.slice(0, 20)
      : role.request?.trim()
        ? [{ id: "search-request", statement: role.request.trim().slice(0, 1_000) }]
        : [];
    if (!requirements.length) {
      getLogger().info("recruiting.criteria.check skipped", { requirements: 0 });
      return;
    }
    const graded = new Set(await listRecruitingGradedCandidateKeys(prisma, role.roleId));
    const fresh = entries.filter((entry) => {
      const key =
        typeof entry.row.linkedin_url === "string"
          ? linkedinPersonKey(entry.row.linkedin_url)
          : null;
      return !key || !graded.has(key);
    });
    const deadline = AbortSignal.timeout(12_000);
    for (let at = 0; at < fresh.length && !deadline.aborted; at += TOGETHER)
      await Promise.all(
        fresh.slice(at, at + TOGETHER).map(async (entry) => {
          const verdicts = await judge.criteria?.(profileState(entry.row), requirements, deadline);
          if (!verdicts) return;
          const answered = requirements.filter((requirement) => verdicts.has(requirement.id));
          const { match_tier: tier, match_score: score } = entry.row;
          entry.check = {
            requirementsRevision: role.revision,
            criteria: answered.map((requirement) => ({
              ...requirement,
              level: verdicts.get(requirement.id)!.level,
              confidence: verdicts.get(requirement.id)!.confidence,
            })),
            ...criteriaGrade(
              answered.map((requirement) => verdicts.get(requirement.id)!),
              typeof tier === "string" && typeof score === "number" ? { tier, score } : undefined,
            ),
          };
        }),
      );
    getLogger().info("recruiting.criteria.check", {
      roleId: role.roleId,
      requirements: requirements.length,
      people: entries.length,
      alreadyGraded: entries.length - fresh.length,
      checked: entries.filter((entry) => entry.check).length,
    });
  } catch (error) {
    getLogger().warn("recruiting.criteria.check failed", { error: String(error) });
  }
}
