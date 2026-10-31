#!/usr/bin/env node
// Release regression on a live deployment: the live layers of the release gate. Unit tests and
// prompt checks run before deploy (release script); this runs right after it, and a red result
// rolls the release back. Each case starts its own test copy and never answers an approval card,
// except cards: it clicks every card in the web app, approving a send or booking only on the
// internal fixtures (@wekruit.com recipients) and cancelling the booking it makes.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_ORIGIN=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/regression.mjs [--suite gate|full] [--cases <dir>] [--only a,b] [--out <dir>]
//   --suite gate   after every deploy: smoke, first10 (short JD), progress question during find-50
//                  (which must end with a report stating the new count), pasted English JD
//                  (needs <cases>/t3.txt), contacts (找contact twice and send-20 on a fresh first
//                  ten of <cases>/t1.pdf, ending on the unanswered send card). cards (full suite or --only cards; it searches, so it costs
//                  money: card-e2e.mjs clicks question, send and booking cards
//                  clicked in the browser; needs RAKAZO_EMAIL/RAKAZO_PASSWORD and <cases>/cards.json
//                  {"sendGroup","sendRoleMark","bookingGroup"})
//   --suite full   gate plus midwork (a new requirement and an after-you-finish message sent
//                  during find-100 each get their own reply), first10 (long JD), attached JD with drafts, contacts and send-20
//                  (<cases>/t1.pdf), dispatch (each specialist capability asked of the
//                  coordinator in the t1 chat, or --dispatch-group <id>), ambiguous (vague asks
//                  in the same chat, or --ambiguous-group <id>: an action or one question card,
//                  never a decline or deferral), and the booking card
//                  (--t5-group <id> --t5-say <text>), and answering a question card whose wait
//                  expired (--expired-group <id>, a test chat with a question left unanswered for a day)
//   --cases <dir>  private JD fixtures; they stay out of this public repository
//   --paid         required for any case that searches (first10, progress, t1, t3, contacts, cards,
//                  dispatch, ambiguous); without it only the free checks may run
//   RAKAZO_EXPECT_SHA  passed to smoke.mjs so /ready must serve the released revision
// Node 20+, no dependencies. Prints no credentials. Exit code 0 only when every case passes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFollowUpDelivery, replyAfterInput } from "./follow-up.mjs";
import { verifyGlobalRecruiting } from "./global-recruiting.mjs";
import { verifyGlobalRecruitingChat } from "./global-recruiting-chat.mjs";
import { checkNotificationPolicy } from "./notification-policy.mjs";
import { checkReviewerGrading } from "./reviewer-grading.mjs";
import { assertSlowToolPromotion } from "./slow-tool.mjs";
import { checkBackgroundTiming, checkToolTiming } from "./tool-timing.mjs";
import {
  checkCardsAfterReconnect,
  checkFailureRecoveryUi,
  checkStageTranscript,
  sendWithImmediateFeedback,
  withConversationPage,
} from "./workloop-browser.mjs";
import {
  assertCancelOneTask,
  assertStopEverything,
  assertStopKeepsBackground,
  assertTestCopy,
} from "./workloop-task-controls.mjs";

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
  let response;
  // Sign-in is rate limited; right after a deploy the smoke check may have used the allowance.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (response.status !== 429) break;
    await sleep(60_000);
  }
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

// Handoff text between agents shows only in the developer view.
const botText = (message) =>
  (message.blocks ?? [])
    .filter((block) => block.kind !== "handoff")
    .map((block) => block.text ?? block.question ?? "")
    .filter(Boolean)
    .join("\n");
