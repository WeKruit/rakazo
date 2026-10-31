#!/usr/bin/env node
// The playtest judge and fixer: scores each transcript with rubric.md through a model, finds
// defects that recur across samples, and drafts the smallest instruction change for each one.
// A draft is a proposal for a normal PR; this never edits instructions or ships anything.
//
// Usage:
//   JUDGE_BASE_URL=https://…/v1 JUDGE_API_KEY=… JUDGE_MODEL=… \
//   JUDGE_USD_PER_MTOK_IN=3 JUDGE_USD_PER_MTOK_OUT=15 \
//     node infra/acceptance/playtest/judge.mjs --samples <dir> [--cap-usd 3] [--out report.json]
//   <dir> holds one folder per sample with scenario.md (the scenario and its checks) and
//   transcript.md (from transcript.mjs). Samples of one scenario share the folder prefix before "#".
//   The endpoint is any OpenAI-compatible chat completions API. Spend is counted from the token
//   usage each reply reports at the given prices; the run stops before a call that could pass the
//   cap. Node 20+, no dependencies. Prints no credentials.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DIMENSIONS = ["concise", "correct", "judgment", "voice", "magic"];
/** Round passes when every dimension averages this and no sample fails a check. */
export const PASS_AVERAGE = 4.5;

/** Reads the judge's SCORES / CHECKS / DEFECTS block. Returns null when it is malformed. */
export function parseJudgement(text) {
  const scores = {};
  const line = text.match(/^SCORES\s+(.+)$/m)?.[1] ?? "";
  for (const dimension of DIMENSIONS) {
    const value = Number(line.match(new RegExp(`${dimension}=(\\d)`))?.[1]);
    if (!(value >= 1 && value <= 5)) return null;
    scores[dimension] = value;
  }
  const checks = text.match(/^CHECKS\s+(\d+)\/(\d+)\s+FAILED:\s*(.*)$/m);
  if (!checks) return null;
  const failed = /^none$/i.test(checks[3].trim())
    ? []
    : checks[3]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
  const defects = [];
  const section = text.split(/^DEFECTS\s*$/m)[1] ?? "";
  for (const raw of section.split("\n")) {
    const defect = raw.match(/^-\s*(\w+):\s*(.+?)(?:\s*\|\s*violates:\s*"(.+)")?\s*$/);
    if (defect && DIMENSIONS.includes(defect[1]))
      defects.push({ dimension: defect[1], what: defect[2], violates: defect[3] ?? null });
  }
  return {
    scores,
    checks: { passed: Number(checks[1]), total: Number(checks[2]), failed },
    defects,
  };
}

/** Per-dimension averages, pass/fail, and defects seen in two or more samples. */
export function summarizeRound(samples) {
  const judged = samples.filter((sample) => sample.judgement);
  const averages = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      judged.length
        ? Math.round(
            (judged.reduce((sum, sample) => sum + sample.judgement.scores[dimension], 0) /
              judged.length) *
              100,
          ) / 100
        : null,
    ]),
  );
  const failedSamples = samples.filter(
    (sample) => !sample.judgement || sample.judgement.checks.failed.length > 0,
  );
  // A defect recurs when the same instruction is violated, or the same dimension is lowered,
  // in at least two samples. One-off defects are noise and never trigger a fix.
  const byKey = new Map();
  for (const sample of judged) {
    const seen = new Set();
    for (const defect of sample.judgement.defects) {
      const key = defect.violates ? `violates:${defect.violates}` : `dimension:${defect.dimension}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key) ?? { ...defect, samples: [] };
      entry.samples.push({ sample: sample.name, what: defect.what });
      byKey.set(key, entry);
    }
  }
  const recurring = [...byKey.values()].filter((entry) => entry.samples.length >= 2);
  const passed =
    failedSamples.length === 0 &&
    DIMENSIONS.every((dimension) => (averages[dimension] ?? 0) >= PASS_AVERAGE);
  return {
    samples: samples.length,
    averages,
    failedSamples: failedSamples.map((s) => s.name),
    recurring,
    passed,
  };
}

/** Counts spend from reported usage and refuses a call that could pass the cap. */
export class SpendCap {
  constructor({ capUsd, inPerMTok, outPerMTok }) {
    Object.assign(this, { capUsd, inPerMTok, outPerMTok, spentUsd: 0 });
  }
  cost(usage) {
    return (
      ((usage?.prompt_tokens ?? 0) * this.inPerMTok +
        (usage?.completion_tokens ?? 0) * this.outPerMTok) /
      1_000_000
    );
  }
  /** Worst case for a call: its whole prompt plus the most it may write. */
  reserve(promptChars, maxTokens) {
    const worst = this.cost({
      prompt_tokens: Math.ceil(promptChars / 3),
      completion_tokens: maxTokens,
    });
    if (this.spentUsd + worst > this.capUsd)
      throw new Error(
        `Stopped at the US$${this.capUsd} cap (spent US$${this.spentUsd.toFixed(3)})`,
      );
  }
  record(usage) {
    this.spentUsd += this.cost(usage);
  }
}

export async function complete({
  fetchImpl = fetch,
  env = process.env,
  cap,
  system,
  user,
  maxTokens,
}) {
  cap.reserve(system.length + user.length, maxTokens);
  const response = await fetchImpl(`${env.JUDGE_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.JUDGE_API_KEY}` },
    body: JSON.stringify({
      model: env.JUDGE_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Judge model answered ${response.status}`);
  const body = await response.json();
  cap.record(body.usage);
  return body.choices?.[0]?.message?.content ?? "";
}

