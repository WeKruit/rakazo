#!/usr/bin/env node
// A simulated customer: a language model plays a recruiter from a persona and talks to Kruit on
// the test environment through a whole journey, choosing each next message from what Kruit
// actually said. A second model then judges the experience turn by turn, checking every claim
// Kruit made about sends against the role's campaign records, and writes a short report. The
// scripted conversations in real-user.mjs ask one thing each; this follows state that builds over
// a journey and a recruiter who pushes back. Journeys live in simulated-journeys.mjs.
//
// Usage (the deployment owner's sign-in creates the throwaway accounts):
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/simulated-customer.mjs --journey send-at-night [--out <dir>]
//       [--bench <dir>] [--model sonnet] [--judge-model sonnet]
// RAKAZO_SIM_RECIPIENTS lists the internal test inboxes a journey may email (comma separated). A
// send card is approved only when every address on it is in that list; any other card is denied,
// so the simulation never emails a real person. Journeys that send need it and an account with a
// sending mailbox: RAKAZO_MAILBOX_EMAIL/PASSWORD, as in real-user.mjs.
// The two models are called through RAKAZO_SIM_MODEL_COMMAND, a command that reads a prompt on
// stdin and prints the reply; by default the Claude Code CLI (`claude -p`).
// Exit code 0 when the journey passes, 1 when the product failed it, 2 when the environment did.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { botText, conversationChecks } from "./real-user-checks.mjs";
import {
  client,
  groupsOf,
  InfraError,
  messagesOf,
  openCards,
  roleChats,
  send,
  settle,
  sleep,
  stopAll,
  transcripts,
} from "./real-user-session.mjs";
import { JOURNEYS } from "./simulated-journeys.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const { RAKAZO_EMAIL: OWNER_EMAIL, RAKAZO_PASSWORD: OWNER_PASSWORD } = process.env;
if (!BASE || !OWNER_EMAIL || !OWNER_PASSWORD)
  throw new Error("Set RAKAZO_URL, RAKAZO_EMAIL and RAKAZO_PASSWORD (the deployment owner)");
const journey = JOURNEYS.find((item) => item.name === option("--journey"));
if (!journey) throw new Error(`--journey is one of: ${JOURNEYS.map((j) => j.name).join(", ")}`);
const RECIPIENTS = (process.env.RAKAZO_SIM_RECIPIENTS ?? "")
  .split(",")
  .map((address) => address.trim().toLowerCase())
  .filter(Boolean);
if (journey.sends && !RECIPIENTS.length)
  throw new Error(
    `${journey.name} sends email: set RAKAZO_SIM_RECIPIENTS to internal test inboxes`,
  );
const MAILBOX = [process.env.RAKAZO_MAILBOX_EMAIL, process.env.RAKAZO_MAILBOX_PASSWORD];
if (journey.account === "mailbox" && !MAILBOX.every(Boolean))
  throw new Error(
    `${journey.name} needs RAKAZO_MAILBOX_EMAIL/PASSWORD (an account with a mailbox)`,
  );
const OUT = option(
  "--out",
  `simulated-${journey.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const log = (text) =>
  process.stdout.write(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s] ${text}\n`,
  );

// --- The two models ---------------------------------------------------------------------------
const usage = { calls: 0, usd: 0 };
function model(system, prompt, name) {
  const custom = process.env.RAKAZO_SIM_MODEL_COMMAND;
  const [command, commandArgs] = custom
    ? ["sh", ["-c", custom]]
    : [
        "claude",
        [
          "-p",
          "--model",
          name,
          "--system-prompt",
          system,
          "--tools",
          "",
          "--setting-sources",
          "",
          "--output-format",
          "json",
        ],
      ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: OUT });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.stdin.end(custom ? `${system}\n\n${prompt}` : prompt);
    child.on("close", (code) => {
      usage.calls += 1;
      if (custom) return code === 0 ? resolve(out) : reject(new Error(err.slice(0, 300)));
      try {
        const result = JSON.parse(out);
        usage.usd += result.total_cost_usd ?? 0;
        resolve(result.result ?? "");
      } catch {
        reject(new Error(`model: ${(out || err).slice(0, 300)}`));
      }
    });
  });
}
/** The first JSON object in a model's reply. */
function parse(text) {
  const start = text.indexOf("{");
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw new Error(`no JSON in the model's reply: ${text.slice(0, 200)}`);
}
const SIMULATOR = option("--model", "sonnet");
const JUDGE = option("--judge-model", "sonnet");

