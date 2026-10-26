#!/usr/bin/env node
// Headless account isolation check against a live deployment, through the same RPC the web app
// calls. Account A is an existing account with real work; account B is a separate test account.
// The script collects A's ids (roles, chats, candidates, files, usage, memory, routines …), then:
//   1. lists everything as B and fails if any of A's ids appear;
//   2. asks for each of A's resources by id as B and fails if one comes back;
//   3. does the same in reverse with B's ids;
//   4. checks B sees no CRM organization, mailbox or deployment settings it was not given, and
//      that money and every account's spend show only to verified operator-domain staff;
//   5. checks every listing refuses a request with no session.
// Only reads. A's resources are never changed; B's crew is created on first use like a new user.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_EMAIL=<A> RAKAZO_PASSWORD=<A password> \
//   RAKAZO_B_EMAIL=<B> [RAKAZO_B_PASSWORD=<B password>] node infra/acceptance/account-isolation.mjs
//   Without RAKAZO_B_PASSWORD, B's password is derived from A's (HMAC), so no second secret is kept.
//   Options: --groups <n>   how many of A's recent role chats to probe (default 8)
//            --out <file>   JSON report (default ./isolation-<time>.json)
//   RAKAZO_RELEASE_SHA labels the report with the live release. RAKAZO_OPERATOR_DOMAIN (default
//   wekruit.com) is the staff domain whose verified accounts see dollar spend.
// Node 20+, no dependencies. Prints no credentials or record contents, only ids and status codes.
// Exit code 0 only when nothing leaked.

import crypto from "node:crypto";
import fs from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const A_EMAIL = process.env.RAKAZO_EMAIL;
const A_PASSWORD = process.env.RAKAZO_PASSWORD;
const B_EMAIL = process.env.RAKAZO_B_EMAIL;
if (!BASE || !A_EMAIL || !A_PASSWORD || !B_EMAIL)
  fail("Set RAKAZO_URL, RAKAZO_EMAIL, RAKAZO_PASSWORD and RAKAZO_B_EMAIL");
const B_PASSWORD =
  process.env.RAKAZO_B_PASSWORD ??
  crypto.createHmac("sha256", A_PASSWORD).update("rakazo-isolation-b").digest("base64url");
