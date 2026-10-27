import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicWebServer } from "./public-web.js";

let directory: string;
let server: Server;
let origin: string;
const logger = { warn: vi.fn(), info: vi.fn() };
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "rakazo-public-web-"));
  const root = path.join(directory, "dist");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Test app</title>");
  await writeFile(path.join(root, "assets/app.js"), 'console.log("test");'.repeat(200));
  await writeFile(path.join(directory, "private.txt"), "never public");
  await writeFile(path.join(root, ".env"), "never public");
  await symlink(path.join(directory, "private.txt"), path.join(root, "leak.txt"));
  await mkdir(path.join(root, "nested"));
  await symlink(path.join(directory, "private.txt"), path.join(root, "nested/index.html"));
  const app = new Hono();
  app.get("/internal/health", (c) => c.text("private internals"));
  app.get("/ready", (c) => c.json({ ok: true }));
  app.get("/api/session", (c) => c.json({ cookie: c.req.header("cookie") }));
  app.post("/rpc/echo", async (c) => c.json(await c.req.json()));
  server = await createPublicWebServer({ app, root, allowedHosts: ["127.0.0.1"], logger });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

function rawRequest(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get(`${origin}${url}`, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
  });
}

describe("production public listener", () => {
  it("serves the build, navigation fallback, HEAD and compressed assets", async () => {
    for (const route of ["/", "/roles/test"]) {
      const res = await fetch(`${origin}${route}`, { headers: { accept: "text/html" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Test app");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
    const head = await fetch(`${origin}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const asset = await fetch(`${origin}/assets/app.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await asset.text()).toContain('console.log("test")');
  });
  it("preserves API cookies, request bodies and readiness without exposing internals", async () => {
    const session = await fetch(`${origin}/api/session`, { headers: { cookie: "session=fake" } });
    expect(await session.json()).toEqual({ cookie: "session=fake" });
    const echo = await fetch(`${origin}/rpc/echo`, {
      method: "POST",
      body: JSON.stringify({ test: true }),
      headers: { "content-type": "application/json" },
    });
    expect(await echo.json()).toEqual({ test: true });
    expect(await (await fetch(`${origin}/ready`)).json()).toEqual({ ok: true });
  });
  it.each([
    "/internal/health",
    "/internal/screen-target",
    "/.env",
    "/%2eenv",
    "/leak.txt",
    "/nested/",
    "/assets/missing.js",
    "/api/missing",
    "/rpc/missing",
    "/novnc/session/view/fake/embed.html",
    "/%2e%2e%2fprivate.txt",
  ])("rejects %s even for HTML navigation", async (route) => {
    const res = await rawRequest(route, { accept: "text/html" });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("never public");
    expect(res.body).not.toContain("Test app");
  });
  it("rejects unknown hosts, malformed encoding and static writes", async () => {
    expect((await rawRequest("/", { host: "attacker.example" })).status).toBe(403);
    expect((await rawRequest("/%zz")).status).toBe(400);
    expect((await fetch(origin, { method: "POST" })).status).toBe(405);
  });
  it("fails startup without a built index", async () => {
    await expect(
      createPublicWebServer({ app: new Hono(), root: directory, allowedHosts: [], logger }),
    ).rejects.toThrow();
  });
});
