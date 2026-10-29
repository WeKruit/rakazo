import type { ConnectorTool } from "@rakazo/adapter-kit";

/**
 * Turn-end invariants every agent's human-facing turn keeps, enforced by the server from the
 * run's own tool records instead of prompt prose:
 * - a turn that did consequential work ends with a visible report of it, and no card or guard
 *   replaces that report;
 * - a reply that declines or defers the request, or hands the person a pick the agent could
 *   make, gets one retry that asks for a best-guess action or one question card instead.
 */

/** Work a person needs to hear about. Reads, lookups of saved state and questions are not work. */
export type TurnWork =
  | "people_search"
  | "people_saved"
  | "round"
  | "role"
  | "feedback"
  | "candidates"
  | "crm"
  | "contacts"
  | "draft"
  | "scheduling"
  | "connected";

/** Operations of the recruiting tools that read or show and change nothing. */
const READ_OPERATIONS = new Set([
  "read",
  "status",
  "rows",
  "list",
  "sources",
  "resolve",
  "round",
  "replies",
  "roles",
  "presence",
  "memberships",
  "candidates",
  "important",
  "candidateDetails",
  "roleCampaigns",
  "mail",
  "roleMail",
  "sequenceStats",
  "unassignedSequences",
  "campaigns",
  "campaignLeads",
  "show_picks",
]);

const RECRUITING_WORK: Record<string, TurnWork> = {
  recruiting_role: "role",
  recruiting_feedback: "feedback",
  recruiting_shortlist: "candidates",
  recruiting_assess: "candidates",
  recruiting_profiles: "candidates",
  recruiting_notes: "candidates",
  recruiting_crm_target: "crm",
  recruiting_crm_import: "crm",
  recruiting_reply: "draft",
  recruiting_scheduling: "scheduling",
  recruiting_reminders: "scheduling",
};

export type ToolSettlement = {
  ok: boolean;
  result?: unknown;
  /** Declared read-only flag of a connector call; undefined for other tools. */
  readOnly?: boolean;
};

/** The source-wide counts a contact lookup returns, present only on a contact lookup result. */
function isContactLookup(result: unknown): boolean {
  const object = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return [result, object(result)?.details, object(result)?.result]
    .map((value) => object(object(value)?.structuredContent))
    .some((value) => value?.source === "local_contact_lookup");
}

/**
 * What a tool call did, from its name, arguments and (once it returned) its result; undefined
 * when it changed nothing a person needs to hear about. A failed call did nothing.
 */
export function turnWork(
  name: string,
  args: Record<string, unknown>,
  settled?: ToolSettlement,
): TurnWork | undefined {
  if (settled && !settled.ok) return undefined;
  if (settled && isContactLookup(settled.result)) return "contacts";
  const operation = typeof args.operation === "string" ? args.operation : undefined;
  if (name.endsWith("web_search_advanced_exa")) return "people_search";
  if (name === "recruiting_research") {
    if (operation && READ_OPERATIONS.has(operation)) return undefined;
    return operation === "calibration_round" ? "round" : "people_saved";
  }
  const recruiting = RECRUITING_WORK[name];
  if (recruiting) return operation && READ_OPERATIONS.has(operation) ? undefined : recruiting;
  if (settled?.readOnly !== false) return undefined;
  const action = (name.split("__").at(-1) ?? name).toLowerCase();
  if (/draft|campaign|lead/.test(action)) return "draft";
  if (/book|calendar|event|schedul/.test(action)) return "scheduling";
  return "connected";
}

/** Past-tense lines for the deterministic report, in the order work is listed. */
const WORK_DONE: Record<TurnWork, string> = {
  people_search: "searched for people",
  people_saved: "saved people to the role",
  round: "recorded the round",
  role: "updated the role",
  feedback: "recorded your feedback",
  candidates: "updated candidate decisions",
  crm: "updated candidate records",
  contacts: "looked up contact details",
  draft: "saved the email draft",
  scheduling: "updated the schedule",
  connected: "made changes in a connected app",
};

