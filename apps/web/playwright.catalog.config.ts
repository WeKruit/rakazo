import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5202";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Catalog acceptance requires a local synthetic fixture server");
}
export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "i18n-feature-catalog.spec.ts",
    "auth-client-boundary.spec.ts",
    "recruiting-app-routes.spec.ts",
    "recruiting-lingui.spec.ts",
    "recruiting-contacts-cold.spec.ts",
  ],
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: { baseURL, ...devices["Desktop Chrome"] },
  outputDir: "/tmp/d1-catalog-browser",
});
