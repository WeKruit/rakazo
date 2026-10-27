import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { build, preview } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const baselineRef = process.env.D3_BASE_REF;
let origin: string;
let output: string;
let stop: (() => Promise<void>) | undefined;
let jsBytes = 0;
let gzipBytes = 0;
test.beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), "rakazo-candidate-browser-"));
  const baseline = baselineRef
    ? execFileSync(
        "git",
        ["show", `${baselineRef}:apps/web/src/pages/recruiting/CandidateDirectory.tsx`],
        { cwd: root, encoding: "utf8" },
      )
    : null;
  process.env.RAKAZO_ALLOW_DEV_SECRETS = "1";
  await build({
    root,
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
    plugins: baseline
      ? [
          {
            name: "baseline-candidate-directory",
            enforce: "pre",
            load(id) {
              if (id.endsWith("/recruiting/CandidateDirectory.tsx")) return baseline;
            },
          },
        ]
      : [],
    build: {
      outDir: output,
      emptyOutDir: true,
      rollupOptions: { input: path.join(root, "e2e/fixtures/candidates.html") },
    },
  });
  for (const file of await readdir(path.join(output, "assets"))) {
    if (!file.endsWith(".js")) continue;
    const bytes = await readFile(path.join(output, "assets", file));
    jsBytes += bytes.length;
    gzipBytes += gzipSync(bytes).length;
  }
  const server = await preview({
    root,
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: output },
    preview: { host: "127.0.0.1", port: 0 },
  });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  stop = () => server.close();
});
test.afterAll(async () => {
  await stop?.();
  if (output) await rm(output, { recursive: true, force: true });
});

test("1000 synthetic candidates: bounded rows, scroll tasks, keyboard and selection", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("https://**/*", (route) => route.abort());
  await page.goto(`${origin}/e2e/fixtures/candidates.html`);
  const table = page.getByRole("region", { name: "Candidate table" });
  await expect(table).toBeVisible();
  await page.waitForTimeout(500);
  const initialRows = await table.locator("tbody tr:has(th)").count();
  const initialRequests = requests.length;
  const scriptRequests = requests.filter((url) => new URL(url).pathname.endsWith(".js")).length;
  if (baselineRef) expect(initialRows).toBe(1000);
  else expect(initialRows).toBeLessThanOrEqual(100);
  await page.evaluate(() => {
    (window as unknown as { longTasks: number[] }).longTasks = [];
    new PerformanceObserver((list) => {
      (window as unknown as { longTasks: number[] }).longTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      );
    }).observe({ type: "longtask" });
  });
  let maxRows = initialRows;
  for (let index = 0; index < 30; index++) {
    await table.evaluate((element, index) => {
      element.scrollTop = index * 1800;
    }, index);
    await page.waitForTimeout(40);
    maxRows = Math.max(maxRows, await table.locator("tbody tr:has(th)").count());
  }
  const longTasks = await page.evaluate(
    () => (window as unknown as { longTasks: number[] }).longTasks,
  );
  console.log(
    JSON.stringify({
      mode: baselineRef ? "before" : "after",
      initialRows,
      maxRows,
      initialRequests,
      scriptRequests,
      jsBytes,
      gzipBytes,
      longTasks,
      maxLongTaskMs: Math.max(0, ...longTasks),
    }),
  );
  if (baselineRef) return;
  expect(maxRows).toBeLessThanOrEqual(100);
  expect(longTasks.filter((duration) => duration > 50)).toEqual([]);
  await table.evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = page.getByRole("button", { name: "Synthetic Candidate 0", exact: true });
  await first.focus();
  await table.evaluate((element) => {
    element.scrollTop = 30000;
  });
  await page.waitForTimeout(100);
  await expect(first).toBeFocused();
  expect(await table.locator("tbody tr:has(th)").count()).toBeLessThanOrEqual(100);
  await first.press("End");
  const last = page.getByRole("button", { name: "Synthetic Candidate 999", exact: true });
  await expect(last).toBeFocused();
  await last.press("Enter");
  await expect(page.getByLabel("Selected candidate")).toHaveText("synthetic-999");
  await table
    .locator('[data-candidate-index="999"]')
    .getByRole("button", { name: "Shortlist" })
    .click();
  await last.focus();
  await last.press("Home");
  await expect(first).toBeFocused();
  await first.press("End");
  await expect(last).toBeFocused();
  await expect(
    table.locator('[data-candidate-index="999"]').getByRole("button", { name: "Shortlist" }),
  ).toHaveAttribute("aria-pressed", "true");
  const offset = await table.evaluate((element) => element.scrollTop);
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  const cards = page.getByRole("region", { name: "Candidate cards" });
  await expect(cards).toBeVisible();
  expect(await cards.locator("[data-candidate-index]").count()).toBeLessThanOrEqual(100);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (window as unknown as { longTasks: number[] }).longTasks = [];
  });
  let maxCards = 0;
  for (let index = 0; index < 30; index++) {
    await cards.evaluate((element, index) => {
      element.scrollTop = index * 2400;
    }, index);
    await page.waitForTimeout(40);
    maxCards = Math.max(maxCards, await cards.locator("[data-candidate-index]").count());
  }
  const cardTasks = await page.evaluate(
    () => (window as unknown as { longTasks: number[] }).longTasks,
  );
  console.log(JSON.stringify({ mode: "cards-after", maxCards, longTasks: cardTasks }));
  expect(maxCards).toBeLessThanOrEqual(100);
  expect(cardTasks.filter((duration) => duration > 50)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await cards.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(200);
  expect(await cards.locator("[data-candidate-index]").count()).toBeLessThanOrEqual(100);
  await page.setViewportSize({ width: 1440, height: 900 });

  expect(await cards.locator("[data-candidate-index]").count()).toBeLessThanOrEqual(100);
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect
    .poll(() => table.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(offset - 200);
  await expect(
    page.getByRole("button", { name: "Synthetic Candidate 999", exact: true }),
  ).toBeVisible();
});
