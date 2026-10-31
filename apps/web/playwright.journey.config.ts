import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const port = Number(process.env.WEB_PORT ?? 5197);
export default defineConfig({
  ...base,
  testMatch: "recruiting-global-journey.spec.ts",
  outputDir: "../../test-report/e2e/recruiting-journey-results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "../../test-report/e2e/recruiting-journey-report" }],
  ],
  workers: 1,
  webServer: {
    command: `pnpm build && pnpm exec vite preview --port ${port} --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 180000,
  },
});
