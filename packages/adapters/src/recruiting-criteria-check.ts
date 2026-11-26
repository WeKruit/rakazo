import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CriterionQuestion, CriterionVerdict, LanguageSignal, TextJudge } from "./judge.js";
import type { PageReader } from "./keyless-http-web.js";
import type { RoundCriterion } from "./recruiting-round-check.js";
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
  medium: "Partial",
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

/**
 * The grade of a person no search graded (a quick search returns none), in the search's own grade
 * words, read off the judge's verdicts so the grade and the lines under the person cannot disagree
 * (11-26: asked as a question of its own, the judge said Strong for 17 of 26 people it had also
 * judged partial or not met on a requirement).
 */
export function gradeOf(
  criteria: ReadonlyArray<{ level: string; avoid?: boolean }>,
): string | undefined {
  const words = criteria
    .filter((item) => !item.avoid || item.level === "opposite")
    .map((item) => ASSESSED[item.level as keyof typeof ASSESSED] ?? "Unknown");
  if (!words.length) return undefined;
  if (words.includes("Gap")) return "Partial";
  if (words.every((word) => word === "Met")) return "Strong";
  // Promising is the search's word for most requirements shown and none contradicted. Staging
  // 11-26: with every person short of a full match called Promising, people meeting one
  // requirement of four counted as found and filled the next round.
  return words.filter((word) => word === "Met").length * 2 > words.length
    ? "Promising"
    : "Uncertain";
}

/** A place tag as people read it: "there_before" is "there before". */
const placeWords = (tag: string) => tag.replace(/_/g, " ");

const ABOUT_THE_PERSON = (statement: string) =>
  `Could a person's public professional profile (titles, employers, years, skills, schools, certificates, location, languages) show whether the person meets this requirement? Answer no when it is a term of the job offer (pay, benefits, office days, work mode, start date, visa, head count) rather than something about the person. Requirement: "${statement}"`;

const STATES_A_PLACE = (statement: string) =>
  `Does this requirement state where the person must live or be based (a city, region or country), rather than a skill, an employer or the job's work mode? Requirement: "${statement}"`;

const STATES_A_LANGUAGE = (statement: string) =>
  `Does this requirement state a language the person must speak or work in, rather than a skill, a place or a programming language? Requirement: "${statement}"`;
/** A requirement on the person; a language they must speak goes to the deployment's language check. */
type PersonRequirement = CriterionQuestion & { language?: boolean };

/**
 * How the language check's answer reads as a requirement's level. Profiles rarely list languages,
 * so the check also counts a school or job where the language is spoken; asked like any other
 * requirement, Mandarin came back "not stated" for engineers who studied and work in Shanghai
 * (11-26). "no sign" is a profile that shows nothing, not one that shows the opposite.
 */
const SPOKEN_LEVEL: Record<LanguageSignal, CriterionVerdict["level"]> = {
  confirmed: "strong",
  strong: "medium",
  possible: "weak",
  unknown: "silent",
  "no sign": "silent",
};

/**
 * The role's saved requirements as questions on a profile, each asked in the words saved. The
 * judge itself says which ones no profile can show (terms of the offer such as pay or office
 * days), which state a place and which a spoken language.
 */
