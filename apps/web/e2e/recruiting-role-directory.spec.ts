import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`all roles is a searchable complete directory at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockRecruitingApp(page);
    const roles = Array.from({ length: 101 }, (_, index) => ({
      id: `directory-role-${index}`,
      title: `Role ${String(index).padStart(3, "0")}`,
      threadId: `directory-thread-${index}`,
      groupId: index === 0 ? appGroupId : `directory-group-${index}`,
      stage: "intake",
    }));
    await page.route("**/rpc/recruiting/accountView", (route) =>
      route.fulfill({ json: { json: { roles, items: [], nextCursor: null } } }),
    );
    await page.goto("/app?view=roles");
    await expect(page.getByRole("heading", { name: "All roles", exact: true })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search roles", exact: true });
    await expect(page.getByRole("link", { name: "Role 000", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Role 100", exact: true })).toHaveCount(0);
    await search.fill("Role 100");
    await expect(page.getByRole("link", { name: "Role 100", exact: true })).toBeVisible();
    await search.fill("");
    await page
      .getByRole("navigation", { name: "Role pages", exact: true })
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await expect(page.getByRole("link", { name: "Role 050", exact: true })).toBeVisible();
    await test
      .info()
      .attach(`all-roles-${width}`, {
        body: await page.screenshot({ path: info.outputPath(`all-roles-${width}.png`) }),
        contentType: "image/png",
      });
    await search.fill("Role 000");
    await page.getByRole("link", { name: "Role 000", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/g/${appGroupId}\\?view=conversation$`));
    expect(fixture.unknown).toEqual([]);
  });
}
