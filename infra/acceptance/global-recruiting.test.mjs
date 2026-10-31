import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyGlobalRecruiting } from "./global-recruiting.mjs";

const roles = ["product", "crm"].map((id) => ({
  id,
  threadId: `thread-${id}`,
  groupId: `group-${id}`,
}));
const fixture = { roles: roles.map((role) => ({ roleId: role.id })) };
function rpcFor(options = {}) {
  return async (route, input) => {
    if (route === "groups/page")
      return {
        items:
          input.archived === Boolean(options.archived)
            ? roles.map((role) => ({
                id: role.groupId,
                name: options.customer ? "Customer role" : "测试固定 · Role",
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
      routines: options.noRoutines
        ? []
        : selected.map((role) => ({
            id: `routine-${role.id}`,
            threadId: options.foreignRoutine ? "other-thread" : role.threadId,
          })),
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
  assert.equal(result.evidence.length, 18);
  assert.ok(
    routes.every((route) =>
      ["groups/page", "recruiting/getWorkspace", "recruiting/accountView"].includes(route),
    ),
  );
});
test("refuses a listed role that is not a test copy", async () => {
  await assert.rejects(
    verifyGlobalRecruiting(rpcFor({ customer: true }), fixture),
    /non-test role/,
  );
});
test("ignores real roles elsewhere in the account", async () => {
  const rpc = rpcFor();
  await verifyGlobalRecruiting(async (route, input) => {
    const result = await rpc(route, input);
    if (route === "groups/page" && !input.archived)
      return { ...result, items: [...result.items, { id: "group-real", name: "Customer role" }] };
    if (route === "recruiting/accountView" && input.view === "roles")
      return {
        ...result,
        roles: [...result.roles, { id: "real", threadId: "t", groupId: "group-real" }],
      };
    return result;
  }, fixture);
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
  noRoutines: /actual native records/,
  foreignRoutine: /Routine filter leaked/,
}))
  test(`refuses false-positive acceptance for ${option}`, async () => {
    await assert.rejects(verifyGlobalRecruiting(rpcFor({ [option]: true }), fixture), message);
  });
