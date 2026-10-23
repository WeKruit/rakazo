import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string) {
  write(path.join(cwd, "revision.txt"), `${message}\n`);
  git(cwd, "add", "revision.txt");
  git(
    cwd,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.test",
    "commit",
    "-qm",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-deploy-"));
  temporaryDirectories.push(root);
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout with spaces");
  const bin = path.join(root, "bin");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  const first = commit(upstream, "first");
  git(root, "clone", "-q", upstream, checkout);
  write(path.join(checkout, ".git/info/exclude"), ".env\n.deploy.lock\n.last-deployed-revision\n");
  write(path.join(checkout, ".env"), "RAKAZO_HOST=app.example.test\n");
  const log = path.join(root, "commands.log");
  // Record every privileged or network command instead of running it.
  write(path.join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n', 0o755);
  write(
    path.join(bin, "timeout"),
    '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    0o755,
  );
  write(
    path.join(bin, "docker"),
    `#!/bin/bash
echo "docker $* @ $(git rev-parse --short HEAD)" >> "$COMMAND_LOG"
if [[ "$*" == *" build" && -n "\${FAIL_BUILD:-}" ]]; then exit 1; fi
exit 0
`,
    0o755,
  );
  write(
    path.join(bin, "curl"),
    `#!/bin/bash\necho "curl \${*: -1}" >> "$COMMAND_LOG"\n[[ -z "\${FAIL_HEALTH:-}" ]]\n`,
    0o755,
  );
  write(path.join(bin, "flock"), `#!/bin/bash\n[[ -z "\${LOCK_HELD:-}" ]]\n`, 0o755);
  const env = {
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: root,
    COMMAND_LOG: log,
    RAKAZO_DEPLOY_DIR: checkout,
    RAKAZO_DEPLOY_HEALTH_INTERVAL: "0",
  };
  return {
    upstream,
    checkout,
    first,
    run(
      overrides: Record<string, string> = {},
      revision: string | null = git(upstream, "rev-parse", "HEAD"),
    ) {
      const args = [path.join(repoRoot, "infra/compose/deploy-main.sh")];
      if (revision !== null) args.push(revision);
      const result = spawnSync("/bin/bash", args, {
        cwd: root,
        env: {
          ...env,
          RAKAZO_LEGACY_COMPOSE_APPROVED_SHA: revision ?? git(upstream, "rev-parse", "HEAD"),
          RAKAZO_DEPLOYMENT_HOLD: "clear",
          ...overrides,
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      return result;
    },
    commands(): string[] {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    head: () => git(checkout, "rev-parse", "HEAD"),
    deployed: () => readFileSync(path.join(checkout, ".last-deployed-revision"), "utf8").trim(),
  };
}

describe("production deploy script", () => {
  it("requires an explicit full tested revision before any deployment command", () => {
    for (const revision of [null, "", "main", "abc123", `${"a".repeat(40)}\n`]) {
      const deploy = fixture();
      const result = deploy.run({}, revision);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("full SHA");
      expect(deploy.head()).toBe(deploy.first);
      expect(deploy.commands()).toEqual([]);
    }
  });

  it("rejects malformed forced SSH commands without interpreting shell syntax", () => {
    const deploy = fixture();
    for (const command of [
      "deploy-main",
      `deploy-main ${deploy.first}; echo unexpected`,
      `deploy-main ${deploy.first} extra`,
      `deploy-main ${deploy.first}\n`,
    ]) {
      const result = deploy.run({ SSH_ORIGINAL_COMMAND: command });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Expected deploy-main FULL_SHA");
      expect(deploy.head()).toBe(deploy.first);
      expect(deploy.commands()).toEqual([]);
    }
  });

  it("accepts the exact approved forced SSH revision", () => {
    const deploy = fixture();
    const result = deploy.run({ SSH_ORIGINAL_COMMAND: `deploy-main ${deploy.first}` }, null);
    expect(result.status).toBe(0);
    expect(deploy.deployed()).toBe(deploy.first);
  });

  it("preserves the hold and requires approval for this exact revision", () => {
    const deploy = fixture();
    for (const overrides of [
      { RAKAZO_LEGACY_COMPOSE_APPROVED_SHA: "" },
      { RAKAZO_LEGACY_COMPOSE_APPROVED_SHA: "a".repeat(40) },
      { RAKAZO_DEPLOYMENT_HOLD: "held" },
      { RAKAZO_DEPLOYMENT_HOLD: "" },
    ]) {
      const result = deploy.run(overrides);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("approval or hold prerequisite");
      expect(deploy.head()).toBe(deploy.first);
      expect(deploy.commands()).toEqual([]);
    }
  });

  it("does not silently substitute a newer main revision for the approved source", () => {
    const deploy = fixture();
    const approved = commit(deploy.upstream, "approved");
    commit(deploy.upstream, "newer unapproved");
    const result = deploy.run({}, approved);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no longer main");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands()).toEqual([]);
  });

  it("preserves dirty tracked work before changing the checkout", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    write(path.join(deploy.checkout, "revision.txt"), "uncommitted user work\n");
    const result = deploy.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dirty");
    expect(readFileSync(path.join(deploy.checkout, "revision.txt"), "utf8")).toBe(
      "uncommitted user work\n",
    );
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands()).toEqual([]);
  });

  it("preserves untracked work that the target revision would overwrite", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, "incoming.txt"), "untracked user work\n");
    write(path.join(deploy.upstream, "incoming.txt"), "new tracked content\n");
    git(deploy.upstream, "add", "incoming.txt");
    commit(deploy.upstream, "next");
    const result = deploy.run();
    expect(result.status).toBe(1);
    expect(readFileSync(path.join(deploy.checkout, "incoming.txt"), "utf8")).toBe(
      "untracked user work\n",
    );
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands()).toEqual([]);
  });

  it("fails instead of reporting success while another deploy holds the lock", () => {
    const deploy = fixture();
    const next = commit(deploy.upstream, "next");
    const result = deploy.run({ LOCK_HELD: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds the lock");
    expect(deploy.head()).not.toBe(next);
    expect(deploy.commands()).toEqual([]);
  });

  it("only checks health when production is already current", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), `${deploy.first}\n`);
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(deploy.commands()).toEqual(["curl https://app.example.test/health"]);
  });

  it("deploys when the checkout matches but that revision was never recorded", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBe(deploy.first);
    const docker = deploy.commands().filter((line) => line.startsWith("docker"));
    expect(docker.map((line) => line.split(" @ ")[0])).toEqual([
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml config --quiet",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml build",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --remove-orphans",
    ]);
  });

  it("deploys when the recorded revision is not the checkout", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), "outdated\n");
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.deployed()).toBe(deploy.first);
    expect(deploy.commands().some((line) => line.includes(" up -d --remove-orphans"))).toBe(true);
  });

  it("builds, starts, and records the new revision under time limits", () => {
    const deploy = fixture();
    const next = commit(deploy.upstream, "next");
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(deploy.head()).toBe(next);
    expect(deploy.deployed()).toBe(next);
    const docker = deploy.commands().filter((line) => line.startsWith("docker"));
    expect(docker.map((line) => line.split(" @ ")[0])).toEqual([
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml config --quiet",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml build",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --remove-orphans",
    ]);
  });

  it("rolls back to the previous revision when the build fails", () => {
    const deploy = fixture();
    commit(deploy.upstream, "broken");
    const result = deploy.run({ FAIL_BUILD: "1" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands().at(-1)).toMatch(
      new RegExp(`up -d --build --remove-orphans @ ${deploy.first.slice(0, 7)}`),
    );
  });

  it("rolls back when production never becomes healthy", () => {
    const deploy = fixture();
    commit(deploy.upstream, "unhealthy");
    const result = deploy.run({ FAIL_HEALTH: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not recover");
    expect(deploy.head()).toBe(deploy.first);
  });
});
