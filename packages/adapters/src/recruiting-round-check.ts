import type { RecruitingCriterion, RecruitingCriterionExpression } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  listRecruitingFitCandidateKeys,
  listRecruitingGradedCandidateKeys,
  readRecruitingResultsMarks,
} from "@rakazo/db";

/**
 * What the recruiter asked for on a role, as the agent saved it: the role's requirement memory.
 * The role's hard criteria, in the words saved, never reshaped here. They are the one place a
 * requirement on the person is saved (staging 11-26: the same requirement saved as a criterion
 * and as a brief field was judged twice, "9 requirements" for a role that stated five).
 */
export type RoundCriterion = { id: string; statement: string };

function statementOf(expression: RecruitingCriterionExpression): string {
  if (expression.kind === "atom") return expression.statement;
  if (expression.kind === "not") return `not ${statementOf(expression.item)}`;
  return expression.items.map(statementOf).join(expression.kind === "all" ? " and " : " or ");
}

export async function roundCriteria(
  prisma: Pick<PrismaClient, "recruitingRole">,
  input: { roleId: string },
): Promise<RoundCriterion[]> {
  const role = await prisma.recruitingRole.findUnique({
    where: { id: input.roleId },
    select: { currentRevision: { select: { criteria: true } } },
  });
  const criteria = role?.currentRevision.criteria;
  return (Array.isArray(criteria) ? (criteria as unknown as RecruitingCriterion[]) : [])
    .filter((criterion) => criterion?.priority === "hard" && criterion.expression)
    .map((criterion) => ({ id: criterion.id, statement: statementOf(criterion.expression) }));
}

/** What a recorded round's read says about repeats: the round record refuses anyone already seen. */
export const ROUND_REPEATS =
  "none: a recorded round never holds anyone shown in an earlier round or turned down";

/**
 * Who in a round was already in an earlier one, read from the recorded rounds. Staging 11-15: a
 * short round topped up to ten was recorded again with the eight already shown; Kruit was told a
 * round never repeats anyone, saw them marked as shown before, and could not answer "any repeats?".
 */
export async function roundRepeats(
  prisma: Pick<PrismaClient, "recruitingCalibrationRound">,
  input: {
    roleId: string;
    round: number;
    candidates: readonly { candidateKey: string; name: string | null }[];
  },
): Promise<string> {
  const earlier = await prisma.recruitingCalibrationRound.findMany({
    where: { roleId: input.roleId, round: { lt: input.round } },
    orderBy: { round: "asc" },
    select: { round: true, candidateKeys: true },
  });
  // Each person under the latest earlier round that held them.
  const shownIn = new Map<string, number>();
  for (const round of earlier) for (const key of round.candidateKeys) shownIn.set(key, round.round);
  const name = (person: { candidateKey: string; name: string | null }) =>
    person.name ?? person.candidateKey;
  const byRound = new Map<number, string[]>();
  const fresh: string[] = [];
  for (const person of input.candidates) {
    const round = shownIn.get(person.candidateKey);
    if (round === undefined) fresh.push(name(person));
    else byRound.set(round, [...(byRound.get(round) ?? []), name(person)]);
  }
  if (!byRound.size) return ROUND_REPEATS;
  const kept = [...byRound].map(([round, names]) => `${names.join(", ")} (round ${round})`);
  const untouched = earlier.map((round) => round.round).filter((round) => !byRound.has(round));
  return [
    `round ${input.round} keeps people already shown: ${kept.join("; ")}.`,
    fresh.length ? `New in it: ${fresh.join(", ")}.` : "Nobody in it is new.",
    untouched.length ? `It has nobody from round ${untouched.join(" or ")}.` : "",
    "Answer a question about repeats with exactly this.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A recorded round's people without anyone an earlier round of the role already showed, so the
 * recruiter never reads the same person in two lists. Identity is the saved key, which is the
 * person's LinkedIn path. A round with nobody new is left whole for the caller to turn back.
 */
export async function withoutShownBefore(
  prisma: Pick<PrismaClient, "recruitingCalibrationRound">,
  roleId: string,
  keys: readonly string[],
): Promise<{ keys: string[]; shownBefore: number }> {
  const earlier = await prisma.recruitingCalibrationRound.findMany({
    where: { roleId, candidateKeys: { hasSome: [...keys] } },
    select: { candidateKeys: true },
  });
  const shown = new Set(earlier.flatMap((round) => round.candidateKeys));
  const fresh = [...new Set(keys)].filter((key) => !shown.has(key));
  return { keys: fresh, shownBefore: keys.length - fresh.length };
}

/**
 * Where a request for N people stands, given with every search, list and round result so the
 * agent never keeps a tally of its own. `counted` is the one count a request is measured by and
 * the one told to the recruiter: the people rounds have listed for them, without those they
 * turned down (`turnedDown`, as Results marks them).
 */
export async function requestCounts(
  prisma: PrismaClient,
  role: { roleId: string; userId: string; spaceId: string },
) {
  const { roleId } = role;
  const [people, graded, fit, rounds, marks] = await Promise.all([
    prisma.recruitingCandidate.count({ where: { roleId } }),
    listRecruitingGradedCandidateKeys(prisma, roleId),
    listRecruitingFitCandidateKeys(prisma, roleId),
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId, status: "shown" },
      select: { candidateKeys: true },
    }),
    readRecruitingResultsMarks(
      prisma,
      { userId: role.userId, spaceId: role.spaceId, email: "", isDeploymentOwner: false },
      { roleId },
    ),
  ]);
  const shown = new Set(rounds.flatMap((round) => round.candidateKeys));
  const notAFit = new Set(
    marks.filter((mark) => mark.mark === "not a fit").map((mark) => mark.candidateKey),
  );
  const turnedDown = [...shown].filter((key) => notAFit.has(key)).length;
  return {
    counted: shown.size - turnedDown,
    turnedDown,
    fitNotShownYet: fit.filter((key) => !shown.has(key) && !notAFit.has(key)).length,
    notGradedYet: people - graded.length,
  };
}

