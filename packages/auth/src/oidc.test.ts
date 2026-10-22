import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runWithAdapter } from "@better-auth/core/context";
import type * as Db from "@rakazo/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import type * as PrismaAdapterModule from "better-auth/adapters/prisma";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth, AuthEnv } from "./index.js";
import { createAuth } from "./index.js";
import {
  getOidcAccessToken,
  getOidcAccountStatus,
  isCurrentOidcAccount,
  oidcAccountSubject,
  oidcConfigFromEnv,
} from "./oidc.js";

const state = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  blockRootAdapter: false,
}));
vi.mock("better-auth/adapters/prisma", async (original) => {
  const native = await original<typeof PrismaAdapterModule>();
  return {
    prismaAdapter: (prisma: object, options: Parameters<typeof native.prismaAdapter>[1]) => {
      if ("$queryRaw" in prisma) return native.prismaAdapter(prisma, options);
      const create = memoryAdapter(state.db);
      return (...args: Parameters<typeof create>) =>
        new Proxy(create(...args), {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (state.blockRootAdapter && typeof value === "function")
              return () => {
                throw new Error("Root adapter used inside token transaction");
              };
            return value;
          },
        });
    },
  };
});
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(),
}));

const issuer = "https://identity.example.test";
const origin = "https://rakazo.example.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
let auth: Auth;
let discoveryDown: boolean;
let activeIssuer = issuer;
let sequence: number;
let cookies: string;
let sentCodes: string[];
let corruptSignature = false;
let omitIdToken = false;
let refreshTokenRequest: Mock<(init?: RequestInit) => Promise<Response>>;
const codes = new Map<
  string,
  { challenge: string; nonce: string; claims: Record<string, unknown> }
>();

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: activeIssuer,
      aud: "test-client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(corruptSignature ? `${data}tampered` : data), privateKey).toString("base64url")}`;
}

function setup(options: Partial<AuthEnv> = {}) {
  const prisma: Record<string, unknown> = {
    deploymentSettings: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "existing-space" })) },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({})) },
    organization: { deleteMany: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (operations: (tx: unknown) => Promise<unknown>) =>
    operations(prisma),
  );
  auth = createAuth(prisma as never, {
    secret: "offline-test-secret-with-at-least-32-characters",
    baseURL: origin,
    webOrigin: origin,
    signupsEnabled: "true",
    signupAllowlist: undefined,
    email: {
      describe: () => ({
        id: "offline-email",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { transactional: true },
      }),
      send: vi.fn(async (message) => {
        sentCodes.push(message.text);
      }),
    },
    oidc: {
      issuer,
      clientId: "test-client",
      clientSecret: "test-client-secret",
      name: "SSO",
      scopes: ["openid", "email", "profile"],
      allowSignupBypass: false,
    },
    ...options,
  });
}

async function request(path: string, body?: unknown, bearer?: string) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookies ? { cookie: cookies } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const cookieList = response.headers.getSetCookie();
  const jar = new Map(
    cookies
      .split("; ")
      .filter(Boolean)
      .map((item) => item.split("=") as [string, string]),
  );
  for (const cookie of cookieList) {
    const [key, value] = cookie.split(";")[0]!.split("=");
    if (key) jar.set(key, value ?? "");
  }
  cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  return response;
}

