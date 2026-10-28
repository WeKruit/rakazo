import { SdkHttpError } from "@modelcontextprotocol/client";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorRoute,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { RecruitingCrmTarget } from "@rakazo/contracts";
import {
  isLocalMcpHost,
  RecruitingCrmPresenceReadSchema,
  RecruitingCrmRoleCampaignsReadSchema,
  RecruitingCrmRoleMailReadSchema,
} from "@rakazo/contracts";
import { abortableDelay, boundDirectApprovalDetails, catalogApprovalDetails } from "@rakazo/core";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { McpServer, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  bindRecruitingSchedulingOperation,
  getRecruitingWorkspaceCrmTarget,
  IsolationError,
  loadVerifiedRecruitingSchedulingPlan,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import addressparser from "nodemailer/lib/addressparser";
import { z } from "zod";
import { catalogToolPrefix } from "./approval-effect.js";
import { calendarEvidenceHash } from "./calendar-approval.js";
import { readBoundedText } from "./connector-http.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { FindEmailsInput, findEmails } from "./contact-lookup.js";
import { credentialDigest } from "./credential-digest.js";
import { appendToolCompletionAudit } from "./executor.js";
import {
  InstantlyRestError,
  instantlyRest,
  isNativeInstantlyWrite,
  nativeInstantlyWrites,
  readRoleCampaignBinding,
  runInstantlyWrite,
} from "./instantly-native-writes.js";
import {
  readInstantlyEmail,
  readInstantlyEmailPage,
  sameInstantlyAddresses,
} from "./instantly-reply.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { McpOAuthBroker, OAuthMaterial } from "./mcp-oauth.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import { type McpRuntimeAuth, McpSession } from "./mcp-transport.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import {
  requireAutumnTaskOwnership,
  requireFullEnrichJobOwnership,
  requireQuickSearchBeforeResearch,
  savedContactEmails,
} from "./recruiting-research.js";
import {
  assertSchedulingCall,
  SchedulingApprovalEvidenceSchema,
  schedulingPlanHash,
} from "./recruiting-scheduling.js";
import { unresolvedContactEmailError } from "./recruiting-tools.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";

