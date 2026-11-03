import type { Actor, RecruitingSearchQualityOutput } from "@rakazo/contracts";
import {
  RecruitingSearchQualityInputSchema,
  RecruitingSearchQualityOutputSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

/**
 * How the recruiter judged the people a role's search returned: their latest good example or
 * not a fit per person, from the feedback form and from feedback the agent saved from chat.
 * Counts only; the saved feedback keeps the reasons.
 */
export async function readRecruitingSearchQuality(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  raw: { roleId: string },
): Promise<RecruitingSearchQualityOutput> {
  const { roleId } = RecruitingSearchQualityInputSchema.parse(raw);
  const [row] = await prisma.$queryRaw<
    {
      owned: boolean;
      rounds: RecruitingSearchQualityOutput["rounds"];
      good: bigint;
      notfit: bigint;
    }[]
  >(Prisma.sql`
    WITH role AS (
      SELECT id FROM recruiting_roles
      WHERE id = ${roleId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    ), verdicts AS (
      SELECT key.value AS person, e.request->>'fit' AS fit, e."createdAt" AS at
      FROM external_effects e
      JOIN runs r ON r.id = e."runId" AND r."userId" = ${actor.userId} AND r."spaceId" = ${actor.spaceId}
      CROSS JOIN LATERAL jsonb_array_elements_text(e.request->'candidateKeys') key
      WHERE e."spaceId" = ${actor.spaceId} AND e.kind = 'recruiting_feedback' AND e.status = 'completed'
        AND e.request->>'roleId' = (SELECT id FROM role)
        AND e.request->>'target' = 'candidate'
        AND e.request->>'fit' IN ('good_example', 'not_fit')
        AND e.result->>'status' IN ('recorded', 'already_recorded')
      UNION ALL
      SELECT key.value, b->'recruitingFeedback'->>'choice', m."createdAt"
      FROM messages m
      JOIN threads t ON t.id = m."threadId" AND t."userId" = ${actor.userId} AND t."spaceId" = ${actor.spaceId}
      CROSS JOIN LATERAL jsonb_array_elements(m.blocks) b
      CROSS JOIN LATERAL jsonb_array_elements_text(b->'recruitingFeedback'->'candidateKeys') key
      WHERE m.role = 'user' AND m."botId" IS NULL
        AND m.blocks @> jsonb_build_array(jsonb_build_object('recruitingFeedback', jsonb_build_object('roleId', (SELECT id FROM role))))
        AND b->'recruitingFeedback'->>'roleId' = (SELECT id FROM role)
        AND b->'recruitingFeedback'->>'choice' IN ('good_example', 'not_fit')
    ), latest AS (
      SELECT DISTINCT ON (person) person, fit FROM verdicts ORDER BY person, at DESC
    )
    SELECT EXISTS (SELECT 1 FROM role) AS owned,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'round', c.round,
          'shown', cardinality(c."candidateKeys"),
          'goodExample', (SELECT count(*) FROM latest l WHERE l.person = ANY(c."candidateKeys") AND l.fit = 'good_example'),
          'notFit', (SELECT count(*) FROM latest l WHERE l.person = ANY(c."candidateKeys") AND l.fit = 'not_fit'),
          'accepted', c."approvedAt" IS NOT NULL
        ) ORDER BY c.round), '[]'::jsonb)
        FROM recruiting_calibration_rounds c WHERE c."roleId" = (SELECT id FROM role)) AS rounds,
      (SELECT count(*) FROM latest WHERE fit = 'good_example') AS good,
      (SELECT count(*) FROM latest WHERE fit = 'not_fit') AS notfit
  `);
  if (!row?.owned) throw new IsolationError();
  return RecruitingSearchQualityOutputSchema.parse({
    rounds: row.rounds,
    goodExample: Number(row.good),
    notFit: Number(row.notfit),
  });
}
