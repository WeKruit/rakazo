#!/usr/bin/env node
// Release regression on a live deployment: the live layers of the release gate. Unit tests and
// prompt checks run before deploy (release script); this runs right after it, and a red result
// rolls the release back. Each case starts its own test copy and never answers an approval card,
// so nothing is sent, imported or booked.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_ORIGIN=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/regression.mjs [--suite gate|full] [--cases <dir>] [--only a,b] [--out <dir>]
//   --suite gate   after every deploy: smoke, first10 (short JD), progress question during find-50,
//                  pasted English JD (needs <cases>/t3.txt)
//   --suite full   gate plus first10 (long JD), attached JD with drafts, contacts and send-20
//                  (<cases>/t1.pdf), and the booking card (--t5-group <id> --t5-say <text>)
//   --cases <dir>  private JD fixtures; they stay out of this public repository
//   RAKAZO_EXPECT_SHA  passed to smoke.mjs so /ready must serve the released revision
// Node 20+, no dependencies. Prints no credentials. Exit code 0 only when every case passes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const TOKEN = process.env.RAKAZO_TOKEN;
const { RAKAZO_EMAIL: EMAIL, RAKAZO_PASSWORD: PASSWORD } = process.env;
if (!BASE || !(TOKEN || (EMAIL && PASSWORD)))
  throw new Error("Set RAKAZO_URL and RAKAZO_EMAIL/RAKAZO_PASSWORD (or RAKAZO_TOKEN)");
const SUITE = option("--suite", "gate");
const CASES = option("--cases");
const OUT = option("--out", `regression-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (text) =>
  process.stdout.write(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s] ${text}\n`,
  );

