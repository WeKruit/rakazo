import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

test("cold contacts retain directory, keyboard detail navigation, and return focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await expect(panel.getByRole("region", { name: "Agent assessment", exact: true })).toContainText(
    "deployment scale is not stated",
  );
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(person).toBeFocused();
  expect(fixture.unknown).toEqual([]);
});
