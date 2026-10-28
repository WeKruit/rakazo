import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicWebServer, hostAccepted } from "./public-web.js";

let directory: string;
let server: Server;
let origin: string;
const logger = { warn: vi.fn(), info: vi.fn() };
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "rakazo-public-web-"));
  const root = path.join(directory, "dist");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(
    path.join(root, "index.html"),
    '<!doctype html><title>Test app</title><script nonce="__RAKAZO_CSP_NONCE__">1</script>',
  );
  await writeFile(path.join(root, "html-preview.html"), "<!doctype html><title>Preview</title>");
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
  it("sends a fresh nonce in the page and an enforced strict policy", async () => {
    const nonces = [];
    for (const route of ["/", "/index.html", "/roles/test"]) {
      const res = await fetch(`${origin}${route}`, { headers: { accept: "text/html" } });
      const policy = res.headers.get("content-security-policy") ?? "";
      const nonce = policy.match(/script-src 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'/)?.[1];
      expect(nonce).toHaveLength(24);
      const html = await res.text();
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).not.toContain("__RAKAZO_CSP_NONCE__");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'none'");
      expect(policy).not.toContain("unsafe-eval");
      expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
      nonces.push(nonce);
    }
    expect(new Set(nonces).size).toBe(3);
    const asset = await fetch(`${origin}/assets/app.js`);
    expect(asset.headers.get("content-security-policy")).toBeNull();
    const preview = await fetch(`${origin}/html-preview.html`);
    expect(preview.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self'; sandbox allow-scripts",
    );
    expect(await preview.text()).toContain("Preview");
  });
  it("only reports the policy for a build without nonces", async () => {
    const root = path.join(directory, "plain");
    await mkdir(root);
    await writeFile(path.join(root, "index.html"), "<!doctype html><script>1</script>");
    const plain = await createPublicWebServer({ app: new Hono(), root, allowedHosts: [], logger });
    await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/`);
      expect(res.headers.get("content-security-policy")).toBeNull();
      expect(res.headers.get("content-security-policy-report-only")).toContain("'strict-dynamic'");
    } finally {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
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
    expect(logger.warn).toHaveBeenCalledWith("public web refused host", {
      "http.host": "attacker.example",
    });
    expect((await rawRequest("/%zz")).status).toBe(400);
    expect((await fetch(origin, { method: "POST" })).status).toBe(405);
  });
  it("fails startup without a built index", async () => {
    await expect(
      createPublicWebServer({ app: new Hono(), root: directory, allowedHosts: [], logger }),
    ).rejects.toThrow();
  });
});

describe("production host headers", () => {
  // The hosts the hosting proxy and the custom domain send, as the release configures them.
  const allowed = ["headhunter.example.com", "org--rakazo-recruiting.modal.run"];
  it.each([
    "headhunter.example.com",
    "org--rakazo-recruiting.modal.run",
    "10.4.2.7",
    "127.0.0.1",
    "[::1]",
    "[fd00::2]",
    "localhost",
  ])("serves %s", (host) => {
    expect(hostAccepted(new URL(`http://${host}:8000`).hostname, allowed)).toBe(true);
  });
  it.each(["attacker.example", "headhunter.example.com.attacker.example", "modal.run"])(
    "refuses %s",
    (host) => {
      expect(hostAccepted(new URL(`http://${host}`).hostname, allowed)).toBe(false);
    },
  );
  it("serves pages, readiness and RPC for an address Host header", async () => {
    for (const host of ["10.4.2.7:8000", "[fd00::2]:8000"]) {
      expect((await rawRequest("/", { host, accept: "text/html" })).status).toBe(200);
      expect((await rawRequest("/ready", { host })).status).toBe(200);
    }
  });
});
