import type { TurnWork } from "./turn-report.js";

/**
 * Claims Kruit makes to the recruiter about what happened, each checked against the turn's own
 * tool results. Staging 11-14: "The template is saved… ready to use" with nothing saved, "1 sent,
 * Ada queued" when the records showed two sent, and "Gmail is connected" right before the card
 * asking to connect it. One check covers every claim and every path (final reply and progress
 * lines), so no tool's result can be described as done without that result in the turn.
 *
 * Practice adopted: the "grounded claims" check of agent evals (a statement of an action needs a
 * tool receipt in the same trajectory), as in tau-bench's action/state checks.
 */
export type ClaimKind = "handed" | "saved" | "sent" | "connected" | "booked" | "created";

export type Claim = { kind: ClaimKind; sentence: string; count?: number };

/** What the turn's tools did and returned, from TurnReportLedger.receipts(). */
export type Receipts = {
  /** Work tools that returned this attempt, plus "memory" for a memory save that succeeded. */
  work: ReadonlySet<TurnWork | "memory">;
  /** A teammate or role was handed the work and answered this attempt: its report is its own. */
  delegated: boolean;
  /** A read returned this attempt. */
  read: boolean;
  /** Text of every result that returned this attempt, for the numbers a claim states. */
  results: string;
};

const CLAIMS: ReadonlyArray<{
  kind: ClaimKind;
  pattern: RegExp;
  backs: readonly (TurnWork | "memory")[];
}> = [
  {
    // Sim 11-14 schedule-interview: "I've passed it to the role" with no handoff, nothing booked.
    kind: "handed",
    pattern:
      /已(?:经)?(?:交给|转给|转交|派给|通知|让)|(?:交给|转给)[^，。]{0,12}了|\b(?:handed|passed|forwarded|delegated|sent|asked)\s+(?:it|this|that|the\s+\w+)?\s*(?:over\s+)?to\s+(?:the\s+)?(?:role|team|teammate|outreach|sourcer|scheduler|scheduling)\b|\b(?:asked|told)\s+(?:the\s+)?(?:role|team|teammate|outreach|sourcer|scheduler)\b/i,
    backs: [],
  },
  {
    kind: "sent",
    pattern:
      /已(?:经)?(?:发送|发出|发给|寄出)|发出去了|发了\s*\d+|\b(?:was|were|has been|have been|is|are|got|been)\s+sent\b|\bsent\s+(?:it|the|your|an?|to|\d+)\b|\b\d+\s+(?:emails?\s+)?(?:were\s+)?sent\b|\bqueued\b|已(?:进入|加入)?(?:发送)?队列|排队发送/i,
    backs: ["sent", "draft"],
  },
  {
    kind: "saved",
    pattern:
      /已(?:经)?(?:保存|存好|存入|存进|记下|记录|更新)|保存好了|存好了|(?:存|记)下来了|\b(?:is|are|was|were|has been|have been|been)\s+(?:saved|stored|recorded|updated)\b|\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:saved|stored|recorded|updated)\b|\bsaved\s+\d+/i,
    backs: [
      "people_saved",
      "role",
      "feedback",
      "candidates",
      "crm",
      "draft",
      "contacts",
      "round",
      "memory",
      "sender",
    ],
  },
  {
    kind: "connected",
    pattern:
      /(?:已|已经)连(?:接|上)|\b(?:gmail|mailbox|email|calendar|account)\s+(?:is|'s|was|has been)\s+(?:now\s+|already\s+)?connected\b/i,
    backs: ["sender", "connected"],
  },
  {
    kind: "booked",
    pattern:
      /已(?:经)?(?:预约|约好|安排好|订好)|\b(?:is|are|was|were|has been|have been)\s+(?:booked|scheduled)\b|\bi(?:'ve| have)\s+(?:booked|scheduled)\b/i,
    backs: ["scheduling"],
  },
  {
    kind: "created",
    pattern:
      /已(?:经)?(?:创建|建好|开好|新建)|\b(?:is|are|was|were|has been|have been)\s+created\b|\bi(?:'ve| have)\s+(?:created|opened|set up)\b/i,
    backs: ["role", "draft", "sender", "connected"],
  },
];

/** A clause that only says what will or would happen, or that it did not: no claim. */
const NOT_A_CLAIM =
  /[?？]|没|未|不|尚|还(?:没|未)|一旦|之后|以后|如果|等你|会|将|要|\b(?:not|no|never|once|after|when|if|until|unless|will|would|can|could|should|before|yet)\b|n't\b/i;

const clauses = (text: string) =>
  text
    .split(/[。！？!?；;，,\n]|(?<=\.)\s+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);

/**
 * The number a clause attaches to its claim ("2 sent", "存了 10 人"), if any. A role's ref or any
 * other id is not a count: sim 11-14, "Ref 15351 的岗位对话已开好" was held as "no result has 1535".
 */
function claimedCount(clause: string): number | undefined {
  const match =
    /(?<![\d.])(\d{1,4})(?![\d.])\s*(?:个|位|人|封|名|people|persons?|candidates?|emails?|leads?|profiles?)?/i.exec(
      clause.replace(
        /\d{1,2}:\d{2}|\b\d{4}-\d{2}-\d{2}\b|\{\{[^}]*\}\}|(?:\bref|\bid|#|编号)\s*[:：#]?\s*\d+/gi,
        " ",
      ),
    );
  return match ? Number(match[1]) : undefined;
}

/** Every claim the text makes of something done. */
export function claimsIn(text: string): Claim[] {
  const found: Claim[] = [];
  for (const sentence of clauses(text)) {
    if (NOT_A_CLAIM.test(sentence)) continue;
    const claim = CLAIMS.find(({ pattern }) => pattern.test(sentence));
    if (!claim) continue;
    const count = claimedCount(sentence);
    found.push({ kind: claim.kind, sentence, ...(count === undefined ? {} : { count }) });
  }
  return found;
}

/**
 * The first claim no result of this turn backs: its kind of work did not return, and no read or
 * teammate's report this turn carries it, or the number it states appears in no result. A status
 * question ("did it go out?") is answered by its reads; an instruction ("save it") is not.
 */
export function unbackedClaim(
  text: string,
  receipts: Receipts,
  options: { question?: boolean } = {},
): Claim | undefined {
  return claimsIn(text).find((claim) => {
    const spec = CLAIMS.find((entry) => entry.kind === claim.kind)!;
    const backed =
      spec.backs.some((work) => receipts.work.has(work)) ||
      receipts.delegated ||
      (receipts.read && options.question === true);
    if (!backed) return true;
    return (
      claim.count !== undefined &&
      receipts.results !== "" &&
      !new RegExp(`(?<![\\d.])${claim.count}(?![\\d.])`).test(receipts.results)
    );
  });
}

/** Model-facing: the one retry of a reply that states something no tool did this turn. */
export function unbackedClaimNote(claim: Claim): string {
  return `Your reply says "${claim.sentence.slice(0, 200)}", but no tool result this turn shows that${claim.count === undefined ? "" : ` (no result has ${claim.count})`}. Read the current record first and say exactly what it shows (names and counts from that result); an earlier step may already have done it, and what the record shows done is never done again. Only when the record shows it not done, do it now with the tool for it. Never describe anything as handed over, saved, sent, queued, connected, booked or created without the result that did it.`;
}
