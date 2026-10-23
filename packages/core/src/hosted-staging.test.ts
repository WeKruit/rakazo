import { describe, expect, it } from "vitest";
import { hostedStagingConfig } from "./hosted-staging.js";

const base = {
  RAKAZO_RELEASE_PROFILE: "staging",
  AGENT_RUNTIME: "scripted",
  SANDBOX_PROVIDER: "fake",
  WEB_PROVIDER: "fake",
  CLOUD_AGENT_PROVIDER: "none",
  WAKEUP_DRIVER: "memory",
  SECRET_STORE: "encrypted",
  MCP_STDIO_ENABLED: "false",
  DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1/rakazo_staging",
  RAKAZO_GIT_SHA: "a".repeat(40),
};

describe("hosted staging profile", () => {
  it("requires an explicit staging profile and keeps production unchanged", () => {
    expect(hostedStagingConfig({ SMTP_URL: "production configuration" })).toBeUndefined();
    expect(hostedStagingConfig({ ...base, RAKAZO_RELEASE_PROFILE: "production" })).toBeUndefined();
    expect(() => hostedStagingConfig({ ...base, RAKAZO_RELEASE_PROFILE: "stagging" })).toThrow();
    expect(hostedStagingConfig(base)).toEqual({
      databaseUrl: base.DATABASE_URL,
      revision: base.RAKAZO_GIT_SHA,
    });
  });

  it.each([
    "AGENT_RUNTIME",
    "SANDBOX_PROVIDER",
    "WEB_PROVIDER",
    "CLOUD_AGENT_PROVIDER",
    "WAKEUP_DRIVER",
    "SECRET_STORE",
    "MCP_STDIO_ENABLED",
  ])("rejects missing or live %s before services start", (key) => {
    for (const value of [undefined, "live"])
      expect(() => hostedStagingConfig({ ...base, [key]: value })).toThrow();
  });

  it.each([
    "SMTP_URL",
    "OPENAI_API_KEY",
    "OIDC_ISSUER",
    "FIRST_PARTY_MCP_URL",
    "AXIOM_DATASET",
    "ARTIFACT_STORAGE_URL",
    "RAKAZO_UPDATER_URL",
    "INTEGRATIONS_CATALOG_URL",
    "UNKNOWN_API_KEY",
    "MODAL_TOKEN_SECRET",
    "PGPASSWORD",
    "PGHOST",
    "NODE_OPTIONS",
  ])("rejects inherited %s without disclosing its value", (key) => {
    try {
      hostedStagingConfig({ ...base, [key]: "private-value-must-not-appear" });
      throw new Error("Expected profile rejection");
    } catch (error) {
      expect(String(error)).toContain("Hosted staging cannot inherit");
      expect(String(error)).not.toContain("private-value-must-not-appear");
    }
  });

  it("allows local signing keys but rejects mixed databases and invalid source identity", () => {
    expect(
      hostedStagingConfig({ ...base, BETTER_AUTH_SECRET: "local", ENCRYPTION_KEY: "local" }),
    ).toBeDefined();
    expect(() => hostedStagingConfig({ ...base, DATABASE_URL: undefined })).toThrow();
    expect(() =>
      hostedStagingConfig({ ...base, REALTIME_DATABASE_URL: "different database" }),
    ).toThrow();
    expect(() =>
      hostedStagingConfig({ ...base, RAKAZO_GIT_SHA: `${base.RAKAZO_GIT_SHA}\n` }),
    ).toThrow();
  });
});
