import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import type { DesktopStackProbeResponse } from "@rakazo/contracts";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PreviewServer, ViteDevServer } from "vite";
import { defineConfig, loadEnv } from "vite";
import { attachNovncProxy } from "../../packages/core/src/node/novnc-proxy.ts";
import { resolveScreenProxySecret } from "../../packages/core/src/secrets-guard.ts";
import { createServiceLogger } from "../../packages/logging/src/env.ts";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const DESKTOP_STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";
const screenLog = createServiceLogger({ service: "rakazo-web" });

function equalStackToken(expected: string, supplied: string | string[] | undefined) {
  if (expected === "" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function attachDesktopStackProbe(
  server: ViteDevServer | PreviewServer,
  token: string,
  imageTag: string,
) {
  server.middlewares.use((req, res, next) => {
    if (req.url?.split("?", 1)[0] !== DESKTOP_STACK_PROBE_PATH) {
      next();
      return;
    }
    if (!equalStackToken(token, req.headers[DESKTOP_STACK_TOKEN_HEADER])) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const body: DesktopStackProbeResponse = { ok: true, imageTag };
    res.statusCode = 200;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  });
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const api = process.env.API_PROXY_TARGET ?? rootEnv.API_PROXY_TARGET ?? "http://127.0.0.1:3100";
  const previewHost = process.env.RAKAZO_HOST ?? rootEnv.RAKAZO_HOST ?? "localhost";
  const allowedHosts = [
    previewHost,
    ...(process.env.RAKAZO_ALLOWED_HOSTS ?? rootEnv.RAKAZO_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
  const screenProxySecret = () =>
    resolveScreenProxySecret({
      ...process.env,
      SCREEN_PROXY_SECRET: process.env.SCREEN_PROXY_SECRET ?? rootEnv.SCREEN_PROXY_SECRET,
      SANDBOX_SUPERVISOR_TOKEN:
        process.env.SANDBOX_SUPERVISOR_TOKEN ?? rootEnv.SANDBOX_SUPERVISOR_TOKEN,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? rootEnv.BETTER_AUTH_SECRET,
    });
  const performanceAssetDelayMs = Number(process.env.RAKAZO_PERFORMANCE_ASSET_DELAY_MS ?? 0);
  const desktopStackToken =
    process.env.RAKAZO_DESKTOP_STACK_TOKEN ?? rootEnv.RAKAZO_DESKTOP_STACK_TOKEN ?? "";
  const imageTag = process.env.RAKAZO_IMAGE_TAG ?? rootEnv.RAKAZO_IMAGE_TAG ?? "edge";
  return {
    plugins: [
      react(),
      babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] }),
      lingui(),
      tailwindcss(),
      {
        name: "rakazo-desktop-stack-probe",
        configureServer: (server) => attachDesktopStackProbe(server, desktopStackToken, imageTag),
        configurePreviewServer: (server) =>
          attachDesktopStackProbe(server, desktopStackToken, imageTag),
      },
      {
        name: "rakazo-performance-asset-delay",
        configurePreviewServer(server) {
          if (!Number.isFinite(performanceAssetDelayMs) || performanceAssetDelayMs <= 0) return;
          server.middlewares.use((req, _res, next) => {
            const pathname = req.url?.split("?", 1)[0] ?? "/";
            if (["/api", "/rpc", "/novnc"].some((prefix) => pathname.startsWith(prefix))) {
              next();
              return;
            }
            setTimeout(next, performanceAssetDelayMs);
          });
        },
      },
      {
        name: "rakazo-novnc-proxy",
        configureServer: (server) => attachNovncProxy(server, screenProxySecret(), api, screenLog),
        configurePreviewServer: (server) =>
          attachNovncProxy(server, screenProxySecret(), api, screenLog),
      },
    ],
    server: {
      host: process.env.RAKAZO_DEV_HOST ?? rootEnv.RAKAZO_DEV_HOST ?? "127.0.0.1",
      port: webPort,
      strictPort: true,
      allowedHosts,
      proxy: {
        "/ready": { target: api, changeOrigin: true, xfwd: true },
        "/api": { target: api, changeOrigin: true },
        "/rpc": { target: api, changeOrigin: true },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: Number(process.env.WEB_PORT ?? 5173),
      allowedHosts,
      proxy: {
        "/ready": { target: api, changeOrigin: true, xfwd: true },
        "/api": { target: api, changeOrigin: true },
        "/rpc": { target: api, changeOrigin: true },
      },
    },
  };
});
