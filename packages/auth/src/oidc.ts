import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { getOAuth2Tokens, refreshAccessTokenRequest } from "better-auth/oauth2";
import { genericOAuth } from "better-auth/plugins";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  scopes: string[];
  allowSignupBypass: boolean;
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
