#!/usr/bin/env node
// Repeatable quality benchmark: plays each private scenario on fresh test copies, judges the
// transcripts with judge.mjs, appends the round to a history file and compares it with the last
// round. Meant to run nightly from a scheduled job; one run is one round.
//
// Usage:
//   RAKAZO_URL=… RAKAZO_ORIGIN=… (RAKAZO_TOKEN=… | RAKAZO_EMAIL=… RAKAZO_PASSWORD=…) \
//   JUDGE_BASE_URL=… JUDGE_API_KEY=… JUDGE_MODEL=… JUDGE_USD_PER_MTOK_IN=… JUDGE_USD_PER_MTOK_OUT=… \
//     node infra/acceptance/playtest/benchmark.mjs --scenarios <dir> --history <file.jsonl> \
//       [--samples 2] [--cap-usd 5] [--work <dir>] [--search]
//   <dir> holds <name>.json files: {"jd": "<JD file in the same dir>", "say": ["…"],
//   "target": 10, "checks": "<markdown list of checks>"}. Scenarios stay private: never commit one.
//   Playing a scenario runs people searches on the live product, which costs money, so it only
//   happens with --search; without it the round re-judges the transcripts already in <work>.
//   The judge stops at --cap-usd. Approval cards are never answered and copies are archived.
// Node 20+, no dependencies. Prints no credentials. Exit 0 only when the round passes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIMENSIONS, judgeRound, readSamples, SpendCap } from "./judge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

function run(script, args, stdoutFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      stdio: ["ignore", stdoutFile ? fs.openSync(stdoutFile, "w") : "inherit", "inherit"],
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)),
    );
  });
}

/** Score change per dimension against the previous round; null when there is none. */
export function compareRounds(previous, current) {
  if (!previous) return null;
  return Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      const before = previous.averages?.[dimension];
      const now = current.averages?.[dimension];
      return [
        dimension,
        before == null || now == null ? null : Math.round((now - before) * 100) / 100,
      ];
    }),
  );
}

export function lastRound(historyFile) {
  if (!fs.existsSync(historyFile)) return null;
  const lines = fs.readFileSync(historyFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : null;
}

async function playScenario(dir, file, sample, work) {
  const name = path.basename(file, ".json");
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const folder = path.join(work, `${name}#${sample}`);
  fs.mkdirSync(folder, { recursive: true });
  const report = path.join(folder, "run.json");
  await run("../recruiting-latency.mjs", [
    "--jd-file",
    path.join(dir, scenario.jd),
    "--skip-scale",
    "--keep",
    "--out",
    report,
  ]);
  const { groupId } = JSON.parse(fs.readFileSync(report, "utf8"));
  if (!groupId) throw new Error(`${name}: no role chat was started`);
  try {
    if (scenario.say?.length)
      await run("../replay-messages.mjs", [
        "--group",
        groupId,
        ...scenario.say.flatMap((text) => ["--say", text]),
        "--out",
        path.join(folder, "replay.json"),
      ]);
    await run("transcript.mjs", ["--group", groupId, "--out", path.join(folder, "transcript.md")]);
  } finally {
    await run("../archive-test-copies.mjs", ["--idle-hours", "0"]).catch(() => undefined);
  }
  fs.writeFileSync(
    path.join(folder, "scenario.md"),
    `# ${name}\n\n${scenario.say?.length ? `Recruiter then says:\n${scenario.say.map((s) => `- ${s}`).join("\n")}\n\n` : ""}## Checks\n\n${scenario.checks}\n`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const scenarios = option("--scenarios");
  const history = option("--history");
  if (!scenarios || !history) throw new Error("Pass --scenarios <dir> and --history <file>");
  const work = option("--work", path.join(path.dirname(history), "benchmark-work"));
  if (args.includes("--search")) {
    fs.rmSync(work, { recursive: true, force: true });
    const files = fs.readdirSync(scenarios).filter((file) => file.endsWith(".json"));
    for (const file of files)
      for (let sample = 1; sample <= Number(option("--samples", "2")); sample++)
        await playScenario(scenarios, file, sample, work);
  }
  const report = await judgeRound({
    samples: readSamples(work),
    instructions: fs.readFileSync(
      path.join(ROOT, "packages/core/src/recruiting-defaults.ts"),
      "utf8",
    ),
    rubric: fs.readFileSync(path.join(HERE, "rubric.md"), "utf8"),
    cap: new SpendCap({
      capUsd: Number(option("--cap-usd", "5")),
      inPerMTok: Number(process.env.JUDGE_USD_PER_MTOK_IN ?? "15"),
      outPerMTok: Number(process.env.JUDGE_USD_PER_MTOK_OUT ?? "75"),
    }),
  });
  const round = {
    at: new Date().toISOString(),
    release: process.env.RAKAZO_RELEASE_SHA ?? null,
    played: args.includes("--search"),
    ...report.summary,
    fixes: report.fixes,
    judgeUsd: report.spentUsd,
  };
  const change = compareRounds(lastRound(history), round);
  fs.appendFileSync(history, `${JSON.stringify(round)}\n`);
  console.log(
    `${round.passed ? "PASS" : "FAIL"} ${JSON.stringify(round.averages)}` +
      (change ? `; change ${JSON.stringify(change)}` : "; first round") +
      `; judge US$${round.judgeUsd}`,
  );
  process.exitCode = round.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
