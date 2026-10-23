import { createHash } from "node:crypto";
import { runWithAdapter } from "@better-auth/core/context";
import { IsolationError, Prisma, type PrismaClient, requireMembership } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { getOAuth2Tokens, refreshAccessTokenRequest } from "better-auth/oauth2";
import { genericOAuth } from "better-auth/plugins";
import type { Auth } from "./index.js";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  scopes: string[];
  allowSignupBypass: boolean;
}

/** API and worker read exactly the same existing product sign-in configuration. */
export function oidcConfigFromEnv(
  source: Record<string, string | undefined>,
): OidcConfig | undefined {
  const optional = (value: string | undefined) => value?.trim() || undefined;
  const issuer = optional(source.OIDC_ISSUER);
  const clientId = optional(source.OIDC_CLIENT_ID);
  const clientSecret = optional(source.OIDC_CLIENT_SECRET);
  const credentials = [issuer, clientId, clientSecret];
  if (credentials.some(Boolean) && !credentials.every(Boolean))
    throw new Error(
      "OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be configured together",
    );
  if (issuer) {
    try {
      const url = new URL(issuer);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      throw new Error("OIDC_ISSUER must be an HTTPS issuer URL");
    }
  }
  for (const key of ["AUTH_PASSWORD_ENABLED", "OIDC_ALLOW_SIGNUP_BYPASS"]) {
    const value = source[key];
    if (value && !["true", "false"].includes(value))
      throw new Error(`${key} must be true or false`);
  }
  if (source.AUTH_PASSWORD_ENABLED === "false" && !issuer)
    throw new Error("AUTH_PASSWORD_ENABLED=false requires OIDC configuration");
  return issuer && clientId && clientSecret
    ? {
        issuer,
        clientId,
        clientSecret,
        name: optional(source.OIDC_NAME) ?? "SSO",
        scopes: (optional(source.OIDC_SCOPES) ?? "openid email profile")
          .split(/[\s,]+/)
          .filter(Boolean),
        allowSignupBypass: source.OIDC_ALLOW_SIGNUP_BYPASS === "true",
      }
    : undefined;
}

