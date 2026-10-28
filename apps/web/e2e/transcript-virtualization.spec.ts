import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { build, preview } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const baselineRef = process.env.D3_TRANSCRIPT_BASE_REF;
let origin: string;
let output: string;
let stop: (() => Promise<void>) | undefined;
let jsBytes = 0;
let gzipBytes = 0;
test.beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), "rakazo-candidate-browser-"));
  const baseline = baselineRef
    ? execFileSync("git", ["show", `${baselineRef}:apps/web/src/pages/shell/Transcript.tsx`], {
        cwd: root,
        encoding: "utf8",
      })
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
              if (id.endsWith("/shell/Transcript.tsx")) return baseline;
            },
          },
        ]
      : [],
    build: {
      outDir: output,
      emptyOutDir: true,
      rollupOptions: { input: path.join(root, "e2e/fixtures/transcript.html") },
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

test("measured transcript preserves streaming tail, focus and distant jump", async ({ page }) => {
  await page.route("https://**/*", (route) => route.abort());
  await page.goto(`${origin}/e2e/fixtures/transcript.html`);
  const rows = page.locator("[data-transcript-key]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeLessThan(100);
  await page.getByRole("button", { name: "Jump first" }).click();
  await expect(page.getByRole("button", { name: "Message 0", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Message 0", exact: true }).focus();
  await page.locator("#viewport").evaluate((element) => {
    element.scrollTop = 80000;
  });
  await expect(page.getByRole("button", { name: "Message 0", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Message 0", exact: true }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator("#viewport").evaluate((element) => {
    element.scrollTop = 120000;
  });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Message 0");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.getByRole("button", { name: "Follow tail" }).click();
  await expect(page.getByRole("button", { name: "Message 999", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stream" }).click();
  await page.waitForTimeout(300);
  const gap = await page
    .locator("#viewport")
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  expect(gap).toBeLessThan(5);
  console.log(JSON.stringify({ rows: await rows.count(), tailGap: gap, jsBytes, gzipBytes }));
});

test("real Transcript renders a bounded synthetic conversation and jumps to an unmounted message", async ({
  page,
}) => {
  await page.route("https://**/*", (route) => route.abort());
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${origin}/e2e/fixtures/transcript.html?real=1`);
  await expect(page.locator('[data-message-id="synthetic-999"]')).toBeVisible();
  await page.waitForTimeout(200);
  const initialRows = await page.locator("[data-message-id]").count();
  const initialRequests = requests.length;
  const scriptRequests = requests.filter((url) => new URL(url).pathname.endsWith(".js")).length;
  await page.evaluate(() => {
    (window as unknown as { longTasks: number[] }).longTasks = [];
    new PerformanceObserver((list) =>
      (window as unknown as { longTasks: number[] }).longTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      ),
    ).observe({ type: "longtask" });
  });
  let maxRows = initialRows;
  for (let index = 0; index < 30; index++) {
    await page.getByTestId("transcript").evaluate((element, step) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      element.scrollTop = ((element.scrollHeight - element.clientHeight) * step) / 29;
    }, index);
    await page.waitForTimeout(20);
    maxRows = Math.max(maxRows, await page.locator("[data-message-id]").count());
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
    }),
  );
  if (baselineRef) return;
  expect(maxRows).toBeLessThan(100);
  expect(longTasks).toEqual([]);
  await page.getByRole("button", { name: "Jump first", exact: true }).click();
  await expect(page.locator('[data-message-id="synthetic-0"]')).toBeVisible();
  // Scrolling upward can already trigger the automatic prepend path.
  await page.getByTestId("transcript").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    element.scrollTop = 0;
  });
  await expect(
    page.getByRole("button", { name: "Load earlier messages", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-message-id="older-0"]')).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect(page.locator('[data-message-id="synthetic-999"]')).toBeVisible();
  await page.getByRole("button", { name: "Append", exact: true }).click();
  await expect(page.locator('[data-message-id="streaming"]')).toBeVisible();
});