export async function judgeRound({ samples, instructions, rubric, cap, fetchImpl, env }) {
  const results = [];
  for (const sample of samples) {
    // A fresh request per sample: no judge sees another sample's transcript.
    const text = await complete({
      fetchImpl,
      env,
      cap,
      maxTokens: 1500,
      system: rubric,
      user: `## Live instructions\n\n${instructions}\n\n## Scenario\n\n${sample.scenario}\n\n## Transcript\n\n${sample.transcript}`,
    });
    results.push({ name: sample.name, judgement: parseJudgement(text) });
  }
  const summary = summarizeRound(results);
  const fixes = [];
  for (const defect of summary.recurring) {
    const proposal = await complete({
      fetchImpl,
      env,
      cap,
      maxTokens: 800,
      system:
        "You maintain recruiting agent instructions. Propose the smallest change to the instructions " +
        "that removes the recurring defect without adding a new rule when an existing sentence can be " +
        "tightened. Reply with BEFORE: <exact current sentence or 'new'> and AFTER: <replacement>, " +
        "then one line WHY. Never add vendor names, ids or tool names to recruiter-facing wording.",
      user: `## Instructions\n\n${instructions}\n\n## Recurring defect (${defect.dimension})\n\n${defect.samples
        .map((s) => `- ${s.sample}: ${s.what}`)
        .join("\n")}${defect.violates ? `\n\nViolated: "${defect.violates}"` : ""}`,
    });
    fixes.push({ defect, proposal });
  }
  return { results, summary, fixes, spentUsd: Math.round(cap.spentUsd * 1000) / 1000 };
}

export function readSamples(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      scenario: fs.readFileSync(path.join(dir, entry.name, "scenario.md"), "utf8"),
      transcript: fs.readFileSync(path.join(dir, entry.name, "transcript.md"), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const dir = option("--samples");
  const out = option("--out", "playtest-report.json");
  for (const name of ["JUDGE_BASE_URL", "JUDGE_API_KEY", "JUDGE_MODEL"])
    if (!process.env[name]) throw new Error(`Set ${name}`);
  if (!dir) throw new Error("Pass --samples <dir>");
  const cap = new SpendCap({
    capUsd: Number(option("--cap-usd", "3")),
    inPerMTok: Number(process.env.JUDGE_USD_PER_MTOK_IN ?? "15"),
    outPerMTok: Number(process.env.JUDGE_USD_PER_MTOK_OUT ?? "75"),
  });
  const report = await judgeRound({
    samples: readSamples(dir),
    instructions: fs.readFileSync(
      path.join(ROOT, "packages/core/src/recruiting-defaults.ts"),
      "utf8",
    ),
    rubric: fs.readFileSync(path.join(ROOT, "infra/acceptance/playtest/rubric.md"), "utf8"),
    cap,
  });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `${report.summary.passed ? "PASS" : "FAIL"} ${JSON.stringify(report.summary.averages)}; ` +
      `${report.summary.recurring.length} recurring defects, ${report.fixes.length} fix drafts; ` +
      `US$${report.spentUsd}; report ${out}`,
  );
  process.exitCode = report.summary.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
