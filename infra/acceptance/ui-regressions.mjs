#!/usr/bin/env node
// Browser checks for bugs that were fixed and came back, run on the test environment after each
// deploy. Each check signs in as the test account and looks at the page a recruiter sees:
//
//   ids        Home and Contacts show no raw internal IDs ("YaUqUV" chips), supplier names or
//              internal tool names.
//   multi      A multi-select question card from Kruit takes several picks before it is sent.
//   people     Kruit lists people in the LinkedIn format the role teams use.
//   title      A new role's title replaces "New role" once the JD names the role.
//   reminder   The corner reminder never covers the composer in a role chat.
//
//   RAKAZO_ORIGIN=<test origin> RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/ui-regressions.mjs [--only ids,multi] [--out <dir>]
//
// Writes to Kruit and creates one role marked 「测试固定 · 」, which it archives again; never runs
// against production (the regression harness passes --staging). Exit 0 only when every check
// passes. Prints no credentials.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { rawIds, SUPPLIER, TOOL_NAME } from "./ui-regressions-checks.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const { RAKAZO_EMAIL: EMAIL, RAKAZO_PASSWORD: PASSWORD } = process.env;
if (!ORIGIN || !EMAIL || !PASSWORD) {
  console.error("Set RAKAZO_ORIGIN, RAKAZO_EMAIL and RAKAZO_PASSWORD");
  process.exit(2);
}
const OUT = option("--out") ?? `ui-regressions-${Date.now()}`;
fs.mkdirSync(OUT, { recursive: true });
const ONLY = option("--only")?.split(",");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FIXTURE_MARK = "测试固定 · ";
// Each run asks something new: Kruit rightly refuses to send the same card twice.
const tag = `T${Date.now().toString(36).slice(-5)}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const results = [];
async function check(name, body) {
  if (ONLY && !ONLY.includes(name)) return;
  const failures = [];
  const started = Date.now();
  const page = await context.newPage();
  try {
    await body(page, failures);
  } catch (error) {
    failures.push(`error: ${error.message.split("\n")[0]}`);
  }
  if (failures.length)
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
  await page.close();
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ name, pass: !failures.length, seconds, failures });
  console.log(
    `${failures.length ? "FAIL" : "PASS"} ${name} (${seconds} s)${failures.map((f) => `\n  - ${f}`).join("")}`,
  );
}

async function rpc(route, json) {
  // A read that failed on the server side is safe to ask again; a write is not.
  const read = /\/(get|messages|page|list)$/.test(route);
  for (let attempt = 0; ; attempt += 1) {
    const response = await context.request.post(`${ORIGIN}/rpc/${route}`, {
      headers: { "content-type": "application/json", origin: ORIGIN },
      data: { json },
      failOnStatusCode: false,
    });
    if (response.ok()) return (await response.json()).json;
    if (!read || attempt >= 4 || response.status() < 500)
      throw new Error(`${route} ${response.status()}`);
    await sleep(5_000);
  }
}
async function groups() {
  const all = [];
  for (let offset = 0; offset !== null && offset !== undefined; ) {
    const page = await rpc("groups/page", { offset, archived: false });
    all.push(...page.items);
    offset = page.nextOffset;
  }
  return all;
}
const textOf = (message) =>
  (message.blocks ?? []).map((block) => block.text ?? block.question ?? "").join("\n");
async function messages(groupId) {
  return (await rpc("threads/messages", { groupId, includePeerRuns: true })).messages ?? [];
}
/** Sends to a chat and waits until `until(newBotMessages)` holds; returns those messages. */
async function ask(groupId, text, until, limitMs = 3 * 60_000) {
  const before = new Set((await messages(groupId)).map((message) => message.id));
  await rpc("threads/send", { groupId, addressing: "coordinator", text });
  const end = Date.now() + limitMs;
  let replies = [];
  while (Date.now() < end) {
    await sleep(3_000);
    replies = (await messages(groupId).catch(() => [])).filter(
      (message) => !before.has(message.id) && message.role !== "user",
    );
    if (until(replies)) break;
  }
  return replies;
}

let signedIn = false;
for (const wait of [0, 60_000]) {
  await sleep(wait);
  const response = await context.request.post(`${ORIGIN}/api/auth/sign-in/email`, {
    headers: { origin: ORIGIN },
    data: { email: EMAIL, password: PASSWORD },
    failOnStatusCode: false,
  });
  if (response.status() === 200) {
    signedIn = true;
    break;
  }
  if (response.status() !== 429) break;
}
if (!signedIn) {
  console.log("SKIP could not sign in");
  await browser.close();
  process.exit(3);
}

const all = await groups();
const kruit = all.find((group) => group.name === "Kruit");
const fixtureRole = all.find((group) => group.name.startsWith(FIXTURE_MARK));

try {
  await check("ids", async (page, failures) => {
    for (const [label, url] of [
      ["Home", "/"],
      ["Contacts", "/app?view=contacts&role=all"],
    ]) {
      await page.goto(`${ORIGIN}${url}`);
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await sleep(2_000);
      const chips = await page
        .locator('main button, main a, main [data-slot="badge"], main [role="option"]')
        .allInnerTexts();
      const ids = rawIds(chips);
      if (ids.length) failures.push(`${label} shows raw IDs: ${ids.slice(0, 5).join(", ")}`);
      const text = await page.locator("body").innerText();
      const supplier = text.match(SUPPLIER)?.[0];
      if (supplier) failures.push(`${label} shows supplier name "${supplier}"`);
      const tool = text.match(TOOL_NAME)?.[0];
      if (tool) failures.push(`${label} shows internal tool name "${tool}"`);
    }
  });

  await check("multi", async (page, failures) => {
    if (!kruit) return failures.push("no Kruit chat on this account");
    const replies = await ask(
      kruit.id,
      `测试 ${tag}：请只发一张可以多选的问题卡片问我测试岗位 ${tag} 接受哪些城市，问题里写上 ${tag}，选项 Atlanta、Dallas、Houston、Chicago。不要做别的事。`,
      (items) => items.some((message) => message.blocks?.some((block) => block.kind === "ask")),
      2 * 60_000,
    );
    const card = replies
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.kind === "ask");
    if (!card) return failures.push("Kruit sent no question card within 2 min");
    if (!card.multiple) failures.push("the card was sent as single-choice (multiple is off)");
    await page.goto(`${ORIGIN}/app/g/${kruit.id}`);
    // This run's card: the newest one with checkboxes and a send button.
    const cardBox = page
      .locator("div")
      .filter({ has: page.getByRole("checkbox") })
      .filter({ has: page.getByRole("button", { name: /^(Send answer|Submit|Send|提交|发送)$/ }) })
      .filter({ hasText: tag })
      .last();
    const boxes = cardBox.getByRole("checkbox");
    await boxes
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    const count = await boxes.count();
    if (count < 2) return failures.push(`the card shows ${count} checkboxes, not one per option`);
    // Two picks, then send: the first click must not submit the card on its own.
    await boxes.nth(0).click();
    await sleep(1_500);
    if (!(await boxes.nth(1).isEnabled()))
      return failures.push("the first click submitted the card");
    await boxes.nth(1).click();
    await cardBox.getByRole("button", { name: /^(Send answer|Submit|Send|提交|发送)$/ }).click();
    await sleep(3_000);
    const answer = (await messages(kruit.id)).filter((message) => message.role === "user").at(-1);
    const picked = textOf(answer ?? {});
    if (!(/Atlanta|Dallas|Houston|Chicago/.test(picked) && /[,，、;；]|\band\b/.test(picked)))
      failures.push(`the sent answer does not hold two picks: "${picked.slice(0, 80)}"`);
  });

  await check("people", async (_page, failures) => {
    if (!kruit) return failures.push("no Kruit chat on this account");
    if (!fixtureRole) return failures.push(`no ${FIXTURE_MARK}role on this account`);
    const linked = (items) =>
      items.reduce(
        (n, message) => n + (textOf(message).match(/linkedin\.com\/in\//g)?.length ?? 0),
        0,
      );
    const replies = await ask(
      kruit.id,
      `列出「${fixtureRole.name}」这个岗位里保存的任意 3 个候选人。`,
      (items) => linked(items) >= 3,
    );
    if (linked(replies) < 3)
      failures.push(
        `Kruit's answer lists ${linked(replies)} LinkedIn profiles, not 3: "${replies.map(textOf).join(" ").slice(0, 160)}"`,
      );
  });

  await check("title", async (page, failures) => {
    const before = new Set(all.map((group) => group.id));
    await page.goto(`${ORIGIN}/`);
    await page.getByRole("button", { name: "New Role", exact: true }).first().click();
    const title = `${FIXTURE_MARK}仓库主管 ${new Date().toISOString().slice(5, 16)}`;
    const jd = `${title}\n地点：Dallas，现场办公。要求：3 年以上仓库主管经验，带过 20 人以上的团队。`;
    const box = page.getByRole("textbox", { name: "Job description", exact: true });
    await box.waitFor({ timeout: 20_000 });
    await box.fill(jd);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // The page moves to the new role's chat; its id names the role this check made.
    await page
      .waitForURL(/\/app\/g\/(?!recruiting-global)[^/?]+/, { timeout: 30_000 })
      .catch(() => {});
    const id = page.url().match(/\/app\/g\/((?!recruiting-global)[^/?]+)/)?.[1];
    let created;
    for (let end = Date.now() + 90_000; Date.now() < end; await sleep(3_000)) {
      const now = await groups().catch(() => []);
      created = id
        ? now.find((group) => group.id === id)
        : now.find((group) => !before.has(group.id));
      if (created && !/^new role$/i.test(created.name.trim())) break;
    }
    if (!created) return failures.push("no new role chat appeared within 90 s");
    if (/^new role$/i.test(created.name.trim()))
      failures.push('the new role is still called "New role" after 90 s');
    const sidebar = await page.getByTestId("recruiting-navigation").innerText();
    if (/\bNew role\b/i.test(sidebar) && !sidebar.includes("仓库主管"))
      failures.push('the sidebar still shows "New role"');
    // The test role leaves the sidebar again.
    await rpc("threads/stop", { groupId: created.id, scope: "all" }).catch(() => {});
    await rpc("groups/archive", { groupId: created.id }).catch(() => {});
  });

  await check("reminder", async (page, failures) => {
    if (!fixtureRole) return failures.push(`no ${FIXTURE_MARK}role on this account`);
    await page.goto(`${ORIGIN}/app/g/${fixtureRole.id}`);
    const composer = page.locator('fieldset[aria-label="Message composer"]').first();
    await composer.waitFor({ timeout: 20_000 });
    await sleep(3_000);
    const box = await composer.boundingBox();
    // The dock: the reminder pill or the Kruit button, whichever shows.
    const dock = page
      .locator('[role="status"]', { hasText: /need(s)? your attention/i })
      .or(page.getByRole("button", { name: /^Kruit/ }));
    for (const item of await dock.all()) {
      const corner = await item.boundingBox();
      if (!box || !corner) continue;
      const overlap =
        corner.x < box.x + box.width &&
        corner.x + corner.width > box.x &&
        corner.y < box.y + box.height &&
        corner.y + corner.height > box.y;
      if (overlap) failures.push("the corner reminder covers the composer");
    }
  });
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, "ui-regressions.json"), JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.pass) ? 0 : 1);