async function start(
  claims: Record<string, unknown> = {
    sub: "subject-1",
    email: "sso@example.test",
    email_verified: true,
    name: "SSO user",
  },
  link = false,
  callbackURL = `${origin}/app`,
  reauthenticate = false,
) {
  const response = await request(link ? "/link-social" : "/sign-in/social", {
    provider: "oidc",
    callbackURL,
    errorCallbackURL: `${origin}/sign-in`,
    disableRedirect: true,
    ...(reauthenticate ? { additionalData: { reauthenticate: true } } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  const code = `code-${++sequence}`;
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("prompt")).toBe("login");
  codes.set(code, {
    challenge: url.searchParams.get("code_challenge")!,
    nonce: url.searchParams.get("nonce")!,
    claims,
  });
  return `/callback/oidc?state=${url.searchParams.get("state")}&code=${code}`;
}
async function signIn(claims?: Record<string, unknown>) {
  return request(await start(claims));
}
const rows = (model: string) => state.db[model] ?? [];

async function tokenTransaction(account: Record<string, unknown>) {
  const stored = structuredClone(account);
  const tx = {
    account: {
      findMany: vi.fn(async ({ where }: { where: { userId: { equals: string } } }) =>
        where.userId.equals === stored.userId ? [structuredClone(stored)] : [],
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          expect(where).toEqual({ id: account.id });
          Object.assign(stored, data);
          return structuredClone(stored);
        },
      ),
    },
  };
  const { prismaAdapter } = await vi.importActual<typeof PrismaAdapterModule>(
    "better-auth/adapters/prisma",
  );
  state.blockRootAdapter = true;
  return {
    tx,
    stored,
    adapter: prismaAdapter(tx, { provider: "postgresql" })(auth.options),
  };
}

function expireOidcProofs() {
  for (const value of rows("verification")) {
    if (String(value.identifier).startsWith("oidc-reauth-")) value.expiresAt = new Date(0);
  }
}

beforeEach(() => {
  state.db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  discoveryDown = false;
  activeIssuer = issuer;
  sequence = 0;
  cookies = "";
  sentCodes = [];
  corruptSignature = false;
  omitIdToken = false;
  state.blockRootAdapter = false;
  refreshTokenRequest = vi.fn(async () =>
    json({
      access_token: "rotated-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 300,
    }),
  );
  codes.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== activeIssuer) throw new Error("Unexpected offline request");
      if (url.pathname.endsWith("openid-configuration"))
        return discoveryDown
          ? json({}, 503)
          : json({
              issuer: activeIssuer,
              authorization_endpoint: `${activeIssuer}/authorize`,
              token_endpoint: `${activeIssuer}/token`,
              userinfo_endpoint: `${activeIssuer}/userinfo`,
              jwks_uri: `${activeIssuer}/jwks`,
              id_token_signing_alg_values_supported: ["RS256"],
            });
      if (url.pathname === "/jwks") return json({ keys: [jwk] });
      if (url.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "refresh_token") {
          expect(["fake-refresh-token", "rotated-refresh-token"]).toContain(
            body.get("refresh_token"),
          );
          return refreshTokenRequest(init);
        }
        const code = body.get("code")!;
        const value = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (!value || value.challenge !== challenge) return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: "fake-access-token",
          refresh_token: "fake-refresh-token",
          token_type: "Bearer",
          expires_in: 300,
          ...(omitIdToken ? {} : { id_token: jwt({ ...value.claims, nonce: value.nonce }) }),
        });
      }
      throw new Error("Unexpected OIDC route");
    }),
  );
});
afterEach(() => {
  auth?.disposeOidcDiscovery();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OIDC callbacks", () => {
  it("bounds refresh discovery, token exchange and body reads with one deadline", async () => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    account.accessTokenExpiresAt = new Date(0);
    account.scope = "openid,email,profile";
    const { adapter, stored, tx } = await tokenTransaction(account);
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    let discoverySignal: AbortSignal | null | undefined;
    let tokenSignal: AbortSignal | null | undefined;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("openid-configuration")) {
        discoverySignal = init?.signal;
        expect(init?.redirect).toBe("manual");
      }
      return original(input, init);
    });
    refreshTokenRequest.mockImplementation(async (init?: RequestInit) => {
      tokenSignal = init?.signal;
      expect(init?.redirect).toBe("manual");
      expect(new URLSearchParams(String(init?.body))).toEqual(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "fake-refresh-token",
          client_id: "test-client",
          client_secret: "test-client-secret",
        }),
      );
      return json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 300,
        scope: "openid",
      });
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(
        runWithAdapter(adapter, () =>
          auth.api.getAccessToken({
            body: { accountId: String(account.id), userId: String(account.userId) },
          }),
        ),
      ).resolves.toMatchObject({
        accessToken: "rotated-access-token",
        scopes: ["openid", "email", "profile"],
      });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(8_000);
      expect(discoverySignal).toBeInstanceOf(AbortSignal);
      expect(tokenSignal).toBe(discoverySignal);
      expect(tx.account.update).toHaveBeenCalledTimes(1);
      expect(stored.scope).toBe("openid,email,profile");
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["discovery", "discovery body", "token", "token body"])(
    "aborts a stalled refresh %s without writing tokens",
    async (stage) => {
      setup();
      await signIn();
      const account = rows("account")[0]!;
      account.accessTokenExpiresAt = new Date(0);
      const before = structuredClone(account);
      const { adapter, stored, tx } = await tokenTransaction(account);
      const fetch = vi.mocked(globalThis.fetch);
      const original = fetch.getMockImplementation()!;
      let signal: AbortSignal | undefined;
      fetch.mockImplementation(async (input, init) => {
        const current = String(input).endsWith("openid-configuration") ? "discovery" : "token";
        if (!stage.startsWith(current)) return original(input, init);
        signal = init?.signal ?? undefined;
        expect(signal).toBeInstanceOf(AbortSignal);
        if (signal!.aborted) throw signal!.reason;
        if (stage.endsWith("body"))
          return new Response(
            new ReadableStream({
              start(controller) {
                signal!.addEventListener("abort", () => controller.error(signal!.reason), {
                  once: true,
                });
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        return new Promise<Response>((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      });
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(8_000);
        return nativeTimeout(25);
      });
      try {
        await expect(
          runWithAdapter(adapter, () =>
            auth.api.getAccessToken({
              body: { accountId: String(account.id), userId: String(account.userId) },
            }),
          ),
        ).rejects.toMatchObject({ body: { code: "FAILED_TO_GET_ACCESS_TOKEN" } });
        expect(signal?.aborted).toBe(true);
        expect(timeout).toHaveBeenCalledExactlyOnceWith(8_000);
        expect(tx.account.update).not.toHaveBeenCalled();
        expect(stored).toEqual(before);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it.each([
    "issuer change",
    "discovery redirect",
    "HTTP endpoint",
    "credential endpoint",
    "fragment endpoint",
    "token redirect",
    "token error",
  ])("rejects refresh %s without replacing the stored grant", async (failure) => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    account.accessTokenExpiresAt = new Date(0);
    const before = structuredClone(account);
    const { adapter, stored, tx } = await tokenTransaction(account);
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("openid-configuration")) {
        if (failure === "issuer change")
          return json({
            issuer: "https://other.example.test",
            token_endpoint: `${issuer}/token`,
          });
        if (failure === "discovery redirect")
          return new Response(null, {
            status: 302,
            headers: { location: `${issuer}/elsewhere` },
          });
        if (failure.endsWith("endpoint"))
          return json({
            issuer,
            token_endpoint:
              failure === "HTTP endpoint"
                ? "http://identity.example.test/token"
                : failure === "credential endpoint"
                  ? "https://client:secret@identity.example.test/token"
                  : `${issuer}/token#fragment`,
          });
      }
      return original(input, init);
    });
    if (failure === "token redirect")
      refreshTokenRequest.mockResolvedValue(
        new Response(null, { status: 302, headers: { location: `${issuer}/elsewhere` } }),
      );
    if (failure === "token error")
      refreshTokenRequest.mockResolvedValue(
        json({ access_token: "must-not-be-stored", error: "invalid_grant" }),
      );

    await expect(
      runWithAdapter(adapter, () =>
        auth.api.getAccessToken({
          body: { accountId: String(account.id), userId: String(account.userId) },
        }),
      ),
    ).rejects.toMatchObject({ body: { code: "FAILED_TO_GET_ACCESS_TOKEN" } });
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(stored).toEqual(before);
    if (
      failure === "issuer change" ||
      failure === "discovery redirect" ||
      failure.endsWith("endpoint")
    )
      expect(refreshTokenRequest).not.toHaveBeenCalled();
  });

  it("keeps native account refresh reads and encrypted writes on the supplied Prisma adapter", async () => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    cookies = "";
    await signIn({ sub: "subject-2", email: "other@example.test", email_verified: true });
    const other = rows("account").find((row) => row.userId !== account.userId)!;
    account.accessTokenExpiresAt = new Date(0);
    const { adapter, stored, tx } = await tokenTransaction(account);

    await expect(
      runWithAdapter(adapter, () =>
        auth.api.getAccessToken({
          body: { accountId: String(account.id), userId: String(account.userId) },
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "rotated-access-token" });
    expect(tx.account.findMany).toHaveBeenCalledTimes(1);
    expect(tx.account.findMany).toHaveBeenLastCalledWith({
      where: { userId: { equals: account.userId } },
      take: 100,
      skip: 0,
      select: undefined,
    });
    expect(tx.account.update).toHaveBeenCalledTimes(1);
    expect(stored.accessToken).not.toBe("rotated-access-token");
    expect(stored.refreshToken).not.toBe("rotated-refresh-token");
    expect(stored.accessToken).not.toBe(account.accessToken);
    expect(stored.refreshToken).not.toBe(account.refreshToken);
    await expect(
      runWithAdapter(adapter, () =>
        auth.api.getAccessToken({
          body: { accountId: String(account.id), userId: String(other.userId) },
        }),
      ),
    ).rejects.toMatchObject({ body: { code: "ACCOUNT_NOT_FOUND" } });
    expect(tx.account.findMany).toHaveBeenLastCalledWith({
      where: { userId: { equals: other.userId } },
      take: 100,
      skip: 0,
      select: undefined,
    });
    expect(tx.account.update).toHaveBeenCalledTimes(1);
    expect(refreshTokenRequest).toHaveBeenCalledTimes(1);
    await expect(
      auth.api.getAccessToken({
        body: { accountId: String(account.id), userId: String(account.userId) },
      }),
    ).rejects.toThrow("Root adapter used inside token transaction");
  });

  it.each(["provider failure", "transport cancellation"])(
    "does not write account tokens after native refresh %s",
    async (failure) => {
      setup();
      await signIn();
      const account = rows("account")[0]!;
      account.accessTokenExpiresAt = new Date(0);
      const before = structuredClone(account);
      const { adapter, stored, tx } = await tokenTransaction(account);
      if (failure === "provider failure")
        refreshTokenRequest.mockResolvedValue(json({ error: "temporarily_unavailable" }, 503));
      else refreshTokenRequest.mockRejectedValue(new DOMException("Aborted", "AbortError"));

      await expect(
        runWithAdapter(adapter, () =>
          auth.api.getAccessToken({
            body: { accountId: String(account.id), userId: String(account.userId) },
          }),
        ),
      ).rejects.toMatchObject({ body: { code: "FAILED_TO_GET_ACCESS_TOKEN" } });
      expect(tx.account.findMany).toHaveBeenCalledTimes(1);
      expect(tx.account.update).not.toHaveBeenCalled();
      expect(stored).toEqual(before);
      expect(account).toEqual(before);
    },
  );

  it("persists successful native rotation when caller cancellation cannot be forwarded", async () => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    account.accessTokenExpiresAt = new Date(0);
    const { adapter, stored, tx } = await tokenTransaction(account);
    const caller = new AbortController();
    refreshTokenRequest.mockImplementation(async (init?: RequestInit) => {
      expect(init?.signal).not.toBe(caller.signal);
      caller.abort();
      expect(init?.signal?.aborted).not.toBe(true);
      return json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 300,
      });
    });

    // Native getAccessToken has no AbortSignal input; do not race a rotating grant.
    await expect(
      runWithAdapter(adapter, () =>
        auth.api.getAccessToken({
          body: { accountId: String(account.id), userId: String(account.userId) },
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "rotated-access-token" });
    expect(caller.signal.aborted).toBe(true);
    expect(tx.account.update).toHaveBeenCalledTimes(1);
    expect(stored.accessToken).not.toBe(account.accessToken);
    await expect(
      runWithAdapter(adapter, () =>
        auth.api.getAccessToken({
          body: { accountId: String(account.id), userId: String(account.userId) },
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "rotated-access-token" });
    expect(refreshTokenRequest).toHaveBeenCalledTimes(1);
  });

  it("encrypts upstream tokens and resolves them only for the selected native account owner", async () => {
    setup();
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
    const account = rows("account")[0]!;
    expect(account).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      accountId: oidcAccountSubject(issuer, "subject-1"),
    });
    expect(account.accessToken).not.toBe("fake-access-token");
    expect(account.refreshToken).not.toBe("fake-refresh-token");
    await expect(
      auth.api.getAccessToken({
        body: { accountId: String(account.id), userId: String(account.userId) },
      }),
    ).resolves.toMatchObject({ accessToken: "fake-access-token" });

    cookies = "";
    await signIn({ sub: "subject-2", email: "other@example.test", email_verified: true });
    const other = rows("account").find((row) => row.userId !== account.userId)!;
    await expect(
      auth.api.getAccessToken({
        body: { accountId: String(account.id), userId: String(other.userId) },
      }),
    ).rejects.toMatchObject({ body: { code: "ACCOUNT_NOT_FOUND" } });
  });

  it.each([true, false, undefined])(
    "preserves email_verified=%s through the real callback",
    async (verified) => {
      setup();
      const response = await signIn({
        sub: "subject-1",
        email: "sso@example.test",
        ...(verified === undefined ? {} : { email_verified: verified }),
      });
      expect(response.headers.get("location")).toBe(`${origin}/app`);
      expect(rows("user")).toHaveLength(1);
      expect(rows("user")[0]?.emailVerified).toBe(verified === true);
      expect(rows("account")).toHaveLength(1);
    },
  );
  it.each([false, undefined])(
    "downgrades a previously verified OIDC email when the claim becomes %s",
    async (verified) => {
      setup();
      await signIn();
      await signIn({ sub: "subject-1", email: "sso@example.test", email_verified: verified });
      expect(rows("user")[0]?.emailVerified).toBe(false);
    },
  );
  it("rejects a changed provider email that collides with another account", async () => {
    setup();
    await signIn();
    cookies = "";
    await request("/sign-up/email", {
      email: "local@example.test",
      password: "test-password-123",
      name: "Local",
    });
    cookies = "";
    const response = await signIn({
      sub: "subject-1",
      email: "local@example.test",
      email_verified: true,
    });
    expect(response.headers.get("location")).toContain("error=account_not_linked");
    expect(rows("account")).toHaveLength(2);
  });
  it.each([true, false, undefined])(
    "refuses email collisions without any link (verified=%s)",
    async (verified) => {
      setup();
      const local = await request("/sign-up/email", {
        email: "sso@example.test",
        password: "test-password-123",
        name: "Local",
      });
      expect(local.status).toBe(200);
      cookies = "";
      const response = await signIn({
        sub: "different-subject",
        email: "sso@example.test",
        email_verified: verified,
      });
      expect(response.headers.get("location")).toContain("error=account_not_linked");
      expect(rows("user")).toHaveLength(1);
      expect(rows("account")).toHaveLength(1);
      expect(rows("account")[0]?.providerId).toBe("credential");
    },
  );
  it("does not reuse identities after changing the configured issuer", async () => {
    setup();
    await signIn();
    auth.disposeOidcDiscovery();
    cookies = "";
    activeIssuer = "https://other-identity.example.test";
    setup({
      oidc: {
        issuer: activeIssuer,
        clientId: "test-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: false,
      },
    });
    expect((await signIn()).headers.get("location")).toContain("error=account_not_linked");
    expect(rows("user")).toHaveLength(1);
    expect(rows("account")).toHaveLength(1);
  });
  it("does not mark an old client account as the current SSO link", async () => {
    setup();
    await signIn();
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    auth.disposeOidcDiscovery();
    setup({
      oidc: {
        issuer,
        clientId: "replacement-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: false,
      },
    });
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: false });
    expect(rows("user")).toHaveLength(1);
    expect(rows("account")).toHaveLength(1);
  });
  it("links only through an authenticated link flow", async () => {
    setup();
    expect(
      (await request("/link-social", { provider: "oidc", callbackURL: `${origin}/app` })).status,
    ).toBe(401);
    await request("/sign-up/email", {
      email: "sso@example.test",
      password: "test-password-123",
      name: "Local",
    });
    const response = await request(await start(undefined, true));
    expect(response.headers.get("location")).toBe(`${origin}/app`);
    expect(rows("account")).toHaveLength(2);
    expect(new Set(rows("account").map((account) => account.userId)).size).toBe(1);
  });
  it("offers linking after issuer replacement, retains old links, and preserves linking safety", async () => {
    setup();
    await request("/sign-up/email", {
      email: "sso@example.test",
      password: "test-password-123",
      name: "Local",
    });
    await request(await start(undefined, true));
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    const oldAccountId = rows("account").find(
      (account) => account.providerId === "oidc",
    )!.accountId;
    auth.disposeOidcDiscovery();
    activeIssuer = "https://replacement.example.test";
    setup({
      oidc: {
        issuer: activeIssuer,
        clientId: "test-client",
        clientSecret: "test-client-secret",
        name: "Replacement",
        scopes: ["openid"],
        allowSignupBypass: false,
      },
    });
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: false });
    const rejected = await request(
      await start({ sub: "subject-1", email: "sso@example.test", email_verified: false }, true),
    );
    expect(rejected.headers.get("location")).toContain("error=unable_to_link_account");
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: false });
    const mismatch = await request(
      await start(
        { sub: "subject-1", email: "different@example.test", email_verified: true },
        true,
      ),
    );
    expect(mismatch.headers.get("location")).toContain("error=");
    const linked = await request(await start(undefined, true));
    expect(linked.headers.get("location")).toBe(`${origin}/app`);
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    expect(rows("account").filter((account) => account.providerId === "oidc")).toHaveLength(2);
    expect(rows("account").some((account) => account.accountId === oldAccountId)).toBe(true);
    expect(new Set(rows("account").map((account) => account.userId)).size).toBe(1);
  });
  it.each([false, undefined])("refuses unverified explicit linking (%s)", async (verified) => {
    setup();
    await request("/sign-up/email", {
      email: "sso@example.test",
      password: "test-password-123",
      name: "Local",
    });
    const response = await request(
      await start({ sub: "subject-1", email: "sso@example.test", email_verified: verified }, true),
    );
    expect(response.headers.get("location")).toContain("error=unable_to_link_account");
    expect(rows("account")).toHaveLength(1);
  });
  it("hands the native browser callback to Expo with a valid bearer session", async () => {
    setup();
    const callback = await start(undefined, false, "rakazo://sign-in");
    const authorize = `${issuer}/authorize?state=${new URL(`${origin}${callback}`).searchParams.get("state")}`;
    const proxy = await request(
      `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: authorize })}`,
    );
    expect(proxy.headers.get("location")).toBe(authorize);
    const returned = await request(callback);
    const destination = new URL(returned.headers.get("location")!);
    expect(destination.protocol).toBe("rakazo:");
    const signed = destination.searchParams
      .get("cookie")!
      .match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/)![1]!;
    cookies = "";
    const session = await request("/get-session", undefined, decodeURIComponent(signed));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: "sso@example.test" } });
  });
  it("enforces the allowlist before inserting a user", async () => {
    setup({ signupAllowlist: "allowed@example.test" });
    expect((await signIn()).headers.get("location")).toContain("error=EMAIL_NOT_ALLOWED");
    expect(rows("user")).toHaveLength(0);
    expect(rows("account")).toHaveLength(0);
  });
  it("admits allowlisted verified identities", async () => {
    setup({ signupAllowlist: "sso@example.test" });
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
  });
  it("never upgrades an unverified allowlisted identity", async () => {
    setup({ signupAllowlist: "sso@example.test" });
    expect(
      (
        await signIn({ sub: "subject-1", email: "sso@example.test", email_verified: false })
      ).headers.get("location"),
    ).toContain("error=EMAIL_VERIFICATION_REQUIRED");
    expect(rows("user")).toHaveLength(0);
  });
  it("bypasses the allowlist only with opt-in", async () => {
    setup({
      signupAllowlist: "allowed@example.test",
      oidc: {
        issuer,
        clientId: "test-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: true,
      },
    });
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
  });
  it.each([false, true])("closed registration stays closed with bypass=%s", async (bypass) => {
    setup({
      signupsEnabled: "false",
      oidc: {
        issuer,
        clientId: "test-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: bypass,
      },
    });
    expect((await signIn()).headers.get("location")).toContain("error=REGISTRATION_CLOSED");
    expect(rows("user")).toHaveLength(0);
  });
  it("rejects state replay", async () => {
    setup();
    const callback = await start();
    expect((await request(callback)).headers.get("location")).toBe(`${origin}/app`);
    expect((await request(callback)).headers.get("location")).toContain("error=");
    expect(rows("session")).toHaveLength(1);
  });
  it("rejects a code issued to a different PKCE challenge", async () => {
    setup();
    const callback = await start();
    const value = codes.get("code-1")!;
    value.challenge = "wrong-challenge";
    expect((await request(callback)).headers.get("location")).toContain("error=invalid_code");
    expect(rows("user")).toHaveLength(0);
  });
  it("rejects a token with an invalid nonce", async () => {
    setup();
    const callback = await start();
    codes.get("code-1")!.nonce = "wrong-nonce";
    expect((await request(callback)).headers.get("location")).toContain(
      "error=unable_to_get_user_info",
    );
    expect(rows("user")).toHaveLength(0);
  });
  it("rejects a token with an invalid signature", async () => {
    setup();
    corruptSignature = true;
    expect((await signIn()).headers.get("location")).toContain("error=unable_to_get_user_info");
    expect(rows("user")).toHaveLength(0);
  });
  it("requires an ID token rather than downgrading to plain OAuth", async () => {
    setup();
    omitIdToken = true;
    expect((await signIn()).headers.get("location")).toContain("error=unable_to_get_user_info");
    expect(rows("user")).toHaveLength(0);
  });
  it("boots SSO-only while discovery is down and recovers without restart", async () => {
    vi.useFakeTimers();
    discoveryDown = true;
    setup({ passwordAuth: false });
    expect(
      (await request("/sign-in/social", { provider: "oidc", callbackURL: `${origin}/app` })).status,
    ).toBe(503);
    expect(auth.ssoAvailability()).toBe("unavailable");
    discoveryDown = false;
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
    expect(auth.ssoAvailability()).toBe("available");
  });
  it("rejects password auth when disabled", async () => {
    setup({ passwordAuth: false });
    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/set-password",
    ]) {
      expect(
        (await request(path, { email: "local@example.test", password: "test-password-123" }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(rows("user")).toHaveLength(0);
  });
  it("refuses password-off without an alternative", () => {
    expect(() => setup({ passwordAuth: false, oidc: undefined })).toThrow(/requires OIDC/);
  });
});

