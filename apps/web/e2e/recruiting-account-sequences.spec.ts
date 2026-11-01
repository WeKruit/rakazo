import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390, 320])
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
    await expect(main.getByRole("combobox", { name: "Sequence date range" })).toHaveCount(0);
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

for (const width of [1440, 390])
  test(`saved campaigns render the first bounded page without waiting for later pages at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockRecruitingApp(page);
    const reads: Record<string, unknown>[] = [];
    let release!: () => void;
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/rpc/recruiting/accountView", async (route) => {
      const input = route.request().postDataJSON().json as Record<string, unknown>;
      if (!input.sequenceSummary) return route.fallback();
      reads.push(input);
      const offset = Number(input.cursor ?? 0);
      if (offset) await later;
      const count = Math.min(25, 61 - offset);
      return route.fulfill({
        json: {
          json: {
            roles: [
              {
                id: "fixture-recruiting-role",
                title: "Platform Engineer",
                threadId: "fixture-thread",
                groupId: appGroupId,
                stage: "outreach",
              },
            ],
            items: Array.from({ length: count }, (_, index) => ({
              roleId: "fixture-recruiting-role",
              campaigns: [
                {
                  status: "ready",
                  sourceKind: "native",
                  serverId: "fixture-source",
                  leads: [],
                  leadsComplete: false,
                  stats: { sent: 4, opened: 3, replied: 1 },
                  campaign: {
                    id: `saved-${offset + index}`,
                    name: `Saved campaign ${offset + index + 1}`,
                    eaccount: null,
                    status: 1,
                    stopOnReply: null,
                  },
                },
              ],
            })),
            total: 61,
            nextCursor: offset + count < 61 ? String(offset + count) : null,
            sequenceSummary: {
              contacted: null,
              active: null,
              opened: 3,
              clicked: null,
              replied: 1,
              interested: null,
              sent: 4,
              partial: true,
            },
          },
        },
      });
    });
    await page.goto("/app?view=sequence&role=all");
    const main = page.getByTestId("account-sequences");
    await expect(main.getByRole("link", { name: "Saved campaign 1", exact: true })).toBeVisible();
    await expect(main.locator("tbody tr")).toHaveCount(25);
    await expect(main).toContainText("61 sequences");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ sequenceSummary: true, limit: 25 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`saved-sequences-page-${width}.png`),
      fullPage: true,
    });
    await main.getByRole("button", { name: "Next", exact: true }).click();
    await expect.poll(() => reads.length).toBe(2);
    expect(reads[1]).toMatchObject({ cursor: "25", limit: 25 });
    await expect(main).toContainText("Loading sequences…");
    release();
    await expect(main.getByRole("link", { name: "Saved campaign 26", exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Saved campaign 1", exact: true })).toHaveCount(0);
    expect(fixture.unknown).toEqual([]);
  });