/**
 * The running count under a round's list, in the server's own words, so the number the recruiter
 * reads is the one the request is measured by and nobody retypes it. A role's first list needs no
 * such line: its heading is the count.
 */
export function roundCountLine(
  counts: { counted: number; turnedDown: number },
  listed: number,
  chinese: boolean,
): string {
  const shown = counts.counted + counts.turnedDown;
  if (shown <= listed && !counts.turnedDown) return "";
  if (chinese)
    return counts.turnedDown
      ? `累计展示 ${shown} 人，你淘汰了 ${counts.turnedDown} 人，计入 ${counts.counted} 人。`
      : `累计展示 ${shown} 人。`;
  return counts.turnedDown
    ? `${shown} shown so far, ${counts.turnedDown} turned down by you, ${counts.counted} counted.`
    : `${shown} shown so far.`;
}

/** A role team's round list starts with this heading, in either language. */
export const ROUND_HEADING = /^(?:\d+ (?:people|person) this round:|本轮 \d+ 人：)/;

/**
 * A round list the role's chat posted after the latest recorded round: the next round is shown
 * there and its record is still being written (a refused record is retried).
 */
export async function roundListedNotRecorded(
  prisma: PrismaClient,
  input: { roleId: string; after: string },
): Promise<{ people: number } | null> {
  const role = await prisma.recruitingRole.findFirst({
    where: { id: input.roleId },
    select: { sourceThreadId: true },
  });
  if (!role?.sourceThreadId) return null;
  const messages = await prisma.message.findMany({
    where: { threadId: role.sourceThreadId, role: "bot", createdAt: { gt: new Date(input.after) } },
    orderBy: { seq: "desc" },
    take: 20,
    select: { blocks: true },
  });
  for (const message of messages) {
    const blocks = Array.isArray(message.blocks)
      ? (message.blocks as Array<{ kind?: unknown; text?: unknown }>)
      : [];
    const list = blocks.find(
      (block) =>
        block.kind === "text" && typeof block.text === "string" && ROUND_HEADING.test(block.text),
    );
    const count =
      typeof list?.text === "string"
        ? /^(?:(\d+) (?:people|person)|本轮 (\d+) 人)/.exec(list.text)
        : null;
    if (count) return { people: Number(count[1] ?? count[2]) };
  }
  return null;
}

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
    select: { blocks: true, updatedAt: true },
  });
  const recorded = new Date(input.createdAt).getTime();
  const listed = messages
    // A reply still being written when the round was recorded may be listing that very round.
    .filter((message) => message.updatedAt.getTime() < recorded)
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
