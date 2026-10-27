/** Cold contacts route with synthetic records; all API requests are mocked. */
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { appGroupId, mockRecruitingApp } from "../e2e/fixtures/recruiting-app-data";

const root = path.resolve(import.meta.dirname, "..");
const locale = process.env.MEASURE_UI_LOCALE ?? "zh-CN";
const server = await preview({
  root,
  configFile: path.join(root, "vite.config.ts"),
  build: { outDir: path.resolve(process.argv[2] ?? "dist") },
  preview: { port: 0, host: "127.0.0.1" },
  logLevel: "silent",
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const fixture = await mockRecruitingApp(page, { locale });
  const assets: Promise<{ path: string; raw: number; gzip: number }>[] = [];
  let requests = 0;
  page.on("request", () => requests++);
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.endsWith(".js"))
      assets.push(
        response.body().then((body) => ({
          path: pathname,
          raw: body.length,
          gzip: gzipSync(body).length,
        })),
      );
  });
  const port = (server.httpServer.address() as AddressInfo).port;
  await page.goto(`http://127.0.0.1:${port}/app/g/${appGroupId}?view=contacts`);
  await page.getByText("Avery Example", { exact: true }).first().waitFor();
  await page.waitForTimeout(500);
  if (fixture.unknown.length) throw new Error(`Unmocked RPCs: ${fixture.unknown.join(", ")}`);
  const scripts = (await Promise.all(assets)).sort((a, b) => b.gzip - a.gzip);
  const keys = fixture.calls
    .filter((call) => call.method.startsWith("recruiting/"))
    .map((call) => JSON.stringify(call));
  console.log(
    JSON.stringify(
      {
        locale,
        scope: "direct cold contacts route with visible synthetic contacts",
        gzipBytes: scripts.reduce((sum, asset) => sum + asset.gzip, 0),
        scriptRequests: scripts.length,
        totalRequests: requests,
        rpcRequests: fixture.calls.length,
        duplicateRecruitingRequests: keys.length - new Set(keys).size,
        scripts,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