/** The short report the server posts when the model ended without one. */
export function turnReportText(work: readonly TurnWork[], savedPeople?: number): string {
  const done = [...new Set(work)].map((item) => WORK_DONE[item]);
  const saved =
    savedPeople && work.some((item) => item === "people_search" || item === "people_saved")
      ? ` ${savedPeople} ${savedPeople === 1 ? "person is" : "people are"} saved for this role.`
      : "";
  return `Done: ${done.join(", ")}.${saved}`;
}

/** A question that also states something ("The pool is now 139. Keep going?") reports it. */
export function questionStatesWork(question: string): boolean {
  return question
    .trim()
    .split(/(?<=[.!?。！？\n])/)
    .map((sentence) => sentence.trim())
    .some((sentence) => sentence.length >= 12 && !/[?？]$/.test(sentence));
}

const ASK_CARRIES: readonly TurnWork[] = ["role", "feedback"];

/** Model-facing: the one extra step before a question card when the work is unreported. */
export const REPORT_BEFORE_ASK =
  "Not asked yet: you have not told the user what you just did. Report it briefly with message_user (counts and names, no internal ids), then ask again.";

/** Model-facing: the last silent-turn continuation when the work is unreported. */
export const REPORT_BEFORE_END =
  "Finish the original task from the latest tool result, then give the user the final answer: report what you did (counts and names, no internal ids) and show in full anything they asked to see, such as a draft.";

type Entry =
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "report" };

/**
 * The run's tool calls and visible replies in stream order. Entries are added by the executor
 * while it consumes the runtime's events, so narration written before a tool call never counts
 * as that call's report; results arrive from the tool executor.
 */
export class TurnReportLedger {
  private readonly entries: Entry[] = [];
  private readonly settled = new Map<string, ToolSettlement>();
  private asksSeen = 0;
  private asksWaited = 0;
  private wake: (() => void) | undefined;
  private askBounced = false;

  constructor(readonly enabled: boolean) {}

  tool(id: string, name: string, args: Record<string, unknown>) {
    this.entries.push({ kind: "tool", id, name, args });
    if (name === "ask_user") {
      this.asksSeen += 1;
      this.wake?.();
    }
  }

  settle(id: string, settlement: ToolSettlement) {
    this.settled.set(id, settlement);
  }

  /** Visible text from the agent (a reply, message_user, narration, a list the server posted). */
  report() {
    this.entries.push({ kind: "report" });
  }

  private workOf(entry: Entry): TurnWork | undefined {
    return entry.kind === "tool"
      ? turnWork(entry.name, entry.args, this.settled.get(entry.id))
      : undefined;
  }

  /** Work done since the last visible report; a recorded round is its own report (its list). */
  owed(): TurnWork[] {
    return this.owedIn(this.entries);
  }

  /** What would be unreported without the reply written after the last tool call. */
  owedWithoutFinalReply(): TurnWork[] {
    const lastTool = this.entries.findLastIndex((entry) => entry.kind === "tool");
    return this.owedIn(this.entries.slice(0, lastTool + 1));
  }

  private owedIn(entries: readonly Entry[]): TurnWork[] {
    if (!this.enabled) return [];
    const owed: TurnWork[] = [];
    for (const entry of entries) {
      const work = this.workOf(entry);
      // The first picks shown in chat report the searches behind them, as the round's list does.
      const shown =
        entry.kind === "tool" &&
        entry.name === "recruiting_research" &&
        entry.args.operation === "show_picks" &&
        this.settled.get(entry.id)?.ok === true;
      if (entry.kind === "report" || work === "round" || shown) owed.length = 0;
      else if (work) owed.push(work);
    }
    return owed;
  }

