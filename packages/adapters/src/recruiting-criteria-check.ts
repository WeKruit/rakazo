import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CriterionQuestion, TextJudge } from "./judge.js";
import type { PageReader } from "./keyless-http-web.js";
import { roundCriteria } from "./recruiting-round-check.js";

/**
 * Each person a search returned is checked against every requirement the role has saved: one
 * judge request per person answers them all. The verdicts are shown beside the person; they never
 * grade anyone. A person's grade comes only from the search service (the recruiter's choice,
 * 11-26), so a row it graded carries that grade with the verdicts and any other row carries none.
 */

/** A Worker keeps six outgoing requests open at once, so six people are judged together. */
const TOGETHER = 6;
const PROFILE_CHARS = 6_000;
/** A search that returns more people than this is left without verdicts. */
const MOST_PEOPLE = 120;

export type CriteriaCheck = {
  /** The role revision whose requirements judged this person. */
  requirementsRevision: number;
  criteria: Array<{
    id: string;
    statement: string;
    level: string;
    confidence: number;
    /** Where the person is relative to the place a requirement states. */
    place?: string;
  }>;
  /** The search service's grade, when it gave one. */
  match_tier?: string;
  match_score?: number;
};

const ASSESSED = {
  strong: "Met",
  medium: "Met",
  weak: "Partial",
  silent: "Unknown",
  opposite: "Gap",
};

/**
 * The verdicts as the person's "Requirements assessment" in Results: one line per requirement,
 * the verdict and then the requirement in the recruiter's words, which is the line's name there.
 * A turned-down reason is listed only when the profile shows it.
 */
export function criteriaAssessment(
  criteria: ReadonlyArray<{ statement: string; level: string; avoid?: boolean; place?: string }>,
): string {
  return criteria
    .filter((item) => !item.avoid || item.level === "opposite")
    .map(
      (item) =>
        `${ASSESSED[item.level as keyof typeof ASSESSED] ?? "Unknown"} - ${item.statement.replace(/\s*\n\s*/g, " ")}${item.place ? ` (${placeWords(item.place)})` : ""}`,
    )
    .join("\n");
}

/** A place tag as people read it: "there_before" is "there before". */
const placeWords = (tag: string) => tag.replace(/_/g, " ");

const ABOUT_THE_PERSON = (statement: string) =>
  `Could a person's public professional profile (titles, employers, years, skills, schools, certificates, location, languages) show whether the person meets this requirement? Answer no when it is a term of the job offer (pay, benefits, office days, work mode, start date, visa, head count) rather than something about the person. Requirement: "${statement}"`;

const STATES_A_PLACE = (statement: string) =>
  `Does this requirement state where the person must live or be based (a city, region or country), rather than a skill, an employer or the job's work mode? Requirement: "${statement}"`;

/**
 * The requirements a profile can be judged on, one fact each: a field holding several ("Shanghai;
 * hybrid three days") is split, and terms of the offer (pay, office days) are left out since no
 * profile shows them. Each reason the
 * recruiter turned people down is asked the other way round: does this profile show it too.
 */
async function personRequirements(
  judge: TextJudge,
  criteria: readonly { id: string; statement: string }[],
): Promise<CriterionQuestion[]> {
  const turnedDown = criteria
    .filter(({ id }) => id.startsWith("turned-down:"))
    .map(({ id, statement }) => ({
      id,
      statement: statement.replace(/^not what the recruiter turned down:\s*/, ""),
      avoid: true,
    }));
  const facts = criteria
    .filter(({ id }) => !id.startsWith("turned-down:"))
    .flatMap(({ id, statement }) => {
      const label = /^([^:：]{1,40})[:：]\s*(.+)$/s.exec(statement);
      const parts = (label?.[2] ?? statement)
        .split(/[;；]/)
        .map((part) => part.trim())
        .filter(Boolean);
      return parts.map((part, index) => ({
        id: parts.length > 1 ? `${id}#${index + 1}` : id,
        statement: label ? `${label[1]}: ${part}` : part,
      }));
    })
    .slice(0, 16);
  if (!facts.length) return turnedDown;
  const about = await judge.yesAll?.(
    Object.fromEntries(
      facts.flatMap((fact) => [
        [fact.id, ABOUT_THE_PERSON(fact.statement)],
        [`place:${fact.id}`, STATES_A_PLACE(fact.statement)],
      ]),
    ),
    { requirements: facts.map((fact) => fact.statement) },
  );
  // A judge that did not answer leaves every requirement in, asked the plain way.
  return [
    ...(about ? facts.filter((fact) => (about.get(fact.id) ?? 1) >= 0.5) : facts).map((fact) =>
      (about?.get(`place:${fact.id}`) ?? 0) >= 0.5 ? { ...fact, place: true } : fact,
    ),
    ...turnedDown,
  ];
}

