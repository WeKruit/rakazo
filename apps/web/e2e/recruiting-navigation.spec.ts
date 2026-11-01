import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [320, 1440]) {
  test(`five primary destinations retain scope and old actions at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockRecruitingApp(page);
    for (const path of ["mcp/servers/list", "mcp/assignments/all"])
      await page.route(`**/rpc/${path}`, (route) => route.fulfill({ json: { json: [] } }));
    await page.goto(`/app/g/${appGroupId}?view=contacts`);
    await expect(page.getByRole("heading", { name: "Candidates", exact: true })).toBeVisible();
    if (width < 768)
      await page.getByRole("button", { name: "Open navigation", exact: true }).first().click();
    const nav = page.getByRole("navigation", { name: "Recruiting workspace", exact: true });
    await expect(nav.getByRole("link")).toHaveText([
      "Kruit",
      "Candidates",
      "Sequence",
      "Inbox1+",
      "Interview",
    ]);
    await expect(nav.getByRole("link", { name: "Inbox", exact: true })).toHaveAttribute(
      "aria-description",
      /saved.*mail|stored.*mail/i,
    );
    await expect(page.getByRole("button", { name: "New role", exact: true }).first()).toBeVisible();
    await nav.getByRole("link", { name: "Inbox", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/g/${appGroupId}\\?view=inbox$`));
    if (width < 768)
      await page
        .getByRole("button", { name: /^(Show|Open) navigation$/ })
        .first()
        .click();
    await page.getByRole("button", { name: "All roles", exact: true }).click();
    await expect(page).toHaveURL(/\/app\?view=inbox&role=all$/);
    if (width < 768)
      await page
        .getByRole("button", { name: /^(Show|Open) navigation$/ })
        .first()
        .click();
    await test.info().attach(`navigation-${width}`, {
      body: await page.screenshot({ path: info.outputPath(`navigation-${width}.png`) }),
      contentType: "image/png",
    });
    await page.getByTestId("user-menu-trigger").click();
    await expect(page.getByRole("button", { name: "Integrations", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Integrations", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(fixture.unknown).toEqual([]);
  });
}

test("Work and Role details preserve the original actions on a compact screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockRecruitingApp(page);
  for (const path of ["mcp/servers/list", "mcp/assignments/all"])
    await page.route(`**/rpc/${path}`, (route) => route.fulfill({ json: { json: [] } }));
  await page.goto(`/app/g/${appGroupId}?view=conversation`);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page).toHaveURL(/\/app\?view=tasks&role=all$/);
  await page.getByRole("link", { name: "Routines", exact: true }).click();
  await expect(page).toHaveURL(/view=routines/);
  await page.goto(`/app/g/${appGroupId}?view=contacts`);
  const close = page.getByRole("button", { name: "Collapse role chat", exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).not.toBeVisible();
  await page
    .getByRole("region", { name: "Recruiting", exact: true })
    .getByRole("button", { name: "Role details", exact: true })
    .click();
  await expect(page.getByRole("link", { name: "Job brief", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Client feedback", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Job brief", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/g/${appGroupId}\\?view=brief$`));
  expect(fixture.unknown).toEqual([]);
});
