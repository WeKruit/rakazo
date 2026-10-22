import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  FetchLike,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  auth,
  Client,
  extractWWWAuthenticateParams,
  OAuthError,
  OAuthErrorCode,
  RegistrationRejectedError,
  refreshAuthorization,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { McpOAuthConfig } from "@rakazo/contracts";
import { isLocalMcpHost, McpOAuthConfigInput } from "@rakazo/contracts";
import { readBoundedResponseBytes } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { combineSignals, sanitizeConnectorError } from "./connector-safety.js";
import type { McpRuntimeAuth } from "./mcp-transport.js";
import { secureFetch, validateUrl, withEndpointOriginFallback } from "./mcp-transport.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { deferSecretChanges } from "./secret-changes.js";
import { persistPreparedSecret } from "./secret-persistence.js";

type OAuthState = {
  tokens?: StoredOAuthTokens;
  obtainedAt?: number;
  clientInformation?: StoredOAuthClientInformation;
  preRegistered?: boolean;
  scope?: string;
  authorizationParams?: Record<string, string>;
  discoveryState?: OAuthDiscoveryState;
  redirectUri?: string;
  codeVerifier?: string;
};

export type OAuthMaterial = {
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: OAuthState;
};

/** Values that must never appear in model-visible tool results or errors. */
export function oauthMaterialSecrets(material: OAuthMaterial): string[] {
  const values: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    values.push(value);
    const bearer = value.match(/^Bearer\s+(.+)$/i);
    if (bearer?.[1]) values.push(bearer[1]);
  };
  add(material.secret);
  add(material.oauth?.tokens?.access_token);
  add(material.oauth?.tokens?.refresh_token);
  const client = material.oauth?.clientInformation;
  if (client && "client_secret" in client && typeof client.client_secret === "string") {
    add(client.client_secret);
  }
  for (const [key, value] of Object.entries(material.headers ?? {})) {
    if (isAuthHeaderKey(key)) {
      // Cookie / X-Session / Authorization always carry auth material, including short values.
      add(value);
    } else if (
      isExplicitCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: true })
    ) {
      add(value);
    } else if (
      isAmbiguousCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: false })
    ) {
      add(value);
    }
  }
  for (const [key, value] of Object.entries(material.env ?? {})) {
    if (isExplicitCredentialKey(key) && looksLikeSecretValue(value, { allowNumeric: true })) {
      add(value);
    } else if (
      isAmbiguousCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: false })
    ) {
      add(value);
    }
  }
  return [...new Set(values)];
}

/** Headers whose values are credentials even when short (e.g. Cookie, X-Session). */
function isAuthHeaderKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized === "x_session" ||
    normalized === "x_api_key" ||
    normalized === "api_key" ||
    normalized === "x_auth_token"
  );
}

/** Explicit credential keys (access_token, api_key, …); numeric values stay redacted. */
function isExplicitCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (isAuthHeaderKey(key)) return true;
  return /(?:^|_)(secret|password|credential|access_token|refresh_token|id_token|auth_token|session_token|session_id|session_key|session_secret|api_key|api_token)$/.test(
    normalized,
  );
}

/** Ambiguous *_token keys where numeric-only values are usually config, not secrets. */
function isAmbiguousCredentialKey(key: string): boolean {
  if (isExplicitCredentialKey(key)) return false;
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (/(?:^|_)token$/.test(normalized)) {
    return !/(timeout|ttl|max|count|type|mode|name)$/.test(normalized);
  }
  return false;
}

/**
 * Values under credential-shaped keys must look like secrets before entering
 * global substring redaction. Ordinary enums such as "production" or "oauth"
 * would otherwise corrupt unrelated tool output. Numeric-only filtering applies
 * only to ambiguous keys — explicit carriers still register OTP-like tokens.
 */