// --- What the recruiter sees and what is true ---------------------------------------------------
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
async function cardsOpen(rpc) {
  const open = [];
  for (const group of await groupsOf(rpc))
    for (const message of await messagesOf(rpc, group.id))
      for (const block of openCards(message)) {
        if (!message.runId || block.input === "secret") continue;
        const text = [block.text, block.detail].filter(Boolean).join("\n");
        open.push({
          chat: group.name,
          groupId: group.id,
          runId: message.runId,
          messageId: message.id,
          send: Boolean(block.approvalEffectId),
          connect: Boolean(block.connection),
          text,
          options: (block.actions ?? []).map((action) => action.label),
          recipients: [...new Set((text.match(ADDRESS) ?? []).map((a) => a.toLowerCase()))],
        });
      }
  return open;
}
// The role's send records: what Kruit's claims about sending are checked against.
async function records(rpc) {
  const roles = [];
  for (const role of await roleChats(rpc)) {
    const campaign = await rpc("recruiting/roleCampaign", { groupId: role.id }).catch((error) => ({
      error: error.message,
    }));
    roles.push({
      role: role.name,
      status: campaign.status ?? campaign.error,
      campaign: campaign.campaign
        ? {
            name: campaign.campaign.name,
            status: campaign.campaign.status,
            mailbox: campaign.campaign.eaccount,
          }
        : null,
      sent: campaign.stats?.sent ?? null,
      queuedFirstEmail: campaign.queuedFirstEmail ?? null,
      people: (campaign.leads ?? []).map((lead) => ({
        email: lead.email,
        status: lead.status,
        contactedAt: lead.contactedAt ?? null,
      })),
    });
  }
  return roles;
}
const CAMPAIGN_CODES =
  "campaign status: 0 draft, 1 active (sending), 2 paused, 3 completed; person status: 1 active, 2 paused, 3 completed, -1 bounced, -2 unsubscribed; contactedAt null = not emailed yet";

function render(chats) {
  return chats
    .filter(({ messages }) => messages.length)
    .map(
      ({ group, messages }) =>
        `## ${group.name}\n${messages
          .map(
            (m) =>
              `[${m.at.slice(11, 19)}] ${m.role === "user" ? "Recruiter" : "Kruit"}${m.card ? " (card)" : ""}: ${m.text}`,
          )
          .join("\n")}`,
    )
    .join("\n\n");
}

// --- One journey --------------------------------------------------------------------------------
async function newestBotMessageAfter(rpc, since) {
  let newest = null;
  for (const group of await groupsOf(rpc))
    for (const message of await messagesOf(rpc, group.id))
      if (
        message.role !== "user" &&
        botText(message).trim() &&
        Date.parse(message.createdAt) > since
      )
        if (!newest || Date.parse(message.createdAt) < Date.parse(newest.createdAt))
          newest = message;
  return newest;
}
/** Seconds until Kruit's first visible reply, then waits until the account is quiet. */
async function replyAfter(rpc, since) {
  let first = null;
  for (const until = Date.now() + 3 * 60_000; !first && Date.now() < until; await sleep(2_000))
    first = await newestBotMessageAfter(rpc, since);
  await settle(rpc, { quietMs: 25_000, limitMs: journey.waitMs ?? 6 * 60_000 });
  return first ? Math.round((Date.parse(first.createdAt) - since) / 1000) : null;
}

