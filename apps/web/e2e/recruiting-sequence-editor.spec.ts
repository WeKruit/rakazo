import { expect, test } from "@playwright/test";

for (const width of [1440, 320])
  test(`sequence editor saves and reopens at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/e2e/fixtures/recruiting-ui-implementation.html?surface=sequence");
    await expect(page.locator('textarea[name="body-0"]')).toHaveValue(/platform engineering work/);
    await page.getByRole("button", { name: "Go to email 2", exact: true }).click();
    await expect(page.locator('textarea[name="body-1"]')).toBeInViewport();
    await page.locator('textarea[name="body-1"]').fill("Saved follow up {{first_name}}");
    await page.getByRole("region", { name: "Email 2", exact: true }).locator("summary").click();
    await page.locator('input[name="delay-1"]').fill("5");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Reopen saved sequence" }).click();
    await expect(page.locator('textarea[name="body-1"]')).toHaveValue(
      "Saved follow up {{first_name}}",
    );
    await expect(page.locator('input[name="delay-1"]')).toHaveValue("5");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`sequence-${width}.png`),
      fullPage: true,
    });
  });
test("new draft and exact rich source remain separate", async ({ page }) => {
  await page.goto("/e2e/fixtures/recruiting-ui-implementation.html?surface=sequence&new");
  await expect(page.getByRole("button", { name: "Create draft", exact: true })).toBeVisible();
  await page.locator('input[name="sequence-name"]').fill("Created in fixture");
  await page.locator('select[name="sending-mailbox"]').selectOption("recruiter@example.test");
  await page.locator('input[name="subject-0"]').fill("Fixture subject");
  await page.locator('textarea[name="body-0"]').fill("Fixture body");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeVisible();
  await page.goto("/e2e/fixtures/recruiting-ui-implementation.html?surface=sequence&rich");
  await expect(page.getByText("Retained rich subject", { exact: true })).toBeVisible();
  await page.getByText("Original email content", { exact: true }).click();
  await expect(
    page.getByText("<p>Hello <strong>{{first_name}}</strong></p>", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('textarea[name="body-0"]')).toHaveCount(0);
});