  /** This attempt showed or recorded a round's people: the first-ten deliverable. */
  presentedRound(): boolean {
    return this.entries.some(
      (entry) =>
        entry.kind === "tool" &&
        entry.name === "recruiting_research" &&
        (entry.args.operation === "calibration_round" || entry.args.operation === "show_picks") &&
        this.settled.get(entry.id)?.ok === true,
    );
  }

  /** Any consequential work in this attempt. */
  worked(): boolean {
    return this.entries.some((entry) => this.workOf(entry) !== undefined);
  }

  /** The newest consequential work in this attempt, passing over the kinds given. */
  lastWork(except: readonly TurnWork[] = []): TurnWork | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const work = this.workOf(this.entries[index]!);
      if (work && !except.includes(work)) return work;
    }
    return undefined;
  }

  /**
   * Resolves once the executor has consumed the ask_user call now being asked, so everything the
   * model wrote before it is counted; gives up after a short wait rather than hold the card.
   */
  async caughtUpToAsk(timeoutMs = 2_000) {
    this.asksWaited += 1;
    const deadline = Date.now() + timeoutMs;
    while (this.asksSeen < this.asksWaited && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    this.wake = undefined;
  }

  /** The note for a question asked over unreported work, once per attempt; else undefined. */
  bounceAsk(question: string): string | undefined {
    // Saving the role or the recruiter's answers is how intake leads to its next question; the
    // card itself carries on from them, so only other work needs a report first.
    const owed = this.owed().filter((work) => !ASK_CARRIES.includes(work));
    if (this.askBounced || !owed.length || questionStatesWork(question)) return undefined;
    this.askBounced = true;
    return REPORT_BEFORE_ASK;
  }
}

/** What a person asked for, by kind of capability. */
export type Capability = "send" | "contacts" | "schedule" | "draft" | "search";

const REQUEST_KINDS: Record<Capability, RegExp> = {
  send: /\bsend\b|\bemail (?:it|this|them|him|her)\b|发(?:送|给|出|邮件|信|\d)/i,
  contacts: /\bcontacts?\b|\bemail address|邮箱|联系方式/i,
  schedule: /\binterview|\bschedul|\bbook|\bavailab|\bcalendar|面试|约.{0,6}(?:时间|面)/i,
  draft: /\bdraft|草稿|写.{0,8}(?:邮件|email)/i,
  search: /\bfind\b|\bsearch|\bmore (?:people|candidates)|再找|找\d|找更多/i,
};
// Tool operations (the last "__" segment) that do each kind of request.
const TOOL_KINDS: Record<Capability, RegExp> = {
  send: /send|reply_to|activate_campaign|forward/,
  contacts: /contact|enrich|lookup|find_emails/,
  schedule: /booking|calendar|availability|schedul/,
  draft: /draft|recruiting_reply|role_campaign/,
  search: /web_search_advanced_exa|recruiting_research/,
};
// A teammate's roster entry (name, title, description, assigned services) that names each kind.
const TEAMMATE_KINDS: Record<Capability, RegExp> = {
  send: /\bsend|outreach|\bemail/i,
  contacts: /contact|enrich/i,
  schedule: /schedul|calendar|booking|interview/i,
  draft: /draft|outreach/i,
  search: /sourc|research|people search/i,
};

/**
 * A final reply that refuses the request outright. Drawn from the release regression's decline
 * checks so the server and the harness agree.
 */
