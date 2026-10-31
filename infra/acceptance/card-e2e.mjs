#!/usr/bin/env node
// Clicks the product's cards in the real web app, so a release is tested end to end without a
// person answering them. Every card is clicked in the browser, the way a recruiter would.
//
//   intake   new test copy: types the JD in the composer, clicks an option on every question card
//            until people are in Results, then asks to email five people and clicks Deny on the
//            send card (copies hold real people, so their send cards are never approved)
//   send     the internal send fixture: asks for the first email and clicks Allow only when every
//            recipient is @wekruit.com and the card names the fixture role; otherwise Deny + fail
//   booking  the internal booking fixture: books a free slot, clicks Allow only for @wekruit.com
//            attendees, then cancels it and checks the calendar shows it cancelled
//
//   RAKAZO_URL=… RAKAZO_ORIGIN=… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/card-e2e.mjs --out <dir> [--only intake,send,booking]
//     [--jd-file <cases>/t3.txt] [--send-group <id> --send-role-mark <text in the role line>]
//     [--booking-group <id>]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const { RAKAZO_EMAIL: EMAIL, RAKAZO_PASSWORD: PASSWORD } = process.env;
if (!BASE || !EMAIL || !PASSWORD) {
  console.error("Set RAKAZO_URL, RAKAZO_EMAIL and RAKAZO_PASSWORD (the browser needs a session)");
  process.exit(2);
}
const OUT = option("--out", `card-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const ONLY = new Set(option("--only", "intake,send,booking").split(","));
const INTERNAL = /@wekruit\.com$/i;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (text) =>
  process.stdout.write(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s] ${text}\n`,
  );

let cookie = "";
async function signIn() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (response.status === 429) {
      await sleep(60_000);
      continue;
    }
    if (!response.ok) throw new Error(`sign-in ${response.status}`);
    cookie = (response.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
    return;
  }
  throw new Error("sign-in rate limited");
}

async function rpc(route, json) {
  // A transient 5xx or dropped connection is retried, so one blip does not fail the release.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${BASE}/rpc/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ json }),
    }).catch(() => null);
    if (response?.ok) return (await response.json()).json;
    if (attempt < 3 && (!response || response.status >= 500)) {
      log(`${route} ${response?.status ?? "network error"}; retrying`);
      await sleep(3_000 * (attempt + 1));
      continue;
    }
    throw new Error(`${route} ${response?.status ?? "network error"}`);
  }
}

const messagesOf = async (groupId) =>
  (await rpc("threads/messages", { groupId, includePeerRuns: true })).messages ?? [];
const asks = (messages) =>
  messages.flatMap((message) =>
    (message.blocks ?? [])
      .filter((block) => block.kind === "ask")
      .map((block) => ({ ...block, at: message.createdAt })),
  );
const pending = (block) => !block.status || block.status === "pending";
const botTexts = (messages, since) =>
  messages
    .filter((message) => message.role === "bot" && message.createdAt > since)
    .flatMap((message) =>
      (message.blocks ?? [])
        .filter((block) => block.kind === "text")
        .map((block) => block.text ?? ""),
    )
    .filter(Boolean);
/** The addresses a card sends to or invites: "To (n):" list lines, or the "Candidate:" line. */
function recipientsOf(card) {
  const lines = (card.detail ?? "").split("\n");
  const found = [];
  let inTo = false;
  for (const line of lines) {
    if (/^To \(\d+\):/.test(line)) {
      inTo = true;
      continue;
    }
    if (inTo && !/^\s*-|^\s{2,}/.test(line)) inTo = false;
    if (inTo || /^(Candidate|Attendees?|To):/.test(line))
      found.push(...(line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []));
  }
  return found;
}

const results = [];
async function stage(name, body) {
  const at = Date.now();
  const failures = [];
  log(`${name}: start`);
  try {
    await body(failures);
  } catch (error) {
    failures.push(`error: ${error.message}`);
  }
  const result = {
    name,
    pass: !failures.length,
    seconds: Math.round((Date.now() - at) / 1000),
    failures,
  };
  results.push(result);
  log(`${name}: ${result.pass ? "PASS" : `FAIL\n  - ${failures.join("\n  - ")}`}`);
}

