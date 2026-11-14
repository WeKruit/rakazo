#!/usr/bin/env node
// Checks a pull request against the development standard in AGENTS.md ("Development standard").
// Each rule catches a pattern that has already cost this project a bad release or a wasted day.
// A PR may skip one rule on purpose with a line in its description:
//   Standard-Exception: <rule> — <why>
//
//   node scripts/check-dev-standard.mjs --base origin/stage [--head HEAD] [--body-file pr.md]
//
// Needs only git and Node; no install.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** Files this big take new code in a focused module of their own, not more lines. */
export const LARGE_FILE_LINES = 3000;
export const LARGE_FILE_MAX_GROWTH = 150;
/** A diff that deletes this share of an existing file's lines is a rewrite or a reformat. */
export const REWRITE_SHARE = 0.5;
export const REWRITE_MIN_LINES = 200;
/** Where agent instructions live; a change here is a behaviour fix and needs an eval. */
export const AGENT_TEXT_FILES = [
  "packages/core/src/recruiting-defaults.ts",
  "packages/core/src/recruiting-playbook.ts",
  "packages/core/src/recruiting-rules.test.ts",
];
/** Where reusable test and ops entry points live; a new one must be wired in, not left orphaned. */
export const ENTRY_POINT_DIRS = ["infra/acceptance/", "scripts/"];

const TESTING_HEADING =
  /^#{1,6}\s*(testing|how (it was |this was )?tested|verification|tested)\b/im;
const EVAL_LINE = /^\s*(\*\*)?eval(\*\*)?\s*:\s*\S/im;

export function exceptions(body) {
  const rules = new Set();
  for (const match of body.matchAll(/^\s*Standard-Exception:\s*([a-z-]+)\s*\S/gim)) {
    rules.add(match[1].toLowerCase());
  }
  return rules;
}

/**
 * @param {object} pr
 * @param {{path: string, status: string, added: number, deleted: number, baseLines: number}[]} pr.files
 * @param {string | undefined} pr.body PR description; undefined when checking a local branch.
 * @param {(path: string) => boolean} pr.isReferenced whether another tracked file names this file.
 * @returns {{rule: string, message: string}[]}
 */
export function evaluate({ files, body, isReferenced }) {
  const failures = [];
  const skip = exceptions(body ?? "");
  const fail = (rule, message) => {
    if (!skip.has(rule)) failures.push({ rule, message });
  };

  if (body !== undefined && !TESTING_HEADING.test(body)) {
    fail(
      "testing",
      "The description has no Testing section. Say what you ran and what it showed, and say " +
        '"not run" for anything you did not run (verification-before-completion).',
    );
  }

  for (const file of files) {
    if (file.status !== "M") continue;
    if (file.baseLines > LARGE_FILE_LINES && file.added - file.deleted > LARGE_FILE_MAX_GROWTH) {
      fail(
        "large-file",
        `${file.path} already has ${file.baseLines} lines and this adds ${file.added - file.deleted} ` +
          "more. Put the new code in a focused module and call it from here.",
      );
    }
    if (file.baseLines >= REWRITE_MIN_LINES && file.deleted >= file.baseLines * REWRITE_SHARE) {
      fail(
        "rewrite",
        `${file.path} has ${file.deleted} of its ${file.baseLines} lines replaced. Other threads ` +
          "edit this file too: keep the diff to the lines you mean to change (format only what you touched).",
      );
    }
  }

  const agentText = files.filter((file) => AGENT_TEXT_FILES.includes(file.path));
  if (agentText.length > 0 && body !== undefined && !EVAL_LINE.test(body)) {
    fail(
      "eval",
      `This changes agent instructions (${agentText.map((file) => file.path).join(", ")}). Add an ` +
        '"Eval:" line naming the simulated journey or eval case that failed before and passes after ' +
        "(with both results). Fix the mechanism first; instruction text is the last resort.",
    );
  }

  for (const file of files) {
    if (file.status !== "A") continue;
    const dir = ENTRY_POINT_DIRS.find((entry) => file.path.startsWith(entry));
    // Only entry points directly in these folders; a subfolder is a tool's own module.
    if (!dir || file.path.slice(dir.length).includes("/")) continue;
    if (/\.test\.[cm]?[jt]s$/.test(file.path) || file.path.endsWith(".md")) continue;
    if (!isReferenced(file.path)) {
      fail(
        "orphan-script",
        `${file.path} is new and nothing calls it. Extend an existing entry point instead, or wire ` +
          "this one in (package.json, a workflow, or the index in infra/acceptance/README.md).",
      );
    }
  }

  return failures;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(base, head) {
  const statuses = new Map();
  for (const line of git("diff", "--name-status", "--no-renames", `${base}...${head}`).split(
    "\n",
  )) {
    const [status, path] = line.split("\t");
    if (path) statuses.set(path, status[0]);
  }
  const mergeBase = git("merge-base", base, head).trim();
  const files = [];
  for (const line of git("diff", "--numstat", "--no-renames", `${base}...${head}`).split("\n")) {
    const [added, deleted, path] = line.split("\t");
    if (!path || added === "-") continue;
    const status = statuses.get(path) ?? "M";
    let baseLines = 0;
    if (status === "M") {
      baseLines = git("show", `${mergeBase}:${path}`).split("\n").length - 1;
    }
    files.push({ path, status, added: Number(added), deleted: Number(deleted), baseLines });
  }
  return files;
}

function referencedAt(head) {
  return (path) => {
    const name = basename(path);
    let hits = "";
    try {
      hits = git("grep", "-l", "-F", name, head, "--");
    } catch {
      return false;
    }
    const self = new Set([path, path.replace(/\.([cm]?[jt]s)$/, ".test.$1")]);
    return hits
      .split("\n")
      .map((hit) => hit.replace(`${head}:`, ""))
      .some((hit) => hit && !self.has(hit));
  };
}

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const base = arg("--base") ?? "origin/stage";
  const head = arg("--head") ?? "HEAD";
  const bodyFile = arg("--body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : undefined;
  const failures = evaluate({
    files: changedFiles(base, head),
    body,
    isReferenced: referencedAt(head),
  });
  if (failures.length === 0) {
    console.log("Development standard: pass");
    return 0;
  }
  for (const { rule, message } of failures) console.log(`✗ ${rule}: ${message}`);
  console.log(
    "\nSee AGENTS.md, Development standard. To skip a rule on purpose, add to the PR description:\n" +
      "  Standard-Exception: <rule> — <why>",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
