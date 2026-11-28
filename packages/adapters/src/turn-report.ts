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
  | "send_queued"
  | "send_held"
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

/** A call's structured results, however the tool result wraps them. */
function structuredResults(result: unknown): Record<string, unknown>[] {
  const object = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return [result, object(result)?.details, object(result)?.result]
    .map((value) => object(object(value)?.structuredContent))
    .flatMap((value) => (value ? [value, object(value.result)].filter((v) => v !== undefined) : []))
    .filter((value): value is Record<string, unknown> => value !== undefined);
}

/** Whether a call's structured result says it created what it ensured. */
function createdByCall(result: unknown): boolean {
  return structuredResults(result).some((value) => value.created === true);
}

/**
 * What a confirmed campaign send did, from the delivery its result records: started and on its
 * way (or waiting for the chosen hours), or held by the mail service. It never says sent: a
 * campaign send only starts the emails (audit 11-26: every activate was reported "sent").
 */
function campaignSendWork(result: unknown): TurnWork {
  return structuredResults(result).some((value) => value.delivery === "held")
    ? "send_held"
    : "send_queued";
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
  // A send runs only once its card is confirmed. A direct send that returned went out; a
  // campaign send is what its result says.
  // The tool's own name, without a native integration's "native_<app>_" prefix.
  const operationName = action.startsWith("native_") ? action.split("_").slice(2).join("_") : action;
  if (operationName === "activate_campaign") return campaignSendWork(settled?.result);
  if (["send_email", "send_message", "send"].includes(operationName)) return "sent";
  if (/sender|mailbox|sending_account/.test(action)) return "sender";
  // Ensuring a campaign that already exists, without new copy, changed nothing (staging 11-13:
  // each status check reported 「已完成：存好了邮件草稿」).
  if (
    action.startsWith("ensure_") &&
    !("steps" in (nestedArgs(args) ?? args)) &&
    !createdByCall(settled?.result)
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
  send_queued: "started the email; it is on its way, not delivered yet",
  send_held: "confirmed the email, but it has not gone out: sending is on hold",
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
  send_queued: "启动了邮件发送，正在发出，还没送达",
  send_held: "确认了邮件，但还没发出：发送被暂停了",
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

/** Model-facing: the last silent-turn continuation when the work is unreported. */
export const REPORT_BEFORE_END =
  "The turn reached its last step after a tool result, with no final answer to the user yet.";

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
}
