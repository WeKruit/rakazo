// The simulated customer's browser (simulated-customer.mjs --ui): the recruiter uses the real
// pages instead of the API. It types in the chat composer, presses the buttons on cards, opens
// pages such as Sequence, Inbox and Contacts and reads what they show, and every step leaves a
// screenshot. Where the page offers no way to do what the recruiter wants, that is reported as a
// UI problem and the step falls back to the API, so one missing control does not end the journey.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sleep } from "./real-user-session.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
/** Clicks, or false when the control never becomes clickable within 10 s. */
const press = (target) =>
  target
    .click({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
let browser;
let catalog;
/** A card button's label as the Chinese page shows it (from the web app's own catalog). */
function inChinese(label) {
  catalog ??= Object.fromEntries(
    [
      ...fs
        .readFileSync(
          new URL("../../apps/web/src/locales/zh-CN/messages.po", import.meta.url),
          "utf8",
        )
        .matchAll(/^msgid "(.+)"\nmsgstr "(.+)"$/gm),
    ].map(([, id, text]) => [id, text]),
  );
  return catalog[label];
}

// Account pages a recruiter opens from the sidebar, and the pages inside one role.
export const ACCOUNT_PAGES = [
  "contacts",
  "shortlist",
  "sequence",
  "inbox",
  "interview",
  "analytics",
];
export const ROLE_PAGES = ["conversation", "results", "brief", "sequence", "inbox", "contacts"];
// Buttons that send email or grant a standing send permission. The harness checks the recipients
// before it lets the recruiter press one, and never presses a standing permission.
export const SEND_BUTTON = /^(Confirm and send|确认发送|确认并发送|发送|Send)$/i;
export const STANDING_BUTTON = /(Send when I say send|always|一律|总是|以后都)/i;

export async function openUi({ origin, email, password, chinese, out, mobile = false }) {
  browser ??= await chromium.launch();
  // A phone-width journey uses a phone's screen, so layout and touch problems show up too.
  const context = await browser.newContext({
    ...(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 } }),
    locale: chinese ? "zh-CN" : "en-US",
  });
  for (let attempt = 0; ; attempt += 1) {
    const response = await context.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin },
      data: { email, password },
      failOnStatusCode: false,
    });
    if (response.ok()) break;
    if (response.status() !== 429 || attempt >= 4)
      throw new Error(`browser sign-in ${response.status()}`);
    await sleep(60_000);
  }
  // The page language a Chinese recruiter would pick.
  const locale = chinese ? "zh-CN" : "en";
  await context.addInitScript((value) => {
    try {
      globalThis.localStorage.setItem("rakazo.uiLocale", value);
    } catch {}
  }, locale);
  const page = await context.newPage();
  let shots = 0;
  // How long the last page took to show, for the judge (slow or stuck pages are a UX failure).
  let loadMs = null;

  // The app keeps a live stream open, so the network is never idle: a page has settled when its
  // text has stopped changing for a second and nothing shows as loading (at most 15 s).
  const settle = async () => {
    let last = "";
    let stableSince = Date.now();
    for (const until = Date.now() + 15_000; Date.now() < until; await sleep(300)) {
      const text = await page
        .locator("main")
        .first()
        .innerText()
        .catch(() => "");
      const busy = await page
        .locator('[aria-busy="true"]:visible, [role="progressbar"]:visible')
        .count()
        .catch(() => 0);
      const loading = /加载中|Loading…|Loading\.\.\./.test(text);
      if (text !== last || busy || loading || text.trim().length < 20) {
        last = text;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1_000) return;
    }
  };
  const open = async (url) => {
    const at = Date.now();
    await page.goto(`${origin}${url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle();
    // Time until the page stopped changing, without the second it had to stay still.
    loadMs = Math.max(0, Date.now() - at - 1_000);
  };
  const buttons = async () =>
    (
      await page
        .locator("main button:visible, main a:visible, section button:visible")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => (node.getAttribute("aria-label") || node.innerText || "").trim())
            .filter((name) => name && name.length <= 80),
        )
        .catch(() => [])
    ).filter((name, index, all) => all.indexOf(name) === index);

  return {
    page,
    open,
    /** Opens a chat (by group id) unless it is already the one on screen. */
    async openChat(groupId) {
      if (!page.url().includes(`/app/g/${encodeURIComponent(groupId)}`))
        await open(`/app/g/${encodeURIComponent(groupId)}`);
    },
    /** Opens a page by name: home, an account page, or a page inside one role's chat. */
    async openPage(name, groupId) {
      if (name === "home") return open("/");
      if (groupId && ROLE_PAGES.includes(name))
        return open(`/app/g/${encodeURIComponent(groupId)}?view=${name}`);
      if (ACCOUNT_PAGES.includes(name)) return open(`/app?view=${name}&role=all`);
      throw new Error(`no page called ${name}`);
    },
    /** Types a message in the open chat's composer and sends it; false when there is none. */
    async say(text) {
      // The chat composer, not an open card's answer box (also a textarea in a fieldset).
      const composer = page
        .locator('fieldset textarea:not([aria-label="Answer"]):not([aria-label="回答"])')
        .last();
      if (!(await composer.isVisible().catch(() => false))) return false;
      await composer.fill(text);
      await composer.press("Enter");
      await sleep(1_500);
      // The composer empties once the page has taken the message (it may wait in a queue while
      // Kruit is still working, so the chat itself can show it later).
      return (await composer.inputValue().catch(() => text)).trim() === "";
    },
    /** Presses the visible button or link with this name; false when the page has none. */
    async click(name) {
      const target = page
        .getByRole("button", { name, exact: true })
        .or(page.getByRole("link", { name, exact: true }))
        .first();
      if (!(await target.isVisible().catch(() => false))) return false;
      // A control that is covered or never becomes clickable is the page's problem, not a crash.
      if (!(await press(target))) return false;
      await settle();
      return true;
    },
    /** Presses a card's button, whichever language the page shows it in. */
    async clickLabel(label) {
      for (const name of [label, inChinese(label)].filter(Boolean)) {
        const target = page.getByRole("button", { name, exact: true }).last();
        if (await target.isVisible().catch(() => false)) {
          if (!(await press(target))) return false;
          await settle();
          return true;
        }
        // A multiple-choice card shows its options as checkboxes and sends them with one button.
        const option = page
          .locator("label")
          .filter({ has: page.getByRole("checkbox") })
          .filter({
            hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`),
          })
          .last();
        if (await option.isVisible().catch(() => false)) {
          if (!(await press(option.getByRole("checkbox").first()))) return false;
          const send = page.getByRole("button", { name: /^(Send answer|发送回答)$/ }).last();
          if (!(await send.isEnabled().catch(() => false))) return false;
          if (!(await press(send))) return false;
          await settle();
          return true;
        }
      }
      return false;
    },
    /** Types a custom answer into the card's answer box and sends it; false when there is none. */
    async answerTyped(text) {
      let box = page.getByRole("textbox", { name: /^(Answer|回答|答案)$/ }).last();
      if (!(await box.isVisible().catch(() => false))) {
        // A form card names each field by its label; one text field takes the typed answer.
        const fields = page
          .locator("form")
          .filter({ has: page.getByRole("button", { name: /^(Send answer|发送回答)$/ }) })
          .last()
          .locator("textarea:visible, input:visible:not([type=checkbox]):not([type=radio])");
        if ((await fields.count().catch(() => 0)) !== 1) return false;
        box = fields.first();
      }
      await box.fill(text);
      const send = page.getByRole("button", { name: /^(Send answer|发送回答)$/ }).last();
      if (!(await send.isEnabled().catch(() => false))) return false;
      if (!(await press(send))) return false;
      await settle();
      return true;
    },
    /** What the recruiter sees now: the address, the page's text, and the buttons on it. */
    async view(limit = 3500) {
      await settle();
      const text = (
        await page
          .locator("main")
          .first()
          .innerText()
          .catch(() => page.locator("body").innerText())
      )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const seen = {
        url: page.url().replace(origin, ""),
        text: text.length > limit ? `${text.slice(0, limit)}\n…` : text,
        buttons: await buttons(),
        ...(loadMs === null ? {} : { loadSeconds: Math.round(loadMs / 100) / 10 }),
      };
      loadMs = null;
      return seen;
    },
    async shot(label) {
      shots += 1;
      const file = `${String(shots).padStart(2, "0")}-${label.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40)}.png`;
      await page.screenshot({ path: path.join(out, file) }).catch(() => {});
      return file;
    },
    close: () => context.close().catch(() => {}),
  };
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
  browser = undefined;
}