const INSTANTLY_MCP = "https://mcp.instantly.ai/mcp";
const THREAD_HISTORY = "native_instantly_get_thread_history";
const CONTACT_EMAILS = "native_instantly_search_contact_emails";
const MAILBOX_EMAILS = "native_instantly_list_mailbox_emails";
const ThreadHistoryInput = z.strictObject({
  anchor_id: z.uuid(),
  campaign_id: z
    .uuid()
    .optional()
    .describe(
      "Exact campaign of the current recruiting role; required when the role has multiple campaigns.",
    ),
  limit: z.number().int().min(1).max(100).default(100),
  starting_after: z
    .string()
    .max(1600)
    .refine((value) => value.trim().length > 0)
    .optional(),
});
const ContactEmailsInput = ThreadHistoryInput.omit({ anchor_id: true }).extend({
  email: z
    .email()
    .max(254)
    .describe(
      "The person's STORED address from recruiting_candidates resolve. Never a guessed address or your own Instantly mailbox.",
    ),
  name: z
    .string()
    .max(240)
    .optional()
    .describe("The resolved person's name, checked against the stored address."),
  eaccount: z
    .email()
    .max(254)
    .optional()
    .describe(
      "Your connected Instantly mailbox that sent or received the mail (e.g. the address the contact wrote to). Never the contact.",
    ),
});
const CreatedAt = z.iso.datetime({ offset: true }).optional();
const MailboxEmailsInput = ThreadHistoryInput.omit({ anchor_id: true }).extend({
  eaccount: z
    .email()
    .max(254)
    .describe("Your connected Instantly mailbox to list. Never a contact address."),
  search: z
    .string()
    .max(500)
    .refine((value) => value.trim().length > 0)
    .optional()
    .describe("Provider-side text search, e.g. part of a subject."),
  min_timestamp_created: CreatedAt.describe("ISO datetime; only mail created at or after it."),
  max_timestamp_created: CreatedAt.describe("ISO datetime; only mail created at or before it."),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exact active-workspace scope. Missing or conflicting arguments never broaden a query. */
export async function agentCrmCandidatesArgs(
  args: Record<string, unknown>,
  bindings: RecruitingCrmTarget[] = [],
) {
  if (bindings.length !== 1)
    throw new IsolationError("Open the CRM role workspace before reading its candidates");
  const target = bindings[0]!;
  if (
    (args.p_org !== undefined && args.p_org !== target.organizationId) ||
    (args.p_client !== undefined && args.p_client !== target.clientLabel) ||
    (args.p_role !== undefined &&
      args.p_role !== target.roleLabel &&
      args.p_role !== target.crmRoleId)
  )
    throw new IsolationError("CRM query does not match the current role workspace");
  return {
    p_not_reviewed: false,
    ...args,
    p_org: target.organizationId,
    p_client: target.clientLabel,
    p_role: target.roleLabel,
  };
}

/** Candidate mail/context tools lack a role parameter: prove exact current-role membership first. */
export async function agentCrmScopedArgs(
  tool: string,
  args: Record<string, unknown>,
  target: RecruitingCrmTarget,
  readMembership: (args: {
    p_org: string;
    p_role: string;
    p_view: "presence";
    p_candidate_ids: string[];
  }) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  if (tool === "list_crm_candidate_correspondence")
    throw new IsolationError(
      "Use list_crm_role_correspondence with p_candidate for this candidate's current-role email; the candidate-only tool cannot isolate role campaigns",
    );
  if (tool === "list_crm_candidates" && args.p_view !== "presence")
    return agentCrmCandidatesArgs(args, [target]);
  if (args.p_org !== undefined && args.p_org !== target.organizationId)
    throw new IsolationError("CRM organization does not match the current role workspace");
  if (args.p_role !== undefined && args.p_role !== target.crmRoleId)
    throw new IsolationError("CRM role does not match the current role workspace");
  if (args.p_client !== undefined && args.p_client !== target.crmClientId)
    throw new IsolationError("CRM client does not match the current role workspace");
  const next = { ...args, p_org: target.organizationId };
  if (tool === "list_crm_candidates" && args.p_view === "presence") {
    if (
      !Array.isArray(args.p_candidate_ids) ||
      !args.p_candidate_ids.length ||
      args.p_candidate_ids.length > 50 ||
      args.p_candidate_ids.some((id) => typeof id !== "string" || !UUID.test(id))
    )
      throw new IsolationError();
    return { ...next, p_role: target.crmRoleId };
  }
  if (["get_crm_role", "list_crm_role_correspondence", "crm_import_candidate"].includes(tool)) {
    if (
      tool === "list_crm_role_correspondence" &&
      args.p_candidate !== undefined &&
      (typeof args.p_candidate !== "string" || !UUID.test(args.p_candidate))
    )
      throw new IsolationError();
    return { ...next, p_role: target.crmRoleId };
  }
  if (typeof args.p_candidate !== "string" || !UUID.test(args.p_candidate))
    throw new IsolationError(
      "Select a candidate in the current CRM role workspace before this operation",
    );
  if (args.p_cursor !== undefined) {
    const cursor = args.p_cursor as Record<string, unknown> | null;
    if (
      !cursor ||
      cursor.p_org !== target.organizationId ||
      cursor.p_candidate !== args.p_candidate
    )
      throw new IsolationError("CRM cursor does not match the current candidate");
  }
  const result = await readMembership({
    p_org: target.organizationId,
    p_role: target.crmRoleId,
    p_view: "presence",
    p_candidate_ids: [args.p_candidate],
  });
  const proof = (result as { isError?: boolean })?.isError
    ? null
    : RecruitingCrmPresenceReadSchema.safeParse(mcpObject(result)?.data);
  if (
    !proof?.success ||
    proof.data.candidate_ids.length !== 1 ||
    proof.data.candidate_ids[0] !== args.p_candidate ||
    proof.data.role_candidate_ids?.length !== 1 ||
    proof.data.role_candidate_ids[0] !== args.p_candidate
  )
    throw new IsolationError("Candidate is not a verified member of the current CRM role");
  return next;
}

export function scopedInstantlyCampaign(
  args: Record<string, unknown>,
  campaigns: readonly string[],
): string {
  const selected = args.campaign_id ?? (campaigns.length === 1 ? campaigns[0] : undefined);
  if (typeof selected !== "string" || !campaigns.includes(selected))
    throw new IsolationError(
      "Select an exact campaign of the current recruiting role before reading its email",
    );
  return selected;
}

const EMAIL_PAGE_BOUND = 4_000_000; // 100 full bodies can pass 1 MB
/** Instantly's short error code only (never the body): a bare token from `error`/`code`. */
function instantlyErrorCode(text: string) {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const code = [body.code, body.error].find(
      (value) => typeof value === "string" && /^[\w.-]{1,64}$/.test(value),
    );
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

const nativeInstantlyReads = [
  {
    name: "get_thread_history",
    toolName: THREAD_HISTORY,
    inputSchema: z.toJSONSchema(ThreadHistoryInput, { io: "input" }),
    description:
      "Local native REST integration for the existing authorized Instantly connection, not a remote MCP tool. Reads one exact thread page from a fresh anchor email. Returns the raw native anchor, raw REST page, exact query and honest page/body coverage. Continue only with the returned cursor; an exhausted page does not by itself prove an entire thread was read. No computer or credentials are needed in arguments. Replies still use the assigned official MCP tool.",
  },
  {
    name: "search_contact_emails",
    toolName: CONTACT_EMAILS,
    inputSchema: z.toJSONSchema(ContactEmailsInput, { io: "input" }),
    description:
      "Local native REST integration for the existing authorized Instantly connection, not a remote MCP tool. Looks up one bounded page of emails sent to or received from an exact contact email, optionally within one of your connected Instantly mailboxes (eaccount), whichever side sent the mail. Uses the official lead filter and verifies each returned contact address. Returns the raw REST page, exact query, provider email IDs and honest page/body coverage; continue with the returned cursor and the same email/account. An exhausted page is not a full-thread receipt; use get_email and get_thread_history for the selected provider email before replying. No computer or credentials are needed in arguments. Does not send email.",
  },
  {
    name: "list_mailbox_emails",
    toolName: MAILBOX_EMAILS,
    inputSchema: z.toJSONSchema(MailboxEmailsInput, { io: "input" }),
    description:
      "Local native REST integration for the existing authorized Instantly connection, not a remote MCP tool. Lists one bounded page (newest first) of all mail in one of your connected Instantly mailboxes (eaccount), sent and received, inside or outside campaigns, optionally narrowed by provider-side text search (e.g. subject) and an ISO created-time window. Use when you do not know the contact address; otherwise prefer search_contact_emails. Verifies each returned mailbox and created time. Returns the raw REST page, exact query and honest page/body coverage; continue with the returned cursor and the same filters. No computer or credentials are needed in arguments. Does not send email.",
  },
];

type SessionEntry = {
  session: McpSession;
  revision: number;
  material: OAuthMaterial;
  digest?: string;
  ref?: string;
  recordId?: string;
  invalidated?: boolean;
  changeVersion?: number;
};
type PendingSession = {
  revision: number;
  promise: Promise<McpSession>;
  invalidated?: boolean;
  changeVersion?: number;
  ref?: string;
};

/**
 * Local mail tools for an assigned official mail server. They call the REST API with the same
 * connection, so they stay available when the remote server cannot list its own tools.
 */
function localInstantlyTools(
  assignment: {
    serverId: string;
    allowAllTools: boolean;
    allowedTools: unknown;
    server: McpServer;
  },
  listed: readonly { name: string }[],
): ConnectorTool[] {
  if (
    assignment.server.transport !== "streamable_http" ||
    assignment.server.endpoint !== INSTANTLY_MCP ||
    !["get_email", "list_emails"].every(
      (name) =>
        assignment.allowAllTools ||
        (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(name)),
    )
  )
    return [];
  const route = (toolName: string) => ({
    connectorId: "mcp",
    resourceId: assignment.serverId,
    resourceRevision: assignment.server.revision,
    toolName,
    catalogGroup: assignment.server.slug,
  });
  const tools: ConnectorTool[] = [];
  for (const local of nativeInstantlyReads) {
    if (listed.some((tool) => [local.name, local.toolName].includes(tool.name))) {
      getLogger().warn(
        `Instantly remote ${local.name} tool conflicts with the local integration; local tool withheld`,
      );
      continue;
    }
    tools.push({
      name: `instantly__${assignment.server.slug}__${local.name}`,
      description: local.description,
      inputSchema: local.inputSchema,
      readOnly: true,
      route: route(local.toolName),
    });
  }
  for (const local of nativeInstantlyWrites) {
    if (listed.some((tool) => tool.name === local.toolName)) continue;
    tools.push({
      name: `instantly__${assignment.server.slug}__${local.name}`,
      description: local.description,
      inputSchema: local.inputSchema,
      readOnly: local.readOnly,
      route: route(local.toolName),
    });
  }
  return tools;
}

const FULLENRICH_MCP = "https://mcp.fullenrich.com/mcp";
const FIND_EMAILS = "native_find_emails";

/**
 * The contact lookup tool for an assigned enrichment server: runs the providers one after another
 * over REST and returns, per person, which provider ran and what it found.
 */
function localContactTools(
  assignment: {
    serverId: string;
    allowAllTools: boolean;
    allowedTools: unknown;
    server: McpServer;
  },
  listed: readonly { name: string }[],
): ConnectorTool[] {
  if (
    assignment.server.transport !== "streamable_http" ||
    assignment.server.endpoint !== FULLENRICH_MCP ||
    !(
      assignment.allowAllTools ||
      (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes("enrich_bulk"))
    ) ||
    listed.some((tool) => tool.name === "find_emails")
  )
    return [];
  const tool: ConnectorTool = {
    name: `mcp__${assignment.server.slug}__find_emails`,
    description:
      "Find email addresses for saved candidates. Pass each person's name, LinkedIn URL and current company. One call looks up the first 50; the result names who is left for the next call. When the recruiter asks again after a lookup, pass the role's next results in the same order after those already looked up, never asking which. Checks several contact sources one after another, each only for people still without an email, and reuses emails already found for this account. Waits for the result (up to about four minutes). Returns, per person, the emails found (type work or personal, and the source's delivery check, e.g. DELIVERABLE, or null when unchecked) and what each source did, plus a summary. Its results are the saved contacts. Does not send anything.",
    inputSchema: z.toJSONSchema(FindEmailsInput, { io: "input" }),
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: assignment.serverId,
      resourceRevision: assignment.server.revision,
      toolName: FIND_EMAILS,
      catalogGroup: assignment.server.slug,
    },
  };
  directTools.add(tool);
  return [tool];
}

function localTools(
  assignment: Parameters<typeof localInstantlyTools>[0],
  listed: readonly { name: string }[],
): ConnectorTool[] {
  return [...localInstantlyTools(assignment, listed), ...localContactTools(assignment, listed)];
}

/** Runtime MCP connector. Authorization is re-checked against the bot assignment on every call. */
/**
 * Stale allowlist entries are filtered out below with no error. Discovery already has the
 * live tool list, so compare once and warn when string allowlist names are missing from the
 * server. Non-string JSON values are ignored for both the missing list and the ratio.
 */
export function allowlistDrift(
  allowedTools: unknown,
  offered: Array<{ name: string }>,
): { missing: string[]; offered: number; stringAllowedCount: number } {
  const names = new Set(offered.map((tool) => tool.name));
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  const stringAllowed = allowed.filter((name): name is string => typeof name === "string");
  return {
    missing: stringAllowed.filter((name) => !names.has(name)),
    offered: names.size,
    stringAllowedCount: stringAllowed.length,
  };
}

function reportAllowlistDrift(
  assignment: { allowAllTools: boolean; allowedTools: unknown; server: { slug: string } },
  offered: Array<{ name: string }>,
  context: { spaceId: string; botId?: string },
): void {
  if (assignment.allowAllTools) return;
  const drift = allowlistDrift(assignment.allowedTools, offered);
  if (drift.missing.length === 0) return;
  getLogger().warn(
    `mcp allowlist drift on ${assignment.server.slug}: ${drift.missing.length}/${drift.stringAllowedCount} allowed tools are not offered (server offers ${drift.offered})`,
    {
      spaceId: context.spaceId,
      botId: context.botId,
      // Cap the list: the point is to name the drift, not to print an allowlist.
      missing: drift.missing.slice(0, 10),
    },
  );
}

export async function requireMcpToolAssignment(
  prisma: PrismaClient,
  context: AdapterContext,
  route: Pick<ConnectorRoute, "resourceId" | "resourceRevision">,
  toolName: string,
) {
  if (!context.botId || !route.resourceId)
    throw new IsolationError("MCP tools require a bot context");
  const assignment = await prisma.botMcpServer.findFirst({
    where: {
      botId: context.botId,
      serverId: route.resourceId,
      spaceId: context.spaceId,
      userId: context.userId,
      server: { enabled: true },
    },
    include: { server: true },
  });
  // Local Instantly writes are not remote tools: they ride the same official-server assignment
  // (get_email + list_emails) as the local reads.
  const local = isNativeInstantlyWrite(toolName);
  const required = local ? ["get_email", "list_emails"] : [toolName];
  if (
    !assignment ||
    (local &&
      (assignment.server.endpoint !== INSTANTLY_MCP ||
        assignment.server.transport !== "streamable_http")) ||
    (!assignment.allowAllTools &&
      (!Array.isArray(assignment.allowedTools) ||
        !required.every((name) => (assignment.allowedTools as unknown[]).includes(name))))
  )
    throw new IsolationError("MCP tool is not assigned to this bot");
  if (route.resourceRevision !== assignment.server.revision)
    throw new IsolationError("MCP server changed; rediscover the tool before trying again");
  return assignment;
}

/** Both composition roots and the connector enforce the same exact resource boundary. */
export function firstPartyMcpUrl(value: string | undefined): string | undefined {
  const endpoint = value?.trim();
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  )
    throw new Error(
      "FIRST_PARTY_MCP_URL must be an HTTPS URL without credentials, query or fragment",
    );
  return url.href;
}

function platformMcpCredential(server: Pick<McpServer, "secretId" | "transport" | "endpoint">) {
  if (server.secretId || server.transport !== "streamable_http") return undefined;
  if (server.endpoint === "https://api.autumn.ai/mcp")
    return { key: process.env.AUTUMN_API_KEY?.trim(), label: "Recruiting research" };
  if (server.endpoint === "https://mcp.fullenrich.com/mcp")
    return { key: process.env.FULLENRICH_API_KEY?.trim(), label: "Contact enrichment" };
  // People search also works keyless at a lower rate limit, so a missing key is not a setup gap.
  if (server.endpoint === PLATFORM_PEOPLE_SEARCH_ENDPOINT)
    return { key: process.env.EXA_API_KEY?.trim(), label: "People search", keyless: true };
  return undefined;
}

/** Tools listed outside the lazy catalog even when an agent has many connected tools. */
const directTools = new WeakSet<ConnectorTool>();

export const PLATFORM_PEOPLE_SEARCH_ENDPOINT =
  "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa";

let warnedKeylessPeopleSearch = false;
const PEOPLE_SEARCH_RETRY_DELAYS_MS = [1_000, 2_000];

// A contact lookup takes about a minute; wait for it here so the agent never stops on a
// half-finished lookup. The final status is the record the Contacts view reads.
const ENRICHMENT_POLL_MS = 5_000;
const ENRICHMENT_WAIT_MS = 240_000;
function enrichmentPending(result: Awaited<ReturnType<McpSession["callTool"]>>): boolean {
  if (result.isError) return false;
  const status = mcpObject(result)?.status;
  return typeof status === "string" && /progress|pending|created|queued/i.test(status);
}

class PeopleSearchRateLimitError extends Error {
  constructor() {
    super("People search is rate-limited (HTTP 429); retry later.");
  }
}

function peopleSearchRateLimited(result: Awaited<ReturnType<McpSession["callTool"]>>): boolean {
  // A successful search may quote arbitrary page text, including HTTP errors. Only interpret
  // a failed tool result as a provider error, never a person's profile or a search snippet.
  if (!result.isError) return false;
  const body = mcpObject(result);
  if (body?.status === 429 || body?.statusCode === 429) return true;
  return result.content.some(
    (part) =>
      part.type === "text" &&
      /\bHTTP\s*429\b|\bstatus(?:\s+code)?\s*[:=]?\s*429\b|\b429\s*[:-]?\s*(?:too many requests|rate limit)|\bfree MCP rate limit\b/i.test(
        part.text,
      ),
  );
}

/** Connection readiness only; never return deployment credentials to product clients. */
export function hasPlatformMcpCredential(
  server: Pick<McpServer, "secretId" | "transport" | "endpoint">,
): boolean {
  const credential = platformMcpCredential(server);
  return Boolean(credential?.key || credential?.keyless);
}

export async function loadMcpCredentialRecord(
  prisma: PrismaClient,
  secrets: SecretStore,
  server: Pick<McpServer, "secretId" | "transport" | "endpoint">,
  context: AdapterContext,
  onRef?: (ref: string, recordId: string) => void,
) {
  const secret = server.secretId
    ? await prisma.secret.findFirst({
        where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
      })
    : null;
  if (secret) onRef?.(secret.ciphertext, secret.id);
  const platformService = platformMcpCredential(server);
  const deploymentKey = platformService?.key;
  if (platformService && !deploymentKey && !platformService.keyless)
    throw new Error(`${platformService.label} is not configured on this server`);
  if (platformService?.keyless && !deploymentKey && !warnedKeylessPeopleSearch) {
    warnedKeylessPeopleSearch = true;
    getLogger().warn("people_search.keyless", { rateLimit: "shared free tier" });
  }
  const plaintext = secret
    ? await secrets.load(secret.ciphertext, { recordId: secret.id, signal: context.signal })
    : deploymentKey
      ? JSON.stringify(
          platformService?.keyless
            ? { headers: { "x-api-key": deploymentKey } }
            : { secret: deploymentKey },
        )
      : undefined;
  return { secret, plaintext };
}

/** How long a worker reuses a server's discovered tool list before listing it again. */
export const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
/**
 * How long a worker skips a server whose discovery just failed, instead of reconnecting every run.
 * Longer than the prewarm cadence, which retries it in the background.
 */
export const DISCOVERY_FAILURE_TTL_MS = DISCOVERY_CACHE_TTL_MS;
/** Discovery with this operation id lists every server again, refreshing the cache for runs. */
export const DISCOVERY_REFRESH_OPERATION = "discovery.prewarm";

export class McpConnector implements ConnectorProvider {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connecting = new Map<string, PendingSession>();
  /** Failed-discovery memo per sessionKey; `logged` keeps `discovery.skipped` to once per window. */
  private readonly discoveryFailures = new Map<
    string,
    { version: string; until: number; logged: boolean }
  >();
  // Discovery runs more than once per run: once up front, then again on every lazy
  // catalog access. Each attempt needs its own executionId.
  private discoverySeq = 0;
  private readonly toolCatalog = new Map<
    string,
    { version: string; at: number; listed: Awaited<ReturnType<McpSession["listTools"]>> }
  >();
  private catalogGeneration = 0;
  private readonly unsubscribe: () => void;
  private readonly firstPartyEndpoint?: string;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly options: {
      stdioEnabled?: boolean;
      allowedCommands?: string[];
      network?: RemoteTransportDependencies;
      /** Audit sink for failed discovery. Without it the log line stays the only trace. */
      events?: Pick<ThreadEvents, "append">;
      allowPrivateEndpoint?: boolean;
      firstParty?: {
        endpoint: string;
        accessToken: (context: AdapterContext, rejectedToken?: string) => Promise<string>;
      };
    } = {},
    private readonly oauth?: McpOAuthBroker,
  ) {
    this.firstPartyEndpoint = firstPartyMcpUrl(options.firstParty?.endpoint);
    this.unsubscribe =
      this.secrets.onChange?.((ref) => {
        // ponytail: any credential change drops every cached tool list; changes are rare.
        this.toolCatalog.clear();
        this.discoveryFailures.clear();
        this.catalogGeneration += 1;
        for (const [key, entry] of this.sessions)
          if (entry.ref === ref) {
            // OAuth may renew inside the active request. Static credential changes
            // keep the existing immediate eviction and reconnect behavior.
            if (entry.material.oauth?.tokens) {
              entry.invalidated = true;
              entry.changeVersion = (entry.changeVersion ?? 0) + 1;
            } else void this.evict(key).catch(() => undefined);
          }
        for (const entry of this.connecting.values())
          if (entry.ref === ref) {
            entry.invalidated = true;
            entry.changeVersion = (entry.changeVersion ?? 0) + 1;
          }
      }) ?? (() => {});
  }

  describe() {
    return {
      id: "mcp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    // The built-in people search stays directly callable, so a calibration round needs no
    // catalog search and load turns before its first search.
    const direct = tools.filter((tool) => directTools.has(tool));
    if (direct.length)
      return [
        ...direct,
        ...lazyCatalogTools(
          catalogToolPrefix("mcp"),
          "mcp",
          "MCP",
          catalogEntries(tools.filter((tool) => !directTools.has(tool))),
        ),
      ];
    // The catalog wrappers must not be named `mcp_*`: Anthropic rejects Claude Code OAuth
    // requests that carry a tool whose name starts with "mcp_" (single underscore) with a
    // misleading "You're out of extra usage" 400, on every model. Direct MCP tools are
    // `mcp__server__tool` (double underscore) and are accepted; keep the wrappers off "mcp_".
    return lazyCatalogTools(catalogToolPrefix("mcp"), "mcp", "MCP", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!context.botId) return [];
    const assignments = await this.prisma.botMcpServer.findMany({
      where: {
        botId: context.botId,
        spaceId: context.spaceId,
        userId: context.userId,
        server: { enabled: true },
      },
      include: { server: true },
    });
    const groups = await Promise.all(
      assignments.map(async (assignment): Promise<ConnectorTool[]> => {
        const startedAt = Date.now();
        const failureKey = this.sessionKey(assignment.server, context);
        // The prewarm retries a remembered failure; success then serves the next run.
        if (context.operationId === DISCOVERY_REFRESH_OPERATION)
          this.discoveryFailures.delete(failureKey);
        const failed = this.discoveryFailures.get(failureKey);
        if (failed) {
          if (
            failed.version === this.discoveryVersion(assignment.server) &&
            Date.now() < failed.until
          ) {
            if (!failed.logged) {
              failed.logged = true;
              getLogger().info("discovery.skipped", {
                server: assignment.server.slug,
                untilMs: failed.until,
              });
            }
            return localInstantlyTools(assignment, []);
          }
          this.discoveryFailures.delete(failureKey);
        }
        try {
          const listed = await this.listServerTools(assignment.server, context);
          reportAllowlistDrift(assignment, listed.tools, context);
          const remoteTools: ConnectorTool[] = listed.tools
            .filter(
              (tool) =>
                assignment.allowAllTools ||
                (assignment.allowedTools as unknown[]).includes(tool.name),
            )
            .map((tool) => ({
              name: `mcp__${assignment.server.slug}__${tool.name}`,
              description: tool.description ?? tool.name,
              inputSchema: tool.inputSchema as Record<string, unknown>,
              route: {
                connectorId: "mcp",
                resourceId: assignment.serverId,
                resourceRevision: assignment.server.revision,
                toolName: tool.name,
                catalogGroup: assignment.server.slug,
              },
            }));
          if (assignment.server.endpoint === PLATFORM_PEOPLE_SEARCH_ENDPOINT)
            for (const tool of remoteTools) directTools.add(tool);
          remoteTools.push(...localTools(assignment, listed.tools));
          return remoteTools;
        } catch (error) {
          // A single unavailable server must not hide tools from other connectors.
          getLogger().error(
            `mcp discovery failed for server ${assignment.server.slug}:`,
            sanitizeConnectorError(error),
          );
          // Capture material before eviction so the audited reason stays redacted, the
          // same reason execute() captures it before callTool.
          const key = failureKey;
          this.discoveryFailures.set(key, {
            version: this.discoveryVersion(assignment.server),
            until: Date.now() + DISCOVERY_FAILURE_TTL_MS,
            logged: false,
          });
          const material = this.sessions.get(key)?.material;
          await this.evict(key);
          await this.recordDiscoveryFailure(
            assignment.server.slug,
            error,
            context,
            startedAt,
            material ? oauthMaterialSecrets(material) : [],
          );
          // The local mail tools call the REST API directly, so a remote outage keeps them.
          return localInstantlyTools(assignment, []);
        }
      }),
    );
    return groups.flat();
  }

  /**
   * Leave a failed discovery where every other tool outcome is already visible, as an
   * `agent.tool.completed` event with `outcome: "error"`. Losing a server's tools is
   * otherwise invisible: the run still ends `completed` and the model simply never sees
   * them. Discovery outside a run (settings, tool pickers) has no thread to attach to, so
   * there the log line stays the only trace.
   */
  private async recordDiscoveryFailure(
    slug: string,
    error: unknown,
    context: AdapterContext,
    startedAt: number,
    secrets: string[],
  ): Promise<void> {
    const events = this.options.events;
    if (!events || !context.runId || !context.botId) return;
    const run = await this.prisma.run
      .findUnique({ where: { id: context.runId }, select: { threadId: true } })
      .catch(() => null);
    if (!run) return;
    await appendToolCompletionAudit(
      { events },
      {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: context.runId,
      },
      {
        name: `mcp__${slug}__discovery`,
        executionId: `mcp-discovery-${slug}-${context.runId}-${this.discoverySeq++}`,
        durationMs: Date.now() - startedAt,
        error,
      },
      secrets,
    );
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId !== "mcp") {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    if (!call.route.resourceId) {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (!context.botId) {
      yield { type: "error", message: "MCP tools require a bot context" };
      return;
    }
    // Capture material before callTool so a concurrent eviction/replace cannot
    // drop this call's OAuth secrets from model-visible redaction. Recompute via
    // oauthMaterialSecrets(material) so in-place token refresh stays covered.
    let material: OAuthMaterial | undefined;
    let callStarted = false;
    let sessionKey: string | undefined;
    try {
      if (call.route.toolName === FIND_EMAILS) {
        yield* this.findContactEmails(call, context);
        return;
      }
      const localInstantlyServer =
        nativeInstantlyReads.some((tool) => tool.toolName === call.route!.toolName) ||
        isNativeInstantlyWrite(call.route.toolName)
          ? await this.prisma.mcpServer.findFirst({
              where: {
                id: call.route.resourceId,
                userId: context.userId,
                spaceId: context.spaceId,
                endpoint: INSTANTLY_MCP,
                transport: "streamable_http",
              },
              select: { id: true },
            })
          : null;
      if (localInstantlyServer) {
        yield* isNativeInstantlyWrite(call.route.toolName)
          ? this.writeInstantly(call, context)
          : this.readInstantlyEmails(call, context);
        return;
      }
      const assignment = await requireMcpToolAssignment(
        this.prisma,
        context,
        call.route,
        call.route.toolName,
      );
      const peopleSearch =
        assignment.server.transport === "streamable_http" &&
        assignment.server.endpoint === PLATFORM_PEOPLE_SEARCH_ENDPOINT &&
        ["web_search_exa", "web_search_advanced_exa"].includes(call.route.toolName);
      const enrichmentResults =
        assignment.server.transport === "streamable_http" &&
        assignment.server.endpoint === "https://mcp.fullenrich.com/mcp" &&
        call.route.toolName === "get_enrichment_results";
      await requireAutumnTaskOwnership(
        this.prisma,
        context,
        assignment.server,
        call.route.toolName,
        call.args,
      );
      const ownedArgs = await requireFullEnrichJobOwnership(
        this.prisma,
        context,
        assignment.server,
        call.route.toolName,
        call.args,
      );
      await requireQuickSearchBeforeResearch(
        this.prisma,
        context,
        assignment.server,
        call.route.toolName,
        call.args,
      );
      const crmTarget =
        context.runId && /(?:^crm_|_crm_)/.test(call.route.toolName)
          ? await this.crmBinding(context, assignment.server)
          : null;
      sessionKey = this.sessionKey(assignment.server, context);
      let session = await this.sessionFor(assignment.server, context);
      material = this.sessions.get(sessionKey)?.material;
      context.signal.throwIfAborted();
      const emailScope =
        assignment.server.endpoint === INSTANTLY_MCP &&
        ["get_email", "list_emails", "reply_to_email"].includes(call.route.toolName)
          ? await this.instantlyCampaignScope(context, assignment.server.id)
          : null;
      let args = ownedArgs;
      if (emailScope && call.route.toolName === "list_emails") {
        const campaignId = scopedInstantlyCampaign(args, emailScope.campaignIds);
        const catalog = await session.listTools({ signal: context.signal });
        const schema = catalog.tools.find((tool) => tool.name === "list_emails")?.inputSchema;
        if (!schema?.properties || !("campaign_id" in schema.properties))
          throw new IsolationError(
            "This email list cannot filter by role campaign; use the scoped mailbox or contact email tool",
          );
        args = { ...args, campaign_id: campaignId };
      }

      if (emailScope && call.route.toolName === "reply_to_email") {
        await requireMcpToolAssignment(this.prisma, context, call.route, "get_email");
        if (typeof args.reply_to_uuid !== "string" || !UUID.test(args.reply_to_uuid))
          throw new IsolationError();
        const original = await session.callTool(
          "get_email",
          { id: args.reply_to_uuid },
          { signal: context.signal },
        );
        const email = original.isError ? null : readInstantlyEmail(mcpObject(original));
        if (
          !email?.campaign_id ||
          !emailScope.campaignIds.includes(email.campaign_id) ||
          email.id !== args.reply_to_uuid ||
          (args.eaccount !== undefined &&
            !sameInstantlyAddresses(email.eaccount, String(args.eaccount)))
        )
          throw new IsolationError(
            "Reply anchor does not belong to the current role campaign and mailbox",
          );
      }

      if (crmTarget) {
        const target = crmTarget;
        await requireMcpToolAssignment(this.prisma, context, call.route, "get_crm_role");
        const roleResult = await session.callTool(
          "get_crm_role",
          {
            p_org: target.organizationId,
            p_role: target.crmRoleId,
          },
          { signal: context.signal },
        );
        const role = roleResult.isError
          ? undefined
          : (mcpObject(roleResult)?.data as Record<string, unknown> | undefined);
        if (
          !role ||
          role.role_spec_id !== target.crmRoleId ||
          (role.organization_id !== undefined && role.organization_id !== target.organizationId) ||
          role.client_id !== target.crmClientId ||
          role.client_label !== target.clientLabel ||
          role.role_label !== target.roleLabel
        )
          throw new IsolationError("CRM role scope changed; reopen the role workspace");
        args = await agentCrmScopedArgs(
          call.route.toolName,
          call.args,
          target,
          async (membershipArgs) => {
            await requireMcpToolAssignment(
              this.prisma,
              context,
              call.route!,
              "list_crm_candidate_roles",
            );
            return session.callTool("list_crm_candidates", membershipArgs, {
              signal: context.signal,
            });
          },
        );
      }
      if (crmTarget) {
        await requireMcpToolAssignment(this.prisma, context, call.route, call.route.toolName);
        const current = await this.crmBinding(context, assignment.server);
        if (JSON.stringify(current) !== JSON.stringify(crmTarget))
          throw new IsolationError(
            "CRM workspace changed during the read; retry in the current workspace",
          );
      }
      if (
        assignment.server.endpoint === INSTANTLY_MCP &&
        ["get_email", "list_emails", "reply_to_email"].includes(call.route.toolName)
      ) {
        await this.assertInstantlyScope(context, assignment.server.id, emailScope);
        await requireMcpToolAssignment(this.prisma, context, call.route, call.route.toolName);
      }
      callStarted = true;
      let result: Awaited<ReturnType<McpSession["callTool"]>>;
      const enrichmentDeadline = Date.now() + ENRICHMENT_WAIT_MS;
      for (let attempt = 0; ; attempt += 1) {
        context.signal.throwIfAborted();
        try {
          result = await session.callTool(call.route.toolName, args, { signal: context.signal });
          if (
            enrichmentResults &&
            enrichmentPending(result) &&
            Date.now() + ENRICHMENT_POLL_MS < enrichmentDeadline
          ) {
            await abortableDelay(ENRICHMENT_POLL_MS, context.signal);
            continue;
          }
          if (!peopleSearch || !peopleSearchRateLimited(result)) break;
        } catch (error) {
          if (!peopleSearch || !(error instanceof SdkHttpError) || error.status !== 429)
            throw error;
        }
        context.signal.throwIfAborted();
        const retryMs = PEOPLE_SEARCH_RETRY_DELAYS_MS[attempt];
        getLogger().warn("people_search.rate_limited", {
          attempt: attempt + 1,
          retryMs: retryMs ?? 0,
          exhausted: retryMs === undefined,
        });
        if (retryMs === undefined) throw new PeopleSearchRateLimitError();
        await abortableDelay(retryMs, context.signal);
        context.signal.throwIfAborted();
        // A backoff is not authorization to use a tool that was disabled while waiting.
        const current = await requireMcpToolAssignment(
          this.prisma,
          context,
          call.route,
          call.route.toolName,
        );
        session = await this.sessionFor(current.server, context);
        material = this.sessions.get(sessionKey)?.material;
      }
      if (crmTarget) {
        await requireMcpToolAssignment(this.prisma, context, call.route, call.route.toolName);
        if (
          JSON.stringify(await this.crmBinding(context, assignment.server)) !==
          JSON.stringify(crmTarget)
        )
          throw new IsolationError("CRM workspace changed during the read");
      }
      if (
        assignment.server.endpoint === INSTANTLY_MCP &&
        ["get_email", "list_emails"].includes(call.route.toolName)
      )
        await this.assertInstantlyScope(context, assignment.server.id, emailScope);
      if (crmTarget && call.route.toolName === "list_crm_role_correspondence" && !result.isError) {
        const data = mcpObject(result)?.data as Record<string, unknown> | undefined;
        const page = RecruitingCrmRoleMailReadSchema.safeParse(data);
        if (
          !page.success ||
          data?.version !== 2 ||
          page.data.organization_id !== crmTarget.organizationId ||
          page.data.role_id !== crmTarget.crmRoleId ||
          (args.p_candidate !== undefined && data.candidate_id !== args.p_candidate) ||
          page.data.messages.some(
            (message) =>
              message.organization_id !== crmTarget.organizationId ||
              (args.p_candidate !== undefined && message.candidate_id !== args.p_candidate),
          )
        )
          throw new IsolationError(
            "CRM email page does not prove the requested role and candidate scope",
          );
      }
      if (emailScope && call.route.toolName !== "reply_to_email" && !result.isError) {
        const body = mcpObject(result);
        const emails =
          call.route.toolName === "get_email"
            ? [readInstantlyEmail(body)]
            : readInstantlyEmailPage(body)?.items;
        if (
          !emails ||
          emails.some(
            (email) =>
              !email?.campaign_id ||
              !emailScope.campaignIds.includes(email.campaign_id) ||
              (call.route!.toolName === "list_emails" && email.campaign_id !== args.campaign_id) ||
              (args.eaccount !== undefined &&
                !sameInstantlyAddresses(email.eaccount, String(args.eaccount))) ||
              (call.route!.toolName === "get_email" && args.id !== email.id),
          )
        )
          throw new IsolationError(
            "Email does not belong to the requested role campaign and mailbox",
          );
      }
      const secrets = material ? oauthMaterialSecrets(material) : [];
      yield { type: "result", data: redactConnectorPayload(result, secrets) };
    } catch (error) {
      // A known rate limit leaves the session healthy. Other thrown calls keep the existing
      // reconnect and uncertain-outcome handling for transport or authentication failures.
      const secrets = material ? oauthMaterialSecrets(material) : [];
      if (sessionKey && !(error instanceof PeopleSearchRateLimitError))
        await this.evict(sessionKey);
      yield {
        type: "error",
        message: sanitizeConnectorError(error, secrets),
        ...(callStarted && !(error instanceof PeopleSearchRateLimitError)
          ? { outcome: "uncertain" as const }
          : {}),
      };
    }
  }

  /** Recheck scheduling proof after native anchor/account awaits, at the actual send boundary. */
  private async assertSchedulingConfirmationDispatch(call: ConnectorCall, context: AdapterContext) {
    if (!context.schedulingConfirmationEffectId) return;
    if (!context.runId) throw new IsolationError();
    const effect = await this.prisma.externalEffect.findUnique({
      where: { id: context.schedulingConfirmationEffectId },
      include: { run: { select: { threadId: true, userId: true, botId: true } } },
    });
    const result = effect?.result;
    const raw =
      result && typeof result === "object" && !Array.isArray(result)
        ? result.schedulingApprovalEvidence
        : undefined;
    if (!raw) throw new IsolationError("Scheduling confirmation proof is unavailable");
    if (
      !effect ||
      effect.runId !== context.runId ||
      effect.spaceId !== context.spaceId ||
      effect.run.userId !== context.userId ||
      effect.run.botId !== context.botId ||
      effect.status !== "executing"
    )
      throw new IsolationError();
    const evidence = SchedulingApprovalEvidenceSchema.parse(raw);
    const direct = boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool");
    const catalog = catalogApprovalDetails(effect.request, "__rakazoCatalogTool");
    const savedRoute = direct?.route ?? catalog?.route;
    const savedArgs = direct?.args ?? catalog?.args.arguments;
    if (
      evidence.operation !== "confirm" ||
      evidence.requestHash !== calendarEvidenceHash(effect.request) ||
      !call.route ||
      savedRoute?.connectorId !== call.route.connectorId ||
      savedRoute?.resourceId !== call.route.resourceId ||
      savedRoute?.resourceRevision !== call.route.resourceRevision ||
      savedRoute?.toolName !== call.route.toolName ||
      stableJsonValue(savedArgs) !== stableJsonValue(call.args)
    )
      throw new IsolationError();
    const actor = {
      spaceId: context.spaceId,
      userId: context.userId,
      email: "",
      isDeploymentOwner: false,
    };
    const plan = await loadVerifiedRecruitingSchedulingPlan(this.prisma, actor, {
      threadId: effect.run.threadId,
      planId: evidence.planId,
    });
    if (
      schedulingPlanHash(plan) !== evidence.planHash ||
      plan.bookingEffectId !== evidence.bookingEffectId
    )
      throw new IsolationError();
    assertSchedulingCall(plan, "confirm", call.route, call.args);
    await bindRecruitingSchedulingOperation(this.prisma, actor, {
      threadId: effect.run.threadId,
      planId: plan.id,
      operation: "confirm",
      effectId: effect.id,
    });
  }

  private async *writeInstantly(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    const redactions: string[] = [];
    const safeFetch = createSafeRemoteFetch(
      this.options.network?.fetch,
      this.options.network?.resolveHostname,
    );
    try {
      const credential = await this.authorizeInstantlyRest(call, context, redactions);
      const emailScope = ["native_instantly_get_email", "native_instantly_reply_to_email"].includes(
        call.route!.toolName,
      )
        ? await this.instantlyCampaignScope(context, credential.server.id)
        : null;
      if (emailScope && call.route!.toolName === "native_instantly_reply_to_email") {
        if (typeof call.args.reply_to_uuid !== "string" || !UUID.test(call.args.reply_to_uuid))
          throw new IsolationError();
        const original = await instantlyRest(
          safeFetch,
          credential.key,
          context.signal,
        )("GET", `/emails/${call.args.reply_to_uuid}`);
        const email = readInstantlyEmail(original);
        if (
          !email?.campaign_id ||
          !emailScope.campaignIds.includes(email.campaign_id) ||
          email.id !== call.args.reply_to_uuid ||
          (call.args.eaccount !== undefined &&
            !sameInstantlyAddresses(email.eaccount, String(call.args.eaccount)))
        )
          throw new IsolationError(
            "Reply anchor does not belong to the current role campaign and mailbox",
          );
      }
      const scopedEmailOperation = [
        "native_instantly_get_email",
        "native_instantly_reply_to_email",
      ].includes(call.route!.toolName);
      const rest = instantlyRest(safeFetch, credential.key, context.signal);
      const assertScope = async () => {
        if (scopedEmailOperation)
          await this.assertInstantlyScope(context, credential.server.id, emailScope);
        const current = await this.authorizeInstantlyRest(call, context, redactions);
        if (current.secretId !== credential.secretId || current.digest !== credential.digest)
          throw new IsolationError();
      };
      if (scopedEmailOperation) await assertScope();
      const result = await runInstantlyWrite(
        this.prisma,
        async (method, path, body) => {
          if (scopedEmailOperation && method !== "GET") {
            await assertScope();
            if (call.route!.toolName === "native_instantly_reply_to_email")
              await this.assertSchedulingConfirmationDispatch(call, context);
          }
          return rest(method, path, body);
        },
        context,
        credential.server.id,
        call.route!.toolName,
        call.args,
      );
      if (call.route!.toolName === "native_instantly_get_email") await assertScope();
      if (emailScope && call.route!.toolName === "native_instantly_get_email") {
        const email = readInstantlyEmail(result);
        if (
          !email?.campaign_id ||
          !emailScope.campaignIds.includes(email.campaign_id) ||
          email.id !== call.args.id
        )
          throw new IsolationError("Email does not belong to the current role campaign");
      }
      yield {
        type: "result",
        data: redactConnectorPayload(
          { structuredContent: { source: "local_native_instantly_rest", result } },
          redactions,
        ),
      };
    } catch (error) {
      // Zod and our own messages carry no secrets; anything else stays generic.
      const detail =
        error instanceof InstantlyRestError
          ? ` HTTP ${error.status}.`
          : error instanceof z.ZodError
            ? ` Invalid arguments: ${z.prettifyError(error)}`
            : error instanceof Error && !(error instanceof IsolationError)
              ? ` ${sanitizeConnectorError(error, redactions)}`
              : " Check the current assigned connection and requested scope.";
      yield {
        type: "error",
        message: `Instantly ${call.route!.toolName} failed.${detail}`,
        // A network failure mid-request may still have reached the provider.
        ...(error instanceof TypeError ? { outcome: "uncertain" as const } : {}),
      };
    } finally {
      await safeFetch.close().catch(() => undefined);
    }
  }

  private async *findContactEmails(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    const redactions: string[] = [];
    const safeFetch = createSafeRemoteFetch(
      this.options.network?.fetch,
      this.options.network?.resolveHostname,
    );
    try {
      const input = FindEmailsInput.parse(call.args);
      const assignment = await requireMcpToolAssignment(
        this.prisma,
        context,
        call.route!,
        "enrich_bulk",
      );
      const { server } = assignment;
      if (server.endpoint !== FULLENRICH_MCP || server.transport !== "streamable_http")
        throw new IsolationError();
      // The assigned connection's own key, or the platform key when it has none.
      const { plaintext } = await loadMcpCredentialRecord(
        this.prisma,
        this.secrets,
        server,
        context,
      );
      const material = plaintext ? (JSON.parse(plaintext) as OAuthMaterial) : undefined;
      if (material) redactions.push(...oauthMaterialSecrets(material));
      const headers = new Headers(material?.headers);
      const fullenrich = [material?.secret, headers.get("authorization")]
        .find((value): value is string => typeof value === "string" && value.length > 0)
        ?.replace(/^Bearer /i, "");
      const contactout = process.env.CONTACTOUT_API_KEY?.trim();
      const leadmagic = process.env.LEADMAGIC_API_KEY?.trim();
      redactions.push(...[fullenrich, contactout, leadmagic].filter((key): key is string => !!key));
      const result = await findEmails(input, {
        fetch: safeFetch,
        signal: context.signal,
        keys: { fullenrich, contactout, leadmagic },
        saved: await savedContactEmails(this.prisma, context, server, FIND_EMAILS),
      });
      yield {
        type: "result",
        data: redactConnectorPayload(
          { structuredContent: { source: "local_contact_lookup", ...result } },
          redactions,
        ),
      };
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? ` Invalid arguments: ${z.prettifyError(error)}`
          : error instanceof Error && !(error instanceof IsolationError)
            ? ` ${sanitizeConnectorError(error, redactions)}`
            : " Check the current assigned connection.";
      yield { type: "error", message: `Contact lookup failed.${detail}` };
    } finally {
      await safeFetch.close().catch(() => undefined);
    }
  }

  /** Exact assigned Instantly connection and its unambiguous API key. */
  private async authorizeInstantlyRest(
    call: ConnectorCall,
    context: AdapterContext,
    redactions: string[],
  ) {
    context.signal.throwIfAborted();
    const assignment = await requireMcpToolAssignment(
      this.prisma,
      context,
      call.route!,
      "get_email",
    );
    const { server } = assignment;
    if (
      server.endpoint !== INSTANTLY_MCP ||
      server.transport !== "streamable_http" ||
      server.userId !== context.userId ||
      server.spaceId !== context.spaceId ||
      (!assignment.allowAllTools &&
        (!Array.isArray(assignment.allowedTools) ||
          !assignment.allowedTools.includes("list_emails")))
    )
      throw new IsolationError();
    const { secret, plaintext } = await loadMcpCredentialRecord(
      this.prisma,
      this.secrets,
      server,
      context,
    );
    if (!secret || !plaintext)
      throw new Error(
        `${server.name} is not connected; call request_connection with serverId "${server.id}".`,
      );
    const material = JSON.parse(plaintext) as OAuthMaterial;
    redactions.push(...oauthMaterialSecrets(material));
    if (material.oauth) throw new Error("An existing API-key credential is required");
    const headers = new Headers(material.headers);
    // The official MCP also accepts the raw API key in Authorization; REST requires Bearer.
    const keys = [material.secret, headers.get("authorization"), headers.get("x-api-key")]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.replace(/^Bearer /i, ""));
    const key = keys[0];
    if (!key || /[\r\n\0]/.test(key) || keys.some((value) => value !== key))
      throw new Error("An unambiguous existing API key is required");
    redactions.push(key);
    context.signal.throwIfAborted();
    return { server, key, secretId: secret.id, digest: credentialDigest(plaintext) };
  }

  /** Resolve only this run's current workspace, never another role owned by the same user. */
  private async crmBinding(context: AdapterContext, server: McpServer) {
    const run = await this.prisma.run.findFirst({
      where: {
        id: context.runId,
        spaceId: context.spaceId,
        userId: context.userId,
        botId: context.botId,
      },
      select: { threadId: true },
    });
    if (!run) throw new IsolationError();
    const target = await getRecruitingWorkspaceCrmTarget(
      this.prisma,
      {
        userId: context.userId,
        spaceId: context.spaceId,
        email: "",
        isDeploymentOwner: false,
      },
      { threadId: run.threadId },
    );
    if (!target || target.mcpServerId !== server.id || target.serverRevision !== server.revision)
      throw new IsolationError("Open the current CRM role workspace before using CRM tools");
    return target;
  }

  /** Existing campaign identity only; reading mail must never create or infer a campaign by name. */
  private async instantlyCampaignScope(
    context: AdapterContext,
    serverId: string,
  ): Promise<{ campaignIds: string[]; workspaceKey: string } | null> {
    if (!context.runId) return null;
    const run = await this.prisma.run.findFirst({
      where: {
        id: context.runId,
        spaceId: context.spaceId,
        userId: context.userId,
        botId: context.botId,
      },
      select: {
        threadId: true,
        thread: { select: { groupId: true, activeRecruitingRoleId: true } },
      },
    });
    if (!run) throw new IsolationError();
    const target = await getRecruitingWorkspaceCrmTarget(
      this.prisma,
      {
        userId: context.userId,
        spaceId: context.spaceId,
        email: "",
        isDeploymentOwner: false,
      },
      { threadId: run.threadId },
    );
    if (target) {
      const route = { resourceId: target.mcpServerId, resourceRevision: target.serverRevision };
      const assigned = await requireMcpToolAssignment(this.prisma, context, route, "get_crm_role");
      const session = await this.sessionFor(assigned.server, context);
      const result = await session.callTool(
        "get_crm_role",
        {
          p_org: target.organizationId,
          p_role: target.crmRoleId,
          p_view: "campaigns",
          p_limit: 50,
          p_offset: 0,
        },
        { signal: context.signal },
      );
      const page = result.isError
        ? null
        : RecruitingCrmRoleCampaignsReadSchema.safeParse(mcpObject(result)?.data);
      if (
        !page?.success ||
        page.data.organization_id !== target.organizationId ||
        page.data.role_spec_id !== target.crmRoleId ||
        page.data.offset !== 0 ||
        page.data.next_offset !== null ||
        !page.data.campaigns.length ||
        page.data.campaigns.length > 50
      )
        throw new IsolationError("Current CRM role campaign mapping is unavailable or incomplete");
      return {
        campaignIds: page.data.campaigns.map((campaign) => campaign.id).sort(),
        workspaceKey: JSON.stringify([run.threadId, target]),
      };
    }
    if (run.thread.activeRecruitingRoleId) {
      const binding = await readRoleCampaignBinding(
        this.prisma,
        context.spaceId,
        serverId,
        run.thread.activeRecruitingRoleId,
      );
      if (!binding) throw new IsolationError("This role has no verified existing email campaign");
      return {
        campaignIds: [binding.campaignId],
        workspaceKey: JSON.stringify([run.threadId, run.thread.activeRecruitingRoleId, serverId]),
      };
    }
    if (run.thread.groupId?.startsWith("recruiting-crm-"))
      throw new IsolationError("Open the CRM role workspace before reading its campaign email");
    return null;
  }

  private async assertInstantlyScope(
    context: AdapterContext,
    serverId: string,
    expected: Awaited<ReturnType<McpConnector["instantlyCampaignScope"]>>,
  ) {
    const current = await this.instantlyCampaignScope(context, serverId);
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new IsolationError("The current role or campaign mapping changed during the operation");
  }

  private async *readInstantlyEmails(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    let phase = "authorization";
    const isHistory = call.route!.toolName === THREAD_HISTORY;
    const isMailbox = call.route!.toolName === MAILBOX_EMAILS;
    const operation = isHistory ? "thread history" : isMailbox ? "mailbox email" : "contact email";
    if (!isHistory && !isMailbox && context.runId) {
      const parsed = ContactEmailsInput.safeParse(call.args);
      const refused =
        parsed.success &&
        unresolvedContactEmailError(context.runId, parsed.data.email, parsed.data.name);
      if (refused) {
        yield { type: "error", message: refused };
        return;
      }
    }
    let rejectedStatus: number | undefined;
    let rejectedCode: string | undefined;
    let reason = "";
    let hint = "";
    const redactions: string[] = [];
    const safeFetch = createSafeRemoteFetch(
      this.options.network?.fetch,
      this.options.network?.resolveHostname,
    );
    try {
      const historyInput = isHistory ? ThreadHistoryInput.parse(call.args) : undefined;
      const mailboxInput = isMailbox ? MailboxEmailsInput.parse(call.args) : undefined;
      const contactInput = isHistory || isMailbox ? undefined : ContactEmailsInput.parse(call.args);
      const input = historyInput ?? mailboxInput ?? contactInput!;
      const authorize = () => this.authorizeInstantlyRest(call, context, redactions);
      const credential = await authorize();
      const emailScope = await this.instantlyCampaignScope(context, credential.server.id);
      const assertAuthorized = async () => {
        await this.assertInstantlyScope(context, credential.server.id, emailScope);
        const current = await authorize();
        if (current.secretId !== credential.secretId || current.digest !== credential.digest)
          throw new IsolationError();
      };
      phase = "native catalog";
      // Only thread history needs the remote server (for its anchor). The other reads use REST
      // alone, so an unreachable remote server, which also cannot offer a conflicting tool,
      // does not block them.
      const remote = await this.sessionFor(credential.server, context)
        .then(async (session) => ({
          session,
          listed: await session.listTools({ signal: context.signal }),
        }))
        .catch((error: unknown) => {
          if (historyInput || context.signal?.aborted) throw error;
          return undefined;
        });
      const local = nativeInstantlyReads.find((tool) => tool.toolName === call.route!.toolName)!;
      if (remote?.listed.tools.some((tool) => [local.name, local.toolName].includes(tool.name)))
        throw new Error("Remote tool conflicts with the local integration; rediscover tools");
      phase = "native anchor";
      const rawAnchor = historyInput
        ? await remote!.session.callTool(
            "get_email",
            { id: historyInput.anchor_id },
            { signal: context.signal },
          )
        : undefined;
      const anchor =
        !rawAnchor || rawAnchor.isError || "error" in rawAnchor
          ? null
          : readInstantlyEmail(mcpObject(rawAnchor));
      if (
        historyInput &&
        (!anchor ||
          anchor.id !== historyInput.anchor_id ||
          !anchor.thread_id ||
          !sameInstantlyAddresses(anchor.eaccount, anchor.eaccount))
      )
        throw new Error("The current native email anchor is invalid");
      const campaignId = emailScope
        ? scopedInstantlyCampaign(
            { campaign_id: input.campaign_id ?? anchor?.campaign_id },
            emailScope.campaignIds,
          )
        : input.campaign_id;
      if (anchor && campaignId && anchor.campaign_id !== campaignId)
        throw new IsolationError("Email anchor does not belong to the requested role campaign");
      if (contactInput && !contactInput.eaccount) {
        // Same rule as ensure_role_campaign: one connected mailbox is the default sending side.
        phase = "default mailbox";
        const accounts = await safeFetch(
          new URL("https://api.instantly.ai/api/v2/accounts?limit=2"),
          {
            method: "GET",
            headers: { authorization: `Bearer ${credential.key}` },
            signal: context.signal,
          },
        );
        const { text } = await readBoundedText(accounts, 100_000);
        const items = accounts.ok
          ? (JSON.parse(text) as { items?: { email?: unknown }[] }).items
          : [];
        if (items?.length === 1 && typeof items[0]?.email === "string")
          contactInput.eaccount = items[0].email;
      }
      const url = new URL("https://api.instantly.ai/api/v2/emails");
      url.search = new URLSearchParams({
        ...(anchor
          ? { search: `thread:${anchor.thread_id}`, eaccount: anchor.eaccount }
          : mailboxInput
            ? {
                eaccount: mailboxInput.eaccount,
                ...(mailboxInput.search ? { search: mailboxInput.search } : {}),
                ...(mailboxInput.min_timestamp_created
                  ? { min_timestamp_created: mailboxInput.min_timestamp_created }
                  : {}),
                ...(mailboxInput.max_timestamp_created
                  ? { max_timestamp_created: mailboxInput.max_timestamp_created }
                  : {}),
                sort_order: "desc",
              }
            : {
                lead: contactInput!.email,
                ...(contactInput!.eaccount ? { eaccount: contactInput!.eaccount } : {}),
                sort_order: "desc",
              }),
        ...(campaignId ? { campaign_id: campaignId } : {}),
        mode: "emode_all",
        latest_of_thread: "false",
        preview_only: "false",
        limit: String(input.limit),
        ...(input.starting_after ? { starting_after: input.starting_after } : {}),
      }).toString();
      phase = isHistory
        ? "REST thread page"
        : isMailbox
          ? "REST mailbox page"
          : "REST contact page";
      await assertAuthorized();
      const response = await safeFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${credential.key}` },
        signal: context.signal,
      });
      const { text, truncated } = await readBoundedText(response, EMAIL_PAGE_BOUND);
      if (!response.ok) {
        rejectedStatus = response.status;
        rejectedCode = instantlyErrorCode(text);
        throw new Error("Email read request rejected");
      }
      if (truncated) {
        reason = " The page exceeded the size bound; retry with a smaller limit.";
        throw new Error("Email read response exceeded its bound");
      }
      reason = " Instantly returned an unreadable page.";
      const rawPage: unknown = JSON.parse(text);
      const page = readInstantlyEmailPage(rawPage);
      if (page) reason = " Instantly returned emails outside the requested scope.";
      if (
        !page ||
        page.items.length > input.limit ||
        page.items.some(
          (email) =>
            (campaignId && email.campaign_id !== campaignId) ||
            (anchor
              ? email.organization_id !== anchor.organization_id ||
                email.thread_id !== anchor.thread_id ||
                (email.campaign_id ?? null) !== (anchor.campaign_id ?? null) ||
                !sameInstantlyAddresses(email.eaccount, anchor.eaccount)
              : mailboxInput
                ? !sameInstantlyAddresses(email.eaccount, mailboxInput.eaccount) ||
                  (mailboxInput.min_timestamp_created !== undefined &&
                    Date.parse(email.timestamp_created) <
                      Date.parse(mailboxInput.min_timestamp_created)) ||
                  (mailboxInput.max_timestamp_created !== undefined &&
                    Date.parse(email.timestamp_created) >
                      Date.parse(mailboxInput.max_timestamp_created))
                : !sameInstantlyAddresses(email.eaccount, email.eaccount) ||
                  (contactInput!.eaccount !== undefined &&
                    !sameInstantlyAddresses(email.eaccount, contactInput!.eaccount)) ||
                  (email.lead != null &&
                    !sameInstantlyAddresses(email.lead, contactInput!.email)) ||
                  (!sameInstantlyAddresses(email.from_address_email, contactInput!.email) &&
                    !addressparser(email.to_address_email_list).some((recipient) =>
                      sameInstantlyAddresses(recipient.address, contactInput!.email),
                    ))),
        )
      )
        throw new Error("Email page does not match the requested scope");
      reason = "";
      if (contactInput && page.items.length === 0) {
        // An empty page is the symptom of contact/mailbox arguments passed the wrong way round.
        phase = "argument check";
        const account = await safeFetch(
          new URL(
            `https://api.instantly.ai/api/v2/accounts/${encodeURIComponent(contactInput.email)}`,
          ),
          {
            method: "GET",
            headers: { authorization: `Bearer ${credential.key}` },
            signal: context.signal,
          },
        );
        await account.body?.cancel();
        if (account.ok) {
          hint =
            " The email argument is one of your connected Instantly mailboxes; pass the contact as email and the mailbox as eaccount.";
          throw new Error("Contact lookup arguments are swapped");
        }
      }
      // Instantly v2 documents no per-lead stop or pause: PATCH /api/v2/leads/{id} has no
      // sequence field and Lead.status (2 Paused, 3 Completed) is readOnly. POST
      // /api/v2/leads/update-interest-status is documented to complete leads and trigger
      // automations/subsequences, not to stop a sequence, so it is not used as a stop.
      // The native stop is the campaign setting GET /api/v2/campaigns/{id} stop_on_reply
      // ("Whether to stop the campaign on reply"); report it, never fabricate a stop.
      // https://developer.instantly.ai/api-reference/campaign/get-campaign
      const repliedCampaigns = [
        ...new Set(
          page.items
            .filter(
              (email) =>
                email.ue_type === 2 &&
                email.campaign_id &&
                email.lead &&
                sameInstantlyAddresses(email.from_address_email, email.lead),
            )
            .map((email) => email.campaign_id!),
        ),
      ].slice(0, 5); // ponytail: bounded per page; a later page reports the rest
      const replyFollowUps: Array<{
        campaignId: string;
        stopOnReply: boolean | null;
        warning?: string;
      }> = [];
      for (const campaignId of repliedCampaigns) {
        phase = "campaign reply policy";
        let stopOnReply: boolean | null = null;
        try {
          const response = await safeFetch(
            new URL(`https://api.instantly.ai/api/v2/campaigns/${encodeURIComponent(campaignId)}`),
            {
              method: "GET",
              headers: { authorization: `Bearer ${credential.key}` },
              signal: context.signal,
            },
          );
          const { text, truncated } = await readBoundedText(response, 1_000_000);
          const campaign: unknown = response.ok && !truncated ? JSON.parse(text) : null;
          if (
            campaign &&
            typeof campaign === "object" &&
            "id" in campaign &&
            campaign.id === campaignId &&
            "stop_on_reply" in campaign &&
            typeof campaign.stop_on_reply === "boolean"
          )
            stopOnReply = campaign.stop_on_reply;
        } catch {
          context.signal.throwIfAborted();
        }
        replyFollowUps.push({
          campaignId,
          stopOnReply,
          ...(stopOnReply
            ? {}
            : {
                warning:
                  stopOnReply === false
                    ? "The lead replied but this campaign's stop_on_reply is off, so Instantly keeps sending follow-ups. Turn on stop on reply for the campaign in Instantly."
                    : "The lead replied but whether this campaign stops on reply could not be confirmed; check stop on reply for the campaign in Instantly.",
              }),
        });
      }
      await assertAuthorized();
      yield {
        type: "result",
        data: redactConnectorPayload(
          {
            structuredContent: {
              source: "local_native_instantly_rest",
              ...(anchor ? { anchor: rawAnchor } : {}),
              ...(replyFollowUps.length ? { replyFollowUps } : {}),
              page: rawPage,
              query: Object.fromEntries(url.searchParams),
              coverage: {
                ...(anchor
                  ? {
                      scope: "exact_thread",
                      anchorId: anchor.id,
                      organizationId: anchor.organization_id,
                      account: anchor.eaccount,
                      threadId: anchor.thread_id,
                      anchorPresent: page.items.some((email) => email.id === anchor.id),
                    }
                  : mailboxInput
                    ? {
                        scope: "mailbox",
                        account: mailboxInput.eaccount,
                        organizationIds: [
                          ...new Set(page.items.map((email) => email.organization_id)),
                        ],
                      }
                    : {
                        scope: "exact_contact",
                        contactEmail: contactInput!.email,
                        account: contactInput!.eaccount ?? null,
                        organizationIds: [
                          ...new Set(page.items.map((email) => email.organization_id)),
                        ],
                        accounts: [...new Set(page.items.map((email) => email.eaccount))],
                      }),
                startingAfter: input.starting_after ?? null,
                nextStartingAfter: page.next_starting_after ?? null,
                pageExhausted: !page.next_starting_after,
                bodiesComplete: page.items.every(
                  (email) =>
                    email.body_fallback_reason == null &&
                    (typeof email.body.text === "string" || typeof email.body.html === "string"),
                ),
                returnedCount: page.items.length,
                checkedAt: new Date().toISOString(),
              },
            },
          },
          redactions,
        ),
      };
    } catch {
      yield {
        type: "error",
        message: `Instantly ${operation} read failed during ${phase}.${rejectedStatus ? ` HTTP ${rejectedStatus}${rejectedCode ? ` (${rejectedCode})` : ""}.` : reason || " Check the current assigned connection and requested scope."}${hint}`,
      };
    } finally {
      await safeFetch.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await Promise.allSettled([...this.connecting.values()].map(({ promise }) => promise));
    await Promise.all([...this.sessions.values()].map(({ session }) => session.close()));
    this.sessions.clear();
    this.connecting.clear();
  }

  /**
   * The server's raw tool list, cached per worker for DISCOVERY_CACHE_TTL_MS. Only the list
   * shape is cached: the assignment, allowlist and enabled state are read on every discovery,
   * and sessionFor still revalidates the credential first (a rotated or deleted credential
   * evicts the session and this entry). The version holds every field a server or credential
   * write changes (revision, secretId), so such a write misses the cache in every worker.
   */
  private async listServerTools(server: McpServer, context: AdapterContext) {
    const key = this.sessionKey(server, context);
    const version = this.discoveryVersion(server);
    const startedAt = performance.now();
    const session = await this.sessionFor(server, context);
    const cached =
      context.operationId === DISCOVERY_REFRESH_OPERATION ? undefined : this.toolCatalog.get(key);
    if (cached?.version === version && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) {
      getLogger().info("discovery.cache", {
        hit: true,
        server: server.slug,
        ms: Math.round(performance.now() - startedAt),
      });
      return cached.listed;
    }
    const generation = this.catalogGeneration;
    const listed = await session.listTools({ signal: context.signal });
    // A credential change during the list call leaves it uncached.
    if (generation === this.catalogGeneration)
      this.toolCatalog.set(key, { version, at: Date.now(), listed });
    this.discoveryFailures.delete(key);
    getLogger().info("discovery.cache", {
      hit: false,
      server: server.slug,
      ms: Math.round(performance.now() - startedAt),
    });
    return listed;
  }

  private discoveryVersion(server: McpServer): string {
    return `${server.revision} ${server.secretId ?? ""} ${server.transport} ${server.endpoint}`;
  }

  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Identity headers are applied once, at connect time, so a session is only
    // valid for the identity it connected as. The key has to carry that identity.
    return `${server.id} ${context.spaceId} ${context.userId}`;
  }

  private async evict(sessionKey: string): Promise<void> {
    this.toolCatalog.delete(sessionKey);
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    this.sessions.delete(sessionKey);
    await entry.session.close();
  }

  private async validateSecretChange(
    server: McpServer,
    context: AdapterContext,
    entry: SessionEntry,
    changed: { changeVersion?: number } = entry,
  ): Promise<number> {
    // An OAuth refresh notifies its own connection after adopting the committed
    // grant. Revalidate before reuse without closing that in-flight request.
    const changeVersion = changed.changeVersion ?? 0;
    const { ref, digest, recordId } = entry;
    context.signal.throwIfAborted();
    if (!recordId || !ref || !digest)
      throw new Error("Secret changed during MCP connection; retry");
    const secret = await this.prisma.secret.findFirst({
      where: { id: recordId, userId: context.userId, spaceId: context.spaceId },
    });
    if (secret?.ciphertext !== ref) throw new Error("Secret changed during MCP connection; retry");
    const plaintext = await this.secrets.load(ref, { recordId, signal: context.signal });
    const current = await this.prisma.mcpServer.findFirst({
      where: { id: server.id, userId: context.userId, spaceId: context.spaceId, enabled: true },
    });
    context.signal.throwIfAborted();
    if (
      !current ||
      current.revision !== server.revision ||
      current.endpoint !== server.endpoint ||
      current.transport !== server.transport ||
      current.secretId !== recordId ||
      credentialDigest(plaintext) !== digest ||
      (changed.changeVersion ?? 0) !== changeVersion
    )
      throw new Error("Secret changed during MCP connection; retry");
    return changeVersion;
  }

  private async serverUnchanged(server: McpServer, context: AdapterContext): Promise<boolean> {
    if (context.signal.aborted) return false;
    const current = await this.prisma.mcpServer.findFirst({
      where: { id: server.id, userId: context.userId, spaceId: context.spaceId, enabled: true },
    });
    return (
      current?.revision === server.revision &&
      current.endpoint === server.endpoint &&
      current.transport === server.transport &&
      current.secretId === server.secretId
    );
  }

  private async sessionFor(server: McpServer, context: AdapterContext): Promise<McpSession> {
    const sessionKey = this.sessionKey(server, context);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.revision === server.revision) {
      if (existing.ref && server.secretId) {
        try {
          const plaintext = await this.secrets.load(existing.ref, {
            recordId: existing.recordId ?? server.secretId,
            signal: context.signal,
          });
          if (credentialDigest(plaintext) !== existing.digest) await this.evict(sessionKey);
        } catch (error) {
          context.signal.throwIfAborted();
          if (!(error instanceof SecretStoreUnavailableError)) {
            // The idle session's credential was replaced or removed; reconnect below
            // from the committed record, which reports any remaining failure.
            await this.evict(sessionKey);
          } else {
            // Keep live sessions usable during a store outage. Never log the error:
            // provider errors can contain credential values or private response data.
            getLogger().warn("MCP secret revalidation failed; retaining the live session");
          }
        }
      }
      if (this.sessions.get(sessionKey) === existing) {
        try {
          if (existing.invalidated) {
            const version = await this.validateSecretChange(server, context, existing);
            if ((existing.changeVersion ?? 0) !== version)
              throw new Error("Secret changed during MCP connection; retry");
            existing.invalidated = false;
          }
        } catch (error) {
          await this.evict(sessionKey);
          // Another connection renewed this grant while the session was idle. Reconnect
          // from the committed credential only when the server itself is unchanged.
          if (await this.serverUnchanged(server, context)) return this.sessionFor(server, context);
          throw new Error(sanitizeConnectorError(error, oauthMaterialSecrets(existing.material)));
        }
        if (this.sessions.get(sessionKey) === existing) return existing.session;
      }
      return this.sessionFor(server, context);
    }
    const pending = this.connecting.get(sessionKey);
    if (pending?.revision === server.revision) return pending.promise;
    if (pending) {
      await pending.promise.catch(() => undefined);
      await this.evict(sessionKey);
      return this.sessionFor(server, context);
    }
    if (existing) await this.evict(sessionKey);

    let connected: SessionEntry | undefined;
    const promise = this.connectSession(server, context, (ref, recordId, digest) => {
      const entry = this.connecting.get(sessionKey);
      if (entry?.promise === promise) entry.ref = ref;
      const live = this.sessions.get(sessionKey);
      if (live && live === connected) {
        live.ref = ref;
        live.recordId = recordId;
        live.digest = digest;
      }
    }).then(async ({ session, material, ref, digest, recordId }) => {
      const pending = this.connecting.get(sessionKey);
      connected = {
        session,
        revision: server.revision,
        material,
        ref,
        digest,
        recordId,
      };
      try {
        if (pending?.invalidated) {
          const version = await this.validateSecretChange(server, context, connected, pending);
          if ((pending.changeVersion ?? 0) !== version)
            throw new Error("Secret changed during MCP connection; retry");
        }
      } catch (error) {
        await session.close().catch(() => undefined);
        throw new Error(sanitizeConnectorError(error, oauthMaterialSecrets(material)));
      }
      this.sessions.set(sessionKey, connected);
      return session;
    });
    this.connecting.set(sessionKey, { revision: server.revision, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(sessionKey)?.promise === promise) this.connecting.delete(sessionKey);
    }
  }

  private async connectSession(
    server: McpServer,
    context: AdapterContext,
    onRef: (ref: string, recordId: string, digest?: string) => void,
  ): Promise<{
    session: McpSession;
    material: OAuthMaterial;
    ref?: string;
    digest?: string;
    recordId?: string;
  }> {
    const session = new McpSession({ name: `rakazo-${server.slug}` });
    // Hoisted so a throw after the secret is decoded can still hand the material out.
    let material: OAuthMaterial | undefined;
    try {
      const { secret, plaintext } = await loadMcpCredentialRecord(
        this.prisma,
        this.secrets,
        server,
        context,
        onRef,
      );
      let ref = secret?.ciphertext;
      let recordId = secret?.id;
      let digest = plaintext === undefined ? undefined : credentialDigest(plaintext);
      material = plaintext === undefined ? {} : (JSON.parse(plaintext) as OAuthMaterial);
      const loaded = { material, ...(secret ? { secretId: secret.id } : {}) };
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const env = { ...(material.env ?? {}) };
      if (server.transport === "stdio") {
        if (!this.options.stdioEnabled) throw new Error("MCP stdio is disabled");
        await session.connectStdio({
          command: String(server.command ?? ""),
          args,
          env,
          allowedCommands: this.options.allowedCommands ?? [],
          signal: context.signal,
        });
      } else {
        if (!server.endpoint) throw new Error("MCP endpoint is required");
        const endpoint = new URL(server.endpoint);
        const localHttp = endpoint.protocol === "http:" && isLocalMcpHost(endpoint.hostname);
        const allowPrivateEndpoint = await actorMayUsePrivateEndpoint(
          this.prisma,
          context.userId,
          this.options.allowPrivateEndpoint === true,
        );
        const firstParty =
          !server.secretId &&
          server.transport === "streamable_http" &&
          server.endpoint === this.firstPartyEndpoint
            ? this.options.firstParty
            : undefined;
        let runtimeAuth: McpRuntimeAuth | undefined;
        if (firstParty) {
          const rejected = new WeakMap<Response, { token: string; signal?: AbortSignal }>();
          const read = async (rejectedToken?: string, signal?: AbortSignal) => {
            // Cached MCP sessions outlive a run; never retain that run's aborted signal.
            const token = await firstParty.accessToken(
              { ...context, signal: signal ?? AbortSignal.timeout(15_000) },
              rejectedToken,
            );
            material!.redact ??= [];
            if (!material!.redact.includes(token)) material!.redact.push(token);
            return token;
          };
          runtimeAuth = {
            provider: {
              token: () => read(),
              onUnauthorized: async ({ response, serverUrl }) => {
                const request = rejected.get(response);
                if (!request || serverUrl.href !== this.firstPartyEndpoint)
                  throw new Error("Your CRM sign-in is unavailable. Sign in again.");
                request.signal?.throwIfAborted();
                await read(request.token, request.signal);
              },
            },
            wrapFetch: (fetch) => async (input, init) => {
              const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
              );
              const authorization = headers.get("authorization");
              const response = await fetch(input, init);
              if (response.status === 401 && authorization?.startsWith("Bearer "))
                rejected.set(response, {
                  token: authorization.slice(7),
                  signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
                });
              return response;
            },
          };
        }
        const authProvider =
          !firstParty && !localHttp && this.oauth
            ? await this.oauth.providerFor(server, context, loaded, (record) => {
                ref = record.ref;
                recordId = record.id;
                digest = credentialDigest(JSON.stringify(record.material));
                onRef(ref, recordId, digest);
              })
            : undefined;
        const staticToken = material.secret
          ? material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`
          : undefined;
        const headers = {
          ...(material.headers ?? {}),
          ...(staticToken ? { Authorization: staticToken } : {}),
        };
        await session.connectRemote({
          url: server.endpoint,
          urlPolicy: {
            allowHttpLocalhost: localHttp,
            allowLocalHttpCredentials: localHttp,
            allowPrivateEndpoint,
          },
          transport: server.transport === "sse" ? "sse" : "streamable-http",
          allowLegacySse: server.transport === "sse",
          headerPolicy: { headers },
          fallbackToSse: false,
          authProvider,
          runtimeAuth,
          network: this.options.network,
          signal: context.signal,
        });
      }
      return { session, material, ref, digest, recordId };
    } catch (error) {
      await session.close().catch(() => undefined);
      // Redact here, while the material is still in hand. This one rejection is handed
      // to every caller waiting on the same pending connect, and none of them can see
      // the secrets: the session never reached `sessions`. Sanitizing per caller would
      // cover only whoever looked first.
      if (!material) throw error;
      throw new Error(sanitizeConnectorError(error, oauthMaterialSecrets(material)));
    }
  }
}
