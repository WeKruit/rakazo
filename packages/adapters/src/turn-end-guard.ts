import type { PrismaClient } from "@rakazo/db";

export const AUTOCONTINUE_NONCE_PREFIX = "autocontinue:";

type RoundPrisma = Pick<PrismaClient, "externalEffect"> & {
  recruitingCandidateOccurrence: Pick<PrismaClient["recruitingCandidateOccurrence"], "findMany">;
};
type RoundPerson = {
  name?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  /** The search's own sentence on why it returned the person. */
  reason?: string | null;
  /** How the person's full profile was judged on each requirement of the role, when it was. */
  verdicts?: Array<{ statement: string; level: string; avoid?: boolean }>;
};

/** The saved people behind round keys, each with its search's reason and the judged verdicts. */
export async function recruitingRoundPeople(
  prisma: RoundPrisma,
  input: { threadId: string; spaceId: string; roleId: string; candidateKeys: readonly string[] },
) {
  // Any saved search in this conversation: the round is often recorded by a later run.
  const [searches, occurrences] = await Promise.all([
    prisma.externalEffect.findMany({
      where: {
        spaceId: input.spaceId,
        run: { threadId: input.threadId },
        kind: "recruiting_research",
        status: "completed",
        request: { path: ["operation"], equals: "save_search" },
      },
      select: { request: true, result: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.recruitingCandidateOccurrence.findMany({
      where: { roleId: input.roleId, candidateKey: { in: [...input.candidateKeys] } },
      select: {
        candidateKey: true,
        name: true,
        title: true,
        company: true,
        location: true,
        matchFields: true,
      },
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
    }),
  ]);
  const people = new Map<string, RoundPerson>();
  const judged = new Map<string, RoundPerson["verdicts"]>();
  for (const { matchFields, ...row } of occurrences) {
    if (!people.has(row.candidateKey)) people.set(row.candidateKey, row);
    const criteria = (matchFields as { criteria?: RoundPerson["verdicts"] } | null)?.criteria;
    if (Array.isArray(criteria) && criteria.length && !judged.has(row.candidateKey))
      judged.set(row.candidateKey, criteria);
  }
  for (const search of searches) {
    const rows = (search.result as { candidateRows?: unknown } | null)?.candidateRows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<RoundPerson & { candidateKey?: unknown }>)
      if (typeof row.candidateKey === "string" && row.reason)
        people.set(row.candidateKey, {
          ...row,
          ...people.get(row.candidateKey),
          reason: row.reason,
        });
  }
  for (const [key, verdicts] of judged) {
    const person = people.get(key);
    if (person) people.set(key, { ...person, verdicts });
  }
  return people;
}

/**
 * One line under a listed person: how many of the role's requirements the full profile meets and
 * which ones it does not show or contradicts; a person not judged yet gets the search's own
 * reason instead. A row used to quote the profile's opening words, and
 * "Aug 2021 - Present (4 years and 11 months)", one job's length, read as the person's whole
 * experience: a recruiter turned down someone judged to meet five years (11-26).
 */
export function roundVerdictLine(
  verdicts: NonNullable<RoundPerson["verdicts"]>,
  chinese: boolean,
): string | undefined {
  const asked = verdicts.filter((item) => !item.avoid);
  if (!asked.length) return undefined;
  const at = (...levels: string[]) =>
    asked.filter((item) => levels.includes(item.level)).map((item) => item.statement);
  const met = at("strong").length;
  const parts = chinese
    ? ([
        ["部分符合：", at("medium", "weak")],
        ["资料未写：", at("silent")],
        ["不符合：", at("opposite")],
      ] as const)
    : ([
        ["partly: ", at("medium", "weak")],
        ["not stated: ", at("silent")],
        ["does not meet: ", at("opposite")],
      ] as const);
  const rest = parts.flatMap(([label, items]) =>
    items.length ? [`${label}${items.join(chinese ? "、" : ", ")}`] : [],
  );
  const head = chinese
    ? `符合 ${met}/${asked.length} 项要求`
    : `Meets ${met} of ${asked.length} requirements`;
  return [head, ...rest].join(chinese ? "；" : "; ");
}

/**
 * The ten of a recorded round as the chat lists them: name, title, company, location and the
 * profile passage the people search returned for each, read from this run's saved searches.
 */
export async function recruitingRoundListText(
  prisma: RoundPrisma,
  input: {
    threadId: string;
    spaceId: string;
    roleId: string;
    candidateKeys: readonly string[];
    /** Leave out keys that name no saved person (a list still being written). */
    knownOnly?: boolean;
    /** The last key may be cut mid-word: leave it out while it is the start of another person's. */
    lastMayBeCut?: boolean;
    /** Per person, the heading of the group the agent put them in; printed where it changes. */
    groupOf?: Readonly<Record<string, string>>;
    /** The first line, when the list is not a round (a role's people listed elsewhere). */
    heading?: string;
    /** Number of the first line, for a later page of a longer list. */
    firstNumber?: number;
    /** The recruiter writes Chinese: the server's own words follow. */
    chinese?: boolean;
    /** Name, title, company and location only, so a long list fits one message. */
    brief?: boolean;
  },
) {
  const people = await recruitingRoundPeople(prisma, input);
  const last = input.candidateKeys.length - 1;
  const cut = (key: string, index: number) =>
    !!input.lastMayBeCut &&
    index === last &&
    [...people.keys()].some((other) => other !== key && other.startsWith(key));
  const keys = input.knownOnly
    ? input.candidateKeys.filter((key, index) => people.has(key) && !cut(key, index))
    : input.candidateKeys;
  if (input.knownOnly && !keys.length) return "";
  const lines = keys.map((key, index) => {
    const person = people.get(key);
    // The saved key is the profile link, so the name opens the person's LinkedIn profile.
    const slug = /^linkedin:(\/in\/[^\s/?#]+)\/?$/i.exec(key)?.[1];
    const name =
      person?.name && slug ? `[${person.name}](https://www.linkedin.com${slug})` : person?.name;
    const head = [name ? `**${name}**` : null, person?.title, person?.company, person?.location]
      .filter(Boolean)
      .join(" · ");
    // A person whose full profile was judged is described by that judgement, else by the search's
    // own reason for returning them.
    const verdicts = person?.verdicts;
    const passage = input.brief
      ? undefined
      : ((verdicts ? roundVerdictLine(verdicts, !!input.chinese) : undefined) ??
        roundPassage(person?.reason));
    // The agent's own grouping of the people, in its words.
    const group = input.groupOf?.[key]?.trim();
    const previous = index ? input.groupOf?.[keys[index - 1]!]?.trim() : undefined;
    const groupLine = group && group !== previous ? `${index ? "\n" : ""}${group}\n` : "";
    return `${groupLine}${(input.firstNumber ?? 1) + index}. ${head}${passage ? `\n   > ${passage}` : ""}`;
  });
  const heading =
    input.heading ??
    (input.chinese
      ? `本轮 ${lines.length} 人：`
      : `${lines.length} ${lines.length === 1 ? "person" : "people"} this round:`);
  return `${heading}\n\n${lines.join("\n")}`;
}

// One line a recruiter reads at a glance; the whole profile and assessment are in Results.
const PASSAGE_MAX = 120;

/**
 * A profile passage as the recruiter reads it: without the search's field scaffolding
 * ("Department: … • Level: …", "(US)", "...") and, when long, cut at a word, never mid-word.
 */
export function roundPassage(snippet: string | null | undefined): string | undefined {
  const text = (snippet ?? "")
    .replace(
      /(?:Department|Level|Seniority|Function):\s*[^•\n]*?(?=\s*(?:•|$|\n|Department:|Level:|Seniority:|Function:))/gi,
      " ",
    )
    .replace(/\s*•\s*/g, " ")
    .replace(/\s*\((?:US|USA)\)/g, "")
    .replace(/\s*\.{3,}\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  if (text.length <= PASSAGE_MAX) return text;
  const cut = text.slice(0, PASSAGE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > PASSAGE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** The declined turn a retry message was sent for, from that message's nonce. */
export function declinedRunId(clientNonce: string | null | undefined): string | undefined {
  if (!clientNonce?.startsWith(AUTOCONTINUE_NONCE_PREFIX) || !clientNonce.endsWith(":decline"))
    return undefined;
  return clientNonce.slice(AUTOCONTINUE_NONCE_PREFIX.length, -":decline".length) || undefined;
}
