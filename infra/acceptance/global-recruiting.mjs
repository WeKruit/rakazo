import assert from "node:assert/strict";

const VIEWS = [
  "brief",
  "feedback",
  "shortlist",
  "contacts",
  "sequence",
  "inbox",
  "interview",
  "tasks",
];
const received = (item) =>
  (item.correspondence?.emails ?? []).filter(
    (email) => (email.direction ?? email.crm?.direction) === "received",
  );
const sort = (rows, key) => [...rows].sort((a, b) => String(key(a)).localeCompare(String(key(b))));
const campaigns = (item) => item.campaigns ?? (item.campaign ? [item.campaign] : []);
const hasText = (value) =>
  typeof value === "string"
    ? !!value.trim()
    : value && typeof value === "object" && Object.values(value).some(hasText);

function projection(view, item) {
  if (view === "brief") return item.workspace;
  if (view === "feedback") return sort(item.feedback?.feedback ?? [], (row) => row.id);
  if (view === "shortlist")
    return {
      people: sort(item.candidates?.items ?? [], (row) => row.key),
      total: item.candidates?.total,
      counts: item.candidates?.counts,
    };
  if (view === "contacts")
    return {
      people: sort(item.candidates?.items ?? [], (row) => row.key),
      contacts: sort(
        (item.correspondence?.contacts ?? []).map(({ checkedAt: _, ...contact }) => contact),
        (row) => row.candidateKey,
      ),
    };
  if (view === "sequence")
    return sort(
      campaigns(item).map((campaign) => ({
        serverId: campaign.serverId,
        campaign: campaign.campaign,
        stats: campaign.stats,
        leads: sort(campaign.leads, (lead) => lead.email),
      })),
      (campaign) => `${campaign.serverId}:${campaign.campaign?.id}`,
    );
  if (view === "inbox")
    return sort(
      received(item).map((email) => ({
        id: email.id,
        providerMessageId: email.providerMessageId,
        sender: email.sender,
        recipients: email.recipients,
        subject: email.subject,
        body: email.body,
        date: email.date,
        campaignId: email.campaignId,
        direction: email.direction ?? email.crm?.direction,
      })),
      (row) => row.id,
    );
  if (view === "interview")
    return {
      events: sort(item.correspondence?.events ?? [], (row) => row.id),
      plans: sort(item.scheduling?.plans ?? [], (row) => row.id),
    };
  return sort(item.reminders?.items ?? [], (row) => row.id);
}

async function groupsPage(rpc, archived) {
  const groups = [];
  const cursors = new Set();
  for (let offset = 0; offset !== null; ) {
    assert.ok(!cursors.has(offset), "Group pagination must advance");
    cursors.add(offset);
    const page = await rpc("groups/page", { offset, archived });
    groups.push(...page.items);
    offset = page.nextOffset ?? null;
  }
  return groups;
}

