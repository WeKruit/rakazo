// Offline check of the test-copy sweep: node --test infra/acceptance/archive-test-copies.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "archive-test-copies.mjs");
const old = new Date(Date.now() - 3 * 3_600_000).toISOString();

/** A fake product: copies to sweep, and archives that fail for the ids in `refuse`. */
async function serve(groups, refuse = new Set()) {
  const live = new Map(groups.map((group) => [group.id, group]));
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const { json } = JSON.parse(raw || "{}");
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ json: body }));
      };
      if (request.url === "/rpc/groups/page")
        return reply(200, { items: [...live.values()], nextOffset: null });
      if (request.url === "/rpc/threads/get") return reply(200, { activeRuns: [] });
      if (request.url === "/rpc/groups/archive") {
        if (refuse.has(json.groupId)) return reply(500, {});
        live.delete(json.groupId);
        return reply(200, {});
      }
      reply(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, live };
}

function sweep(url) {
  const child = spawn(process.execPath, [SCRIPT, "--idle-hours", "2"], {
    env: { ...process.env, RAKAZO_URL: url, RAKAZO_TOKEN: "test", RAKAZO_EMAIL: "" },
    stdio: "ignore",
  });
  return new Promise((resolve) => child.on("exit", resolve));
}

const copies = [
  { id: "copy_old", name: "测试副本 · 旧", updatedAt: old },
  { id: "copy_new", name: "测试副本 · 新", updatedAt: new Date().toISOString() },
  { id: "real_role", name: "Real role", updatedAt: old },
];

test("archives idle copies only and passes when none are left", async () => {
  const fake = await serve(copies);
  try {
    assert.equal(await sweep(fake.url), 0);
    assert.deepEqual([...fake.live.keys()].sort(), ["copy_new", "real_role"]);
  } finally {
    fake.server.close();
  }
});

test("fails when an idle copy is still unarchived after the sweep", async () => {
  const fake = await serve(copies, new Set(["copy_old"]));
  try {
    assert.equal(await sweep(fake.url), 1);
  } finally {
    fake.server.close();
  }
});
