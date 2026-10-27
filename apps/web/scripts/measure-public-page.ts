/** Compare actual browser page requests with the same build on both C6 servers. */

import type { AddressInfo } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { createPublicWebServer } from "../../api/src/public-web.js";

const root = path.resolve(import.meta.dirname, "..");
const browser = await chromium.launch({ headless: true });
async function measure(origin: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  const scripts = new Map<string, Promise<Buffer>>();
  page.on("request", (request) => {
    if (new URL(request.url()).origin === origin.slice(0, -1))
      requests.push(new URL(request.url()).pathname);
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin.slice(0, -1)
      ? route.continue()
      : route.abort(),
  );
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.endsWith(".js") && response.ok()) scripts.set(pathname, response.body());
  });
  // Keep API responses identical: this is a static sign-in navigation, not a live account.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }),
  );
  await page.route("**/rpc/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"message":"unauthorized"}',
    }),
  );
  await page.goto(origin, { waitUntil: "networkidle" });
  const bytes = await Promise.all(scripts.values());
  const result = {
    pageRequests: requests.length,
    jsRequests: scripts.size,
    jsRawBytes: bytes.reduce((sum, body) => sum + body.length, 0),
    jsGzipBytes: bytes.reduce((sum, body) => sum + gzipSync(body).length, 0),
    requestPaths: requests.sort(),
  };
  await context.close();
  return result;
}
try {
  const before = await preview({
    root,
    configFile: path.join(root, "vite.config.ts"),
    preview: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  let baseline: Awaited<ReturnType<typeof measure>>;
  try {
    baseline = await measure(
      `http://127.0.0.1:${(before.httpServer.address() as AddressInfo).port}/`,
    );
  } finally {
    await before.close();
  }
  const after = await createPublicWebServer({
    root: path.join(root, "dist"),
    allowedHosts: ["127.0.0.1"],
    app: { fetch: () => new Response(null, { status: 404 }) },
    logger: { info() {}, warn() {} },
  });
  await new Promise<void>((resolve) => after.listen(0, "127.0.0.1", resolve));
  try {
    const result = await measure(`http://127.0.0.1:${(after.address() as AddressInfo).port}/`);
    console.log(
      JSON.stringify(
        {
          fixture:
            "fresh sign-in navigation; identical mocked API; cold browser context; first-party requests only; external resources blocked",
          before: baseline,
          after: result,
        },
        null,
        2,
      ),
    );
    if (
      baseline.jsRawBytes !== result.jsRawBytes ||
      baseline.jsGzipBytes !== result.jsGzipBytes ||
      baseline.jsRequests !== result.jsRequests
    )
      process.exitCode = 1;
  } finally {
    after.closeAllConnections();
    await new Promise<void>((resolve) => after.close(() => resolve()));
  }
} finally {
  await browser.close();
}
