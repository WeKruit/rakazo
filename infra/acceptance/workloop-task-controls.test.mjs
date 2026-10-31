import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCancelOneTask,
  assertStopEverything,
  assertStopKeepsBackground,
} from "./workloop-task-controls.mjs";

function fixture({ foreground = true, background = true, ignoreStop = false } = {}) {
  let stopped = false;
  let cancelled = false;
  const writes = [];
  const rpc = async (route, input) => {
    if (route === "groups/get")
      return {
        name: "测试副本",
        members: ["Main", "Sourcer", "Outreach", "Reviewer"].map((name) => ({ name })),
      };
    if (route === "threads/get")
      return {
        activeRuns:
          foreground && (!stopped || ignoreStop) ? [{ id: "foreground", status: "running" }] : [],
      };
    if (route === "threads/backgroundTasks")
      return background && !cancelled ? [{ id: "teammate", kind: "run", status: "running" }] : [];
    if (route === "threads/stop") {
      writes.push(input);
      stopped = true;
      if (input.scope === "all") cancelled = true;
      return {};
    }
    if (route === "threads/cancelTask") {
      writes.push(input);
      cancelled = true;
      return {};
    }
    throw new Error(`Unexpected route ${route}`);
  };
  return { rpc, writes };
}

test("default Stop must stop a real foreground while preserving existing teammate work", async () => {
  const f = fixture();
  await assertStopKeepsBackground(f.rpc, "copy");
  assert.deepEqual(f.writes, [{ groupId: "copy" }]);
  const idle = fixture({ foreground: false });
  await assert.rejects(assertStopKeepsBackground(idle.rpc, "copy"), /no foreground/);
  assert.equal(idle.writes.length, 0);
  await assert.rejects(
    assertStopKeepsBackground(fixture({ ignoreStop: true }).rpc, "copy"),
    /left the foreground/,
  );
});

test("Stop everything cannot pass against an already idle test copy", async () => {
  const idle = fixture({ foreground: false, background: false });
  await assert.rejects(assertStopEverything(idle.rpc, "copy"), /no active work/);
  assert.equal(idle.writes.length, 0);
  await assertStopEverything(fixture().rpc, "copy");
});

test("per-task cancellation uses the selected real native teammate task", async () => {
  const f = fixture();
  await assertCancelOneTask(f.rpc, "copy", "teammate");
  assert.deepEqual(f.writes, [{ groupId: "copy", id: "teammate", kind: "run" }]);
});
