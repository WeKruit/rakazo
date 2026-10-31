import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyGlobalRecruitingChat } from "./global-recruiting-chat.mjs";

const fixture = { isolatedTestAccount: true, roles: [{ roleId: "product" }, { roleId: "crm" }] };
function harness(option = {}) {
  const original = {
    id: "recruiting-global-account",
    threadId: "original-thread",
    spaceId: "space",
    name: "Main",
    members: ["Main", "Sourcer", "Outreach", "Scheduling", "Reviewer"].map((name) => ({ name })),
  };
  const copy = { ...original, id: "copy", threadId: "copy-thread" };
  const roles = fixture.roles.map(({ roleId }) => ({
    id: roleId,
    title: `${roleId} Engineer`,
    groupId: `group-${roleId}`,
    threadId: `thread-${roleId}`,
  }));
  const calls = [];
  const events = [];
  const messages = [];
  let seq = 0;
  let turn = 0;
  const event = (type, runId, payload) => {
    const row = { seq: ++seq, type, runId, payload };
    events.push(row);
    return row;
  };
  const rpc = async (route, input) => {
    calls.push({ route, input });
    if (route === "groups/page" && input.archived) {
      if (option.missingArchive) return { items: [], nextOffset: null };
      if (option.pagedArchive && input.offset === 0)
        return { items: [{ id: "another-archived-copy" }], nextOffset: 1 };
      return { items: copy.archivedAt ? [copy] : [], nextOffset: null };
    }
    if (route === "groups/page")
      return {
        items: [
          original,
          ...roles.map((role) => ({
            id: role.groupId,
            name: option.customer ? "Customer role" : "测试副本 · Role",
          })),
        ],
        nextOffset: null,
      };
    if (route === "groups/get") {
      if (input.groupId === copy.id && copy.archivedAt) throw new Error("groups/get 404");
      return input.groupId === original.id ? original : copy;
    }
    if (route === "groups/duplicate") return option.originalDuplicate ? original : copy;
    if (route === "groups/update") {
      copy.name = input.name;
      return copy;
    }
    if (route === "groups/archive") {
      copy.archivedAt = "2026-10-31T00:00:00Z";
      return copy;
    }
    if (route === "recruiting/getWorkspace") {
      const role = roles.find((row) => row.threadId === input.threadId);
      return role
        ? { role, crmTarget: role.id === "crm" ? {} : null }
        : option.bound
          ? { role: { id: "unexpected" } }
          : null;
    }
    if (route === "recruiting/accountView")
      return {
        roles,
        nextCursor: null,
        items:
          input.view === "roles"
            ? []
            : [
                {
                  roleId: input.roleId,
                  candidates: { total: 1, items: [{ name: "Example Person" }], nextCursor: null },
                  correspondence: {
                    status: option.unchecked ? "not_checked" : "ready",
                    connectionChanged: false,
                    partial: false,
                    nextCursor: null,
                    connections: [{ status: "configured", checkIssue: null }],
                    events: [{ id: "calendar-event" }],
                    emails: [{ direction: "received" }],
                  },
                },
              ],
      };
    if (route === "threads/get") return { cursor: seq };
    if (route === "threads/messages") return { messages };
    throw new Error(`Unexpected route ${route}`);
  };
  const say = async (groupId, text) => {
    assert.equal(groupId, copy.id);
    turn++;
    const runId = `run-${turn}`;
    const inputId = `input-${turn}`;
    const source = event("thread.message.created", runId, { role: "user", messageId: inputId });
    messages.push({
      id: inputId,
      seq: source.seq,
      runId,
      role: "user",
      blocks: [{ kind: "text", text }],
    });
    event("run.started", runId, { trigger: "user" });
    const operation = ["interviews", "shortlist", "replies"][turn - 1];
    const tool = option.search ? "web_search_exa" : "recruiting_candidates";
    if (!option.noTool) {
      event("agent.tool.called", runId, {
        name: tool,
        executionId: `execution-${turn}`,
        argsSummary: `operation=${option.wrongOperation ? "roles" : operation}`,
      });
      if (!option.noCompletion)
        event("agent.tool.completed", runId, {
          name: tool,
          executionId: option.unmatchedCompletion ? "wrong-execution" : `execution-${turn}`,
          outcome: option.failed ? "error" : "succeeded",
        });
    }
    if (option.card)
      messages.push({
        id: `card-${turn}`,
        seq: ++seq,
        runId,
        role: "bot",
        blocks: [{ kind: "ask" }],
      });
    if (!option.noReply) {
      const replyId = `reply-${turn}`;
      const reply = event("thread.message.created", runId, { role: "bot", messageId: replyId });
      messages.push({
        id: replyId,
        seq: reply.seq,
        runId,
        internal: option.internal,
        role: "bot",
        blocks: [
          {
            kind: "text",
            text: roles.map((role) => `${role.title}: ${option.wrongCount ? 7 : 1}`).join("\n"),
          },
        ],
      });
    }
    if (option.throwAfterSend) throw new Error("native wait failed");
    return { replies: [] };
  };
  return { rpc, say, readEvents: async () => events, calls, copy, original };
}

