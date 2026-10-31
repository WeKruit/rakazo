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
async function serve(
  groups,
  refuse = new Set(),
  { messages = [], activeRuns = [], stopsUntilQuiet = 1 } = {},
) {
  const live = new Map(groups.map((group) => [group.id, group]));
  const answers = [];
  const stopped = [];
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
      // A stopped chat can queue a follow-up, so it is quiet only after `stopsUntilQuiet` stops.
      if (request.url === "/rpc/threads/get")
        return reply(200, {
          activeRuns:
            stopped.filter((id) => id === json.groupId).length >= stopsUntilQuiet ? [] : activeRuns,
        });
      if (request.url === "/rpc/threads/messages") return reply(200, { messages });
      if (request.url === "/rpc/threads/answer") {
        answers.push(json);
        return reply(200, { ok: true });
      }
      if (request.url === "/rpc/threads/stop") {
        stopped.push(json.groupId);
        return reply(200, { ok: true });
      }
      if (request.url === "/rpc/groups/archive") {
        if (refuse.has(json.groupId)) return reply(500, {});
        live.delete(json.groupId);
        return reply(200, {});
      }
      reply(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, live, answers, stopped };
}

function sweep(url, extra = []) {
  const child = spawn(process.execPath, [SCRIPT, "--idle-hours", "2", ...extra], {
    env: {
      ...process.env,
      RAKAZO_URL: url,
      RAKAZO_TOKEN: "test",
      RAKAZO_EMAIL: "",
      RAKAZO_SETTLE_MS: "0",
    },
    stdio: "ignore",
  });
  return new Promise((resolve) => child.on("exit", resolve));
}

const copies = [
  { id: "copy_old", name: "测试副本 · 旧", updatedAt: old },
  { id: "copy_new", name: "测试副本 · 新", updatedAt: new Date().toISOString() },
  { id: "verify_old", name: "[验证用4] R&D Engineer", updatedAt: old },
  { id: "suffix_old", name: "Research Scientist（测试副本）", updatedAt: old },
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

test("closes every open card without approving anything before archiving", async () => {
  const ask = (id, block) => ({
    id,
    runId: "run_1",
    blocks: [{ kind: "ask", text: id, ...block }],
  });
  const messages = [
    ask("send", {
      approvalEffectId: "effect_1",
      actions: [{ id: "allow", label: "Confirm and send" }],
    }),
    ask("form", { requestedSchema: { type: "object", properties: {} } }),
    ask("later", {
      actions: [
        { id: "a", label: "12:00" },
        { id: "b", label: "稍后再说" },
      ],
    }),
    ask("time", { actions: [{ id: "a", label: "12:00–12:30 PT" }] }),
    ask("secret", { input: "secret" }),
    ask("done", { status: "answered" }),
  ];
  const fake = await serve(copies, new Set(), { messages });
  try {
    assert.equal(await sweep(fake.url), 0);
    const byCard = Object.fromEntries(fake.answers.map((a) => [a.messageId, a.answer]));
    assert.deepEqual(byCard, {
      send: "deny",
      form: { action: "decline" },
      later: "b",
      time: "测试结束，不用继续。",
    });
  } finally {
    fake.server.close();
  }
});

test("--stop stops a working copy and archives it; without it the copy is skipped", async () => {
  const activeRuns = [{ id: "run_1", status: "running" }];
  const own = [{ id: "copy_old", name: "测试副本 · 旧", updatedAt: old }];
  const fake = await serve(own, new Set(), { activeRuns });
  try {
    assert.equal(await sweep(fake.url), 1);
    assert.deepEqual(fake.stopped, []);
    assert.equal(await sweep(fake.url, ["--stop"]), 0);
    assert.deepEqual(fake.stopped, ["copy_old"]);
    assert.equal(fake.live.size, 0);
  } finally {
    fake.server.close();
  }
});

test("--stop stops again when stopping queued a follow-up, and archives once quiet", async () => {
  const activeRuns = [{ id: "report_run", status: "queued" }];
  const own = [{ id: "copy_old", name: "测试副本 · 旧", updatedAt: old }];
  const fake = await serve(own, new Set(), { activeRuns, stopsUntilQuiet: 2 });
  try {
    assert.equal(await sweep(fake.url, ["--stop"]), 0);
    assert.deepEqual(fake.stopped, ["copy_old", "copy_old"]);
    assert.equal(fake.live.size, 0);
  } finally {
    fake.server.close();
  }
});
