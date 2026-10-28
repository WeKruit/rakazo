#!/usr/bin/env node
// Archives the "测试副本 · …" crews the replay and regression harnesses create, once they have been
// idle for a while. Archiving uses the product's own archive (restorable); nothing is deleted.
// Real roles never match the copy prefix. A copy with a run still working is skipped.
//
//   RAKAZO_URL=… RAKAZO_ORIGIN=… RAKAZO_TOKEN=… node infra/acceptance/archive-test-copies.mjs \
//     [--idle-hours 2] [--keep <groupId>,<groupId>] [--dry-run]
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const TOKEN = process.env.RAKAZO_TOKEN;
if (!BASE || !TOKEN) {
  console.error("RAKAZO_URL and RAKAZO_TOKEN are required");
  process.exit(2);
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
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ json }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route} ${response.status}`);
  return body.json;
}

const groups = [];
for (let offset = 0; offset !== null && offset !== undefined; ) {
  const page = await rpc("groups/page", { offset, archived: false });
  groups.push(...(page.items ?? []));
  offset = page.nextOffset;
}

let archived = 0;
const skipped = [];
for (const group of groups) {
  if (!COPY.test(group.name) || KEEP.has(group.id)) continue;
  if (Date.now() - Date.parse(group.updatedAt) < IDLE_MS) continue;
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