/** Read-only checks; the callback exposes cleanup targets only after account and copy validation. */
export async function verifyGlobalRecruiting(rpc, fixture, { onValidatedGroups = () => {} } = {}) {
  assert.equal(
    fixture.isolatedTestAccount,
    true,
    "Global recruiting requires an isolated test account",
  );
  assert.ok(
    Array.isArray(fixture.roles) && fixture.roles.length >= 2,
    "Provide at least two test-copy role expectations",
  );
  assert.ok(
    fixture.roles.every((role) => typeof role.roleId === "string" && role.roleId),
    "Each expectation needs a role id",
  );
  const groups = await groupsPage(rpc, false);
  const allRoles = new Map();
  const roleCursors = new Set();
  for (let cursor; ; ) {
    if (cursor) {
      assert.ok(!roleCursors.has(cursor), "Role pagination must advance");
      roleCursors.add(cursor);
    }
    const page = await rpc("recruiting/accountView", {
      view: "roles",
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const role of page.roles) allRoles.set(role.id, role);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  for (const role of allRoles.values()) {
    const group = groups.find((group) => group.id === role.groupId);
    assert.match(
      group?.name ?? "",
      /^测试副本 · /,
      "Refusing a non-test role in the regression account",
    );
  }
  const selected = fixture.roles.map((expected) => {
    const role = allRoles.get(expected.roleId);
    assert.ok(role, "Test-copy role is missing");
    return role;
  });
  const cleanupGroups = [...new Set(selected.map((role) => role.groupId))];
  onValidatedGroups(cleanupGroups);
  const globalItems = new Map();
  for (const view of VIEWS) {
    const items = new Map();
    const cursors = new Set();
    for (let cursor; ; ) {
      if (cursor) {
        assert.ok(!cursors.has(cursor), "View pagination must advance");
        cursors.add(cursor);
      }
      const page = await rpc("recruiting/accountView", {
        view,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        assert.ok(!items.has(item.roleId), "A role was repeated across global pages");
        items.set(item.roleId, item);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    globalItems.set(view, items);
  }
  const evidence = [];
  const kinds = new Set();
  for (const expected of fixture.roles) {
    const role = allRoles.get(expected.roleId);
    const workspace = await rpc("recruiting/getWorkspace", { threadId: role.threadId });
    const kind = workspace.crmTarget ? "crm" : "product";
    kinds.add(kind);
    for (const view of VIEWS) {
      const filtered = await rpc("recruiting/accountView", { view, roleId: role.id, limit: 50 });
      assert.deepEqual(
        filtered.items.map((item) => item.roleId),
        [role.id],
        "Role filter leaked another role",
      );
      const item = filtered.items[0];
      if (view === "brief")
        assert.ok(
          hasText(item.workspace?.revision?.brief) ||
            item.workspace?.revision?.criteria?.length > 0,
          "Job brief has no saved brief fields or criteria",
        );
      if (view === "feedback")
        assert.ok(
          item.feedback?.feedback.length >= Math.max(1, expected.feedback ?? 1),
          "Client feedback has no actual records",
        );
      if (["shortlist", "contacts"].includes(view))
        assert.ok(
          item.candidates?.items.length >= Math.max(1, expected[view] ?? 1),
          `${view} has no actual people`,
        );
      if (view === "shortlist")
        assert.ok(
          item.candidates.items.every((person) => person.shortlisted === true),
          "Shortlist contains an unshortlisted person",
        );
      if (view === "sequence") {
        const rows = campaigns(item);
        assert.ok(
          rows.some((campaign) => campaign.campaign && campaign.leads.length > 0),
          "Sequence has no campaign leads",
        );
        for (const metric of ["sent", "opened", "replied"]) {
          assert.ok(
            rows.length &&
              rows.every(
                (campaign) =>
                  Number.isSafeInteger(campaign.stats?.[metric]) && campaign.stats[metric] >= 0,
              ),
            `Sequence ${metric} stats are unavailable`,
          );
          const minimum =
            metric === "sent"
              ? Math.max(1, expected.sent ?? 1)
              : metric === "opened"
                ? (expected.opened ?? 0)
                : Math.max(1, expected.replies ?? 1);
          assert.ok(
            rows.reduce((total, campaign) => total + campaign.stats[metric], 0) >= minimum,
            `Sequence ${metric} count is too small`,
          );
        }
      }
      if (view === "inbox")
        assert.ok(
          received(item).length >= Math.max(1, expected.replies ?? 1),
          "Inbox has no actual received replies",
        );
      if (view === "interview") {
        assert.ok(
          item.correspondence?.events.length >= Math.max(1, expected.interviews ?? 1),
          "Interview has no actual events",
        );
        if (kind === "product")
          assert.ok(
            item.scheduling?.plans.some((plan) => plan.bookingStatus === "completed"),
            "Product role has no completed scheduling booking",
          );
      }
      if (view === "tasks")
        assert.ok(
          item.reminders?.items.length >= Math.max(1, expected.tasks ?? 1),
          "Tasks has no actual reminders",
        );
      const global = globalItems.get(view).get(role.id);
      assert.ok(global, "Global view omitted the test role");
      assert.deepEqual(
        projection(view, global),
        projection(view, item),
        `${view} global data differs from the filtered role`,
      );
      evidence.push({ roleId: role.id, view, filtered: true, global: true });
    }
  }
  assert.deepEqual(
    [...kinds].sort(),
    ["crm", "product"],
    "Both product and CRM roles must be covered",
  );
  return { evidence, groups: cleanupGroups };
}

/** The archive script skips working copies without a failure exit code; verify its actual result. */
export async function assertGlobalRecruitingCopiesArchived(rpc, ids) {
  const active = await groupsPage(rpc, false);
  const archived = await groupsPage(rpc, true);
  for (const id of ids) {
    assert.ok(
      !active.some((group) => group.id === id),
      "A global regression test copy remains active",
    );
    assert.ok(
      archived.some((group) => group.id === id),
      "A global regression test copy was not archived",
    );
  }
}
