#!/usr/bin/env node
// Headless find-10 / find-100 latency run against a live deployment, through the same RPC the web
// app calls. It signs in as a dedicated test account, starts a new role from a JD, answers the
// questions neutrally, confirms the brief, waits for the first ten, sends the scale-out request and
// waits for 100 people. It never approves a send: outreach cards are recorded and left alone.
//
// Usage:
//   RAKAZO_URL=https://… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… node infra/acceptance/recruiting-latency.mjs
//   Options: --jd <file> | --jd-text <text>   role description (default: a built-in test role)
//            --jd-url <url>                   start the role from a job link, as a recruiter pastes one
//            --group <id>                     measure an existing role chat instead of starting one
//            --scale-now                      with --group: send the scale-out request right away
//            --skip-scale                     stop after the first ten
//            --feedback [text]                after the first ten, give feedback on two of them and
//                                             wait for the next round before scaling ("auto" or no
//                                             text uses a built-in comment naming the first two)
//            --target <n>                     scale target (default 100)
//            --timeout-min <n>                overall limit (default 60)
//            --out <file>                     JSON report path (default ./latency-<time>.json)
//            --area <regex>                   locations the role accepts; others are flagged
//            --hiring-company <name>          flag people who work there now
//            --archive                        archive the test role when the run ends
//   RAKAZO_TOKEN may replace email/password (a session token sent as a bearer credential).
//   --signup creates the test account on first use (the deployment's signup policy applies).
//   RAKAZO_RELEASE_SHA labels the report with the live release.
// Node 20+, no dependencies. Prints no credentials.

import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
if (!BASE) fail("Set RAKAZO_URL");
const TARGET = Number(option("--target", "100"));
const TIMEOUT_MS = Number(option("--timeout-min", "60")) * 60_000;
const POLL_MS = 2_000;
const SCALE_TEXT = `这 10 个方向可以，找 ${TARGET} 个类似的人`;
const FEEDBACK_RAW = flag("--feedback") ? option("--feedback", "auto") : null;
const FEEDBACK = FEEDBACK_RAW?.startsWith("--") ? "auto" : FEEDBACK_RAW;
const feedbackText = (round) => {
  if (FEEDBACK !== "auto") return FEEDBACK;
  const [first, second] = round.candidates.map((c) => c.name).filter(Boolean);
  return `${first} 和 ${second} 不太合适，他们没有直接带过现场小时工团队。多找在仓库或配送中心直接管过 50 人以上一线团队的人，其他人的方向可以。`;
};
const DEFAULT_JD =
  "新岗位：仓库运营经理（亚特兰大 Atlanta，现场办公）。要求：5年以上仓储或配送中心运营管理，带过50人以上的小时工团队，熟悉WMS和KPI管理。加分：会中文、电商或第三方物流背景。排除：猎头、学生。";
const JD = option("--jd-url")
  ? `新岗位：${option("--jd-url")}`
  : option("--jd")
    ? fs.readFileSync(option("--jd"), "utf8").trim()
    : option("--jd-text", DEFAULT_JD);
