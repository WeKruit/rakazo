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

test("people open in a detail panel beside the workbench", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${fixture}?view=contacts`);
  await page.getByRole("button", { name: "Avery Example", exact: true }).click();
  const panel = page.getByTestId("recruiting-detail-panel");
  await expect(panel.getByRole("heading", { name: "Avery Example", exact: true })).toBeVisible();
  // The contacts table stays on screen beside the panel.
  await expect(page.getByRole("region", { name: "Contacts" })).toBeVisible();
  await captureScreenshot(page, testInfo, "panel-profile");
  await panel.getByRole("button", { name: "Emails" }).click();
  await expect(panel.getByText("free Tuesday or Wednesday").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "panel-thread");
  await panel.getByRole("button", { name: "Back" }).click();
  await expect(panel.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Contacts" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Avery Example", exact: true }).click();
  await expect(panel).toBeVisible();
  await captureScreenshot(page, testInfo, "panel-narrow");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("duplicate role names have visible creation dates", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${fixture}?view=results&duplicate-roles`);
  const roles = page.getByRole("navigation", { name: "Role conversations" });
  await expect(roles.locator("time")).toHaveCount(2);
  await expect(roles.locator("time").first()).toHaveAttribute(
    "datetime",
    "2026-10-22T10:00:00.000Z",
  );
  await expect(roles.locator("time").last()).toHaveAttribute(
    "datetime",
    "2026-10-24T10:00:00.000Z",
  );
  await captureScreenshot(page, testInfo, "duplicate-role-dates");
  await noHorizontalScroll(page);
});

test("profile notes save and tasks render at desktop and phone widths", async ({
  page,
}, testInfo) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`${fixture}?view=contacts`);
    await page.getByRole("button", { name: "Avery Example", exact: true }).click();
    const panel = page.getByTestId("recruiting-detail-panel");
    await panel.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(panel.getByText("No notes yet.")).toBeVisible();
    await panel.getByRole("textbox", { name: "Note", exact: true }).fill("Follow up next week");
    await panel.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(panel.getByText("Follow up next week")).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("");
    await captureScreenshot(page, testInfo, `profile-notes-${width}`);
    await panel.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Create reminder", exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `profile-tasks-${width}`);
    await noHorizontalScroll(page);
  }
});

test("a linked CRM role has one canonical Inbox with connected history and reply drafting", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${fixture}?view=inbox`);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toHaveCount(1);
  await expect(page.getByText("free Tuesday or Wednesday").first()).toBeVisible();
  await expect(page.getByLabel("Service connections")).toContainText("Configured");
  await expect(page.getByText("Earlier history", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft reply", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "canonical-crm-inbox");
  await noHorizontalScroll(page);
});
