import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
  throw new Error("A3 measurements require a loopback fixture server");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "a3-pagination.spec.ts",
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: { baseURL, ...devices["Desktop Chrome"] },
});
