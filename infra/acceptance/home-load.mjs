#!/usr/bin/env node
// Release check: the signed-in Home opens within its time budget, in a real browser.
//
//   RAKAZO_ORIGIN=<public origin> RAKAZO_EMAIL=… RAKAZO_PASSWORD=… [RAKAZO_SESSION_FILE=…] \
//   node infra/acceptance/home-load.mjs [--shell-ms 6000] [--roles-ms 10000] [--overview-ms 15000]
//
// Measures, from navigation start: the greeting (page shell), the sidebar's role list, and the
// first Overview numbers. Run it on an account with many roles; that is where Home got slow.
// Exit 0 = within budget, 1 = too slow or broken, 2 = usage, 3 = could not sign in (auth's
// rate limit after recent sign-ins; not a product failure). Read-only; secrets are never printed.
// RAKAZO_SESSION_FILE keeps the signed-in session between runs (keep it outside the repo), so
// releases reuse one sign-in instead of tripping auth's rate limit.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// The release machine provides Playwright globally (NODE_PATH), which only require() searches.
const { chromium } = createRequire(import.meta.url)("playwright");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const budgets = {
  shell: option("--shell-ms", 6_000),
  roles: option("--roles-ms", 10_000),
  overview: option("--overview-ms", 15_000),
};
const origin = (process.env.RAKAZO_ORIGIN ?? process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const { RAKAZO_EMAIL: email, RAKAZO_PASSWORD: password } = process.env;
if (!origin || !email || !password || Object.values(budgets).some((ms) => !(ms > 0))) {
  console.error("Usage: RAKAZO_ORIGIN=… RAKAZO_EMAIL=… RAKAZO_PASSWORD=… node home-load.mjs");
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const sessionFile = process.env.RAKAZO_SESSION_FILE;
  const viewport = { width: 1440, height: 900 };
  const signedIn = async (context) =>
    (
      await context.request.post(`${origin}/rpc/me`, {
        headers: { "content-type": "application/json", origin },
        data: "{}",
        failOnStatusCode: false,
      })
    ).status() === 200;
  let context =
    sessionFile && existsSync(sessionFile)
      ? await browser.newContext({ viewport, storageState: sessionFile })
      : undefined;
  if (!context || !(await signedIn(context))) {
    await context?.close();
    context = await browser.newContext({ viewport });
    let status = 0;
    // Auth's limit clears within a minute; one wait keeps a busy release from skipping the check.
    for (const wait of [0, 60_000]) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const signIn = await context.request.post(`${origin}/api/auth/sign-in/email`, {
        headers: { origin },
        data: { email, password },
        failOnStatusCode: false,
      });
      status = signIn.status();
      if (status !== 429) break;
    }
    if (status !== 200) {
      console.log(`SKIP sign-in status ${status}`);
      process.exit(3);
    }
    if (sessionFile) await context.storageState({ path: sessionFile });
  }
  const page = await context.newPage();
  const errors = [];
  page.on("response", (response) => {
    if (response.url().includes("/rpc/") && response.status() >= 500)
      errors.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });
  const start = Date.now();
  await page.goto(`${origin}/`, { waitUntil: "commit" });
  const deadline = Math.max(...Object.values(budgets)) + 5_000;
  const mark = (condition) =>
    page
      .waitForFunction(condition, null, { timeout: deadline, polling: 100 })
      .then(() => Date.now() - start)
      .catch(() => null);
  const [shell, roles, overview] = await Promise.all([
    mark(() => /^Hello\b/.test(document.querySelector("h1")?.textContent?.trim() ?? "")),
    mark(
      () =>
        document.querySelector('nav[aria-label="Role conversations"] button') !== null &&
        !document.body.innerText.includes("Loading roles"),
    ),
    mark(
      () =>
        document.querySelector('[aria-label="Outreach funnel"]') !== null ||
        /No saved overview|Could not load your overview/.test(document.body.innerText),
    ),
  ]);
  const overviewFailed = await page
    .getByText("Could not load your overview.")
    .isVisible()
    .catch(() => false);
  const results = { shell, roles, overview };
  let failed = false;
  for (const [name, ms] of Object.entries(results)) {
    const ok = ms !== null && ms <= budgets[name];
    failed ||= !ok;
    console.log(
      `${ok ? "PASS" : "FAIL"} home ${name} ${ms === null ? "never appeared" : `${ms} ms`} (budget ${budgets[name]} ms)`,
    );
  }
  if (overviewFailed) {
    failed = true;
    console.log("FAIL home overview shows an error");
  }
  if (errors.length) console.log(`server errors: ${[...new Set(errors)].join(", ")}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
