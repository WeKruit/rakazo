import type { ActionApprovalRule as StoredActionApprovalRule } from "@rakazo/contracts";

const APPROVAL_EXEMPT_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "read_file",
  "artifact_read",
  "read_history",
  "search_history",
  "write_file",
  "shell",
  "open_path",
  "launch_app",
  "remember",
  "request_takeover",
  "request_secret",
  "run_subagent",
  "spawn_bot",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
]);

const APPROVAL_REQUIRED_BUILTIN_TOOLS = new Set([
  "destination.write",
  "delete_bot",
  "archive_bot",
  "secret_request",
  "forget_secret",
  "forget_memory",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "cloud_agent_cancel",
]);
const EXPLICIT_APPROVAL_BUILTIN_TOOLS = new Set(["create_space", "recruiting_request_approval"]);
// Lead enrollment may start an already-active campaign; it needs the same
// one-time human decision as a direct reply or campaign activation.
const EXPLICIT_APPROVAL_MCP_OPERATIONS = new Set([
  "reply_to_email",
  "create_lead",
  "add_leads_to_campaign_or_list_bulk",
  "activate_campaign",
]);
// Canonical actions in Composio's Gmail and Google Calendar toolkit catalogs.
const EXPLICIT_APPROVAL_COMPOSIO_OPERATIONS = new Set([
  "GMAIL_SEND_EMAIL",
  "GMAIL_SEND_DRAFT",
  "GMAIL_FORWARD_MESSAGE",
  "GMAIL_REPLY_TO_THREAD",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_UPDATE_EVENT",
  "GOOGLECALENDAR_PATCH_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_EVENTS_MOVE",
  "GOOGLECALENDAR_QUICK_ADD",
  "GOOGLECALENDAR_REMOVE_ATTENDEE",
  "GOOGLECALENDAR_EVENTS_IMPORT",
]);

const GOOGLE_MCP_GMAIL_WRITES = new Set([
  "create_draft",
  "label_message",
  "label_thread",
  "unlabel_message",
  "unlabel_thread",
]);
const GOOGLE_MCP_CALENDAR_WRITES = new Set([
  "create_event",
  "update_event",
  "delete_event",
  "respond_to_event",
]);
const CAL_MCP_BOOKING_WRITES = new Set([
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "confirm_booking",
  "add_booking_attendee",
]);

/** Native non-sending mailbox writes; the executor must verify the assigned official endpoint. */
export function internalMcpWriteEndpoint(toolName: string): string | undefined {
  if (
    GOOGLE_MCP_GMAIL_WRITES.has(toolName) ||
    (toolName.startsWith("gmail.") && GOOGLE_MCP_GMAIL_WRITES.has(toolName.slice(6)))
  )
    return "https://gmailmcp.googleapis.com/mcp/v1";
  return undefined;
}

/** Native MCP writes requiring a one-time decision at their exact official endpoint. */
export function oneTimeMcpWriteEndpoint(toolName: string): string | undefined {
  if (
    GOOGLE_MCP_CALENDAR_WRITES.has(toolName) ||
    (toolName.startsWith("calendar.") && GOOGLE_MCP_CALENDAR_WRITES.has(toolName.slice(9)))
  )
    return "https://calendarmcp.googleapis.com/mcp/v1";
  if (CAL_MCP_BOOKING_WRITES.has(toolName)) return "https://mcp.cal.com/mcp";
  return undefined;
}

const UNATTENDED_SAFE_BUILTIN_TOOLS = new Set([
  "recruiting_candidates",
  "recruiting_crm_target",
  "recruiting_crm_bind",
  "recruiting_crm_import",
  "recruiting_role",
  "recruiting_feedback",
  "recruiting_shortlist",
  "recruiting_research",
  "remember",
  "save_memory",
  "save_shared_memory",
  "write_file",
  "browser_snapshot",
  "cloud_agent_status",
  "computer_observe",
  "list_files",
  "list_secrets",
  "read_file",
  "artifact_read",
  "recall_memory",
  "read_memory",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "schedule_list",
  "scratchpad_list",
  "skill_read",
  "web_fetch",
  "web_search",
]);

