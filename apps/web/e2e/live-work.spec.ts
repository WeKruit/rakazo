import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/live-work.html";
const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

test("a running turn shows its steps in plain words with a clock, then folds", async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?phase=live`);
    const live = page.getByTestId("live-work");
    await expect(live.getByRole("status")).toContainText("Searching candidates…");
    await expect(live).toContainText("Reviewing the role");
    await expect(live).toContainText("Reviewing candidates");
    await expect(live).toContainText(/0:4\d/);
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
    await captureScreenshot(page, testInfo, `live-work-running-${viewport.name}`);

    await page.goto(`${fixture}?phase=done`);
    const summary = page.getByTestId("work-summary");
    await expect(summary.locator("summary")).toHaveText("Worked for 1m 12s");
    await expect(summary.getByText("Reviewing candidates")).toBeHidden();
    await captureScreenshot(page, testInfo, `live-work-done-${viewport.name}`);
    await summary.locator("summary").click();
    await expect(summary.getByText("Reviewing candidates")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
    await captureScreenshot(page, testInfo, `live-work-expanded-${viewport.name}`);
  }
});
