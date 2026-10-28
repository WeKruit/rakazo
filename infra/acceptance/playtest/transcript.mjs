#!/usr/bin/env node
// Prints what a recruiter saw in one role chat, as Markdown, for the playtest judge: their own
// messages, the replies, question cards with their options and answers, approval cards and file
// names. Internal messages, ids, tool names and progress lines are left out.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/playtest/transcript.mjs --group <id> [--out file.md]
//   RAKAZO_TOKEN may replace email/password. RAKAZO_ORIGIN sets the Origin header.
// Node 20+, no dependencies. Prints no credentials.

import fs from "node:fs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const GROUP = option("--group");
if (!BASE || !GROUP) {
  console.error("Set RAKAZO_URL and pass --group <id>");
  process.exit(2);
}

let cookie = "";
function headers() {
  const result = { "content-type": "application/json", origin: ORIGIN };
  if (cookie) result.cookie = cookie;
  else if (process.env.RAKAZO_TOKEN) result.authorization = `Bearer ${process.env.RAKAZO_TOKEN}`;
  return result;
}
async function signIn() {
  const email = process.env.RAKAZO_EMAIL;
  const password = process.env.RAKAZO_PASSWORD;
  if (!email || !password) {
    if (process.env.RAKAZO_TOKEN) return;
    throw new Error("Set RAKAZO_EMAIL and RAKAZO_PASSWORD, or RAKAZO_TOKEN");
  }
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Sign-in failed (${response.status})`);
  cookie = (response.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
}
async function rpc(path, input) {
  const response = await fetch(`${BASE}/rpc/${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ json: input }),
  });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return (await response.json()).json;
}

function blockText(block) {
  switch (block.kind) {
    case "text":
      return block.text;
    case "ask": {
      const options = (block.actions ?? []).map((action) => `  - [${action.label}]`).join("\n");
      const answer = block.answer ? `\n  → answered: ${block.answer}` : "";
      const kind = block.approvalEffectId ? "Approval card" : "Question card";
      return `**${kind}:** ${block.text}${block.detail ? `\n${block.detail}` : ""}${options ? `\n${options}` : ""}${answer}`;
    }
    case "choice":
      return `**Choice:** ${block.question}\n${block.options.map((o) => `  - [${o.label}]`).join("\n")}`;
    case "card":
      return block.lines.map((line) => `${line.k}: ${line.v}`).join("\n");
    case "file":
      return `[file: ${block.name ?? "attachment"}]`;
    case "image":
      return "[image]";
    default:
      return "";
  }
}

await signIn();
const pages = [];
let before;
do {
  const page = await rpc("threads/messages", { groupId: GROUP, ...(before ? { before } : {}) });
  pages.unshift(page.messages);
  before = page.olderCursor ?? undefined;
} while (before);
const lines = [];
for (const message of pages.flat()) {
  if (message.internal) continue;
  const text = message.blocks.map(blockText).filter(Boolean).join("\n\n").trim();
  if (!text) continue;
  lines.push(`### ${message.role === "user" ? "Recruiter" : "Assistant"}\n\n${text}\n`);
}
const markdown = `${lines.join("\n")}`;
const out = option("--out");
if (out) fs.writeFileSync(out, markdown);
else process.stdout.write(markdown);