const SIMULATOR_RULES = `You play a recruiter using a recruiting assistant called Kruit, to test it the way a real customer would. Stay in character: write the way this person writes (language, length, tone). Decide your next move from what Kruit actually said and showed, not from what it should have said. If Kruit did not answer what you asked, did not do what you asked, or said something you doubt, push back the way this person would. Never explain that you are testing. Answer with one JSON object and nothing else:
{"action": "say" | "answer_card" | "approve_send" | "deny_send" | "done", "card": <index of the card for answer_card/approve_send/deny_send>, "text": "<your message, or your typed answer for answer_card>", "goal": "<which goal this move serves>", "feeling": "<one line: how this person feels about Kruit's last reply>"}
Use "done" when every goal is met, or when you have pushed back twice on the same goal and got nowhere (say which goal in "goal").`;

async function simulate(turns, view, cards) {
  const prompt = `Who you are:\n${journey.persona}\n\nWhat you want, in order:\n${journey.goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n")}\n\n${journey.facts ? `What you know:\n${journey.facts(RECIPIENTS)}\n\n` : ""}The conversation so far (times are UTC):\n${view || "(nothing yet: you open the conversation)"}\n\nOpen cards you can act on:\n${
    cards.length
      ? cards
          .map(
            (card, i) =>
              `[${i}] in "${card.chat}"${card.send ? " SEND CONFIRMATION" : ""}: ${card.text}${card.options.length ? `\n    options: ${card.options.join(" | ")}` : ""}`,
          )
          .join("\n")
      : "(none)"
  }\n\nYour moves so far: ${turns.length}. Your next move:`;
  return parse(await model(SIMULATOR_RULES, prompt, SIMULATOR));
}

async function play() {
  const owner = client();
  const user = client();
  if (journey.account === "mailbox") {
    await user.auth(...MAILBOX);
    await stopAll(user.rpc);
    await settle(user.rpc, { quietMs: 15_000, limitMs: 2 * 60_000 });
  } else {
    await owner.auth(OWNER_EMAIL, OWNER_PASSWORD);
    const email = `kruit-sim-${journey.name}-${Date.now()}@example.com`;
    const password = `Sim-${crypto.randomUUID()}`;
    await owner.rpc("deployment/createAccount", { email, name: "Simulated Recruiter", password });
    await user.auth(email, password);
  }
  const { rpc } = user;
  const startedAt = Date.now();
  const kruit = (await groupsOf(rpc)).find((group) => group.id.startsWith("recruiting-global-"));
  if (!kruit) throw new Error("the account has no Kruit conversation");
  const turns = [];
  try {
    for (let index = 0; index < journey.maxTurns; index += 1) {
      const chats = await transcripts(rpc, startedAt, journey.chinese);
      const cards = await cardsOpen(rpc);
      const move = await simulate(turns, render(chats), cards);
      const at = Date.now();
      const turn = { turn: index + 1, at: new Date(at).toISOString(), move };
      if (move.action === "done") {
        log(`recruiter is done: ${move.goal ?? ""}`);
        turns.push(turn);
        break;
      }
      const card = cards[move.card];
      if (move.action === "say") {
        const chat = (await groupsOf(rpc)).find((group) => group.name === move.chat) ?? kruit;
        log(`recruiter: ${move.text}`);
        await send(rpc, chat.id, move.text);
      } else if (card && ["answer_card", "approve_send", "deny_send"].includes(move.action)) {
        let answer =
          move.action === "deny_send"
            ? "deny"
            : move.action === "approve_send"
              ? "allow"
              : move.text;
        // The harness, not the model, decides what may be emailed: only the internal test inboxes.
        if (card.send && answer === "allow") {
          const outside = card.recipients.filter((address) => !RECIPIENTS.includes(address));
          if (!card.recipients.length || outside.length) {
            answer = "deny";
            turn.guard = `denied: the card names ${outside.join(", ") || "no address"}`;
          }
        }
        if (card.send && !["allow", "deny"].includes(answer)) answer = "deny";
        log(
          `recruiter ${answer === "allow" ? "approves" : answer === "deny" ? "denies" : `answers "${answer}" on`} "${card.text.slice(0, 60)}"${turn.guard ? ` (${turn.guard})` : ""}`,
        );
        await rpc("threads/answer", {
          groupId: card.groupId,
          runId: card.runId,
          messageId: card.messageId,
          answer,
        });
      } else {
        turn.invalid = `no card ${move.card} to ${move.action}`;
        turns.push(turn);
        continue;
      }
      turn.firstReplySeconds = await replyAfter(rpc, at);
      turn.records = await records(rpc);
      turns.push(turn);
      log(`  Kruit's first reply after ${turn.firstReplySeconds ?? "no reply"} s`);
    }
    return {
      turns,
      chats: await transcripts(rpc, startedAt, journey.chinese),
      records: await records(rpc),
    };
  } finally {
    await stopAll(rpc).catch((error) => log(`stop failed: ${error.message}`));
  }
}

