import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { linkedinPersonKey } from "./recruiting-profiles.js";

export const AUTOCONTINUE_NONCE_PREFIX = "autocontinue:";

/** The recruiter's answers to the bot's question cards, keyed by question; a later answer wins. */
export function intakeAnswers(messages: readonly { role: string; blocks: unknown }[]) {
  const answers = new Map<string, string>();
  let question: string | undefined;
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (message.role !== "user") {
      const ask = blocks.find((block) => block.kind === "ask");
      question = ask?.kind === "ask" ? ask.text.trim().slice(0, 200) : undefined;
      continue;
    }
    const answer = blocks
      .flatMap((block) => (block.kind === "text" ? [block.text.trim()] : []))
      .filter(Boolean)
      .join("\n");
    if (question && answer) {
      answers.delete(question);
      answers.set(question, answer);
    }
    question = undefined;
  }
  return [...answers].map(([key, value]) => ({ key, value }));
}
/** An intake answer that only states a preference or lifts a limit, which narrows no search. */
const PREFERENCE_ANSWER =
  /^(prefer|preferred|nice to have|optional|either|any\b|no\b|not required|open to|偏好|优先|最好|可选|不限|都可以|无所谓|不需要)/i;

/**
 * The recruiter's answers that set a requirement, as search filters every search must apply: a
 * stated must-have such as a language narrows who is searched for instead of staying a note. An
 * answer worded as a preference or as lifting a limit stays in the brief only.
 */
export function answerSearchFilters(answers: readonly { key: string; value: string }[]) {
  return answers.flatMap(({ value }, index) =>
    value && !PREFERENCE_ANSWER.test(value.trim())
      ? [
          {
            id: `recruiter-answer-${index + 1}`,
            mode: "include" as const,
            origin: "user_instruction" as const,
            statement: value,
          },
        ]
      : [],
  );
}
type RoundPrisma = Pick<PrismaClient, "externalEffect"> & {
  recruitingCandidateOccurrence: Pick<PrismaClient["recruitingCandidateOccurrence"], "findMany">;
};
type RoundPerson = {
  name?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  snippet?: string | null;
};

/** The saved people behind round keys, each with the profile passage its search returned. */
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
        OR: [
          { request: { path: ["operation"], equals: "save_search" } },
          { request: { path: ["operation"], equals: "save_grades" } },
        ],
      },
      select: { request: true, result: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.recruitingCandidateOccurrence.findMany({
      where: { roleId: input.roleId, candidateKey: { in: [...input.candidateKeys] } },
      select: { candidateKey: true, name: true, title: true, company: true, location: true },
      orderBy: [{ page: { observedAt: "desc" } }, { rowIndex: "asc" }],
    }),
  ]);
  const people = new Map<string, RoundPerson>();
  for (const row of occurrences)
    if (!people.has(row.candidateKey)) people.set(row.candidateKey, row);
  // The check's own reason, read from the full profile, says more than the search's passage:
  // branch fr 11-21, a line quoting a team name made a Kafka engineer read as a backend one.
  const reasons = new Map<string, string>();
  for (const search of searches) {
    const grades = (search.request as { operation?: unknown; rows?: unknown } | null) ?? {};
    if (grades.operation === "save_grades") {
      if (Array.isArray(grades.rows))
        for (const grade of grades.rows as Array<{
          linkedin_url?: unknown;
          fit_reasons?: unknown;
        }>) {
          const key = linkedinPersonKey(grade.linkedin_url);
          if (key && typeof grade.fit_reasons === "string" && grade.fit_reasons.trim())
            reasons.set(key, grade.fit_reasons);
        }
      continue;
    }
    const rows = (search.result as { candidateRows?: unknown } | null)?.candidateRows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<RoundPerson & { candidateKey?: unknown }>)
      if (typeof row.candidateKey === "string" && row.snippet)
        people.set(row.candidateKey, { ...people.get(row.candidateKey), ...row });
  }
  for (const [key, snippet] of reasons) {
    const person = people.get(key);
    if (person) people.set(key, { ...person, snippet });
  }
  return people;
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
    /** Per person, the must-haves their row does not show. */
    unverified?: Readonly<Record<string, string>>;
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
  // The same open must-haves under every person say nothing about any one of them: say them once.
  const notes = keys.map((key) => input.unverified?.[key]?.trim() ?? "");
  const shared =
    keys.length > 1 && notes[0] && notes.every((note) => note === notes[0]) ? notes[0] : undefined;
  const lines = keys.map((key, index) => {
    const person = people.get(key);
    // The saved key is the profile link, so the name opens the person's LinkedIn profile.
    const slug = /^linkedin:(\/in\/[^\s/?#]+)\/?$/i.exec(key)?.[1];
    const name =
      person?.name && slug ? `[${person.name}](https://www.linkedin.com${slug})` : person?.name;
    const head = [name ? `**${name}**` : null, person?.title, person?.company, person?.location]
      .filter(Boolean)
      .join(" · ");
    const passage = input.brief ? undefined : roundPassage(person?.snippet);
    const unknown = shared ? undefined : input.unverified?.[key]?.trim();
    const unverifiedLabel = input.chinese ? "未核实：" : "Not verified: ";
    return `${(input.firstNumber ?? 1) + index}. ${head}${passage ? `\n   > ${passage}` : ""}${unknown ? `\n   ${unverifiedLabel}${unknown}` : ""}`;
  });
  const heading =
    input.heading ??
    (input.chinese
      ? `本轮 ${lines.length} 人：`
      : `${lines.length} ${lines.length === 1 ? "person" : "people"} this round:`);
  const sharedLine = input.chinese ? "所有人都还未核实：" : "Not verified for anyone yet: ";
  return `${heading}${shared ? `\n${sharedLine}${shared}` : ""}\n\n${lines.join("\n")}`;
}

const PASSAGE_MAX = 220;

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