const READ_ONLY_CONNECTOR_PATTERN = /(^|_)(get|list|search|find|read)(_|$)/i;
const MUTATING_CONNECTOR_PATTERN =
  /(^|_)(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)(_|$)/i;
const COMPOUND_CONNECTOR_ACTION_PATTERN = /_(and|or|then)_/i;

const EMAIL_CONNECTOR_SLUGS = new Set(["gmail", "outlook", "microsoft_outlook"]);
const PURCHASE_CONNECTOR_SLUGS = new Set(["stripe", "shopify", "paypal", "square"]);

export type ActionApprovalRule = Pick<
  StoredActionApprovalRule,
  "effect" | "matchKind" | "matchValue"
>;

export function connectorKindFromToolName(toolName: string, connectorKinds: string[] = []): string {
  const normalizedTool = toolName.toLowerCase();
  const matched = connectorKinds
    .map((kind) => kind.toLowerCase())
    .filter((kind) => normalizedTool === kind || normalizedTool.startsWith(`${kind}_`))
    .sort((left, right) => right.length - left.length)[0];
  if (matched) return matched;
  const [segment] = toolName.split("_");
  return (segment ?? toolName).toLowerCase();
}

/**
 * `readOnly` is the connector tool's declared effect (for installed APIs, derived from the stored
 * HTTP method and read-only flag). A declared write always needs approval. A declared read never
 * relaxes the name check: the provider chooses both the name and the hint.
 */
export function connectorToolRequiresApproval(toolName: string, readOnly?: boolean): boolean {
  if (readOnly === false) return true;
  if (MUTATING_CONNECTOR_PATTERN.test(toolName)) return true;
  if (COMPOUND_CONNECTOR_ACTION_PATTERN.test(toolName)) return true;
  return !READ_ONLY_CONNECTOR_PATTERN.test(toolName);
}

export function toolRequiresApproval(
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (toolRequiresExplicitApproval(toolName)) return true;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName, readOnly);
  return false;
}

/** These actions require a one-time human decision, without auto-review or permanent allowance. */
export function toolRequiresExplicitApproval(
  toolName: string,
  route?: { connectorId: string; toolName: string },
  args?: Record<string, unknown>,
  serverEndpoint?: string | null,
): boolean {
  if (
    EXPLICIT_APPROVAL_BUILTIN_TOOLS.has(toolName) ||
    (route?.connectorId === "mcp" && EXPLICIT_APPROVAL_MCP_OPERATIONS.has(route.toolName))
  )
    return true;
  if (route?.connectorId === "mcp" && serverEndpoint) {
    try {
      const url = new URL(serverEndpoint);
      if (
        `${url.origin}${url.pathname.replace(/\/$/, "")}` ===
        oneTimeMcpWriteEndpoint(route.toolName)
      )
        return true;
    } catch {
      /* A malformed endpoint cannot identify the official service. */
    }
  }
  if (route?.connectorId !== "composio") return false;
  const operation = route.toolName.toUpperCase();
  if (EXPLICIT_APPROVAL_COMPOSIO_OPERATIONS.has(operation)) return true;
  if (operation !== "COMPOSIO_MULTI_EXECUTE_TOOL" || !Array.isArray(args?.tools)) return false;
  return args.tools.some((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const call = item as Record<string, unknown>;
    return (
      typeof call.tool_slug === "string" &&
      toolRequiresExplicitApproval(
        toolName,
        { ...route, toolName: call.tool_slug },
        call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
          ? (call.arguments as Record<string, unknown>)
          : undefined,
      )
    );
  });
}

