import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { blocksText } from "./reply-suggestion.js";

/**
 * After the recruiter turns people down for something their profiles do not show ("no Spark or
 * Kafka in prod shown"), the next round should not bring back people whose own round note says
 * the same thing is not shown. The agent writes that note itself (calibration_round's
 * `unverified`); this compares it with the recruiter's words since the last round, so the check
 * is the agent's own judgement held to what the recruiter asked, not a second evaluator.
 */

/** Words that appear in almost every note or request and name no requirement on their own. */
const GENERIC = new Set(
  (
    "and the with for not are was were has have had its their they this that these those from " +
    "into than then also only just more most very any all both each other shown show shows " +
    "visible verified unverified specific explicit explicitly concrete clear clearly whether " +
    "used use using work worked working experience experienced profile profiles passage search " +
    "row rows detail details evidence production level role roles current currently people " +
    "person need needs want like rest find round none them what which who said says actually"
  ).split(" "),
);
const ALIASES: Record<string, string> = { yrs: "years", yr: "years", year: "years" };

function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9+#]*|\d+\+?/g) ?? [];
  return new Set(
    words
      .map((word) => ALIASES[word] ?? word)
      .filter((word) => (word.length >= 3 || /\d/.test(word)) && !GENERIC.has(word)),
  );
}

/**
 * Per person, the terms of their unverified note that the recruiter's words also name. A word
 * matches its own longer or shorter form ("kafka" and "kafka's", "prod" never, it is generic).
 */
export function gapsRecruiterRaised(
  unverified: Readonly<Record<string, string>> | undefined,
  recruiterText: string,
): Map<string, string[]> {
  const asked = [...terms(recruiterText)];
  const raised = new Map<string, string[]>();
  if (!asked.length) return raised;
  for (const [key, note] of Object.entries(unverified ?? {})) {
    const hits = [...terms(note)].filter((term) =>
      asked.some(
        (word) =>
          word === term ||
          (word.length >= 4 &&
            term.length >= 4 &&
            (word.startsWith(term) || term.startsWith(word))),
      ),
    );
    if (hits.length) raised.set(key, hits);
  }
  return raised;
}

/**
 * The gaps of a later round's picks that the recruiter raised since the previous round was
 * recorded: their own messages and the briefs other agents passed on in this conversation.
 * Nothing before the first round is recorded, when every must-have may still be unknown.
 */
export async function raisedGapsSinceLastRound(
  prisma: PrismaClient,
  input: {
    threadId: string;
    roleId: string;
    botId: string;
    unverified: Readonly<Record<string, string>> | undefined;
  },
): Promise<Map<string, string[]>> {
  if (!input.unverified || !Object.keys(input.unverified).length) return new Map();
  const previous = await prisma.recruitingCalibrationRound.findFirst({
    where: { roleId: input.roleId },
    orderBy: { round: "desc" },
    select: { createdAt: true },
  });
  if (!previous) return new Map();
  const messages = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      createdAt: { gt: previous.createdAt },
      OR: [{ role: "user" }, { role: "bot", botId: { not: input.botId } }],
    },
    orderBy: { seq: "asc" },
    select: { blocks: true },
    take: 20,
  });
  const text = messages
    .map((message) =>
      Array.isArray(message.blocks) ? blocksText(message.blocks as MessageBlock[]) : "",
    )
    .join("\n");
  return gapsRecruiterRaised(input.unverified, text);
}
