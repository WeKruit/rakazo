export interface HostedStagingConfig {
  databaseUrl: string;
  revision: string;
}

/** Hosted release smoke is a restricted service profile, never a live agent environment. */
export function hostedStagingConfig(
  source: Record<string, string | undefined>,
): HostedStagingConfig | undefined {
  const profile = source.RAKAZO_RELEASE_PROFILE;
  if (!profile || profile === "production") return undefined;
  if (profile !== "staging") throw new Error("Unknown release profile");
  for (const [key, value] of Object.entries({
    AGENT_RUNTIME: "scripted",
    SANDBOX_PROVIDER: "fake",
    WEB_PROVIDER: "fake",
    CLOUD_AGENT_PROVIDER: "none",
    WAKEUP_DRIVER: "memory",
    SECRET_STORE: "encrypted",
    MCP_STDIO_ENABLED: "false",
  })) {
    if (source[key] !== value) throw new Error(`Hosted staging requires ${key}=${value}`);
  }
  const localSecrets = new Set(["BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "SCREEN_PROXY_SECRET"]);
  for (const [key, value] of Object.entries(source)) {
    if (!value || key === "SECRET_STORE" || localSecrets.has(key)) continue;
    if (
      /(?:^|_)(?:KEY|TOKEN|SECRETS?|PASSWORD|CREDENTIALS?)(?:_|$)/.test(key) ||
      /^(?:PG|NODE_OPTIONS$)/.test(key) ||
      /^(?:AXIOM|SMTP|OIDC|FIRST_PARTY_MCP|COMPOSIO|PIPEDREAM|SENDBLUE|SLACK|WHATSAPP|TELEGRAM|LARK|STRIPE|OPENAI|ANTHROPIC|GEMINI|E2B|DAYTONA|BOX|CREATEOS|RAILWAY|CURSOR|ARTIFACT_STORAGE|INFISICAL|RAKAZO_UPDATER|PI_DEFAULT|INTEGRATIONS_CATALOG)(?:_|$)/.test(
        key,
      )
    ) {
      throw new Error("Hosted staging cannot inherit external provider configuration");
    }
  }
  const databaseUrl = source.DATABASE_URL;
  const revision = source.RAKAZO_GIT_SHA;
  if (
    !databaseUrl ||
    (source.REALTIME_DATABASE_URL && source.REALTIME_DATABASE_URL !== databaseUrl)
  )
    throw new Error("Hosted staging requires one isolated database");
  if (revision?.length !== 40 || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error("Hosted staging requires a full source revision");
  return { databaseUrl, revision };
}
