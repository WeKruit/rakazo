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
    WITH roles AS (
      SELECT id FROM recruiting_roles
      WHERE id = ${roleId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    ), ${latestVerdictsSql(actor)}
    SELECT EXISTS (SELECT 1 FROM roles) AS owned,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'round', c.round,
          'shown', cardinality(c."candidateKeys"),
          'goodExample', (SELECT count(*) FROM latest l WHERE l.person = ANY(c."candidateKeys") AND l.fit = 'good_example'),
          'notFit', (SELECT count(*) FROM latest l WHERE l.person = ANY(c."candidateKeys") AND l.fit = 'not_fit'),
          'accepted', c."approvedAt" IS NOT NULL
        ) ORDER BY c.round), '[]'::jsonb)
        FROM recruiting_calibration_rounds c WHERE c."roleId" IN (SELECT id FROM roles)) AS rounds,
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

/**
 * The latest good example or not a fit per person on each role in the `roles` CTE, from the
 * feedback form and from feedback the agent saved from chat. Defines CTE `latest(role, person, fit)`.
 */
function latestVerdictsSql(actor: Actor) {
  return Prisma.sql`verdicts AS (
      SELECT e.request->>'roleId' AS role, key.value AS person, e.request->>'fit' AS fit, e."createdAt" AS at
      FROM external_effects e
      JOIN runs r ON r.id = e."runId" AND r."userId" = ${actor.userId} AND r."spaceId" = ${actor.spaceId}
      CROSS JOIN LATERAL jsonb_array_elements_text(e.request->'candidateKeys') key
      WHERE e."spaceId" = ${actor.spaceId} AND e.kind = 'recruiting_feedback' AND e.status = 'completed'
        AND e.request->>'roleId' IN (SELECT id FROM roles)
        AND e.request->>'target' = 'candidate'
        AND e.request->>'fit' IN ('good_example', 'not_fit')
        AND e.result->>'status' IN ('recorded', 'already_recorded')
      UNION ALL
      SELECT b->'recruitingFeedback'->>'roleId', key.value, b->'recruitingFeedback'->>'choice', m."createdAt"
      FROM messages m
      JOIN threads t ON t.id = m."threadId" AND t."userId" = ${actor.userId} AND t."spaceId" = ${actor.spaceId}
      CROSS JOIN LATERAL jsonb_array_elements(m.blocks) b
      CROSS JOIN LATERAL jsonb_array_elements_text(b->'recruitingFeedback'->'candidateKeys') key
      WHERE m.role = 'user' AND m."botId" IS NULL
        AND m.blocks @> '[{"recruitingFeedback":{}}]'::jsonb
        AND b->'recruitingFeedback'->>'roleId' IN (SELECT id FROM roles)
        AND b->'recruitingFeedback'->>'choice' IN ('good_example', 'not_fit')
    ), latest AS (
      SELECT DISTINCT ON (role, person) role, person, fit FROM verdicts ORDER BY role, person, at DESC
    )`;
}

const FACET_LIMIT = 5;

/**
 * What the people the recruiter praised and turned down have in common: their current company
 * and title, schools and majors, from saved profiles (or the search row when no profile is
 * saved). Per role and across all of this recruiter's open roles. Counts only; the search and
 * the reviewer still do the matching.
 */
export async function readRecruitingVerdictPatterns(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  raw: { roleId: string },
): Promise<RecruitingVerdictPatterns> {
  const { roleId } = RecruitingSearchQualityInputSchema.parse(raw);
  const [role, all] = await Promise.all([
    verdictFacets(prisma, actor, Prisma.sql`id = ${roleId}`),
    verdictFacets(prisma, actor, Prisma.sql`"archivedAt" IS NULL`),
  ]);
  return { role, allRoles: all };
}

export type RecruitingVerdictFacet = {
  facet: "company" | "title" | "school" | "major";
  fit: "good_example" | "not_fit";
  value: string;
  people: number;
};
export type RecruitingVerdictPatterns = {
  role: RecruitingVerdictFacet[];
  allRoles: RecruitingVerdictFacet[];
};

async function verdictFacets(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  scope: Prisma.Sql,
): Promise<RecruitingVerdictFacet[]> {
  const rows = await prisma.$queryRaw<
    (Omit<RecruitingVerdictFacet, "people"> & { people: bigint })[]
  >(
    Prisma.sql`
    WITH roles AS (
      SELECT id FROM recruiting_roles
      WHERE "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId} AND ${scope}
    ), ${latestVerdictsSql(actor)}, people AS (
      SELECT l.role, l.person, l.fit, sp.profile,
        coalesce(
          (SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sp.profile->'experience') = 'array' THEN sp.profile->'experience' ELSE '[]'::jsonb END) WITH ORDINALITY e(x, n)
            ORDER BY (x->>'is_current')::boolean IS TRUE DESC, n LIMIT 1),
          '{}'::jsonb) AS job,
        o.title AS row_title, o.company AS row_company
      FROM latest l
      LEFT JOIN recruiting_saved_profiles sp ON sp."personKey" = l.person
        AND sp."ownerUserId" = ${actor.userId} AND sp."spaceId" = ${actor.spaceId}
      LEFT JOIN LATERAL (
        SELECT title, company FROM recruiting_candidate_occurrences
        WHERE "roleId" = l.role AND "candidateKey" = l.person
        ORDER BY "pageId" DESC, "rowIndex" DESC LIMIT 1
      ) o ON true
    ), facets AS (
      SELECT role, person, fit, 'company' AS facet, coalesce(nullif(btrim(job->>'company_name'), ''), row_company) AS value FROM people
      UNION ALL
      SELECT role, person, fit, 'title', coalesce(nullif(btrim(job->>'title'), ''), row_title) FROM people
      UNION ALL
      SELECT p.role, p.person, p.fit, 'school', ed->>'school_name'
      FROM people p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.profile->'education') = 'array' THEN p.profile->'education' ELSE '[]'::jsonb END) ed
      UNION ALL
      SELECT p.role, p.person, p.fit, 'major', ed->>'field_of_study'
      FROM people p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.profile->'education') = 'array' THEN p.profile->'education' ELSE '[]'::jsonb END) ed
    ), counted AS (
      SELECT facet, fit, min(btrim(value)) AS value, count(DISTINCT role || ' ' || person) AS people,
        row_number() OVER (PARTITION BY facet, fit ORDER BY count(DISTINCT role || ' ' || person) DESC, min(btrim(value))) AS rank
      FROM facets WHERE nullif(btrim(value), '') IS NOT NULL
      GROUP BY facet, fit, lower(btrim(value))
    )
    SELECT facet, fit, value, people FROM counted WHERE rank <= ${FACET_LIMIT}
    ORDER BY facet, fit, people DESC, value`,
  );
  return rows.map((row) => ({ ...row, people: Number(row.people) }));
}