function looksLikeSecretValue(value: string, options: { allowNumeric?: boolean } = {}): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (COMMON_CONFIG_VALUES.has(trimmed.toLowerCase())) return false;
  if (!options.allowNumeric && /^\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

const COMMON_CONFIG_VALUES = new Set([
  "production",
  "development",
  "staging",
  "test",
  "testing",
  "oauth",
  "openid",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "none",
  "null",
  "debug",
  "info",
  "warn",
  "error",
  "http",
  "https",
  "local",
  "localhost",
  "enabled",
  "disabled",
  "default",
  "auto",
  "manual",
  "read",
  "write",
  "sync",
  "async",
]);

type ServerRef = {
  id: string;
  endpoint: string | null;
  secretId: string | null;
  revision: number;
};
type ActorRef = { spaceId: string; userId: string };

export class McpReauthorizationRequiredError extends Error {
  readonly code = "MCP_REAUTHORIZATION_REQUIRED";
  constructor(readonly serverId: string) {
    super("MCP authorization expired. Reconnect this server in MCP settings.");
    this.name = "McpReauthorizationRequiredError";
  }
}

type ProviderOptions = {
  /** Stage interactive state until tokens and the new generation can be published together. */
  interactive?: boolean;
  redirectUri?: string;
  state?: string;
  onAuthorization?: (url: URL) => void;
  onPersisted?: (record: { id: string; ref: string; material: OAuthMaterial }) => void;
  /** Network for renewing an expired access token through its stored refresh token. */
  refreshNetwork?: () => Promise<{ fetch: typeof fetch; close: () => Promise<void> }>;
  refresh?: (rejected?: RejectedMcpRequest) => Promise<void>;
  generation?: () => string | undefined;
};

type RejectedMcpRequest = {
  bearer: string | null;
  generation?: string;
  response: Response;
  signal?: AbortSignal;
};

/** Refresh before expiry to cover clock skew and request time. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** One SDK OAuth provider backed by the same encrypted material used at runtime. */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private readonly runtimeState = randomUUID();
  private persistQueue = Promise.resolve();
  private refreshing?: Promise<void>;
  private readonly rejectedRequests = new WeakMap<Response, RejectedMcpRequest>();

  readonly runtimeAuth: McpRuntimeAuth = {
    provider: {
      token: async () => (await this.tokens())?.access_token,
      onUnauthorized: async (context) => {
        const rejected = this.rejectedRequests.get(context.response);
        if (!rejected) throw new McpReauthorizationRequiredError(this.serverId);
        const fetchFn: FetchLike = async (input, init) => {
          try {
            const response = await context.fetchFn(input, init);
            if (response.ok) return response;
            const rejection = await readOAuthRejection(response);
            return rejection
              ? redactOAuthRejectionResponse(
                  response,
                  rejection,
                  oauthMaterialSecrets(this.material),
                )
              : opaqueOAuthFailure(response);
          } catch (error) {
            const message = sanitizeConnectorError(error, oauthMaterialSecrets(this.material));
            if (error instanceof Error && error.message === message) throw error;
            throw new Error(message);
          }
        };
        if (this.options.refresh) {
          try {
            await this.options.refresh(rejected);
          } catch (error) {
            if (!this.options.onAuthorization || this.material.oauth?.tokens) throw error;
          }
        } else {
          const challenge = extractWWWAuthenticateParams(context.response);
          await auth(this, {
            serverUrl: context.serverUrl,
            fetchFn,
            resourceMetadataUrl: challenge.resourceMetadataUrl,
            scope: challenge.scope,
          });
          return;
        }
        if (!this.material.oauth?.tokens) {
          if (!this.options.onAuthorization)
            throw new McpReauthorizationRequiredError(this.serverId);
          await auth(this, { serverUrl: context.serverUrl, fetchFn });
        }
      },
    },
    wrapFetch: (fetch) => async (input, init) => {
      const observed = {
        bearer: new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        ).get("authorization"),
        generation: this.options.generation?.(),
        signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      };
      const response = await fetch(input, init);
      if (response.status === 401) this.rejectedRequests.set(response, { ...observed, response });
      return response;
    },
  };

  constructor(
    readonly serverId: string,
    private readonly material: OAuthMaterial,
    private readonly persistMaterial: (material: OAuthMaterial) => Promise<void>,
    private readonly options: ProviderOptions = {},
  ) {
    if (options.redirectUri) {
      this.material.oauth = { ...(this.material.oauth ?? {}), redirectUri: options.redirectUri };
    }
  }

  get redirectUrl(): string | undefined {
    return this.options.redirectUri ?? this.material.oauth?.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl;
    if (!redirectUri) throw new McpReauthorizationRequiredError(this.serverId);
    const hostname = new URL(redirectUri).hostname;
    const applicationType = hostname === "localhost" || hostname === "127.0.0.1" ? "native" : "web";
    return {
      redirect_uris: [redirectUri],
      client_name: "Rakazo",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: applicationType,
      ...(this.material.oauth?.scope ? { scope: this.material.oauth.scope } : {}),
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.options.state ?? this.runtimeState;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.material.oauth?.clientInformation;
  }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.oauth().clientInformation = value;
    await this.persist();
  }
  /**
   * Some providers return a JSON-RPC error with HTTP 200 after access-token
   * expiry, so the SDK's 401-driven refresh does not run. Renew from the stored
   * expiry before returning a token that has lapsed.
   */
  async tokens(): Promise<StoredOAuthTokens | undefined> {
    if (this.options.refreshNetwork && this.accessTokenExpired()) {
      this.refreshing ??= (
        this.options.refresh ? this.options.refresh() : this.refreshExpiredToken()
      ).finally(() => {
        this.refreshing = undefined;
      });
      await this.refreshing;
    }
    return this.material.oauth?.tokens;
  }

  private accessTokenExpired(): boolean {
    const oauth = this.material.oauth;
    const lifetimeSeconds = oauth?.tokens?.expires_in;
    if (!oauth?.tokens?.refresh_token || !oauth.obtainedAt || !lifetimeSeconds) return false;
    return Date.now() >= oauth.obtainedAt + lifetimeSeconds * 1000 - TOKEN_REFRESH_SKEW_MS;
  }

  private async refreshExpiredToken(): Promise<void> {
    const oauth = this.material.oauth;
    const refreshToken = oauth?.tokens?.refresh_token;
    const discovery = oauth?.discoveryState;
    const clientInformation = oauth?.clientInformation;
    if (!refreshToken || !discovery?.authorizationServerUrl || !clientInformation) return;
    let network: { fetch: typeof fetch; close: () => Promise<void> } | undefined;
    try {
      network = await this.options.refreshNetwork?.();
      if (!network) return;
      const resource = await this.validateResourceURL(
        discovery.authorizationServerUrl,
        discovery.resourceMetadata?.resource,
      );
      const next = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation,
        refreshToken,
        resource,
        fetchFn: network.fetch,
      });
      await this.saveTokens(next);
    } catch (error) {
      if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant) {
        // A revoked refresh token cannot recover through a second SDK attempt.
        // Clear only the grant so the existing authorization path requests reconnect.
        await this.invalidateCredentials("tokens");
      }
      // Transient setup or transport failures must not discard a usable token.
    } finally {
      await network?.close().catch(() => undefined);
    }
  }

  async saveTokens(value: StoredOAuthTokens): Promise<void> {
    const oauth = this.oauth();
    oauth.tokens = value;
    oauth.obtainedAt = Date.now();
    await this.persist();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    let authorizationUrl: URL;
    try {
      authorizationUrl = validateUrl(url, { allowHttpLocalhost: true });
      if (this.material.oauth?.scope)
        authorizationUrl.searchParams.set("scope", this.material.oauth.scope);
      for (const [key, value] of Object.entries(this.material.oauth?.authorizationParams ?? {})) {
        authorizationUrl.searchParams.set(key, value);
      }
      const client = this.material.oauth?.clientInformation;
      const secret = client && "client_secret" in client ? client.client_secret : undefined;
      if (
        secret &&
        (authorizationUrl.href.includes(secret) ||
          authorizationUrl.href.includes(encodeURIComponent(secret)) ||
          [...authorizationUrl.searchParams.values()].some((value) => value.includes(secret)))
      ) {
        throw new Error("OAuth authorization URL contains a credential");
      }
    } catch (error) {
      if (!this.options.onAuthorization) {
        await this.invalidateCredentials("tokens");
      }
      throw error;
    }
    this.authorizationUrl = authorizationUrl;
    if (this.options.onAuthorization) {
      this.options.onAuthorization(authorizationUrl);
      return;
    }
    // Runtime re-auth needs the user; drop the dead tokens so status reads "reconnect".
    await this.invalidateCredentials("tokens");
    throw new McpReauthorizationRequiredError(this.serverId);
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.oauth().codeVerifier = value;
    await this.persist();
  }
  codeVerifier(): string {
    const verifier = this.material.oauth?.codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing");
    return verifier;
  }
  // RFC 8707 resource binding: only accept a self-declared canonical resource
  // that is itself a well-formed HTTPS (or localhost) URL. Providers like Brex
  // advertise an internal alias for their public origin, so cross-host
  // resources are allowed, but malformed or cleartext resources are rejected
  // and the SDK falls back to deriving the resource from the server URL.
  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined;
    try {
      return validateUrl(resource);
    } catch {
      return undefined;
    }
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.oauth().discoveryState = value;
    await this.persist();
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.material.oauth?.discoveryState;
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      const redirectUri = this.redirectUrl;
      const previous = this.material.oauth;
      this.material.oauth = previous?.preRegistered
        ? {
            redirectUri,
            preRegistered: true,
            clientInformation: previous.clientInformation,
            scope: previous.scope,
            authorizationParams: previous.authorizationParams,
          }
        : redirectUri
          ? { redirectUri }
          : undefined;
    } else if (this.material.oauth) {
      if (scope === "client" && !this.material.oauth.preRegistered)
        delete this.material.oauth.clientInformation;
      if (scope === "tokens") {
        delete this.material.oauth.tokens;
        delete this.material.oauth.obtainedAt;
      }
      if (scope === "verifier") delete this.material.oauth.codeVerifier;
      if (scope === "discovery") delete this.material.oauth.discoveryState;
    }
    await this.persist();
  }

  private oauth(): OAuthState {
    if (!this.material.oauth) this.material.oauth = {};
    return this.material.oauth;
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.material);
    const next = this.persistQueue.then(() => this.persistMaterial(snapshot));
    this.persistQueue = next.catch(() => undefined);
    await next;
  }
}