await signIn();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const host = new URL(BASE).hostname;
await context.addCookies(
  cookie.split("; ").map((pair) => {
    const index = pair.indexOf("=");
    return {
      name: pair.slice(0, index),
      value: pair.slice(index + 1),
      domain: host,
      path: "/",
      secure: BASE.startsWith("https"),
      httpOnly: true,
    };
  }),
);
const page = await context.newPage();

async function openChat(groupId) {
  await page.goto(`${BASE}/app/g/${groupId}`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("group", { name: "Message composer" })
    .locator("textarea")
    .waitFor({ timeout: 60_000 });
}
async function type(text) {
  const box = page.getByRole("group", { name: "Message composer" }).locator("textarea");
  await box.fill(text);
  await page
    .getByRole("group", { name: "Message composer" })
    .getByRole("button", { name: "Send" })
    .last()
    .click();
}
/** Clicks the card's action with this id in the browser; buttons render in the block's action order. */
async function click(card, actionId) {
  const index = card.actions.findIndex((action) => action.id === actionId);
  if (index < 0) throw new Error(`card "${card.text}" has no ${actionId} action`);
  const fieldset = page
    .locator("fieldset", { has: page.getByText(card.text.split("\n")[0].slice(0, 60)) })
    .last();
  await fieldset.scrollIntoViewIfNeeded();
  await fieldset.locator("div.space-y-1\\.5 > button").nth(index).click();
  // The click lands when the server records the answer.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const now = asks(await messagesOf(card.groupId)).find((block) =>
      block.approvalEffectId
        ? block.approvalEffectId === card.approvalEffectId
        : block.at === card.at && block.text === card.text,
    );
    if (now && !pending(now)) return now;
    await sleep(1_000);
  }
  throw new Error(`click on "${card.text.slice(0, 60)}" (${actionId}) was not recorded`);
}
/** Waits for a pending card matching `match`, new since `since`. */
async function waitCard(groupId, since, match, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const card = asks(await messagesOf(groupId)).find(
      (block) => block.at > since && pending(block) && match(block),
    );
    if (card) return { ...card, groupId };
    await sleep(2_000);
  }
  return null;
}
/** True once no run in the chat is working (a run waiting on a card counts as done). */
async function settled(groupId, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const { activeRuns = [] } = await rpc("threads/get", { groupId });
    if (!activeRuns.some((run) => run.status !== "waiting_input")) return true;
    await sleep(3_000);
  }
  return false;
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => undefined);
}

