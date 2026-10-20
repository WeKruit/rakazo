import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthMaterial } from "./mcp-oauth.js";
import {
  McpOAuthBroker,
  McpReauthorizationRequiredError,
  oauthMaterialSecrets,
  StoredMcpOAuthProvider,
} from "./mcp-oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TEST_NETWORK = {
  // Read the global per call so a fetch stubbed after construction still wins.
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

function logicalHref(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
  if (host) url.host = host;
  return url.href;
}

function deploymentOwner(ownerUserId: string) {
  return { findUnique: vi.fn(async () => ({ ownerUserId })) };
}

function oauthSessionStore() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
}

function trackedClone(response: Response): { response: Response; bytesRead: () => number } {
  let bytes = 0;
  const clone = response.clone.bind(response);
  response.clone = () => {
    const cloned = clone();
    const reader = cloned.body?.getReader();
    if (!reader) return cloned;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: cloned.status,
      statusText: cloned.statusText,
      headers: cloned.headers,
    });
  };
  return { response, bytesRead: () => bytes };
}

function chunkedBody(totalBytes: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

async function rejectedOAuthBegin(
  register: () => Response | Promise<Response>,
  secret?: string,
): Promise<Error> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = logicalHref(input, init);
      if (url === "https://mcp.example.test/mcp" && request.method === "POST") {
        return new Response("missing bearer token", {
          status: 401,
          headers: {
            "content-type": "text/plain",
            "WWW-Authenticate":
              'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://auth.example.test"],
        });
      }
      if (url === "https://auth.example.test/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://auth.example.test/register" && request.method === "POST") {
        return register();
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    }),
  );
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    mcpServer: {
      findFirst: vi.fn().mockResolvedValue({
        endpoint: "https://mcp.example.test/mcp",
        revision: 1,
        secretId: secret ? "secret-1" : null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    secret: {
      findFirst: vi
        .fn()
        .mockResolvedValue(secret ? { id: "secret-1", ciphertext: "encrypted" } : undefined),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    mcpServer: {
      findFirst: vi.fn().mockResolvedValue({
        id: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        revision: 1,
        secretId: secret ? "secret-1" : null,
      }),
    },
    secret: {
      findFirst: vi
        .fn()
        .mockResolvedValue(secret ? { id: "secret-1", ciphertext: "encrypted" } : undefined),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    mcpOAuthSession: oauthSessionStore(),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const broker = new McpOAuthBroker(
    prisma as never,
    {
      load: vi.fn(() => JSON.stringify(secret ? { secret } : {})),
      put: vi.fn(async () => ({ id: "secret-1", ciphertext: "encrypted" })),
    } as never,
    TEST_NETWORK,
  );
  const error = await broker
    .begin({
      serverId: "server-1",
      spaceId: "workspace-1",
      userId: "user-1",
      redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
    })
    .then(
      () => null,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("MCP OAuth", () => {
  function expiringMaterial(obtainedAt: number) {
    return {
      oauth: {
        tokens: {
          access_token: "old-access",
          refresh_token: "old-refresh",
          token_type: "Bearer",
          expires_in: 7200,
        },
        obtainedAt,
        clientInformation: { client_id: "client-1" },
        discoveryState: {
          authorizationServerUrl: "https://auth.example.test",
          authorizationServerMetadata: {
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            response_types_supported: ["code"],
          },
          resourceMetadata: {
            resource: "https://mcp.example.test",
            authorization_servers: ["https://auth.example.test"],
          },
        },
      },
    };
  }

  it("renews an expired token once before handing it out", async () => {
    const persisted: { oauth?: { tokens?: { access_token?: string } } }[] = [];
    const tokenRequests: URLSearchParams[] = [];
    const close = vi.fn(async () => undefined);
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      expiringMaterial(Date.now() - 3 * 60 * 60 * 1000),
      async (material) => {
        persisted.push(structuredClone(material));
      },
      {
        refreshNetwork: async () => ({
          fetch: async (_input: string | URL | Request, init?: RequestInit) => {
            tokenRequests.push(new URLSearchParams(String(init?.body)));
            return new Response(
              JSON.stringify({
                access_token: "new-access",
                refresh_token: "new-refresh",
                token_type: "Bearer",
                expires_in: 7200,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
          close,
        }),
      },
    );

    const [first, second] = await Promise.all([provider.tokens(), provider.tokens()]);

    expect(first).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh" });
    expect(second).toMatchObject({ access_token: "new-access" });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[0]?.get("refresh_token")).toBe("old-refresh");
    expect(tokenRequests[0]?.get("client_id")).toBe("client-1");
    expect(tokenRequests[0]?.get("resource")).toBe("https://mcp.example.test/");
    expect(persisted.at(-1)?.oauth?.tokens?.access_token).toBe("new-access");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not renew a token that is still inside its lifetime", async () => {
    const refreshNetwork = vi.fn(async () => ({
      fetch: async () => new Response(),
      close: async () => undefined,
    }));
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      expiringMaterial(Date.now() - 10 * 60 * 1000),
      async () => undefined,
      { refreshNetwork },
    );

    expect(await provider.tokens()).toMatchObject({ access_token: "old-access" });
    expect(refreshNetwork).not.toHaveBeenCalled();
  });

  it("keeps the current token when refresh-network setup fails", async () => {
    const persist = vi.fn(async () => undefined);
    const refreshNetwork = vi.fn(async () => {
      throw new Error("permission lookup temporarily unavailable");
    });
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      expiringMaterial(Date.now() - (7200 - 30) * 1000),
      persist,
      { refreshNetwork },
    );

    await expect(provider.tokens()).resolves.toMatchObject({ access_token: "old-access" });
    expect(persist).not.toHaveBeenCalled();
    expect(refreshNetwork).toHaveBeenCalledOnce();
  });

  it("keeps the current token when renewal has a transient failure", async () => {
    const persist = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      expiringMaterial(Date.now() - 3 * 60 * 60 * 1000),
      persist,
      {
        refreshNetwork: async () => ({
          fetch: async () => {
            throw new TypeError("network unavailable");
          },
          close,
        }),
      },
    );

    expect(await provider.tokens()).toMatchObject({ access_token: "old-access" });
    expect(persist).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("invalidates only tokens after invalid_grant and does not retry a revoked grant", async () => {
    const persist = vi.fn(async (_material: OAuthMaterial) => undefined);
    const close = vi.fn(async () => undefined);
    const fetchToken = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      expiringMaterial(Date.now() - 3 * 60 * 60 * 1000),
      persist,
      { refreshNetwork: async () => ({ fetch: fetchToken, close }) },
    );

    const [first, second] = await Promise.all([provider.tokens(), provider.tokens()]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
    expect(fetchToken).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    const persisted = persist.mock.calls[0]?.[0] as OAuthMaterial | undefined;
    expect(persisted?.oauth?.tokens).toBeUndefined();
    expect(persisted?.oauth?.obtainedAt).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "client-1" });
    expect(provider.discoveryState()).toBeDefined();
  });

  it("rejects unsafe browser authorization URLs", async () => {
    const onAuthorization = vi.fn();
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      { oauth: { tokens: { access_token: "working", token_type: "bearer" } } },
      async () => undefined,
      { onAuthorization },
    );

    await expect(
      provider.redirectToAuthorization(new URL("http://auth.example.test/authorize")),
    ).rejects.toThrow(/HTTPS/i);

    expect(provider.authorizationUrl).toBeUndefined();
    expect(onAuthorization).not.toHaveBeenCalled();
    expect(await provider.tokens()).toMatchObject({ access_token: "working" });
  });

  it("allows localhost HTTP browser authorization URLs", async () => {
    const onAuthorization = vi.fn();
    const provider = new StoredMcpOAuthProvider("server-1", {}, async () => undefined, {
      onAuthorization,
    });
    const authorizationUrl = new URL("http://127.0.0.1:5173/authorize");

    await provider.redirectToAuthorization(authorizationUrl);

    expect(provider.authorizationUrl).toEqual(authorizationUrl);
    expect(onAuthorization).toHaveBeenCalledWith(authorizationUrl);
  });

  it("clears stale tokens when runtime authorization URL validation fails", async () => {
    const persisted: { oauth?: { tokens?: unknown } }[] = [];
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      { oauth: { tokens: { access_token: "revoked", token_type: "bearer" } } },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );

    await expect(
      provider.redirectToAuthorization(new URL("http://auth.example.test/authorize")),
    ).rejects.toThrow(/HTTPS/i);

    expect(await provider.tokens()).toBeUndefined();
    expect(persisted.at(-1)?.oauth?.tokens).toBeUndefined();
  });

  it("persists SDK credentials and invalidates only the requested scope", async () => {
    const persisted: unknown[] = [];
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: "old", refresh_token: "refresh", token_type: "bearer" },
          clientInformation: { client_id: "client-1" },
          discoveryState: { authorizationServerUrl: "https://auth.example.test" },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );

    await provider.saveTokens({
      access_token: "new",
      refresh_token: "rotated",
      token_type: "bearer",
    });
    await provider.invalidateCredentials("tokens");

    expect(await provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "client-1" });
    expect(provider.discoveryState()).toMatchObject({
      authorizationServerUrl: "https://auth.example.test",
    });
    expect(persisted).toHaveLength(2);
    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.test/authorize")),
    ).rejects.toThrow(McpReauthorizationRequiredError);
  });

  it("clears stale tokens when runtime re-authorization is required so status flips to reconnect", async () => {
    const persisted: { oauth?: { tokens?: unknown } }[] = [];
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: "revoked-server-side", token_type: "bearer" },
          clientInformation: { client_id: "client-1" },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );

    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.test/authorize")),
    ).rejects.toThrow(McpReauthorizationRequiredError);

    expect(await provider.tokens()).toBeUndefined();
    expect(persisted.at(-1)?.oauth?.tokens).toBeUndefined();
  });

  it.each([true, false])(
    "persists only this begin's OAuth refresh: %s",
    async (refreshThisBegin) => {
      let material = expiringMaterial(Date.now() - (refreshThisBegin ? 3 * 60 * 60_000 : 0));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = logicalHref(input, init);
          if (url === "https://auth.example.test/token" && refreshThisBegin)
            return Response.json({
              access_token: "quiet-access",
              refresh_token: "quiet-refresh",
              token_type: "bearer",
              expires_in: 7200,
            });
          if (url === "https://mcp.example.test/mcp") {
            if (request.method === "GET") return new Response(null, { status: 405 });
            const message = await request.json();
            if (message.method === "initialize") {
              if (!refreshThisBegin) {
                server.secretId = "secret-other-refresh";
                material = expiringMaterial(Date.now());
                material.oauth.tokens.access_token = "other-access";
                material.oauth.tokens.refresh_token = "other-refresh";
              }
              return Response.json({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                },
              });
            }
            return new Response(null, { status: 202 });
          }
          throw new Error(`Unexpected fixture request: ${request.method} ${url}`);
        }),
      );
      const server = {
        id: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        secretId: "secret-current",
        revision: 1,
      };
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        mcpServer: {
          findFirst: vi.fn(async () => ({ ...server })),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: {
          findFirst: vi.fn(async () => ({ id: server.secretId, ciphertext: server.secretId })),
          create: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        ...tx,
        mcpOAuthSession: oauthSessionStore(),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const secrets = {
        load: vi.fn(async () => JSON.stringify(material)),
        put: vi.fn(async (_plaintext: string) => ({ id: "secret-next", ciphertext: "next" })),
      };
      const broker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);
      await expect(
        broker.begin({
          serverId: server.id,
          spaceId: "workspace-1",
          userId: "user-1",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
      ).resolves.toEqual({ status: "already_connected" });
      if (!refreshThisBegin) {
        expect(secrets.put).not.toHaveBeenCalled();
        expect(tx.secret.create).not.toHaveBeenCalled();
        expect(tx.mcpServer.update).not.toHaveBeenCalled();
        expect(server.secretId).toBe("secret-other-refresh");
        expect(material.oauth.tokens.refresh_token).toBe("other-refresh");
        return;
      }
      expect(tx.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: server.id },
        data: { secretId: "secret-next" },
      });
      expect(JSON.parse(secrets.put.mock.calls[0]![0] as string).oauth.tokens).toMatchObject({
        access_token: "quiet-access",
        refresh_token: "quiet-refresh",
      });
      expect(prisma.mcpOAuthSession.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mcpOrigin: "https://mcp.example.test", preRegistered: false },
    { mcpOrigin: "http://127.0.0.1:8080", preRegistered: false },
    { mcpOrigin: "https://mcp.example.test", preRegistered: true },
    { mcpOrigin: "https://mcp.example.test", preRegistered: true, existingGrant: true },
    {
      mcpOrigin: "https://mcp.example.test",
      preRegistered: true,
      existingGrant: true,
      tokenRejected: true,
    },
  ])(
    "drives discovery, registration, PKCE, redirect, and token exchange for %j",
    async ({ mcpOrigin, preRegistered, existingGrant, tokenRejected }) => {
      const requests: string[] = [];
      let registration: Record<string, unknown> | undefined;
      const existingMaterial = existingGrant
        ? {
            oauth: {
              clientInformation: { client_id: "old-client", client_secret: "old-secret" },
              tokens: { access_token: "old-working-token", token_type: "bearer" },
            },
          }
        : undefined;
      const existingSecret = existingGrant
        ? { id: "secret-existing", ciphertext: "encrypted-existing" }
        : null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(logicalHref(input, init));
          requests.push(`${request.method} ${url.toString()}`);

          if (url.href === `${mcpOrigin}/mcp` && request.method === "POST") {
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"`,
              },
            });
          }
          if (url.href === `${mcpOrigin}/.well-known/oauth-protected-resource/mcp`) {
            return Response.json({
              resource: `${mcpOrigin}/mcp`,
              authorization_servers: ["https://auth.example.test"],
              ...(preRegistered ? { scopes_supported: ["mail.readonly", "mail.write"] } : {}),
            });
          }
          if (url.href === "https://auth.example.test/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              ...(!preRegistered
                ? { registration_endpoint: "https://auth.example.test/register" }
                : {}),
              ...(preRegistered
                ? { token_endpoint_auth_methods_supported: ["client_secret_post"] }
                : {}),
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
            });
          }
          if (url.href === "https://auth.example.test/register" && request.method === "POST") {
            registration = (await request.json()) as Record<string, unknown>;
            return Response.json(
              {
                client_id: "registered-client-id",
                redirect_uris: ["http://127.0.0.1:5173/mcp/oauth/callback"],
                token_endpoint_auth_method: "none",
              },
              { status: 201 },
            );
          }
          if (url.href === "https://auth.example.test/token" && request.method === "POST") {
            if (preRegistered) {
              const body = new URLSearchParams(await request.text());
              expect(body.get("client_id")).toBe("registered-client-id");
              expect(body.get("client_secret")).toBe("private-client-secret");
            }
            if (tokenRejected)
              return Response.json(
                { error: "invalid_client", error_description: "Rejected private-client-secret" },
                { status: 401 },
              );
            return Response.json({
              access_token: "access-token",
              refresh_token: "refresh-token",
              token_type: "bearer",
              expires_in: 3600,
            });
          }
          throw new Error(`Unexpected request: ${request.method} ${url}`);
        }),
      );
      let secretCounter = 0;
      const storedPayloads: string[] = [];
      const put = vi.fn(async (plaintext: string) => {
        storedPayloads.push(plaintext);
        secretCounter += 1;
        return { id: `secret-${secretCounter}`, ciphertext: `encrypted-${secretCounter}` };
      });
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        mcpServer: {
          findFirst: vi.fn().mockResolvedValue({
            endpoint: `${mcpOrigin}/mcp`,
            revision: 1,
            secretId: existingSecret?.id ?? null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: {
          findFirst: vi.fn().mockResolvedValue(existingSecret),
          create: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        mcpServer: {
          findFirst: vi.fn().mockResolvedValue({
            id: "server-1",
            endpoint: `${mcpOrigin}/mcp`,
            revision: 1,
            secretId: existingSecret?.id ?? null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: {
          findFirst: vi.fn().mockResolvedValue(existingSecret),
          create: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        mcpOAuthSession: oauthSessionStore(),
        deploymentSettings: deploymentOwner("user-1"),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const broker = new McpOAuthBroker(
        prisma as never,
        { put, load: async () => JSON.stringify(existingMaterial) } as never,
        TEST_NETWORK,
      );
      const oauth = preRegistered
        ? {
            clientId: "registered-client-id",
            clientSecret: "private-client-secret",
            scopes: ["mail.readonly"],
            authorizationParams: { access_type: "offline", prompt: "consent" },
          }
        : undefined;

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        ...(oauth ? { oauth } : {}),
      });
      expect(started.status).toBe("authorization_required");
      if (started.status !== "authorization_required") throw new Error("OAuth was not requested");
      const authorizationUrl = new URL(started.authorizationUrl);

      if (preRegistered) {
        expect(registration).toBeUndefined();
        expect(authorizationUrl.searchParams.get("scope")).toBe("mail.readonly");
        expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
        expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
        expect(JSON.stringify(started)).not.toContain("private-client-secret");
      } else
        expect(registration).toMatchObject({ client_name: "Rakazo", application_type: "native" });
      expect(authorizationUrl.origin).toBe("https://auth.example.test");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("registered-client-id");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("state")).toBe(started.sessionId);

      const second = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        ...(oauth ? { oauth } : {}),
      });
      expect(second.status).toBe("authorization_required");
      if (second.status !== "authorization_required") throw new Error("OAuth was not requested");
      expect(second.sessionId).not.toBe(started.sessionId);
      expect(tx.secret.create).not.toHaveBeenCalled();
      expect(tx.mcpServer.update).not.toHaveBeenCalled();
      if (existingMaterial)
        expect(existingMaterial.oauth.tokens.access_token).toBe("old-working-token");

      const warnings = tokenRejected
        ? vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined)
        : undefined;
      const complete = broker.complete({
        sessionId: started.sessionId,
        code: "authorization-code",
        state: started.sessionId,
        spaceId: "workspace-1",
        userId: "user-1",
      });
      if (tokenRejected) {
        const failure = await complete.catch((error: Error) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("private-client-secret");
        expect(warnings).toHaveBeenCalled();
        expect(JSON.stringify(warnings!.mock.calls)).not.toContain("private-client-secret");
        expect(tx.secret.create).not.toHaveBeenCalled();
        expect(tx.mcpServer.update).not.toHaveBeenCalled();
        expect(existingMaterial?.oauth.tokens.access_token).toBe("old-working-token");
        return;
      }
      await complete;

      expect(requests).toContain("POST https://auth.example.test/token");
      expect(
        storedPayloads
          .map((value) => JSON.parse(value))
          .some((value) => value.oauth?.tokens?.access_token === "access-token"),
      ).toBe(true);
      expect(tx.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: "server-1" },
        data: { secretId: expect.any(String), revision: { increment: 1 } },
      });
      expect(prisma.mcpServer.update).not.toHaveBeenCalled();
      if (preRegistered) {
        expect(storedPayloads.map((value) => JSON.parse(value)).at(-1).oauth).toMatchObject({
          clientInformation: {
            client_id: "registered-client-id",
            client_secret: "private-client-secret",
          },
          scope: "mail.readonly",
          authorizationParams: { access_type: "offline", prompt: "consent" },
          tokens: { access_token: "access-token" },
        });
      }
    },
  );

  it("preserves a configured client and authorization settings when invalidating its grant", async () => {
    const material: OAuthMaterial = {
      oauth: {
        preRegistered: true,
        clientInformation: { client_id: "client", client_secret: "private-secret" },
        scope: "mail.readonly",
        authorizationParams: { access_type: "offline" },
        tokens: { access_token: "token", token_type: "bearer" },
      },
    };
    const provider = new StoredMcpOAuthProvider("server", material, async () => undefined, {
      redirectUri: "https://app.example.test/mcp/oauth/callback",
    });
    await provider.invalidateCredentials("client");
    expect(provider.clientInformation()).toEqual({
      client_id: "client",
      client_secret: "private-secret",
    });
    await provider.invalidateCredentials("all");
    expect(material.oauth).toMatchObject({
      preRegistered: true,
      clientInformation: { client_id: "client", client_secret: "private-secret" },
      scope: "mail.readonly",
      authorizationParams: { access_type: "offline" },
    });
    expect(await provider.tokens()).toBeUndefined();
    expect(oauthMaterialSecrets(material)).toContain("private-secret");
    await expect(
      provider.redirectToAuthorization(
        new URL("https://auth.example.test/authorize?ref=private-secret"),
      ),
    ).rejects.toThrow("credential");
  });

  it("applies the transport URL policy to OAuth traffic: no plain-HTTP endpoints, no redirects", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        fetchCalls.push(`${request.method} ${url}`);
        if (url === "http://insecure.example.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="http://insecure.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "http://insecure.example.test/mcp",
          revision: 1,
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/HTTPS/i);
    expect(fetchCalls).toEqual([]);
  });

  it.each([
    ["http://localhost:3100/api/auth/get-session", /HTTPS/],
    ["http://127.0.0.1:3100/mcp", /HTTPS/],
    ["https://localhost:3100/mcp", /private/],
  ])("refuses loopback %s for a user who is not the deployment owner", async (endpoint, reason) => {
    const fetch = vi.fn(async () => new Response("internal handler body", { status: 405 }));
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", endpoint, secretId: null }),
      },
      secret: { findFirst: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      deploymentSettings: deploymentOwner("owner"),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, {
      fetch,
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reflect upstream response text when starting OAuth fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("UPSTREAM_BODY_MARKER internal detail", { status: 500 })),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: null,
        }),
      },
      secret: { findFirst: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, TEST_NETWORK);

    const error = await broker
      .begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not start MCP OAuth");
    expect((error as Error).message).not.toContain("UPSTREAM_BODY_MARKER");
  });

  it("reports the HTTP status and OAuth error when registration is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        if (url === "https://mcp.example.test/mcp" && request.method === "POST") {
          return new Response("missing bearer token", {
            status: 401,
            headers: {
              "content-type": "text/plain",
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
          });
        }
        if (url === "https://auth.example.test/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            registration_endpoint: "https://auth.example.test/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url === "https://auth.example.test/register" && request.method === "POST") {
          return Response.json(
            {
              error: "registration_not_supported",
              error_description:
                "Dynamic client registration is not supported. Only pre-registered partners are allowed.",
            },
            { status: 403 },
          );
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: null,
        }),
      },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const broker = new McpOAuthBroker(
      prisma as never,
      { put: vi.fn(async () => ({ id: "secret-1", ciphertext: "encrypted" })) } as never,
      TEST_NETWORK,
    );

    const error = await broker
      .begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Could not start MCP OAuth: HTTP 403 registration_not_supported: Dynamic client registration is not supported. Only pre-registered partners are allowed.",
    );
    expect((error as Error).message).not.toContain("[object Response]");
  });

  it("reports the OAuth status and code when the description is redacted", async () => {
    const error = await rejectedOAuthBegin(
      () =>
        Response.json(
          {
            error: "registration_not_supported",
            error_description:
              "Use Bearer access-token-value or quote static-credential-value to continue.",
          },
          { status: 403 },
        ),
      "static-credential-value",
    );

    expect(error.message).toBe(
      "Could not start MCP OAuth: HTTP 403 registration_not_supported: Use Bearer [redacted] or quote [redacted] to continue.",
    );
    expect(error.message).not.toContain("access-token-value");
    expect(error.message).not.toContain("static-credential-value");
  });

  it("reports the OAuth status and code when the description exceeds the sanitized message", async () => {
    const description = `${"a".repeat(2_500)} tail-marker`;
    const error = await rejectedOAuthBegin(() =>
      Response.json(
        { error: "registration_not_supported", error_description: description },
        { status: 403 },
      ),
    );

    expect(error.message).toBe(
      `Could not start MCP OAuth: HTTP 403 registration_not_supported: ${"a".repeat(300)}`,
    );
    expect(error.message).not.toContain("tail-marker");
  });

  it("redacts a secret that crosses the caller-facing description cut", async () => {
    const secret = "cross-boundary-secret-value";
    const error = await rejectedOAuthBegin(
      () =>
        Response.json(
          {
            error: "registration_not_supported",
            error_description: `${"a".repeat(290)}${secret}`,
          },
          { status: 403 },
        ),
      secret,
    );

    expect(error.message).toBe(
      `Could not start MCP OAuth: HTTP 403 registration_not_supported: ${"a".repeat(290)}[redacted]`,
    );
    expect(error.message).not.toContain(secret.slice(0, 10));
  });

  it("stops reading an oversized OAuth error body", async () => {
    const totalBytes = 128 * 1_024;
    const chunkBytes = 1_024;
    const tracked = trackedClone(
      new Response(chunkedBody(totalBytes, chunkBytes), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await rejectedOAuthBegin(() => tracked.response);

    expect(tracked.bytesRead()).toBeGreaterThan(0);
    expect(tracked.bytesRead()).toBeLessThanOrEqual(8_000 * 3 + chunkBytes);
    expect(tracked.bytesRead()).toBeLessThan(totalBytes);
    expect(error.message).toBe("Could not start MCP OAuth");
    expect(error.message).not.toContain("a".repeat(300));
  });

  it("does not read an OAuth error body whose declared length exceeds the cap", async () => {
    const tracked = trackedClone(
      new Response(chunkedBody(64 * 1_024, 1_024), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024),
        },
      }),
    );

    const error = await rejectedOAuthBegin(() => tracked.response);

    expect(tracked.bytesRead()).toBe(0);
    expect(error.message).toBe("Could not start MCP OAuth");
  });

  it.each([
    ["same generation", 1],
    ["missing generation", undefined],
    ["changed generation", 2],
  ])("restores a persisted OAuth session from the %s", async (_label, authorizationRevision) => {
    const sessionId = "5d259fd9-b9fa-478e-a268-cc778816a043";
    let tokenRequestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        if (url !== "https://auth.example.test/token") {
          throw new Error(`Unexpected request: ${request.method} ${url}`);
        }
        tokenRequestBody = await request.text();
        return Response.json({ access_token: "fresh", token_type: "bearer" });
      }),
    );
    const material = {
      authorizationRevision,
      oauth: {
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        codeVerifier: "persisted-verifier",
        clientInformation: { client_id: "persisted-client" },
        discoveryState: {
          authorizationServerUrl: "https://auth.example.test",
          resourceMetadata: {
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
          },
          authorizationServerMetadata: {
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
          },
        },
      },
    };
    const sessions = oauthSessionStore();
    sessions.findFirst.mockResolvedValue({
      id: sessionId,
      serverId: "server-1",
      endpoint: "https://mcp.example.test/mcp",
      redirectUri: material.oauth.redirectUri,
      oauthCiphertext: "session-first",
      createdAt: new Date(),
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: "secret-1",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      ...tx,
      mcpOAuthSession: sessions,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const secrets = {
      load: vi.fn((ciphertext: string) =>
        JSON.stringify(
          ciphertext === "session-first"
            ? material
            : { oauth: { ...material.oauth, codeVerifier: "wrong-later-verifier" } },
        ),
      ),
      put: vi.fn(async () => ({ id: "secret-2", ciphertext: "encrypted-2" })),
    };
    const restartedBroker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);

    if (authorizationRevision !== 1) {
      await expect(
        restartedBroker.complete({
          sessionId,
          code: "authorization-code",
          state: sessionId,
          spaceId: "workspace-1",
          userId: "user-1",
        }),
      ).rejects.toThrow(/invalid or expired/i);
      expect(tokenRequestBody).toBe("");
      expect(tx.secret.create).not.toHaveBeenCalled();
      expect(tx.mcpServer.update).not.toHaveBeenCalled();
      return;
    }

    await restartedBroker.complete({
      sessionId,
      code: "authorization-code",
      state: sessionId,
      spaceId: "workspace-1",
      userId: "user-1",
    });

    expect(sessions.deleteMany).toHaveBeenCalledWith({
      where: { id: sessionId, spaceId: "workspace-1", userId: "user-1" },
    });
    expect(new URLSearchParams(tokenRequestBody).get("code_verifier")).toBe("persisted-verifier");
    expect(tx.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "server-1" },
      data: { secretId: "secret-2", revision: { increment: 1 } },
    });
  });

  it("rotates the current credential inside a serialized database transaction", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: "secret-current",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: "secret-current",
          ciphertext: "encrypted-current",
        }),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: "secret-current",
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: "secret-current",
          ciphertext: "encrypted-current",
        }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const secrets = {
      load: vi.fn(() =>
        JSON.stringify({
          secret: "static-token",
          oauth: { tokens: { access_token: "oauth-token", token_type: "bearer" } },
        }),
      ),
      put: vi.fn(async () => ({ id: "secret-next", ciphertext: "encrypted-next" })),
    };
    const broker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);

    await broker.disconnect({
      serverId: "server-1",
      spaceId: "workspace-1",
      userId: "user-1",
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.mcpServer.update).toHaveBeenCalledWith({
      where: { id: "server-1" },
      data: { secretId: "secret-next", revision: { increment: 1 } },
    });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({ where: { id: "secret-current" } });
  });

  it.each([
    ["same generation", 1, false],
    ["changed generation", 2, false],
    ["generation changed while preparing", 2, true],
  ])("fences quiet OAuth persistence against the %s", async (_label, revision, raced) => {
    const storedPayloads: string[] = [];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          endpoint: "https://mcp.example.test/mcp",
          secretId: "secret-current",
          revision,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: "secret-current",
          ciphertext: "encrypted-current",
        }),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    if (raced)
      tx.mcpServer.findFirst.mockResolvedValueOnce({
        endpoint: "https://mcp.example.test/mcp",
        secretId: "secret-current",
        revision: 1,
      });
    const secrets = {
      load: vi.fn(() =>
        JSON.stringify({
          secret: "fresh-static-token",
          headers: { Authorization: "fresh-static-header" },
          oauth: { tokens: { access_token: "previous-oauth", token_type: "bearer" } },
        }),
      ),
      put: vi.fn(async (plaintext: string) => {
        storedPayloads.push(plaintext);
        return { id: "secret-next", ciphertext: "encrypted-next" };
      }),
    };
    const broker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);
    const provider = await broker.providerFor(
      {
        id: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        secretId: "secret-before-edit",
        revision: 1,
      },
      { spaceId: "workspace-1", userId: "user-1" },
      {
        material: {
          secret: "stale-static-token",
          oauth: { tokens: { access_token: "stale-oauth", token_type: "bearer" } },
        },
        secretId: "secret-before-edit",
      },
    );
    if (!provider) throw new Error("expected an OAuth provider");

    if (revision !== 1) {
      await expect(
        provider.saveTokens({ access_token: "stale-account-token", token_type: "bearer" }),
      ).rejects.toThrow(/server changed/i);
      expect(secrets.put).toHaveBeenCalledTimes(raced ? 1 : 0);
      expect(tx.secret.create).not.toHaveBeenCalled();
      expect(tx.mcpServer.update).not.toHaveBeenCalled();
      return;
    }

    await provider.saveTokens({ access_token: "fresh-oauth", token_type: "bearer" });
    expect(tx.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "server-1" },
      data: { secretId: "secret-next" },
    });

    expect(JSON.parse(storedPayloads.at(-1)!)).toMatchObject({
      secret: "fresh-static-token",
      headers: { Authorization: "fresh-static-header" },
      oauth: { tokens: { access_token: "fresh-oauth", token_type: "bearer" } },
    });
    expect(JSON.parse(storedPayloads.at(-1)!)).not.toMatchObject({
      secret: "stale-static-token",
    });

    tx.mcpServer.findFirst.mockResolvedValue({
      endpoint: "https://replacement.example.test/mcp",
      revision: 1,
      secretId: "secret-next",
    });
    await expect(
      provider.saveTokens({ access_token: "must-not-cross-origins", token_type: "bearer" }),
    ).rejects.toThrow(/endpoint changed/i);
    expect(secrets.put).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects during OAuth discovery instead of following them", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        requestedUrls.push(url);
        if (url === "https://mcp.example.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url.startsWith("https://mcp.example.test/.well-known/")) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: "https://attacker.example.test/.well-known/oauth-protected-resource/mcp",
            },
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/redirect/i);
    expect(requestedUrls.every((url) => !url.includes("attacker.example.test"))).toBe(true);
  });

  it("retries safe OAuth discovery reads without replaying DCR writes", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(logicalHref(input, init));
        requests.push(`${request.method} ${url.toString()}`);

        if (url.href === "https://mcp.example.test/mcp" && request.method === "POST") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://private-auth.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url.origin === "https://private-auth.example.test") throw new TypeError("fetch failed");
        if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
          // Like Brex: the advertised canonical resource is the private alias.
          return Response.json({
            resource: "https://private-auth.example.test",
            authorization_servers: ["https://private-auth.example.test"],
          });
        }
        if (url.href === "https://mcp.example.test/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://private-auth.example.test",
            authorization_endpoint: "https://login.example.test/authorize",
            token_endpoint: "https://login.example.test/token",
            registration_endpoint: "https://private-auth.example.test/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    let secretCounter = 0;
    const put = vi.fn(async () => {
      secretCounter += 1;
      return { id: `secret-${secretCounter}`, ciphertext: `encrypted-${secretCounter}` };
    });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          revision: 1,
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const broker = new McpOAuthBroker(prisma as never, { put } as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/Could not reach private-auth\.example\.test|Unexpected request/);

    expect(requests).toContain(
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
    );
    expect(requests).not.toContain("POST https://mcp.example.test/register");
  });
});

