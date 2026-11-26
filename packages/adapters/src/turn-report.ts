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

export const isTurnWork = (value: string): value is TurnWork => Object.hasOwn(WORK_DONE, value);

/** Past-tense English label of one kind of work, for model-facing state. */
export const workDoneLabel = (work: TurnWork): string => WORK_DONE[work];

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
export function turnReportText(work: readonly TurnWork[], chinese = false): string {
  // "A change in a connected app" says nothing beside work that names itself.
  const named = [...new Set(work)];
  const items = named.length > 1 ? named.filter((item) => item !== "connected") : named;
  if (chinese) return `已完成：${items.map((item) => WORK_DONE_ZH[item]).join("、")}。`;
  return `Done: ${items.map((item) => WORK_DONE[item]).join(", ")}.`;
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

  /** What one returned call did, for its durable receipt. */
  workFor(id: string): TurnWork | undefined {
    const entry = this.entries.find((item) => item.kind === "tool" && item.id === id);
    return entry && this.settled.get(id)?.ok === true ? this.workOf(entry) : undefined;
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
      if (entry.kind === "report" || work === "round") owed.length = 0;
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
        entry.args.operation === "calibration_round" &&
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

export type DeclineKind = "decline" | "defer" | "pick" | "text_question";
/** `keep` is the reply without the question, when the reply also delivered a draft. */
export type Declined = { sentence: string; kind: DeclineKind; keep?: string };

/** Where a drafted email starts in a reply: an "Email N" heading or a Subject: line. */
const _DRAFT_START = /(?:^|\n)\s*(?:[#*_]+\s*)?(?:Email \d|Subject:|主题[:：]|第\s*\d+\s*封)/i;

export type Teammate = { id: string; name: string; about: string };

/**
 * `keep` is the part of the reply still shown, when the reply also delivered a draft. `card` is a
 * question the retry still typed into its reply: it goes on a question card instead.
 */
export type DeclineRetry = { sentence: string; note: string; keep?: string; card?: string };

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
    // A role named by its title, or a first touch, is about the role too (gate 7b5230e4:
    // 「Staff Frontend Engineer 的首次触达邮件」).
    /\b(?:role|position|job|opening|engineer|developer|designer|manager|scientist|analyst|architect|director|first[- ]touch|outreach)s?\b|职位|岗位|工程师|经理|总监|设计师|架构师|首次|首封|触达|포지션|직무|ポジション|求人/i.test(
      request,
    ) &&
    !/@|\b(?:these|those|them|him|her|each|everyone|people|candidates?)\b|这些|他们|候选人|这位/i.test(
      request,
    )
  );
}

/**
 * Whether a brief carries the recruiter's message: most of the message's character pairs, spaces
 * and punctuation aside, appear in the brief, as they do when it is quoted.
 */
export function quotesMessage(brief: string, message: string): boolean {
  const flat = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const pairs = (text: string) =>
    Array.from({ length: Math.max(0, text.length - 1) }, (_, at) => text.slice(at, at + 2));
  const wanted = pairs(flat(message));
  if (wanted.length < 4) return false;
  const shown = new Set(pairs(flat(brief)));
  return wanted.filter((pair) => shown.has(pair)).length / wanted.length >= 0.8;
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
type HistoryRow = {
  role: string;
  botId: string | null;
  blocks: unknown;
  runId?: string | null;
  clientNonce?: string | null;
};
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
export function lastOwnUpdate(
  rows: readonly HistoryRow[],
  botId: string,
  runId?: string,
): string | undefined {
  for (const row of rows) {
    // This turn's own lines are not an earlier reply; the person's messages it answers are still
    // the person writing since (staging 11-21, aftercard: the same question asked again after a
    // card got no answer, as its answer matched the last one). A server nudge is not the person.
    if (runId && row.role !== "user" && row.runId === runId) continue;
    if (row.clientNonce?.startsWith("autocontinue:")) continue;
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

/** The reply's sentences with their end marks, in order. */
const _sentencesOf = (text: string) =>
  text.match(/[^。！？!?；;\n]+(?:[。！？!?；;]+|\n+|$)/g) ?? [];

function _sameSentence(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size < 4 || y.size < 4) return false;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  // Gate 8cc8cc5b: the same invitation reworded each time (「发来」/「把…发给我」) overlaps by half.
  return shared / (x.size + y.size - shared) >= 0.5;
}

/** The same message again, apart from spacing. */
export function sameWords(reply: string, earlier: string | undefined): boolean {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return earlier !== undefined && flat(reply) !== "" && flat(reply) === flat(earlier);
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