/**
 * What the judge reads about a person: the profile's full text (dated jobs with their own
 * descriptions), never a search's short row. The search's own sentence on why the person fits is
 * never passed: with it, the judge agreed "5+ years" for people whose dated jobs showed about
 * three (five real profiles, 11-26).
 */
function profileState(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const full = row._profile_text;
  return typeof full === "string" && full
    ? { name: row.name, location: row.location, profile: full.slice(0, PROFILE_CHARS) }
    : undefined;
}

const PROFILE_READ_MS = 15_000;

/**
 * A deeper search returns a short row per person, so each row without the profile's full text
 * gets it by its profile link from the search service's reader (the same text a quick search
 * returns). A person whose text could not be read stays without it and is not judged.
 */
async function readMissingProfiles(
  read: PageReader | undefined,
  entries: Array<{ row: Record<string, unknown> }>,
): Promise<void> {
  if (!read) return;
  const signal = AbortSignal.timeout(PROFILE_READ_MS);
  await Promise.all(
    entries.map(async ({ row }) => {
      if (row._profile_text || typeof row.linkedin_url !== "string" || !row.linkedin_url) return;
      const page = await read(row.linkedin_url, PROFILE_CHARS, signal).catch(() => undefined);
      if (page?.text) row._profile_text = page.text;
    }),
  );
}

/**
 * A requirement for years of some work is judged on the time the profile ties to that work, and
 * an unsure answer is "not stated": asked plainly, a long career or a senior title passed as the
 * years (same five profiles).
 */
const YEARS = /\d\s*\+?\s*(?:years?|yrs?|年)/i;
const COUNTED_YEARS =
  "Count only the time the profile ties to that work: the dated jobs whose own description shows it, or a number of years the profile states for it. Total career length and a job title alone do not count.";
const SURE = 0.5;
const asksYears = (requirement: CriterionQuestion) =>
  !requirement.avoid && !requirement.place && YEARS.test(requirement.statement);

/**
 * Judges the entries' people on the role's saved requirements and writes each one's verdicts
 * beside their row. Any failure, a role with no saved requirements yet, or a deployment without a
 * judge leaves the entries as they were.
 */
export async function checkPeopleCriteria(
  judgeSettings: { resolve(): Promise<TextJudge | undefined> } | undefined,
  prisma: PrismaClient,
  role: { roleId: string; spaceId: string; revision: number },
  entries: Array<{ row: Record<string, unknown>; check?: CriteriaCheck }>,
  readProfile?: PageReader,
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
    const requirements = await personRequirements(
      judge,
      await roundCriteria(prisma, role, { everyOrigin: true }),
    );
    if (!requirements.length) {
      getLogger().info("recruiting.criteria.check skipped", { requirements: 0 });
      return;
    }
    const questions = requirements.map((requirement) =>
      asksYears(requirement) ? { ...requirement, rule: COUNTED_YEARS } : requirement,
    );
    await readMissingProfiles(readProfile, entries);
    const deadline = AbortSignal.timeout(12_000);
    for (let at = 0; at < entries.length && !deadline.aborted; at += TOGETHER)
      await Promise.all(
        entries.slice(at, at + TOGETHER).map(async (entry) => {
          const profile = profileState(entry.row);
          const verdicts = profile && (await judge.criteria?.(profile, questions, deadline));
          if (!verdicts) return;
          for (const requirement of requirements) {
            const verdict = verdicts.get(requirement.id);
            if (verdict && asksYears(requirement) && verdict.confidence < SURE)
              verdicts.set(requirement.id, { ...verdict, level: "silent", against: 0 });
          }
          const answered = requirements.filter((requirement) => verdicts.has(requirement.id));
          const { match_tier: tier, match_score: score } = entry.row;
          entry.check = {
            requirementsRevision: role.revision,
            criteria: answered.map(({ place: _place, ...requirement }) => {
              const verdict = verdicts.get(requirement.id)!;
              return {
                ...requirement,
                level: verdict.level,
                confidence: verdict.confidence,
                ...(verdict.place ? { place: verdict.place } : {}),
              };
            }),
            ...(typeof tier === "string" && typeof score === "number"
              ? { match_tier: tier, match_score: score }
              : {}),
          };
          entry.row.requirements_assessment = criteriaAssessment(entry.check.criteria);
          const place = entry.check.criteria.find((item) => item.place)?.place;
          if (place) entry.row.location_tag = placeWords(place);
        }),
      );
    getLogger().info("recruiting.criteria.check", {
      roleId: role.roleId,
      requirements: requirements.length,
      people: entries.length,
      checked: entries.filter((entry) => entry.check).length,
      withoutFullProfile: entries.filter((entry) => !entry.row._profile_text).length,
    });
  } catch (error) {
    getLogger().warn("recruiting.criteria.check failed", { error: String(error) });
  }
}
