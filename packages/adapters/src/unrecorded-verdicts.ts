import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, readRecruiterVerdicts } from "@rakazo/db";
import { handedInRecruiterWords } from "./global-role-writes.js";

const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Whether the recruiter's words name a saved person: a CJK name as written, otherwise the first
 * and last name as whole words ("Victor Doe" names "Victor Middle Doe").
 */
export function namesPerson(said: string, name: string): boolean {
  const words = fold(name.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((word) => word.length > 1 || /\p{Script=Han}/u.test(word));
  if (!words.length) return false;
  const text = ` ${fold(said)} `;
  if (/\p{Script=Han}/u.test(name)) return text.replace(/ /g, "").includes(words.join(""));
  return [words[0]!, words.at(-1)!].every((word) => text.includes(` ${word} `));
}

/**
 * People from the role's latest round the recruiter named after it was shown, with no verdict or
 * hold/pass saved for them. Branch b0ceaea0 (feedback-on-some-people): three people were turned
 * down in the main chat, the role team never saved it, and Results marked them only after the
 * recruiter complained. A fact for the agent, never a refusal or a verdict of its own.
 */
export async function namedWithoutVerdict(
  prisma: PrismaClient,
  actor: Actor,
  input: { roleId: string; threadId: string },
): Promise<{ round: number; names: string[] } | undefined> {
  const round = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId: input.roleId },
    orderBy: { round: "desc" },
    select: { round: true, candidateKeys: true, createdAt: true },
  });
  if (!round?.candidateKeys.length) return undefined;
  const messages = await prisma.message.findMany({
    where: { threadId: input.threadId, role: "user", createdAt: { gt: round.createdAt } },
    orderBy: { seq: "desc" },
    take: 20,
    select: { blocks: true },
  });
  const said = messages
    .flatMap((message) => (Array.isArray(message.blocks) ? message.blocks : []))
    .map((block) => {
      const { kind, text } = (block ?? {}) as { kind?: unknown; text?: unknown };
      if (typeof text !== "string") return "";
      if (kind === "text") return text;
      return kind === "bot_message_received" ? (handedInRecruiterWords(text) ?? "") : "";
    })
    .join("\n");
  if (!said.trim()) return undefined;
  const rows = await prisma.recruitingCandidateOccurrence.findMany({
    where: { roleId: input.roleId, candidateKey: { in: round.candidateKeys }, name: { not: null } },
    distinct: ["candidateKey"],
    select: { candidateKey: true, name: true },
  });
  const named = rows.filter((row) => row.name && namesPerson(said, row.name));
  if (!named.length) return undefined;
  const keys = named.map((row) => row.candidateKey);
  const [verdicts, decided] = await Promise.all([
    readRecruiterVerdicts(prisma, actor, { roleId: input.roleId, candidateKeys: keys }),
    prisma.recruitingCandidate.findMany({
      where: {
        roleId: input.roleId,
        candidateKey: { in: keys },
        consideration: { not: Prisma.DbNull },
      },
      select: { candidateKey: true },
    }),
  ]);
  const done = new Set([...verdicts.keys(), ...decided.map((row) => row.candidateKey)]);
  const names = named.filter((row) => !done.has(row.candidateKey)).map((row) => row.name!);
  return names.length ? { round: round.round, names } : undefined;
}

/** Model-facing: the people named without a saved verdict, for the role's run context. */
export const namedWithoutVerdictText = (found: { round: number; names: string[] }) =>
  `Since round ${found.round} was shown the recruiter wrote about ${found.names.join(", ")} from it, and nothing they said about them is saved yet. Save their words about each person with recruiting_feedback (candidate review: not_fit, good_example, or hold/pass as they said) before the next search, so Results and the next round show it.`;
