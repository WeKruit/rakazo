#!/usr/bin/env node
// Archives the "测试副本 · …" crews the replay and regression harnesses create, once they have been
// idle for a while. Archiving uses the product's own archive (restorable); nothing is deleted.
// Real roles never match the copy prefix. A copy with a run still working is skipped. Afterwards the
// copies are read again: any idle copy still unarchived exits 1, so a sweep that did nothing fails.
//
//   RAKAZO_URL=… RAKAZO_ORIGIN=… (RAKAZO_TOKEN=… | RAKAZO_EMAIL=… RAKAZO_PASSWORD=…) \
//     node infra/acceptance/archive-test-copies.mjs [--idle-hours 2] [--keep <groupId>,<groupId>] [--dry-run]
//     [--only <groupId>,…] [--stop]
// Before a copy is archived, every card still open in it is closed: approvals are denied (never
// allowed), forms declined, and questions get their "later" choice or a plain "test over" reply.
// Secret and connection cards are left alone. --stop stops a copy's working run instead of skipping
// the copy; the harness passes it for the copies it made itself.
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const TOKEN = process.env.RAKAZO_TOKEN;
const { RAKAZO_EMAIL: EMAIL, RAKAZO_PASSWORD: PASSWORD } = process.env;
if (!BASE || !(TOKEN || (EMAIL && PASSWORD))) {
  console.error("RAKAZO_URL and RAKAZO_TOKEN (or RAKAZO_EMAIL and RAKAZO_PASSWORD) are required");
  process.exit(2);
}
// The harness signs in with a password as often as with a token; both sweep the same copies.
let cookie = "";
if (EMAIL && PASSWORD) {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    console.error(`sign-in ${response.status}`);
    process.exit(2);
  }
  cookie = (response.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
}
const IDLE_MS = Number(option("--idle-hours", "2")) * 3_600_000;
const KEEP = new Set((option("--keep", "") ?? "").split(",").filter(Boolean));
const DRY = args.includes("--dry-run");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// How long a stopped chat gets to queue its follow-up before it is checked again.
const SETTLE_MS = Number(process.env.RAKAZO_SETTLE_MS ?? 2_000);
const ONLY = new Set((option("--only", "") ?? "").split(",").filter(Boolean));
// Copies the harnesses and verification runs make: a "测试副本 · " or "[验证用N]" prefix, or a
// "（测试副本）" / "（测试 · JD 副本）" suffix. Real roles never carry these marks.
const COPY = /^测试副本 · |^\[验证用\d+\] |（测试副本）$|（测试 · JD 副本）$/;
const STOP = args.includes("--stop");
const DEFER_CHOICE = /(稍后|以后|先不|跳过|暂不|不用|取消|later|skip|not now|cancel)/i;
const TEST_OVER = "测试结束，不用继续。";

/** The answer that closes an open card without approving anything; undefined leaves it. */
function closingAnswer(block) {
  if (block.input === "secret" || block.connection) return undefined;
  if (block.approvalEffectId) return "deny";
  if (block.requestedSchema) return { action: "decline" };
  const later = (block.actions ?? []).find((action) => DEFER_CHOICE.test(action.label));
  return later?.id ?? TEST_OVER;
}

async function closeCards(groupId) {
  const { messages = [] } = await rpc("threads/messages", { groupId, includePeerRuns: true });
  let closed = 0;
  for (const message of messages)
    for (const block of message.blocks ?? []) {
      if (block.kind !== "ask" || (block.status && block.status !== "pending")) continue;
      const answer = closingAnswer(block);
      if (answer === undefined || !message.runId) continue;
      await rpc("threads/answer", { groupId, runId: message.runId, messageId: message.id, answer })
        .then(() => (closed += 1))
        .catch((error) => console.error(`card in ${groupId}: ${error.message}`));
    }
  return closed;
}

async function rpc(route, json) {
  // A read that failed on the server side is safe to ask again; a write is not.
  const read = /\/(get|messages|list|page)$/.test(route);
  let response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(`${BASE}/rpc/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(cookie ? { cookie } : { authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify({ json }),
    });
    if (!read || attempt >= 5 || ![500, 502, 503, 504].includes(response.status)) break;
    await sleep(8_000);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route} ${response.status}`);
  return body.json;
}

async function activeGroups() {
  const groups = [];
  for (let offset = 0; offset !== null && offset !== undefined; ) {
    const page = await rpc("groups/page", { offset, archived: false });
    groups.push(...(page.items ?? []));
    offset = page.nextOffset;
  }
  return groups;
}
/** Copies this sweep is for: test copies, not kept, idle for longer than the limit. */
const idleCopies = (groups) =>
  groups.filter(
    (group) =>
      // --only names the caller's own copies by id, whatever they are called.
      (ONLY.size ? ONLY.has(group.id) : COPY.test(group.name)) &&
      !KEEP.has(group.id) &&
      Date.now() - Date.parse(group.updatedAt) >= IDLE_MS,
  );
const groups = await activeGroups();

let archived = 0;
const skipped = [];
for (const group of idleCopies(groups)) {
  const { activeRuns = [] } = await rpc("threads/get", { groupId: group.id });
  if (activeRuns.some((run) => run.status !== "waiting_input") && !STOP) {
    skipped.push(`${group.id} (working)`);
    continue;
  }
  if (!DRY) {
    try {
      const closed = await closeCards(group.id);
      if (closed) console.log(`closed ${closed} open cards in ${group.id}`);
      // Answering a card or stopping a turn can queue a follow-up (a teammate's stage report), so
      // stop until the chat stays quiet: a turn left queued in an archived chat retries forever.
      for (let check = 0; check < 5; check += 1) {
        const { activeRuns: active = [] } = await rpc("threads/get", { groupId: group.id });
        if (!active.length) break;
        await rpc("threads/stop", { groupId: group.id, scope: "all" });
        await sleep(SETTLE_MS);
      }
      await rpc("groups/archive", { groupId: group.id });
    } catch (error) {
      skipped.push(`${group.id} (${error.message})`);
      continue;
    }
  }
  archived += 1;
  console.log(`${DRY ? "would archive" : "archived"} ${group.id} ${group.name}`);
}
console.log(
  `${archived} test copies ${DRY ? "to archive" : "archived"}; ${skipped.length} skipped${skipped.length ? `: ${skipped.join(", ")}` : ""}`,
);
if (!DRY) {
  const left = idleCopies(await activeGroups());
  if (left.length) {
    console.error(
      `${left.length} idle test copies are still unarchived: ${left.map((group) => group.id).join(", ")}`,
    );
    process.exit(1);
  }
}
