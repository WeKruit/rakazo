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
import { isLocalMcpHost } from "@rakazo/contracts";
import { mcpObject } from "@rakazo/core/node/approval-effect-key";
import type { McpServer, PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import addressparser from "nodemailer/lib/addressparser";
import { z } from "zod";
import { catalogToolPrefix } from "./approval-effect.js";
import { readBoundedText } from "./connector-http.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import { appendToolCompletionAudit } from "./executor.js";
import {
  InstantlyRestError,
  instantlyRest,
  isNativeInstantlyWrite,
  nativeInstantlyWrites,
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
} from "./recruiting-research.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";

const INSTANTLY_MCP = "https://mcp.instantly.ai/mcp";
const THREAD_HISTORY = "native_instantly_get_thread_history";
const CONTACT_EMAILS = "native_instantly_search_contact_emails";
const MAILBOX_EMAILS = "native_instantly_list_mailbox_emails";
const ThreadHistoryInput = z.strictObject({
  anchor_id: z.uuid(),
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
    .describe("The other party (candidate/contact) address. Never your own Instantly mailbox."),
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
  return undefined;
}

/** Connection readiness only; never return deployment credentials to product clients. */
export function hasPlatformMcpCredential(
  server: Pick<McpServer, "secretId" | "transport" | "endpoint">,
): boolean {
  return Boolean(platformMcpCredential(server)?.key);
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
  if (platformService && !deploymentKey)
    throw new Error(`${platformService.label} is not configured on this server`);
  const plaintext = secret
    ? await secrets.load(secret.ciphertext, { recordId: secret.id, signal: context.signal })
    : deploymentKey
      ? JSON.stringify({ secret: deploymentKey })
      : undefined;
  return { secret, plaintext };
}

export class McpConnector implements ConnectorProvider {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connecting = new Map<string, PendingSession>();
  // Discovery runs more than once per run: once up front, then again on every lazy
  // catalog access. Each attempt needs its own executionId.
  private discoverySeq = 0;
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
        try {
          const session = await this.sessionFor(assignment.server, context);
          const listed = await session.listTools({ signal: context.signal });
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
          if (
            assignment.server.transport === "streamable_http" &&
            assignment.server.endpoint === INSTANTLY_MCP &&
            ["get_email", "list_emails"].every(
              (name) =>
                assignment.allowAllTools ||
                (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(name)),
            )
          ) {
            for (const local of nativeInstantlyReads) {
              if (listed.tools.some((tool) => [local.name, local.toolName].includes(tool.name))) {
                getLogger().warn(
                  `Instantly remote ${local.name} tool conflicts with the local integration; local tool withheld`,
                );
                continue;
              }
              remoteTools.push({
                name: `instantly__${assignment.server.slug}__${local.name}`,
                description: local.description,
                inputSchema: local.inputSchema,
                readOnly: true,
                route: {
                  connectorId: "mcp",
                  resourceId: assignment.serverId,
                  resourceRevision: assignment.server.revision,
                  toolName: local.toolName,
                  catalogGroup: assignment.server.slug,
                },
              });
            }
            for (const local of nativeInstantlyWrites) {
              if (listed.tools.some((tool) => tool.name === local.toolName)) continue;
              remoteTools.push({
                name: `instantly__${assignment.server.slug}__${local.name}`,
                description: local.description,
                inputSchema: local.inputSchema,
                readOnly: local.readOnly,
                route: {
                  connectorId: "mcp",
                  resourceId: assignment.serverId,
                  resourceRevision: assignment.server.revision,
                  toolName: local.toolName,
                  catalogGroup: assignment.server.slug,
                },
              });
            }
          }
          return remoteTools;
        } catch (error) {
          // A single unavailable server must not hide tools from other connectors.
          getLogger().error(
            `mcp discovery failed for server ${assignment.server.slug}:`,
            sanitizeConnectorError(error),
          );
          // Capture material before eviction so the audited reason stays redacted, the
          // same reason execute() captures it before callTool.
          const key = this.sessionKey(assignment.server, context);
          const material = this.sessions.get(key)?.material;
          await this.evict(key);
          await this.recordDiscoveryFailure(
            assignment.server.slug,
            error,
            context,
            startedAt,
            material ? oauthMaterialSecrets(material) : [],
          );
          return [];
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
      await requireAutumnTaskOwnership(
        this.prisma,
        context,
        assignment.server,
        call.route.toolName,
        call.args,
      );
      await requireFullEnrichJobOwnership(
        this.prisma,
        context,
        assignment.server,
        call.route.toolName,
        call.args,
      );
      sessionKey = this.sessionKey(assignment.server, context);
      const session = await this.sessionFor(assignment.server, context);
      material = this.sessions.get(sessionKey)?.material;
      context.signal.throwIfAborted();
      callStarted = true;
      const result = await session.callTool(call.route.toolName, call.args, {
        signal: context.signal,
      });
      const secrets = material ? oauthMaterialSecrets(material) : [];
      yield { type: "result", data: redactConnectorPayload(result, secrets) };
    } catch (error) {
      // A thrown call means the transport or auth broke; drop the session so the next call reconnects.
      const secrets = material ? oauthMaterialSecrets(material) : [];
      if (sessionKey) await this.evict(sessionKey);
      yield {
        type: "error",
        message: sanitizeConnectorError(error, secrets),
        ...(callStarted ? { outcome: "uncertain" as const } : {}),
      };
    }
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
      const result = await runInstantlyWrite(
        this.prisma,
        instantlyRest(safeFetch, credential.key, context.signal),
        context,
        credential.server.id,
        call.route!.toolName,
        call.args,
      );
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

  private async *readInstantlyEmails(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    let phase = "authorization";
    const isHistory = call.route!.toolName === THREAD_HISTORY;
    const isMailbox = call.route!.toolName === MAILBOX_EMAILS;
    const operation = isHistory ? "thread history" : isMailbox ? "mailbox email" : "contact email";
    let rejectedStatus: number | undefined;
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
      const assertAuthorized = async () => {
        const current = await authorize();
        if (current.secretId !== credential.secretId || current.digest !== credential.digest)
          throw new IsolationError();
      };
      phase = "native catalog";
      const session = await this.sessionFor(credential.server, context);
      const listed = await session.listTools({ signal: context.signal });
      const local = nativeInstantlyReads.find((tool) => tool.toolName === call.route!.toolName)!;
      if (listed.tools.some((tool) => [local.name, local.toolName].includes(tool.name)))
        throw new Error("Remote tool conflicts with the local integration; rediscover tools");
      phase = "native anchor";
      const rawAnchor = historyInput
        ? await session.callTool(
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
      const { text, truncated } = await readBoundedText(response, 1_000_000);
      if (!response.ok) {
        rejectedStatus = response.status;
        throw new Error("Email read request rejected");
      }
      if (truncated) throw new Error("Email read response exceeded its bound");
      const rawPage: unknown = JSON.parse(text);
      const page = readInstantlyEmailPage(rawPage);
      if (
        !page ||
        page.items.length > input.limit ||
        page.items.some((email) =>
          anchor
            ? email.organization_id !== anchor.organization_id ||
              email.thread_id !== anchor.thread_id ||
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
                (email.lead != null && !sameInstantlyAddresses(email.lead, contactInput!.email)) ||
                (!sameInstantlyAddresses(email.from_address_email, contactInput!.email) &&
                  !addressparser(email.to_address_email_list).some((recipient) =>
                    sameInstantlyAddresses(recipient.address, contactInput!.email),
                  )),
        )
      )
        throw new Error("Email page does not match the requested scope");
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
        message: `Instantly ${operation} read failed during ${phase}.${rejectedStatus ? ` HTTP ${rejectedStatus}.` : " Check the current assigned connection and requested scope."}${hint}`,
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

  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Identity headers are applied once, at connect time, so a session is only
    // valid for the identity it connected as. The key has to carry that identity.
    return `${server.id} ${context.spaceId} ${context.userId}`;
  }

  private async evict(sessionKey: string): Promise<void> {
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
            await this.evict(sessionKey);
            throw error;
          }
          // Keep live sessions usable during a store outage. Never log the error:
          // provider errors can contain credential values or private response data.
          getLogger().warn("MCP secret revalidation failed; retaining the live session");
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
