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
/** P5's one count for a role: the people shown to the recruiter, less those they turned down. */
export async function shownCount(
  prisma: Parameters<typeof readRecruitingResultsMarks>[0],
  role: { roleId: string; userId: string; spaceId: string },
) {
  const [rounds, marks] = await Promise.all([
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId: role.roleId, status: "shown" },
      select: { candidateKeys: true },
    }),
    readRecruitingResultsMarks(
      prisma,
      { userId: role.userId, spaceId: role.spaceId, email: "", isDeploymentOwner: false },
      { roleId: role.roleId },
    ),
  ]);
  const shown = new Set(rounds.flatMap((round) => round.candidateKeys));
  const notAFit = new Set(
    marks.filter((mark) => mark.mark === "not a fit").map((mark) => mark.candidateKey),
  );
  const turnedDown = [...shown].filter((key) => notAFit.has(key)).length;
  return { shown, notAFit, counted: shown.size - turnedDown, turnedDown };
}

export async function requestCounts(
  prisma: PrismaClient,
  role: { roleId: string; userId: string; spaceId: string },
) {
  const { roleId } = role;
  const [people, graded, fit, { shown, notAFit, counted, turnedDown }] = await Promise.all([
    prisma.recruitingCandidate.count({ where: { roleId } }),
    listRecruitingGradedCandidateKeys(prisma, roleId),
    listRecruitingFitCandidateKeys(prisma, roleId),
    shownCount(prisma, role),
  ]);
  return {
    counted,
    turnedDown,
    fitNotShownYet: fit.filter((key) => !shown.has(key) && !notAFit.has(key)).length,
    notGradedYet: people - graded.length,
  };
}

/**
 * The count the open request is met at: what was counted when the recruiter asked, plus the
 * number they asked for. A request starts at a round that records a number asked and goes on
 * through every later round that records none. The same number again on a request not yet shown
 * in full continues it. Messages play no part. Undefined when no round has asked for a number.
 * Staging find-100 11-27: anchored at the newest message, "进度？" reset the request and 110 were
 * shown for 100; fosp s178: a turn-down naming no number started ten more nobody asked for.
 */
export async function requestTarget(
  prisma: PrismaClient,
  role: { roleId: string; userId: string; spaceId: string },
  counted: number,
): Promise<number | undefined> {
  const [rounds, marks] = await Promise.all([
    prisma.recruitingCalibrationRound.findMany({
      where: { roleId: role.roleId, status: "shown" },
      orderBy: { createdAt: "asc" },
      select: { effectId: true, candidateKeys: true },
    }),
    readRecruitingResultsMarks(
      prisma,
      { userId: role.userId, spaceId: role.spaceId, email: "", isDeploymentOwner: false },
      { roleId: role.roleId },
    ),
  ]);
  const effects = rounds.length
    ? await prisma.externalEffect.findMany({
        where: { id: { in: rounds.map((round) => round.effectId) } },
        select: { id: true, request: true },
      })
    : [];
  const askedOf = new Map(
    effects.map((effect) => {
      const request = effect.request;
      const value =
        request && typeof request === "object" && !Array.isArray(request)
          ? Number((request as Record<string, unknown>).asked)
          : Number.NaN;
      return [effect.id, Number.isInteger(value) && value > 0 ? value : undefined] as const;
    }),
  );
  let open: { asked: number; keys: Set<string> } | undefined;
  for (const round of rounds) {
    const asked = askedOf.get(round.effectId);
    if (asked !== undefined && (asked !== open?.asked || open.keys.size >= open.asked)) {
      open = { asked, keys: new Set() };
    }
    for (const key of round.candidateKeys) open?.keys.add(key);
  }
  if (!open) return undefined;
  const notAFit = new Set(
    marks.filter((mark) => mark.mark === "not a fit").map((mark) => mark.candidateKey),
  );
  return counted - [...open.keys].filter((key) => !notAFit.has(key)).length + open.asked;
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
  target?: number,
): string {
  const shown = counts.counted + counts.turnedDown;
  // Staging 11-26: asked for ten, two were listed and nothing said eight were still to come.
  const missing = Math.max(0, (target ?? 0) - counts.counted);
  const still = missing
    ? chinese
      ? `还差 ${missing} 人，继续找。`
      : `${missing} still to come.`
    : "";
  if (shown <= listed && !counts.turnedDown) return still;
  const line = chinese
    ? counts.turnedDown
      ? `累计展示 ${shown} 人，你淘汰了 ${counts.turnedDown} 人，计入 ${counts.counted} 人。`
      : `累计展示 ${shown} 人。`
    : counts.turnedDown
      ? `${shown} shown so far, ${counts.turnedDown} turned down by you, ${counts.counted} counted.`
      : `${shown} shown so far.`;
  return still ? (chinese ? `${line}${still}` : `${line} ${still}`) : line;
}

