import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["candidate-virtualization.spec.ts", "transcript-virtualization.spec.ts"],
  workers: 1,
  use: { headless: true, viewport: { width: 1440, height: 900 } },
});
