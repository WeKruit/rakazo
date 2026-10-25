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
  "continue-on-error"?: boolean;
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
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, Job>;
}

const root = path.resolve(import.meta.dirname, "../../..");
const read = (name: string) => readFileSync(path.join(root, ".github/workflows", name), "utf8");
const validationText = read("release-validation.yml");
const stagingText = read("staging.yml");
const promotionText = read("promote-production.yml");
const validation = parse(validationText) as Workflow;
const staging = parse(stagingText) as Workflow;
const promotion = parse(promotionText) as Workflow;
const ci = parse(read("ci.yml")) as Workflow;
const images = parse(read("publish-server-image.yml")) as Workflow;
const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");
const defined = <T>(value: T | undefined): T => {
  expect(value).toBeDefined();
  return value as T;
};

// These gates are intentionally conjunctions: an added OR can bypass a hold.
function requiresAll(condition: string | undefined, requirements: string[]) {
  expect(condition).toBeDefined();
  const terms = compact(condition ?? "").split(/\s*&&\s*/);
  expect(terms).toEqual(expect.arrayContaining(requirements));
  expect(terms.every((term) => !term.includes("||"))).toBe(true);
}

describe("release workflow safety boundaries", () => {
  it("runs synthetic validation without deployment secrets, environments or containers", () => {
    expect(validation.name).toBe("release-validation");
    expect(validation.permissions).toEqual({ contents: "read", actions: "read" });
    expect(validationText).not.toMatch(/secrets\s*[:.]|secrets:\s*inherit/);
    for (const job of Object.values(validation.jobs)) {
      expect(job.environment).toBeUndefined();
      expect(job.services).toBeUndefined();
      expect(job.secrets).toBeUndefined();
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toMatch(/\b(?:docker|modal|ssh|eas)\b/);
      }
    }
    expect(validationText).toContain("infra/release/validate.py --sha");
    expect(validationText).toContain("--pg-bin /usr/lib/postgresql/16/bin");
  });

  it("does not promote PR artifacts or unsuccessful/foreign main runs", () => {
    expect(Object.keys(validation.on).sort()).toEqual(["pull_request", "workflow_run"]);
    expect(validation.on.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"] });
    const job = defined(validation.jobs.staging);
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
    expect(tokenSteps?.[0]?.if).toBe("github.event_name == 'workflow_run'");
    expect(tokenSteps?.[0]?.env?.GH_TOKEN).toBe(expression("github.token"));
  });

  it("checks out the event's full SHA without persisting a checkout credential", () => {
    const job = defined(validation.jobs.staging);
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

  it("requires manual main-only activation for isolated hosted staging", () => {
    expect(staging.name).toBe("staging");
    expect(Object.keys(staging.on)).toEqual(["workflow_dispatch"]);
    expect(staging.permissions).toEqual({ contents: "read", actions: "read" });
    expect(staging.concurrency).toEqual({ group: "hosted-staging", "cancel-in-progress": false });
    const job = defined(staging.jobs.staging);
    requiresAll(job.if, [
      "github.repository == 'WeKruit/rakazo'",
      "github.ref == 'refs/heads/main'",
    ]);
    expect(job.environment).toBe("staging");
    expect(job.env).toMatchObject({
      STAGING_DEPLOY_ENABLED: expression("vars.STAGING_DEPLOY_ENABLED"),
      STAGING_DEPLOYMENT_HOLD: expression("vars.STAGING_DEPLOYMENT_HOLD"),
      STAGING_RELEASE_APPROVAL: expression("secrets.STAGING_RELEASE_APPROVAL"),
    });
    const activation =
      job.steps?.findIndex((step) => step.run?.includes('test "$STAGING_DEPLOY_ENABLED" = true')) ??
      -1;
    const deploy = job.steps?.findIndex((step) => step.run?.includes("release.py stage ")) ?? -1;
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(activation);
    expect(job.steps?.[activation]?.run).toContain('test "$STAGING_DEPLOYMENT_HOLD" = clear');
    expect(job.steps?.[activation]?.run).toContain('test -n "$STAGING_RELEASE_APPROVAL"');
    expect(job.steps?.[deploy]?.env).toMatchObject({
      MODAL_TOKEN_ID: expression("secrets.STAGING_MODAL_TOKEN_ID"),
      MODAL_TOKEN_SECRET: expression("secrets.STAGING_MODAL_TOKEN_SECRET"),
      STAGING_MODAL_APP_NAME: expression("vars.STAGING_MODAL_APP_NAME"),
      STAGING_MODAL_SECRET_NAME: expression("vars.STAGING_MODAL_SECRET_NAME"),
      STAGING_MODAL_VOLUME_NAME: expression("vars.STAGING_MODAL_VOLUME_NAME"),
      STAGING_ORIGIN: expression("vars.STAGING_ORIGIN"),
      MODAL_ENVIRONMENT: "staging",
      RAKAZO_RELEASE_PROFILE: "staging",
    });
    expect(stagingText).not.toMatch(/PRODUCTION_|secrets\.MODAL_/);
    expect(job.services).toBeUndefined();
  });

  it("publishes only the hosted staging receipt after successful verification", () => {
    const steps = defined(staging.jobs.staging).steps ?? [];
    const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    const upload = defined(uploads[0]);
    expect(upload.with).toMatchObject({
      name: `hosted-staging-${expression("github.run_id")}-${expression("github.run_attempt")}`,
      path: `${expression("runner.temp")}/candidate/staging.json`,
      "if-no-files-found": "error",
    });
    expect(upload.if).toBeUndefined();
    expect(steps.indexOf(upload)).toBeGreaterThan(
      steps.findIndex((step) => step.run?.includes("release.py stage ")),
    );
    for (const step of steps) expect(step["continue-on-error"]).not.toBe(true);
  });

  it("requires explicit dispatch on main and serializes production without cancellation", () => {
    expect(Object.keys(promotion.on)).toEqual(["workflow_dispatch"]);
    expect(promotion.permissions).toEqual({ contents: "read", actions: "read" });
    expect(promotion.concurrency).toEqual({ group: "production", "cancel-in-progress": false });
    const job = defined(promotion.jobs.promote);
    requiresAll(job.if, [
      "github.repository == 'WeKruit/rakazo'",
      "github.ref == 'refs/heads/main'",
    ]);
    expect(job.environment).toBe("production");
    expect(job.env).toMatchObject({
      MODAL_PROMOTION_ENABLED: expression("vars.MODAL_PROMOTION_ENABLED"),
      PRODUCTION_DEPLOYMENT_HOLD: expression("vars.PRODUCTION_DEPLOYMENT_HOLD"),
      PRODUCTION_RELEASE_APPROVAL: expression("secrets.PRODUCTION_RELEASE_APPROVAL"),
    });
    const activation =
      job.steps?.findIndex((step) =>
        step.run?.includes('test "$MODAL_PROMOTION_ENABLED" = true'),
      ) ?? -1;
    const prerequisites =
      job.steps?.findIndex((step) => step.run?.includes("release.py promote ")) ?? -1;
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(prerequisites).toBeGreaterThan(activation);
    expect(job.steps?.[activation]?.run).toContain('test "$PRODUCTION_DEPLOYMENT_HOLD" = clear');
    expect(job.steps?.[activation]?.run).toContain('test -n "$PRODUCTION_RELEASE_APPROVAL"');
    expect(job.steps?.[prerequisites]?.name).toBe("Verify promotion prerequisites (cutover held)");
    expect(promotionText).not.toMatch(/MODAL_TOKEN_|pip install|modal deploy/);
  });

  it("passes release inputs as quoted environment arguments, never shell source", () => {
    expect(defined(promotion.jobs.promote).env).toMatchObject({
      EXPECTED_SHA: expression("inputs.expected_sha"),
      STAGING_RUN_ID: expression("inputs.staging_run_id"),
    });
    expect(defined(staging.jobs.staging).env).toMatchObject({
      EXPECTED_SHA: expression("inputs.expected_sha"),
      VALIDATION_RUN_ID: expression("inputs.validation_run_id"),
    });
    for (const workflow of [validation, staging, promotion]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          expect(step.run ?? "").not.toContain("${{");
          if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"]).toBe(false);
            if (workflow !== validation) {
              expect(step.with).toMatchObject({
                ref: expression("github.sha"),
                "fetch-depth": 0,
              });
            }
          }
        }
      }
    }
    expect(promotionText).toContain('fetch --run-id "$STAGING_RUN_ID" --sha "$EXPECTED_SHA"');
    expect(promotionText).toContain('promote --sha "$EXPECTED_SHA"');
    expect(stagingText).toContain(
      'fetch-validation --run-id "$VALIDATION_RUN_ID" --sha "$EXPECTED_SHA"',
    );
    expect(stagingText).toContain(
      'stage --directory "$RUNNER_TEMP/candidate" --sha "$EXPECTED_SHA"',
    );
  });

  it.each([staging, promotion])(
    "$name keeps the dispatch revision when main advances while waiting",
    (workflow) => {
      const dispatch = { sha: "a".repeat(40), ref: "refs/heads/main" };
      const remoteRefs: Record<string, string> = { main: dispatch.sha };
      const checkout = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.uses?.startsWith("actions/checkout@"));
      const checkoutRevision = () => {
        const ref = String(checkout?.with?.ref).replace(expression("github.sha"), dispatch.sha);
        return remoteRefs[ref] ?? ref;
      };

      expect(checkoutRevision()).toBe(dispatch.sha);
      // The run's event SHA stays fixed during environment approval/concurrency waits.
      remoteRefs.main = "b".repeat(40);
      expect(remoteRefs.main).not.toBe(dispatch.sha);
      expect(checkoutRevision()).toBe(dispatch.sha);
    },
  );

  it("keeps legacy Compose disabled regardless of old opt-ins or release variables", () => {
    const job = defined(ci.jobs["deploy-production"]);
    expect(job.if).toBe(expression("false"));
    expect(job.environment).toBeUndefined();
    expect(job.env).toBeUndefined();
    for (const step of job.steps ?? []) {
      expect(step.env).toBeUndefined();
      expect(step.run ?? "").not.toMatch(/\b(?:ssh|docker|deploy-main)\b/);
    }
    expect(job.steps?.some((step) => step.run?.includes("exit 1"))).toBe(true);
    expect(job.concurrency).toEqual({
      group: "production",
      "cancel-in-progress": false,
    });
  });

  it("requires separate opt-ins for OTA and mutable image publication", () => {
    requiresAll(defined(ci.jobs["publish-mobile-update"]).if, [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
      "vars.MOBILE_OTA_PUBLISH_ENABLED == 'true'",
      "vars.MODAL_PROMOTION_ENABLED != 'true'",
    ]);
    for (const name of ["build", "publish"]) {
      requiresAll(defined(images.jobs[name]).if, [
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
    expect(defined(ci.jobs["deploy-production"]).needs).toContain("release-safeguards");
    expect(defined(ci.jobs["publish-mobile-update"]).needs).toContain("release-safeguards");
  });
});
