import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const locale of ["en", "zh-CN"] as const) {
  test(`optional page loads its catalog before rendering (${locale})`, async ({ page }) => {
    const fixture = await mockRecruitingApp(page, { locale });
    await page.route("**/rpc/approvalRules/list", (route) => route.fulfill({ json: { json: [] } }));
    await page.route("**/rpc/autoReview/get", (route) =>
      route.fulfill({ json: { json: { enabled: false, checkerAvailable: false } } }),
    );
    const requested: string[] = [];
    page.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await page.route("**/api/auth/account-security", (route) =>
      route.fulfill({
        json: {
          hasPassword: true,
          passwordChangeEnabled: true,
          freshOidcAuth: false,
          ssoLinked: false,
          emailDeletion: false,
          sso: null,
        },
      }),
    );
    await page.goto(`/app/g/${appGroupId}?view=contacts`);
    await expect(page.getByText("Avery Example", { exact: true }).first()).toBeVisible();
    expect(requested.filter((path) => /\/messages-[^/]+\.js$/.test(path))).toEqual([]);
    await page.getByTestId("user-menu-trigger").click();
    await page
      .getByRole("button", { name: locale === "en" ? "Settings" : "设置", exact: true })
      .click();
    const settings = page.getByTestId("user-settings");
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId("ui-locale-select")).toBeVisible();
    await expect(
      settings.getByRole("button", {
        name: locale === "en" ? "Close user settings" : "关闭用户设置",
        exact: true,
      }),
    ).toBeVisible();
    expect(requested.some((path) => /\/messages-[^/]+\.js$/.test(path))).toBe(true);
    await settings.getByTestId("ui-locale-select").click();
    await page
      .getByRole("option", { name: locale === "en" ? "简体中文" : "English", exact: true })
      .click();
    await expect(
      settings.getByRole("button", {
        name: locale === "en" ? "关闭用户设置" : "Close user settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(settings.getByTestId("ui-locale-select")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(fixture.unknown).toEqual([]);
  });
}