/** Webhooks may inspect and save native internal state; other side effects still need the owner. */
export function unattendedTriggerToolRequiresApproval(
  trigger: string,
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
): boolean {
  if (trigger !== "webhook") return false;
  return viaConnector
    ? connectorToolRequiresApproval(toolName, readOnly)
    : !UNATTENDED_SAFE_BUILTIN_TOOLS.has(toolName);
}

function categoryMatches(
  category: string,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
): boolean {
  const normalized = category.toLowerCase();
  const consequential = connectorToolRequiresApproval(toolName, readOnly);
  if (normalized === "email") {
    if (EMAIL_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /send.*mail|gmail_send|outlook_send/i.test(toolName);
  }
  if (normalized === "purchase") {
    if (PURCHASE_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /purchase|pay_|charge|checkout|buy_/i.test(toolName);
  }
  return false;
}

function ruleMatches(
  rule: ActionApprovalRule,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
): boolean {
  const value = rule.matchValue.toLowerCase();
  switch (rule.matchKind) {
    case "tool":
      return toolName.toLowerCase() === value;
    case "connector":
      return connectorKind.toLowerCase() === value;
    case "category":
      return categoryMatches(rule.matchValue, toolName, connectorKind, readOnly);
    default:
      return false;
  }
}

function ruleSpecificity(rule: ActionApprovalRule): number {
  switch (rule.matchKind) {
    case "tool":
      return 3;
    case "connector":
      return 2;
    case "category":
      return 1;
    default:
      return 0;
  }
}

export type ActionApprovalSource = "require_approval" | "always_allow" | "default";

export type ActionApprovalResolved = {
  decision: "ask" | "allow";
  source: ActionApprovalSource;
  matchingRules: ActionApprovalRule[];
};

/** Deterministic rule resolution. Always-allow and require-approval both beat the default. */
export function resolveActionApprovalDetail(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  rules: ActionApprovalRule[];
}): ActionApprovalResolved {
  const connectorKind = input.connectorKind ?? connectorKindFromToolName(input.toolName);
  const matchingRules = input.rules.filter((rule) =>
    ruleMatches(rule, input.toolName, connectorKind, input.readOnly),
  );
  if (matchingRules.length === 0) {
    return { decision: "allow", source: "default", matchingRules };
  }

  const highestSpecificity = Math.max(...matchingRules.map(ruleSpecificity));
  const winners = matchingRules.filter((rule) => ruleSpecificity(rule) === highestSpecificity);
  if (winners.some((rule) => rule.effect === "require_approval")) {
    return { decision: "ask", source: "require_approval", matchingRules };
  }
  return { decision: "allow", source: "always_allow", matchingRules };
}

export function resolveActionApproval(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  rules: ActionApprovalRule[];
}): "ask" | "allow" {
  return resolveActionApprovalDetail(input).decision;
}

export type AutoReviewJudgeDecision = "pass" | "ask" | "error";

/**
 * Pure combiner for Auto Review after rule resolution.
 * Rules win: require_approval asks, always_allow runs. Only the default path may call a judge.
 * The judge only escalates to ask; it never silent-denies.
 */
export function planActionGate(input: {
  resolved: ActionApprovalResolved;
  consequential: boolean;
  autoReviewEnabled: boolean;
  checkerConfigured: boolean;
}): "ask" | "allow" | "judge" {
  if (input.resolved.decision === "ask") return "ask";
  if (input.resolved.source === "always_allow") return "allow";
  if (
    input.consequential &&
    input.autoReviewEnabled &&
    input.checkerConfigured &&
    input.resolved.source === "default"
  ) {
    return "judge";
  }
  return "allow";
}

/** Map a judge outcome onto ask/allow. Errors fail closed on consequential tools. */
export function applyJudgeDecision(input: {
  decision: AutoReviewJudgeDecision;
  consequential: boolean;
}): "ask" | "allow" {
  if (input.decision === "pass") return "allow";
  if (input.decision === "ask") return "ask";
  return input.consequential ? "ask" : "allow";
}

