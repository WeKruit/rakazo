import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCopyMutations,
  checkSharedMail,
  findOwnedCampaign,
  withIsolationTestCopies,
} from "./account-isolation-checks.mjs";

function client(label, failRole = false) {
  const calls = [];
  const state = new Map();
  return {
    label,
    calls,
    async rpc(route, input) {
      calls.push({ route, input });
      const data =
        route === "onboarding/ensureRecruiting"
          ? { groupId: `${label}-home` }
          : route === "groups/get"
            ? (state.get(input.groupId) ?? {
                members: ["Main", "Sourcer", "Outreach", "Reviewer"].map((name) => ({ name })),
              })
            : route === "groups/duplicate"
              ? { id: `${label}-copy`, threadId: `${label}-thread` }
              : route === "artifacts/create"
                ? { id: `${label}-artifact` }
                : route === "recruiting/createRole"
                  ? { role: { id: `${label}-role`, revision: 1 } }
                  : { ok: true };
      if (route === "groups/update")
        state.set(input.groupId, {
          name: input.name,
          archivedAt: null,
          members: ["Main", "Sourcer", "Outreach", "Reviewer"].map((name) => ({ name })),
        });
      return { status: route === "recruiting/createRole" && failRole ? 500 : 200, data };
    },
  };
}

test("uses bootstrap and native duplicate, then archives both copies even when the case fails", async () => {
  const a = client("A");
  const b = client("B");
  await assert.rejects(
    withIsolationTestCopies([a, b], async () => {
      throw new Error("case failed");
    }),
    /case failed/,
  );
  for (const owner of [a, b]) {
    assert.equal(owner.calls[0].route, "bootstrap");
    assert.equal(owner.calls[1].route, "onboarding/ensureRecruiting");
    assert.ok(owner.calls.some((call) => call.route === "groups/duplicate"));
    assert.ok(!owner.calls.some((call) => call.route === "groups/create"));
    assert.equal(owner.calls.at(-1).route, "groups/archive");
  }
});

test("archives a copy when fixture preparation fails part way through", async () => {
  const a = client("A", true);
  await assert.rejects(
    withIsolationTestCopies([a], async () => {}),
    /recruiting\/createRole/,
  );
  assert.equal(a.calls.at(-1).route, "groups/archive");
});

test("never runs mutations against a customer conversation and rejects false authorization failures", async () => {
  const attempts = [];
  const viewer = {
    label: "B",
    rpc: async (route) => {
      attempts.push(route);
      return { status: 500 };
    },
  };
  await assert.rejects(
    checkCopyMutations(viewer, { name: "Customer role" }, () => {}),
    /designated test copy/,
  );
  assert.equal(attempts.length, 0);
  const copy = {
    name: "测试副本 · Isolation",
    groupId: "copy",
    roleId: "role",
    roleRevision: 1,
    owner: {
      rpc: async () => ({ status: 200, data: { name: "测试副本 · Isolation", archivedAt: null } }),
    },
  };
  const checks = [];
  await checkCopyMutations(viewer, copy, (check) => checks.push(check));
  assert.ok(checks.length >= 7);
  assert.ok(checks.every((check) => check.verdict === "leak"));
  assert.ok(attempts.includes("threads/cancelTask"));
});

function mailClient(reply) {
  const calls = [];
  return {
    label: "B",
    calls,
    async rpc(route, input) {
      calls.push({ route, input });
      if (route === "threads/messages")
        return {
          status: 200,
          data: {
            messages: [
              {
                role: "bot",
                createdAt: new Date(Date.now() + 1_000).toISOString(),
                blocks: [{ kind: "text", text: reply }],
              },
            ],
          },
        };
      if (route === "runs/list") return { status: 200, data: { runs: [] } };
      return { status: 200, data: { ok: true } };
    },
  };
}
const copy = { groupId: "B-copy", name: "测试副本 · Isolation x" };
const foreign = { id: "c-1", name: "Founding Engineer Outreach", emails: ["ada@example.test"] };

test("a crew that reveals another account's campaign is a leak", async () => {
  for (const [reply, verdict] of [
    ["That campaign is not in this account.", "ok"],
    ["Campaign: Founding Engineer Outreach, to ada@example.test", "leak"],
  ]) {
    const records = [];
    const viewer = mailClient(reply);
    await checkSharedMail(viewer, copy, foreign, (row) => records.push(row), { waitMs: 0 });
    assert.equal(records[0].verdict, verdict);
    assert.ok(viewer.calls.some((call) => call.route === "threads/stop"));
    assert.equal(viewer.calls[0].input.groupId, "B-copy");
  }
});

test("finds the owner's first named campaign without changing anything", async () => {
  const calls = [];
  const owner = {
    async rpc(route, input) {
      calls.push(route);
      return input.groupId === "g2"
        ? {
            status: 200,
            data: { campaign: { id: "c-2", name: "Role" }, leads: [{ email: "Ada@Example.test" }] },
          }
        : { status: 200, data: { campaign: null, leads: [] } };
    },
  };
  assert.deepEqual(await findOwnedCampaign(owner, ["g1", "g2", "g3"]), {
    id: "c-2",
    name: "Role",
    emails: ["ada@example.test"],
  });
  assert.deepEqual(calls, ["recruiting/roleCampaign", "recruiting/roleCampaign"]);
});
