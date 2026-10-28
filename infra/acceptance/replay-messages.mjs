#!/usr/bin/env node
// Replays a recruiter's follow-up messages in an existing role chat on a live deployment, one at a
// time, and records what the product answered to each. A message is sent only after the previous
// one has settled (no run working, no new message for a while). Approval cards are never answered,
// so nothing is sent, imported or booked. Used to replay conversations that went wrong.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_TOKEN=… node infra/acceptance/replay-messages.mjs \
//     --group <id> --say "first message" --say "second message" [--out report.json]
//   Options: --quiet-s <n>   seconds without a new message that count as settled (default 30)
//            --step-min <n>  longest wait per message (default 15)
//   RAKAZO_ORIGIN sets the Origin header (default RAKAZO_URL). Node 20+, no dependencies.

import fs from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const says = args.flatMap((arg, index) => (arg === "--say" ? [args[index + 1]] : []));
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const TOKEN = process.env.RAKAZO_TOKEN;
const groupId = option("--group");
if (!BASE || !TOKEN || !groupId || !says.length)
  throw new Error("Set RAKAZO_URL and RAKAZO_TOKEN, and pass --group and at least one --say");
const QUIET_MS = Number(option("--quiet-s", "30")) * 1000;
const STEP_MS = Number(option("--step-min", "15")) * 60_000;
const out = option("--out", `replay-${Date.now()}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(path, json) {
  const response = await fetch(`${BASE}/rpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ json }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path} ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.json;
}

const messages = async () =>
  (await rpc("threads/messages", { groupId, includePeerRuns: true })).messages ?? [];
const working = async () => {
  const snapshot = await rpc("threads/get", { groupId });
  return (snapshot.activeRuns ?? []).some((run) => run.status !== "waiting_input");
};
const text = (message) =>
  message.blocks
    .map(
      (block) =>
        block.text ?? block.question ?? (block.kind === "file" ? `[file ${block.name}]` : ""),
    )
    .filter(Boolean)
    .join("\n");

const report = { groupId, startedAt: new Date().toISOString(), steps: [] };
for (const say of says) {
  const before = new Set((await messages()).map((message) => message.id));
  const busy = await working();
  const sentAt = Date.now();
  // The web composer interrupts work in progress and lets the coordinator route the message.
  await rpc("threads/send", {
    groupId,
    addressing: "coordinator",
    text: say,
    ...(busy ? { interrupt: true } : {}),
  });
  let lastCount = 0;
  let lastChange = Date.now();
  let replies = [];
  while (Date.now() - sentAt < STEP_MS) {
    await sleep(3_000);
    replies = (await messages()).filter(
      (message) => !before.has(message.id) && message.role !== "user",
    );
    if (replies.length !== lastCount) {
      lastCount = replies.length;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange > QUIET_MS && !(await working())) break;
  }
  const step = {
    say,
    seconds: Math.round((Date.now() - sentAt) / 1000),
    settled: Date.now() - sentAt < STEP_MS,
    replies: replies.map((message) => ({
      at: message.createdAt,
      bot: message.botId ?? null,
      internal: Boolean(message.internal),
      text: text(message),
      cards: message.blocks
        .filter((block) => block.kind === "ask")
        .map((block) => ({
          text: block.text,
          approval: Boolean(block.approvalEffectId),
          status: block.status,
        })),
    })),
  };
  report.steps.push(step);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    `[${step.seconds}s] ${say} → ${step.replies.length} replies${step.settled ? "" : " (still working)"}`,
  );
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify(report, null, 2));