const DECLINE =
  /\bI (?:can(?:no|['’])t|(?:could(?:n['’]t| not)|was(?:n['’]t| not) able to)(?! (?:find|locate|reach))|am unable to|['’]m unable to|am not able to|['’]m not able to|don['’]t have (?:access|a tool|the ability|permission))\b|\b(?:that['’]s|this is|it['’]s) (?:outside|beyond) (?:my|what I)\b|\bnot something I can\b|\bnot (?:send-)?ready to send\b|\bcan(?:no|['’])t (?:send|look up|book|schedule|draft|prepare)\b|我(?:无法|不能|没法|没有权限|做不了)|无法(?:发送|完成|执行|代|查|找|安排|准备)/i;
/** A reply that offers the work back instead of doing it ("Do you want me to…?", 要不要我…). */
const DEFER =
  /\b(?:do you want|would you like|want) me to\b|\bshall I\b|\bshould I (?:go ahead|proceed|start|send|draft|look|find|search|book|schedule|reach|contact)\b|\bif you(?:['’]d| would)? like,? I can\b|要不要我|需要我.{0,24}[吗么]|是否需要我|要我.{0,24}[吗么]|需要你先|请先(?:确认|提供|告诉)/i;
/** A reply that hands the recruiter a choice the agent could make ("Which people…?"). */
const PICK =
  /\bwhich (?:\d+ |of (?:them|these|the \w+) |ones?\b|people|candidates?|person|emails?|interviews?)[^.!?\n]{0,60}\b(?:should I|do you want|would you like|to (?:send|email|contact|reach|draft|look up|book|schedule|process|handle))\b|^which (?:\d+|ones?|people|candidates?|person)\b[^.!?\n]{0,30}[?？]$|(?:(?:哪些|哪几)(?:个|位)?(?:人|候选人)|哪位|哪个(?:人|候选人)).{0,20}(?:发|联系|约|处理|查|写)|(?:发给|联系|约)(?:谁|哪些|哪几|哪位)/i;

export type DeclineKind = "decline" | "defer" | "pick" | "text_question";
/** `keep` is the reply without the question, when the reply also delivered a draft. */
export type Declined = { sentence: string; kind: DeclineKind; keep?: string };

/** Where a drafted email starts in a reply: an "Email N" heading or a Subject: line. */
const DRAFT_START = /(?:^|\n)\s*(?:[#*_]+\s*)?(?:Email \d|Subject:)/i;
/** A question to the user about the draft itself, after the draft (not the candidate's "open to a chat?"). */
const ABOUT_DRAFT =
  /\b(?:draft|emails?|change|edit|send|tweak|adjust|version|tone|shorter|longer)\b|改|发/i;
/** A choice asked as an instruction instead of a question mark. */
const ASKS_TO_CHOOSE =
  /\b(?:please|just) (?:choose|pick|select|tell me|let me know)\b|请(?:选择|选|告诉我)/i;
const asksUser = (sentence: string) => /[?？]$/.test(sentence) || ASKS_TO_CHOOSE.test(sentence);

/** The first sentence of a reply that declines, defers or hands back a pick, else undefined. */
export function declinedSentence(text: string): Declined | undefined {
  // A drafted email is the deliverable, not the reply's own words: its "Would you be open…?"
  // is no question to the user, so only the text before the first email is read, and after it
  // only a closing question about the draft.
  const draft = text.search(DRAFT_START);
  const own = draft >= 0 ? text.slice(0, draft) : text;
  const sentences = own
    .split(/(?<=[.!?。！？\n])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (DECLINE.test(sentence)) return { sentence, kind: "decline" };
    if (PICK.test(sentence)) return { sentence, kind: "pick" };
    if (DEFER.test(sentence)) return { sentence, kind: "defer" };
  }
  // A clarifying question typed into the reply instead of a question card.
  const question = sentences.find(asksUser);
  if (question) return { sentence: question, kind: "text_question" };
  if (draft < 0) return undefined;
  const paragraphs = text.trimEnd().split(/\n\s*\n/);
  const last = paragraphs.at(-1)?.trim() ?? "";
  const asks = last.split(/(?<=[.!?。！？])\s*/).some((sentence) => asksUser(sentence.trim()));
  return paragraphs.length > 1 && asks && ABOUT_DRAFT.test(last)
    ? { sentence: last, kind: "text_question", keep: paragraphs.slice(0, -1).join("\n\n") }
    : undefined;
}

export type Teammate = { id: string; name: string; about: string };

/** `keep` is the part of the reply still shown, when the reply also delivered a draft. */
export type DeclineRetry = { sentence: string; note: string; keep?: string };

/** Model-facing: the substance of every decline retry; tools or a teammate are named after it. */
export const DECLINE_RETRY_NOTE =
  "Do not decline or defer. If who, what or when is unclear (for a send or booking: the recipients, the email, the time), ask one clear question with ask_user, with concrete options and a custom answer. Otherwise do it now with your tools, or hand it to the teammate who can. Anything that needs approval shows its own card when you call the tool; never ask for approval in text. If something is truly missing after that, say exactly what.";

/** Model-facing: a clarifying question asked in plain text goes on a question card instead. */
export const TEXT_QUESTION_NOTE =
  "You asked the user in plain text. Ask it with ask_user instead: the question in one sentence, concrete options (the people or choices you listed) and a custom answer, without saying what you could not do or find. Your question was";

/**
 * One retry for a final reply that declines, defers or hands back a pick. A refusal is retried
 * when the turn did nothing, or when it refuses the kind of work the person asked for (a refused
 * aside inside a report of done work stands). An offer or a pick question is retried only when
 * the turn did nothing: after real work, "want me to keep going?" is a fair next step. The note
 * names the tools or teammate for the asked kind of work when there are any. Undefined keeps
 * the reply.
 */
export function declineRetry(input: {
  reply: string;
  request: string;
  tools: readonly Pick<ConnectorTool, "name">[];
  teammates: readonly Teammate[];
  /** The turn did consequential work (see TurnReportLedger.worked). */
  worked?: boolean;
}): DeclineRetry | undefined {
  const declined = declinedSentence(input.reply);
  // A reply that shows a drafted email delivered the work; holding it back would lose the draft.
  if (!declined || (DRAFT_START.test(input.reply) && declined.keep === undefined)) return undefined;
  const { sentence } = declined;
  const asked = (Object.keys(REQUEST_KINDS) as Capability[]).filter((kind) =>
    REQUEST_KINDS[kind].test(input.request),
  );
  const refusesAsked = asked.some((kind) => REQUEST_KINDS[kind].test(sentence));
  // A send or booking ends on its card (planDeclineRetry never retries after one), so a decline
  // without it refused the request whatever the sentence names.
  const cardOwed = asked.includes("send") || asked.includes("schedule");
  if (input.worked && !(declined.kind === "decline" && (refusesAsked || cardOwed)))
    return undefined;
  const quoted = sentence.slice(0, 200);
  if (declined.kind === "text_question")
    return {
      sentence,
      note: `${TEXT_QUESTION_NOTE} ("${quoted}")`,
      ...(declined.keep === undefined ? {} : { keep: declined.keep }),
    };
  const lead =
    declined.kind === "pick"
      ? `Your reply asked the user to choose ("${quoted}"). When the request names the people or a number, use those; otherwise ask that choice as one ask_user question with concrete options (such as the person just discussed or the first results).`
      : `Your reply ${declined.kind === "defer" ? "deferred" : "declined"} the request ("${quoted}").`;
  const own = asked.flatMap((kind) =>
    input.tools
      .map((tool) => tool.name)
      .filter((name) => TOOL_KINDS[kind].test((name.split("__").at(-1) ?? name).toLowerCase())),
  );
  const mate = own.length
    ? undefined
    : asked
        .map((kind) =>
          input.teammates.find((teammate) =>
            TEAMMATE_KINDS[kind].test(`${teammate.name} ${teammate.about}`),
          ),
        )
        .find(Boolean);
  const named = own.length
    ? ` You have ${[...new Set(own)].slice(0, 3).join(", ")} for it.`
    : mate
      ? ` ${mate.name} can do it: hand it to ${mate.name} now with handoff_to_bot (bot_id ${mate.id}), quoting the user's words.`
      : "";
  return { sentence, note: `${lead} ${DECLINE_RETRY_NOTE}${named}` };
}
