#!/usr/bin/env node
// Real-user conversations on the test environment: the conversation half of the recruiting
// benchmark and part of the release gate. Scenarios live in real-user-scenarios.mjs. Each signs up a
// brand-new outside account (no internal domain, no assigned mailbox, starting credits), talks to
// Kruit the way recruiters actually wrote when things went wrong, and fails on what they saw:
// a reply that overrides what they just said, a dead end, a pointer to an internal address or an
// admin, a repeated message, the wrong language, a hard requirement that never reached the role.
// No case answers an approval card; open cards are denied and work is stopped at the end.
// Paid scenarios answer a role's first question, which starts the first-ten search, so they run
// only when this script itself is given --paid (the release thread's one paid run a day); the
// release gate never passes it here, even when its own paid cases run. The rest are free.
//
// Usage (the deployment owner's sign-in creates the throwaway accounts):
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/real-user.mjs [--only a,b] [--paid] [--samples 1] [--concurrency 8]
//       [--out <dir>] [--bench <dir>] [--sha <sha>] [--model <provider/id>] [--thinking <level>]
// To reproduce one failure before and after a fix, play just that scenario a few times:
//     node infra/acceptance/real-user.mjs --only jd-zh-must-have --samples 3 --out /tmp/repro
// RAKAZO_ONBOARDED_EMAIL/PASSWORD name a fixture account set up by hand (no credit limit, no
// mailbox) for the onboarded-account scenarios, and RAKAZO_MAILBOX_EMAIL/PASSWORD an outside account
// given a mailbox by the owner (assignSendingMailbox) for the mailbox scenarios; without them those
// are skipped. A mailbox is held by one account, so that account is reused, never made per run.
// Replies vary from run to run, so the nightly benchmark plays each free scenario --samples 3
// times; the release gate plays each once, and a failed one once more before it blocks. Rows go to <out>/results.jsonl and, with --bench, are
// appended to the shared benchmark folder for the scoreboard.
// Node 20+, no dependencies. Prints no credentials. Exit code 0 when every scenario passes, 1 on a
// product failure, 2 when only the test environment failed (server errors, refused sign-ins).

import fs from "node:fs";
import path from "node:path";
import {
  botText,
  conversationChecks,
  mostlyChinese,
  ROUND as RESULTS,
  requirementSaved,
} from "./real-user-checks.mjs";
import { SCENARIOS } from "./real-user-scenarios.mjs";
import {
  client,
  groupsOf,
  InfraError,
  PROFILE,
  roleChats,
  send,
  settle,
  stopAll,
  transcripts,
  waitForText,
} from "./real-user-session.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const { RAKAZO_EMAIL: OWNER_EMAIL, RAKAZO_PASSWORD: OWNER_PASSWORD } = process.env;
if (!BASE || !OWNER_EMAIL || !OWNER_PASSWORD)
  throw new Error("Set RAKAZO_URL, RAKAZO_EMAIL and RAKAZO_PASSWORD (the deployment owner)");
const OUT = option("--out", `real-user-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const log = (text) =>
  process.stdout.write(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s] ${text}\n`,
  );

