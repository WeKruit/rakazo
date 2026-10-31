import { expect, test } from "@playwright/test";
import { accountRolesData, accountItem as item } from "./fixtures/recruiting-account-data";
import { appRoleId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";
import { captureScreenshot } from "./helpers";

const roles = accountRolesData();

for (const width of [1440, 390]) {
  test(`global pages and in-place role filter show product records at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date(checkedAt));
    const fixture = await mockRecruitingApp(page, { nativeScheduling: true });
    const reads: { view: string; roleId?: string }[] = [];
    await page.route("**/rpc/recruiting/accountView", async (route) => {
      const input = route.request().postDataJSON().json;
      reads.push(input);
      const selected = roles.filter((role) => !input.roleId || input.roleId === role.id);
      await route.fulfill({
        json: {
          json: {
            roles,
            items: selected.map((role) => item(role, roles.indexOf(role))),
            nextCursor: null,
          },
        },
      });
    });
    for (const [view, row] of [
      ["contacts", "Avery Example"],
      ["shortlist", "Avery Example"],
      ["sequence", "Platform outreach"],
      ["inbox", "Tuesday afternoon works"],
      ["interview", "Avery platform interview"],
      ["tasks", "Prepare platform interview"],
    ] as const) {
      await page.goto(`/app?view=${view}&role=all`);
      const main = page.getByTestId("account-recruiting-view");
      await expect(main).toBeVisible();
      await expect(main.getByText(row, { exact: false }).first()).toBeVisible();
      const picker = main.getByRole("combobox", { name: "Role", exact: true });
      await expect(picker).toHaveValue("all");
      if (view === "sequence") {
        const campaign = main.getByRole("region", { name: "Staff Platform Engineer", exact: true });
        for (const [label, count] of [
          ["Sent", "3"],
          ["Opened", "2"],
          ["Replied", "1"],
        ])
          await expect(
            campaign
              .locator("dt")
              .filter({ hasText: new RegExp(`^${label}$`) })
              .locator("..")
              .locator("dd"),
          ).toHaveText(count);
      }
      await captureScreenshot(page, testInfo, `global-${view}-${width}`);
      await picker.selectOption(appRoleId);
      await expect(page).toHaveURL(new RegExp(`view=${view}.*role=${appRoleId}`));
      await expect(
        main.getByText("Product Designer", { exact: true }).filter({ visible: true }),
      ).toHaveCount(0);
      await expect(main.getByText(row, { exact: false }).first()).toBeVisible();
      await captureScreenshot(page, testInfo, `role-${view}-${width}`);
      await picker.selectOption("fixture-role-two");
      await expect(page).toHaveURL(/role=fixture-role-two/);
      await expect(
        main.getByText("Staff Platform Engineer", { exact: true }).filter({ visible: true }),
      ).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/app");
    }
    expect(reads.some((read) => read.roleId === "fixture-role-two")).toBe(true);
    expect(fixture.calls.some((call) => call.method === "threads/answer")).toBe(false);
  });
}