export async function personRequirements(
  judge: TextJudge,
  criteria: readonly RoundCriterion[],
): Promise<PersonRequirement[]> {
  if (!criteria.length) return [];
  const facts = criteria.map(({ id, statement }) => ({ id, statement }));
  const about = await judge.yesAll?.(
    Object.fromEntries(
      facts.flatMap((fact) => [
        [fact.id, ABOUT_THE_PERSON(fact.statement)],
        [`place:${fact.id}`, STATES_A_PLACE(fact.statement)],
        [`language:${fact.id}`, STATES_A_LANGUAGE(fact.statement)],
      ]),
    ),
    { requirements: facts.map((fact) => fact.statement) },
  );
  // A judge that did not answer leaves every requirement in, asked the plain way.
  return (about ? facts.filter((fact) => (about.get(fact.id) ?? 1) >= 0.5) : facts).map((fact) =>
    (about?.get(`place:${fact.id}`) ?? 0) >= 0.5
      ? { ...fact, place: true }
      : (about?.get(`language:${fact.id}`) ?? 0) >= 0.5
        ? { ...fact, language: true }
        : fact,
  );
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
      const page = await read(row.linkedin_url, PROFILE_CHARS, signal).catch((error) => {
        getLogger().warn("recruiting.criteria.profile not read", { error: String(error) });
        return undefined;
      });
      if (page?.text) row._profile_text = page.text;
    }),
  );
}

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
    const requirements = await personRequirements(judge, await roundCriteria(prisma, role));
    if (!requirements.length) {
      getLogger().info("recruiting.criteria.check skipped", { requirements: 0 });
      return;
    }
    // The recruiter's choice (11-25, again 11-26): a language goes to the deployment's own
    // language check, a second request per person, when the deployment has one.
    const spoken = judge.language ? requirements.filter((requirement) => requirement.language) : [];
    const questions = requirements
      .filter((requirement) => !spoken.includes(requirement))
      .map(({ language: _language, ...requirement }) => requirement);
    await readMissingProfiles(readProfile, entries);
    const deadline = AbortSignal.timeout(12_000);
    const rows = entries.flatMap(({ row }, index) =>
      typeof row._profile_text === "string" && row._profile_text
        ? [
            {
              id: String(index),
              ...(typeof row.name === "string" ? { name: row.name } : {}),
              profile: row._profile_text.slice(0, PROFILE_CHARS),
            },
          ]
        : [],
    );
    const speaks = new Map(
      await Promise.all(
        spoken.map(
          async (requirement) =>
            [requirement.id, await judge.language!(requirement.statement, rows, deadline)] as const,
        ),
      ),
    );
    for (let at = 0; at < entries.length && !deadline.aborted; at += TOGETHER)
      await Promise.all(
        entries.slice(at, at + TOGETHER).map(async (entry) => {
          const profile = profileState(entry.row);
          if (!profile) return;
          const verdicts =
            (questions.length ? await judge.criteria?.(profile, questions, deadline) : undefined) ??
            new Map<string, CriterionVerdict>();
          const index = String(entries.indexOf(entry));
          for (const [id, signals] of speaks) {
            const signal = signals.get(index);
            if (signal)
              verdicts.set(id, { level: SPOKEN_LEVEL[signal], confidence: 1, against: 0 });
          }
          if (!verdicts.size) return;
          const answered = requirements.filter((requirement) => verdicts.has(requirement.id));
          const { match_tier: tier, match_score: score } = entry.row;
          const criteria = answered.map(
            ({ place: _place, language: _language, ...requirement }) => {
              const verdict = verdicts.get(requirement.id)!;
              return {
                ...requirement,
                level: verdict.level,
                confidence: verdict.confidence,
                ...(verdict.place ? { place: verdict.place } : {}),
              };
            },
          );
          const grade = gradeOf(criteria);
          entry.check = {
            requirementsRevision: role.revision,
            criteria,
            ...(typeof tier === "string" && typeof score === "number"
              ? { match_tier: tier, match_score: score }
              : grade
                ? { match_tier: grade }
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

/**
 * People saved before the role had requirements were never judged: the first quick searches run
 * before the brief is saved (play 11-26: all first ten stayed without a verdict). So each save of
 * the role judges its people who have no verdicts yet and writes them on their newest saved row.
 */
const judgingRoles = new Set<string>();

export async function checkUnjudgedPeople(
  judgeSettings: { resolve(): Promise<TextJudge | undefined> } | undefined,
  prisma: PrismaClient,
  role: { roleId: string; spaceId: string },
  readProfile?: PageReader,
): Promise<void> {
  // Several saves of one role land together (four within a second, 11-26): one pass serves them.
  if (judgingRoles.has(role.roleId)) return;
  judgingRoles.add(role.roleId);
  try {
    const [saved, occurrences] = await Promise.all([
      prisma.recruitingRole.findUnique({ where: { id: role.roleId }, select: { revision: true } }),
      prisma.recruitingCandidateOccurrence.findMany({
        where: { roleId: role.roleId },
        orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
        select: {
          pageId: true,
          rowIndex: true,
          candidateKey: true,
          name: true,
          location: true,
          linkedinUrl: true,
          matchFields: true,
          report: true,
        },
      }),
    ]);
    if (!saved) return;
    const newest = new Map<string, (typeof occurrences)[number]>();
    for (const row of occurrences)
      if (!newest.has(row.candidateKey)) newest.set(row.candidateKey, row);
    const judged = new Set(
      occurrences
        .filter((row) =>
          Array.isArray((row.matchFields as { criteria?: unknown } | null)?.criteria),
        )
        .map((row) => row.candidateKey),
    );
    const unjudged = [...newest.values()].filter((row) => !judged.has(row.candidateKey));
    const entries = unjudged.map(
      (row): { row: Record<string, unknown>; check?: CriteriaCheck } => ({
        row: { name: row.name, location: row.location, linkedin_url: row.linkedinUrl },
      }),
    );
    await checkPeopleCriteria(
      judgeSettings,
      prisma,
      { ...role, revision: saved.revision },
      entries,
      readProfile,
    );
    await Promise.all(
      entries.map(async ({ row, check }, at) => {
        if (!check) return;
        const { pageId, rowIndex, matchFields, report } = unjudged[at]!;
        const fields = (report as { fields?: unknown[] } | null)?.fields;
        const added = [
          ["Requirements assessment", row.requirements_assessment],
          ["Location tag", row.location_tag],
        ].flatMap(([label, value]) =>
          typeof value === "string" ? [{ label, value, sourceUrls: [] }] : [],
        );
        await prisma.recruitingCandidateOccurrence.update({
          where: { pageId_rowIndex: { pageId, rowIndex } },
          data: {
            matchFields: { ...(matchFields as object | null), ...check } as Prisma.InputJsonObject,
            ...(Array.isArray(fields)
              ? {
                  report: {
                    ...(report as object),
                    fields: [...fields, ...added],
                  } as Prisma.InputJsonObject,
                }
              : {}),
          },
        });
      }),
    );
  } catch (error) {
    getLogger().warn("recruiting.criteria.unjudged failed", { error: String(error) });
  } finally {
    judgingRoles.delete(role.roleId);
  }
}
