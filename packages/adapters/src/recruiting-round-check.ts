import type { RecruitingCriterion, RecruitingCriterionExpression } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { countRecruitingRoleGrades } from "@rakazo/db";
import { handedInRecruiterWords } from "./global-role-writes.js";

/**
 * A calibration round's requirements and the agent's optional verdicts on them ("shown",
 * "unknown" or "fails"). What the recruiter says (a city, a level, the reason they turned people
 * down) is one of those requirements. The agent judges; this keeps a pick out only on its own
 * "fails" and turns its unknowns into the round list's notes.
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

/**
 * The brief fields the recruiter stated themselves, as requirements in their words; with
 * everyOrigin, the JD's too, which a pasted job states for them.
 */
function statedFields(brief: unknown, everyOrigin = false): Requirement[] {
  const fields = (brief as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return (fields as BriefField[]).flatMap((field) =>
    typeof field?.key === "string" &&
    typeof field.value === "string" &&
    field.state === "known" &&
    (field.origin === "user_instruction" || (everyOrigin && field.origin === "jd"))
      ? [
          {
            id: `brief:${field.key}`,
            // A field saved from an intake question keeps the question as its key; the answer
            // alone says the requirement.
            statement: field.key.trim().endsWith("?")
              ? field.value
              : `${field.key}: ${field.value}`,
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
  options: { everyOrigin?: boolean } = {},
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
    ...statedFields(role?.currentRevision.brief, options.everyOrigin),
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

export type RoundCheckResult = { ok: true; unverified: Record<string, string> };

/**
 * The picks' own verdicts, where the lead gave them: what no
 * row shows becomes the round list's "Not verified" note. Verdicts are optional: the search
 * grades the people it returns, and asking the lead for a verdict on every
 * criterion of every pick cost refusals and up to a minute a round (staging 11-15/16).
 */
export function checkRound(input: {
  keys: readonly string[];
  checks: RoundChecks | undefined;
  criteria: readonly RoundCriterion[];
}): RoundCheckResult {
  const unverified: Record<string, string> = {};
  if (!input.criteria.length) return { ok: true, unverified };
  const verdictOf = (key: string, id: string) => input.checks?.[key]?.[id];
  for (const key of input.keys) {
    // Something no pick's row shows is still unverified for each of them; the round list says
    // it once when every note is the same. A turned-down reason is not a requirement to list.
    const listed = input.criteria.filter(
      (criterion) =>
        verdictOf(key, criterion.id) === "unknown" && !criterion.id.startsWith("turned-down:"),
    );
    if (listed.length) unverified[key] = listed.map((criterion) => criterion.statement).join("; ");
  }
  return { ok: true, unverified };
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
 * agent never keeps a tally of its own: `fitShown`, the people graded Strong or Promising a round
 * has shown the recruiter, is the one count a request is measured by and the one told to them.
 */
export async function requestCounts(prisma: PrismaClient, roleId: string) {
  const [peopleInResults, grades] = await Promise.all([
    prisma.recruitingCandidate.count({ where: { roleId } }),
    countRecruitingRoleGrades(prisma, roleId),
  ]);
  return {
    fitShown: grades.fitShown,
    fitNotShownYet: grades.fit - grades.fitShown,
    notGradedYet: peopleInResults - grades.checked,
  };
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

const GENERIC_COMPANY_WORD =
  /^(?:data|tech\w*|people|group|global|systems?|solutions?|software|digital|services?|consult\w*|labs?|health\w*|senior|engineer\w*|cloud|inc|corp\w*|company|international|united|american|national|first|new)$/;

/** What the recruiter said in a message: a handed-in quote is their words, never Kruit's note. */
function saidText(blocks: unknown): string[] {
  return (Array.isArray(blocks) ? blocks : []).flatMap((block) => {
    const { kind, text } = (block ?? {}) as { kind?: unknown; text?: unknown };
    if (typeof text !== "string") return [];
    if (kind === "text") return [text];
    return kind === "bot_message_received" ? [handedInRecruiterWords(text) ?? text] : [];
  });
}

/**
 * People of the latest unapproved round that the recruiter's message names, by a name of theirs,
 * their number in the round ("#6") or their company ("the amazon ones"). A message that names
 * some of them is usually turning them down, which is feedback for the next round rather than
 * acceptance of this one. A message handed in by a teammate quotes the recruiter's words.
 */
export async function roundPeopleNamed(
  prisma: PrismaClient,
  input: { threadId: string; messageId: string },
): Promise<{ round: number; named: string[]; keys: string[] } | null> {
  const [thread, message] = await Promise.all([
    prisma.thread.findUnique({
      where: { id: input.threadId },
      select: { activeRecruitingRoleId: true },
    }),
    prisma.message.findUnique({ where: { id: input.messageId }, select: { blocks: true } }),
  ]);
  const roleId = thread?.activeRecruitingRoleId;
  if (!roleId || !message) return null;
  const text = saidText(message.blocks).join("\n");
  const round = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId },
    orderBy: { round: "desc" },
    select: { round: true, candidateKeys: true, approvedAt: true },
  });
  if (!text || !round || round.approvedAt) return null;
  const people = await prisma.recruitingCandidateOccurrence.findMany({
    where: { roleId, candidateKey: { in: round.candidateKeys }, name: { not: null } },
    distinct: ["candidateKey"],
    select: { candidateKey: true, name: true, company: true },
  });
  const said = text.toLowerCase();
  const says = (word: string) =>
    new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(
      said,
    );
  const numbers = new Set(
    [...said.matchAll(/(?:#|\bno\.?\s*|\bnumber\s+)(\d{1,2})\b/g)].map((match) => Number(match[1])),
  );
  const words = (value: string | null | undefined) =>
    (value ?? "")
      .toLowerCase()
      .split(/[\s,.()&/-]+/)
      .filter((word) => word.length >= 4);
  const named = round.candidateKeys.flatMap((key, index) => {
    const person = people.find((row) => row.candidateKey === key);
    const name = person?.name?.trim();
    // The company's first word: "Amazon" for "Amazon Web Services (AWS)"; a generic word such as
    // "People" (People Tech Group) names nobody.
    const company = words(person?.company).find((word) => !GENERIC_COMPANY_WORD.test(word));
    return words(name).some(says) || (company && says(company)) || numbers.has(index + 1)
      ? [{ key, name: name ?? `#${index + 1}` }]
      : [];
  });
  return named.length
    ? {
        round: round.round,
        named: named.map((person) => person.name),
        keys: named.map((person) => person.key),
      }
    : null;
}
