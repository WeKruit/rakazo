import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const locale of ["en", "zh-CN"] as const) {
  test(`extracted recruiting controls retain translated accessible names in ${locale}`, async ({
    page,
  }) => {
    const fixture = await mockRecruitingApp(page, { locale });
    await page.goto(`/app/g/${appGroupId}?view=contacts`);
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    const chinese = locale === "zh-CN";
    const chat = page.getByRole("region", {
      name: chinese ? "岗位对话" : "Role conversation",
      exact: true,
    });
    await expect(chat).toBeVisible();
    await expect(
      chat.getByRole("button", { name: chinese ? "导出对话" : "Export conversation", exact: true }),
    ).toBeVisible();
    await page.route("**/rpc/threads/messages", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            defined: false,
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "rpc threads/messages failed",
          },
        }),
      }),
    );
    await chat
      .getByRole("button", { name: chinese ? "导出对话" : "Export conversation", exact: true })
      .click();
    await expect(
      page.getByText(chinese ? "无法导出对话" : "Could not export conversation", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: chinese ? "收起岗位对话" : "Collapse role chat", exact: true })
      .click();
    await expect(chat).toBeHidden();
    await expect(
      page.getByRole("textbox", {
        name: chinese ? "搜索候选人" : "Search candidates",
        exact: true,
      }),
    ).toBeVisible();
    expect(fixture.unknown).toEqual([]);
  });
}