test("uses native Main duplication and actual persisted tool/reply proof for three questions, then archives only its copy", async () => {
  const h = harness();
  const result = await verifyGlobalRecruitingChat(h.rpc, fixture, h);
  assert.deepEqual(
    result.evidence.map((row) => row.operation),
    ["interviews", "shortlist", "replies"],
  );
  assert.equal(result.tested, true);
  assert.equal(h.original.name, "Main");
  assert.deepEqual(
    h.calls.filter((call) => call.route === "groups/archive").map((call) => call.input.groupId),
    ["copy"],
  );
  assert.match(h.copy.name, /^测试副本 · /);
});
for (const [option, reason] of Object.entries({
  noTool: /did not call/,
  noCompletion: /no successful completion/,
  unmatchedCompletion: /no successful completion/,
  failed: /no successful completion/,
  wrongOperation: /did not call/,
  noReply: /visible persisted reply/,
  internal: /visible persisted reply/,
  wrongCount: /authoritative count/,
  card: /card decision/,
  search: /unexpected search/,
  unchecked: /verified complete/,
  throwAfterSend: /native wait failed/,
})) {
  test(`missing or unsafe ${option} proof fails and archives its created copy`, async () => {
    const h = harness({ [option]: true });
    await assert.rejects(verifyGlobalRecruitingChat(h.rpc, fixture, h), reason);
    assert.deepEqual(
      h.calls.filter((call) => call.route === "groups/archive").map((call) => call.input.groupId),
      ["copy"],
    );
  });
}
test("refuses nonisolated accounts without calls", async () => {
  const h = harness();
  await assert.rejects(
    verifyGlobalRecruitingChat(h.rpc, { ...fixture, isolatedTestAccount: false }, h),
    /isolated test account/,
  );
  assert.equal(h.calls.length, 0);
});
for (const option of ["bound", "customer", "originalDuplicate"])
  test(`refuses ${option} without archiving the original`, async () => {
    const h = harness({ [option]: true });
    await assert.rejects(verifyGlobalRecruitingChat(h.rpc, fixture, h));
    assert.equal(h.calls.filter((call) => call.route === "groups/archive").length, 0);
  });

test("checks all archived pages without reading the archived group detail", async () => {
  const h = harness({ pagedArchive: true });
  await verifyGlobalRecruitingChat(h.rpc, fixture, h);
  assert.deepEqual(
    h.calls
      .filter((call) => call.route === "groups/page" && call.input.archived)
      .map((call) => call.input.offset),
    [0, 1],
  );
  await assert.rejects(h.rpc("groups/get", { groupId: h.copy.id }), /404/);
});

test("fails cleanup proof when the exact created copy is absent from archived pages", async () => {
  const h = harness({ missingArchive: true });
  await assert.rejects(verifyGlobalRecruitingChat(h.rpc, fixture, h), /not archived/);
});
