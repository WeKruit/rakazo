import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "recruiting-query.spec.ts",
  workers: 1,
  timeout: 60000,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5184", headless: true },
  reporter: "list",
  outputDir: "/tmp/rakazo-d2-playwright",
});
