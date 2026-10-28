import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { attachNovncProxy } from "@rakazo/core/node/novnc-proxy";
import type { Logger } from "@rakazo/logging";
import { Hono } from "hono";
import { compress } from "hono/compress";

/** Public listener owned by the API process; internal API routes stay on loopback. */
export async function createPublicWebServer(options: {
  app: Pick<Hono, "fetch">;
  root: string;
  allowedHosts: string[];
  screen?: { secret: string; api: string };
  logger: Pick<Logger, "warn" | "info">;
}) {
  const root = await realpath(options.root);
  // Fail startup if the build was not copied into the image.
  const index = await realpath(path.join(root, "index.html"));
  if (!index.startsWith(`${root}${path.sep}`))
    throw new Error("Web index must be inside the static root");
  const rejected = new Set<string>();
  const accepts = (hostname: string) => {
    if (hostAccepted(hostname, options.allowedHosts)) return true;
    // Name the refused host once so a hosting proxy's Host header is visible in the logs.
    if (rejected.size < 20 && !rejected.has(hostname)) {
      rejected.add(hostname);
      options.logger.warn("public web refused host", { "http.host": hostname });
    }
    return false;
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!accepts(new URL(c.req.url).hostname)) return c.body(null, 403);
    c.header("x-content-type-options", "nosniff");
    await next();
  });
  // Explicit public routes: never expose /internal or turn missing RPCs into HTML.
  for (const route of ["/api", "/api/*", "/rpc", "/rpc/*", "/ready", "/health"]) {
    app.all(route, (c) => options.app.fetch(c.req.raw));
  }
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD"].includes(c.req.method)) return c.body(null, 405);
    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      return c.body(null, 400);
    }
    if (
      pathname.includes("\\") ||
      pathname.includes("\0") ||
      pathname.split("/").some((segment) => segment.startsWith(".")) ||
      /^\/(?:internal|novnc)(?:\/|$)/.test(pathname)
    )
      return c.notFound();
    const file = path.resolve(root, `.${pathname}`);
    const entry = await stat(file).catch(() => null);
    const resolved = await realpath(
      entry?.isDirectory() ? path.join(file, "index.html") : file,
    ).catch(() => null);
    if (resolved && resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      return c.notFound();
    c.header("cache-control", "no-cache");
    await next();
  });
  app.use("*", compress());
  app.use("*", serveStatic({ root }));
  app.get("*", async (c, next) => {
    // Only browser navigations get SPA fallback; missing modules must remain 404.
    if (!c.req.header("accept")?.includes("text/html") || path.extname(c.req.path))
      return c.notFound();
    return serveStatic({ path: path.join(root, "index.html") })(c, next);
  });
  const listener = getRequestListener(app.fetch);
  const server = createServer();
  if (options.screen) {
    attachNovncProxy(
      {
        httpServer: server,
        middlewares: {
          use(handler) {
            server.on("request", (req, res) => {
              // Check Host before proxying too: the proxy is outside Hono's middleware.
              if (!allowedHost(req.headers.host, accepts)) {
                res.writeHead(403).end();
                return;
              }
              handler(req, res, () => {
                void listener(req, res);
              });
            });
          },
        },
      },
      options.screen.secret,
      options.screen.api,
      options.logger,
    );
    // Prepend so invalid hosts cannot reach the screen upgrade handler.
    server.prependListener("upgrade", (req, socket) => {
      if (!allowedHost(req.headers.host, accepts) || !req.url?.startsWith("/novnc/"))
        socket.destroy();
    });
  } else {
    server.on("request", listener);
    server.on("upgrade", (_req, socket) => socket.destroy());
  }
  return server;
}

/**
 * The configured names, plus localhost and IP addresses as Vite preview allowed: a hosting
 * proxy can reach the container by address. Other names stay refused (DNS rebinding).
 */
export function hostAccepted(hostname: string, allowed: readonly string[]) {
  return (
    allowed.includes(hostname) ||
    hostname === "localhost" ||
    isIP(hostname.replace(/^\[(.*)\]$/, "$1")) !== 0
  );
}

function allowedHost(host: string | undefined, accepts: (hostname: string) => boolean) {
  try {
    return Boolean(host && accepts(new URL(`http://${host}`).hostname));
  } catch {
    return false;
  }
}