export function isSecretAskBlock(block: {
  kind: string;
  input?: string;
  approvalEffectId?: string;
}): boolean {
  return block.kind === "ask" && block.input === "secret" && !block.approvalEffectId;
}

export function isApprovalAskBlock(block: {
  kind: string;
  approvalEffectId?: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  if (block.kind !== "ask" || !block.approvalEffectId || !block.actions?.length) return false;
  const actionIds = new Set(block.actions.map((action) => action.id));
  return (
    actionIds.has("allow") &&
    actionIds.has("deny") &&
    [...actionIds].every((id) => id === "allow" || id === "always" || id === "deny")
  );
}

export const DIRECT_APPROVAL_TAG = "direct";

export type BoundApprovalRoute = {
  connectorId: string;
  resourceId: string;
  toolName: string;
  resourceRevision?: string | number;
};

export function catalogApprovalRequest(
  toolName: string,
  args: Record<string, unknown>,
  marker: string,
  route?: BoundApprovalRoute,
): unknown[] {
  return route ? [marker, toolName, args, route] : [marker, toolName, args];
}

export function catalogApprovalDetails(
  request: unknown,
  marker: string,
): { toolName: string; args: Record<string, unknown>; route?: BoundApprovalRoute } | undefined {
  if (
    !Array.isArray(request) ||
    (request.length !== 3 && request.length !== 4) ||
    request[0] !== marker ||
    typeof request[1] !== "string" ||
    !request[1].endsWith("_execute_tool") ||
    !request[2] ||
    typeof request[2] !== "object" ||
    Array.isArray(request[2])
  ) {
    return undefined;
  }
  if (request.length === 3) {
    return { toolName: request[1], args: request[2] as Record<string, unknown> };
  }
  const route = request[3];
  if (
    !route ||
    typeof route !== "object" ||
    Array.isArray(route) ||
    typeof (route as BoundApprovalRoute).connectorId !== "string" ||
    typeof (route as BoundApprovalRoute).resourceId !== "string" ||
    typeof (route as BoundApprovalRoute).toolName !== "string" ||
    ((route as BoundApprovalRoute).resourceRevision !== undefined &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "string" &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "number")
  ) {
    return undefined;
  }
  return {
    toolName: request[1],
    args: request[2] as Record<string, unknown>,
    route: route as BoundApprovalRoute,
  };
}

export function boundDirectApprovalRequest(
  route: BoundApprovalRoute,
  args: Record<string, unknown>,
  marker: string,
): unknown[] {
  return [marker, DIRECT_APPROVAL_TAG, { route, args }];
}

export function boundDirectApprovalDetails(
  request: unknown,
  marker: string,
): { route: BoundApprovalRoute; args: Record<string, unknown> } | undefined {
  if (
    !Array.isArray(request) ||
    request.length !== 3 ||
    request[0] !== marker ||
    request[1] !== DIRECT_APPROVAL_TAG ||
    !request[2] ||
    typeof request[2] !== "object" ||
    Array.isArray(request[2])
  ) {
    return undefined;
  }
  const payload = request[2] as { route?: unknown; args?: unknown };
  const route = payload.route;
  if (
    !route ||
    typeof route !== "object" ||
    Array.isArray(route) ||
    typeof (route as BoundApprovalRoute).connectorId !== "string" ||
    typeof (route as BoundApprovalRoute).resourceId !== "string" ||
    typeof (route as BoundApprovalRoute).toolName !== "string" ||
    ((route as BoundApprovalRoute).resourceRevision !== undefined &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "string" &&
      typeof (route as BoundApprovalRoute).resourceRevision !== "number") ||
    !payload.args ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    return undefined;
  }
  return {
    route: route as BoundApprovalRoute,
    args: payload.args as Record<string, unknown>,
  };
}