let cookie = "";
async function signIn() {
  if (!EMAIL) return;
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign-in ${response.status}`);
  cookie = (response.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
}

async function rpc(route, json) {
  if (EMAIL && !cookie) await signIn();
  const response = await fetch(`${BASE}/rpc/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : { authorization: `Bearer ${TOKEN}` }),
    },
    body: JSON.stringify({ json }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route} ${response.status}`);
  return body.json;
}

/** Runs one harness script; resolves with its exit code. Output goes to <out>/<name>.log. */
function run(name, script, scriptArgs) {
  const logFile = fs.openSync(path.join(OUT, `${name}.log`), "w");
  const child = spawn(process.execPath, [path.join(HERE, script), ...scriptArgs], {
    stdio: ["ignore", logFile, logFile],
    env: process.env,
  });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

const botText = (message) =>
  (message.blocks ?? [])
    .map((block) => block.text ?? block.question ?? "")
    .filter(Boolean)
    .join("\n");
const recruiterSees = (messages) =>
  messages.filter((message) => message.role !== "user" && !message.internal);
const cards = (messages) =>
  messages.flatMap((message) =>
    (message.blocks ?? [])
      .filter((block) => block.kind === "ask")
      .map((block) => ({ ...block, at: message.createdAt })),
  );
const messagesOf = async (groupId) =>
  (await rpc("threads/messages", { groupId, includePeerRuns: true })).messages ?? [];
const working = async (groupId) =>
  ((await rpc("threads/get", { groupId })).activeRuns ?? []).some(
    (activeRun) => activeRun.status !== "waiting_input",
  );

const VENDORS =
  /\b(autumn|exa|coresignal|fullenrich|contactout|instantly|composio|cal\.com|apollo|openai|codex)\b/i;
const REFUSAL =
  /\b(?:unassessed|not (?:send-)?ready|which (?:\d+|people|candidates)|can(?:no|')t (?:send|look up|choose))\b/i;
/** Checks every recruiter-visible message must pass, whatever the case. */
function commonChecks(messages, failures) {
  for (const message of recruiterSees(messages)) {
    const text = botText(message);
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
    if (han > latin) failures.push(`not English: "${text.slice(0, 80)}"`);
    if (text.includes("、")) failures.push(`Chinese list separator: "${text.slice(0, 80)}"`);
    if (VENDORS.test(text)) failures.push(`vendor name: "${text.match(VENDORS)[0]}"`);
    if (REFUSAL.test(text))
      failures.push(`declined or deferred a request: "${text.match(REFUSAL)[0]}"`);
  }
}
/** The ten: a list of ten LinkedIn names, then a next-step card that recommends one option. */
function tenChecks(messages, failures, { card = true } = {}) {
  const list = recruiterSees(messages).find((message) => /this round:/.test(botText(message)));
  const links = list ? (botText(list).match(/linkedin\.com\/in\//g)?.length ?? 0) : 0;
  if (links < 10) failures.push(`ten listed with LinkedIn links: ${links}/10`);
  if (!card) return;
  const next = cards(messages).find((item) => /what's next/i.test(item.text ?? ""));
  if (!next) failures.push("no next-step card after the ten");
  else if (!/\bI'd\b/.test(next.text)) failures.push("next-step card recommends nothing");
}

/** Sends one recruiter message and waits until the crew settles. Never answers a card. */
async function say(groupId, text, { quietMs = 30_000, limitMs = 15 * 60_000 } = {}) {
  const before = new Set((await messagesOf(groupId)).map((message) => message.id));
  const busy = await working(groupId);
  const sentAt = Date.now();
  await rpc("threads/send", {
    groupId,
    addressing: "coordinator",
    text,
    ...(busy ? { interrupt: true } : {}),
  });
  let count = 0;
  let changed = Date.now();
  let replies = [];
  while (Date.now() - sentAt < limitMs) {
    await sleep(3_000);
    replies = (await messagesOf(groupId)).filter(
      (message) => !before.has(message.id) && message.role !== "user",
    );
    if (replies.length !== count) {
      count = replies.length;
      changed = Date.now();
    }
    if (Date.now() - changed > quietMs && !(await working(groupId))) break;
  }
  return { replies, seconds: Math.round((Date.now() - sentAt) / 1000) };
}

/** Waits until the crew is idle and has posted nothing new for a while; the next-step card follows the ten. */
async function settled(groupId, { quietMs = 20_000, limitMs = 3 * 60_000 } = {}) {
  const startedAt = Date.now();
  let count = -1;
  let changed = Date.now();
  let messages = [];
  while (Date.now() - startedAt < limitMs) {
    messages = await messagesOf(groupId);
    if (messages.length !== count) {
      count = messages.length;
      changed = Date.now();
    }
    if (Date.now() - changed > quietMs && !(await working(groupId))) break;
    await sleep(3_000);
  }
  return messages;
}

const results = [];
async function stage(name, body) {
  const failures = [];
  const at = Date.now();
  log(`${name}: start`);
  try {
    await body(failures);
  } catch (error) {
    failures.push(`error: ${error.message}`);
  }
  const result = {
    name,
    pass: failures.length === 0,
    seconds: Math.round((Date.now() - at) / 1000),
    failures,
  };
  results.push(result);
  log(`${name}: ${result.pass ? "PASS" : `FAIL\n  - ${failures.join("\n  - ")}`}`);
  fs.writeFileSync(path.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
const reportOf = (name) => JSON.parse(fs.readFileSync(path.join(OUT, `${name}.json`), "utf8"));
const wanted = new Set(
  option("--only")?.split(",") ??
    (SUITE === "full"
      ? ["smoke", "first10", "progress", "t3", "first10-long", "t1", "t5"]
      : ["smoke", "first10", "progress", "t3"]),
);

if (wanted.has("smoke"))
  await stage("smoke", async (failures) => {
    // Both hosts: pages, /health, /ready (revision when RAKAZO_EXPECT_SHA is set), rpc, sign-in.
    const code = await run("smoke", "smoke.mjs", ["--wait", "60"]);
    if (code !== 0) failures.push("smoke did not pass; see smoke.log");
  });

if (wanted.has("first10"))
  await stage("first10", async (failures) => {
    const code = await run("first10", "first10-suite.mjs", [
      "--only",
      "short",
      "--out",
      path.join(OUT, "first10"),
    ]);
    if (code !== 0) failures.push("first10 (short JD) did not pass; see first10/summary.md");
  });

if (wanted.has("progress"))
  await stage("progress", async (failures) => {
    // find-50 on the built-in role; a progress question is sent while it scales.
    const out = path.join(OUT, "progress.json");
    const finding = run("progress", "recruiting-latency.mjs", [
      "--target",
      "50",
      "--out",
      out,
      "--keep",
    ]);
    let asked = false;
    let exit;
    finding.then((code) => {
      exit = code;
    });
    while (exit === undefined) {
      await sleep(2_000);
      // The latency harness rewrites its report while running; a half-written file is read again.
      let report = null;
      try {
        report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
      } catch {
        continue;
      }
      if (asked || !report?.groupId || !report.milestones?.scale_sent) continue;
      if (!(await working(report.groupId))) continue;
      asked = true;
      const before = new Set((await messagesOf(report.groupId)).map((message) => message.id));
      const sentAt = Date.now();
      await rpc("threads/send", {
        groupId: report.groupId,
        addressing: "coordinator",
        text: "进度怎么样了",
        interrupt: true,
      });
      let answer;
      while (!answer && Date.now() - sentAt < 15_000) {
        await sleep(500);
        answer = (await messagesOf(report.groupId)).find(
          (message) =>
            !before.has(message.id) &&
            message.role !== "user" &&
            /^Still working:/.test(botText(message)),
        );
      }
      const seconds = (Date.now() - sentAt) / 1000;
      if (!answer) failures.push("no progress answer within 15 s");
      else if (seconds > 3) failures.push(`progress answer took ${seconds.toFixed(1)} s (limit 3)`);
    }
    if (!asked) failures.push("the search finished before a progress question could be sent");
    if (exit !== 0)
      failures.push("find-50 did not pass after the progress question; see progress.log");
    const report = reportOf("progress");
    if (report.groupId) commonChecks(await messagesOf(report.groupId), failures);
  });

if (wanted.has("t3"))
  await stage("t3", async (failures) => {
    const jd = CASES && path.join(CASES, "t3.txt");
    if (!jd || !fs.existsSync(jd)) return failures.push("missing <cases>/t3.txt");
    const code = await run("t3", "recruiting-latency.mjs", [
      "--jd",
      jd,
      "--skip-scale",
      "--keep",
      "--out",
      path.join(OUT, "t3.json"),
    ]);
    if (code !== 0) failures.push("first ten did not pass; see t3.log");
    const messages = await settled(reportOf("t3").groupId);
    commonChecks(messages, failures);
    tenChecks(messages, failures);
    const text = fs.readFileSync(jd, "utf8");
    const statesYears =
      /\d+\s*\+?\s*(?:(?:-|–|to)\s*\d+\s*\+?\s*)?(?:years?|yrs?)\b|\d+\s*年/i.test(text);
    if (!statesYears && !cards(messages).some((card) => /years?/i.test(card.text ?? "")))
      failures.push("JD states no years, and no question asked for a years range");
  });

if (wanted.has("first10-long"))
  await stage("first10-long", async (failures) => {
    const code = await run("first10-long", "first10-suite.mjs", [
      "--only",
      "long",
      "--out",
      path.join(OUT, "first10-long"),
    ]);
    if (code !== 0) failures.push("first10 (long JD) did not pass; see first10-long/summary.md");
  });

if (wanted.has("t1"))
  await stage("t1", async (failures) => {
    const pdf = CASES && path.join(CASES, "t1.pdf");
    if (!pdf || !fs.existsSync(pdf)) return failures.push("missing <cases>/t1.pdf");
    const code = await run("t1", "recruiting-latency.mjs", [
      "--jd-file",
      pdf,
      "--target",
      "50",
      "--scale-text",
      "lets find 50 ",
      "--keep",
      "--out",
      path.join(OUT, "t1.json"),
    ]);
    if (code !== 0) failures.push("start or find-50 did not pass; see t1.log");
    const groupId = reportOf("t1").groupId;
    // The scale message goes in right after the ten, so no next-step card is expected here.
    tenChecks(await settled(groupId), failures, { card: false });
    const draft = await say(groupId, "来个campign draft看看");
    const drafted = draft.replies.map(botText).join("\n");
    fs.writeFileSync(path.join(OUT, "t1-draft.txt"), `${drafted}\n`);
    if ((drafted.match(/subject:/gi)?.length ?? 0) < 3)
      failures.push("campaign draft is not three emails shown in chat");
    if (!/^\s*[-*•]\s/m.test(drafted)) failures.push("job duties in the draft are not bullets");
    const contacts = await say(groupId, "找contact");
    if (!contacts.replies.length) failures.push("「找contact」 got no reply");
    const again = await say(groupId, "找contact");
    if (again.seconds > contacts.seconds)
      failures.push(
        `repeat 「找contact」 slower than the first (${again.seconds} s vs ${contacts.seconds} s)`,
      );
    const send = await say(groupId, "发20个人的先");
    if (
      !send.replies.some((message) =>
        (message.blocks ?? []).some((block) => block.kind === "ask" && block.approvalEffectId),
      )
    )
      failures.push("「发20个人的先」 did not end on a send confirmation card");
    commonChecks(await messagesOf(groupId), failures);
  });

if (wanted.has("t5"))
  await stage("t5", async (failures) => {
    // <cases>/t5.json ({"groupId","say"}) names a private test chat that already has a candidate reply.
    const file = CASES && path.join(CASES, "t5.json");
    const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const groupId = option("--t5-group") ?? saved.groupId;
    const text = option("--t5-say") ?? saved.say;
    if (!groupId || !text)
      return failures.push(
        "pass --t5-group and --t5-say, or <cases>/t5.json, for the booking card case",
      );
    const { replies } = await say(groupId, text);
    const card = cards(replies).find((block) => block.approvalEffectId);
    if (!card) failures.push("no booking confirmation card");
    else if (!/confirm interview booking/i.test(card.text ?? ""))
      failures.push(`card text: "${card.text}"`);
    commonChecks(replies, failures);
  });

const passed = results.every((result) => result.pass);
const summary = [
  `# Regression ${passed ? "PASS" : "FAIL"} (${SUITE}, ${Math.round((Date.now() - started) / 60_000)} min)`,
  "",
  ...results.map(
    (result) =>
      `- ${result.pass ? "PASS" : "FAIL"} ${result.name} (${result.seconds} s)${result.failures.map((failure) => `\n  - ${failure}`).join("")}`,
  ),
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), `${summary}\n`);
log(summary);
process.exit(passed ? 0 : 1);
