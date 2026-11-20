import type { Actor, RecruitingSearchQualityOutput } from "@rakazo/contracts";
import {
  RecruitingCandidateConsiderationSchema,
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

export type RecruiterSeenPerson = {
  /** The calibration round that showed this person. */
  round?: number;
  /** Returned before the latest round was recorded, so a later round may not show them. */
  seenBeforeLatestRound: boolean;
  /** The recruiter's latest verdict on this person for this role. */
  verdict?: "good_example" | "not_fit";
};
export type RecruiterSeen = {
  latestRound: { round: number; recordedAt: Date; people: number; accepted: boolean } | null;
  people: Map<string, RecruiterSeenPerson>;
};

/**
 * What the recruiter has already seen on one role, from the one record every reply and list
 * reads: which round showed each person, who was returned before the latest round, and their
 * latest verdict. The round guard uses the same rule, so a list never shows someone a round
 * would refuse as a repeat.
 */
export async function readRecruiterSeen(
  prisma: Pick<
    PrismaClient,
    "$queryRaw" | "recruitingCalibrationRound" | "recruitingCandidateOccurrence"
  >,
  actor: Actor,
  input: { roleId: string; candidateKeys: readonly string[] },
): Promise<RecruiterSeen> {
  const roleId = input.roleId;
  const keys = [...new Set(input.candidateKeys)];
  const rounds = await prisma.recruitingCalibrationRound.findMany({
    where: { roleId, role: { spaceId: actor.spaceId, userId: actor.userId } },
    orderBy: { round: "desc" },
    select: { round: true, createdAt: true, candidateKeys: true, approvedAt: true },
  });
  const latest = rounds[0];
  const people = new Map<string, RecruiterSeenPerson>(
    keys.map((key) => [key, { seenBeforeLatestRound: false }]),
  );
  if (!keys.length) return { latestRound: null, people };
  for (const round of [...rounds].reverse())
    for (const key of round.candidateKeys) {
      const person = people.get(key);
      if (person && person.round === undefined) person.round = round.round;
    }
  if (latest) {
    const pages = await prisma.recruitingCandidateOccurrence.findMany({
      where: {
        roleId,
        candidateKey: { in: keys },
        page: { observedAt: { lte: latest.createdAt } },
      },
      select: { candidateKey: true },
    });
    for (const row of pages) people.get(row.candidateKey)!.seenBeforeLatestRound = true;
  }
  for (const [key, fit] of await readRecruiterVerdicts(prisma, actor, {
    roleId,
    candidateKeys: keys,
  })) {
    const person = people.get(key);
    if (person) person.verdict = fit;
  }
  return {
    latestRound: latest
      ? {
          round: latest.round,
          recordedAt: latest.createdAt,
          people: latest.candidateKeys.length,
          accepted: latest.approvedAt !== null,
        }
      : null,
    people,
  };
}

/** The recruiter's latest good example or not a fit on each of these people for one role. */
export async function readRecruiterVerdicts(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  input: { roleId: string; candidateKeys: readonly string[] },
): Promise<Map<string, "good_example" | "not_fit">> {
  if (!input.candidateKeys.length) return new Map();
  const rows = await prisma.$queryRaw<{ person: string; fit: "good_example" | "not_fit" }[]>(
    Prisma.sql`
      WITH roles AS (
        SELECT id FROM recruiting_roles
        WHERE id = ${input.roleId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
      ), ${latestVerdictsSql(actor)}
      SELECT person, fit FROM latest WHERE person IN (${Prisma.join([...input.candidateKeys])})`,
  );
  return new Map(rows.map((row) => [row.person, row.fit]));
}

/** How many people a role's search has saved since a moment, for live progress while it runs. */
export async function countRecruitingPeopleFoundSince(
  prisma: Pick<PrismaClient, "recruitingCandidateOccurrence">,
  input: { roleId: string; since: Date },
): Promise<number> {
  return (await listRecruitingPeopleFoundSince(prisma, input)).length;
}

/** The people a role's search has saved since a moment, each once, in the order they were found. */
export async function listRecruitingPeopleFoundSince(
  prisma: Pick<PrismaClient, "recruitingCandidateOccurrence">,
  input: { roleId: string; since: Date },
): Promise<string[]> {
  const rows = await prisma.recruitingCandidateOccurrence.findMany({
    where: { roleId: input.roleId, page: { observedAt: { gte: input.since } } },
    orderBy: [{ page: { observedAt: "asc" } }, { rowIndex: "asc" }],
    select: { candidateKey: true },
  });
  return [...new Set(rows.map((row) => row.candidateKey))];
}

/**
 * Everyone Results marks on a role, as the page decides it: on hold, or not a fit (a pass, or the
 * recruiter's own "not a fit" with no decision after it), with their name and the first round
 * that showed them. fosp x5 11-20 (1ae3a9c3): asked whether round 1's turned-down people were
 * marked, Kruit read round 2 and said it could not confirm.
 */
export async function readRecruitingResultsMarks(
  prisma: Pick<
    PrismaClient,
    | "$queryRaw"
    | "recruitingCandidate"
    | "recruitingCandidateOccurrence"
    | "recruitingCalibrationRound"
  >,
  actor: Actor,
  input: { roleId: string },
): Promise<
  { candidateKey: string; name: string | null; round?: number; mark: "on hold" | "not a fit" }[]
> {
  const rows = await prisma.$queryRaw<{ person: string }[]>(Prisma.sql`
    WITH roles AS (
      SELECT id FROM recruiting_roles
      WHERE id = ${input.roleId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    ), ${latestVerdictsSql(actor)}
    SELECT person FROM latest WHERE fit = 'not_fit'`);
  const notFit = new Set(rows.map((row) => row.person));
  const decided = await prisma.recruitingCandidate.findMany({
    where: { roleId: input.roleId, role: { userId: actor.userId, spaceId: actor.spaceId } },
    select: { candidateKey: true, consideration: true },
  });
  const decisions = new Map<string, string>();
  for (const candidate of decided) {
    const parsed = RecruitingCandidateConsiderationSchema.safeParse(candidate.consideration);
    if (
      parsed.success &&
      parsed.data.source.actor.userId === actor.userId &&
      parsed.data.source.actor.spaceId === actor.spaceId
    )
      decisions.set(candidate.candidateKey, parsed.data.operation);
  }
  const marks = new Map<string, "on hold" | "not a fit">();
  for (const key of new Set([...notFit, ...decisions.keys()])) {
    const decision = decisions.get(key);
    if (decision === "hold") marks.set(key, "on hold");
    else if (decision === "pass" || (!decision && notFit.has(key))) marks.set(key, "not a fit");
  }
  if (!marks.size) return [];
  const keys = [...marks.keys()];
  const [names, rounds] = await Promise.all([
    prisma.recruitingCandidateOccurrence.findMany({
      where: { roleId: input.roleId, candidateKey: { in: keys }, name: { not: null } },
      select: { candidateKey: true, name: true },
      distinct: ["candidateKey"],
    }),
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId: input.roleId, status: "shown", candidateKeys: { hasSome: keys } },
      select: { round: true, candidateKeys: true },
      orderBy: { round: "asc" },
    }),
  ]);
  const name = new Map(names.map((row) => [row.candidateKey, row.name]));
  return keys.map((candidateKey) => {
    const round = rounds.find((item) => item.candidateKeys.includes(candidateKey))?.round;
    return {
      candidateKey,
      name: name.get(candidateKey) ?? null,
      ...(round ? { round } : {}),
      mark: marks.get(candidateKey) as "on hold" | "not a fit",
    };
  });
}