if (ONLY.has("intake"))
  await stage("intake", async (failures) => {
    const file = option("--jd-file");
    if (!file || !fs.existsSync(file)) return failures.push("pass --jd-file (a text JD)");
    const workspace = await rpc("onboarding/ensureRecruiting", {});
    const home = await rpc("groups/get", { groupId: workspace.groupId });
    const crew = home.members.map((member) => member.botId);
    const group = await rpc("groups/create", {
      name: `测试副本 · 卡片测试 ${new Date().toISOString().slice(5, 16).replace("T", " ")}`,
      botIds: [workspace.botId, ...crew.filter((id) => id !== workspace.botId)],
    });
    const groupId = group.id;
    fs.writeFileSync(path.join(OUT, "intake.json"), JSON.stringify({ groupId }));
    await openChat(groupId);
    const since = new Date().toISOString();
    await type(fs.readFileSync(file, "utf8"));
    // Answer every question in the browser until people are in Results.
    let clicked = 0;
    let people = 0;
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const card = asks(await messagesOf(groupId)).find(
        (block) => block.at > since && pending(block),
      );
      if (card?.approvalEffectId) {
        failures.push(`approval card before any people: "${card.text}"`);
        await click({ ...card, groupId }, "deny");
        break;
      }
      if (card?.actions?.length) {
        const answered = await click({ ...card, groupId }, card.actions[0].id);
        clicked += 1;
        log(`question ${clicked}: "${card.text.slice(0, 70)}" → ${answered.answer}`);
      }
      const thread = (await rpc("groups/get", { groupId })).threadId;
      people = thread
        ? ((
            await rpc("recruiting/roleCandidates", { groupId, threadId: thread, limit: 1 }).catch(
              () => null,
            )
          )?.total ?? 0)
        : 0;
      if (people >= 10) break;
      await sleep(2_000);
    }
    await screenshot("intake-people");
    if (!clicked) failures.push("no question card was clicked");
    if (people < 10) failures.push(`only ${people} people after answering ${clicked} question(s)`);
    if (people < 1) return;
    // A recruiter replies once the round is posted; a run still working minutes later is stuck.
    const quiet = await settled(groupId, 5 * 60_000);
    if (!quiet) failures.push("a run was still working 5 min after the first people appeared");
    // A send card on a copy lists real people: the harness always clicks Deny there.
    const askedAt = new Date().toISOString();
    await type("发5个人的先");
    const send = await waitCard(
      groupId,
      askedAt,
      (block) => Boolean(block.approvalEffectId),
      8 * 60_000,
    );
    if (!send) return failures.push("「发5个人的先」 did not end on a send card");
    await screenshot("intake-send-card");
    const denied = await click(send, "deny");
    if (denied.answer !== "deny") failures.push(`send card answered ${denied.answer}`);
    await sleep(20_000);
    const after = botTexts(await messagesOf(groupId), denied.at).join("\n");
    if (
      /\b(sent|activated|is live)\b|已发送/i.test(after) &&
      !/not (been )?sent|nothing (was )?sent|没有发送|未发送/i.test(after)
    )
      failures.push(`after Deny the chat says it sent: ${after.slice(0, 200)}`);
    await screenshot("intake-denied");
    await rpc("groups/archive", { groupId }).catch(() => undefined);
  });

