import type { RecruitingCriterion, RecruitingCriterionExpression } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/**
 * One check for every calibration round: the agent gives each pick a verdict on every hard
 * criterion of the role ("shown", "unknown" or "fails"), and the server holds the round to those
 * verdicts. What the recruiter says (a city, a level, the reason they turned people down) becomes
 * a role criterion, so the same check covers it without a rule per trait. The agent judges; this
 * only checks the judgement is complete and consistent (structured output against a rubric).
 */

export type RoundVerdict = "shown" | "unknown" | "fails";
export type RoundChecks = Readonly<Record<string, Readonly<Record<string, RoundVerdict>>>>;

export type RoundCriterion = { id: string; statement: string; added: boolean };

function statementOf(expression: RecruitingCriterionExpression): string {
  if (expression.kind === "atom") return expression.statement;
  if (expression.kind === "not") return `not ${statementOf(expression.item)}`;
  return expression.items.map(statementOf).join(expression.kind === "all" ? " and " : " or ");
}

function hardCriteria(criteria: unknown): { id: string; statement: string }[] {
  if (!Array.isArray(criteria)) return [];
  return (criteria as RecruitingCriterion[])
    .filter((criterion) => criterion?.priority === "hard" && criterion.expression)
    .map((criterion) => ({ id: criterion.id, statement: statementOf(criterion.expression) }));
}

/**
 * The role's hard criteria, each marked when it was added after the last round was recorded
 * (that is where the recruiter's feedback since then lands). No round yet: nothing is new.
 */
export async function roundCriteria(
  prisma: PrismaClient,
  roleId: string,
): Promise<RoundCriterion[]> {
  const [role, last] = await Promise.all([
    prisma.recruitingRole.findUnique({
      where: { id: roleId },
      select: { currentRevision: { select: { criteria: true } } },
    }),
    prisma.recruitingCalibrationRound.findFirst({
      where: { roleId },
      orderBy: { round: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const current = hardCriteria(role?.currentRevision.criteria);
  if (!last) return current.map((criterion) => ({ ...criterion, added: false }));
  const before = await prisma.recruitingRoleRevision.findFirst({
    where: { roleId, createdAt: { lte: last.createdAt } },
    orderBy: { revision: "desc" },
    select: { criteria: true },
  });
  const earlier = new Set(hardCriteria(before?.criteria).map((criterion) => criterion.id));
  return current.map((criterion) => ({ ...criterion, added: !earlier.has(criterion.id) }));
}

export type RoundCheckResult =
  | { ok: true; unverified: Record<string, string> }
  | { ok: false; error: string; asked: string[] };

/**
 * Holds the picks to their verdicts. A missing verdict or a "fails" is always refused. "unknown"
 * on a criterion added since the last round is refused once per person (`asked`), since the
 * recruiter just said it matters; after that the agent's choice stands. Returns the "Not
 * verified" note per person, written from the criteria, for the round list.
 */
export function checkRound(input: {
  keys: readonly string[];
  checks: RoundChecks | undefined;
  criteria: readonly RoundCriterion[];
  asked: ReadonlySet<string>;
  /** What to do when fewer than ten fit. */
  shortOfTen: string;
}): RoundCheckResult {
  const unverified: Record<string, string> = {};
  if (!input.criteria.length) return { ok: true, unverified };
  const verdictOf = (key: string, id: string) => input.checks?.[key]?.[id];
  const missing = input.keys.filter((key) =>
    input.criteria.some((criterion) => !verdictOf(key, criterion.id)),
  );
  if (missing.length)
    return {
      ok: false,
      asked: [],
      error: `Not recorded: checks needs a verdict ("shown", "unknown" or "fails", from the person's row) on every hard criterion for every pick; missing for ${missing.join(", ")}. The hard criteria: ${input.criteria.map((criterion) => `${criterion.id} = ${criterion.statement}`).join("; ")}.`,
    };
  const failing: string[] = [];
  const newlyUnknown: string[] = [];
  for (const key of input.keys) {
    const fails = input.criteria.filter((criterion) => verdictOf(key, criterion.id) === "fails");
    if (fails.length)
      failing.push(`${key} (${fails.map((criterion) => criterion.statement).join("; ")})`);
    const unknown = input.criteria.filter(
      (criterion) => verdictOf(key, criterion.id) === "unknown",
    );
    if (unknown.length)
      unverified[key] = unknown.map((criterion) => criterion.statement).join("; ");
    const raised = unknown.filter((criterion) => criterion.added);
    if (raised.length && !input.asked.has(key))
      newlyUnknown.push(`${key} (${raised.map((criterion) => criterion.statement).join("; ")})`);
  }
  if (!failing.length && !newlyUnknown.length) return { ok: true, unverified };
  return {
    ok: false,
    asked: newlyUnknown.map((entry) => entry.slice(0, entry.indexOf(" ("))),
    error: [
      "Not recorded.",
      failing.length &&
        `These picks fail a hard criterion by your own verdict, so they are not in the round: ${failing.join("; ")}.`,
      newlyUnknown.length &&
        `These rows do not show what the recruiter asked for since the last round: ${newlyUnknown.join("; ")}.`,
      `Replace them with people whose rows show every hard criterion. If fewer than ten do, show the ones who do with show_picks, then ${input.shortOfTen}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * People turned down since the last round, by recruiting_feedback, with no role revision after
 * it: the recruiter's reasons are not criteria yet, so the next round could not be held to them.
 * Returns the feedback summaries to save as criteria.
 */
export async function feedbackNotYetCriteria(
  prisma: PrismaClient,
  input: { spaceId: string; roleId: string },
): Promise<string[]> {
  const last = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId: input.roleId },
    orderBy: { round: "desc" },
    select: { createdAt: true },
  });
  if (!last) return [];
  const [turnedDown, revised] = await Promise.all([
    prisma.externalEffect.findMany({
      where: {
        spaceId: input.spaceId,
        kind: "recruiting_feedback",
        status: "completed",
        createdAt: { gt: last.createdAt },
        AND: [
          { request: { path: ["roleId"], equals: input.roleId } },
          { request: { path: ["fit"], equals: "not_fit" } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { request: true, createdAt: true },
      take: 10,
    }),
    prisma.recruitingRoleRevision.findFirst({
      where: { roleId: input.roleId },
      orderBy: { revision: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return turnedDown
    .filter((effect) => !revised || effect.createdAt > revised.createdAt)
    .map((effect) => {
      const summary = (effect.request as { summary?: unknown } | null)?.summary;
      return typeof summary === "string" ? summary : "";
    })
    .filter(Boolean);
}
