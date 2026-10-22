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
import type { McpServer, PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { catalogToolPrefix } from "./approval-effect.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import { appendToolCompletionAudit } from "./executor.js";
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
import { McpSession } from "./mcp-transport.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import {
  requireAutumnTaskOwnership,
  requireFullEnrichJobOwnership,
} from "./recruiting-research.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";

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
  if (
    !assignment ||
    (!assignment.allowAllTools &&
      (!Array.isArray(assignment.allowedTools) || !assignment.allowedTools.includes(toolName)))
  )
    throw new IsolationError("MCP tool is not assigned to this bot");
  if (route.resourceRevision !== assignment.server.revision)
    throw new IsolationError("MCP server changed; rediscover the tool before trying again");
  return assignment;
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
    } = {},
    private readonly oauth?: McpOAuthBroker,
  ) {
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
          return listed.tools
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
        const authProvider =
          !localHttp && this.oauth
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