if (ONLY.has("send"))
  await stage("send", async (failures) => {
    const groupId = option("--send-group");
    const mark = option("--send-role-mark");
    if (!groupId || !mark) return failures.push("pass --send-group and --send-role-mark");
    const open = asks(await messagesOf(groupId)).filter(pending);
    if (open.length)
      return failures.push(`fixture has ${open.length} unanswered card(s); not touching it`);
    await openChat(groupId);
    const since = new Date().toISOString();
    await type("给 Adam Test 发第一封邮件");
    const card = await waitCard(
      groupId,
      since,
      (block) => Boolean(block.approvalEffectId),
      8 * 60_000,
    );
    if (!card) return failures.push("no send card");
    await screenshot("send-card");
    const to = recipientsOf(card);
    const role = (card.detail ?? "").split("\n").find((line) => line.startsWith("Role:")) ?? "";
    if (!to.length || !to.every((address) => INTERNAL.test(address)) || !role.includes(mark)) {
      await click(card, "deny");
      return failures.push(
        `unsafe send card (to: ${to.join(", ") || "none"}; ${role || "no role line"}); denied`,
      );
    }
    await click(card, "allow");
    await sleep(30_000);
    const after = botTexts(await messagesOf(groupId), card.at).join("\n");
    fs.writeFileSync(path.join(OUT, "send-after.txt"), `${after}\n`);
    if (!after) failures.push("no reply after the send was allowed");
    if (
      /error|failed|could not|couldn['’]t/i.test(after) &&
      !/already (been )?(sent|emailed)/i.test(after)
    )
      failures.push(`send reply reports a failure: ${after.slice(0, 200)}`);
    await screenshot("send-after");
  });

if (ONLY.has("booking"))
  await stage("booking", async (failures) => {
    const groupId = option("--booking-group");
    if (!groupId) return failures.push("pass --booking-group");
    // The full suite's booking check leaves its card unanswered; an old one is declined here.
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    await openChat(groupId);
    for (const card of asks(await messagesOf(groupId)).filter(pending)) {
      if (card.at < stale && /^Confirm interview booking/.test(card.text) && card.approvalEffectId)
        await click({ ...card, groupId }, "deny");
    }
    const open = asks(await messagesOf(groupId)).filter(pending);
    if (open.length)
      return failures.push(`fixture has ${open.length} unanswered card(s); not touching it`);
    // A free slot two or more days out, so each run books something new.
    const calendar = await rpc("recruiting/correspondence", { groupId, view: "interview" });
    const soonest = Date.now() + 2 * 86_400_000;
    const slot = (calendar.events ?? []).find(
      (event) => event.kind === "availability" && Date.parse(event.start) > soonest,
    );
    if (!slot) return failures.push("no free interview slot in the fixture calendar");
    const when = new Date(slot.start);
    const label = when.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      weekday: "long",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    await openChat(groupId);
    const since = new Date().toISOString();
    await type(
      `Please book another interview with Adam Test on ${label} Central, 30 minutes, same interviewer as before.`,
    );
    const card = await waitCard(
      groupId,
      since,
      (block) => Boolean(block.approvalEffectId),
      6 * 60_000,
    );
    if (!card) return failures.push("no booking card");
    await screenshot("booking-card");
    const to = recipientsOf(card);
    if (!to.length || !to.every((address) => INTERNAL.test(address))) {
      await click(card, "deny");
      return failures.push(`booking card invites ${to.join(", ") || "nobody"}; denied`);
    }
    await click(card, "allow");
    const booked = async () =>
      ((await rpc("recruiting/correspondence", { groupId, view: "interview" })).events ?? []).find(
        (event) =>
          event.kind === "event" &&
          Date.parse(event.start) === when.getTime() &&
          event.status !== "superseded",
      );
    let event = null;
    for (let i = 0; i < 30 && !event; i += 1) {
      await sleep(4_000);
      event = await booked();
    }
    if (!event) failures.push(`allowed booking for ${label} never reached the calendar`);
    // Cancel right away; a confirmation card for the cancel is clicked the same way.
    const cancelAt = new Date().toISOString();
    await type(
      `Please cancel the interview with Adam Test on ${label} Central that you just booked.`,
    );
    const cancelDeadline = Date.now() + 5 * 60_000;
    let cancelled = false;
    while (Date.now() < cancelDeadline && !cancelled) {
      const cancelCard = asks(await messagesOf(groupId)).find(
        (block) => block.at > cancelAt && pending(block) && block.approvalEffectId,
      );
      if (cancelCard) {
        const invited = recipientsOf(cancelCard);
        await click(
          { ...cancelCard, groupId },
          invited.every((address) => INTERNAL.test(address)) ? "allow" : "deny",
        );
      }
      const now = await booked();
      cancelled = event ? now?.status === "cancelled" || !now : true;
      if (!cancelled) await sleep(4_000);
    }
    await screenshot("booking-cancelled");
    // One cancel needs one card, and the recruiter must not be told both outcomes.
    const cancelCards = asks(await messagesOf(groupId)).filter(
      (block) => block.at > cancelAt && block.approvalEffectId,
    );
    if (cancelCards.length > 1)
      failures.push(`${cancelCards.length} cancellation cards for one cancel`);
    const replies = botTexts(await messagesOf(groupId), cancelAt).join("\n");
    fs.writeFileSync(path.join(OUT, "booking-after.txt"), `${replies}\n`);
    if (
      /cancel(?:l)?ed/i.test(replies) &&
      /(?:couldn['’]t|could not|unable to) cancel/i.test(replies)
    )
      failures.push("the chat says the interview was both cancelled and not cancelled");
    if (event && !cancelled)
      failures.push(`booking at ${label} is still ${(await booked())?.status}; cancel it by hand`);
  });

await browser.close();
const passed = results.every((result) => result.pass);
const summary = [
  `# Card clicks ${passed ? "PASS" : "FAIL"} (${Math.round((Date.now() - started) / 60_000)} min)`,
  "",
  ...results.map(
    (result) =>
      `- ${result.pass ? "PASS" : "FAIL"} ${result.name} (${result.seconds} s)${result.failures.map((failure) => `\n  - ${failure}`).join("")}`,
  ),
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), `${summary}\n`);
log(summary);
process.exit(passed ? 0 : 1);
