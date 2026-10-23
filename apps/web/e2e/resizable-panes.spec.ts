import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/resizable-panes.html";
test("pane drag and keyboard widths persist and respect mobile and RTL layouts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(fixture);
  const nav = page.getByRole("separator", { name: "Resize navigation" });
  const chat = page.getByRole("separator", { name: "Resize chat" });
  await nav.focus();
  await page.keyboard.press("End");
  await expect(nav).toHaveAttribute("aria-valuenow", "480");
  const handle = (await chat.boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x - 97, handle.y + 100, { steps: 8 });
  await page.mouse.up();
  await expect(chat).toHaveAttribute("aria-valuenow", "460");
  await page.reload();
  await expect(nav).toHaveAttribute("aria-valuenow", "480");
  await expect(chat).toHaveAttribute("aria-valuenow", "460");
  await captureScreenshot(page, info, "panes-desktop-resized");
  await page.goto(`${fixture}?dir=rtl`);
  await chat.focus();
  await page.keyboard.press("ArrowRight");
  await expect(chat).toHaveAttribute("aria-valuenow", "476");
  await chat.dblclick();
  await expect(chat).toHaveAttribute("aria-valuenow", "360");
  await captureScreenshot(page, info, "panes-rtl");
  await page.setViewportSize({ width: 940, height: 900 });
  await expect(chat).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Role conversation" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await captureScreenshot(page, info, "panes-mobile");
});
test("right detail bounds reserve the current navigation width", async ({ page }, info) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${fixture}?detail=1`);
  const nav = page.getByRole("separator", { name: "Resize navigation" });
  const detail = page.getByRole("separator", { name: "Resize panel" });
  await nav.focus();
  await page.keyboard.press("End");
  await expect(detail).toHaveAttribute("aria-valuemax", "700");
  await detail.focus();
  await page.keyboard.press("End");
  await expect(page.getByTestId("side-panel")).toHaveCSS("width", "700px");
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(detail).toHaveAttribute("aria-valuemax", "320");
  await captureScreenshot(page, info, "panes-detail-constrained");
});
