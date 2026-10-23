import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/recruiting-workbench.html";

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".recruiting-workspace-main");
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow).toEqual({ page: 0, main: 0 });
}

test("role workbench tabs render stored records without overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });

  await page.goto(`${fixture}?view=results`);
  await expect(page.getByTestId("role-list")).toContainText("Senior Perception Engineer");
  await expect(page.getByText("Avery Example").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-results");
  await noHorizontalScroll(page);

  await page.goto(`${fixture}?view=brief`);
  await expect(page.getByText("Own the perception stack").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-brief");

  await page.goto(`${fixture}?view=shortlist`);
  await expect(page.getByText("Avery Example").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-shortlist");

  await page.goto(`${fixture}?view=contacts`);
  await expect(page.getByText("Casey Placeholder").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-contacts");
  await noHorizontalScroll(page);

  await page.goto(`${fixture}?view=sequence`);
  await expect(page.getByText("Perception follow-up").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-sequence");

  await page.goto(`${fixture}?view=inbox`);
  await expect(page.getByText("free Tuesday or Wednesday").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-inbox");
  await noHorizontalScroll(page);

  await page.goto(`${fixture}?view=interview`);
  await expect(page.getByText("Devon Fixture").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workbench-interview");
});

test("role workbench fits a phone-width viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ["results", "contacts", "sequence", "inbox", "interview"]) {
    await page.goto(`${fixture}?view=${view}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("status")).toHaveCount(0);
    await captureScreenshot(page, testInfo, `workbench-narrow-${view}`);
    await noHorizontalScroll(page);
  }
});

test("role workbench shows loading and empty states", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  for (const view of ["results", "contacts", "inbox"]) {
    await page.goto(`${fixture}?view=${view}&state=loading`);
    await expect(page.getByRole("status").first()).toBeVisible();
    await captureScreenshot(page, testInfo, `workbench-loading-${view}`);
    await page.goto(`${fixture}?view=${view}&state=empty`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("status")).toHaveCount(0);
    await captureScreenshot(page, testInfo, `workbench-empty-${view}`);
  }
});
