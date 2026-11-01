import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 320])
  test(`actual global Sequence overview and native drilldown at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockRecruitingApp(page, { multipleCampaigns: true });
    await page.goto("/app?view=sequence&role=all");
    const main = page.getByTestId("account-sequences");
    await expect(main).toBeVisible();
    await expect(main.getByRole("heading", { name: "Sequence", exact: true })).toBeVisible();
    await expect(main.locator("dt")).toHaveText([
      "Contacted",
      "Active",
      "Opened",
      "Clicked",
      "Replied",
      "Interested",
    ]);
    await expect(main.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(main.getByRole("combobox", { name: "Sequence date range" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
    await expect(main.getByRole("columnheader")).toHaveText([
      "Name",
      "Privacy",
      "Total",
      "Active",
      "Opened",
      "Clicked",
      "Replied",
      "Interested",
      "Bounced",
      "Created",
      "Actions",
    ]);
    await expect(main.getByRole("link", { name: "Platform outreach", exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Platform follow-up", exact: true })).toBeVisible();
    await main.getByRole("textbox", { name: "Search sequences" }).fill("follow-up");
    await expect(main.getByRole("link", { name: "Platform outreach", exact: true })).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Platform follow-up", exact: true })).toBeVisible();
    await main.getByRole("textbox", { name: "Search sequences" }).clear();
    const contactRead = page.waitForRequest(
      (request) =>
        request.url().includes("recruiting/accountView") &&
        request.postDataJSON()?.json?.sequenceContactQuery === "Avery",
    );
    await main.getByRole("textbox", { name: "Filter by saved contact" }).fill("Avery");
    await contactRead;
    const clearContact = page.waitForRequest(
      (request) =>
        request.url().includes("recruiting/accountView") &&
        !request.postDataJSON()?.json?.sequenceContactQuery,
    );
    await main.getByRole("textbox", { name: "Filter by saved contact" }).clear();
    await clearContact;
    await expect(main.getByRole("link", { name: "Platform follow-up", exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`global-sequences-${width}.png`),
      fullPage: true,
    });
    await main.getByRole("table").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`global-sequences-table-${width}.png`),
      fullPage: true,
    });
    await main.getByRole("link", { name: "Platform follow-up", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/app/g/${appGroupId}.*campaign=fixture-second-campaign`),
    );
    await expect(
      page.getByRole("heading", { name: "Platform follow-up", exact: true }),
    ).toBeVisible();
    await page.goto("/app?view=sequence&role=all");
    await page
      .getByTestId("account-sequences")
      .getByRole("button", { name: "New sequence", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Role for new sequence" })
      .selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/compose=new/);
    await expect(page.getByRole("dialog", { name: "New sequence", exact: true })).toBeVisible();
    expect(fixture.unknown).toEqual([]);
  });
