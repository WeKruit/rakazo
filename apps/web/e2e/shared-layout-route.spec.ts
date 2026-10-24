import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`actual Contacts layout keeps chat and detail usable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockRecruitingApp(page);
    await page.goto(`/app/g/${appGroupId}?view=contacts`);
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    const collapse = page.getByRole("button", { name: "Collapse role chat", exact: true });
    await expect(collapse).toBeVisible();
    await collapse.click();
    await expect(
      page.getByRole("heading", { name: "Contacts", exact: true, level: 1 }),
    ).toHaveCount(1);
    const wrapper = page.locator(".hire-standard-view-native");
    await expect(wrapper).toBeVisible();
    await expect(wrapper.locator(":scope > .hire-section-header")).toHaveCount(0);
    const launcher = page.getByRole("button", { name: "Open role chat", exact: true });
    await expect(launcher).toBeVisible();
    if (width === 390) {
      expect(await launcher.evaluate((element) => getComputedStyle(element).position)).toBe(
        "static",
      );
      const content = await page
        .locator(".hire-role-chat-workspace > .recruiting-workspace-main")
        .boundingBox();
      const button = await launcher.boundingBox();
      expect(content!.y + content!.height).toBeLessThanOrEqual(button!.y);
    }
    await page.screenshot({ path: testInfo.outputPath(`contacts-${width}.png`), fullPage: true });
    await testInfo.attach(`contacts-${width}`, {
      path: testInfo.outputPath(`contacts-${width}.png`),
      contentType: "image/png",
    });
    await launcher.click();
    await expect(collapse).toBeVisible();
    await collapse.click();
    await page.getByRole("button", { name: "Avery Example", exact: true }).first().click();
    const detail = page.locator('[data-panel="recruiting-detail"]');
    await expect(detail).toBeVisible();
    await expect
      .poll(async () => Math.round((await detail.boundingBox())!.width))
      .toBe(width === 1440 ? 600 : 390);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`detail-${width}.png`), fullPage: true });
    await testInfo.attach(`detail-${width}`, {
      path: testInfo.outputPath(`detail-${width}.png`),
      contentType: "image/png",
    });
  });
}
