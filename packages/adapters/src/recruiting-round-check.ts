import type { RecruitingCriterion, RecruitingCriterionExpression } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/**
 * One check for every calibration round: the agent gives each pick a verdict on every requirement
 * of the role ("shown", "unknown" or "fails"), and the server holds the round to those
 * verdicts. What the recruiter says (a city, a level, the reason they turned people down) is one
 * of those requirements, so the same check covers it without a rule per trait. The agent judges; this
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

/** The recruiter messages a requirement cites ("human-message:<id>" or a message anchor). */
function citedMessages(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref) => {
    const id = typeof ref === "string" ? ref : (ref as { id?: unknown } | null)?.id;
    const anchor = (ref as { anchor?: { messageId?: unknown } } | null)?.anchor?.messageId;
    const fromId = typeof id === "string" ? /^human-message:(.+)$/.exec(id)?.[1] : undefined;
    return [fromId, typeof anchor === "string" ? anchor : undefined].filter(
      (value): value is string => !!value,
    );
  });
}

type Requirement = { id: string; statement: string; messages: string[] };

function hardCriteria(criteria: unknown): Requirement[] {
  if (!Array.isArray(criteria)) return [];
  return (criteria as (RecruitingCriterion & { sourceRefs?: unknown })[])
    .filter((criterion) => criterion?.priority === "hard" && criterion.expression)
    .map((criterion) => ({
      id: criterion.id,
      statement: statementOf(criterion.expression),
      messages: citedMessages(criterion.sourceRefs),
    }));
}

type BriefField = {
  key?: unknown;
  value?: unknown;
  state?: unknown;
  origin?: unknown;
  sourceRefIds?: unknown;
};

