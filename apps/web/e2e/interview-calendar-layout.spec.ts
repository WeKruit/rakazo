import { expect, test } from "@playwright/test";
import { mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`actual global Interview keeps five-date calendar and source activity at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    const fixture = await mockRecruitingApp(page);
    await page.goto("/app?view=interview&role=all");
    const calendar = page.getByTestId("interview-calendar");
    await expect(calendar).toBeVisible();
    await expect(calendar.getByRole("button", { name: "Today", exact: true })).toBeDisabled();
    await expect(calendar.locator('fieldset[aria-label="Choose day"] button')).toHaveCount(5);
    await calendar.getByLabel("Display timezone", { exact: true }).selectOption("America/New_York");
    const event = calendar.locator("[data-event-id]").first();
    await expect(event).toContainText("10:00–10:45");
    const activity = calendar.getByRole("complementary", { name: "Saved calendar events" });
    await expect(activity).toContainText("All activity");
    if (width === 1440) {
      const hours = await calendar.getByTestId("calendar-hours").boundingBox();
      const rail = await activity.boundingBox();
      expect(rail!.x).toBeGreaterThan(hours!.x + hours!.width);
      expect(Math.round(rail!.width)).toBe(300);
    }
    await page.screenshot({
      path: info.outputPath(`interview-calendar-${width}.png`),
      fullPage: true,
    });
    await info.attach(`interview-calendar-${width}`, {
      path: info.outputPath(`interview-calendar-${width}.png`),
      contentType: "image/png",
    });
    await event.click();
    await expect(calendar.getByRole("complementary", { name: "Event details" })).toContainText(
      "avery@example.test",
    );
    await calendar.getByRole("button", { name: "Close event details" }).click();
    await calendar.getByLabel("Calendar start date", { exact: true }).fill("2026-11-01");
    await expect(calendar.getByTestId("calendar-empty-guidance")).toContainText(
      "No timed events in this date range.",
    );
    await expect(activity).toContainText("No activity in this date range.");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    expect(
      fixture.calls.some((call) => /create_event|create_booking|threads\/send/.test(call.method)),
    ).toBe(false);
    expect(fixture.unknown).toEqual([]);
  });
}
