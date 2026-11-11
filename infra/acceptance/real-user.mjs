#!/usr/bin/env node
// Real-user conversations on the test environment, for the release gate. Each scenario signs up a
// brand-new outside account (no internal domain, no assigned mailbox, starting credits), talks to
// Kruit the way recruiters actually wrote when things went wrong, and fails on what they saw:
// a reply that overrides what they just said, a dead end, a pointer to an internal address or an
// admin, a repeated message, the wrong language, a hard requirement that never reached the role.
// No case answers an approval card; open cards are denied and work is stopped at the end.
// must-have-on-card answers the role's first question, which starts the paid first-ten search, so
// it runs only with --paid (the release thread's one paid run a day); the rest are free.
//
// Usage (the deployment owner's sign-in creates the throwaway accounts):
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/real-user.mjs [--only a,b] [--paid] [--out <dir>]
// Node 20+, no dependencies. Prints no credentials. Exit code 0 only when every scenario passes.

import fs from "node:fs";
import path from "node:path";
import { conversationChecks, requirementSaved } from "./real-user-checks.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const { RAKAZO_EMAIL: OWNER_EMAIL, RAKAZO_PASSWORD: OWNER_PASSWORD } = process.env;
if (!BASE || !OWNER_EMAIL || !OWNER_PASSWORD)
  throw new Error("Set RAKAZO_URL, RAKAZO_EMAIL and RAKAZO_PASSWORD (the deployment owner)");
const OUT = option("--out", `real-user-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (text) =>
  process.stdout.write(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s] ${text}\n`,
  );

// Wording from real recruiter conversations; the JD is invented.
const JD_OPTIONAL_CHINESE =
  "帮我开个新岗位：高级技术产品经理，湾区（Sunnyvale），半导体或芯片背景，5年以上产品经验，和晶圆厂、封测厂合作过。会说中文更好，不强求。";
const SCENARIOS = [
  {
    // A self-signup account asks to email someone: it has no product mailbox.
    name: "email-no-mailbox-zh",
    turns: [
      { say: "帮我给 alex.chen.test@example.com 发封邮件，问他下周有没有空聊一个后端岗位" },
      { say: "其他几位可以根据实际情况发送邮件吗" },
      { say: "那你就直接发啊" },
    ],
  },
  { name: "email-no-mailbox-en", turns: [{ say: "Can you just email the candidates for me?" }] },
  { name: "angry-zh", turns: [{ say: "你能听懂我说话吗？" }] },
  { name: "vague-en", turns: [{ say: "need people. fast" }] },
  {
    // The JD says optional; the recruiter then types a must-have into the card, annoyed.
    name: "must-have-on-card",
    paid: true,
    turns: [{ say: JD_OPTIONAL_CHINESE }, { answerCard: "你能听的懂话吗？中文是必须！" }],
    requirement: /中文|普通话|汉语|mandarin|chinese/,
  },
];

function client() {
  let cookie = "";
  const auth = async (email, password) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      });
      if (response.status === 429) {
        await sleep(60_000);
        continue;
      }
      if (!response.ok) throw new Error(`sign-in ${response.status}`);
      cookie = (response.headers.getSetCookie?.() ?? [])
        .map((line) => line.split(";")[0])
        .join("; ");
      return;
    }
    throw new Error("sign-in rate limited");
  };
  const rpc = async (route, json) => {
    const read = /\/(get|messages|list|page|roleSetup|backgroundTasks)$/.test(route);
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(`${BASE}/rpc/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ json }),
      });
      if (!read || attempt >= 5 || ![500, 502, 503, 504].includes(response.status)) break;
      await sleep(8_000);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${route} ${response.status}`);
    return body.json;
  };
  return { auth, rpc };
}

const botText = (message) =>
  (message.blocks ?? [])
    .filter((block) => block.kind !== "handoff")
    .map((block) => block.text ?? block.question ?? "")
    .filter(Boolean)
    .join("\n");
const openCards = (message) =>
  (message.blocks ?? []).filter(
    (block) => block.kind === "ask" && (!block.status || block.status === "pending"),
  );

async function groupsOf(rpc) {
  const groups = [];
  for (let offset = 0; offset !== null && offset !== undefined; ) {
    const page = await rpc("groups/page", { offset, archived: false });
    groups.push(...page.items);
    offset = page.nextOffset;
  }
  return groups;
}
const messagesOf = async (rpc, groupId) =>
  (await rpc("threads/messages", { groupId, includePeerRuns: true })).messages ?? [];
const working = async (rpc, groupId) =>
  ((await rpc("threads/get", { groupId })).activeRuns ?? []).some(
    (run) => run.status !== "waiting_input",
  );

/** Every chat of the account, until all are idle and quiet, or a card is open when wanted. */
async function settle(rpc, { quietMs = 30_000, limitMs = 6 * 60_000, untilCard = false } = {}) {
  const startedAt = Date.now();
  let seen = -1;
  let changed = Date.now();
  while (Date.now() - startedAt < limitMs) {
    await sleep(4_000);
    const groups = await groupsOf(rpc);
    const all = (
      await Promise.all(
        groups.map(async (group) =>
          (await messagesOf(rpc, group.id)).map((message) => ({ ...message, groupId: group.id })),
        ),
      )
    ).flat();
    if (untilCard) {
      const card = all.findLast(
        (message) =>
          message.role !== "user" &&
          message.runId &&
          openCards(message).some((block) => !block.approvalEffectId && !block.requestedSchema),
      );
      if (card) return card;
      continue;
    }
    if (all.length !== seen) {
      seen = all.length;
      changed = Date.now();
    }
    if (Date.now() - changed < quietMs) continue;
    const busy = await Promise.all(groups.map((group) => working(rpc, group.id)));
    if (!busy.some(Boolean)) return null;
  }
  return null;
}