describe("SSO-only account deletion", () => {
  it("allows a fresh provider sign-in and removes the account", async () => {
    setup();
    await signIn();
    expect((await request("/delete-user", {})).status).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("refuses a stale session, then accepts fresh reauthentication", async () => {
    setup();
    await signIn();
    expireOidcProofs();
    expect((await request("/delete-user", {})).status).toBe(403);
    await signIn();
    expect((await request("/delete-user", {})).status).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("accepts an emailed deletion code from a stale bearer session", async () => {
    setup();
    await signIn();
    const sessionToken = String(rows("session")[0]!.token);
    expireOidcProofs();
    cookies = "";
    expect((await request("/delete-user", { token: "wrong-code" }, sessionToken)).status).not.toBe(
      200,
    );
    expect((await request("/request-account-deletion", {}, sessionToken)).status).toBe(200);
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    const deleted = await request("/delete-user", { token: code }, sessionToken);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("binds provider reauthentication to the signed-in account", async () => {
    setup();
    await signIn();
    const rejected = await request(
      await start(
        { sub: "other-subject", email: "other@example.test", email_verified: true },
        false,
        `${origin}/app`,
        true,
      ),
    );
    expect(rejected.headers.get("location")).toContain("error=REAUTHENTICATION_REQUIRED");
    expect(rows("user")).toHaveLength(1);
    expect(rows("session")).toHaveLength(1);
    const confirmed = await request(await start(undefined, false, `${origin}/app`, true));
    expect(confirmed.headers.get("location")).toBe(`${origin}/app`);
    expect((await request("/delete-user", {})).status).toBe(200);
  });
  it("refuses newly minted sessions that did not authenticate with OIDC", async () => {
    setup();
    await signIn();
    // A valid server-side session alone must not manufacture provider proof.
    state.db.session!.push({
      ...rows("session")[0],
      id: "unproven-session",
      token: "unproven-token",
      createdAt: new Date(),
    });
    cookies = "";
    expect((await request("/delete-user", {}, "unproven-token")).status).toBe(403);
    expect(rows("user")).toHaveLength(1);
  });
  it("rejects expired and wrong-account deletion codes", async () => {
    setup();
    await signIn();
    await request("/request-account-deletion", {});
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    const verification = rows("verification").find((value) =>
      String(value.identifier).includes(code),
    )!;
    verification.expiresAt = new Date(0);
    expect((await request("/delete-user", { token: code })).status).not.toBe(200);
    await request("/request-account-deletion", {});
    const otherCode = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    cookies = "";
    await signIn({ sub: "subject-2", email: "other@example.test", email_verified: true });
    expect((await request("/delete-user", { token: otherCode })).status).not.toBe(200);
    expect(rows("user")).toHaveLength(2);
  });
  it.each([true, false])(
    "keeps password deletion for credential accounts (password auth: %s)",
    async (passwordAuth) => {
      setup();
      await request("/sign-up/email", {
        email: "local@example.test",
        password: "test-password-123",
        name: "Local",
      });
      setup({ passwordAuth });
      expect(await (await request("/account-security")).json()).toMatchObject({
        hasPassword: true,
        passwordChangeEnabled: passwordAuth,
      });
      if (!passwordAuth) {
        expect(
          (
            await request("/change-password", {
              currentPassword: "test-password-123",
              newPassword: "new-password-123",
            })
          ).status,
        ).toBe(403);
      }
      expect((await request("/request-account-deletion", {})).status).toBe(400);
      expect((await request("/delete-user", {})).status).toBe(400);
      expect((await request("/delete-user", { password: "wrong-password" })).status).toBe(400);
      expect((await request("/delete-user", { password: "test-password-123" })).status).toBe(200);
    },
  );
});

it("counts only stored OIDC subjects bound to the current issuer and client", () => {
  const account = {
    providerId: "oidc",
    accountId: oidcAccountSubject(issuer, "subject-1"),
    idToken: jwt({ sub: "subject-1" }),
  };
  expect(isCurrentOidcAccount(account, issuer, "test-client")).toBe(true);
  expect(isCurrentOidcAccount(account, issuer, "replacement-client")).toBe(false);
  expect(isCurrentOidcAccount(account, issuer, undefined)).toBe(false);
  expect(isCurrentOidcAccount(account, undefined, "test-client")).toBe(false);
  expect(isCurrentOidcAccount(account, "https://replacement.example.test", "test-client")).toBe(
    false,
  );
  expect(
    isCurrentOidcAccount({ ...account, providerId: "credential" }, issuer, "test-client"),
  ).toBe(false);
  expect(isCurrentOidcAccount({ ...account, accountId: "unbound" }, issuer, "test-client")).toBe(
    false,
  );
  expect(isCurrentOidcAccount({ ...account, idToken: null }, issuer, "test-client")).toBe(false);
  expect(isCurrentOidcAccount({ ...account, idToken: "malformed" }, issuer, "test-client")).toBe(
    false,
  );
});

it.each([
  ["single audience", { aud: "test-client" }, true],
  ["single audience array", { aud: ["test-client"] }, true],
  ["single authorized party", { aud: "test-client", azp: "test-client" }, true],
  [
    "multiple authorized audiences",
    { aud: ["other-client", "test-client"], azp: "test-client" },
    true,
  ],
  ["wrong audience", { aud: "other-client" }, false],
  ["missing audience", { aud: undefined }, false],
  ["empty audience", { aud: [] }, false],
  ["numeric audience", { aud: 1 }, false],
  ["object audience", { aud: { client: "test-client" } }, false],
  ["malformed audience array", { aud: ["test-client", null], azp: "test-client" }, false],
  ["empty audience entry", { aud: ["test-client", ""], azp: "test-client" }, false],
  ["multiple audiences without authorized party", { aud: ["test-client", "other-client"] }, false],
  ["wrong authorized party", { aud: ["test-client", "other-client"], azp: "other-client" }, false],
  ["wrong single authorized party", { aud: "test-client", azp: "other-client" }, false],
  ["null authorized party", { aud: "test-client", azp: null }, false],
] as const)("checks the stored OIDC %s", (_label, claims, accepted) => {
  expect(
    isCurrentOidcAccount(
      {
        providerId: "oidc",
        accountId: oidcAccountSubject(issuer, "subject-1"),
        idToken: jwt({ sub: "subject-1", ...claims }),
      },
      issuer,
      "test-client",
    ),
  ).toBe(accepted);
});

describe("first-party CRM native OIDC access", () => {
  function dbForToken(tx: Record<string, unknown>, stored: Record<string, unknown>) {
    let tail = Promise.resolve();
    const queryRaw = vi.fn(async (query: { strings?: string[] }) =>
      String(query.strings?.join(" ")).includes("space_members")
        ? [{ userId: stored.userId, spaceId: "space-1" }]
        : [structuredClone(stored)],
    );
    Object.assign(tx, { $executeRaw: vi.fn(async () => 0), $queryRaw: queryRaw });
    return {
      queryRaw,
      $transaction: vi.fn((run: (client: unknown) => Promise<unknown>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        return previous.then(() => run(tx)).finally(release);
      }),
    };
  }

  it("shares existing OIDC env validation without inventing another login configuration", () => {
    expect(oidcConfigFromEnv({})).toBeUndefined();
    expect(() => oidcConfigFromEnv({ OIDC_CLIENT_ID: "id" })).toThrow(
      "must be configured together",
    );
    expect(() => oidcConfigFromEnv({ AUTH_PASSWORD_ENABLED: "false" })).toThrow(
      "requires OIDC configuration",
    );
    expect(
      oidcConfigFromEnv({
        OIDC_ISSUER: issuer,
        OIDC_CLIENT_ID: "test-client",
        OIDC_CLIENT_SECRET: "test-client-secret",
      }),
    ).toMatchObject({ issuer, scopes: ["openid", "email", "profile"] });
  });

  it("uses the native encrypted account adapter and adopts one rotation for concurrent readers and stale 401s", async () => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    account.accessTokenExpiresAt = new Date(0);
    const { stored, tx } = await tokenTransaction(account);
    const prisma = dbForToken(tx, stored);
    const context = { userId: String(account.userId), spaceId: "space-1" };
    const [a, b] = await Promise.all([
      getOidcAccessToken(
        prisma as never,
        auth,
        {
          issuer,
          clientId: "test-client",
          clientSecret: "test-client-secret",
          name: "SSO",
          scopes: ["openid", "email", "profile"],
          allowSignupBypass: false,
        },
        context,
      ),
      getOidcAccessToken(
        prisma as never,
        auth,
        {
          issuer,
          clientId: "test-client",
          clientSecret: "test-client-secret",
          name: "SSO",
          scopes: ["openid", "email", "profile"],
          allowSignupBypass: false,
        },
        context,
      ),
    ]);
    expect([a, b]).toEqual(["rotated-access-token", "rotated-access-token"]);
    expect(refreshTokenRequest).toHaveBeenCalledTimes(1);
    expect(stored.accessToken).not.toBe("rotated-access-token");
    expect(stored.refreshToken).not.toBe("rotated-refresh-token");
    await expect(
      getOidcAccessToken(
        prisma as never,
        auth,
        {
          issuer,
          clientId: "test-client",
          clientSecret: "test-client-secret",
          name: "SSO",
          scopes: ["openid", "email", "profile"],
          allowSignupBypass: false,
        },
        context,
        "fake-access-token",
      ),
    ).resolves.toBe("rotated-access-token");
    expect(refreshTokenRequest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(prisma.queryRaw.mock.calls)).toContain("FOR UPDATE");
  });

  it("refreshes a still-current 401 grant through native encrypted persistence, but never retries a failing rotation", async () => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    const { stored, tx } = await tokenTransaction(account);
    const prisma = dbForToken(tx, stored);
    const config = {
      issuer,
      clientId: "test-client",
      clientSecret: "test-client-secret",
      name: "SSO",
      scopes: ["openid", "email", "profile"],
      allowSignupBypass: false,
    };
    const context = { userId: String(account.userId), spaceId: "space-1" };
    await expect(
      getOidcAccessToken(prisma as never, auth, config, context, "fake-access-token"),
    ).resolves.toBe("rotated-access-token");
    expect(refreshTokenRequest).toHaveBeenCalledTimes(1);
    const saved = structuredClone(stored);
    refreshTokenRequest.mockImplementation(async (init) => {
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(
        "rotated-refresh-token",
      );
      return json({ error: "temporarily_unavailable" }, 503);
    });
    await expect(
      getOidcAccessToken(prisma as never, auth, config, context, "rotated-access-token"),
    ).rejects.toMatchObject({ body: { code: "FAILED_TO_REFRESH_ACCESS_TOKEN" } });
    expect(refreshTokenRequest).toHaveBeenCalledTimes(2);
    expect(stored).toEqual(saved);
  });

  it("publishes a native successful rotation before honoring caller cancellation", async () => {
    setup();
    await signIn();
    const account = rows("account")[0]!;
    account.accessTokenExpiresAt = new Date(0);
    const { stored, tx } = await tokenTransaction(account);
    const prisma = dbForToken(tx, stored);
    const caller = new AbortController();
    const native = refreshTokenRequest.getMockImplementation()!;
    refreshTokenRequest.mockImplementation(async (init) => {
      caller.abort();
      return native(init);
    });
    const config = {
      issuer,
      clientId: "test-client",
      clientSecret: "test-client-secret",
      name: "SSO",
      scopes: ["openid", "email", "profile"],
      allowSignupBypass: false,
    };
    await expect(
      getOidcAccessToken(prisma as never, auth, config, {
        userId: String(account.userId),
        spaceId: "space-1",
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const writes = tx.account.update.mock.calls.length;
    expect(writes).toBe(1);
    await expect(
      getOidcAccessToken(prisma as never, auth, config, {
        userId: String(account.userId),
        spaceId: "space-1",
      }),
    ).resolves.toBe("rotated-access-token");
    expect(refreshTokenRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["membership", "owner", "client", "issuer", "expired-without-refresh"])(
    "rejects invalid %s before CRM dispatch",
    async (failure) => {
      setup();
      await signIn();
      const account = rows("account")[0]!;
      const { stored, tx } = await tokenTransaction(account);
      const prisma = dbForToken(tx, stored);
      if (failure === "membership") prisma.queryRaw.mockResolvedValueOnce([]);
      if (failure === "owner") stored.userId = "another-user";
      if (failure === "expired-without-refresh") {
        stored.accessTokenExpiresAt = new Date(0);
        stored.refreshToken = null;
      }
      const config = {
        issuer,
        clientId: "test-client",
        clientSecret: "test-client-secret",
        name: "SSO",
        scopes: ["openid", "email", "profile"],
        allowSignupBypass: false,
      };
      if (failure === "client") config.clientId = "another-client";
      if (failure === "issuer") config.issuer = "https://another.example.test";
      await expect(
        getOidcAccessToken(prisma as never, auth, config, {
          userId: String(account.userId),
          spaceId: "space-1",
        }),
      ).rejects.toThrow();
      expect(refreshTokenRequest).not.toHaveBeenCalled();
    },
  );
});

describe("read-only product OIDC connection metadata", () => {
  const config = { issuer, clientId: "test-client" };
  const context = { userId: "product-user", spaceId: "product-space" };
  function metadata(extra: Record<string, unknown> = {}) {
    return {
      id: "product-account",
      userId: context.userId,
      providerId: "oidc",
      accountId: oidcAccountSubject(issuer, "subject-1"),
      idToken: jwt({ sub: "subject-1", aud: config.clientId }),
      hasAccessToken: true,
      hasRefreshToken: true,
      accessTokenExpiresAt: new Date(Date.now() + 60_000) as Date | null,
      refreshTokenExpiresAt: null as Date | null,
      ...extra,
    };
  }
  function client(rows: ReturnType<typeof metadata>[]) {
    return {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ userId: context.userId, spaceId: context.spaceId }])
        .mockResolvedValueOnce(rows),
      $transaction: vi.fn(),
    };
  }
  it("reports an issuer/client-bound current account without decrypting or refreshing any grant", async () => {
    const prisma = client([metadata()]);
    expect(await getOidcAccountStatus(prisma as never, config, context)).toBe("connected");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const sql = prisma.$queryRaw.mock.calls[1]![0].sql as string;
    expect(sql).toContain('"accessToken" IS NOT NULL');
    expect(sql).toContain('"refreshToken" IS NOT NULL');
    expect(sql).not.toContain('SELECT "accessToken"');
  });
  it.each([
    "missing",
    "unlink",
    "owner",
    "issuer",
    "client",
    "expired",
    "expired-refresh",
    "missing-expiry",
    "invalid-expiry",
    "empty-token",
    "ambiguous",
  ])("does not claim a valid connection for %s account metadata", async (failure) => {
    const row = metadata();
    if (failure === "owner") row.userId = "another-user";
    if (failure === "issuer")
      row.accountId = oidcAccountSubject("https://other.example.test", "subject-1");
    if (failure === "client") row.idToken = jwt({ sub: "subject-1", aud: "other-client" });
    if (failure === "expired" || failure === "expired-refresh")
      row.accessTokenExpiresAt = new Date(0);
    if (failure === "expired") row.hasRefreshToken = false;
    if (failure === "missing-expiry") row.accessTokenExpiresAt = null;
    if (failure === "invalid-expiry") row.accessTokenExpiresAt = new Date(Number.NaN);
    if (failure === "empty-token") {
      row.hasAccessToken = false;
      row.hasRefreshToken = false;
    }
    if (failure === "expired-refresh") row.refreshTokenExpiresAt = new Date(0);
    const rows =
      failure === "missing" || failure === "unlink"
        ? []
        : failure === "ambiguous"
          ? [row, row]
          : [row];
    expect(await getOidcAccountStatus(client(rows) as never, config, context)).toBe("reconnect");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("recognizes refreshable expiry without exercising that refresh and rejects a removed Space membership", async () => {
    expect(
      await getOidcAccountStatus(
        client([metadata({ accessTokenExpiresAt: new Date(0) })]) as never,
        config,
        context,
      ),
    ).toBe("connected");
    const prisma = client([]);
    prisma.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(getOidcAccountStatus(prisma as never, config, context)).rejects.toThrow();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
