import { describe, expect, it } from "vitest";
import { evaluate } from "./check-dev-standard.mjs";

const TESTED = "## Why\nx\n## Testing\nUnit tests pass.";
const nobodyCalls = () => false;
const rules = (input) =>
  evaluate({ isReferenced: nobodyCalls, body: TESTED, files: [], ...input }).map((f) => f.rule);
const modified = (path, baseLines, added, deleted) => ({
  path,
  status: "M",
  baseLines,
  added,
  deleted,
});
const added = (path) => ({ path, status: "A", baseLines: 0, added: 40, deleted: 0 });

describe("development standard", () => {
  it("passes a small, tested change", () => {
    expect(rules({ files: [modified("packages/core/src/ask.ts", 400, 12, 3)] })).toEqual([]);
  });

  it("asks for a Testing section, accepting the headings PRs already use", () => {
    expect(rules({ body: "## Why\nx\n## What changed\ny" })).toEqual(["testing"]);
    expect(rules({ body: "## How tested\nLint clean." })).toEqual([]);
    expect(rules({ body: "### Verification\nScreenshot." })).toEqual([]);
    // A local branch check has no description to read.
    expect(rules({ body: undefined })).toEqual([]);
  });

  it("stops a very large file from growing", () => {
    const file = modified("packages/adapters/src/executor.ts", 20314, 220, 10);
    expect(rules({ files: [file] })).toEqual(["large-file"]);
    expect(
      rules({ files: [modified("packages/adapters/src/executor.ts", 20314, 85, 20)] }),
    ).toEqual([]);
  });

  it("flags a whole-file rewrite or reformat of a shared file", () => {
    expect(rules({ files: [modified("apps/web/src/lib/thread.ts", 900, 905, 880)] })).toEqual([
      "rewrite",
    ]);
    expect(rules({ files: [modified("apps/web/src/lib/small.ts", 60, 60, 60)] })).toEqual([]);
  });

  it("asks an agent-instruction change for the eval that proves it", () => {
    const files = [modified("packages/core/src/recruiting-defaults.ts", 552, 6, 1)];
    expect(rules({ files })).toEqual(["eval"]);
    const body = `${TESTED}\nEval: one-off-email journey, 6/10 before, 9/10 and 9/10 after.`;
    expect(rules({ files, body })).toEqual([]);
    expect(
      rules({ files: [modified("packages/core/src/recruiting-playbook.ts", 900, 4, 4)] }),
    ).toEqual(["eval"]);
  });

  it("refuses a new script that nothing calls", () => {
    expect(rules({ files: [added("infra/acceptance/one-off-check.mjs")] })).toEqual([
      "orphan-script",
    ]);
    expect(
      rules({
        files: [added("infra/acceptance/one-off-check.mjs")],
        isReferenced: () => true,
      }),
    ).toEqual([]);
    // Tests, docs and a tool's own modules in a subfolder are not entry points.
    expect(
      rules({
        files: [
          added("infra/acceptance/one-off-check.test.mjs"),
          added("infra/acceptance/playtest/judge-v2.mjs"),
          added("scripts/README.md"),
        ],
      }),
    ).toEqual([]);
  });

  it("lets a PR skip one named rule with a reason, and only that rule", () => {
    const files = [
      modified("packages/adapters/src/executor.ts", 20314, 400, 0),
      added("scripts/backfill.mjs"),
    ];
    const body = `${TESTED}\nStandard-Exception: large-file — moving the round guidance out next.`;
    expect(rules({ files, body })).toEqual(["orphan-script"]);
    // A bare rule name without a reason does not count.
    expect(rules({ files, body: `${TESTED}\nStandard-Exception: large-file` })).toEqual([
      "large-file",
      "orphan-script",
    ]);
  });
});
