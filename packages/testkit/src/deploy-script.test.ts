import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const revision = "a".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-held-deploy-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "checkout with spaces");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  mkdirSync(checkout);
  mkdirSync(bin);
  const preserved = {
    "revision.txt": "uncommitted user work\n",
    "incoming.txt": "untracked user work\n",
    ".env": "RAKAZO_HOST=app.example.test\n",
    ".last-deployed-revision": "previous-revision\n",
  };
  for (const [name, contents] of Object.entries(preserved)) {
    writeFileSync(path.join(checkout, name), contents);
  }
  // Every external command is a failing mock; the script gets no system PATH.
  for (const command of [
    "git",
    "curl",
    "docker",
    "ssh",
    "sudo",
    "timeout",
    "flock",
    "sed",
    "tail",
    "tr",
    "install",
    "chmod",
    "ssh-keygen",
  ]) {
    writeFileSync(
      path.join(bin, command),
      `#!/bin/bash\nprintf "%s\\n" "${command}" >> "$COMMAND_LOG"\nexit 97\n`,
      { mode: 0o755 },
    );
  }
  return {
    run(args: string[] = [revision], overrides: Record<string, string> = {}) {
      const result = spawnSync(
        "/bin/bash",
        [path.join(repoRoot, "infra/compose/deploy-main.sh"), ...args],
        {
          cwd: root,
          env: {
            PATH: bin,
            HOME: root,
            COMMAND_LOG: log,
            GITHUB_SHA: revision,
            GITHUB_REF: "refs/heads/main",
            PRODUCTION_DEPLOY_ENABLED: "true",
            LEGACY_COMPOSE_DEPLOY_ENABLED: "true",
            MODAL_PROMOTION_ENABLED: "false",
            PRODUCTION_DEPLOYMENT_HOLD: "clear",
            PRODUCTION_APPROVED_SHA: revision,
            RAKAZO_LEGACY_COMPOSE_APPROVED_SHA: revision,
            RAKAZO_DEPLOYMENT_HOLD: "clear",
            RAKAZO_DEPLOY_DIR: checkout,
            RAKAZO_HEALTH_URL: "https://app.example.test/health",
            ...overrides,
          },
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      expect(result.error).toBeUndefined();
      return result;
    },
    assertUnchanged() {
      expect(existsSync(log)).toBe(false);
      expect(existsSync(path.join(checkout, ".deploy.lock"))).toBe(false);
      for (const [name, contents] of Object.entries(preserved)) {
        expect(readFileSync(path.join(checkout, name), "utf8")).toBe(contents);
      }
    },
  };
}

describe("legacy Compose deployment hard stop", () => {
  it("cannot be enabled by all previous opt-ins and an approved exact revision", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Legacy Compose deployment is disabled");
    expect(result.stderr).toContain("enforceable intake drain");
    deploy.assertUnchanged();
  });

  it("blocks the forced SSH entrypoint without interpreting command text", () => {
    for (const command of [
      `deploy-main ${revision}`,
      `deploy-main ${revision}; git fetch origin main`,
      `deploy-main ${revision} extra`,
      `deploy-main ${revision}\n`,
    ]) {
      const deploy = fixture();
      const result = deploy.run([], { SSH_ORIGINAL_COMMAND: command });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Legacy Compose deployment is disabled");
      deploy.assertUnchanged();
    }
  });

  it("stops before reading configuration or running commands for any arguments", () => {
    for (const args of [[], ["main"], ["abc123"], [revision, "--override"]]) {
      const deploy = fixture();
      const result = deploy.run(args, { RAKAZO_DEPLOY_DIR: "/does-not-exist" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Legacy Compose deployment is disabled");
      deploy.assertUnchanged();
    }
  });
});
