import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const port = Number(process.env.WEB_PORT ?? 5199);
// These actual-app route checks use a fixed build, so unrelated edits cannot reload a test mid-action.
const outDir = "../../test-report/e2e/recruiting-web-build";
export default defineConfig({
  ...base,
  testMatch: ["recruiting-global.spec.ts", "recruiting-app-routes.spec.ts"],
  workers: 1,
  outputDir: "../../test-report/e2e/global-routes",
  webServer: {
    command: `pnpm build --outDir ${outDir} --emptyOutDir && pnpm exec vite preview --outDir ${outDir} --port ${port} --host 127.0.0.1`,
    env: { SCREEN_PROXY_SECRET: "offline-recruiting-screen-proxy-secret-32chars" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 180000,
  },
});
