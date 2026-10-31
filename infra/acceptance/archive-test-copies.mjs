#!/usr/bin/env node
// Archives the "测试副本 · …" crews the replay and regression harnesses create, once they have been
// idle for a while. Archiving uses the product's own archive (restorable); nothing is deleted.
// Real roles never match the copy prefix. A copy with a run still working is skipped. Afterwards the
// copies are read again: any idle copy still unarchived exits 1, so a sweep that did nothing fails.
//
//   RAKAZO_URL=… RAKAZO_ORIGIN=… (RAKAZO_TOKEN=… | RAKAZO_EMAIL=… RAKAZO_PASSWORD=…) \
//     node infra/acceptance/archive-test-copies.mjs [--idle-hours 2] [--keep <groupId>,<groupId>] [--dry-run]
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
const COPY = /^测试副本 · /;

async function rpc(route, json) {
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
      COPY.test(group.name) &&
      !KEEP.has(group.id) &&
      Date.now() - Date.parse(group.updatedAt) >= IDLE_MS,
  );
const groups = await activeGroups();

let archived = 0;
const skipped = [];
for (const group of idleCopies(groups)) {
  const { activeRuns = [] } = await rpc("threads/get", { groupId: group.id });
  if (activeRuns.some((run) => run.status !== "waiting_input")) {
    skipped.push(`${group.id} (working)`);
    continue;
  }
  if (!DRY) {
    try {
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