describe("MCP setup with an existing access token", () => {
  it.each(["https://mcp.example.test/mcp", "http://127.0.0.1:8080/mcp"])(
    "verifies %s using the stored token without starting OAuth",
    async (endpoint) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(logicalHref(input, init)).toBe(endpoint);
        expect(request.headers.get("authorization")).toBe("Bearer fake-executor-token");
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const body = (await request.json()) as { id?: number; method: string };
        if (body.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1" },
            },
          });
        return new Response(null, { status: 202 });
      });
      const prisma = {
        mcpServer: {
          findFirst: vi.fn(async () => ({ id: "server", endpoint, secretId: "secret" })),
        },
        secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
        mcpOAuthSession: oauthSessionStore(),
        deploymentSettings: deploymentOwner("user"),
      };
      const secrets = {
        load: vi.fn(() => JSON.stringify({ secret: "fake-executor-token" })),
        put: vi.fn(),
      };
      const broker = new McpOAuthBroker(prisma as never, secrets as never, {
        ...TEST_NETWORK,
        fetch,
      });
      await expect(
        broker.begin({
          serverId: "server",
          userId: "user",
          spaceId: "space",
          redirectUri: "https://app.example.test/mcp/oauth/callback",
        }),
      ).resolves.toEqual({ status: "authorization_not_requested" });
      expect(fetch).toHaveBeenCalled();
      expect(secrets.put).not.toHaveBeenCalled();
    },
  );
});
