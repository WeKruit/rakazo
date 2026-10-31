import assert from "node:assert/strict";

// Case helpers for the existing regression harness. The caller owns its native onboarding,
// test copy, search launch and try/finally archive; these checks never launch paid work.
export async function assertTestCopy(rpc, groupId) {
  const { name: groupName, members } = await rpc("groups/get", { groupId });
  assert.match(groupName, /测试副本/, "work controls must run only in a test copy");
  const names = new Set(members.map((member) => member.name));
  for (const name of ["Main", "Sourcer", "Outreach", "Reviewer"])
    assert(names.has(name), `test copy is missing ${name}`);
}

export async function assertStopKeepsBackground(rpc, groupId) {
  await assertTestCopy(rpc, groupId);
  const before = await rpc("threads/backgroundTasks", { groupId });
  assert(before.length > 0, "the mid-search Stop case needs background work already running");
  const snapshot = await rpc("threads/get", { groupId });
  const backgroundRunIds = new Set(
    before.filter((task) => task.kind === "run").map((task) => task.id),
  );
  const foreground = (snapshot.activeRuns ?? []).filter(
    (run) => !backgroundRunIds.has(run.id) && ["queued", "leased", "running"].includes(run.status),
  );
  assert(foreground.length > 0, "Stop was not exercised: no foreground turn was active");
  await rpc("threads/stop", { groupId });
  const [after, stopped] = await Promise.all([
    rpc("threads/backgroundTasks", { groupId }),
    rpc("threads/get", { groupId }),
  ]);
  for (const run of foreground)
    assert(
      !(stopped.activeRuns ?? []).some((active) => active.id === run.id),
      "Stop left the foreground turn active",
    );
  for (const task of before)
    assert(
      after.some((row) => row.id === task.id),
      "Stop ended a background task",
    );
}

export async function assertCancelOneTask(rpc, groupId, taskId) {
  await assertTestCopy(rpc, groupId);
  const before = await rpc("threads/backgroundTasks", { groupId });
  const selected = before.find((task) => task.id === taskId);
  assert(selected, "the selected test task is not running");
  await rpc("threads/cancelTask", { groupId, id: selected.id, kind: selected.kind });
  const after = await rpc("threads/backgroundTasks", { groupId });
  const cancelled = after.find((task) => task.id === taskId);
  assert(!cancelled || cancelled.status === "cancelling", "the chosen task ignored cancellation");
  for (const other of before.filter((task) => task.id !== taskId))
    assert(
      after.some((task) => task.id === other.id),
      "cancelling one task stopped its sibling",
    );
}

export async function assertStopEverything(rpc, groupId) {
  await assertTestCopy(rpc, groupId);
  const [before, work] = await Promise.all([
    rpc("threads/get", { groupId }),
    rpc("threads/backgroundTasks", { groupId }),
  ]);
  assert(
    (before.activeRuns?.length ?? 0) > 0 || work.some((task) => task.status !== "cancelling"),
    "Stop everything was not exercised: no active work remained",
  );
  await rpc("threads/stop", { groupId, scope: "all" });
  const [snapshot, tasks] = await Promise.all([
    rpc("threads/get", { groupId }),
    rpc("threads/backgroundTasks", { groupId }),
  ]);
  assert.equal(snapshot.activeRuns?.length ?? 0, 0, "Stop everything left a native run active");
  assert(
    tasks.every((task) => task.kind === "cloud_agent" && task.status === "cancelling"),
    "Stop everything left native background work active",
  );
}
