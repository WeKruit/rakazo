import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { Receipts } from "./claim-receipts.js";

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
  | "sent"
  | "scheduling"
  | "sender"
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

/** Tool operations that only read, by their leading verb. */
const READ_ACTION =
  /^(?:native_[a-z]+_)?(?:(?:get|list|search|read|fetch|lookup|query|count|describe|retrieve|preview)(?:_|$)|whoami$|me$)/;

/** A catalog call's own arguments (`connectors_execute_tool` nests them). */
function nestedArgs(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = args.arguments;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

/** A call's operation, read from a catalog call's nested arguments too. */
export function toolOperation(args: Record<string, unknown>): string | undefined {
  const nested = args.arguments;
  const operation =
    args.operation ??
    (nested && typeof nested === "object"
      ? (nested as Record<string, unknown>).operation
      : undefined);
  return typeof operation === "string" ? operation : undefined;
}

/** A call that only reads: a recruiting read operation or a get/list/search tool by name. */
export function readsOnly(name: string, args: Record<string, unknown>): boolean {
  const operation = toolOperation(args);
  if (name.startsWith("recruiting_"))
    return operation !== undefined && READ_OPERATIONS.has(operation);
  return READ_ACTION.test((name.split("__").at(-1) ?? name).toLowerCase());
}

/** A reply saying an approval card still waits or the email is not sent ("审批卡仍待你确认"). */
export const CLAIMS_CARD_PENDING =
  /(?:仍|还)?(?:在)?(?:等待|待)(?:你的?)?确认|(?:目前|状态)(?:为|是)?\**未发送|尚未发送|还没有?发送|\bstill (?:waiting|pending)\b|\bnot (?:yet )?(?:been )?sent\b/i;

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
  const operation = toolOperation(args);
  if (name.endsWith("web_search_advanced_exa") || name.endsWith("__agent_run"))
    return "people_search";
  if (name === "recruiting_research") {
    if (operation && READ_OPERATIONS.has(operation)) return undefined;
    return operation === "calibration_round" ? "round" : "people_saved";
  }
  const recruiting = RECRUITING_WORK[name];
  if (recruiting) return operation && READ_OPERATIONS.has(operation) ? undefined : recruiting;
  if (settled?.readOnly !== false) return undefined;
  // A catalog call names its tool in `id` ("server:get_bookings"); many servers declare no
  // read-only hint, so a get or list call is read by its name, never reported as a change.
  const target =
    (name === "connectors_execute_tool" || name === "mcp_execute_tool") &&
    typeof args.id === "string"
      ? (args.id.split(":").at(-1) ?? name)
      : name;
  const action = (target.split("__").at(-1) ?? target).toLowerCase();
  // A writable tool's read operation ("ensure_sender" with operation "read") changed nothing.
  if (READ_ACTION.test(action) || (operation && READ_ACTION.test(operation))) return undefined;
  // A send runs only once its card is confirmed, so a returned send went out.
  if (/^(?:native_[a-z]+_)?(?:activate_campaign|send_email|send_message|send)$/.test(action))
    return "sent";
  if (/sender|mailbox|sending_account/.test(action)) return "sender";
  // Ensuring a campaign that already exists, without new copy, changed nothing (staging 11-13:
  // each status check reported 「已完成：存好了邮件草稿」).
  if (
    action.startsWith("ensure_") &&
    !("steps" in (nestedArgs(args) ?? args)) &&
    !/"created"\s*:\s*true/.test(JSON.stringify(settled?.result ?? null))
  )
    return undefined;
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
  sent: "sent the email",
  scheduling: "updated the schedule",
  sender: "got the sending email address ready",
  connected: "made changes in a connected app",
};

const WORK_DONE_ZH: Record<TurnWork, string> = {
  people_search: "搜索了候选人",
  people_saved: "把候选人存进了岗位",
  round: "记下了这一轮",
  role: "更新了岗位",
  feedback: "记下了你的反馈",
  candidates: "更新了候选人决定",
  crm: "更新了候选人记录",
  contacts: "查了联系方式",
  draft: "存好了邮件草稿",
  sent: "发出了邮件",
  scheduling: "更新了日程",
  sender: "准备好了发件邮箱",
  connected: "在已连接的应用里做了修改",
};

