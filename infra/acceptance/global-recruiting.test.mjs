import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertGlobalRecruitingCopiesArchived,
  verifyGlobalRecruiting,
} from "./global-recruiting.mjs";

const roles = ["product", "crm"].map((id) => ({
  id,
  threadId: `thread-${id}`,
  groupId: `group-${id}`,
}));
const fixture = { isolatedTestAccount: true, roles: roles.map((role) => ({ roleId: role.id })) };
function rpcFor(options = {}) {
  return async (route, input) => {
    if (route === "groups/page")
      return {
        items:
          input.archived === Boolean(options.archived)
            ? roles.map((role) => ({
                id: role.groupId,
                name: options.customer ? "Customer role" : "测试副本 · Role",
              }))
            : [],
        nextOffset: null,
      };
    if (route === "recruiting/getWorkspace")
      return { crmTarget: input.threadId.includes("crm") ? {} : null };
    const selected =
      input.roleId && !options.leak ? roles.filter((role) => role.id === input.roleId) : roles;
    return {
      roles,
      nextCursor: null,
      items: selected.map((role) => ({
        roleId: role.id,
        workspace: {
          role: { id: role.id },
          revision: { criteria: options.noBrief ? [] : [{ label: "Recruiting requirement" }] },
        },
        feedback: {
          feedback: options.noFeedback ? [] : [{ id: `feedback-${role.id}`, text: "Proceed" }],
        },
        candidates: {
          items:
            options.empty || (!input.roleId && options.emptyGlobal)
              ? []
              : [{ key: `person-${role.id}`, name: "Example Person", shortlisted: true }],
          total: 1,
          counts: { shortlisted: 1, replied: 1 },
        },
        campaigns: [
          {
            serverId: "mail",
            campaign: { id: `campaign-${role.id}` },
            leads: [{ email: "person@example.test" }],
            stats: options.noStats ? undefined : { sent: 3, opened: 2, replied: 1 },
          },
        ],
        correspondence: {
          emails: [
            {
              id: `reply-${role.id}`,
              providerMessageId: `provider-${role.id}`,
              direction: options.sentOnly ? "sent" : "received",
              sender: "person@example.test",
              body: "Interested",
              date: "2026-10-30T12:00:00Z",
            },
          ],
          events: [{ id: `event-${role.id}`, start: "2026-10-31T12:00:00Z" }],
        },
        scheduling: {
          plans:
            role.id === "product" && !options.noBooking
              ? [{ id: "plan", bookingStatus: "completed" }]
              : [],
        },
        reminders: {
          items: options.noTasks
            ? []
            : [{ id: `task-${role.id}`, title: "Follow up", status: "open" }],
        },
      })),
    };
  };
}
test("checks real records and matching global/filtered projections for product and CRM roles using reads only", async () => {
  const routes = [];
  const delegate = rpcFor();
  const result = await verifyGlobalRecruiting(async (route, input) => {
    routes.push(route);
    return delegate(route, input);
  }, fixture);
  assert.equal(result.evidence.length, 16);
  assert.deepEqual(result.groups, ["group-product", "group-crm"]);
  assert.ok(
    routes.every((route) =>
      ["groups/page", "recruiting/getWorkspace", "recruiting/accountView"].includes(route),
    ),
  );
});
test("rejects a nonisolated account before any remote read or cleanup callback", async () => {
  let reads = 0;
  let cleanup = false;
  await assert.rejects(
    verifyGlobalRecruiting(
      async () => {
        reads++;
      },
      { ...fixture, isolatedTestAccount: false },
      {
        onValidatedGroups: () => {
          cleanup = true;
        },
      },
    ),
    /isolated test account/,
  );
  assert.equal(reads, 0);
  assert.equal(cleanup, false);
});
test("rejects customer-role names before exposing cleanup targets", async () => {
  let cleanup = false;
  await assert.rejects(
    verifyGlobalRecruiting(rpcFor({ customer: true }), fixture, {
      onValidatedGroups: () => {
        cleanup = true;
      },
    }),
    /non-test role/,
  );
  assert.equal(cleanup, false);
});
for (const [option, message] of Object.entries({
  empty: /actual people/,
  leak: /leaked another role/,
  emptyGlobal: /global data differs/,
  sentOnly: /received replies/,
  noStats: /stats are unavailable/,
  noBrief: /brief fields or criteria/,
  noFeedback: /actual records/,
  noTasks: /actual reminders/,
  noBooking: /completed scheduling booking/,
}))
  test(`refuses false-positive acceptance for ${option}`, async () => {
    await assert.rejects(verifyGlobalRecruiting(rpcFor({ [option]: true }), fixture), message);
  });
test("exposes only validated copies for finally cleanup when a later data assertion fails", async () => {
  let ids = [];
  await assert.rejects(
    verifyGlobalRecruiting(rpcFor({ noTasks: true }), fixture, {
      onValidatedGroups: (groups) => {
        ids = groups;
      },
    }),
    /actual reminders/,
  );
  assert.deepEqual(
    ids,
    roles.map((role) => role.groupId),
  );
});
test("requires archived-state readback, so a skipped working copy cannot count as cleaned up", async () => {
  const ids = roles.map((role) => role.groupId);
  await assert.rejects(assertGlobalRecruitingCopiesArchived(rpcFor(), ids), /remains active/);
  await assertGlobalRecruitingCopiesArchived(rpcFor({ archived: true }), ids);
  await assert.rejects(
    assertGlobalRecruitingCopiesArchived(async () => ({ items: [], nextOffset: null }), ids),
    /not archived/,
  );
});