/** The brief fields the recruiter stated themselves, as requirements in their words. */
function statedFields(brief: unknown): Requirement[] {
  const fields = (brief as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return (fields as BriefField[]).flatMap((field) =>
    typeof field?.key === "string" &&
    typeof field.value === "string" &&
    field.state === "known" &&
    field.origin === "user_instruction"
      ? [
          {
            id: `brief:${field.key}`,
            statement: `${field.key}: ${field.value}`,
            messages: citedMessages(field.sourceRefIds),
          },
        ]
      : [],
  );
}

/**
 * Everything the recruiter asked for, as the requirements every pick gets a verdict on: the brief
 * fields in their own words, the role's hard criteria, and each reason they turned people down
 * (the recorded recruiting_feedback, so nothing has to be saved first). One is new when the
 * recruiter said it after the last round was recorded: the message it cites, or the turn-down
 * itself. When it was saved does not count, since the brief is often saved just after a round.
 */
export async function roundCriteria(
  prisma: PrismaClient,
  input: { roleId: string; spaceId: string },
): Promise<RoundCriterion[]> {
  const { roleId } = input;
  const [role, last, turnedDown] = await Promise.all([
    prisma.recruitingRole.findUnique({
      where: { id: roleId },
      select: { currentRevision: { select: { criteria: true, brief: true } } },
    }),
    prisma.recruitingCalibrationRound.findFirst({
      where: { roleId },
      orderBy: { round: "desc" },
      select: { createdAt: true },
    }),
    prisma.externalEffect.findMany({
      where: {
        spaceId: input.spaceId,
        kind: "recruiting_feedback",
        status: "completed",
        AND: [
          { request: { path: ["roleId"], equals: roleId } },
          { request: { path: ["fit"], equals: "not_fit" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, request: true, createdAt: true },
      take: 10,
    }),
  ]);
  const stated = [
    ...statedFields(role?.currentRevision.brief),
    ...hardCriteria(role?.currentRevision.criteria),
  ];
  const cited = [...new Set(stated.flatMap((requirement) => requirement.messages))];
  const saidAfter = new Set(
    last && cited.length
      ? (
          await prisma.message.findMany({
            where: { id: { in: cited }, createdAt: { gt: last.createdAt } },
            select: { id: true },
          })
        ).map((message) => message.id)
      : [],
  );
  const reasons = turnedDown.reverse().flatMap((effect) => {
    const summary = (effect.request as { summary?: unknown } | null)?.summary;
    return typeof summary === "string" && summary.trim()
      ? [
          {
            id: `turned-down:${effect.id}`,
            statement: `not what the recruiter turned down: ${summary.trim()}`,
            added: !!last && effect.createdAt > last.createdAt,
          },
        ]
      : [];
  });
  return [
    ...stated.map(({ id, statement, messages }) => ({
      id,
      statement,
      added: messages.some((message) => saidAfter.has(message)),
    })),
    ...reasons,
  ];
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
  /**
   * A top-up search already came back and the round is still short: the bar relaxes, so an
   * unknown on what the recruiter just raised no longer keeps a person out ("fails" still does).
   */
  relaxed?: boolean;
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
    // Something no pick's row shows (base pay, say) is not about the person, so it stays off
    // each person's note.
    const personal = unknown.filter((criterion) =>
      input.keys.some((other) => verdictOf(other, criterion.id) !== "unknown"),
    );
    if (personal.length)
      unverified[key] = personal.map((criterion) => criterion.statement).join("; ");
    const raised = unknown.filter((criterion) => criterion.added);
    if (raised.length && !input.relaxed && !input.asked.has(key))
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

/** What a recorded round's read says about repeats: the round record refuses anyone already seen. */
export const ROUND_REPEATS =
  "none: a recorded round never holds anyone shown in an earlier round or turned down";

/** A role team's round list starts with this heading, in either language. */
export const ROUND_HEADING = /^(?:\d+ (?:people|person) this round:|本轮 \d+ 人：)/;

/**
 * Round people this conversation listed before the round as saved, unreviewed results (a page of
 * the pool, never a round list), so a question about repeats is answered from what was shown.
 */
export async function listedBeforeRound(
  prisma: PrismaClient,
  input: {
    threadId: string;
    roleId: string;
    round: number;
    createdAt: string;
    candidates: ReadonlyArray<{ name: string | null; linkedinUrl: string | null }>;
  },
): Promise<string[]> {
  const slugs = input.candidates.flatMap((person) => {
    const slug = /\/in\/([^/?#\s)]+)/.exec(person.linkedinUrl ?? "")?.[1];
    return slug && person.name ? [{ name: person.name, slug }] : [];
  });
  if (!slugs.length) return [];
  const previous = await prisma.recruitingCalibrationRound.findMany({
    where: { roleId: input.roleId, round: { lt: input.round } },
    orderBy: { round: "desc" },
    take: 1,
    select: { createdAt: true },
  });
  const messages = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      role: "bot",
      createdAt: { gt: previous[0]?.createdAt ?? new Date(0), lt: new Date(input.createdAt) },
    },
    orderBy: { seq: "asc" },
    take: 100,
    select: { blocks: true },
  });
  const listed = messages
    .flatMap((message) =>
      Array.isArray(message.blocks)
        ? (message.blocks as Array<{ kind?: unknown; text?: unknown }>).flatMap((block) =>
            block.kind === "text" && typeof block.text === "string" ? [block.text] : [],
          )
        : [],
    )
    .filter((text) => !ROUND_HEADING.test(text))
    .join("\n");
  return slugs
    .filter(({ slug }) =>
      new RegExp(`/in/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(listed),
    )
    .map(({ name }) => name);
}

/**
 * The recruiter's own words on people and the round between the previous round and this one, so
 * the global conversation can say what changed without the role's chat in its history.
 */
export async function feedbackBeforeRound(
  prisma: PrismaClient,
  input: { spaceId: string; roleId: string; round: number; createdAt: string },
): Promise<Array<{ said: string; target?: string; fit?: string }>> {
  const previous = await prisma.recruitingCalibrationRound.findMany({
    where: { roleId: input.roleId, round: { lt: input.round } },
    orderBy: { round: "desc" },
    take: 1,
    select: { round: true, createdAt: true },
  });
  if (!previous[0]) return [];
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: input.spaceId,
      kind: "recruiting_feedback",
      status: "completed",
      createdAt: { gt: previous[0].createdAt, lte: new Date(input.createdAt) },
      request: { path: ["roleId"], equals: input.roleId },
    },
    orderBy: { createdAt: "asc" },
    select: { request: true },
    take: 10,
  });
  const said = new Set<string>();
  return effects.flatMap((effect) => {
    const request = (effect.request ?? {}) as {
      target?: unknown;
      fit?: unknown;
      summary?: unknown;
      intent?: { quote?: unknown };
    };
    const text =
      typeof request.intent?.quote === "string"
        ? request.intent.quote
        : typeof request.summary === "string"
          ? request.summary
          : "";
    if (!text || said.has(text)) return [];
    said.add(text);
    return [
      {
        said: text,
        ...(typeof request.target === "string" ? { target: request.target } : {}),
        ...(typeof request.fit === "string" ? { fit: request.fit } : {}),
      },
    ];
  });
}
