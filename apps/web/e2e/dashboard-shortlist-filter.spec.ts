import { expect, test } from "@playwright/test";
import { appGroupId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`weekly shortlist keeps exact dates through clear, back and reload at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date(checkedAt));
    await mockRecruitingApp(page);
    await page.goto(`/app/g/${appGroupId}?view=home`);
    const chart = page.getByRole("region", { name: "Shortlisted profiles", exact: true });
    await chart.locator("ol button").last().click();
    await chart
      .getByRole("list", { name: "Projects", exact: true })
      .getByRole("button")
      .first()
      .click();
    await expect(page).toHaveURL(/view=contacts.*shortlistFrom=/);
    await page.getByRole("button", { name: "Collapse role chat", exact: true }).click();
    const contacts = page.getByRole("region", { name: "Contacts", exact: true });
    const clear = page.getByRole("button", { name: "Clear date filter", exact: true });
    await expect(clear).toBeVisible();
    await expect(contacts.getByText("Avery Example", { exact: true })).toBeVisible();
    await expect(contacts.getByText("Blake Sample", { exact: true })).toHaveCount(0);
    const filteredUrl = page.url();
    await clear.click();
    await expect(page).not.toHaveURL(/shortlistFrom=/);
    await expect(contacts.getByText("Blake Sample", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    await expect(clear).toBeVisible();
    await expect(contacts.getByText("Blake Sample", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(clear).toBeVisible();
    await expect(contacts.getByText("Avery Example", { exact: true })).toBeVisible();
    await expect(contacts.getByText("Blake Sample", { exact: true })).toHaveCount(0);
    const path = info.outputPath(`weekly-shortlist-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(`weekly-shortlist-${width}`, { path, contentType: "image/png" });
    const foreign = new URL(filteredUrl);
    foreign.searchParams.set("shortlistRole", "other-role");
    await page.goto(foreign.toString());
    await expect(
      page.getByText("This filter belongs to another role.", { exact: true }),
    ).toBeVisible();
    await expect(contacts.getByText("Avery Example", { exact: true })).toHaveCount(0);
  });
}
