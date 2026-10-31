import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { replyAfterInput } from "./follow-up.mjs";

const CASES = [
  {
    operation: "interviews",
    view: "interview",
    subject: "upcoming and recent interview calendar entries",
  },
  { operation: "shortlist", view: "shortlist", subject: "saved shortlisted people" },
  {
    operation: "replies",
    view: "inbox",
    subject: "received email replies (messages, not distinct senders)",
  },
];
const CREW = ["Main", "Sourcer", "Outreach", "Scheduling", "Reviewer"];
const textOf = (message) =>
  (message.blocks ?? [])
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join("\n");

async function groupsOf(rpc, archived = false) {
  const groups = [];
  const seen = new Set();
  for (let offset = 0; offset !== null; ) {
    assert(!seen.has(offset), "Group pagination must advance");
    seen.add(offset);
    const page = await rpc("groups/page", { offset, archived });
    groups.push(...page.items);
    offset = page.nextOffset ?? null;
  }
  return groups;
}
function assertCrew(group) {
  for (const name of CREW)
    assert(
      group.members?.some((member) => member.name === name),
      `Native Main is missing ${name}`,
    );
}
async function assertUnlinked(rpc, group) {
  assert.equal(
    await rpc("recruiting/getWorkspace", { threadId: group.threadId }),
    null,
    "Main must remain unlinked to a role",
  );
}
function countFor(view, item) {
  assert(item, "The selected role has no authoritative view result");
  if (view === "shortlist") {
    assert(!item.candidates?.nextCursor, "Shortlist proof needs a complete candidate page");
    const count = item.candidates?.items?.length;
    assert(Number.isSafeInteger(count) && count > 0, "Shortlist needs actual saved people");
    assert.equal(item.candidates.total, count, "Shortlist total must match the complete page");
    return count;
  }
  const correspondence = item.correspondence;
  assert(
    correspondence &&
      ["ready", "empty"].includes(correspondence.status) &&
      !correspondence.partial &&
      !correspondence.nextCursor &&
      !correspondence.connectionChanged,
    "Chat proof requires a verified complete correspondence read",
  );
  assert(
    correspondence.connections.every(
      (connection) => connection.status === "configured" && !connection.checkIssue,
    ),
    "Correspondence source is unavailable",
  );
  if (view === "interview") {
    assert(correspondence.events.length > 0, "Interview needs actual calendar entries");
    return correspondence.events.length;
  }
  assert(
    correspondence.emails.every((email) => (email.direction ?? email.crm?.direction) != null),
    "Reply direction is unknown",
  );
  const count = correspondence.emails.filter(
    (email) => (email.direction ?? email.crm?.direction) === "received",
  ).length;
  assert(count > 0, "Inbox needs actual received replies");
  return count;
}