async function play(scenario, owner, sample) {
  const failures = [];
  let startedAt = Date.now() - 5_000;
  const label = `${scenario.name}#${sample}`;
  const user = client();
  if (scenario.account) {
    // A hand-onboarded account cannot be made through the API, so a fixed one is reused.
    await user.auth(...FIXTURES[scenario.account]);
    // Close what earlier runs left open, let the replies land, and judge only what follows.
    await stopAll(user.rpc);
    await settle(user.rpc, { quietMs: 15_000, limitMs: 2 * 60_000 });
    startedAt = Date.now();
  } else {
    const email = `kruit-eval-${scenario.name}-${sample}-${Date.now()}@example.com`;
    const password = `Ev-${crypto.randomUUID()}`;
    await owner.rpc("deployment/createAccount", { email, name: "Eval Recruiter", password });
    await user.auth(email, password);
    // A model comparison runs the new account's agents on another model or effort.
    if (MODEL || THINKING)
      for (const bot of await user.rpc("bots/list"))
        await user.rpc("bots/update", {
          botId: bot.id,
          ...(MODEL ? { modelProvider: MODEL.provider, modelId: MODEL.id } : {}),
          ...(THINKING ? { thinkingLevel: THINKING } : {}),
        });
  }
  const kruit = (await groupsOf(user.rpc)).find((group) =>
    group.id.startsWith("recruiting-global-"),
  );
  if (!kruit) return ["the new account has no Kruit conversation"];
  let chats = [];
  let lastSent = Date.now();
  const shown = new Set();
  // Roles a reused fixture account already had are not this play's.
  const rolesBefore = new Set((await roleChats(user.rpc)).map((group) => group.id));
  try {
    for (const [index, turn] of scenario.turns.entries()) {
      const next = scenario.turns[index + 1];
      // A turn followed by a timed step (wait, stop) is sent without waiting for the reply.
      const settleAfter = !(next?.wait || next?.stop);
      if (turn.say || turn.sayRole) {
        const target = turn.say ? kruit : (await roleChats(user.rpc)).at(-1);
        if (!target) {
          failures.push("no role chat to write in");
          break;
        }
        log(
          `${label}: says "${(turn.say ?? turn.sayRole).slice(0, 40)}"${turn.file ? ` with ${turn.file.name}` : ""}`,
        );
        lastSent = Date.now();
        await send(user.rpc, target.id, turn.say ?? turn.sayRole, turn.file);
        if (settleAfter) await settle(user.rpc);
      } else if (turn.results) {
        // A round of people, after the recruiter's last message. Feedback rounds must bring new
        // people, not the ones already shown.
        log(`${label}: waits for a round of people`);
        const round = await waitForText(
          user.rpc,
          RESULTS,
          lastSent,
          turn.results.limitMs ?? 10 * 60_000,
        );
        if (!round) {
          failures.push("no round of people arrived after the recruiter's message");
          break;
        }
        const people = new Set((round.match(PROFILE) ?? []).map((link) => link.toLowerCase()));
        const again = [...people].filter((link) => shown.has(link));
        if (again.length) failures.push(`the next round shows people again: ${again.join(", ")}`);
        for (const link of people) shown.add(link);
        await settle(user.rpc, { quietMs: 20_000, limitMs: 3 * 60_000 });
      } else if (turn.wait) {
        await sleep(turn.wait);
      } else if (turn.stop) {
        log(`${label}: presses Stop`);
        for (const group of await groupsOf(user.rpc))
          await user.rpc("threads/stop", { groupId: group.id }).catch(() => {});
        await sleep(3_000);
      } else if (turn.answerCard) {
        const card = await settle(user.rpc, { untilCard: true, limitMs: 5 * 60_000 });
        if (!card) {
          failures.push("no question card to answer");
          break;
        }
        log(`${label}: types "${turn.answerCard}" into "${botText(card).slice(0, 50)}"`);
        lastSent = Date.now();
        await user.rpc("threads/answer", {
          groupId: card.groupId,
          runId: card.runId,
          messageId: card.id,
          answer: turn.answerCard,
        });
        // The reply to the answer is what is judged; a search it starts is stopped right after.
        await settle(user.rpc, { quietMs: 25_000, limitMs: 3 * 60_000 });
      }
    }
    const roles = (await roleChats(user.rpc)).filter((group) => !rolesBefore.has(group.id));
    if (scenario.noRole && roles.length)
      failures.push(`opened a role it was not asked for: ${roles.map((g) => g.name).join(", ")}`);
    if (scenario.role) {
      if (!roles.length) failures.push("no role was opened");
      else if (roles.some((group) => /^New role$|^新岗位$/i.test(group.name)))
        failures.push("the role kept its placeholder title");
      else if (scenario.roleTitle && !roles.some((group) => scenario.roleTitle.test(group.name)))
        failures.push(`the role is not named from the JD: ${roles.map((g) => g.name).join(", ")}`);
    }
    if (scenario.requirement) {
      const role = roles[0];
      if (!role) failures.push("no role was created");
      else {
        // Saves run in the background, so the role gets a minute to catch up. Judge what the role
        // now requires (its criteria at their priority, the brief and the search filters), not the
        // quotes it keeps of the original JD, which still say "会说中文更好，不强求" after the
        // recruiter makes it a must. A hard criterion on the same requirement replaces the
        // preferred one it supersedes.
        const statement = (criterion) => JSON.stringify(criterion?.expression ?? "");
        const mentions = new RegExp(scenario.requirement.source, "i");
        let missing = [];
        for (let attempt = 0; attempt < 7; attempt += 1) {
          if (attempt) await sleep(10_000);
          const workspace = await user.rpc("recruiting/getWorkspace", {
            threadId: role.threadId ?? role.id,
          });
          fs.writeFileSync(
            path.join(OUT, `${label}.role.json`),
            JSON.stringify(workspace, null, 1),
          );
          const revision = workspace?.revision ?? {};
          const lines = [
            ...(revision.criteria ?? []).map(
              (criterion) =>
                `${criterion.priority === "hard" ? "required" : "preferred"}: ${statement(criterion)}`,
            ),
            ...(revision.brief?.fields ?? []).map((field) => `${field.key}: ${field.value}`),
            ...(revision.brief?.searchFilters ?? []).map(
              (filter) =>
                `${filter.mode === "include" ? "required" : filter.mode}: ${filter.statement}`,
            ),
          ];
          const hard = lines.some((line) => line.startsWith("required: ") && mentions.test(line));
          const requirements = lines
            .filter((line) => !hard || line.startsWith("required: ") || !mentions.test(line))
            .join("\n");
          missing = requirementSaved(requirements, scenario.requirement);
          if (!missing.length) break;
        }
        failures.push(...missing);
      }
    }
    const first = scenario.turns.find((turn) => turn.say)?.say ?? "";
    chats = await transcripts(user.rpc, startedAt, mostlyChinese(first));
  } finally {
    await stopAll(user.rpc).catch((error) => log(`${label}: stop failed: ${error.message}`));
  }
  const lines = [];
  for (const { group, messages } of chats) {
    if (!messages.length) continue;
    lines.push(`## ${group.name}`);
    for (const message of messages)
      lines.push(
        `[${message.at}] ${message.role}${message.card ? " (card)" : ""}: ${message.text}`,
      );
    failures.push(
      ...conversationChecks(messages)
        // A contact lookup's deliverable is an address the recruiter never typed.
        .filter((failure) => !(scenario.foundEmail && failure.startsWith("shows an address")))
        .map((failure) => `${group.name}: ${failure}`),
    );
  }
  // The last reply in the chat the recruiter last wrote in.
  const latest = chats
    .map(({ messages }) => ({
      sent: messages.findLast((message) => message.role === "user")?.at ?? "",
      reply: messages.findLast((message) => message.role !== "user" && message.text.trim()),
    }))
    .sort((a, b) => Date.parse(b.sent || 0) - Date.parse(a.sent || 0))[0]?.reply;
  // Denied by stopAll above, so the benchmark itself never sends.
  if (scenario.sendCard && !chats.some(({ messages }) => messages.some((m) => m.sendCard)))
    failures.push("no send card: the email could not be sent");
  if (scenario.last && !scenario.last.test(latest?.text ?? ""))
    failures.push(`last reply misses ${scenario.last}: "${(latest?.text ?? "").slice(0, 120)}"`);
  const wrong = scenario.lastNot && (latest?.text ?? "").match(scenario.lastNot);
  if (wrong) failures.push(`last reply says "${wrong[0]}"`);
  fs.writeFileSync(path.join(OUT, `${label}.chat.txt`), `${lines.join("\n\n")}\n`);
  return failures;
}