const GROUPS = Number(option("--groups", "8"));
const OUT = option("--out", `isolation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const report = {
  base: BASE,
  release: process.env.RAKAZO_RELEASE_SHA ?? null,
  startedAt: new Date().toISOString(),
  accounts: {},
  checks: [],
  leaks: [],
  warnings: [],
  unexercised: [],
  result: "running",
};
function fail(text) {
  process.stderr.write(`${text}\n`);
  process.exit(2);
}
function log(text) {
  process.stdout.write(`${text}\n`);
}
function record(check) {
  report.checks.push(check);
  if (check.verdict === "leak") {
    report.leaks.push(check);
    log(`LEAK  ${check.name}: ${check.detail}`);
  } else if (check.verdict === "warn") {
    report.warnings.push(check);
    log(`warn  ${check.name}: ${check.detail}`);
  }
}

// --- Sessions and RPC ------------------------------------------------------------------------
function session(label) {
  let cookie = "";
  const headers = () => ({
    "content-type": "application/json",
    origin: BASE,
    ...(cookie ? { cookie } : {}),
  });
  async function post(path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    }).catch((error) => ({ ok: false, status: 0, error }));
    const set = response.headers?.getSetCookie?.() ?? [];
    if (set.length) {
      const jar = new Map(cookie ? cookie.split("; ").map((p) => p.split(/=(.*)/s, 2)) : []);
      for (const line of set) {
        const [name, value] = line.split(";")[0].split(/=(.*)/s, 2);
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
      cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const json = response.json ? await response.json().catch(() => null) : null;
    return { status: response.status, body: json };
  }
  return {
    label,
    auth: (path, body) => post(`/api/auth/${path}`, body),
    // Returns { status, data }; never throws, so every refusal is recorded.
    async rpc(path, input) {
      for (let attempt = 0; ; attempt++) {
        const result = await post(`/rpc/${path}`, input === undefined ? {} : { json: input });
        if ((result.status === 0 || result.status >= 502) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          continue;
        }
        return { status: result.status, data: result.body?.json };
      }
    },
  };
}
async function signIn(client, email, password, allowSignup) {
  let result = await client.auth("sign-in/email", { email, password });
  if (result.status === 401 && allowSignup) {
    const created = await client.auth("sign-up/email", { email, password, name: "Isolation test" });
    if (created.status >= 400)
      fail(`${client.label} sign-up refused (${created.status} ${created.body?.code ?? ""})`);
    if (created.body?.token === null)
      fail(`${client.label} created; open the verification email, then run again`);
    result = created;
  }
  if (result.status >= 400)
    fail(`${client.label} sign-in failed (${result.status} ${result.body?.code ?? ""})`);
  const me = await client.rpc("me");
  if (me.status !== 200) fail(`${client.label} me ${me.status}`);
  return me.data;
}

// --- Collecting an account's ids ---------------------------------------------------------------
const ok = (result) => result.status === 200 && result.data !== undefined;

async function collect(client, me, groupLimit) {
  const ids = new Map(); // id -> what it is
  const add = (id, kind) => {
    if (typeof id === "string" && id.length >= 8 && !ids.has(id)) ids.set(id, kind);
  };
  add(me.userId, "user");
  add(me.spaceId, "space");
  const r = {
    userId: me.userId,
    spaceId: me.spaceId,
    email: me.email,
    bots: [],
    groups: [],
    threads: [],
    roles: [],
    candidates: [],
    artifacts: [],
    memory: [],
    routines: [],
    scratchpad: [],
    usage: [],
  };
  const bots = await client.rpc("bots/list");
  for (const bot of ok(bots) ? bots.data : []) {
    r.bots.push(bot.id);
    add(bot.id, "bot");
  }
  const groups = await client.rpc("groups/list");
  const sorted = (ok(groups) ? groups.data : [])
    .filter((group) => !group.archivedAt)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const group of ok(groups) ? groups.data : []) {
    add(group.id, "group");
    add(group.threadId, "thread");
  }
  for (const group of sorted.slice(0, groupLimit)) {
    const head = await client.rpc("threads/head", { groupId: group.id });
    const threadId = ok(head) ? head.data.threadId : group.threadId;
    add(threadId, "thread");
    const entry = { groupId: group.id, threadId, roleId: null, revisionId: null };
    r.groups.push(entry);
    if (threadId) r.threads.push(threadId);
    const workspace = threadId ? await client.rpc("recruiting/getWorkspace", { threadId }) : null;
    if (workspace && ok(workspace) && workspace.data) {
      entry.roleId = workspace.data.role.id;
      entry.revisionId = workspace.data.revision.id;
      r.roles.push(entry.roleId);
      add(entry.roleId, "role");
      add(entry.revisionId, "role revision");
      const people = await client.rpc("recruiting/roleCandidates", {
        groupId: group.id,
        threadId,
        limit: 20,
      });
      for (const item of ok(people) ? people.data.items : []) {
        const key = item.candidateKey ?? item.key;
        if (key) {
          r.candidates.push({ roleId: entry.roleId, threadId, groupId: group.id, key });
          add(key, "candidate");
        }
      }
    }
    const messages = await client.rpc("threads/messages", { groupId: group.id });
    for (const message of ok(messages) ? (messages.data.messages ?? []).slice(-20) : [])
      add(message.id, "message");
  }
  const artifacts = await client.rpc("artifacts/listSpace", { limit: 60 });
  for (const item of ok(artifacts) ? artifacts.data.items : []) {
    r.artifacts.push({ id: item.id, familyId: item.familyId ?? null, botId: item.botId ?? null });
    add(item.id, "artifact");
    add(item.familyId, "artifact family");
  }
  const memory = await client.rpc("memory/list", {});
  for (const doc of ok(memory) ? memory.data : []) {
    r.memory.push(doc.id);
    add(doc.id, "memory");
  }
  for (const botId of r.bots) {
    const routines = await client.rpc("routines/list", { botId });
    for (const routine of ok(routines) ? routines.data : []) {
      r.routines.push(routine.id);
      add(routine.id, "routine");
    }
    const notes = await client.rpc("scratchpad/list", { botId, includeDone: true });
    for (const item of ok(notes) ? notes.data : []) {
      r.scratchpad.push(item.id);
      add(item.id, "scratchpad");
    }
  }
  const usage = await client.rpc("usage/list");
  for (const row of ok(usage) ? usage.data.slice(0, 50) : []) {
    r.usage.push(row.id);
    add(row.id, "usage record");
    add(row.runId, "run");
  }
  const rules = await client.rpc("approvalRules/list");
  for (const rule of ok(rules) ? rules.data : []) add(rule.id, "approval rule");
  const secrets = await client.rpc("agentSecrets/list");
  for (const secret of ok(secrets) ? secrets.data : []) add(secret.id, "agent secret");
  const connections = await client.rpc("connections/list");
  for (const row of ok(connections) ? connections.data : []) add(row.id, "connection");
  return { ids, resources: r };
}

// --- Checks ------------------------------------------------------------------------------------
function foreignIds(data, ids) {
  const text = JSON.stringify(data ?? null);
  const found = [];
  for (const [id, kind] of ids) if (text.includes(id)) found.push(`${kind} ${id}`);
  return found;
}

/** A listing of `viewer`'s own data must not mention any of `owner`'s ids. */
async function listingCheck(viewer, owner, ownerIds, path, input) {
  const result = await viewer.rpc(path, input);
  const name = `${viewer.label} lists ${path}`;
  if (result.status !== 200) {
    record({
      name,
      verdict: result.status >= 500 ? "warn" : "ok",
      status: result.status,
      detail: `status ${result.status}`,
    });
    return result;
  }
  const found = foreignIds(result.data, ownerIds);
  record({
    name,
    verdict: found.length ? "leak" : "ok",
    status: result.status,
    detail: found.length ? `${owner.label}'s ${found.slice(0, 5).join(", ")}` : "no foreign ids",
  });
  return result;
}