/** What the recruiter saw in each chat, oldest first; the server records typed card answers. */
async function transcripts(rpc) {
  const chats = [];
  for (const group of await groupsOf(rpc)) {
    const messages = (await messagesOf(rpc, group.id))
      .filter((message) => !message.internal && !(message.role === "user" && message.botId))
      .map((message) => ({
        // A user-role row written by an agent is a handoff, not the recruiter.
        role: message.role === "user" && !message.botId ? "user" : "bot",
        text: botText(message),
        card: (message.blocks ?? []).some((block) => block.kind === "ask"),
        at: message.createdAt,
      }));
    chats.push({ group, messages });
  }
  return chats;
}

async function stopAll(rpc) {
  for (const group of await groupsOf(rpc)) {
    for (const message of await messagesOf(rpc, group.id))
      for (const block of openCards(message)) {
        if (!message.runId || block.input === "secret" || block.connection) continue;
        const answer = block.approvalEffectId
          ? "deny"
          : block.requestedSchema
            ? { action: "decline" }
            : "测试结束，不用继续。";
        await rpc("threads/answer", {
          groupId: group.id,
          runId: message.runId,
          messageId: message.id,
          answer,
        }).catch(() => {});
      }
    await rpc("threads/stop", { groupId: group.id, scope: "all" }).catch(() => {});
  }
}

async function play(scenario, owner) {
  const failures = [];
  const email = `kruit-eval-${scenario.name}-${Date.now()}@example.com`;
  const password = `Ev-${crypto.randomUUID()}`;
  await owner.rpc("deployment/createAccount", { email, name: "Eval Recruiter", password });
  const user = client();
  await user.auth(email, password);
  const kruit = (await groupsOf(user.rpc)).find((group) =>
    group.id.startsWith("recruiting-global-"),
  );
  if (!kruit) return ["the new account has no Kruit conversation"];
  let chats = [];
  try {
    for (const turn of scenario.turns) {
      if (turn.say) {
        log(`${scenario.name}: says "${turn.say.slice(0, 40)}"`);
        const busy = await working(user.rpc, kruit.id);
        await user.rpc("threads/send", {
          groupId: kruit.id,
          addressing: "coordinator",
          text: turn.say,
          ...(busy ? { interrupt: true } : {}),
        });
        await settle(user.rpc);
      } else if (turn.answerCard) {
        const card = await settle(user.rpc, { untilCard: true, limitMs: 5 * 60_000 });
        if (!card) {
          failures.push("no question card to answer");
          break;
        }
        log(`${scenario.name}: types "${turn.answerCard}" into "${botText(card).slice(0, 50)}"`);
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
    if (scenario.requirement) {
      const role = (await groupsOf(user.rpc)).find(
        (group) => !group.id.startsWith("recruiting-global-"),
      );
      if (!role) failures.push("no role was created");
      else {
        const setup = await user.rpc("recruiting/roleSetup", { groupId: role.id });
        fs.writeFileSync(
          path.join(OUT, `${scenario.name}.role.json`),
          JSON.stringify(setup, null, 1),
        );
        failures.push(...requirementSaved(JSON.stringify(setup), scenario.requirement));
      }
    }
    chats = await transcripts(user.rpc);
  } finally {
    await stopAll(user.rpc).catch((error) =>
      log(`${scenario.name}: stop failed: ${error.message}`),
    );
  }
  const lines = [];
  for (const { group, messages } of chats) {
    if (!messages.length) continue;
    lines.push(`## ${group.name}`);
    for (const message of messages)
      lines.push(
        `[${message.at}] ${message.role}${message.card ? " (card)" : ""}: ${message.text}`,
      );
    failures.push(...conversationChecks(messages).map((failure) => `${group.name}: ${failure}`));
  }
  fs.writeFileSync(path.join(OUT, `${scenario.name}.chat.txt`), `${lines.join("\n\n")}\n`);
  return failures;
}

const only = option("--only")?.split(",");
const wanted = SCENARIOS.filter(
  (scenario) =>
    (!only || only.includes(scenario.name)) && (!scenario.paid || args.includes("--paid")),
);
const owner = client();
await owner.auth(OWNER_EMAIL, OWNER_PASSWORD);
const results = await Promise.all(
  wanted.map(async (scenario) => {
    const at = Date.now();
    let failures;
    try {
      failures = await play(scenario, owner);
    } catch (error) {
      failures = [`error: ${error.message}`];
    }
    const result = {
      name: scenario.name,
      pass: failures.length === 0,
      seconds: Math.round((Date.now() - at) / 1000),
      failures,
    };
    log(`${scenario.name}: ${result.pass ? "PASS" : `FAIL\n  - ${failures.join("\n  - ")}`}`);
    return result;
  }),
);
fs.writeFileSync(path.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((result) => !result.pass).length;
log(`${results.length - failed}/${results.length} scenarios pass`);
process.exit(failed ? 1 : 0);
