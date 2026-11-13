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

export async function openUi({ origin, email, password, chinese, out }) {
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
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

  const settle = async () => {
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(1_500);
  };
  const open = async (url) => {
    await page.goto(`${origin}${url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle();
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
      await target.click();
      await settle();
      return true;
    },
    /** Presses a card's button, whichever language the page shows it in. */
    async clickLabel(label) {
      for (const name of [label, inChinese(label)].filter(Boolean)) {
        const target = page.getByRole("button", { name, exact: true }).last();
        if (await target.isVisible().catch(() => false)) {
          await target.click();
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
      await send.click();
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
      return {
        url: page.url().replace(origin, ""),
        text: text.length > limit ? `${text.slice(0, limit)}\n…` : text,
        buttons: await buttons(),
      };
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