/** Opt-in only: the caller must obtain cost authorization before invoking the existing native say callback. */
export async function verifyGlobalRecruitingChat(rpc, fixture, { say, readEvents }) {
  assert.equal(fixture.isolatedTestAccount, true, "Global chat requires an isolated test account");
  assert(
    Array.isArray(fixture.roles) && fixture.roles.length >= 2,
    "Global chat needs product and CRM test roles",
  );
  assert.equal(
    new Set(fixture.roles.map((role) => role.roleId)).size,
    fixture.roles.length,
    "Fixture role IDs must be unique",
  );
  assert.equal(typeof say, "function");
  assert.equal(typeof readEvents, "function");
  const groups = await groupsOf(rpc);
  const mains = groups.filter((group) => group.id.startsWith("recruiting-global-"));
  assert.equal(mains.length, 1, "Exactly one provisioned native global Main is required");
  const original = await rpc("groups/get", { groupId: mains[0].id });
  assertCrew(original);
  await assertUnlinked(rpc, original);
  const catalog = await rpc("recruiting/accountView", { view: "roles", limit: 50 });
  assert.equal(catalog.nextCursor, null, "Role catalog proof must be complete");
  for (const role of catalog.roles)
    assert.match(
      groups.find((group) => group.id === role.groupId)?.name ?? "",
      /^测试副本 · /,
      "Refusing customer roles in the chat regression account",
    );
  const roles = fixture.roles.map(({ roleId }) => {
    const role = catalog.roles.find((row) => row.id === roleId);
    assert(
      role && typeof role.title === "string" && role.title.trim(),
      "Selected fixture role is missing",
    );
    return role;
  });
  const kinds = new Set();
  for (const role of roles) {
    const workspace = await rpc("recruiting/getWorkspace", { threadId: role.threadId });
    assert.equal(workspace?.role?.id, role.id, "Fixture workspace does not match its role");
    kinds.add(workspace.crmTarget ? "crm" : "product");
  }
  assert.deepEqual(
    [...kinds].sort(),
    ["crm", "product"],
    "Chat proof needs both product and CRM roles",
  );
  let copy;
  try {
    copy = await rpc("groups/duplicate", { groupId: original.id });
    // Refuse cleanup unless native duplication returned a distinct target owned by this account.
    assert(
      copy.id &&
        copy.id !== original.id &&
        copy.threadId !== original.threadId &&
        copy.spaceId === original.spaceId,
      "Native duplicate did not return a separate owned Main",
    );
    await rpc("groups/update", {
      groupId: copy.id,
      name: `测试副本 · Global Main ${randomUUID().slice(0, 8)}`,
    });
    const detail = await rpc("groups/get", { groupId: copy.id });
    assert.match(detail.name, /^测试副本 · /);
    assertCrew(detail);
    await assertUnlinked(rpc, detail);
    const evidence = [];
    for (const { operation, view, subject } of CASES) {
      const expected = [];
      for (const role of roles) {
        const page = await rpc("recruiting/accountView", { view, roleId: role.id, limit: 50 });
        assert.equal(page.nextCursor, null);
        assert.deepEqual(
          page.items.map((item) => item.roleId),
          [role.id],
          "Filtered view leaked a role",
        );
        expected.push({ title: role.title, count: countFor(view, page.items[0]) });
      }
      const before = await rpc("threads/get", { groupId: copy.id });
      const cursor = before.cursor;
      assert(
        Number.isSafeInteger(cursor) && cursor >= 0,
        "The native snapshot has no event cursor",
      );
      const question = `Across these roles: ${roles.map((role) => role.title).join("; ")}, how many ${subject} are there? Use the saved account records. Give one line per role with its exact title followed by the numeric count. Do not search for people, change records, send messages, book interviews or request approval.`;
      await say(copy.id, question);
      const [events, page] = await Promise.all([
        readEvents(copy.id),
        rpc("threads/messages", { groupId: copy.id, includePeerRuns: true }),
      ]);
      const fresh = events.filter((event) => event.seq > cursor);
      const input = page.messages.find(
        (message) =>
          message.role === "user" && textOf(message) === question && message.seq > cursor,
      );
      assert(input, "The exact question was not persisted after the snapshot cursor");
      const reply = replyAfterInput(events, page.messages, input.seq);
      assert(reply?.role === "bot", "No visible persisted reply followed the actual question");
      assert(
        !page.messages.some(
          (message) =>
            message.seq > cursor && (message.blocks ?? []).some((block) => block.kind === "ask"),
        ),
        "Read-only Main chat requested a card decision",
      );
      const calls = fresh.filter((event) => event.type === "agent.tool.called");
      assert(
        calls.every((event) =>
          ["recruiting_candidates", "skill_read", "read_memory"].includes(event.payload?.name),
        ),
        "Global read invoked an unexpected search, write or delegation tool",
      );
      const reads = calls.filter(
        (event) =>
          event.runId === reply.runId &&
          event.payload?.name === "recruiting_candidates" &&
          new RegExp(`(?:^|, )operation=${operation}(?:,|$)`).test(event.payload.argsSummary ?? ""),
      );
      assert(
        reads.length > 0,
        `Main did not call the native ${operation} operation for this question`,
      );
      for (const call of reads)
        assert(
          fresh.some(
            (event) =>
              event.type === "agent.tool.completed" &&
              event.runId === call.runId &&
              event.payload?.executionId === call.payload.executionId &&
              event.payload?.name === "recruiting_candidates" &&
              event.payload?.outcome === "succeeded" &&
              event.seq > call.seq &&
              event.seq < reply.seq,
          ),
          "The expected native read has no successful completion before the reply",
        );
      const text = textOf(reply);
      for (const { title, count } of expected)
        assert(
          text
            .split("\n")
            .some(
              (line) =>
                line.includes(title) &&
                new RegExp(`(?:^|[^\\d])${count}(?:[^\\d]|$)`).test(
                  line.slice(line.indexOf(title) + title.length),
                ),
            ),
          "Main reply omitted a selected role or its authoritative count",
        );
      await assertUnlinked(rpc, detail);
      evidence.push({
        operation,
        roleIds: roles.map((role) => role.id),
        runId: reply.runId,
        replyId: reply.id,
      });
    }
    return { tested: true, evidence };
  } finally {
    if (
      copy?.id &&
      copy.id !== original.id &&
      copy.threadId !== original.threadId &&
      copy.spaceId === original.spaceId
    ) {
      await rpc("groups/archive", { groupId: copy.id });
      assert(
        (await groupsOf(rpc, true)).some((group) => group.id === copy.id),
        "Created Main test copy was not archived",
      );
    }
  }
}
