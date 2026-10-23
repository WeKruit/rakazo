import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  if?: string;
  environment?: string | { name: string };
  services?: unknown;
  secrets?: unknown;
  needs?: string[];
  env?: Record<string, string>;
  steps?: Step[];
  concurrency?: { group: string; "cancel-in-progress": boolean };
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, Job>;
}

const root = path.resolve(import.meta.dirname, "../../..");
const read = (name: string) => readFileSync(path.join(root, ".github/workflows", name), "utf8");
const stagingText = read("staging.yml");
const promotionText = read("promote-production.yml");
const staging = parse(stagingText) as Workflow;
const promotion = parse(promotionText) as Workflow;
const ci = parse(read("ci.yml")) as Workflow;
const images = parse(read("publish-server-image.yml")) as Workflow;
const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");

// These gates are intentionally conjunctions: an added OR can bypass a hold.
function requiresAll(condition: string | undefined, requirements: string[]) {
  expect(condition).toBeDefined();
  const terms = compact(condition ?? "").split(/\s*&&\s*/);
  expect(terms).toEqual(expect.arrayContaining(requirements));
  expect(terms.every((term) => !term.includes("||"))).toBe(true);
}

describe("release workflow safety boundaries", () => {
  it("runs synthetic staging without deployment secrets, environments or containers", () => {
    expect(staging.permissions).toEqual({ contents: "read", actions: "read" });
    expect(stagingText).not.toMatch(/secrets\s*[:.]|secrets:\s*inherit/);
    for (const job of Object.values(staging.jobs)) {
      expect(job.environment).toBeUndefined();
      expect(job.services).toBeUndefined();
      expect(job.secrets).toBeUndefined();
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toMatch(/\b(?:docker|modal|ssh|eas)\b/);
      }
    }
    expect(stagingText).toContain("infra/release/staging.py --sha");
    expect(stagingText).toContain("--pg-bin /usr/lib/postgresql/16/bin");
  });

  it("does not promote PR artifacts or unsuccessful/foreign main runs", () => {
    expect(Object.keys(staging.on).sort()).toEqual(["pull_request", "workflow_run"]);
    expect(staging.on.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"] });
    const job = staging.jobs.staging;
    expect(compact(job.if ?? "")).toBe(
      "github.repository == 'WeKruit/rakazo' && " +
        "(github.event_name == 'pull_request' || " +
        "(github.event.workflow_run.conclusion == 'success' && " +
        "github.event.workflow_run.event == 'push' && " +
        "github.event.workflow_run.head_branch == 'main' && " +
        "github.event.workflow_run.head_repository.full_name == github.repository))",
    );
    const artifactSteps = job.steps?.filter(
      (step) =>
        step.run?.includes("release.py package") ||
        step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(artifactSteps).toHaveLength(2);
    for (const step of artifactSteps ?? []) {
      expect(step.if).toBe("github.event_name == 'workflow_run'");
    }
    const tokenSteps = job.steps?.filter((step) => step.env?.GH_TOKEN);
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps?.[0].if).toBe("github.event_name == 'workflow_run'");
    expect(tokenSteps?.[0].env?.GH_TOKEN).toBe(expression("github.token"));
  });

  it("checks out the event's full SHA without persisting a checkout credential", () => {
    const job = staging.jobs.staging;
    expect(job.env?.SOURCE_SHA).toBe(
      expression("github.event.workflow_run.head_sha || github.event.pull_request.head.sha"),
    );
    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({
      ref: expression("env.SOURCE_SHA"),
      "persist-credentials": false,
    });
    expect(job.steps?.some((step) => step.run?.includes('--sha "$SOURCE_SHA"'))).toBe(true);
  });

  it("requires explicit dispatch on main and serializes production without cancellation", () => {
    expect(Object.keys(promotion.on)).toEqual(["workflow_dispatch"]);
    expect(promotion.permissions).toEqual({ contents: "read", actions: "read" });
    expect(promotion.concurrency).toEqual({ group: "production", "cancel-in-progress": false });
    const job = promotion.jobs.promote;
    requiresAll(job.if, [
      "github.repository == 'WeKruit/rakazo'",
      "github.ref == 'refs/heads/main'",
    ]);
    expect(job.environment).toBe("production");
    expect(job.env).toMatchObject({
      MODAL_PROMOTION_ENABLED: expression("vars.MODAL_PROMOTION_ENABLED"),
      PRODUCTION_DEPLOYMENT_HOLD: expression("vars.PRODUCTION_DEPLOYMENT_HOLD"),
      PRODUCTION_RELEASE_APPROVAL: expression("vars.PRODUCTION_RELEASE_APPROVAL"),
    });
    const activation =
      job.steps?.findIndex((step) =>
        step.run?.includes('test "$MODAL_PROMOTION_ENABLED" = true'),
      ) ?? -1;
    const credential = job.steps?.findIndex((step) => step.env?.MODAL_TOKEN_SECRET) ?? -1;
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(credential).toBeGreaterThan(activation);
    expect(job.steps?.[activation].run).toContain('test "$PRODUCTION_DEPLOYMENT_HOLD" = clear');
    expect(job.steps?.[activation].run).toContain('test -n "$PRODUCTION_RELEASE_APPROVAL"');
    expect(job.steps?.[credential].env?.MODAL_TOKEN_SECRET).toBe(
      expression("secrets.PRODUCTION_MODAL_TOKEN_SECRET"),
    );
  });

  it("passes release inputs as quoted environment arguments, never shell source", () => {
    expect(promotion.jobs.promote.env).toMatchObject({
      EXPECTED_SHA: expression("inputs.expected_sha"),
      STAGING_RUN_ID: expression("inputs.staging_run_id"),
    });
    for (const workflow of [staging, promotion]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          expect(step.run ?? "").not.toContain("${{");
          if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"]).toBe(false);
          }
        }
      }
    }
    expect(promotionText).toContain('fetch --run-id "$STAGING_RUN_ID" --sha "$EXPECTED_SHA"');
    expect(promotionText).toContain('promote --sha "$EXPECTED_SHA"');
  });

  it("keeps the legacy Compose publisher behind the hold and disables it for Modal promotion", () => {
    requiresAll(ci.jobs["deploy-production"].if, [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
      "vars.LEGACY_COMPOSE_DEPLOY_ENABLED == 'true'",
      "vars.PRODUCTION_DEPLOY_ENABLED == 'true'",
      "vars.MODAL_PROMOTION_ENABLED != 'true'",
      "vars.PRODUCTION_DEPLOYMENT_HOLD == 'clear'",
      "vars.PRODUCTION_APPROVED_SHA == github.sha",
    ]);
    const commands =
      ci.jobs["deploy-production"].steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(commands).toContain('deploy-main "$GITHUB_SHA"');
    expect(ci.jobs["deploy-production"].concurrency).toEqual({
      group: "production",
      "cancel-in-progress": false,
    });
  });

  it("requires separate opt-ins for OTA and mutable image publication", () => {
    requiresAll(ci.jobs["publish-mobile-update"].if, [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
      "vars.MOBILE_OTA_PUBLISH_ENABLED == 'true'",
      "vars.MODAL_PROMOTION_ENABLED != 'true'",
    ]);
    for (const name of ["build", "publish"]) {
      requiresAll(images.jobs[name].if, [
        "github.event_name != 'pull_request'",
        "vars.SERVER_IMAGE_PUBLISH_ENABLED == 'true'",
      ]);
    }
  });

  it("runs the release safeguard tests in CI", () => {
    expect(
      Object.values(ci.jobs).some((job) =>
        job.steps?.some((step) =>
          /python3 (?:-B )?-m unittest discover -s infra\/release/.test(step.run ?? ""),
        ),
      ),
    ).toBe(true);
    expect(ci.jobs["deploy-production"].needs).toContain("release-safeguards");
  });
});