// --- The judge ----------------------------------------------------------------------------------
const JUDGE_RULES = `You judge a recruiting assistant called Kruit from the customer's side. You get one simulated customer's whole conversation, the moves the customer made, how long Kruit took to reply, and the role's real send records after each move. Be strict and concrete; quote Kruit. For every customer move decide:
- answered: did Kruit's reply directly answer or do what the customer asked (not a deferral, not a different question)?
- truthful: "yes", "no" or "unknown" — does every claim Kruit made about state (sent, queued, scheduled, paused, how many) match the records? A count or status that contradicts the records is "no".
- issues: short labels for what went wrong, from: dead end, refused, lecture, repeat, wrong language, false claim, internal jargon, slow (first reply over 10 s), did not act, asked again, other.
Then judge the whole journey: which of the customer's goals were met, a score from 0 to 10 for how a real recruiter would rate the experience, a one-sentence verdict, and the top problems. Write the verdict and problems in Chinese, in short plain sentences. Answer with one JSON object and nothing else:
{"turns": [{"turn": n, "answered": true|false, "truthful": "yes"|"no"|"unknown", "issues": ["..."], "note": "<one line>"}], "goals": [{"goal": "...", "met": true|false, "why": "..."}], "score": 0-10, "verdict": "...", "problems": ["..."]}`;

async function judge(result) {
  const moves = result.turns
    .map(
      (turn) =>
        `Move ${turn.turn} at ${turn.at.slice(11, 19)}: ${turn.move.action}${turn.move.text ? ` "${turn.move.text}"` : ""}${turn.guard ? ` (${turn.guard})` : ""}${turn.invalid ? ` (not done: ${turn.invalid})` : ""}\n  first reply after: ${turn.firstReplySeconds ?? "none"} s\n  records after: ${JSON.stringify(turn.records ?? [])}`,
    )
    .join("\n");
  const prompt = `Customer persona:\n${journey.persona}\n\nGoals:\n${journey.goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n")}\n\nRecord codes: ${CAMPAIGN_CODES}\n\nConversation (UTC):\n${render(result.chats)}\n\nCustomer moves:\n${moves}`;
  return parse(await model(JUDGE_RULES, prompt, JUDGE));
}

// --- Run, judge, report -------------------------------------------------------------------------
const SHA =
  option("--sha") ??
  (await fetch(`${BASE}/ready`)
    .then((response) => response.headers.get("x-rakazo-revision"))
    .catch(() => null)) ??
  "unknown";
