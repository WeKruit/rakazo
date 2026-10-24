import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test.use({ colorScheme: "light" });

async function readableWeekTicks(page: Page) {
  const chart = page.getByRole("region", { name: "Shortlisted profiles", exact: true });
  const ticks = chart.getByTestId("weekly-shortlist-tick");
  await expect(ticks).toHaveCount(4);
  const chartBounds = (await chart.boundingBox())!;
  const bounds = await ticks.evaluateAll((labels) =>
    labels.map((label) => {
      const box = label.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  for (const [index, box] of bounds.entries()) {
    expect(box.left).toBeGreaterThanOrEqual(chartBounds.x);
    expect(box.right).toBeLessThanOrEqual(chartBounds.x + chartBounds.width);
    if (index) expect(box.left - bounds[index - 1]!.right).toBeGreaterThanOrEqual(8);
  }
}

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Home filters real records and keeps unavailable metrics honest at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.routeWebSocket("**/*", () => {});
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
      if (url.hostname === "fonts.googleapis.com")
        return route.fulfill({ body: "", contentType: "text/css" });
      errors.push(`Unexpected external request: ${url.hostname}`);
      return route.abort();
    });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    await page.setViewportSize({ width, height });
    await page.goto("/e2e/fixtures/home-dashboard.html");
    await expect(page.getByRole("heading", { name: "Hello, Jordan" })).toBeVisible();
    await expect(page.getByTestId("weekly-shortlist-total")).toHaveText("6");
    const funnel = page.getByRole("region", { name: "Outreach funnel" });
    await expect(funnel).toContainText("Contacted—Unknown");
    await expect(funnel).toContainText("Interested≥1Partial data");
    await expect(funnel).toContainText("Current totals · all dates");
    await readableWeekTicks(page);
    await expect(funnel.locator('[style*="height"]')).toHaveCount(0);
    await captureScreenshot(page, testInfo, `home-${width}`);
    if (width === 390) {
      await page.getByRole("heading", { name: "Your tasks", exact: true }).scrollIntoViewIfNeeded();
      await captureScreenshot(page, testInfo, "home-tasks-390");
    }
    await page.getByRole("combobox", { name: "Shortlist period" }).selectOption("8");
    await expect(page.getByTestId("weekly-shortlist-total")).toHaveText("9");
    await readableWeekTicks(page);
    await page.getByRole("heading", { name: "Hello, Jordan" }).scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `home-eight-weeks-${width}`);
    await expect(funnel.locator("li").first()).toContainText("Shortlisted11");
    const project = page.getByRole("combobox", { name: "Project", exact: true });
    await project.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(project).toHaveValue("g1");
    await expect(page.getByTestId("weekly-shortlist-total")).toHaveText("5");
    await readableWeekTicks(page);
    await expect(funnel.locator("li").first()).toContainText("Shortlisted6");
    await funnel.getByRole("button", { name: "Inspect Shortlisted", exact: true }).click();
    await expect(funnel.getByRole("list", { name: "Projects", exact: true })).toContainText(
      "Staff Platform Engineer6",
    );
    await funnel.getByRole("list", { name: "Projects", exact: true }).getByRole("button").click();
    const chart = page.getByRole("region", { name: "Shortlisted profiles", exact: true });
    await chart.locator("ol button").last().click();
    await expect(chart.getByRole("list", { name: "Projects", exact: true })).toContainText(
      "Staff Platform Engineer2",
    );
    await chart.getByRole("list", { name: "Projects", exact: true }).getByRole("button").click();
    await expect(page.getByRole("list", { name: "Recents" }).getByRole("button")).toHaveCount(1);
    await page.getByRole("list", { name: "Recents" }).getByRole("button").click();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { homeDashboardFixture: { opened: string } }).homeDashboardFixture
            .opened,
      ),
    ).toBe("g1");
    await expect(page.getByRole("list", { name: "Your tasks" })).toContainText(
      "Review the platform shortlist",
    );
    await expect(page.getByRole("list", { name: "Your tasks" })).not.toContainText(
      "Prepare design interview questions",
    );
    await page.getByRole("button", { name: "Mark Review the platform shortlist done" }).click();
    await expect(page.getByText("No open tasks.", { exact: true })).toBeVisible();
    await project.selectOption("g2");
    await page.getByRole("combobox", { name: "Shortlist period" }).selectOption("12");
    await expect(page.getByTestId("weekly-shortlist-total")).toHaveText("5");
    await readableWeekTicks(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    await page.getByRole("heading", { name: "Hello, Jordan" }).scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `home-filtered-${width}`);
    expect(errors).toEqual([]);
  });
}
