import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFirstPartyAccessToken,
  firstPartySessionConfigFromEnv,
} from "./first-party-session.js";
import type { OidcConfig } from "./oidc.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  requireMembership: vi.fn(async () => undefined),
}));

const oidc: OidcConfig = {
  issuer: "https://crm.example.test/auth/v1",
  clientId: "client",
  clientSecret: "secret",
  name: "SSO",
  scopes: ["openid"],
  allowSignupBypass: false,
};
const session = { authUrl: oidc.issuer, serviceKey: "sb_secret_placeholder" };
const context = { userId: "user-1", spaceId: "space-1" };
let user: { email: string; emailVerified: boolean } | null;
const prisma = {
  $queryRaw: vi.fn(async () => []),
  user: { findUnique: vi.fn(async () => user) },
} as unknown as PrismaClient;
const auth = {} as Parameters<typeof createFirstPartyAccessToken>[0]["auth"];

function provider() {
  let issued = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(oidc.issuer.length);
    const body = JSON.parse(String(init?.body));
    const headers = init?.headers as Record<string, string>;
    expect(headers.apikey).toBe(session.serviceKey);
    expect(headers.authorization).toBeUndefined();
    if (path === "/admin/generate_link") {
      expect(body).toEqual({ type: "magiclink", email: "recruiter@example.test" });
      return Response.json({ hashed_token: `hash-${++issued}`, verification_type: "magiclink" });
    }
    if (path === "/verify")
      return Response.json({ access_token: `token-${body.token_hash}`, expires_in: 3600 });
    return new Response(null, { status: 404 });
  });
}

describe("first-party CRM session", () => {
  beforeEach(() => {
    user = { email: "Recruiter@example.test", emailVerified: true };
  });

  it("reads its key only alongside the product identity provider", () => {
    expect(firstPartySessionConfigFromEnv({}, oidc)).toBeUndefined();
    expect(firstPartySessionConfigFromEnv({ FIRST_PARTY_MCP_SERVICE_KEY: "key" }, oidc)).toEqual({
      authUrl: oidc.issuer,
      serviceKey: "key",
    });
    expect(() =>
      firstPartySessionConfigFromEnv({ FIRST_PARTY_MCP_SERVICE_KEY: "key" }, undefined),
    ).toThrow();
  });

  it("signs the verified product email in without a second login and reuses the session", async () => {
    const fetch = provider();
    const token = createFirstPartyAccessToken({ prisma, auth, oidc, session, fetch });
    const [first, concurrent] = await Promise.all([token(context), token(context)]);
    expect(first).toBe("token-hash-1");
    expect(concurrent).toBe("token-hash-1");
    expect(await token(context)).toBe("token-hash-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    // A token the service rejected opens a fresh session.
    expect(await token(context, "token-hash-1")).toBe("token-hash-2");
  });

  it("never signs in an unverified email", async () => {
    user = { email: "recruiter@example.test", emailVerified: false };
    const fetch = provider();
    const token = createFirstPartyAccessToken({ prisma, auth, oidc, session, fetch });
    await expect(token(context)).rejects.toThrow("verified email");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a provider refusal without exposing it", async () => {
    const fetch = vi.fn(async () => new Response("denied", { status: 422 }));
    const token = createFirstPartyAccessToken({ prisma, auth, oidc, session, fetch });
    await expect(token(context)).rejects.toThrow("Your CRM access is unavailable right now.");
  });
});
