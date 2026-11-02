import { expect, test } from "@playwright/test";
import { appGroupId, appRoleId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [320, 1440]) {
  test(`shortlist table, same-pool board, review and insights at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockRecruitingApp(page);
    const campaignId = "00000000-0000-4000-8000-000000000099";
    const commands: string[] = [];
    await page.route("**/rpc/recruiting/accountView", async (route) => {
      const input = route.request().postDataJSON()?.json;
      if (input?.view !== "sequence") return route.fallback();
      await route.fulfill({
        json: {
          json: {
            roles: [
              {
                id: appRoleId,
                title: "Staff Platform Engineer",
                threadId: "fixture-thread",
                groupId: appGroupId,
                stage: "saved",
              },
            ],
            items: [
              {
                roleId: appRoleId,
                campaign: {
                  status: "ready",
                  serverId: "fixture-mail",
                  campaign: {
                    id: campaignId,
                    name: "Platform outreach",
                    eaccount: "recruiter@example.test",
                    status: 0,
                    stopOnReply: true,
                  },
                  leads: [],
                },
              },
            ],
            nextCursor: null,
          },
        },
      });
    });
    await page.route("**/rpc/recruiting/sequenceDraft", async (route) => {
      const command = route.request().postDataJSON()?.json?.command;
      commands.push(command?.operation);
      await route.fulfill({
        json: {
          json: {
            roleId: appRoleId,
            roleTitle: "Staff Platform Engineer",
            mailboxes: ["recruiter@example.test"],
            campaign: {
              id: campaignId,
              name: "Platform outreach",
              status: 0,
              editable: true,
              eaccount: "recruiter@example.test",
              steps: [
                {
                  subject: "Saved subject",
                  body: "Actual saved sequence email for review.",
                  delay_days: 0,
                },
              ],
              timezone: "America/Chicago",
              send_hours: "weekdays_9_to_5",
            },
          },
        },
      });
    });
    await page.goto(`/app/g/${appGroupId}?view=shortlist`);
    await expect(
      page.getByRole("button", { name: "Avery Example", exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const board = page.getByRole("region", { name: "Shortlist board", exact: true });
    await expect(board.getByRole("button", { name: "Avery Example", exact: true })).toBeVisible();
    await test.info().attach(`shortlist-board-${width}`, {
      body: await page.screenshot({
        fullPage: true,
        path: test.info().outputPath(`shortlist-${width}-${Date.now()}.png`),
      }),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select Avery Example", exact: true }).check();
    await expect(
      page.getByRole("toolbar", { name: "Selected candidates", exact: true }),
    ).toContainText("1 selected");
    await page
      .getByRole("toolbar", { name: "Selected candidates", exact: true })
      .getByRole("button", { name: "Add to sequence", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Sequence", exact: true }).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Preview steps", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Actual saved sequence email for review.");
    await test.info().attach(`enrollment-preview-${width}`, {
      body: await page.screenshot({
        path: test.info().outputPath(`enrollment-preview-${width}.png`),
        fullPage: true,
      }),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(commands).toEqual(["read"]);
    await page
      .getByRole("toolbar", { name: "Selected candidates", exact: true })
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await page.getByRole("button", { name: "Request review", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Review all 1 shortlisted candidates");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "View insights", exact: true }).click();
    await expect(page.getByRole("region", { name: "Talent insights", exact: true })).toContainText(
      "1 shortlisted candidates",
    );
    await test.info().attach(`shortlist-insights-${width}`, {
      body: await page.screenshot({
        fullPage: true,
        path: test.info().outputPath(`shortlist-${width}-${Date.now()}.png`),
      }),
      contentType: "image/png",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "Back to shortlist", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Avery Example", exact: true }).first(),
    ).toBeVisible();
    expect(fixture.unknown).toEqual([]);
  });
}
