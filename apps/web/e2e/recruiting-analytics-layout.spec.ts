import { expect, test } from "@playwright/test";
import { appGroupId, appRoleId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [320, 1440]) {
  test(`analytics scoped charts, export and people drill at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockRecruitingApp(page);
    const reads: Record<string, unknown>[] = [];
    for (const path of ["mcp/servers/list", "mcp/assignments/all"])
      await page.route(`**/rpc/${path}`, (route) => route.fulfill({ json: { json: [] } }));
    await page.route("**/rpc/recruiting/analytics", (route) =>
      route.fulfill({
        json: {
          json: {
            roles: [{ id: appRoleId, title: "Platform Engineer", groupId: appGroupId }],
            trend: [
              { date: "2026-10-02", contacted: 2, replied: 1 },
              { date: "2026-10-16", contacted: 3, replied: 1 },
            ],
            groups: [{ roleId: appRoleId, title: "Platform Engineer", contacted: 5, replied: 2 }],
            observedShortlistedPeople: 3,
            shortlistDateUnknownPeople: 0,
            observedContactedPeople: 5,
            observedRepliedPeople: 2,
            firstContactedPeople: null,
            replyRate: null,
            coverage: "partial",
            sources: {
              storedCrmMessages: "observed",
              nativeCorrespondence: "not_included",
              importedCorrespondence: "not_included",
              firstSendHistory: "unknown",
              replyClassification: "unknown",
              identityResolution: "partial",
              shortlistHistory: "unknown",
            },
          },
        },
      }),
    );
    await page.route("**/rpc/recruiting/analyticsPeople", async (route) => {
      reads.push(route.request().postDataJSON().json);
      await route.fulfill({
        json: {
          json: {
            items: [
              {
                key: "internal-person-key",
                name: "Avery Example",
                email: "avery@example.test",
                linkedinUrl: "https://www.linkedin.com/in/synthetic-profile-0",
                contactedAt: "2026-10-02T10:00:00Z",
                repliedAt: "2026-10-03T12:00:00Z",
                shortlistedAt: null,
                roles: [{ id: appRoleId, title: "Platform Engineer" }],
              },
            ],
            total: 1,
            nextCursor: null,
            coverage: "partial",
          },
        },
      });
    });
    await page.goto(
      `/app?view=analytics&role=${appRoleId}&analyticsSince=2026-10-01&analyticsUntil=2026-10-31`,
    );
    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Observed contact cohort", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Replies to that cohort", exact: true }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "Grouped by", exact: true }).selectOption("week");
    await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("period");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("outreach-analytics.csv");
    await page.getByRole("button", { name: "View observed contacted people", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Avery Example");
    await expect(dialog).not.toContainText("internal-person-key");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads)
      expect(read).toEqual(
        expect.objectContaining({
          roleId: appRoleId,
          metric: "contacted",
          limit: 50,
          since: "2026-10-01T00:00:00Z",
          until: "2026-11-01T00:00:00.000Z",
        }),
      );
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`analytics-${width}.png`), fullPage: true });
    expect(fixture.unknown).toEqual([]);
  });
}
