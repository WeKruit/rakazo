/** Local C6 TTFB comparison. Requires a production web build; never connects to a database. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { preview } from "vite";
import { createPublicWebServer } from "../../api/src/public-web.js";

const root = path.resolve(import.meta.dirname, "..");
const count = 200;
const concurrency = 20;
async function measure(origin: string) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const request = () =>
    new Promise<number>((resolve, reject) => {
      const start = performance.now();
      const req = http.get(
        origin,
        { agent, headers: { accept: "text/html", "accept-encoding": "gzip" } },
        (res) => {
          const ttfb = performance.now() - start;
          res.resume();
          res.on("end", () =>
            res.statusCode === 200 ? resolve(ttfb) : reject(new Error(`HTTP ${res.statusCode}`)),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
    });
  try {
    for (let index = 0; index < 20; index++) await request();
    const times: number[] = [];
    for (let index = 0; index < count; index += concurrency) {
      times.push(...(await Promise.all(Array.from({ length: concurrency }, request))));
    }
    times.sort((a, b) => a - b);
    return {
      requests: times.length,
      concurrency,
      errors: 0,
      p50Ms: +times[99]!.toFixed(2),
      p95Ms: +times[189]!.toFixed(2),
      maxMs: +times[199]!.toFixed(2),
    };
  } finally {
    agent.destroy();
  }
}

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
    JSON.stringify({ node: process.version, warmup: 20, before: baseline, after: result }, null, 2),
  );
  if (result.p95Ms >= 200) process.exitCode = 1;
} finally {
  after.closeAllConnections();
  await new Promise<void>((resolve) => after.close(() => resolve()));
}