const OUT = option("--out", `latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const AREA = option("--area") ? new RegExp(option("--area"), "i") : null;
const HIRING_COMPANY = option("--hiring-company")?.toLowerCase() ?? null;
// Names a recruiter must never see. Matched case-insensitively on whole words.
const VENDORS = [
  "autumn",
  "exa",
  "coresignal",
  "juicebox",
  "instantly",
  "composio",
  "serper",
  "tavily",
  "apollo",
  "openai",
  "codex",
];
const vendorPattern = new RegExp(`\\b(${VENDORS.join("|")})\\b`, "i");

const started = Date.now();
const report = {
  base: BASE,
  startedAt: new Date(started).toISOString(),
  version: null,
  groupId: null,
  jd: JD,
  milestones: {},
  rounds: [],
  cards: [],
  violations: [],
  candidateTotals: [],
  result: "running",
};
const elapsed = () => Math.round((Date.now() - started) / 100) / 10;
function mark(name, extra) {
  if (report.milestones[name]) return;
  report.milestones[name] = { at: new Date().toISOString(), s: elapsed(), ...extra };
  log(`${name}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
}
function violation(kind, detail) {
  const key = `${kind}:${detail}`;
  if (report.violations.some((item) => `${item.kind}:${item.detail}` === key)) return;
  report.violations.push({ kind, detail, s: elapsed() });
  log(`VIOLATION ${kind}: ${detail}`);
}
function log(text) {
  process.stdout.write(`[${elapsed().toFixed(1).padStart(7)}s] ${text}\n`);
}
function fail(text) {
  process.stderr.write(`${text}\n`);
  process.exit(2);
}
function save() {
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Session and RPC -------------------------------------------------------------------------
let cookie = "";
const bearer = process.env.RAKAZO_TOKEN;
function remember(response) {
  const set = response.headers.getSetCookie?.() ?? [];
  const jar = new Map(cookie ? cookie.split("; ").map((pair) => pair.split(/=(.*)/s, 2)) : []);
  for (const line of set) {
    const [pair] = line.split(";");
    const [name, value] = pair.split(/=(.*)/s, 2);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
function headers() {
  const result = { "content-type": "application/json", origin: BASE };
  if (cookie) result.cookie = cookie;
  else if (bearer) result.authorization = `Bearer ${bearer}`;
  return result;
}
async function auth(path, body) {
  const response = await fetch(`${BASE}/api/auth/${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  remember(response);
  return { status: response.status, body: await response.json().catch(() => null) };
}
async function signIn() {
  if (bearer && !process.env.RAKAZO_EMAIL) return;
  const email = process.env.RAKAZO_EMAIL;
  const password = process.env.RAKAZO_PASSWORD;
  if (!email || !password) fail("Set RAKAZO_EMAIL and RAKAZO_PASSWORD, or RAKAZO_TOKEN");
  let result = await auth("sign-in/email", { email, password });
  if (result.status === 401 && flag("--signup")) {
    // First run for a dedicated test account. Signup policy (allowlist, mailbox proof) still applies.
    const created = await auth("sign-up/email", { email, password, name: "Latency test" });
    if (created.status >= 400)
      fail(
        `Sign-up failed (${created.status}): ${created.body?.code ?? created.body?.message ?? ""}`,
      );
    if (created.body?.token === null)
      fail("Account created; open the verification email, then run again without --signup");
    result = created;
  }
  if (result.status >= 400)
    fail(`Sign-in failed (${result.status}): ${result.body?.code ?? result.body?.message ?? ""}`);
}
async function rpc(path, input, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${BASE}/rpc/${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    }).catch((error) => ({ ok: false, status: 0, error }));
    if (response.ok) return (await response.json()).json;
    const body = response.json ? await response.json().catch(() => null) : null;
    const transient = response.status === 0 || response.status >= 500;
    if (transient && attempt < retries) {
      await sleep(1_000 * (attempt + 1));
      continue;
    }
    const message = body?.json?.message ?? response.error?.message ?? "";
    throw new Error(`${path} ${response.status} ${message}`.trim());
  }
}

// --- Thread reading --------------------------------------------------------------------------
const handled = new Set();
const seenText = new Set();
let messages = [];
async function readMessages(groupId) {
  const page = await rpc("threads/messages", { groupId });
  messages = page.messages.filter((message) => !message.internal);
  return messages;
}
function botText() {
  return messages
    .filter((message) => message.role !== "user")
    .flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.kind === "text"
          ? [block.text]
          : block.kind === "ask"
            ? [block.text, block.detail ?? "", ...(block.actions ?? []).map((a) => a.label)]
            : block.kind === "card"
              ? block.lines.map((line) => `${line.k} ${line.v}`)
              : block.kind === "choice"
                ? [block.question, ...block.options.map((o) => o.label)]
                : [],
      ),
    )
    .join("\n");
}
function scanText() {
  for (const message of messages) {
    if (message.role === "user" || seenText.has(message.id)) continue;
    seenText.add(message.id);
    if (/Source unavailable|来源不可用/i.test(JSON.stringify(message.blocks)))
      violation("source_unavailable_chip", message.id);
    for (const block of message.blocks) {
      const text =
        block.kind === "text"
          ? block.text
          : block.kind === "ask"
            ? `${block.text}\n${block.detail ?? ""}`
            : "";
      const hit = text.match(vendorPattern);
      if (hit) violation("vendor_name", `${hit[1]} in “${excerpt(text, hit.index)}”`);
    }
  }
}
function excerpt(text, index = 0) {
  return text
    .slice(Math.max(0, index - 30), index + 50)
    .replace(/\s+/g, " ")
    .trim();
}
function pendingAsks() {
  return messages.flatMap((message) =>
    message.blocks
      .filter((block) => block.kind === "ask" && block.status !== "answered")
      .map((block) => ({ message, block })),
  );
}

// Neutral answers: what a recruiter with no extra preferences would say.
function formAnswer(schema) {
  const content = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    if (field.enum) content[name] = field.enum[0];
    else if (field.oneOf) content[name] = field.oneOf[0].const;
    else if (field.type === "boolean") content[name] = false;
    else if (field.type === "number" || field.type === "integer")
      content[name] = field.minimum ?? 0;
    else if (field.type === "array")
      content[name] = field.items?.enum?.slice(0, 1) ?? [field.items?.anyOf?.[0]?.const];
    else content[name] = "没有特别要求，按 JD 来";
  }
  return { action: "accept", content };
}
const NEUTRAL_CHOICE =
  /(按 ?JD|都可以|不限|优先|不作要求|不要求|没有|无所谓|default|any|either|按你|你来定|保持)/i;
const CONFIRM_CHOICE = /(确认|开始|可以|没问题|对|是|继续|confirm|start|yes|ok)/i;
const DEFER_CHOICE = /(稍后|以后|先不|跳过|暂不|later|skip|not now)/i;

async function answer(groupId, { message, block }, value, label) {
  const key = `${message.id}:${block.text}`;
  if (handled.has(key)) return;
  handled.add(key);
  await rpc("threads/answer", {
    groupId,
    runId: message.runId,
    messageId: message.id,
    answer: value,
  });
  report.cards.push({ s: elapsed(), text: block.text.slice(0, 160), answered: label });
  log(`answered “${block.text.slice(0, 60)}” → ${label}`);
}

/** Answers what a recruiter answers before the first ten; returns true while the run waits on a card it leaves alone. */
async function handleCards(groupId, phase) {
  let waitingOnUntouched = false;
  for (const ask of pendingAsks()) {
    const { message, block } = ask;
    const key = `${message.id}:${block.text}`;
    if (handled.has(key)) continue;
    const labels = (block.actions ?? []).map((action) => action.label).join(" / ");
    if (block.connection) {
      handled.add(key);
      violation("connect_card", block.connection.name);
      waitingOnUntouched = true;
      continue;
    }
    if (block.input === "secret") {
      handled.add(key);
      violation("secret_card", block.text.slice(0, 80));
      waitingOnUntouched = true;
      continue;
    }
    if (block.approvalEffectId) {
      const label = block.actions?.find((action) => action.id === "allow")?.label ?? "";
      if (
        /confirm requirements|确认要求|确认需求/i.test(label) ||
        /brief|岗位要求/i.test(block.text)
      ) {
        mark("brief_card_shown");
        await answer(groupId, ask, "allow", label || "allow");
        mark("brief_confirmed");
        continue;
      }
      if (/approve documents|材料|文件/i.test(`${label} ${block.text}`)) {
        await answer(groupId, ask, "deny", "deny (documents deferred)");
        continue;
      }
      handled.add(key);
      if (/confirm and send|确认发送/i.test(label)) {
        report.cards.push({
          s: elapsed(),
          text: block.text.slice(0, 160),
          answered: "left (send)",
        });
        log(`send card left unanswered: ${block.text.slice(0, 60)}`);
      } else violation("approval_card", `${label}: ${block.text.slice(0, 100)}`);
      waitingOnUntouched = true;
      continue;
    }
    if (block.requestedSchema) {
      mark("first_question");
      await answer(groupId, ask, formAnswer(block.requestedSchema), "form (neutral)");
      continue;
    }
    if (block.actions?.length) {
      if (phase !== "intake") {
        // After the first ten the next step is the scale-out message, not a card click.
        handled.add(key);
        report.cards.push({
          s: elapsed(),
          text: block.text.slice(0, 160),
          answered: `left (${labels})`,
        });
        waitingOnUntouched = true;
        continue;
      }
      mark("first_question");
      const brief = block.actions.find((action) =>
        /开始找人|confirm requirements/i.test(action.label),
      );
      if (brief) {
        mark("brief_card_shown", { title: block.text.slice(0, 40), buttons: labels });
        const go =
          brief ??
          block.actions.find((action) => CONFIRM_CHOICE.test(action.label)) ??
          block.actions[0];
        await answer(groupId, ask, go.id, go.label);
        mark("brief_confirmed");
        continue;
      }
      const pick =
        block.actions.find(
          (action) => DEFER_CHOICE.test(action.label) && /材料|文件|document/i.test(block.text),
        ) ??
        block.actions.find((action) => NEUTRAL_CHOICE.test(action.label)) ??
        block.actions.find((action) => CONFIRM_CHOICE.test(action.label)) ??
        block.actions[0];
      await answer(groupId, ask, pick.id, pick.label);
      continue;
    }
    // Free-text question.
    mark("first_question");
    await answer(groupId, ask, "没有特别要求，按 JD 来", "text (neutral)");
  }
  return waitingOnUntouched;
}

// --- Rounds and people -----------------------------------------------------------------------
const roundKeys = new Map();
async function readRound(groupId) {
  const result = await rpc("recruiting/calibrationRound", { groupId }).catch(() => null);
  const round = result?.round;
  if (!round || roundKeys.has(round.round)) return round ?? null;
  const keys = round.candidates.map((candidate) => candidate.candidateKey);
  const earlier = [...roundKeys.values()].flat();
  const repeats = keys.filter((key) => earlier.includes(key));
  roundKeys.set(round.round, keys);
  report.rounds.push({
    round: round.round,
    s: elapsed(),
    createdAt: round.createdAt,
    approvedAt: round.approvedAt,
    count: keys.length,
    repeats: repeats.length,
    ...placeQuality(round.candidates),
    people: round.candidates.map((c) =>
      [c.name, c.title, c.company, c.location].filter(Boolean).join(" · "),
    ),
  });
  log(
    `round ${round.round}: ${keys.length} people, ${repeats.length} repeated from earlier rounds`,
  );
  if (repeats.length) violation("repeated_people", `round ${round.round}: ${repeats.length}`);
  return round;
}
async function sendScale(groupId, threadId) {
  const before = threadId ? await readTotal(threadId) : null;
  report.candidateTotals.push({ s: elapsed(), total: before });
  log(`role has ${before} people before the scale-out request`);
  // Let the previous turn settle so the request is its own user message.
  await sleep(3_000);
  await rpc("threads/send", { groupId, text: SCALE_TEXT });
  mark("scale_sent", { before });
  return "scale";
}
function placeQuality(people) {
  const outside = AREA ? people.filter((p) => !AREA.test(p.location ?? "")) : [];
  const staff = HIRING_COMPANY
    ? people.filter((p) => (p.company ?? "").toLowerCase().includes(HIRING_COMPANY))
    : [];
  return {
    ...(AREA
      ? { outsideArea: outside.map((p) => `${p.name} · ${p.location || "no location"}`) }
      : {}),
    ...(HIRING_COMPANY ? { hiringCompanyStaff: staff.map((p) => `${p.name} · ${p.company}`) } : {}),
  };
}
// Reads the whole role list once and checks that every person appears once, by LinkedIn profile.
async function checkPool(threadId) {
  const rows = [];
  let cursor;
  do {
    const page = await rpc("recruiting/roleCandidates", {
      groupId: report.groupId,
      threadId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && rows.length < 2_000);
  const identity = (url) =>
    /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url ?? "")?.[1]?.toLowerCase() ?? null;
  const byProfile = new Map();
  for (const row of rows) {
    const key = identity(row.linkedinUrl);
    if (key) byProfile.set(key, [...(byProfile.get(key) ?? []), row.name]);
  }
  const duplicates = [...byProfile].filter(([, names]) => names.length > 1);
  const outside = AREA ? rows.filter((row) => !AREA.test(row.location ?? "")) : [];
  report.pool = {
    total: rows.length,
    withProfile: [...byProfile.values()].flat().length,
    uniqueProfiles: byProfile.size,
    duplicates: duplicates.map(([key, names]) => `${names.join(" / ")} · in/${key}`),
    ...(AREA
      ? {
          inArea: rows.length - outside.length,
          outsideArea: outside.map((row) => `${row.name} · ${row.location || "no location"}`),
        }
      : {}),
  };
  for (const item of report.pool.duplicates) violation("duplicate_person", item);
  if (AREA && report.pool.inArea < TARGET)
    violation("too_few_in_area", `${report.pool.inArea} of ${rows.length} in the role's area`);
  log(
    `pool: ${rows.length} people, ${byProfile.size} unique profiles, ${duplicates.length} duplicated${AREA ? `, ${rows.length - outside.length} in area` : ""}`,
  );
}
async function readTotal(threadId) {
  const result = await rpc("recruiting/roleCandidates", {
    groupId: report.groupId,
    threadId,
    limit: 1,
  }).catch(() => null);
  return result?.total ?? null;
}
function namesListedInChat(round) {
  const text = botText();
  const names = round.candidates.map((c) => c.name).filter(Boolean);
  return { listed: names.filter((name) => text.includes(name)).length, of: names.length };
}

// --- Run -------------------------------------------------------------------------------------
// --- Save failures ---------------------------------------------------------------------------
// Replays the chat's native events and fails the run on any recruiting tool error the agent did not
// recover from with a later successful call of the same tool, and on any error that reads
// as an outage. Counts every error class either way, so recovered retries still show up.
const CHECKED_TOOLS = /^(recruiting_|artifact_read$)/;
async function readEvents(groupId) {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), 15_000);
  const events = [];
  try {
    const response = await fetch(`${BASE}/rpc/threads/subscribe`, {
      method: "POST",
      headers: { ...headers(), accept: "text/event-stream" },
      body: JSON.stringify({ json: { groupId, cursor: 0 } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`threads/subscribe ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // The replay arrives at once; a quiet stream means it has caught up with live events.
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 3_000);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5));
          events.push(data.json ?? data);
        } catch {}
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(idle);
  }
  return events;
}
// Fixable rejections end with "This is not an outage: never tell the recruiter that saving is unavailable."
const outage = (error) => /unavailable/i.test(error.replace(/This is not an outage.*$/s, ""));
function errorClass(error) {
  if (/not an outage|could not be read/.test(error)) return error.split(/[.:]/)[0].slice(0, 80);
  if (outage(error)) return "unavailable";
  if (/Validation failed|expected|Invalid/i.test(error)) return "schema";
  return error.slice(0, 80);
}
function checkToolErrors(events) {
  const done = events.filter(
    (event) =>
      event.type === "agent.tool.completed" && CHECKED_TOOLS.test(event.payload?.name ?? ""),
  );
  const errors = [];
  done.forEach((event, index) => {
    const { name, outcome, error = "" } = event.payload;
    if (outcome !== "error") return;
    // A retry in the same run or in the follow-up run the server starts both count as recovery.
    const recovered = done
      .slice(index + 1)
      .some((later) => later.payload.name === name && later.payload.outcome !== "error");
    errors.push({
      at: event.createdAt,
      name,
      class: errorClass(error),
      recovered,
      error: error.slice(0, 300),
    });
    if (outage(error)) violation("tool_outage_error", `${name}: ${error.slice(0, 120)}`);
    else if (!recovered) violation("tool_error_unrecovered", `${name}: ${error.slice(0, 120)}`);
  });
  const counts = {};
  for (const item of errors)
    counts[`${item.name} ${item.class}`] = (counts[`${item.name} ${item.class}`] ?? 0) + 1;
  // Every tool, including connector discovery: the error rate a release is compared on.
  const all = { calls: 0, errors: 0, byTool: {}, items: [] };
  for (const event of events) {
    if (event.type !== "agent.tool.completed" || event.payload?.outcome === "paused") continue;
    all.byTool[event.payload.name] ??= { calls: 0, errors: 0 };
    const tool = all.byTool[event.payload.name];
    tool.calls += 1;
    all.calls += 1;
    if (event.payload.outcome !== "error") continue;
    tool.errors += 1;
    all.errors += 1;
    all.items.push({
      at: event.createdAt,
      name: event.payload.name,
      error: String(event.payload.error ?? "").slice(0, 300),
    });
  }
  report.toolErrors = { calls: done.length, errors: errors.length, counts, items: errors, all };
  log(`recruiting tool calls ${done.length}, errors ${errors.length} ${JSON.stringify(counts)}`);
  log(`all tool calls ${all.calls}, errors ${all.errors}`);
}

// --- First ten, timed by the server ----------------------------------------------------------
// Uses the chat's own event times, so polling does not blur the numbers. Times count from the
// recruiter's last answer before the round (or from the JD when nothing was asked).
const US_STATES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming";
const REGION_ONLY = new RegExp(
  `^\\s*((${US_STATES})(,\\s*(united states|usa|us))?|united states|usa|us)\\s*$`,
  "i",
);
const SEARCH_TOOL = /search/i;
const NOT_A_PEOPLE_SEARCH = /^(connectors_search_tools|recruiting_)/;
function blockText(blocks = []) {
  return blocks
    .map((block) => (block.kind === "text" ? block.text : block.kind === "ask" ? block.text : ""))
    .join("\n");
}
function measureFirstTen(events, round) {
  const at = (event) => Date.parse(event.createdAt);
  const seconds = (from, to) =>
    from != null && to != null ? Math.round((to - from) / 100) / 10 : null;
  const jd = messages.find((message) => message.role === "user");
  const jdAt = jd ? Date.parse(jd.createdAt) : null;
  const roundAt = events
    .filter((e) => e.type === "effect.recorded" && e.payload?.round === round.round)
    .map(at)[0];
  const users = events.filter(
    (e) =>
      e.type === "thread.message.created" &&
      e.payload?.role === "user" &&
      e.payload.messageId !== jd?.id &&
      at(e) > jdAt &&
      at(e) < roundAt,
  );
  const answerAt = users.length ? at(users.at(-1)) : jdAt;
  // Time the recruiter waited before the agent even started, separate from the agent's own time.
  const runStart = events.find((e) => e.type === "run.started" && at(e) >= answerAt);
  const bot = events.filter(
    (e) => /^thread\.message\.(created|updated)$/.test(e.type) && e.payload?.role === "bot",
  );
  const asks = bot.filter(
    (e) => e.type === "thread.message.created" && e.payload.blocks?.some((b) => b.kind === "ask"),
  );
  const names = round.candidates.map((c) => c.name).filter(Boolean);
  const shownAt = (count) =>
    bot
      .filter((e) => at(e) > answerAt)
      .find((e) => {
        const text = blockText(e.payload.blocks);
        return names.filter((name) => text.includes(name)).length >= count;
      });
  const firstShown = shownAt(1);
  const allShown = shownAt(names.length);
  const allTenAt = allShown ? Math.max(at(allShown), roundAt) : null;
  const cardAfter = asks.find((e) => at(e) > answerAt);
  const planned = events.filter(
    (e) => e.type === "recruiting.searches.planned" && at(e) <= answerAt,
  );
  const afterAnswer = (e) => at(e) > answerAt && at(e) <= roundAt;
  const searchesRun = events.filter(
    (e) =>
      e.type === "effect.recorded" && e.payload?.source?.kind === "people_search" && afterAnswer(e),
  ).length;
  const modelSearches = events.filter(
    (e) =>
      e.type === "agent.tool.called" &&
      SEARCH_TOOL.test(e.payload?.name ?? "") &&
      !NOT_A_PEOPLE_SEARCH.test(e.payload.name) &&
      afterAnswer(e),
  ).length;
  const people = round.candidates.map((c) => ({
    name: c.name,
    company: c.company ?? "",
    location: c.location ?? "",
  }));
  const regionOnly = people.filter((p) => !p.location || REGION_ONLY.test(p.location));
  const outsideArea = AREA ? people.filter((p) => !AREA.test(p.location)) : [];
  const hiringStaff = HIRING_COMPANY
    ? people.filter((p) => p.company.toLowerCase().includes(HIRING_COMPANY))
    : [];
  const result = {
    from: users.length ? "last_answer" : "jd",
    questions: asks.filter((e) => at(e) < roundAt).length,
    firstQuestionS: seconds(jdAt, asks[0] && at(asks[0]) < roundAt ? at(asks[0]) : null),
    firstPeopleInChatS: seconds(answerAt, firstShown && at(firstShown)),
    tenRecordedS: seconds(answerAt, roundAt),
    allTenS: seconds(answerAt, allTenAt),
    runStartWaitS: seconds(answerAt, runStart && at(runStart)),
    plannedSearches: planned.at(-1)?.payload?.queries?.length ?? 0,
    searchesAfterAnswer: searchesRun,
    modelSearchesAfterAnswer: modelSearches,
    tenRecordedBeforeCard: !cardAfter || roundAt <= at(cardAfter),
    people: people.length,
    inArea: AREA ? people.length - outsideArea.length : null,
    regionOnly: regionOnly.map((p) => `${p.name} · ${p.location || "no location"}`),
    outsideArea: outsideArea.map((p) => `${p.name} · ${p.location}`),
    hiringCompanyStaff: hiringStaff.map((p) => `${p.name} · ${p.company}`),
  };
  if (!allShown) violation("ten_not_in_chat", `${names.length} names never all in chat`);
  if (!result.tenRecordedBeforeCard) violation("card_before_ten", "next-step card came first");
  if (result.questions && !result.plannedSearches)
    violation("no_planned_searches", "the last question carried no planned searches");
  if (result.plannedSearches && result.modelSearchesAfterAnswer)
    violation("searched_again", `${result.modelSearchesAfterAnswer} searches after planned rows`);
  for (const item of result.regionOnly) violation("region_only_location", item);
  for (const item of result.outsideArea) violation("outside_area", item);
  for (const item of result.hiringCompanyStaff) violation("hiring_company_staff", item);
  report.first10 = result;
  log(
    `first ten: Q1 ${result.firstQuestionS}s, first people ${result.firstPeopleInChatS}s, all ten ${result.allTenS}s (from ${result.from})`,
  );
}

const TEST_MARK = "测试副本 · ";

async function main() {
  await signIn();
  // The API does not publish its source revision; the runner passes the released SHA.
  report.version = process.env.RAKAZO_RELEASE_SHA ?? null;
  await rpc("me");
  log(`signed in; release ${report.version ?? "unknown"}`);
  // Bootstrap provisions the recruiting crew for a fresh account, as the web app does.
  await rpc("bootstrap", {});

  let groupId = option("--group");
  if (!groupId) {
    // The account's recruiting crew, provisioned on first use exactly as the web onboarding does.
    const workspace = await rpc("onboarding/ensureRecruiting", {});
    const home = await rpc("groups/get", { groupId: workspace.groupId });
    const crew = home.members.map((member) => member.botId);
    if (!crew.includes(workspace.botId)) fail("No recruiting crew on this account");
    const group = await rpc("groups/create", {
      name: `延迟测试 ${new Date().toISOString().slice(5, 16).replace("T", " ")}`,
      botIds: [workspace.botId, ...crew.filter((id) => id !== workspace.botId)],
    });
    groupId = group.id;
    report.groupId = groupId;
    save();
    // Same call the web app's new-role form makes.
    await rpc("threads/followUp", { groupId, text: JD, mentions: [workspace.botId] });
    mark("jd_sent");
  } else {
    report.groupId = groupId;
    mark("attached");
  }

  let phase = "intake";
  if (option("--group") && flag("--scale-now")) {
    await readMessages(groupId);
    phase = await sendScale(groupId, messages[0]?.threadId ?? null);
  }
  let firstRound = null;
  let threadId = null;
  let lastTotal = -1;
  let idleSince = Date.now();
  let settledSince = null;
  while (Date.now() - started < TIMEOUT_MS) {
    await readMessages(groupId).catch((error) => log(`read failed: ${error.message}`));
    threadId ??= messages[0]?.threadId ?? null;
    scanText();
    // With no requirements card, the server's own confirmation record marks the brief confirmed.
    if (
      messages.some(
        (message) =>
          message.role === "user" &&
          message.blocks.some(
            (block) => block.kind === "text" && /^Confirm recruiting brief/.test(block.text),
          ),
      )
    )
      mark("brief_confirmed");
    // Read the round first: once ten are recorded, the next-step card is left for the recruiter.
    const round = await readRound(groupId);
    if (phase === "intake" && round && round.candidates.length >= 10) {
      firstRound = round;
      mark("first10_saved", { round: round.round });
      phase = "presented";
    }
    await handleCards(groupId, phase).catch((error) => log(`card failed: ${error.message}`));
    if (phase === "presented") {
      const shown = namesListedInChat(firstRound);
      if (shown.listed >= Math.min(8, shown.of)) {
        mark("first10_in_chat", shown);
        if (FEEDBACK) {
          await sleep(3_000);
          const text = feedbackText(firstRound);
          report.feedback = { text };
          await rpc("threads/send", { groupId, text });
          mark("feedback_sent");
          phase = "feedback";
        } else {
          if (flag("--skip-scale")) break;
          phase = await sendScale(groupId, threadId);
        }
      } else if (Date.now() - Date.parse(report.milestones.first10_saved.at) > 120_000) {
        violation("ten_not_in_chat", `${shown.listed}/${shown.of} names in chat after 2 min`);
        report.milestones.first10_in_chat = { s: null, ...shown };
        if (flag("--skip-scale")) break;
        phase = await sendScale(groupId, threadId);
      }
    }
    if (phase === "feedback") {
      const next = round && round.round > firstRound.round ? round : null;
      const shown = next ? namesListedInChat(next) : null;
      if (next && next.candidates.length)
        mark("feedback_round_saved", { round: next.round, people: next.candidates.length });
      const waited = Date.now() - Date.parse(report.milestones.feedback_sent.at);
      const ready = shown && shown.of >= 10 && shown.listed >= Math.min(8, shown.of);
      if (ready || waited > 10 * 60_000) {
        if (ready) mark("feedback_round_in_chat", shown);
        else
          violation(
            "no_feedback_round",
            next ? `${shown.listed}/${shown.of} in chat after 10 min` : "no new round after 10 min",
          );
        report.feedback.round = next ? report.rounds.find((r) => r.round === next.round) : null;
        if (flag("--skip-scale")) break;
        phase = await sendScale(groupId, threadId);
      }
    }
    if (phase === "scale" && threadId) {
      const total = await readTotal(threadId);
      if (total !== null && total !== lastTotal) {
        lastTotal = total;
        idleSince = Date.now();
        report.candidateTotals.push({ s: elapsed(), total });
        log(`role has ${total} people`);
        for (const step of [25, 50, 75])
          if (total >= (TARGET * step) / 100) mark(`reached_${step}pct`, { total });
        if (total >= TARGET) mark("target_reached", { total });
      }
      // People saved before the request can already exceed the target, so the run also waits for
      // the reply to the request and for the role's work to finish before it reads the pool.
      const sentAt = Date.parse(report.milestones.scale_sent.at);
      // A next-step card from the round's own turn can land just after the request: only text counts.
      const replied = messages.some(
        (message) =>
          message.role === "bot" &&
          Date.parse(message.createdAt) > sentAt &&
          message.blocks.some((block) => block.kind === "text" && block.text.trim()),
      );
      if (replied) mark("scale_replied");
      const busy = await rpc("threads/get", { groupId })
        .then(
          (snapshot) =>
            (snapshot.activeRuns ?? []).length > 0 || snapshot.run?.status === "running",
        )
        .catch(() => true);
      if (!busy && replied) {
        settledSince ??= Date.now();
        if (Date.now() - settledSince > 45_000) {
          mark("scale_settled", { total: lastTotal });
          // Work that stops on a question before the target is a stall a recruiter has to notice.
          const open = pendingAsks();
          if (lastTotal < TARGET && open.length)
            violation("scale_waits_on_card", open.at(-1).block.text.slice(0, 120));
          break;
        }
      } else settledSince = null;
      if (report.milestones.target_reached && Date.now() - sentAt > 30 * 60_000) {
        log("still working 30 min after the request with the target reached; reading the pool now");
        break;
      }
      if (Date.now() - idleSince > 20 * 60_000) {
        violation("stalled", `no new people for 20 min at ${lastTotal}`);
        break;
      }
    }
    save();
    await sleep(POLL_MS);
  }

  if (threadId && phase === "scale")
    await checkPool(threadId).catch((error) => log(`pool read failed: ${error.message}`));
  const events = await readEvents(groupId).catch((error) => {
    log(`event read failed: ${error.message}`);
    return null;
  });
  if (events) {
    // The role is archived below and its events can no longer be read, so keep them for diagnosis.
    fs.writeFileSync(OUT.replace(/(\.json)?$/, ".events.json"), JSON.stringify(events));
    checkToolErrors(events);
    for (const event of events.filter((e) => e.type === "run.failed"))
      violation("run_failed", `${event.createdAt} ${event.payload?.error ?? ""}`.trim());
    if (firstRound) measureFirstTen(events, firstRound);
  }
  const m = report.milestones;
  const between = (from, to) =>
    m[from]?.s != null && m[to]?.s != null ? +(m[to].s - m[from].s).toFixed(1) : null;
  report.latency = {
    jd_to_first_question_s: between("jd_sent", "first_question"),
    confirm_to_first10_saved_s: between("brief_confirmed", "first10_saved"),
    confirm_to_first10_in_chat_s: between("brief_confirmed", "first10_in_chat"),
    jd_to_first10_in_chat_s: between("jd_sent", "first10_in_chat"),
    feedback_to_round_in_chat_s: between("feedback_sent", "feedback_round_in_chat"),
    scale_to_25pct_s: between("scale_sent", "reached_25pct"),
    scale_to_target_s: between("scale_sent", "target_reached"),
    scale_to_reply_s: between("scale_sent", "scale_replied"),
    scale_to_settled_s: between("scale_sent", "scale_settled"),
    jd_to_target_s: between("jd_sent", "target_reached"),
  };
  if (!m.first_question && !m.first10_saved)
    violation("no_reply", "the recruiter saw no question and no people");
  report.result =
    (!option("--group") && !m.first10_saved) || (!flag("--skip-scale") && !m.target_reached)
      ? "incomplete"
      : report.violations.length
        ? "completed_with_violations"
        : "pass";
  if (!option("--group")) {
    // The conversation is renamed after its role; keep it marked as a test copy in the sidebar.
    const { name } = await rpc("groups/get", { groupId });
    if (!name.startsWith(TEST_MARK))
      await rpc("groups/update", { groupId, name: `${TEST_MARK}${name}`.slice(0, 80) });
    if (flag("--archive")) await rpc("groups/archive", { groupId });
  }
  report.finishedAt = new Date().toISOString();
  save();
  log(`result ${report.result}; latency ${JSON.stringify(report.latency)}; report ${OUT}`);
  process.exit(report.result === "pass" ? 0 : 1);
}

main().catch((error) => {
  report.result = "error";
  report.error = error.message;
  save();
  log(`error: ${error.message}`);
  process.exit(2);
});