const env = process.env;
const FIXTURES = Object.fromEntries(
  [
    ["onboarded", env.RAKAZO_ONBOARDED_EMAIL, env.RAKAZO_ONBOARDED_PASSWORD],
    ["mailbox", env.RAKAZO_MAILBOX_EMAIL, env.RAKAZO_MAILBOX_PASSWORD],
  ].flatMap(([name, email, password]) => (email && password ? [[name, [email, password]]] : [])),
);
const only = option("--only")?.split(",");
const wanted = SCENARIOS.filter(
  (scenario) =>
    (!only || only.includes(scenario.name)) &&
    (!scenario.paid || args.includes("--paid")) &&
    (!scenario.account || FIXTURES[scenario.account]),
);
for (const name of ["onboarded", "mailbox"])
  if (!FIXTURES[name]) log(`No ${name} fixture account set: skipping its scenarios`);
const SAMPLES = Number(option("--samples", "1"));
// --model provider/id and --thinking level compare models on the same scenarios; the deployment's
// own key must serve that provider.
const [, modelProvider, modelId] = option("--model")?.match(/^([^/]+)\/(.+)$/) ?? [];
const MODEL = modelProvider ? { provider: modelProvider, id: modelId } : null;
if (option("--model") && !MODEL) throw new Error("--model takes provider/id");
const THINKING = option("--thinking");
const CONCURRENCY = Number(option("--concurrency", "8"));
const plays = wanted.flatMap((scenario) =>
  Array.from({ length: scenario.paid || scenario.account ? 1 : SAMPLES }, (_, index) => ({
    scenario,
    sample: index + 1,
  })),
);
const owner = client();
await owner.auth(OWNER_EMAIL, OWNER_PASSWORD);
// The revision the test environment serves, for the scoreboard.
const SHA =
  option("--sha") ??
  process.env.RAKAZO_EXPECT_SHA ??
  (await fetch(`${BASE}/ready`)
    .then((response) => response.headers.get("x-rakazo-revision"))
    .catch(() => null)) ??
  "unknown";