type Pending = {
  serverId: string;
  spaceId: string;
  userId: string;
  endpoint: string;
  revision: number;
  material: OAuthMaterial;
  provider: StoredMcpOAuthProvider;
  createdAt: number;
  expiry?: ReturnType<typeof setTimeout>;
};

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_SESSIONS = 100;

/** OAuth traffic runs through the same URL policy as runtime MCP requests
 * (HTTPS enforced, redirects rejected), with the endpoint-origin fallback
 * layered on top for providers like Brex. */
function oauthFetch(
  endpoint: string,
  network: RemoteTransportDependencies,
  material: OAuthMaterial = {},
  allowPrivateEndpoint = false,
  redactionSecrets: string[] = [],
): {
  fetch: typeof fetch;
  close: () => Promise<void>;
  headers: Record<string, string>;
  publicError: (error: unknown, message: string) => Error;
} {
  const url = new URL(endpoint);
  const localHttp = url.protocol === "http:" && isLocalMcpHost(url.hostname);
  const headers = {
    ...material.headers,
    ...(material.secret
      ? {
          Authorization: material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`,
        }
      : {}),
  };
  const safeFetch = secureFetch(
    url,
    {
      allowHttpLocalhost: localHttp,
      allowLocalHttpCredentials: localHttp,
      allowPrivateEndpoint,
    },
    { headers },
    network,
  );
  const fallbackFetch = withEndpointOriginFallback(url.origin, safeFetch);
  // Errors raised by this network layer (URL policy, redirects, unreachable
  // hosts) carry only our own text. Anything else was built by the SDK from an
  // upstream response and may quote its body, so the caller gets `message`.
  // A structured OAuth error is the protocol's own failure: keep its status,
  // error code, and description instead of hiding them behind `message`.
  const networkErrors = new WeakSet<Error>();
  let rejection: OAuthRejection | undefined;
  const recordingFetch: typeof fetch = async (input, init) => {
    try {
      const response = await fallbackFetch(input, init);
      if (!response.ok) {
        const next = await readOAuthRejection(response);
        if (next) {
          rejection = next;
          // Native OAuth recovery logs error descriptions before returning to our redactor.
          return redactOAuthRejectionResponse(response, next, [
            ...oauthMaterialSecrets(material),
            ...redactionSecrets,
          ]);
        }
        return opaqueOAuthFailure(response);
      }
      return response;
    } catch (error) {
      if (error instanceof Error) networkErrors.add(error);
      throw error;
    }
  };
  return {
    headers,
    fetch: recordingFetch,
    close: () => safeFetch.close(),
    publicError: (error, message) => {
      if (error instanceof Error && networkErrors.has(error)) return error;
      const secrets = [...oauthMaterialSecrets(material), ...redactionSecrets];
      const sdk = sanitizeConnectorError(error, secrets);
      const surfaced = rejection ? formatOAuthRejection(rejection, sdk, secrets, error) : undefined;
      getLogger().warn(`${message}: ${surfaced ?? sdk}`);
      return new Error(surfaced ? `${message}: ${surfaced}` : message);
    },
  };
}

type OAuthRejection = { status: number; code: string; description: string };

function opaqueOAuthFailure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(null, { status: response.status, statusText: response.statusText, headers });
}

function redactOAuthRejectionResponse(
  response: Response,
  rejection: OAuthRejection,
  secrets: string[],
): Response {
  const description = sanitizeConnectorError(rejection.description, secrets);
  const code = sanitizeConnectorError(rejection.code, secrets);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const OAUTH_ERROR_BODY_MAX_CHARS = 8_000;
// A JavaScript character is at most 3 UTF-8 bytes, so a longer body cannot pass the character cap.
const OAUTH_ERROR_BODY_MAX_BYTES = OAUTH_ERROR_BODY_MAX_CHARS * 3;

/** Read an RFC 6749 error object without consuming the body the SDK still needs. */
async function readOAuthRejection(response: Response): Promise<OAuthRejection | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_ERROR_BODY_MAX_BYTES) {
    return undefined;
  }
  let text: string;
  try {
    const bytes = await readBoundedResponseBytes(response.clone(), {
      maxBytes: OAUTH_ERROR_BODY_MAX_BYTES,
      tooLargeMessage: "OAuth error response is too large",
      read: (operation) => operation(),
    });
    text = new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  if (text.length > OAUTH_ERROR_BODY_MAX_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const code = record.error;
  if (typeof code !== "string" || !/^[\w.-]{1,64}$/.test(code)) return undefined;
  const description = typeof record.error_description === "string" ? record.error_description : "";
  return { status: response.status, code, description };
}

/** Surface a rejection only when it is the error the SDK just threw.
 *
 * Earlier challenges (a 401 while discovery continues) must not replace a
 * later, different failure. The SDK message is already redacted and
 * length-limited, so the description is cleaned the same way before comparing.
 * Unstructured bodies stay out of the caller-facing message; the log still
 * receives the SDK text. */
function formatOAuthRejection(
  rejection: OAuthRejection,
  sdk: string,
  secrets: string[],
  error: unknown,
): string | undefined {
  if (sdk.includes("Raw body:")) return undefined;
  // Redact the whole description first. A later cut can land inside a secret, and
  // the redactor only matches the complete value.
  const cleaned = sanitizeConnectorError(rejection.description, secrets);
  if (error instanceof RegistrationRejectedError) {
    let body: { error?: unknown; error_description?: unknown };
    try {
      body = JSON.parse(error.body);
    } catch {
      return undefined;
    }
    if (
      error.status !== rejection.status ||
      body.error !== rejection.code ||
      sanitizeConnectorError(
        typeof body.error_description === "string" ? body.error_description : "",
        secrets,
      ).trim() !== cleaned.trim()
    )
      return undefined;
  } else if (cleaned.trim() !== sdk.trim()) return undefined;
  const description = cleaned.replace(/\s+/g, " ").trim().slice(0, 300);
  const detail = description ? `${rejection.code}: ${description}` : rejection.code;
  return sanitizeConnectorError(`HTTP ${rejection.status} ${detail}`, secrets);
}

export class McpOAuthBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly network: RemoteTransportDependencies = {},
    private readonly allowPrivateEndpoint = false,
  ) {}

  async statusFor(
    server: ServerRef,
    context: ActorRef,
  ): Promise<"none" | "connected" | "reconnect"> {
    const { material } = await this.loadMaterial(server, context);
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  async statusForCiphertext(
    ciphertext: string | undefined,
    recordId: string | undefined,
  ): Promise<"none" | "connected" | "reconnect"> {
    const material = ciphertext && recordId ? await this.read(ciphertext, recordId) : {};
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  async providerFor(
    server: ServerRef,
    context: ActorRef,
    loaded?: { material: OAuthMaterial; secretId?: string },
    onPersisted?: ProviderOptions["onPersisted"],
  ): Promise<StoredMcpOAuthProvider | undefined> {
    const material = loaded ?? (await this.loadMaterial(server, context));
    if (!material.material.oauth) return undefined;
    return this.createProvider(server, context, material, { onPersisted });
  }

  async begin(input: {
    serverId: string;
    spaceId: string;
    userId: string;
    redirectUri: string;
    oauth?: McpOAuthConfig;
  }): Promise<
    | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
    | { status: "already_connected" | "authorization_not_requested" }
  > {
    const server = await this.prisma.mcpServer.findFirst({
      where: {
        id: input.serverId,
        spaceId: input.spaceId,
        userId: input.userId,
        enabled: true,
      },
    });
    if (!server?.endpoint) throw new Error("MCP server endpoint is required for OAuth");
    await this.sweepExpiredPending();
    let actorPending = 0;
    for (const pending of this.pending.values()) {
      if (pending.spaceId === input.spaceId && pending.userId === input.userId) {
        actorPending += 1;
      }
    }
    if (actorPending >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const activeCount = await this.prisma.mcpOAuthSession.count({
      where: { spaceId: input.spaceId, userId: input.userId },
    });
    if (activeCount >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const sessionId = randomUUID();
    const context = { spaceId: input.spaceId, userId: input.userId };
    const loaded = await this.loadMaterial(server, context);
    if (input.oauth) {
      const config = McpOAuthConfigInput.parse(input.oauth);
      const previous = loaded.material.oauth ?? {};
      const sameClient = previous.clientInformation?.client_id === config.clientId;
      const clientInformation = {
        ...(sameClient ? previous.clientInformation : {}),
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      };
      if (config.clientSecret && "token_endpoint_auth_method" in clientInformation)
        delete clientInformation.token_endpoint_auth_method;
      const configured = {
        ...previous,
        preRegistered: true,
        clientInformation,
        scope: config.scopes?.join(" ") ?? (sameClient ? previous.scope : undefined),
        authorizationParams:
          config.authorizationParams ?? (sameClient ? previous.authorizationParams : undefined),
      };
      if (
        !isDeepStrictEqual(previous.clientInformation, configured.clientInformation) ||
        previous.scope !== configured.scope ||
        !isDeepStrictEqual(previous.authorizationParams, configured.authorizationParams)
      ) {
        // Stage a new grant without changing the working connection until success.
        delete configured.tokens;
        delete configured.obtainedAt;
        delete configured.codeVerifier;
      }
      loaded.material.oauth = configured;
    }
    let authorizationUrl: URL | undefined;
    const provider = this.createProvider(server, context, loaded, {
      interactive: true,
      redirectUri: input.redirectUri,
      state: sessionId,
      onAuthorization: (url) => {
        authorizationUrl = url;
      },
    });
    const initialOAuth = structuredClone(loaded.material.oauth);
    const initialSecretId = loaded.secretId;
    // Never destroy working tokens here: if this attempt fails (network error,
    // cancelled popup), the server keeps its valid connection. The SDK itself
    // invalidates dead tokens when a refresh is rejected with invalid_grant.
    const endpoint = new URL(server.endpoint);
    const networkFetch = oauthFetch(
      server.endpoint,
      this.network,
      loaded.material,
      await actorMayUsePrivateEndpoint(this.prisma, input.userId, this.allowPrivateEndpoint),
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: networkFetch.headers },
      authProvider: provider.runtimeAuth.provider,
      fetch: provider.runtimeAuth.wrapFetch(networkFetch.fetch),
      onInsufficientScope: "throw",
    });
    const client = new Client(
      { name: "rakazo-oauth", version: "0.1.0" },
      { enforceStrictCapabilities: true },
    );
    const signal = AbortSignal.timeout(15_000);
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
      // Initialization may be public even when tools require the configured OAuth client.
      if (!authorizationUrl && provider.clientInformation() && !(await provider.tokens()))
        await auth(provider, {
          serverUrl: endpoint,
          fetchFn: (input, init) =>
            networkFetch.fetch(input, {
              ...init,
              signal: combineSignals(
                signal,
                input instanceof Request ? input.signal : undefined,
                init?.signal ?? undefined,
              ),
            }),
        });
    } catch (error) {
      if (!authorizationUrl) throw networkFetch.publicError(error, "Could not start MCP OAuth");
    } finally {
      await client.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!authorizationUrl) {
      if (await provider.tokens()) {
        if (
          loaded.secretId === initialSecretId &&
          !isDeepStrictEqual(initialOAuth, loaded.material.oauth)
        )
          await this.replaceMaterial(
            server.id,
            loaded.material,
            context,
            false,
            server.revision,
            server.endpoint,
          );
        return { status: "already_connected" };
      }
      return { status: "authorization_not_requested" };
    }
    const sessionMaterial = await this.secrets.put(
      JSON.stringify({ ...loaded.material, authorizationRevision: server.revision }),
      {
        operationId: "mcp.oauth.session",
        traceId: "mcp.oauth.session",
        spaceId: input.spaceId,
        userId: input.userId,
        botId: "mcp",
        signal: new AbortController().signal,
      },
      { recordId: sessionId, ephemeral: true },
    );
    await this.prisma.mcpOAuthSession.create({
      data: {
        id: sessionId,
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: server.endpoint,
        redirectUri: input.redirectUri,
        oauthCiphertext: sessionMaterial.ciphertext,
      },
    });
    const expiry = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.prisma.mcpOAuthSession
        .deleteMany({ where: { id: sessionId } })
        .catch(() => undefined);
    }, PENDING_TTL_MS);
    expiry.unref?.();
    this.pending.set(sessionId, {
      serverId: server.id,
      spaceId: input.spaceId,
      userId: input.userId,
      endpoint: server.endpoint,
      revision: server.revision,
      material: loaded.material,
      provider,
      createdAt: Date.now(),
      expiry,
    });
    return {
      status: "authorization_required",
      sessionId,
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async complete(input: {
    sessionId: string;
    code: string;
    state: string;
    iss?: string;
    spaceId: string;
    userId: string;
  }): Promise<void> {
    await this.sweepExpiredPending();
    if (input.state !== input.sessionId) {
      throw new Error("MCP OAuth session is invalid or expired");
    }
    let pending = this.pending.get(input.sessionId);
    if (pending && (pending.spaceId !== input.spaceId || pending.userId !== input.userId)) {
      pending = undefined;
    }
    if (!pending) {
      const session = await this.prisma.mcpOAuthSession.findFirst({
        where: {
          id: input.sessionId,
          spaceId: input.spaceId,
          userId: input.userId,
          createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) },
        },
      });
      if (!session) throw new Error("MCP OAuth session is invalid or expired");
      const server = await this.prisma.mcpServer.findFirst({
        where: {
          id: session.serverId,
          spaceId: input.spaceId,
          userId: input.userId,
          enabled: true,
        },
      });
      if (!server?.endpoint) throw new Error("MCP OAuth session is invalid or expired");
      const context = { spaceId: input.spaceId, userId: input.userId };
      const material = (await this.read(session.oauthCiphertext, session.id)) as OAuthMaterial & {
        authorizationRevision?: unknown;
      };
      if (
        typeof material.authorizationRevision !== "number" ||
        !Number.isSafeInteger(material.authorizationRevision) ||
        material.authorizationRevision !== server.revision
      )
        throw new Error("MCP OAuth session is invalid or expired");
      delete material.authorizationRevision;
      const loaded = {
        material,
        ...(server.secretId ? { secretId: server.secretId } : {}),
      };
      pending = {
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: session.endpoint,
        revision: server.revision,
        material,
        provider: this.createProvider(server, context, loaded, {
          interactive: true,
          redirectUri: session.redirectUri,
          state: session.id,
        }),
        createdAt: session.createdAt.getTime(),
        expiry: undefined,
      };
    }
    // Consume the session up front so a failed token exchange cannot be
    // retried with a replayed code; the user starts a fresh flow instead.
    this.pending.delete(input.sessionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    const consumed = await this.prisma.mcpOAuthSession.deleteMany({
      where: {
        id: input.sessionId,
        spaceId: input.spaceId,
        userId: input.userId,
      },
    });
    if (consumed.count !== 1) throw new Error("MCP OAuth session is invalid or expired");
    const endpoint = new URL(pending.endpoint);
    const networkFetch = oauthFetch(
      pending.endpoint,
      this.network,
      {},
      await actorMayUsePrivateEndpoint(this.prisma, pending.userId, this.allowPrivateEndpoint),
      oauthMaterialSecrets(pending.material),
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: pending.provider,
      fetch: networkFetch.fetch,
    });
    try {
      await transport.finishAuth(input.code, input.iss);
    } catch (error) {
      throw networkFetch.publicError(error, "Could not complete MCP OAuth");
    } finally {
      await transport.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!(await pending.provider.tokens())) throw new Error("MCP OAuth authorization failed");
    await this.replaceMaterial(
      pending.serverId,
      pending.material,
      input,
      true,
      pending.revision,
      pending.endpoint,
    );
  }

  private async sweepExpiredPending(): Promise<void> {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sessionId, pending] of this.pending) {
      if (pending.createdAt < cutoff) {
        this.discardPending(sessionId, pending);
      }
    }
    await this.prisma.mcpOAuthSession.deleteMany({
      where: { createdAt: { lt: new Date(cutoff) } },
    });
  }

  private discardPending(sessionId: string, pending: Pending): void {
    if (pending.expiry) clearTimeout(pending.expiry);
    this.pending.delete(sessionId);
  }

  async disconnect(input: { serverId: string; spaceId: string; userId: string }): Promise<void> {
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: input.serverId, spaceId: input.spaceId, userId: input.userId },
    });
    if (!server?.secretId) return;
    const row = await this.prisma.secret.findFirst({
      where: { id: server.secretId, spaceId: input.spaceId, userId: input.userId },
    });
    if (!row) return;
    const material = await this.read(row.ciphertext, row.id);
    delete material.oauth;
    await this.replaceMaterial(server.id, material, input, true, server.revision, server.endpoint);
  }

  private async loadMaterial(
    server: ServerRef,
    context: ActorRef,
  ): Promise<{ material: OAuthMaterial; secretId?: string }> {
    if (!server.secretId) return { material: {} };
    const row = await this.prisma.secret.findFirst({
      where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
    });
    return row
      ? { material: await this.read(row.ciphertext, row.id), secretId: row.id }
      : { material: {} };
  }

  private createProvider(
    server: ServerRef,
    context: ActorRef,
    loaded: { material: OAuthMaterial; secretId?: string },
    options: ProviderOptions = {},
  ): StoredMcpOAuthProvider {
    const { id, endpoint, revision } = server;
    const provider = new StoredMcpOAuthProvider(
      id,
      loaded.material,
      async (material) => {
        if (options.interactive) return;
        await this.replaceMaterial(
          id,
          material,
          context,
          false,
          revision,
          endpoint,
          options.onPersisted,
        );
      },
      {
        ...(endpoint
          ? {
              refreshNetwork: async () =>
                oauthFetch(
                  endpoint,
                  this.network,
                  {},
                  await actorMayUsePrivateEndpoint(
                    this.prisma,
                    context.userId,
                    this.allowPrivateEndpoint,
                  ),
                ),
            }
          : {}),
        ...options,
        generation: () => loaded.secretId,
        ...(!options.interactive || loaded.material.oauth?.tokens
          ? {
              refresh: async (rejected?: RejectedMcpRequest) => {
                if (!endpoint) throw new McpReauthorizationRequiredError(id);
                // Prepare policy before checking out the single transaction connection.
                const allowPrivateEndpoint = await actorMayUsePrivateEndpoint(
                  this.prisma,
                  context.userId,
                  this.allowPrivateEndpoint,
                );
                let network: ReturnType<typeof oauthFetch> | undefined;
                try {
                  const observed = await deferSecretChanges(async () => {
                    const next = await this.prisma.$transaction(
                      async (tx) => {
                        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
                        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${id}))`;
                        await tx.$queryRaw`SELECT id FROM mcp_servers WHERE id = ${id} AND "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} FOR UPDATE`;
                        const current = await tx.mcpServer.findFirst({
                          where: {
                            id,
                            spaceId: context.spaceId,
                            userId: context.userId,
                            enabled: true,
                          },
                        });
                        if (
                          !current ||
                          current.revision !== revision ||
                          current.endpoint !== endpoint ||
                          !current.secretId
                        )
                          throw new McpReauthorizationRequiredError(id);
                        await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${current.secretId} FOR UPDATE`;
                        const secret = await tx.secret.findFirst({
                          where: {
                            id: current.secretId,
                            userId: context.userId,
                            spaceId: context.spaceId,
                            kind: "mcp",
                          },
                        });
                        if (!secret) throw new McpReauthorizationRequiredError(id);
                        const material = await this.read(secret.ciphertext, secret.id);
                        network = oauthFetch(
                          endpoint,
                          this.network,
                          {},
                          allowPrivateEndpoint,
                          oauthMaterialSecrets(material),
                        );
                        const token = material.oauth?.tokens;
                        const expiry =
                          material.oauth?.obtainedAt && token?.expires_in
                            ? material.oauth.obtainedAt +
                              token.expires_in * 1000 -
                              TOKEN_REFRESH_SKEW_MS
                            : Infinity;
                        const superseded =
                          rejected &&
                          (rejected.generation !== current.secretId ||
                            rejected.bearer !== (token ? `Bearer ${token.access_token}` : null));
                        if (!token || (Date.now() < expiry && (!rejected || superseded)))
                          return { material, secretId: secret.id, ref: secret.ciphertext };
                        const stagedMaterial = structuredClone(material);
                        const staged = new StoredMcpOAuthProvider(
                          id,
                          stagedMaterial,
                          async () => undefined,
                          { redirectUri: options.redirectUri, onAuthorization: () => undefined },
                        );
                        const signal = combineSignals(
                          rejected?.signal,
                          AbortSignal.timeout(15_000),
                        );
                        let error: unknown;
                        try {
                          const fetchFn: FetchLike = async (input, init) => {
                            try {
                              return await network!.fetch(input, {
                                ...init,
                                signal: combineSignals(signal, init?.signal ?? undefined),
                              });
                            } catch (failure) {
                              throw new Error(
                                sanitizeConnectorError(failure, oauthMaterialSecrets(material)),
                              );
                            }
                          };
                          const challenge = rejected
                            ? extractWWWAuthenticateParams(rejected.response)
                            : undefined;
                          const outcome = await auth(staged, {
                            serverUrl: endpoint,
                            resourceMetadataUrl: challenge?.resourceMetadataUrl,
                            scope: challenge?.scope,
                            fetchFn,
                          });
                          if (outcome !== "AUTHORIZED")
                            throw new McpReauthorizationRequiredError(id);
                        } catch (failure) {
                          if (
                            failure instanceof OAuthError &&
                            failure.code === OAuthErrorCode.InvalidGrant
                          )
                            await staged.invalidateCredentials("tokens");
                          // A terminal native invalidation commits; transient errors preserve the grant.
                          if (stagedMaterial.oauth?.tokens || !material.oauth?.tokens)
                            throw network.publicError(failure, "Could not refresh MCP OAuth");
                          error = new McpReauthorizationRequiredError(id);
                        }
                        if (isDeepStrictEqual(material, stagedMaterial))
                          return { material, secretId: secret.id, ref: secret.ciphertext, error };
                        // Finish a successful rotation even if its originating resource request was canceled.
                        const stored = await this.secrets.put(JSON.stringify(stagedMaterial), {
                          operationId: "mcp.oauth.persist",
                          traceId: "mcp.oauth.persist",
                          userId: context.userId,
                          spaceId: context.spaceId,
                          botId: "mcp",
                          signal: new AbortController().signal,
                        });
                        await tx.secret.create({
                          data: {
                            id: stored.id,
                            ciphertext: stored.ciphertext,
                            userId: context.userId,
                            spaceId: context.spaceId,
                            kind: "mcp",
                          },
                        });
                        await tx.mcpServer.update({ where: { id }, data: { secretId: stored.id } });
                        await tx.secret.deleteMany({ where: { id: secret.id } });
                        return {
                          material: stagedMaterial,
                          secretId: stored.id,
                          ref: stored.ciphertext,
                          error,
                        };
                      },
                      { timeout: 40_000, maxWait: 5_000 },
                    );
                    // Adopt only after commit, before deferred invalidations notify this live session.
                    for (const key of Object.keys(loaded.material))
                      delete loaded.material[key as keyof OAuthMaterial];
                    Object.assign(loaded.material, next.material);
                    loaded.secretId = next.secretId;
                    options.onPersisted?.({
                      id: next.secretId,
                      ref: next.ref,
                      material: next.material,
                    });
                    return next;
                  });
                  if (observed.error) throw observed.error;
                } finally {
                  await network?.close().catch(() => undefined);
                }
              },
            }
          : {}),
      },
    );
    return provider;
  }

  private async replaceMaterial(
    serverId: string,
    material: OAuthMaterial,
    context: ActorRef,
    incrementRevision: boolean,
    expectedRevision: number,
    expectedEndpoint?: string | null,
    onPersisted?: ProviderOptions["onPersisted"],
  ): Promise<string | undefined> {
    // Take a DB-only snapshot, then do provider I/O with no transaction open.
    // Recheck both the pointer and ciphertext under the existing advisory lock.
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.prisma.$transaction(async (tx) => {
        const server = await tx.mcpServer.findFirst({
          where: { id: serverId, spaceId: context.spaceId, userId: context.userId },
          select: { endpoint: true, secretId: true, revision: true },
        });
        if (!server) throw new Error("MCP server is unavailable");
        if (expectedEndpoint !== undefined && server.endpoint !== expectedEndpoint)
          throw new Error(
            "MCP server endpoint changed during authorization; reconnect this server",
          );
        if (server.revision !== expectedRevision)
          throw new Error("MCP server changed during authorization; reconnect this server");
        const secret = server.secretId
          ? await tx.secret.findFirst({
              where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
            })
          : null;
        return { server, secret };
      });
      const nextMaterial = snapshot.secret
        ? await this.read(snapshot.secret.ciphertext, snapshot.secret.id)
        : {};
      if (material.oauth) nextMaterial.oauth = structuredClone(material.oauth);
      else delete nextMaterial.oauth;
      const hasMaterial = Boolean(
        nextMaterial.secret ||
          Object.keys(nextMaterial.env ?? {}).length ||
          Object.keys(nextMaterial.headers ?? {}).length ||
          nextMaterial.oauth,
      );
      const stored = hasMaterial
        ? await this.secrets.put(JSON.stringify(nextMaterial), {
            operationId: "mcp.oauth.persist",
            traceId: "mcp.oauth.persist",
            spaceId: context.spaceId,
            userId: context.userId,
            botId: "mcp",
            signal: new AbortController().signal,
          })
        : undefined;
      const committed = await persistPreparedSecret(
        this.prisma,
        this.secrets,
        stored,
        () =>
          this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${serverId}))`;
            const server = await tx.mcpServer.findFirst({
              where: { id: serverId, spaceId: context.spaceId, userId: context.userId },
              select: { endpoint: true, secretId: true, revision: true },
            });
            if (!server) throw new Error("MCP server is unavailable");
            if (
              server.revision !== expectedRevision ||
              server.endpoint !== snapshot.server.endpoint ||
              server.secretId !== snapshot.server.secretId
            )
              return false;
            if (server.secretId)
              await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${server.secretId} FOR UPDATE`;
            const current = server.secretId
              ? await tx.secret.findFirst({
                  where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
                })
              : null;
            if (current?.ciphertext !== snapshot.secret?.ciphertext) return false;
            if (stored)
              await tx.secret.create({
                data: {
                  id: stored.id,
                  spaceId: context.spaceId,
                  userId: context.userId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            await tx.mcpServer.update({
              where: { id: serverId },
              data: {
                secretId: stored?.id ?? null,
                ...(incrementRevision ? { revision: { increment: 1 } } : {}),
              },
            });
            if (server.secretId && server.secretId !== stored?.id)
              await tx.secret.deleteMany({ where: { id: server.secretId } });
            return true;
          }),
        (committed) => {
          if (committed && stored)
            onPersisted?.({ id: stored.id, ref: stored.ciphertext, material: nextMaterial });
        },
      );
      if (committed) return stored?.id;
    }
    throw new Error("MCP credentials changed during authorization; retry");
  }

  private async read(ciphertext: string, recordId: string): Promise<OAuthMaterial> {
    try {
      const value = JSON.parse(await this.secrets.load(ciphertext, recordId));
      return value && typeof value === "object" ? (value as OAuthMaterial) : {};
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return {};
    }
  }
}
