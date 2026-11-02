import type * as Db from "@rakazo/db";
import { bootstrapUserSpace } from "@rakazo/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import type * as PrismaAdapterModule from "better-auth/adapters/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "./index.js";
import { createAuth } from "./index.js";

const state = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("better-auth/adapters/prisma", async (original) => {
  const native = await original<typeof PrismaAdapterModule>();
  return {
    prismaAdapter: (prisma: object, options: Parameters<typeof native.prismaAdapter>[1]) =>
      "$queryRaw" in prisma ? native.prismaAdapter(prisma, options) : memoryAdapter(state.db),
  };
});
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
}));

const origin = "https://rakazo.example.test";
let auth: Auth;
let cookies: string;
let policy: { signupsEnabled: boolean; signupAllowlist: string };
let claims: Record<string, unknown>;
const ensureUserSpace = vi.fn(async () => undefined);

function idToken(body: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({
    iss: "https://accounts.google.com",
    aud: "google-client",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...body,
  })}.signature`;
}

async function request(path: string, body?: unknown) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookies ? { cookie: cookies } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const jar = new Map(
    cookies
      .split("; ")
      .filter(Boolean)
      .map((item) => item.split("=") as [string, string]),
  );
  for (const cookie of response.headers.getSetCookie()) {
    const [key, value] = cookie.split(";")[0]!.split("=");
    if (key) jar.set(key, value ?? "");
  }
  cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  return response;
}

async function signInWithGoogle() {
  const started = await request("/sign-in/social", {
    provider: "google",
    callbackURL: `${origin}/app`,
    newUserCallbackURL: `${origin}/onboarding`,
    errorCallbackURL: `${origin}/sign-in`,
    disableRedirect: true,
  });
  expect(started.status, await started.clone().text()).toBe(200);
  const url = new URL(((await started.json()) as { url: string }).url);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/google`);
  expect(url.searchParams.get("prompt")).toBe("select_account");
  return request(`/callback/google?state=${url.searchParams.get("state")}&code=google-code`);
}

describe("Google sign-in", () => {
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
    cookies = "";
    policy = { signupsEnabled: true, signupAllowlist: "*" };
    claims = { sub: "google-1", email: "new@gmail.test", email_verified: true, name: "New" };
    vi.mocked(bootstrapUserSpace).mockClear();
    ensureUserSpace.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://oauth2.googleapis.com/token"))
          return Response.json({
            access_token: "google-access",
            expires_in: 3600,
            token_type: "Bearer",
            id_token: idToken(claims),
          });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const prisma: Record<string, unknown> = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ...policy, signupPolicyInitialized: true })),
      },
      spaceMember: { findFirst: vi.fn(async () => null) },
    };
    auth = createAuth(prisma as never, {
      secret: "offline-test-secret-with-at-least-32-characters",
      baseURL: origin,
      webOrigin: origin,
      signupsEnabled: "true",
      signupAllowlist: undefined,
      google: { clientId: "google-client", clientSecret: "google-secret" },
      ensureUserSpace,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates and provisions a verified account on first sign-in", async () => {
    const response = await signInWithGoogle();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/onboarding`);
    expect(state.db.user).toMatchObject([{ email: "new@gmail.test", emailVerified: true }]);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(ensureUserSpace).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@gmail.test" }),
      "space-1",
    );
  });

  it("refuses an unverified Google email", async () => {
    claims = { ...claims, email_verified: false };
    const response = await signInWithGoogle();
    expect(response.headers.get("location")).toContain("error=");
    expect(state.db.user).toHaveLength(0);
  });

  it("follows the signup policy", async () => {
    policy = { signupsEnabled: true, signupAllowlist: "owner@wekruit.test" };
    expect((await signInWithGoogle()).headers.get("location")).toContain("EMAIL_NOT_ALLOWED");
    cookies = "";
    policy = { signupsEnabled: false, signupAllowlist: "" };
    expect((await signInWithGoogle()).headers.get("location")).toContain("REGISTRATION_CLOSED");
    expect(state.db.user).toHaveLength(0);
  });

  it("does not take over an existing password account with the same email", async () => {
    policy = { signupsEnabled: true, signupAllowlist: "" };
    const local = await request("/sign-up/email", {
      email: "new@gmail.test",
      password: "test-password-123",
      name: "Local",
    });
    expect(local.status).toBe(200);
    cookies = "";
    const response = await signInWithGoogle();
    expect(response.headers.get("location")).toContain("account_not_linked");
    expect(state.db.account).toHaveLength(1);
  });
});