let result;
let verdict;
let error;
try {
  result = await play();
  verdict = await judge(result);
} catch (caught) {
  error = caught;
}
// Rule checks the scripted conversations use apply here too.
const checks = (result?.chats ?? []).flatMap(({ group, messages }) =>
  conversationChecks(messages).map((failure) => `${group.name}: ${failure}`),
);
const falseClaims = (verdict?.turns ?? []).filter((turn) => turn.truthful === "no").length;
const missed = (verdict?.goals ?? []).filter((goal) => !goal.met);
const pass =
  Boolean(verdict) && verdict.score >= 7 && !falseClaims && !missed.length && !checks.length;
const row = {
  suite: "simulated",
  scenario: journey.name,
  area: journey.area,
  source: journey.source,
  sample: 1,
  pass,
  score: verdict ? verdict.score / 10 : 0,
  failures: error
    ? [`${error instanceof InfraError ? "infrastructure" : "error"}: ${error.message}`]
    : [
        ...(verdict.score < 7 ? [`score ${verdict.score}/10: ${verdict.verdict}`] : []),
        ...(falseClaims ? [`${falseClaims} reply(ies) contradict the send records`] : []),
        ...missed.map((goal) => `goal not met: ${goal.goal}`),
        ...checks,
      ],
  sha: SHA,
  at: new Date(started).toISOString(),
  seconds: Math.round((Date.now() - started) / 1000),
  modelUsd: Math.round(usage.usd * 100) / 100,
  ...(error instanceof InfraError ? { infra: true } : {}),
};
fs.writeFileSync(path.join(OUT, "results.jsonl"), `${JSON.stringify(row)}\n`);
fs.writeFileSync(
  path.join(OUT, "journey.json"),
  JSON.stringify({ journey: journey.name, result, verdict, checks }, null, 1),
);
const report = [
  `# ${journey.title} — ${verdict ? `${verdict.score}/10` : "not judged"} ${pass ? "PASS" : "FAIL"}`,
  "",
  verdict?.verdict ?? `出错: ${error?.message}`,
  "",
  ...(verdict?.problems?.length ? ["## 问题", ...verdict.problems.map((p) => `- ${p}`), ""] : []),
  ...(verdict?.goals?.length
    ? ["## 目标", ...verdict.goals.map((g) => `- ${g.met ? "✓" : "✗"} ${g.goal}：${g.why}`), ""]
    : []),
  ...(checks.length ? ["## 规则检查", ...checks.map((c) => `- ${c}`), ""] : []),
  "## 每一步",
  "| # | 客户 | 首次回复 | 回答了 | 属实 | 问题 |",
  "|---|---|---|---|---|---|",
  ...(result?.turns ?? []).map((turn) => {
    const judged = verdict?.turns?.find((item) => item.turn === turn.turn) ?? {};
    const said = turn.move.text ?? turn.move.action;
    return `| ${turn.turn} | ${said.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 60)}${turn.guard ? " (拦截)" : ""} | ${turn.firstReplySeconds ?? "-"} s | ${judged.answered === undefined ? "-" : judged.answered ? "是" : "否"} | ${judged.truthful ?? "-"} | ${(judged.issues ?? []).join(", ")} |`;
  }),
  "",
  "## 对话",
  render(result?.chats ?? []),
  "",
  `Staging ${SHA.slice(0, 8)} · ${row.seconds} s · model cost $${row.modelUsd}`,
].join("\n");
fs.writeFileSync(path.join(OUT, "report.md"), `${report}\n`);
const BENCH = option("--bench");
if (BENCH) {
  fs.mkdirSync(BENCH, { recursive: true });
  fs.appendFileSync(
    path.join(BENCH, `${new Date().toISOString().slice(0, 10)}-${SHA.slice(0, 8)}-simulated.jsonl`),
    `${JSON.stringify(row)}\n`,
  );
}
log(
  `${journey.name}: ${verdict ? `${verdict.score}/10` : "not judged"} ${pass ? "PASS" : "FAIL"}; report ${path.join(OUT, "report.md")}`,
);
process.exit(pass ? 0 : error instanceof InfraError ? 2 : 1);