// What the reply itself says for the refusal checks: card questions are left out, and a reply that
// shows a draft delivered it (the server never retries one), so only its closing paragraph counts.
const DRAFT_START = /(?:^|\n)\s*(?:[#*_]+\s*)?(?:Email \d|Subject:)/i;
const ownWords = (message) => {
  const text = botText({ blocks: (message.blocks ?? []).filter((block) => block.kind !== "ask") });
  const draft = text.search(DRAFT_START);
  if (draft < 0) return text;
  // A reply that shows the draft delivered it: only a closing question or refusal after it counts.
  const after = text
    .slice(draft)
    .trimEnd()
    .split(/\n\s*\n/);
  return after.length > 1 ? (after.at(-1) ?? "") : "";
};
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
// "Which people…?" asks the recruiter to pick instead of doing it; "I'll check which people…" is fine.
const REFUSAL =
  /\b(?:unassessed|not (?:send-)?ready|which (?:\d+(?![-:])|people|candidates)\b[^.!?\n]*\?|can(?:no|['’])t (?:send|look up|choose))/i;
// The model thinking aloud in a reply, seen while it spelled unusual email addresses.
const SELF_TALK = /\?\s*Wait\.|\bNeed correctly\b/;
/** Checks every recruiter-visible message must pass, whatever the case. */
function commonChecks(messages, failures) {
  for (const message of recruiterSees(messages)) {
    const text = botText(message);
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
    if (han > latin) failures.push(`not English: "${text.slice(0, 80)}"`);
    if (text.includes("、")) failures.push(`Chinese list separator: "${text.slice(0, 80)}"`);
    if (VENDORS.test(text)) failures.push(`vendor name: "${text.match(VENDORS)[0]}"`);
    const selfTalk = text.match(SELF_TALK);
    if (selfTalk)
      failures.push(
        `self-talk in reply: "…${text.slice(Math.max(0, selfTalk.index - 60), selfTalk.index + 40)}…"`,
      );
    // A question card asks "which people…?" by design; only the reply's own words can refuse.
    const said = ownWords(message);
    const refusal = said.match(REFUSAL);
    if (refusal)
      failures.push(
        `declined or deferred a request: "…${said.slice(Math.max(0, refusal.index - 80), refusal.index + 80)}…"`,
      );
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

/**
 * The scale-out turn ends with a report that states the new count: its last text, before any
 * card, names more people than the role had when the request was sent. A card or a guard may
 * follow the report but never stand in for it.
 */
function scaleReportChecks(messages, failures, scale) {
  if (!scale?.at) return failures.push("no scale request was sent");
  const sentAt = Date.parse(scale.at);
  const later = messages.filter((message) => Date.parse(message.createdAt) > sentAt);
  // The window ends at the recruiter's next message; a progress question does not end it. The
  // scale request itself can be stamped just after the harness clock read, so it is skipped.
  const next = later.find(
    (message) =>
      message.role === "user" &&
      Date.parse(message.createdAt) > sentAt + 15_000 &&
      !message.internal &&
      !/进度|how(?:['’]s| is) it going|status/i.test(botText(message)),
  );
  const turn = recruiterSees(later).filter(
    (message) =>
      (!next || Date.parse(message.createdAt) < Date.parse(next.createdAt)) &&
      !/^Still working:/.test(botText(message)),
  );
  const texts = turn
    .map((message) =>
      (message.blocks ?? [])
        .filter((block) => block.kind === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
    )
    .filter((text) => text.trim());
  const last = texts.at(-1);
  if (!last) return failures.push("scale-out ended without a report");
  // "154 people", "119 of 119", "Results now holds 119", "bringing Results to 119".
  const counts = [
    ...last.matchAll(
      /(\d{2,})\s*(?:more\s+|new\s+)?(?:people|candidates|profiles|人)|(\d{2,})\s+of\s+(?:the\s+)?\d{2,}|(?:holds|contains|has|at|to|reach(?:es|ing)?|now|total(?: of)?)\s+\**(\d{2,})/gi,
    ),
  ].map((match) => Number(match[1] ?? match[2] ?? match[3]));
  const before = Number(scale.before ?? 0);
  if (!counts.some((count) => count > before))
    failures.push(
      `scale-out report does not state the new count (had ${before}): "${last.slice(0, 160)}"`,
    );
}

// The send confirmation card: an approval the recruiter has not answered.
const sendCard = (message) =>
  (message.blocks ?? []).some((block) => block.kind === "ask" && block.approvalEffectId);

/** Every event of a thread so far, from the replay of its event stream. */
async function readEvents(groupId, { limitMs = 15_000 } = {}) {
  const controller = new AbortController();
  // A busy stream must not keep replay open beyond a latency assertion's budget.
  const replayLimit = setTimeout(() => controller.abort(), limitMs);
  let idle = setTimeout(() => controller.abort(), 15_000);
  const events = [];
  try {
    if (EMAIL && !cookie) await signIn();
    const response = await fetch(`${BASE}/rpc/threads/subscribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin: ORIGIN,
        ...(cookie ? { cookie } : { authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify({ json: { groupId, cursor: 0 } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`threads/subscribe ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // The replay arrives at once; a quiet stream means it has caught up.
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 3_000);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5));
          events.push(data.json ?? data);
        } catch {}
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(replayLimit);
  }
  return events;
}
// A contact lookup reply lists addresses or says how many people have one, not only that it is checking.
const COUNT = String.raw`(?:\d+|all|none)`;
const CONTACT_WORD = String.raw`(?:e-?mails?|address(?:es)?|contacts?|邮箱|联系方式)`;
const CONTACT_REPORT = new RegExp(
  [
    String.raw`[\w.+-]+@[\w-]+\.\w`,
    String.raw`\bno ${CONTACT_WORD}\b[^.\n]{0,20}\bfound\b`,
    String.raw`${CONTACT_WORD}[^.\n]{0,80}\b${COUNT}\b`,
    String.raw`\b${COUNT}\b[^.\n]{0,80}${CONTACT_WORD}`,
  ].join("|"),
  "i",
);

/** Sends one recruiter message and waits until the crew settles. Never answers a card. */
async function say(groupId, text, { quietMs = 30_000, limitMs = 15 * 60_000, until } = {}) {
  await assertTestCopy(rpc, groupId);
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
  let firstReply = null;
  while (Date.now() - sentAt < limitMs) {
    await sleep(3_000);
    replies = (await messagesOf(groupId)).filter(
      (message) => !before.has(message.id) && message.role !== "user",
    );
    if (replies.length !== count) {
      count = replies.length;
      changed = Date.now();
      firstReply ??= Math.round((changed - sentAt) / 1000);
    }
    if (until?.(replies)) break;
    if (!until && Date.now() - changed > quietMs && !(await working(groupId))) {
      // A handed-in specialist can work for a while without posting: tool events count as activity.
      const latest = Math.max(
        0,
        ...(await readEvents(groupId).catch(() => [])).map((event) => Date.parse(event.createdAt)),
      );
      if (Date.now() - latest < quietMs) continue;
      break;
    }
  }
  return { replies, firstReply, seconds: Math.round((Date.now() - sentAt) / 1000) };
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
      ? [
          "smoke",
          "isolation",
          "global-recruiting",
          "first10",
          "progress",
          "midwork",
          "t3",
          "first10-long",
          "t1",
          "dispatch",
          "ambiguous",
          "cards",
          "t5",
          "expired",
        ]
      : ["smoke", "global-recruiting", "isolation", "first10", "progress", "t3", "contacts"]),
);

// Cases that start a people search pay for it, its grading and any contact lookups. They run only
// with --paid: after a change to search, grading or contact code, with small targets. Every other
// check is free.
const PAID_CASES = [
  "first10",
  "first10-long",
  "progress",
  "t1",
  "t3",
  "contacts",
  "cards",
  "dispatch",
  "ambiguous",
];
const paid = PAID_CASES.filter((name) => wanted.has(name));
if (paid.length && !args.includes("--paid"))
  throw new Error(
    `${paid.join(", ")} spend on people search; pass --paid only after a search, grading or contact change`,
  );

// Every copy this run made leaves the sidebar, and older idle copies are swept, even when a case
// or the harness itself stops early. Keeps the booking fixture the t5 case reuses. A sweep that
// leaves an idle copy unarchived fails the run.
async function cleanUp() {
  // The read-only global case archives only its validated copies in its own finally block.
  if (wanted.size === 1 && wanted.has("global-recruiting")) return;
  const t5 = CASES && path.join(CASES, "t5.json");
  const keep =
    option("--t5-group") ??
    (t5 && fs.existsSync(t5) ? JSON.parse(fs.readFileSync(t5, "utf8")).groupId : "");
  for (const file of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) {
    if (!file.endsWith(".json")) continue;
    let groupId;
    try {
      groupId = JSON.parse(fs.readFileSync(path.join(OUT, file), "utf8")).groupId;
    } catch {
      continue;
    }
    if (typeof groupId === "string" && groupId && groupId !== keep)
      await rpc("groups/archive", { groupId }).catch((error) => log(error.message));
  }
  const code = await run("archive-copies", "archive-test-copies.mjs", [
    "--idle-hours",
    "2",
    ...(keep ? ["--keep", keep] : []),
  ]);
  if (code !== 0) {
    passed = false;
    log("archive-copies: FAIL (idle test copies left unarchived; see archive-copies.log)");
  }
}

let passed = false;
try {
  if (wanted.has("global-recruiting"))
    await stage("global-recruiting", async (failures) => {
      const file =
        option("--global-fixtures") ?? (CASES && path.join(CASES, "global-recruiting.json"));
      if (!file || !fs.existsSync(file))
        return failures.push(
          "Provide --global-fixtures or <cases>/global-recruiting.json listing the product and CRM test copies",
        );
      const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
      // Read-only: the listed copies stay in place for the next release.
      const result = await verifyGlobalRecruiting(rpc, fixture);
      result.nativeChat = args.includes("--global-chat")
        ? await verifyGlobalRecruitingChat(rpc, fixture, { say, readEvents })
        : {
            tested: false,
            reason: "not tested: native chat requires approved model calls and --global-chat",
          };
      fs.writeFileSync(path.join(OUT, "global-recruiting.json"), JSON.stringify(result, null, 2));
    });

  if (wanted.has("smoke"))
    await stage("smoke", async (failures) => {
      // Both hosts: pages, /health, /ready (revision when RAKAZO_EXPECT_SHA is set), rpc, sign-in.
      const code = await run("smoke", "smoke.mjs", ["--wait", "60"]);
      if (code !== 0) failures.push("smoke did not pass; see smoke.log");
    });

  if (wanted.has("isolation"))
    await stage("isolation", async (failures) => {
      const code = await run("isolation", "account-isolation.mjs", [
        "--out",
        path.join(OUT, "isolation.json"),
      ]);
      if (code !== 0) failures.push("account isolation did not pass; see isolation.log");
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
      let stoppedCurrent = false;
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
        if (!report?.groupId || !report.milestones?.scale_sent) continue;
        if (
          asked &&
          !stoppedCurrent &&
          (await rpc("threads/backgroundTasks", { groupId: report.groupId })).length
        ) {
          await assertStopKeepsBackground(rpc, report.groupId);
          stoppedCurrent = true;
        }
        if (asked) continue;
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
        else if (seconds > 3)
          failures.push(`progress answer took ${seconds.toFixed(1)} s (limit 3)`);
      }
      if (!asked) failures.push("the search finished before a progress question could be sent");
      if (!stoppedCurrent)
        failures.push("Stop mid-search was not exercised against running background work");
      if (exit !== 0)
        failures.push("find-50 did not pass after the progress question; see progress.log");
      const report = reportOf("progress");
      if (report.groupId) {
        const messages = await settled(report.groupId);
        commonChecks(messages, failures);
        scaleReportChecks(messages, failures, report.milestones?.scale_sent);
        checkToolTiming(messages);
        checkBackgroundTiming(await rpc("threads/get", { groupId: report.groupId }));
        const grading = await checkReviewerGrading(rpc, report.groupId, readEvents);
        fs.writeFileSync(path.join(OUT, "progress-reviewer.json"), JSON.stringify(grading));
        const events = await readEvents(report.groupId);
        const event = events.find(
          (event) => event.type === "thread.message.created" && event.payload?.role === "bot",
        );
        if (!event) failures.push("notification regression needs a real bot reply event");
        else await checkNotificationPolicy(rpc, { threadId: event.threadId, eventId: event.id });
      }
    });

  if (wanted.has("midwork"))
    await stage("midwork", async (failures) => {
      // Workloop's busy-input contract on a find-100: a new requirement sent mid-search is
      // answered within a minute and shapes the rest of the work, an "after you finish" message
      // waits for the answer, and every message the recruiter sent gets its own reply.
      const out = path.join(OUT, "midwork.json");
      const finding = run("midwork", "recruiting-latency.mjs", [
        "--target",
        "100",
        "--out",
        out,
        "--keep",
      ]);
      let exit;
      finding.then((code) => {
        exit = code;
      });
      let steer;
      let follow;
      let groupId;
      while (exit === undefined) {
        await sleep(2_000);
        let report = null;
        try {
          report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
        } catch {
          continue;
        }
        if (!report?.groupId || !report.milestones?.scale_sent) continue;
        groupId = report.groupId;
        if (!(await working(groupId))) continue;
        if (!steer) {
          steer = await rpc("threads/send", {
            groupId,
            addressing: "coordinator",
            text: "另外，优先找湾区（San Francisco Bay Area）的人。",
          });
          steer.sentAt = Date.now();
          continue;
        }
        if (!follow && Date.now() - steer.sentAt > 20_000) {
          follow = await rpc("threads/send", {
            groupId,
            addressing: "coordinator",
            text: "全部做完以后，用一句话告诉我一共找到多少人、其中多少在湾区。",
            queueMode: "follow_up",
          });
        }
      }
      if (!groupId) return failures.push("find-100 never started scaling; see midwork.log");
      if (!steer) return failures.push("the search finished before a mid-work message was sent");
      const messages = await settled(groupId, { limitMs: 10 * 60_000 });
      const events = await readEvents(groupId);
      const steerReply = replyAfterInput(events, messages, steer.seq);
      if (!steerReply) failures.push("the mid-search requirement got no reply of its own");
      else if (Date.parse(steerReply.createdAt) - steer.sentAt > 60_000)
        failures.push("the mid-search requirement was answered after more than 60 s");
      const after = messages.filter(
        (message) => message.role !== "user" && message.seq > steer.seq,
      );
      if (!after.some((message) => /湾区|Bay Area|San Francisco|旧金山/i.test(botText(message))))
        failures.push("no reply after the new requirement mentions the Bay Area");
      if (follow) {
        const delayed = messages.find(
          (message) => message.role === "user" && message.seq === follow.seq,
        );
        if (!delayed) failures.push("the after-you-finish message was not saved");
        else {
          try {
            assertFollowUpDelivery(events, delayed.id, follow.runId);
          } catch (error) {
            failures.push(String(error.message ?? error));
          }
          if (!replyAfterInput(events, messages, follow.seq))
            failures.push("the after-you-finish message got no reply");
        }
      } else failures.push("the search finished before the after-you-finish message was sent");
      commonChecks(messages, failures);
      fs.writeFileSync(
        path.join(OUT, "midwork-chat.txt"),
        `${messages.map((message) => `[${message.role}] ${botText(message)}`).join("\n\n")}\n`,
      );
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

  // The contact and send steps on a fresh first ten, short enough for every release: 找contact,
  // 找contact again and 发20个人的先 up to the send card, which is never answered.
  if (wanted.has("contacts"))
    await stage("contacts", async (failures) => {
      const pdf = CASES && path.join(CASES, "t1.pdf");
      if (!pdf || !fs.existsSync(pdf)) return failures.push("missing <cases>/t1.pdf");
      const code = await run("contacts", "recruiting-latency.mjs", [
        "--jd-file",
        pdf,
        "--skip-scale",
        "--keep",
        "--out",
        path.join(OUT, "contacts.json"),
      ]);
      // The first ten's own timing is the first10 case's; here it only has to leave people to contact.
      const report = fs.existsSync(path.join(OUT, "contacts.json")) ? reportOf("contacts") : {};
      if (!report.groupId || !report.rounds?.[0]?.count)
        return failures.push(`no first ten to contact (exit ${code}); see contacts.log`);
      const groupId = report.groupId;
      await settled(groupId);
      await contactsAndSend(groupId, failures);
      const transcript = (await messagesOf(groupId))
        .map((message) => `[${message.role}] ${botText(message)}`)
        .join("\n\n");
      fs.writeFileSync(path.join(OUT, "contacts-chat.txt"), `${transcript}\n`);
      commonChecks(await messagesOf(groupId), failures);
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
      // The scale message goes in right after the ten, so no next-step card is expected here, and
      // the scale-out ends with its own report.
      const scaled = await settled(groupId);
      tenChecks(scaled, failures, { card: false });
      scaleReportChecks(scaled, failures, reportOf("t1").milestones?.scale_sent);
      const draft = await say(groupId, "来个campign draft看看", {
        until: (replies) =>
          (replies
            .map(botText)
            .join("\n")
            .match(/subject:/gi)?.length ?? 0) >= 3,
        limitMs: 8 * 60_000,
      });
      const drafted = recruiterSees(draft.replies).map(botText).join("\n");
      fs.writeFileSync(path.join(OUT, "t1-draft.txt"), `${drafted}\n`);
      if (/\{\{\s*\w+\s*\}\}/.test(drafted))
        failures.push("campaign draft in chat shows {{variables}}");
      if ((drafted.match(/subject:/gi)?.length ?? 0) < 3)
        failures.push("campaign draft is not three emails shown in chat");
      if (!/^\s*[-*•]\s/m.test(drafted)) failures.push("job duties in the draft are not bullets");
      await withConversationPage(
        { rpc, origin: ORIGIN, cookie, token: TOKEN, groupId },
        async (page) => {
          const lookup = await rpc("threads/send", {
            groupId,
            addressing: "coordinator",
            text: "找contact",
          });
          const lookupMessage = (await messagesOf(groupId)).find(
            (message) => message.role === "user" && message.seq === lookup.seq,
          );
          if (!lookupMessage) throw new Error("lookup source message was not persisted");
          const toolWaitAt = Date.now();
          let activePromotion;
          while (!activePromotion && Date.now() - toolWaitAt < 45_000) {
            const events = await readEvents(groupId, {
              limitMs: Math.min(15_000, 45_000 - (Date.now() - toolWaitAt)),
            });
            const source = events.find(
              (event) =>
                event.type === "thread.message.created" &&
                event.payload?.role === "user" &&
                event.payload?.messageId === lookupMessage.id,
            );
            if (!source) throw new Error("lookup source event was not persisted");
            // Include native delegated peers, but never an old tool from before this lookup.
            activePromotion = events.find(
              (event) =>
                event.type === "run.started" &&
                event.seq > source.seq &&
                event.payload?.backgrounded === true &&
                event.payload?.trigger === "tool_background" &&
                events.some(
                  (called) =>
                    called.type === "agent.tool.called" &&
                    called.seq > source.seq &&
                    called.runId === event.runId &&
                    called.payload?.executionId === event.payload.executionId,
                ) &&
                !events.some(
                  (done) =>
                    done.type === "agent.tool.completed" &&
                    done.runId === event.runId &&
                    done.payload?.executionId === event.payload.executionId,
                ),
            );
            if (!activePromotion)
              await sleep(Math.max(0, Math.min(500, 45_000 - (Date.now() - toolWaitAt))));
          }
          if (!activePromotion)
            throw new Error(
              "slow-tool regression was not exercised: no new promoted lookup tool remained active before the repeat",
            );
          const repeated = await sendWithImmediateFeedback(page, "找contact");
          const snapshot = await rpc("threads/get", { groupId });
          const previous = (snapshot.activeRuns ?? []).find((run) =>
            ["user", "follow_up", "resume"].includes(run.trigger),
          );
          if (!previous)
            throw new Error("follow_up regression needs the person's current reply still running");
          const followText = "等当前回复说完，再用一句话总结本次联系人查找结果；不要再搜索或查找。";
          const follow = await sendWithImmediateFeedback(page, followText, {
            queueMode: "follow_up",
          });
          let firstReply = null;
          while (Date.now() - repeated.startedAt < 60_000 && firstReply === null) {
            const events = await readEvents(groupId);
            const reply = replyAfterInput(events, await messagesOf(groupId), repeated.receipt.seq);
            if (reply && Date.parse(reply.createdAt) - repeated.startedAt < 60_000)
              firstReply = Math.max(0, Date.parse(reply.createdAt) - repeated.startedAt);
            else await sleep(500);
          }
          if (firstReply === null)
            throw new Error("repeat 找contact received no visible reply within 60 seconds");
          fs.writeFileSync(
            path.join(OUT, "t1-feedback.json"),
            JSON.stringify({ feedbackMs: repeated.feedbackMs, firstReplyMs: firstReply }),
          );
          await settled(groupId);
          const delayed = (await messagesOf(groupId)).find(
            (message) => message.role === "user" && message.seq === follow.receipt.seq,
          );
          if (!delayed) throw new Error("follow_up message was not persisted");
          const completedEvents = await readEvents(groupId);
          assertFollowUpDelivery(completedEvents, delayed.id, follow.receipt.runId);
          const repeatedMessage = (await messagesOf(groupId)).find(
            (message) => message.role === "user" && message.seq === repeated.receipt.seq,
          );
          if (!repeatedMessage) throw new Error("repeat contact message was not persisted");
          const promotion = assertSlowToolPromotion(completedEvents, repeatedMessage.id);
          fs.writeFileSync(path.join(OUT, "t1-slow-tool.json"), JSON.stringify(promotion));
          await page.screenshot({ path: path.join(OUT, "t1-busy-feedback.png"), fullPage: true });
        },
      );
      // The lookup and sequence save can pause long enough to look idle, so wait for the card itself.
      const send = await say(groupId, "发20个人的先", {
        until: (replies) => replies.some(sendCard),
        limitMs: 8 * 60_000,
      });
      if (!send.replies.some(sendCard))
        failures.push("「发20个人的先」 did not end on a send confirmation card");
      await withConversationPage(
        { rpc, origin: ORIGIN, cookie, token: TOKEN, groupId },
        async (page) => {
          await checkCardsAfterReconnect(rpc, page, groupId);
          await checkStageTranscript(page);
          const recovery = await checkFailureRecoveryUi(page, { rpc, groupId });
          fs.writeFileSync(path.join(OUT, "t1-recovery.json"), JSON.stringify(recovery));
          await page.screenshot({ path: path.join(OUT, "t1-card-deadlines.png"), fullPage: true });
        },
      );
      const transcript = (await messagesOf(groupId))
        .map((message) => `[${message.role}] ${botText(message)}`)
        .join("\n\n");
      fs.writeFileSync(path.join(OUT, "t1-chat.txt"), `${transcript}\n`);
      commonChecks(await messagesOf(groupId), failures);
      const pendingTasks = await rpc("threads/backgroundTasks", { groupId });
      const approvalRunId = send.replies.find(sendCard)?.runId;
      const approvalTask = pendingTasks.find(
        (task) => task.kind === "run" && task.id === approvalRunId,
      );
      if (!approvalTask)
        failures.push(
          "per-task cancellation was not exercised: the unanswered approval has no active native teammate task",
        );
      else await assertCancelOneTask(rpc, groupId, approvalTask.id);
      await assertStopEverything(rpc, groupId);
    });

  // Each ask names a specialist capability; the coordinator must get it done by the member who has
  // it (or do it itself), never decline. Cards are left unanswered, so nothing is sent or booked.
  const DISPATCH = [
    { ask: "再找20个人", owners: /sourc|main/i, capability: "search and scale" },
    { ask: "帮我找前5个人的邮箱", owners: /outreach/i, capability: "contact lookup" },
    // Asked again: everyone was already looked up, so no source may be paid for them again.
    {
      ask: "前5个人的contact",
      owners: /outreach|main/i,
      capability: "repeat contact lookup",
      repeatLookup: true,
    },
    { ask: "给第一个人写一封邮件草稿", owners: /outreach/i, capability: "email draft" },
    // A one-person send right after the draft ends on its confirmation card, never a decline.
    {
      ask: "send this email to them",
      owners: /outreach/i,
      capability: "send confirmation",
      sendCard: true,
    },
    { ask: "下周二我有哪些时间可以面试", owners: /schedul/i, capability: "availability" },
    { ask: "帮第一个人约下周三下午的面试", owners: /schedul/i, capability: "booking" },
    { ask: "把这个面试改到下周四", owners: /schedul/i, capability: "reschedule" },
  ];
  // The turn's result is its last words; its opening line only says what it is about to do.
  const lastReply = (replies) =>
    recruiterSees(replies)
      .map(botText)
      .filter((text) => text.trim())
      .at(-1) ?? "";
  /** 找contact, 找contact again and 发20个人的先 in a role chat with saved people. */
  async function contactsAndSend(groupId, failures) {
    const startedAt = new Date().toISOString();
    const contacts = await say(groupId, "找contact");
    if (!contacts.replies.length) failures.push("「找contact」 got no reply");
    else if (!CONTACT_REPORT.test(lastReply(contacts.replies)))
      failures.push("「找contact」 reply does not say who has an email");
    const askedAgain = new Date().toISOString();
    const again = await say(groupId, "找contact");
    if (again.firstReply === null || again.firstReply > 60)
      failures.push(
        `repeat 「找contact」 first reply after ${again.firstReply ?? "never"} s (limit 60 s)`,
      );
    else if (!CONTACT_REPORT.test(lastReply(again.replies)))
      failures.push("repeat 「找contact」 reply does not say who has an email");
    const events = await readEvents(groupId).catch(() => []);
    // Everyone was looked up a moment ago, so the repeat may not pay a source for anyone again.
    const paid = events
      .filter(
        (event) =>
          event.type === "agent.tool.completed" &&
          event.createdAt > askedAgain &&
          event.payload?.lookup,
      )
      .reduce((sum, event) => sum + Number(event.payload.lookup.paid_lookups ?? 0), 0);
    if (paid) failures.push(`repeat 「找contact」 paid ${paid} source lookup(s) again`);
    // The lookup and sequence save can pause long enough to look idle, so wait for the card itself.
    const send = await say(groupId, "发20个人的先", {
      until: (replies) => replies.some(sendCard),
      limitMs: 8 * 60_000,
    });
    if (!send.replies.some(sendCard))
      failures.push("「发20个人的先」 did not end on a send confirmation card");
    // Tool calls and runs of these steps, kept before the end-of-run archive.
    fs.writeFileSync(
      path.join(OUT, "contacts.events.json"),
      JSON.stringify(
        (await readEvents(groupId).catch(() => [])).filter(
          (event) =>
            event.createdAt > startedAt &&
            /^(?:agent\.tool\.|run\.|thread\.message\.)/.test(event.type),
        ),
        null,
        1,
      ),
    );
  }
  const DECLINED =
    /\b(?:I (?:can(?:no|['’])t|(?:could(?:n['’]t| not)|was(?:n['’]t| not) able to)(?! (?:find|locate|reach|check|verify|confirm))|am unable to|['’]m unable to|['’]m not able to|don['’]t have (?:access|a tool|the ability))|(?:that['’]s|this is|it['’]s) (?:outside|beyond) (?:my|what I)|not something I can)\b|我(?:无法|不能|没法|做不了)/i;
  // Offering the work back instead of doing it; the server retries these once, so one left in a
  // reply means the retry did not take.
  const DEFERRED =
    /\b(?:do you want|would you like|want) me to\b|\bshall I\b|要不要我|是否需要我|需要你先/i;

  // What each step's messages and runs looked like, kept before the end-of-run archive: block kinds
  // and text lengths only, so a silent or hidden reply can be told apart from a cut-off run.
  const traceOf = (events, replies) => ({
    events: events.filter((event) => /^(?:agent\.tool\.|run\.|thread\.message\.)/.test(event.type)),
    messages: replies.map((message) => ({
      id: message.id,
      role: message.role,
      botId: message.botId,
      internal: Boolean(message.internal),
      createdAt: message.createdAt,
      blocks: (message.blocks ?? []).map((block) => ({
        kind: block.kind,
        text: (block.text ?? block.question ?? "").length,
        ...(block.status ? { status: block.status } : {}),
      })),
    })),
  });

  if (wanted.has("dispatch"))
    await stage("dispatch", async (failures) => {
      const groupId =
        option("--dispatch-group") ?? (wanted.has("t1") ? reportOf("t1").groupId : undefined);
      if (!groupId) return failures.push("pass --dispatch-group or run t1 first");
      const { members } = await rpc("groups/get", { groupId });
      const nameOf = new Map(members.map((member) => [member.botId, member.name ?? ""]));
      const notes = [];
      const steps = [];
      for (const item of DISPATCH) {
        const askedAt = new Date().toISOString();
        const { replies } = await say(groupId, item.ask, {
          quietMs: 45_000,
          limitMs: 6 * 60_000,
          ...(item.sendCard ? { until: (replies) => replies.some(sendCard) } : {}),
        });
        if (item.sendCard && !replies.some(sendCard))
          failures.push(`${item.capability}: did not end on a send confirmation card`);
        if (item.repeatLookup) {
          // Everyone was already looked up, so no lookup in this turn may pay a source again.
          const paid = (await readEvents(groupId))
            .filter(
              (event) =>
                event.type === "agent.tool.completed" &&
                event.createdAt > askedAt &&
                event.payload?.lookup,
            )
            .reduce((sum, event) => sum + Number(event.payload.lookup.paid_lookups ?? 0), 0);
          if (paid) failures.push(`${item.capability}: paid ${paid} source lookup(s) again`);
        }
        const handlers = new Set(
          replies.flatMap((message) => [
            nameOf.get(message.botId) ?? "",
            ...(message.blocks ?? [])
              .filter((block) => block.kind === "handoff")
              .map((block) => nameOf.get(block.toBotId) ?? ""),
          ]),
        );
        const text = recruiterSees(replies).map(botText).join("\n");
        notes.push(
          `## ${item.capability}: ${item.ask}\nhandled by: ${[...handlers].filter(Boolean).join(", ")}\n${text}`,
        );
        if (!replies.length) failures.push(`${item.capability}: no reply`);
        else if (![...handlers].some((name) => item.owners.test(name)))
          failures.push(
            `${item.capability}: not handled by the member who can (${[...handlers].filter(Boolean).join(", ") || "nobody"})`,
          );
        const said = recruiterSees(replies).map(ownWords).join("\n");
        const declined = said.match(DECLINED);
        if (declined)
          failures.push(
            `${item.capability}: declined "…${said.slice(Math.max(0, declined.index - 60), declined.index + 80)}…"`,
          );
        commonChecks(replies, failures);
        // Each step's tool calls, kept before the end-of-run archive makes the group unreadable.
        steps.push({
          capability: item.capability,
          ask: item.ask,
          ...traceOf(
            (await readEvents(groupId).catch(() => [])).filter(
              (event) => event.createdAt > askedAt,
            ),
            replies,
          ),
        });
      }
      fs.writeFileSync(path.join(OUT, "dispatch.txt"), `${notes.join("\n\n")}\n`);
      fs.writeFileSync(path.join(OUT, "dispatch.events.json"), JSON.stringify(steps, null, 1));
    });

  // Vague recruiter asks in the t1 chat: each gets a best-guess action (a tool call, a handoff, or
  // the action's own card) or exactly one question card, never a decline or an offer to do it.
  // Cards are left unanswered, so nothing is sent or booked.
  // "clarify": who, what or when is open, so the turn must end on one card: a question with
  // options, or the send/booking card naming exact recipients. The rest may act on a stated
  // reading or ask. A card's own question may say why it asks; only the reply's words are checked
  // for a refusal.
  const AMBIGUOUS = [
    { ask: "发一下", clarify: true },
    { ask: "约一下他", clarify: true },
    { ask: "这个人怎么样" },
    { ask: "处理一下前几个" },
    { ask: "contact" },
    { ask: "再来点" },
    { ask: "改一下邮件", clarify: true },
  ];
  if (wanted.has("ambiguous"))
    await stage("ambiguous", async (failures) => {
      const groupId =
        option("--ambiguous-group") ??
        option("--dispatch-group") ??
        (wanted.has("t1") ? reportOf("t1").groupId : undefined);
      if (!groupId) return failures.push("pass --ambiguous-group or run t1 first");
      const notes = [];
      const steps = [];
      for (const { ask, clarify } of AMBIGUOUS) {
        const askedAt = new Date().toISOString();
        const { replies } = await say(groupId, ask, { quietMs: 45_000, limitMs: 6 * 60_000 });
        const allEvents = (await readEvents(groupId).catch(() => [])).filter(
          (event) => event.createdAt > askedAt,
        );
        const events = allEvents.filter((event) => event.type.startsWith("agent.tool."));
        const acted =
          events.some((event) => event.type === "agent.tool.completed") ||
          replies.some((message) =>
            (message.blocks ?? []).some((block) => block.kind === "handoff"),
          );
        const asks = cards(recruiterSees(replies));
        const text = recruiterSees(replies).map(botText).join("\n");
        notes.push(`## ${ask}\ntools: ${events.length}, cards: ${asks.length}\n${text}`);
        if (!replies.length) failures.push(`「${ask}」: no reply`);
        else if (!text.trim() && !asks.length)
          failures.push(`「${ask}」: ended with nothing the recruiter can see`);
        else if (clarify && asks.length !== 1)
          failures.push(
            `「${ask}」: unclear request ended on ${asks.length} cards (want one question)`,
          );
        else if (!acted && asks.length !== 1)
          failures.push(`「${ask}」: no action and ${asks.length} question cards (want one)`);
        const said = recruiterSees(replies).map(ownWords).join("\n");
        const declined = said.match(DECLINED) ?? said.match(DEFERRED);
        if (declined)
          failures.push(
            `「${ask}」: declined or deferred "…${said.slice(Math.max(0, declined.index - 60), declined.index + 80)}…"`,
          );
        commonChecks(replies, failures);
        steps.push({ ask, ...traceOf(allEvents, replies) });
      }
      fs.writeFileSync(path.join(OUT, "ambiguous.txt"), `${notes.join("\n\n")}\n`);
      fs.writeFileSync(path.join(OUT, "ambiguous.events.json"), JSON.stringify(steps, null, 1));
    });

  if (wanted.has("cards"))
    await stage("cards", async (failures) => {
      const file = CASES && path.join(CASES, "cards.json");
      const jd = CASES && path.join(CASES, "t3.txt");
      if (!file || !fs.existsSync(file)) return failures.push("missing <cases>/cards.json");
      if (!EMAIL || !PASSWORD) return failures.push("cards needs RAKAZO_EMAIL and RAKAZO_PASSWORD");
      const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
      const code = await run("cards", "card-e2e.mjs", [
        "--out",
        path.join(OUT, "cards"),
        "--jd-file",
        jd,
        "--send-group",
        fixture.sendGroup,
        "--send-role-mark",
        fixture.sendRoleMark,
        "--booking-group",
        fixture.bookingGroup,
      ]);
      if (code !== 0) failures.push("card clicks did not pass; see cards/summary.md");
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
      fs.writeFileSync(path.join(OUT, "t5-replies.txt"), `${replies.map(botText).join("\n")}\n`);
      const card = cards(replies).find((block) => block.approvalEffectId);
      if (!card) failures.push("no booking confirmation card");
      else if (!/confirm interview booking/i.test(card.text ?? ""))
        failures.push(`card text: "${card.text}"`);
      commonChecks(replies, failures);
    });

  if (wanted.has("expired"))
    await stage("expired", async (failures) => {
      // <cases>/expired.json ({"groupId"}) names a private test chat whose question card expired.
      // Answering it must start the work like any message: the card shows the answer, the answer
      // replies to the card, a reply follows, and the question is not asked again.
      const file = CASES && path.join(CASES, "expired.json");
      const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      const groupId = option("--expired-group") ?? saved.groupId;
      if (!groupId)
        return failures.push(
          "pass --expired-group, or <cases>/expired.json, for the expired card case",
        );
      const before = await messagesOf(groupId);
      // Approval, secret and connection cards are never answered here.
      const card = before.findLast((message) =>
        (message.blocks ?? []).some(
          (block) =>
            block.kind === "ask" &&
            block.status === "expired" &&
            !block.approvalEffectId &&
            block.input !== "secret" &&
            !block.connection &&
            !block.requestedSchema &&
            block.actions?.length,
        ),
      );
      if (!card) return failures.push("no expired question card with choices in the test chat");
      const ask = card.blocks.find((block) => block.kind === "ask" && block.status === "expired");
      const choice = ask.actions[0];
      const seen = new Set(before.map((message) => message.id));
      await rpc("threads/answer", {
        groupId,
        runId: card.runId,
        messageId: card.id,
        answer: choice.id,
      });
      const messages = await settled(groupId, { quietMs: 30_000, limitMs: 10 * 60_000 });
      const added = messages.filter((message) => !seen.has(message.id));
      const answered = messages
        .find((message) => message.id === card.id)
        ?.blocks?.find((block) => block.kind === "ask");
      if (answered?.status !== "answered" || answered.answer !== choice.id)
        failures.push(`card not shown answered (${answered?.status ?? "missing"})`);
      const sent = added.filter((message) => message.role === "user");
      if (sent.length !== 1 || botText(sent[0]) !== choice.label)
        failures.push(`answer not sent once as "${choice.label}" (${sent.length} messages)`);
      else if (sent[0].replyToMessageId !== card.id)
        failures.push("answer does not reply to the card");
      const replies = recruiterSees(added);
      if (!replies.some((message) => botText(message).trim()))
        failures.push("no reply after the answer");
      if (cards(added).some((block) => block.text === ask.text))
        failures.push(`asked again: "${ask.text.slice(0, 80)}"`);
      const notice = added.find((message) => message.role === "system" && !message.internal);
      if (notice) failures.push(`status line after the answer: "${botText(notice).slice(0, 80)}"`);
      commonChecks(added, failures);
    });

  passed = results.every((result) => result.pass);
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
} finally {
  await cleanUp();
}
process.exit(passed ? 0 : 1);