/**
 * A read of `owner`'s resource by id, made by `viewer`, must be refused or come back empty. The
 * owner makes the same read first: a read that is empty for the owner too proves nothing and is
 * reported as not exercised instead of passing.
 */
async function probe(viewer, owner, ownerIds, path, input, what) {
  const name = `${viewer.label} reads ${owner.label}'s ${what} via ${path}`;
  const own = await owner.rpc(path, input);
  if (own.status !== 200 || isEmpty(own.data)) {
    report.unexercised.push({ name, ownerStatus: own.status });
    return;
  }
  const result = await viewer.rpc(path, input);
  if (result.status === 200) {
    const found = foreignIds(result.data, ownerIds);
    const empty = isEmpty(result.data);
    record({
      name,
      verdict: found.length || !empty ? "leak" : "ok",
      status: 200,
      detail: found.length
        ? `returned ${found.slice(0, 5).join(", ")}`
        : empty
          ? "empty result"
          : `returned data: ${shape(result.data)}`,
    });
  } else {
    record({
      name,
      verdict: result.status >= 500 || result.status === 0 ? "warn" : "ok",
      status: result.status,
      detail: `refused ${result.status}${result.status >= 500 ? " (should be 403/404)" : ""}`,
    });
  }
}
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object") return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      item === undefined ||
      item === false ||
      item === 0 ||
      (Array.isArray(item) && item.length === 0) ||
      (typeof item === "string" && /^(ok|not_bound|unavailable)$/.test(item)) ||
      (item && typeof item === "object" && !Array.isArray(item) && isEmpty(item)),
  );
}
function shape(value) {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).slice(0, 8).join(",")}}`;
  return typeof value;
}

const LISTINGS = [
  ["bots/list"],
  ["bots/listArchived"],
  ["groups/list"],
  ["groups/listArchived"],
  ["spaces/list"],
  ["artifacts/listSpace", { limit: 60 }],
  ["memory/list", {}],
  ["usage/list"],
  ["usage/summary"],
  ["runs/list", { filter: "recent" }],
  ["runs/list", { filter: "active" }],
  ["approvalRules/list"],
  ["agentSecrets/list"],
  ["connections/list"],
  ["capabilities/list"],
  ["computer/updates"],
  ["recruiting/reminders/list", {}],
];

async function crossReads(viewer, owner, ownerIds, r) {
  for (const botId of r.bots) {
    const target = { botId };
    await probe(viewer, owner, ownerIds, "bots/get", target, "assistant");
    await probe(viewer, owner, ownerIds, "threads/messages", target, "assistant chat");
    await probe(viewer, owner, ownerIds, "threads/get", target, "assistant chat");
    await probe(viewer, owner, ownerIds, "memory/list", { botId }, "assistant memory");
    await probe(viewer, owner, ownerIds, "routines/list", target, "routines");
    await probe(
      viewer,
      owner,
      ownerIds,
      "scratchpad/list",
      { botId, includeDone: true },
      "scratchpad",
    );
    await probe(viewer, owner, ownerIds, "skills/list", target, "taught skills");
    await probe(viewer, owner, ownerIds, "artifacts/list", target, "files");
    await probe(viewer, owner, ownerIds, "artifacts/listSpace", { botId }, "files");
    await probe(viewer, owner, ownerIds, "computer/status", target, "computer");
    await probe(viewer, owner, ownerIds, "computer/files", { botId, path: "/" }, "computer files");
    await probe(viewer, owner, ownerIds, "computer/commands", target, "computer commands");
    await probe(viewer, owner, ownerIds, "botSecrets/list", target, "assistant secrets");
    await probe(viewer, owner, ownerIds, "export/bot", target, "assistant export");
    await probe(viewer, owner, ownerIds, "mcp/list", target, "connectors");
  }
  for (const group of r.groups) {
    const target = { groupId: group.groupId };
    await probe(viewer, owner, ownerIds, "groups/get", target, "role chat");
    await probe(viewer, owner, ownerIds, "threads/head", target, "role chat");
    await probe(viewer, owner, ownerIds, "threads/get", target, "role chat");
    await probe(viewer, owner, ownerIds, "threads/messages", target, "role chat messages");
    await probe(viewer, owner, ownerIds, "recruiting/roleSetup", target, "role setup");
    await probe(viewer, owner, ownerIds, "recruiting/calibrationRound", target, "first ten");
    for (const view of ["inbox", "interview", "contacts"])
      await probe(
        viewer,
        owner,
        ownerIds,
        "recruiting/correspondence",
        { ...target, view },
        `${view}`,
      );
    await probe(viewer, owner, ownerIds, "recruiting/roleCampaign", target, "campaign");
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/crmData",
      { ...target, operation: "memberships" },
      "CRM link",
    );
    if (group.threadId) {
      await probe(
        viewer,
        owner,
        ownerIds,
        "recruiting/roleCandidates",
        { ...target, threadId: group.threadId, limit: 5 },
        "candidates",
      );
      await probe(
        viewer,
        owner,
        ownerIds,
        "recruiting/getWorkspace",
        { threadId: group.threadId },
        "role",
      );
      await probe(
        viewer,
        owner,
        ownerIds,
        "recruiting/schedulingPlans",
        { threadId: group.threadId },
        "interview plans",
      );
    }
    // The same chat named under the viewer's own group: the server must resolve by id, not trust it.
    if (group.threadId && viewer.ownGroupId)
      await probe(
        viewer,
        owner,
        ownerIds,
        "recruiting/roleCandidates",
        { groupId: viewer.ownGroupId, threadId: group.threadId, limit: 5 },
        "candidates through own chat",
      );
    if (group.roleId) {
      const roleId = group.roleId;
      await probe(
        viewer,
        owner,
        ownerIds,
        "recruiting/listCandidates",
        { roleId, limit: 5 },
        "candidates",
      );
      await probe(viewer, owner, ownerIds, "recruiting/listFeedback", { roleId }, "feedback");
      await probe(viewer, owner, ownerIds, "recruiting/listAssessments", { roleId }, "assessments");
      await probe(viewer, owner, ownerIds, "recruiting/listResearch", { roleId }, "research");
      await probe(viewer, owner, ownerIds, "recruiting/reminders/list", { roleId }, "reminders");
      if (group.threadId)
        await probe(
          viewer,
          owner,
          ownerIds,
          "recruiting/listQuestions",
          { threadId: group.threadId, roleId },
          "questions",
        );
    }
  }
  for (const person of r.candidates.slice(0, 10)) {
    const { roleId, key } = person;
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/getAssessment",
      { roleId, candidateKey: key },
      "assessment",
    );
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/listCandidateSources",
      { roleId, candidateKey: key },
      "candidate sources",
    );
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/profileActivity/list",
      { roleId, candidateKey: key },
      "profile activity",
    );
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/listFeedback",
      { roleId, candidateKey: key },
      "candidate feedback",
    );
    // Keys alone (no role) are matched against the viewer's own records only.
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/notes/list",
      { candidateKeys: [key] },
      "candidate notes",
    );
    await probe(
      viewer,
      owner,
      ownerIds,
      "recruiting/reminders/list",
      { candidateKey: key },
      "candidate reminders",
    );
  }
  for (const artifact of r.artifacts.slice(0, 10)) {
    await probe(viewer, owner, ownerIds, "artifacts/getById", { artifactId: artifact.id }, "file");
    if (artifact.familyId)
      await probe(
        viewer,
        owner,
        ownerIds,
        "artifacts/listVersions",
        { familyId: artifact.familyId },
        "file versions",
      );
  }
  for (const documentId of r.memory.slice(0, 10))
    await probe(viewer, owner, ownerIds, "memory/history", { documentId }, "memory history");
  for (const routineId of r.routines.slice(0, 10))
    await probe(viewer, owner, ownerIds, "routines/history", { routineId }, "routine history");
}

/** Who sees money: verified mailboxes at the operator's domain see every account's spend. */
const OPERATOR_DOMAIN = (process.env.RAKAZO_OPERATOR_DOMAIN ?? "wekruit.com").toLowerCase();
const isStaff = (email) => String(email).toLowerCase().endsWith(`@${OPERATOR_DOMAIN}`);

async function spendView(client, me, otherUserId) {
  const costs = await client.rpc("usage/costs");
  if (!ok(costs)) {
    record({
      name: `${client.label} usage/costs`,
      verdict: "warn",
      status: costs.status,
      detail: `status ${costs.status}`,
    });
    return;
  }
  const money = /"estimatedUsd":\s*[0-9]/.test(JSON.stringify(costs.data));
  const accounts = costs.data.accounts ?? null;
  if (isStaff(me.email)) {
    const complete = money && Array.isArray(costs.data.services) && Array.isArray(accounts);
    record({
      name: `${client.label} (operator staff) usage shows money and every account`,
      verdict: complete && accounts.some((row) => row.userId === otherUserId) ? "ok" : "warn",
      detail: complete
        ? `${accounts.length} accounts`
        : "staff view missing estimatedUsd, services or accounts",
    });
  } else {
    record({
      name: `${client.label} (customer) usage shows only its own credits`,
      verdict: money || accounts || costs.data.services ? "leak" : "ok",
      detail: accounts
        ? `accounts list with ${accounts.length} rows`
        : money
          ? "dollar amounts present"
          : costs.data.services
            ? "service names present"
            : "credits only",
    });
  }
}

/** What a fresh account must not see even from its own crew: someone else's CRM, mailbox or settings. */
async function newAccountScope(b, bResources) {
  const deployment = await b.rpc("deployment/get");
  record({
    name: "B cannot read deployment settings",
    verdict: deployment.status === 200 && deployment.data?.signupAllowlist?.length ? "leak" : "ok",
    status: deployment.status,
    detail: deployment.status === 200 ? "readable" : `refused ${deployment.status}`,
  });
  const group = bResources.groups[0];
  if (!group) return;
  const target = { groupId: group.groupId };
  const crm = await b.rpc("recruiting/crmData", { ...target, operation: "memberships" });
  const organizations = ok(crm)
    ? (crm.data.sources ?? []).flatMap((source) => source.memberships ?? [])
    : [];
  record({
    name: "B's own chat reaches no CRM organization it was not added to",
    verdict: organizations.length ? "leak" : "ok",
    status: crm.status,
    detail: organizations.length
      ? `${organizations.length} organizations visible`
      : `status ${crm.status}, none`,
  });
  for (const view of ["inbox", "contacts", "interview"]) {
    const mail = await b.rpc("recruiting/correspondence", { ...target, view });
    // `connections` lists the account's own mail connections; only messages and people count.
    const rows = ok(mail)
      ? ["emails", "events", "contacts"].reduce(
          (sum, key) => sum + (mail.data[key]?.length ?? 0),
          0,
        )
      : 0;
    record({
      name: `B's own ${view} holds no one else's mail`,
      verdict: rows ? "leak" : "ok",
      status: mail.status,
      detail: rows ? `${rows} rows in a new account` : `status ${mail.status}, empty`,
    });
  }
}

async function anonymous(paths) {
  const anon = session("anonymous");
  for (const [path, input] of paths) {
    const result = await anon.rpc(path, input);
    record({
      name: `no session ${path}`,
      verdict: result.status === 200 ? "leak" : "ok",
      status: result.status,
      detail: `status ${result.status}`,
    });
  }
}

// --- Run ---------------------------------------------------------------------------------------
const a = session("A");
const b = session("B");
const meA = await signIn(a, A_EMAIL, A_PASSWORD, false);
const meB = await signIn(b, B_EMAIL, B_PASSWORD, true);
if (meA.userId === meB.userId || meA.spaceId === meB.spaceId)
  fail("A and B are the same account or share a workspace; pick two separate accounts");
const crew = await b.rpc("onboarding/ensureRecruiting", {});
if (ok(crew)) b.ownGroupId = crew.data.groupId;
const ensured = await a.rpc("groups/list");
a.ownGroupId = ok(ensured) ? ensured.data.find((group) => !group.archivedAt)?.id : undefined;

const collectedA = await collect(a, meA, GROUPS);
const collectedB = await collect(b, meB, GROUPS);
report.accounts = {
  A: { owner: meA.isDeploymentOwner, counts: counts(collectedA.resources) },
  B: { owner: meB.isDeploymentOwner, counts: counts(collectedB.resources) },
};
log(`A: ${JSON.stringify(report.accounts.A.counts)}`);
log(`B: ${JSON.stringify(report.accounts.B.counts)}`);
// B's own ids must not count as A's when B's listings echo them.
for (const id of collectedB.ids.keys()) collectedA.ids.delete(id);
for (const id of collectedA.ids.keys()) collectedB.ids.delete(id);

for (const [path, input] of LISTINGS) await listingCheck(b, a, collectedA.ids, path, input);
// Search B's workspace for words from A's chats.
const titles = (await a.rpc("groups/list")).data ?? [];
for (const title of titles
  .slice(0, 5)
  .map((group) => group.name)
  .filter(Boolean))
  await listingCheck(b, a, collectedA.ids, "search/query", { q: title.slice(0, 40) });
await crossReads(b, a, collectedA.ids, collectedA.resources);
await newAccountScope(b, collectedB.resources);
await spendView(b, meB, meA.userId);
await spendView(a, meA, meB.userId);
if (isStaff(meB.email))
  report.warnings.push({
    name: "customer spend view not covered",
    detail: `B is at @${OPERATOR_DOMAIN}; use a B outside that domain to check the customer view`,
  });

// Reverse direction: the deployment owner is still one account and must not open B's work.
for (const [path, input] of LISTINGS.filter(([path]) => !path.startsWith("usage/")))
  await listingCheck(a, b, collectedB.ids, path, input);
await crossReads(a, b, collectedB.ids, collectedB.resources);

await anonymous(LISTINGS);

report.result = report.leaks.length ? "leak" : "isolated";
report.finishedAt = new Date().toISOString();
report.summary = {
  checks: report.checks.length,
  leaks: report.leaks.length,
  warnings: report.warnings.length,
  unexercised: report.unexercised.length,
};
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
log(
  `${report.result}: ${report.checks.length} checks, ${report.leaks.length} leaks, ${report.warnings.length} warnings, ${report.unexercised.length} reads empty for the owner too → ${OUT}`,
);
process.exit(report.leaks.length ? 1 : 0);

function counts(r) {
  return Object.fromEntries(
    Object.entries(r)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length]),
  );
}
