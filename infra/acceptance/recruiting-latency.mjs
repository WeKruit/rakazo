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
//            --target <n>                     scale target (default 100)
//            --timeout-min <n>                overall limit (default 60)
//            --out <file>                     JSON report path (default ./latency-<time>.json)
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
const DEFAULT_JD =
  "新岗位：仓库运营经理（亚特兰大 Atlanta，现场办公）。要求：5年以上仓储或配送中心运营管理，带过50人以上的小时工团队，熟悉WMS和KPI管理。加分：会中文、电商或第三方物流背景。排除：猎头、学生。";
const JD = option("--jd-url")
  ? `新岗位：${option("--jd-url")}`
  : option("--jd")
    ? fs.readFileSync(option("--jd"), "utf8").trim()
    : option("--jd-text", DEFAULT_JD);
const OUT = option("--out", `latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
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
const NEUTRAL_CHOICE = /(按 ?JD|都可以|不限|没有|无所谓|default|any|either|按你|你来定|保持)/i;
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
function errorClass(error) {
  if (/not an outage|could not be read/.test(error)) return error.split(/[.:]/)[0].slice(0, 80);
  if (/unavailable/i.test(error)) return "unavailable";
  if (/Validation failed|expected|Invalid/i.test(error)) return "schema";
  return error.slice(0, 80);
}
async function checkToolErrors(groupId) {
  const events = await readEvents(groupId);
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
    if (/unavailable/i.test(error))
      violation("tool_outage_error", `${name}: ${error.slice(0, 120)}`);
    else if (!recovered) violation("tool_error_unrecovered", `${name}: ${error.slice(0, 120)}`);
  });
  const counts = {};
  for (const item of errors)
    counts[`${item.name} ${item.class}`] = (counts[`${item.name} ${item.class}`] ?? 0) + 1;
  report.toolErrors = { calls: done.length, errors: errors.length, counts, items: errors };
  log(`recruiting tool calls ${done.length}, errors ${errors.length} ${JSON.stringify(counts)}`);
}

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
    const before = messages[0]?.threadId ? await readTotal(messages[0].threadId) : null;
    report.candidateTotals.push({ s: elapsed(), total: before });
    log(`role has ${before} people before the scale-out request`);
    await rpc("threads/send", { groupId, text: SCALE_TEXT });
    mark("scale_sent", { before });
    phase = "scale";
  }
  let firstRound = null;
  let threadId = null;
  let lastTotal = -1;
  let idleSince = Date.now();
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
    await handleCards(groupId, phase).catch((error) => log(`card failed: ${error.message}`));
    const round = await readRound(groupId);

    if (phase === "intake" && round && round.candidates.length >= 10) {
      firstRound = round;
      mark("first10_saved", { round: round.round });
      phase = "presented";
    }
    if (phase === "presented") {
      const shown = namesListedInChat(firstRound);
      if (shown.listed >= Math.min(8, shown.of)) {
        mark("first10_in_chat", shown);
        if (flag("--skip-scale")) break;
        // Let the round's turn settle so the scale request is its own user message.
        await sleep(3_000);
        await rpc("threads/send", { groupId, text: SCALE_TEXT });
        mark("scale_sent");
        phase = "scale";
      } else if (Date.now() - Date.parse(report.milestones.first10_saved.at) > 120_000) {
        violation("ten_not_in_chat", `${shown.listed}/${shown.of} names in chat after 2 min`);
        report.milestones.first10_in_chat = { s: null, ...shown };
        if (flag("--skip-scale")) break;
        await rpc("threads/send", { groupId, text: SCALE_TEXT });
        mark("scale_sent");
        phase = "scale";
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
        if (total >= TARGET) {
          mark("target_reached", { total });
          break;
        }
      }
      if (Date.now() - idleSince > 20 * 60_000) {
        violation("stalled", `no new people for 20 min at ${lastTotal}`);
        break;
      }
    }
    save();
    await sleep(POLL_MS);
  }

  await checkToolErrors(groupId).catch((error) => log(`tool event read failed: ${error.message}`));
  const m = report.milestones;
  const between = (from, to) =>
    m[from]?.s != null && m[to]?.s != null ? +(m[to].s - m[from].s).toFixed(1) : null;
  report.latency = {
    jd_to_first_question_s: between("jd_sent", "first_question"),
    confirm_to_first10_saved_s: between("brief_confirmed", "first10_saved"),
    confirm_to_first10_in_chat_s: between("brief_confirmed", "first10_in_chat"),
    jd_to_first10_in_chat_s: between("jd_sent", "first10_in_chat"),
    scale_to_25pct_s: between("scale_sent", "reached_25pct"),
    scale_to_target_s: between("scale_sent", "target_reached"),
    jd_to_target_s: between("jd_sent", "target_reached"),
  };
  report.result =
    !m.first10_saved || (!flag("--skip-scale") && !m.target_reached)
      ? "incomplete"
      : report.violations.length
        ? "completed_with_violations"
        : "pass";
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