/** Product connection display only: no grant decryption, provider request, refresh or write lock. */
export async function getOidcAccountStatus(
  prisma: PrismaClient,
  oidc: Pick<OidcConfig, "issuer" | "clientId">,
  context: { userId: string; spaceId: string },
): Promise<"connected" | "reconnect"> {
  await requireMembership(prisma, context.userId, context.spaceId);
  const accounts = await prisma.$queryRaw<
    Array<{
      id: string;
      userId: string;
      providerId: string;
      accountId: string;
      idToken: string | null;
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
      accessTokenExpiresAt: Date | null;
      refreshTokenExpiresAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT id, "userId", "providerId", "accountId", "idToken",
      ("accessToken" IS NOT NULL AND "accessToken" <> '') AS "hasAccessToken",
      ("refreshToken" IS NOT NULL AND "refreshToken" <> '') AS "hasRefreshToken",
      "accessTokenExpiresAt", "refreshTokenExpiresAt"
    FROM account WHERE "userId" = ${context.userId} AND "providerId" = 'oidc'
  `);
  const matching = accounts.filter(
    (account) =>
      account.userId === context.userId &&
      isCurrentOidcAccount(account, oidc.issuer, oidc.clientId),
  );
  if (matching.length !== 1) return "reconnect";
  const account = matching[0]!;
  const expires = account.accessTokenExpiresAt?.getTime();
  const now = Date.now();
  const usable =
    account.hasAccessToken && expires !== undefined && Number.isFinite(expires) && expires > now;
  const refreshable =
    expires !== undefined &&
    Number.isFinite(expires) &&
    expires <= now &&
    account.hasRefreshToken &&
    (account.refreshTokenExpiresAt === null || account.refreshTokenExpiresAt.getTime() > now);
  return usable || refreshable ? "connected" : "reconnect";
}

/** Read/rotate the current caller's grant on one native Account transaction, never an MCP secret. */
export async function getOidcAccessToken(
  prisma: PrismaClient,
  auth: Pick<Auth, "api" | "options">,
  oidc: OidcConfig,
  context: { userId: string; spaceId: string; signal?: AbortSignal },
  rejectedToken?: string,
): Promise<string> {
  context.signal?.throwIfAborted();
  const outcome = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await requireMembership(tx as PrismaClient, context.userId, context.spaceId);
      const accounts = await tx.$queryRaw<
        Array<{
          id: string;
          userId: string;
          providerId: string;
          accountId: string;
          idToken: string | null;
        }>
      >(Prisma.sql`
      SELECT id, "userId", "providerId", "accountId", "idToken" FROM account
      WHERE "userId" = ${context.userId} AND "providerId" = 'oidc'
      ORDER BY id FOR UPDATE
    `);
      const matching = accounts.filter(
        (account) =>
          account.userId === context.userId &&
          isCurrentOidcAccount(account, oidc.issuer, oidc.clientId),
      );
      if (matching.length !== 1)
        throw new IsolationError("Your CRM sign-in is unavailable. Sign in again.");
      context.signal?.throwIfAborted();
      const account = matching[0]!;
      const adapter = prismaAdapter(tx, { provider: "postgresql" })(auth.options);
      // Native OAuth refresh uses its bounded provider signal. Once rotating, persist before observing cancellation.
      try {
        const token = await runWithAdapter(adapter, async () => {
          let result: {
            accessToken?: string;
            accessTokenExpiresAt?: Date;
            idToken?: string | null;
          } = await auth.api.getAccessToken({
            body: { accountId: account.id, userId: context.userId },
          });
          if (rejectedToken !== undefined && result.accessToken === rejectedToken)
            result = await auth.api.refreshToken({
              body: { accountId: account.id, userId: context.userId },
            });
          const expiresAt = result.accessTokenExpiresAt
            ? new Date(result.accessTokenExpiresAt).getTime()
            : Number.NaN;
          if (
            !result.accessToken ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= Date.now() ||
            !isCurrentOidcAccount(
              { ...account, idToken: result.idToken ?? account.idToken },
              oidc.issuer,
              oidc.clientId,
            )
          )
            throw new IsolationError("Your CRM sign-in is unavailable. Sign in again.");
          return result.accessToken;
        });
        return { token };
      } catch (error) {
        // A completed provider rotation must commit even if subsequent validation rejects it.
        return { error };
      }
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
  if ("error" in outcome) throw outcome.error;
  context.signal?.throwIfAborted();
  return outcome.token;
}

/** Discovery never gates API startup. Failed attempts share exponential backoff. */
export function oidcDiscovery(config: OidcConfig) {
  const generic = genericOAuth({
    config: [
      {
        providerId: "oidc",
        name: config.name,
        discoveryUrl: `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: [...new Set(["openid", "email", "profile", ...config.scopes])],
        pkce: true,
        accountSubject: ({ profile }) => {
          if (typeof profile.sub !== "string" || !profile.sub.trim()) return "";
          // Subjects are unique within an issuer, never across different IdPs.
          return oidcAccountSubject(config.issuer, profile.sub);
        },
        requireIdTokenVerification: true,
        // Every round-trip can serve as fresh authentication for account deletion.
        prompt: "login",
        authorizationUrlParams: { max_age: "0" },
        mapProfileToUser: (profile) => ({ emailVerified: profile.email_verified === true }),
      },
    ],
  });
  type Provider = Awaited<ReturnType<typeof generic.init>>["context"]["socialProviders"][number];
  let provider: Provider | undefined;
  let pending: Promise<Provider> | undefined;
  let nextAttempt = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let availability: "checking" | "available" | "unavailable" = "checking";
  const unavailable = () =>
    new APIError("SERVICE_UNAVAILABLE", {
      code: "SSO_UNAVAILABLE",
      message: "SSO is temporarily unavailable. Try again.",
    });
  const plugin: BetterAuthPlugin = {
    id: "oidc-discovery",
    init(ctx) {
      const schedule = (delay: number) => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void discover().catch(() => undefined);
        }, delay);
        timer.unref?.();
      };
      const discover = (): Promise<Provider> => {
        if (pending) return pending;
        if (Date.now() < nextAttempt) return Promise.reject(unavailable());
        pending = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              // The library may log upstream error detail. Keep discovery errors generic.
              generic.init({
                ...ctx,
                socialProviders: ctx.socialProviders.filter((item) => item.id !== "oidc"),
                logger: { ...ctx.logger, error: () => undefined },
              }),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(unavailable()), 8_000);
              }),
            ]);
            const discovered = result.context.socialProviders[0];
            if (
              !discovered ||
              typeof discovered === "function" ||
              discovered.issuer !== config.issuer
            )
              throw unavailable();
            provider = discovered;
            availability = "available";
            failures = 0;
            nextAttempt = 0;
            schedule(5 * 60_000);
            return discovered;
          } catch {
            provider = undefined;
            availability = "unavailable";
            const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
            nextAttempt = Date.now() + delay;
            schedule(delay);
            throw unavailable();
          } finally {
            clearTimeout(timeout);
            pending = undefined;
          }
        })();
        return pending;
      };
      schedule(0);
      const getProvider = () => (provider ? Promise.resolve(provider) : discover());
      const lazy: Provider = {
        id: "oidc",
        name: config.name,
        issuer: config.issuer,
        requiresIdTokenNonce: true,
        createAuthorizationURL: async (data) => (await getProvider()).createAuthorizationURL(data),
        validateAuthorizationCode: async (data) =>
          (await getProvider()).validateAuthorizationCode(data),
        getUserInfo: async (tokens) =>
          tokens.idToken ? (await getProvider()).getUserInfo(tokens) : null,
        accountSubject: async (data) => {
          const resolved = await getProvider();
          if (!resolved.accountSubject) throw unavailable();
          return resolved.accountSubject(data);
        },
        refreshAccessToken: async (token) => {
          const signal = AbortSignal.timeout(8_000);
          // ponytail: re-discover once per refresh until Generic OAuth exposes refresh fetch options.
          const discovery = await fetch(
            `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
            { signal, redirect: "manual" },
          );
          if (!discovery.ok) throw unavailable();
          const metadata = await discovery.json();
          if (
            !metadata ||
            typeof metadata !== "object" ||
            !("issuer" in metadata) ||
            metadata.issuer !== config.issuer ||
            !("token_endpoint" in metadata) ||
            typeof metadata.token_endpoint !== "string" ||
            !metadata.token_endpoint
          )
            throw unavailable();
          const endpoint = new URL(metadata.token_endpoint);
          if (
            endpoint.protocol !== "https:" ||
            endpoint.username ||
            endpoint.password ||
            endpoint.hash
          )
            throw unavailable();
          const request = await refreshAccessTokenRequest({
            refreshToken: token,
            tokenEndpoint: metadata.token_endpoint,
            options: { clientId: config.clientId, clientSecret: config.clientSecret },
          });
          const response = await fetch(metadata.token_endpoint, {
            ...request,
            method: "POST",
            signal,
            redirect: "manual",
          });
          if (!response.ok) throw unavailable();
          const data = await response.json();
          if (
            !data ||
            typeof data !== "object" ||
            !("access_token" in data) ||
            typeof data.access_token !== "string" ||
            !data.access_token ||
            ("error" in data && data.error)
          )
            throw unavailable();
          return getOAuth2Tokens(data);
        },
      };
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
  };
  return {
    plugin,
    availability: () => availability,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export function oidcAccountSubject(issuer: string, subject: string) {
  return createHash("sha256")
    .update(JSON.stringify([issuer, subject]))
    .digest("hex");
}

/** Stored ID tokens were verified during linking; bind them to the current issuer, client and subject. */
export function isCurrentOidcAccount(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
  clientId: string | undefined,
) {
  if (!issuer || !clientId || account.providerId !== "oidc" || !account.idToken) return false;
  try {
    const claims = JSON.parse(
      Buffer.from(account.idToken.split(".")[1] ?? "", "base64url").toString(),
    );
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    return (
      claims.iss === issuer &&
      Array.isArray(audiences) &&
      audiences.length > 0 &&
      audiences.every((audience) => typeof audience === "string" && audience.length > 0) &&
      audiences.includes(clientId) &&
      (claims.azp === undefined ? audiences.length === 1 : claims.azp === clientId) &&
      typeof claims.sub === "string" &&
      account.accountId === oidcAccountSubject(issuer, claims.sub)
    );
  } catch {
    return false;
  }
}