/** The short report the server posts when the model ended without one, in the recruiter's language. */
export function turnReportText(
  work: readonly TurnWork[],
  savedPeople?: number,
  chinese = false,
): string {
  // "A change in a connected app" says nothing beside work that names itself.
  const named = [...new Set(work)];
  const items = named.length > 1 ? named.filter((item) => item !== "connected") : named;
  const counted =
    savedPeople && work.some((item) => item === "people_search" || item === "people_saved");
  if (chinese)
    return `已完成：${items.map((item) => WORK_DONE_ZH[item]).join("、")}。${
      counted ? `这个岗位现在存了 ${savedPeople} 人。` : ""
    }`;
  const saved = counted
    ? ` ${savedPeople} ${savedPeople === 1 ? "person is" : "people are"} saved for this role.`
    : "";
  return `Done: ${items.map((item) => WORK_DONE[item]).join(", ")}.${saved}`;
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
const MEMORY_SAVE_TOOLS = new Set([
  "remember",
  "save_memory",
  "save_shared_memory",
  "save_group_memory",
]);

/** Tools that hand work to a teammate or role; their answer is that teammate's own report. */
const DELEGATION_TOOLS = new Set(["delegate_to_role", "handoff_to_bot", "start_role"]);

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

  /** A tool call in this attempt that returned, read-only or not. */
  read(): boolean {
    return this.entries.some(
      (entry) => entry.kind === "tool" && this.settled.get(entry.id)?.ok === true,
    );
  }

  /** A memory save was tried in this attempt and none of the tries was saved. */
  memorySaveFailed(): boolean {
    const saves = this.entries.filter(
      (entry): entry is Extract<Entry, { kind: "tool" }> =>
        entry.kind === "tool" && MEMORY_SAVE_TOOLS.has(entry.name),
    );
    return saves.length > 0 && saves.every((entry) => this.settled.get(entry.id)?.ok === false);
  }

  /** What this attempt's tools did and returned, for checking what a reply claims. */
  receipts(): Receipts {
    const work = new Set<TurnWork | "memory">();
    const results: string[] = [];
    let delegated = false;
    let read = false;
    for (const entry of this.entries) {
      if (entry.kind !== "tool") continue;
      const settled = this.settled.get(entry.id);
      if (settled?.ok !== true) continue;
      const done = this.workOf(entry);
      if (done) work.add(done);
      else read = true;
      if (MEMORY_SAVE_TOOLS.has(entry.name)) work.add("memory");
      if (DELEGATION_TOOLS.has(entry.name)) delegated = true;
      results.push(JSON.stringify(settled.result ?? null).slice(0, 20_000));
    }
    return { work, delegated, read, results: results.join("\n") };
  }

  /** Any consequential work in this attempt. */
  /** A send or booking returned this attempt: its card was shown and confirmed. */
  sent(): boolean {
    return this.entries.some((entry) => {
      const work = this.workOf(entry);
      return work === "sent" || work === "scheduling";
    });
  }

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
// "Do not send anything", "No emails will be sent", "before anything is sent" or 先不要发 rule a
// send out; they are not a send request.
const NEGATED =
  /\b(?:do not|don['’]t|never|without|not)\s+(?:\w+\s+){0,2}?(?:send(?:ing)?|book(?:ing)?|schedul\w*|email (?:it|this|them|him|her))\b|\b(?:no|nothing)\b(?:\s+\w+){0,4}?\s+(?:sent|send(?:ing)?)\b|\b(?:before|until)\s+(?:\w+\s+){0,3}?(?:send(?:ing)?|sent)\b|(?:不要|别|先不|不用|不)(?:发|约)/gi;

function requests(kind: Capability, request: string): boolean {
  return REQUEST_KINDS[kind].test(request.replace(NEGATED, " "));
}
// A booking change, which needs the recruiter's card. Reading the calendar or the interviews
// ("what interviews are coming up", "when is she free") changes nothing and owes no card.
const BOOKING_CHANGE =
  /\b(?:book|re-?schedul|cancel|arrange)\w*|\bschedul\w*\s+(?:an?|the|her|him|them|it|time|\w+\s+for)\b|\bset\s+up\s+(?:an?\s+)?(?:interview|call|meeting)|约.{0,6}(?:时间|面)|(?:安排|取消|改|重新约).{0,4}面试|改期/i;
function asksBooking(request: string): boolean {
  return BOOKING_CHANGE.test(request.replace(NEGATED, " "));
}
// Tool operations (the last "__" segment) that do each kind of request.
const TOOL_KINDS: Record<Capability, RegExp> = {
  send: /send|reply_to|activate_campaign|forward/,
  contacts: /contact|enrich|lookup|find_emails/,
  // Calendar tools; schedule_* are routines, not interviews.
  schedule: /booking|calendar|availability|event_type|^recruiting_scheduling$/,
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
  /\bI (?:can(?:no|['’])t|(?:could(?:n['’]t| not)|was(?:n['’]t| not) able to)(?! (?:find|locate|reach|check|verify|confirm))|am unable to|['’]m unable to|am not able to|['’]m not able to|don['’]t have (?:access|a tool|the ability|permission))\b|\b(?:that['’]s|this is|it['’]s) (?:outside|beyond) (?:my|what I)\b|\bnot something I can\b|\bnot (?:send-)?ready to send\b|\bcan(?:no|['’])t (?:send|look up|book|schedule|draft|prepare)\b|我(?:无法|不能|没法|没有权限|做不了)|无法(?:发送|完成|执行|代|查|找|安排|准备)|权限(?:不支持|不足|不允许|不够)|没有(?:相应的?|足够的?)?权限|需要开通[^。！？\n]{0,20}权限|\bnot (?:permitted|authorized|allowed) to\b|\b(?:my|the current) permissions? (?:do(?:es)?n['’]t|do(?:es)? not) (?:allow|support)\b/i;
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
const DRAFT_START = /(?:^|\n)\s*(?:[#*_]+\s*)?(?:Email \d|Subject:|主题[:：]|第\s*\d+\s*封)/i;
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

/** A reply that talks about the send or booking it was asked for. */
const CARD_WORK = /\b(?:sen[dt]|e-?mail|draft|book|invit|interview|schedul)|发|约/i;

/**
 * Why a final reply gets the one retry: it declines, defers, picks or asks in text, or a send or
 * booking request ended without its card while the reply talks about that work ("I haven't sent
 * anything; please save the draft"), which leaves the request undone however it is worded.
 */
export function retryReason(
  reply: string,
  request: string,
  /** The recruiter's own latest words, when a teammate's brief is the request. */
  person?: string,
): Declined | undefined {
  const declined = declinedSentence(reply);
  if (declined) return declined;
  // A brief's wording ("no emails will be sent yet") is no send request unless the recruiter's
  // own message asked for one.
  const asksCard = (text: string) => requests("send", text) || asksBooking(text);
  if (!asksCard(request) || (person !== undefined && !asksCard(person))) return undefined;
  if (DRAFT_START.test(reply) || !CARD_WORK.test(reply)) return undefined;
  const sentence = reply
    .split(/(?<=[.!?。！？\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .findLast((part) => CARD_WORK.test(part));
  return sentence ? { sentence, kind: "decline" } : undefined;
}

export type Teammate = { id: string; name: string; about: string };

/**
 * `keep` is the part of the reply still shown, when the reply also delivered a draft. `card` is a
 * question the retry still typed into its reply: it goes on a question card instead.
 */
export type DeclineRetry = { sentence: string; note: string; keep?: string; card?: string };

/** Model-facing: a draft shown in chat with {{variables}} is written again for a real person. */
export const DRAFT_VARIABLES_NOTE =
  "Your draft shows template variables or placeholders. A draft in the chat is written for a real person: use the name and current title or company of the person it is for, else the role's first result from recruiting_candidates, and show the whole draft again. Never {{variables}}, placeholders or brackets in a draft; only a send uses them.";

/**
 * The recruiter asked for a template: named it, or asked for an email about a role without naming
 * anyone ("write me a short cold outreach email for a senior data engineer role in Seattle").
 */
export function askedTemplate(request: string): boolean {
  if (
    /template|模板|模版|템플릿|テンプレート|\{\{\s*first_?name\s*\}\}|placeholder|자리표시자|占位/i.test(
      request,
    )
  )
    return true;
  return (
    /\b(?:e-?mail|message|note)\b|邮件|이메일|메일|メール/i.test(request) &&
    /\b(?:role|position|job|opening)\b|职位|岗位|포지션|직무|ポジション|求人/i.test(request) &&
    !/@|\b(?:these|those|them|him|her|each|everyone|people|candidates?)\b|这些|他们|候选人|这位/i.test(
      request,
    )
  );
}

/** Model-facing: a template written as the candidate thanking an interviewer is written again. */
export const CANDIDATE_VOICE_NOTE =
  'This template is written as a candidate thanking an interviewer. The recruiter is the one writing, to the candidate: write it again from the recruiter, opening "Hi {{firstName}},", and show the whole template.';

/** A drafted template addressed to the interviewer, as if the candidate were writing. */
export function candidateVoiceDraft(reply: string): DeclineRetry | undefined {
  if (!DRAFT_START.test(reply)) return undefined;
  const greeting = reply.match(
    /\b(?:Hi|Dear|Hello)\s+\[(?:Interviewer|Hiring Manager)[^\]\n]{0,30}\]/i,
  )?.[0];
  return greeting ? { sentence: greeting, note: CANDIDATE_VOICE_NOTE } : undefined;
}

/** Model-facing: one email was asked for and a sequence came back. */
export const ONE_EMAIL_NOTE =
  "They asked for one email, not a sequence: show just that one email, with its subject and full body.";

/** A sequence of drafts shown when the recruiter asked for one email ("a short cold email…", "一封…"). */
export function sequenceForOneEmail(reply: string, request: string): DeclineRetry | undefined {
  if (!/\b(?:an?|one|single)\s+(?:\w+\s+){0,3}e-?mail\b|一封/i.test(request)) return undefined;
  if (/\b(?:sequence|campaign|follow-?ups)\b|序列|跟进序列/i.test(request)) return undefined;
  const subjects = reply.match(/(?:^|\n)\s*(?:[#*_]+\s*)?Subject:/gi) ?? [];
  return subjects.length > 1 ? { sentence: "", note: ONE_EMAIL_NOTE } : undefined;
}

/** A drafted email shown with {{variables}} instead of a real person's details. */
export function draftVariables(reply: string): DeclineRetry | undefined {
  if (!DRAFT_START.test(reply)) return undefined;
  const variable = reply.match(
    /\{\{\s*[\w.]+\s*\}\}|\[(?:your|candidate|recipient|first|last|full|company|name|title|role|recruiter|sender)\b[^\]\n]{0,30}\](?!\()/i,
  )?.[0];
  return variable ? { sentence: variable, note: DRAFT_VARIABLES_NOTE } : undefined;
}

/** Model-facing: a draft signed as a team is written again with the recruiter's name. */
export const TEAM_SIGNED_DRAFT_NOTE =
  "Your draft is signed as a team. Sign it with the recruiter's name or saved signature, else end with the sign-off alone (Best,), and show the whole draft again.";

/** A drafted email signed by a team ("Best,\nRecruiting Team") or as Kruit instead of a person. */
export function teamSignedDraft(reply: string): DeclineRetry | undefined {
  if (!DRAFT_START.test(reply)) return undefined;
  const signature = reply.match(
    /^[ \t]*(?:the\s+)?(?:recruiting|recruitment|talent(?:\s+acquisition)?|hiring|hr|kruit)(?:\s+(?:team|department))?[ \t]*$/im,
  )?.[0];
  return signature ? { sentence: signature.trim(), note: TEAM_SIGNED_DRAFT_NOTE } : undefined;
}

/** Model-facing: a template with [bracketed] blanks is written again with real details. */
export const TEMPLATE_BLANKS_NOTE =
  "Your template shows bracketed blanks. Write {{firstName}} where the candidate's first name goes (it is filled in for each person when sent) and the real role title, company, location and pay from the conversation; leave out a detail nobody gave instead of writing a blank, sign with the recruiter's name or the sign-off alone, and show the whole template again.";

/** A template the recruiter asked for that still has [bracketed] blanks ("Hi [Candidate Name],"). */
export function templateBlanks(reply: string): DeclineRetry | undefined {
  if (!DRAFT_START.test(reply)) return undefined;
  const blank = reply.match(
    /\{\{\s*(?:your|my|sender|recruiter)[\w.]*\s*\}\}|\[(?:your|candidate|recipient|first|last|full|company|name|title|role|position|recruiter|sender|interviewer|hiring)\b[^\]\n]{0,30}\](?!\()|\[[^\]\n]{0,10}(?:候选人|姓名|名字|公司|职位|岗位|名称|你的|您的)[^\]\n]{0,10}\]/i,
  )?.[0];
  return blank ? { sentence: blank, note: TEMPLATE_BLANKS_NOTE } : undefined;
}

/**
 * A question still typed into a reply after its retry: the question and what follows it go on a
 * question card, the text before it stays. A refusal is not a question.
 */
export function questionCard(reply: string, declined: Declined): DeclineRetry | undefined {
  if (declined.kind === "decline") return undefined;
  const at = reply.indexOf(declined.sentence);
  if (at < 0) return undefined;
  const card = reply.slice(at).trim();
  if (!/[?？]/.test(card)) return undefined;
  return { sentence: declined.sentence, note: "", keep: reply.slice(0, at).trim(), card };
}

/** Model-facing: the substance of every decline retry; tools or a teammate are named after it. */
export const DECLINE_RETRY_NOTE =
  "Do not decline or defer. If who, what or when is unclear (for a send or booking: the recipients, the email, the time), ask one clear question with ask_user, with concrete options and a custom answer. Otherwise do it now with your tools, or hand it to the teammate who can; for a send, the email is the one written in this conversation, else the role's saved email. Anything that needs approval shows its own card when you call the tool; never ask for approval in text. If something is truly missing after that, say exactly what.";

/** Model-facing: a clarifying question asked in plain text goes on a question card instead. */
export const TEXT_QUESTION_NOTE =
  "You asked the user in plain text. Ask it with ask_user instead: the question in one sentence, concrete options (the people or choices you listed) and a custom answer, without saying what you could not do or find. Your question was";

/**
 * One retry for a final reply that declines, defers or hands back a pick, when the turn did
 * nothing, or when a send or booking ended without its card. After other work the reply stands:
 * a handed stage reports back and is checked against its brief, and "want me to keep going?" is
 * a fair next step. The note
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
  /** A tool call returned this turn (see TurnReportLedger.read). */
  read?: boolean;
  /** The recruiter's own latest words, when a teammate's brief is the request. */
  personRequest?: string;
}): DeclineRetry | undefined {
  const declined = retryReason(input.reply, input.request, input.personRequest);
  // A reply that shows a drafted email delivered the work; holding it back would lose the draft.
  if (!declined || (DRAFT_START.test(input.reply) && declined.keep === undefined)) return undefined;
  const { sentence } = declined;
  const asked = (Object.keys(REQUEST_KINDS) as Capability[]).filter((kind) =>
    requests(kind, input.request),
  );
  // A turn that did work reports it, and the coordinator checks it against the brief. Only a send
  // or booking that ended without its card is retried, since no card means nothing was asked.
  const cardOwed = asked.includes("send") || asksBooking(input.request);
  if (input.worked && !(declined.kind === "decline" && cardOwed)) return undefined;
  // A question that asks for nothing to be done ("what interviews do I have") is answered by its
  // reads; a coverage aside in that answer is no refusal.
  // An instruction ("drop the ones without Kafka") is no question, whatever was read for it.
  const question = /[?？]|[吗呢][\s。.!！]*$/.test(input.personRequest ?? input.request);
  if (input.read && question && !cardOwed && asked.every((kind) => kind === "schedule"))
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

// Chinese and Japanese have no spaces: a run of their characters counts by its character pairs.
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}$/u;
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[*_`#>[\]()]/g, " ")
      .split(/[^\p{L}\p{N}]+|(?<=\p{Script=Han})(?=[a-z0-9])|(?<=[a-z0-9])(?=\p{Script=Han})/u)
      .filter(Boolean)
      .flatMap((word) =>
        CJK_RUN.test(word)
          ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
          : [word],
      ),
  );

/**
 * A final reply that only says again what the turn's last progress update just said (same
 * facts, not much longer) adds a duplicate message, so the update stands as the answer.
 */
type HistoryRow = { role: string; botId: string | null; blocks: unknown };
const rowText = (blocks: unknown, kind: string) =>
  (Array.isArray(blocks) ? blocks : [])
    .flatMap((block) =>
      block && typeof block === "object" && block.kind === kind && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");

/**
 * This bot's newest reply in the conversation, newest-first rows, when the recruiter has not
 * written since: a teammate's report relayed after it adds nothing if it only says it again.
 */
export function lastOwnUpdate(rows: readonly HistoryRow[], botId: string): string | undefined {
  for (const row of rows) {
    const relayed =
      Array.isArray(row.blocks) &&
      row.blocks.some(
        (block) => block && typeof block === "object" && block.kind === "bot_message_received",
      );
    if (row.role === "user" && !relayed) return undefined;
    const text = row.botId === botId && row.role !== "user" ? rowText(row.blocks, "text") : "";
    if (text.trim()) return text;
  }
  return undefined;
}

export function restatesUpdate(reply: string, update: string | undefined): boolean {
  if (!update?.trim() || !reply.trim()) return false;
  if (reply.trim().length > update.trim().length * 1.5) return false;
  const a = words(reply);
  const b = words(update);
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  // A reply that only repeats the update's closing question or one of its sentences says nothing new.
  if (a.size >= 5 && shared / a.size >= 0.9) return true;
  return shared / (a.size + b.size - shared) >= 0.55;
}