/** What a round's result tells the agent when the request it serves is not yet met. */
export function roundStillMissing(counted: number, target?: number) {
  const stillMissing = Math.max(0, (target ?? 0) - counted);
  return stillMissing
    ? {
        stillMissing,
        requestOpen: `The recruiter's request is ${stillMissing} short.`,
      }
    : {};
}

type StoredBlock = { kind?: unknown; text?: unknown; recruitingRoundList?: { roundId?: unknown } };
const storedBlocks = (blocks: unknown) => (Array.isArray(blocks) ? (blocks as StoredBlock[]) : []);

/**
 * A round list the role's chat posted after the latest recorded round: the next round is shown
 * there and its record is still being written (a refused record is retried).
 */
export async function roundListedNotRecorded(
  prisma: PrismaClient,
  input: { roleId: string; after: string },
): Promise<boolean> {
  const role = await prisma.recruitingRole.findFirst({
    where: { id: input.roleId },
    select: { sourceThreadId: true },
  });
  if (!role?.sourceThreadId) return false;
  const messages = await prisma.message.findMany({
    where: { threadId: role.sourceThreadId, role: "bot", createdAt: { gt: new Date(input.after) } },
    orderBy: { seq: "desc" },
    take: 20,
    select: { blocks: true },
  });
  return messages.some((message) =>
    storedBlocks(message.blocks).some(
      (block) => block.recruitingRoundList && block.recruitingRoundList.roundId === undefined,
    ),
  );
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
      storedBlocks(message.blocks).flatMap((block) =>
        block.kind === "text" && typeof block.text === "string" && !block.recruitingRoundList
          ? [block.text]
          : [],
      ),
    )
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

/**
 * A saved search row as the agent sees it: who the person is, the search's grade and the judge's
 * verdict on each requirement. When the judge has read the person, the search's own prose about
 * them is left out: the list's row is written from the judge's verdicts, and headings written
 * from the search's reason said "all requirements shown" above a row saying two of five met
 * (staging and branch plays 11-27). Record keeping fields are never the agent's to read out.
 */
export function searchRowForAgent(row: Record<string, unknown>): Record<string, unknown> {
  const {
    rowIndex: _rowIndex,
    email: _email,
    locationTag: _locationTag,
    reason,
    snippet,
    ...person
  } = row;
  const judged =
    typeof row.requirements_assessment === "string" && row.requirements_assessment.trim();
  return judged
    ? person
    : {
        ...person,
        ...(reason !== undefined ? { reason } : {}),
        ...(snippet !== undefined
          ? { snippet: typeof snippet === "string" ? snippet.slice(0, 160) : snippet }
          : {}),
      };
}

/**
 * A round's people in the order the list prints them: a group's people stand together under its
 * one heading, groups in the order they first appear. The round is recorded in this order too, so
 * "number 9" names the same person in the list and in the record (staging 11-27: "6 and 9" turned
 * down the person recorded ninth, who was printed tenth).
 */
export function inGroupOrder(
  keys: readonly string[],
  groupOf: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!groupOf) return [...keys];
  const group = (key: string) => groupOf[key]?.trim();
  return [...new Set(keys.map(group))].flatMap((one) => keys.filter((key) => group(key) === one));
}
