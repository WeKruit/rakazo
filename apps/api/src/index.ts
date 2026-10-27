import type { Socket } from "node:net";
import path from "node:path";
import { hostedStagingConfig } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

if (process.env.RAKAZO_RELEASE_PROFILE !== "staging") loadRootEnv();

import { serve } from "@hono/node-server";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createPublicWebServer } from "./public-web.js";
import { createStagingApp } from "./release-staging.js";

const staging = hostedStagingConfig(process.env);
const logger = createRootLogger(
  SERVICE_NAMES.api,
  staging ? { NODE_ENV: "production" } : process.env,
);
// performance.now() is ms since process start, so this includes node + import time.
logger.info("boot.phase", {
  phase: "imports.done",
  "boot.elapsed_ms": Math.round(performance.now()),
});

try {
  const env = staging ? { port: 3100, apiHost: "127.0.0.1" } : loadEnv();
  const { app, stop } = staging ? createStagingApp(staging) : await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("boot.phase", {
      phase: "listening",
      "boot.elapsed_ms": Math.round(performance.now()),
    });
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });

  const publicServer = process.env.WEB_STATIC_DIR
    ? await createPublicWebServer({
        app,
        root: path.resolve(process.env.WEB_STATIC_DIR),
        allowedHosts: [
          process.env.RAKAZO_HOST ?? "localhost",
          ...(process.env.RAKAZO_ALLOWED_HOSTS ?? "")
            .split(",")
            .map((host) => host.trim())
            .filter(Boolean),
        ],
        ...("screenProxySecret" in env
          ? { screen: { secret: env.screenProxySecret, api: `http://127.0.0.1:${env.port}` } }
          : {}),
        logger,
      })
    : undefined;
  if (publicServer) {
    publicServer.listen(Number(process.env.WEB_PORT ?? 5173), "0.0.0.0");
  }
  const servers = publicServer ? [server, publicServer] : [server];

  // Long-lived connections (threads.subscribe SSE streams) never end on their
  // own, so server.close() alone waits forever for them. Track sockets and
  // force-close any still open after a short grace period for in-flight
  // requests, or every restart/shutdown hangs until something force-kills it.
  const sockets = new Set<Socket>();
  for (const listener of servers)
    listener.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = Promise.all(
      servers.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))),
    );
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    await closed;
    clearTimeout(grace);
    await stop();
    await logger.flush({ timeoutMs: 2_000 });
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} catch (error) {
  if (staging) logger.error("restricted staging api startup failed");
  else logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
