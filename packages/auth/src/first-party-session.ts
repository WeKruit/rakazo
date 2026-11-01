import { IsolationError, type PrismaClient, requireMembership } from "@rakazo/db";
import type { Auth } from "./index.js";
import type { OidcConfig } from "./oidc.js";
import { getOidcAccessToken, getOidcAccountStatus } from "./oidc.js";

/**
 * The first-party CRM shares the product's identity provider. With the provider's server key
 * configured, the backend opens a CRM session for the signed-in user's verified email itself,
 * so nobody signs in a second time. A linked OIDC Account still takes precedence.
 */
export interface FirstPartySessionConfig {
  /** The identity provider's auth API, i.e. the OIDC issuer (`…/auth/v1`). */
  authUrl: string;
  serviceKey: string;
}

export function firstPartySessionConfigFromEnv(
  source: Record<string, string | undefined>,
  oidc: Pick<OidcConfig, "issuer"> | undefined,
): FirstPartySessionConfig | undefined {
  const serviceKey = source.FIRST_PARTY_MCP_SERVICE_KEY?.trim();
  if (!serviceKey) return undefined;
  if (!oidc) throw new Error("FIRST_PARTY_MCP_SERVICE_KEY requires OIDC configuration");
  return { authUrl: oidc.issuer.replace(/\/+$/, ""), serviceKey };
}

type Context = { userId: string; spaceId: string; signal?: AbortSignal };
type Cached = { email: string; token: string; expiresAt: number };

const REQUEST_TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_MS = 60_000;

/** The caller's verified product email, which the backend may sign in to the CRM. */
export async function firstPartySessionEmail(prisma: PrismaClient, context: Context) {
  await requireMembership(prisma, context.userId, context.spaceId);
  const user = await prisma.user.findUnique({
    where: { id: context.userId },
    select: { email: true, emailVerified: true },
  });
  return user?.emailVerified && user.email ? user.email.toLowerCase() : undefined;
}

/** The first-party MCP token source: the linked OIDC Account first, else a backend session. */
export function createFirstPartyAccessToken(deps: {
  prisma: PrismaClient;
  auth: Pick<Auth, "api" | "options">;
  oidc: OidcConfig;
  session?: FirstPartySessionConfig;
  fetch?: typeof fetch;
}) {
  const { prisma, oidc, session } = deps;
  const request = deps.fetch ?? fetch;
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<Cached>>();

  async function post(path: string, body: unknown, signal?: AbortSignal) {
    const config = session!;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      apikey: config.serviceKey,
    };
    // Legacy JWT service keys also authenticate as the bearer; new secret keys use apikey only.
    if (!config.serviceKey.startsWith("sb_")) headers.authorization = `Bearer ${config.serviceKey}`;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await request(`${config.authUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new IsolationError("Your CRM access is unavailable right now.");
    return (await response.json()) as Record<string, unknown>;
  }

  async function open(email: string, signal?: AbortSignal): Promise<Cached> {
    // An admin link is never mailed: the backend redeems it at once for the user's own session.
    const link = await post("/admin/generate_link", { type: "magiclink", email }, signal);
    const hashed = link.hashed_token ?? (link.properties as Record<string, unknown>)?.hashed_token;
    const type =
      link.verification_type ??
      (link.properties as Record<string, unknown>)?.verification_type ??
      "magiclink";
    if (typeof hashed !== "string" || !hashed)
      throw new IsolationError("Your CRM access is unavailable right now.");
    const opened = await post("/verify", { type, token_hash: hashed }, signal);
    const token = opened.access_token;
    const expiresIn = Number(opened.expires_in);
    if (typeof token !== "string" || !token || !Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new IsolationError("Your CRM access is unavailable right now.");
    return { email, token, expiresAt: Date.now() + expiresIn * 1_000 };
  }

  async function sessionToken(context: Context, rejectedToken?: string) {
    const email = await firstPartySessionEmail(prisma, context);
    if (!email) throw new IsolationError("Your CRM access needs a verified email.");
    const cached = cache.get(context.userId);
    if (
      cached &&
      cached.email === email &&
      cached.token !== rejectedToken &&
      cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
    )
      return cached.token;
    cache.delete(context.userId);
    let opening = pending.get(context.userId);
    if (!opening) {
      opening = open(email, context.signal).finally(() => pending.delete(context.userId));
      pending.set(context.userId, opening);
    }
    const next = await opening;
    cache.set(context.userId, next);
    return next.token;
  }

  return async (context: Context, rejectedToken?: string): Promise<string> => {
    if (!session || (await getOidcAccountStatus(prisma, oidc, context)) === "connected")
      return getOidcAccessToken(prisma, deps.auth, oidc, context, rejectedToken);
    return sessionToken(context, rejectedToken);
  };
}