const rows = [];
// A fixture account is one person with one Kruit conversation: its scenarios take turns, or
// their messages land in the same chat and each is scored on the other's replies.
const accountTurns = new Map();
const onAccount = (scenario, run) => {
  if (!scenario.account) return run();
  const turn = (accountTurns.get(scenario.account) ?? Promise.resolve()).then(run);
  accountTurns.set(
    scenario.account,
    turn.catch(() => undefined),
  );
  return turn;
};
let nextPlay = 0;
async function worker(plays) {
  while (nextPlay < plays.length) {
    const { scenario, sample, retry } = plays[nextPlay++];
    const at = Date.now();
    let failures;
    try {
      failures = await onAccount(scenario, () => play(scenario, owner, sample));
    } catch (error) {
      failures = [
        error instanceof InfraError
          ? `infrastructure: ${error.message}`
          : `error: ${error.message}`,
      ];
    }
    const infra = failures.some((failure) => failure.startsWith("infrastructure:"));
    const row = {
      suite: "conversation",
      scenario: scenario.name,
      area: scenario.area,
      source: scenario.source,
      sample,
      pass: failures.length === 0,
      score: failures.length === 0 ? 1 : 0,
      failures,
      sha: SHA,
      at: new Date(at).toISOString(),
      seconds: Math.round((Date.now() - at) / 1000),
      paid: Boolean(scenario.paid),
      ...(MODEL || THINKING
        ? {
            model: MODEL ? `${MODEL.provider}/${MODEL.id}` : "default",
            thinking: THINKING ?? "default",
          }
        : {}),
      ...(scenario.known ? { known: scenario.known } : {}),
      ...(retry ? { retry: true } : {}),
      ...(infra ? { infra: true } : {}),
    };
    rows.push(row);
    log(
      `${scenario.name}#${sample}: ${row.pass ? "PASS" : `FAIL\n  - ${failures.join("\n  - ")}`}`,
    );
  }
}
const pool = async (list) => {
  nextPlay = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, () => worker(list)));
};
await pool(plays);
// One sample can fail on a reply that varies from run to run. A failed free sample is played once
// more on a fresh account; it blocks the release only when the second play fails too. Both rows
// stay on the scoreboard. Paid scenarios are never played twice.
const retries = rows
  .filter((row) => !row.pass && !row.known && !row.paid)
  .map((row) => ({
    scenario: wanted.find((scenario) => scenario.name === row.scenario),
    sample: `${row.sample}-again`,
    retry: true,
  }));
if (retries.length) {
  log(`playing ${retries.length} failed free sample(s) once more`);
  await pool(retries);
}
fs.writeFileSync(
  path.join(OUT, "results.jsonl"),
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
// The shared benchmark folder, when given, gets the same rows for the scoreboard.
const BENCH = option("--bench");
if (BENCH) {
  fs.mkdirSync(BENCH, { recursive: true });
  const file = path.join(
    BENCH,
    `${new Date().toISOString().slice(0, 10)}-${SHA.slice(0, 8)}-conversation.jsonl`,
  );
  fs.appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
const failed = rows.filter((row) => !row.pass);
const againOf = (row) =>
  rows.find(
    (item) => item.retry && item.scenario === row.scenario && item.sample === `${row.sample}-again`,
  );
// A sample the environment broke on both plays says nothing about the product: it is reported
// as an infrastructure failure (exit code 2), not a product one.
const blocking = failed.filter(
  (row) =>
    !row.known &&
    !row.retry &&
    (row.paid || !againOf(row) || !againOf(row).pass) &&
    !(row.infra && (!againOf(row) || againOf(row).infra)),
);
const broken = failed.filter(
  (row) => !row.retry && row.infra && (!againOf(row) || againOf(row).infra),
);
for (const row of broken)
  log(
    `infrastructure failure, not a product result: ${row.scenario}#${row.sample} (${row.failures[0]})`,
  );
for (const row of failed.filter((item) => !item.known && !item.retry && againOf(item)?.pass))
  log(`failed once, passed when played again, not blocking: ${row.scenario}#${row.sample}`);
log(`${rows.length - failed.length}/${rows.length} conversations pass`);
for (const row of failed.filter((item) => item.known))
  log(`known failure, not blocking: ${row.scenario}#${row.sample} (${row.known})`);
// A known failure that passes every sample is ready to lose its mark.
for (const name of new Set(rows.filter((row) => row.known && row.pass).map((row) => row.scenario)))
  if (!failed.some((row) => row.scenario === name))
    log(`known failure now passes: ${name}; remove its known mark`);
process.exit(blocking.length ? 1 : broken.length ? 2 : 0);
