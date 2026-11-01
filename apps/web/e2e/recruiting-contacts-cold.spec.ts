import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

test("cold contacts retain directory, keyboard detail navigation, and return focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const fixture = await mockRecruitingApp(page);
  await page.goto(`/app/g/${appGroupId}?view=contacts`);
  const person = page.getByRole("button", { name: "Avery Example", exact: true }).first();
  await expect(person).toBeVisible();
  const layout = page.getByRole("group", { name: "Contact layout", exact: true });
  await layout.getByRole("button", { name: "Cards", exact: true }).click();
  await expect(person).toBeVisible();
  await layout.getByRole("button", { name: "Table", exact: true }).click();
  await person.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("recruiting-detail-panel");
  await expect(panel.getByRole("heading", { name: "Avery Example", exact: true })).toBeVisible();
  const linkedin = panel.locator('a[href="https://www.linkedin.com/in/synthetic-profile-0"]');
  await expect(linkedin).toBeVisible();
  await expect(linkedin.locator("svg")).toHaveCSS("fill", "rgb(10, 102, 194)");
  await expect(
    panel
      .locator("dt")
      .filter({ hasText: /^Email$/ })
      .locator("svg"),
  ).toHaveCSS("color", "rgb(37, 99, 235)");
  await panel.getByRole("button", { name: "Show all 5 criteria", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Agent assessment", exact: true })).toContainText(
    "deployment scale is not stated",
  );
  await panel.getByRole("button", { name: "Expand profile", exact: true }).click();
  await expect(page.getByTestId("recruiting-detail-panel")).toHaveCount(1);
  await expect(panel.getByRole("region", { name: "Agent assessment", exact: true })).toContainText(
    "deployment scale is not stated",
  );
  await panel.getByRole("button", { name: "Collapse profile", exact: true }).click();
  await test.info().attach("profile-drawer-1440", {
    body: await page.screenshot({
      path: test.info().outputPath("profile-drawer-1440.png"),
      fullPage: true,
    }),
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(person).toBeFocused();
  expect(fixture.unknown).toEqual([]);
});
