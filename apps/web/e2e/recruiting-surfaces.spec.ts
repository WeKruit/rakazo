import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";

const fixture = "/e2e/fixtures/recruiting-surfaces.html";
const failures = new Map<Page, string[]>();
test.use({ colorScheme: "light", timezoneId: "UTC" });

test.beforeEach(async ({ page }) => {
  // Isolated fixtures use no realtime services; ignore Vite HMR while other tracks edit.
  await page.routeWebSocket("**/*", () => {});
  const errors: string[] = [];
  failures.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ body: "", contentType: "text/css" });
    if (url.hostname === "assets.example.test" && url.pathname === "/profile-photo.svg")
      return route.fulfill({
        contentType: "image/svg+xml",
        path: fileURLToPath(new URL("./fixtures/profile-photo.svg", import.meta.url)),
      });
    errors.push(`Unexpected external request: ${url.hostname}`);
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(failures.get(page)).toEqual([]);
  failures.delete(page);
});

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
}

async function selectedDayWithinSelector(page: Page) {
  const days = page.getByRole("group", { name: "Choose day", exact: true });
  await expect
    .poll(() =>
      days.evaluate((selector) => {
        const selected = selector.querySelector('[aria-pressed="true"]');
        if (!selected) return false;
        const bounds = selector.getBoundingClientRect();
        const button = selected.getBoundingClientRect();
        return button.left >= bounds.left - 1 && button.right <= bounds.right + 1;
      }),
    )
    .toBe(true);
}

async function calendarParentScrolls(page: Page) {
  return page.getByTestId("interview-calendar").evaluate((calendar) => {
    const positions = [{ x: window.scrollX, y: window.scrollY }];
    for (let parent = calendar.parentElement; parent; parent = parent.parentElement)
      positions.push({ x: parent.scrollLeft, y: parent.scrollTop });
    return positions;
  });
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  const height = width === 1440 ? 900 : 844;
  test(`inbox selection, folded history, draft identity and profile drawer at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${fixture}?surface=inbox`);
    await expect(page.getByRole("status")).toHaveText("Select a conversation");
    await screenshot(page, info, `inbox-unselected-${width}`);
    const opener = page.getByRole("button", {
      name: "Avery Example Platform engineering conversation",
      exact: true,
    });
    await opener.focus();
    await page.keyboard.press("Enter");
    const conversation = page.getByTestId("email-conversation");
    await expect(
      conversation.getByRole("article", { name: "Platform engineering conversation", exact: true }),
    ).toBeVisible();
    await expect(
      conversation.getByText("This message belongs only to Blake.", { exact: true }),
    ).toHaveCount(0);
    await expect(conversation.locator("details[open]")).toHaveCount(0);
    await expect
      .poll(() =>
        conversation.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await noOverflow(page);
    await screenshot(page, info, `inbox-selected-${width}`);

    const summary = conversation.locator("summary");
    await summary.focus();
    await page.keyboard.press("Space");
    const selected = conversation.getByRole("article", {
      name: "Staff Platform Engineer at Example Labs",
      exact: true,
    });
    await expect(selected).toBeFocused();
    await expect(selected).toContainText("Your work on Go services is relevant");
    await screenshot(page, info, `inbox-history-${width}`);
    await conversation.getByRole("button", { name: "Draft reply", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Draft requested for sent-avery");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { recruitingSurfacesFixture: { actions: unknown[] } })
            .recruitingSurfacesFixture.actions,
      ),
    ).toEqual([{ kind: "draft", id: "sent-avery" }]);

    const profileButton = conversation.getByRole("button", { name: "Profile", exact: true });
    await profileButton.click();
    const panel = page.getByTestId("recruiting-detail-panel");
    await expect(panel.getByRole("heading", { name: "Avery Example", exact: true })).toBeVisible();
    await screenshot(page, info, `inbox-profile-${width}`);
    await noOverflow(page);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(profileButton).toBeFocused();
    await page
      .getByRole("button", { name: "Blake Sample Separate candidate context", exact: true })
      .click();
    await expect(
      conversation.getByRole("heading", { name: "Blake Sample", exact: true }),
    ).toBeVisible();
    await expect(conversation).not.toContainText("Your work on Go services is relevant");
    await expect(conversation).toContainText("Preview only.");
  });

  test(`sequence distinguishes observed counts, unknown telemetry and dated sends at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${fixture}?surface=sequence`);
    const metric = (name: string) =>
      page.locator("dl > div").filter({ has: page.getByText(name, { exact: true }) });
    await expect(metric("Contacted")).toContainText("Not reported");
    await expect(metric("Opened")).toContainText("Not reported");
    await expect(metric("Clicked")).toContainText("Not reported");
    await expect(metric("Active")).toContainText("≥ 2");
    await expect(metric("Interested")).toContainText("≥ 1");
    await expect(metric("Replied").locator("dd")).toHaveText("2");
    const chart = page.getByRole("region", { name: "Recorded send activity", exact: true });
    await expect(chart.locator("li")).toHaveCount(7);
    await expect(chart.locator("li").last()).toHaveText("2Oct 23");
    await noOverflow(page);
    await screenshot(page, info, `sequence-observed-${width}`);
    await page.goto(`${fixture}?surface=sequence&state=empty`);
    await expect(
      page.getByText("No dated sends in the available records.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("dd")).toHaveCount(6);
    for (const value of await page.locator("dd").allTextContents())
      expect(value).toContain("Not reported");
    await screenshot(page, info, `sequence-unavailable-${width}`);
  });

  test(`calendar keyboard navigation, source details, filters and empty state at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${fixture}?surface=interview`);
    const calendar = page.getByTestId("interview-calendar");
    const event = page.locator('[data-event-id="interview-avery"]');
    await expect(event).toBeVisible();
    await expect(event).toContainText("14:00–15:00");
    if (width === 390) {
      const weekRange = await calendar.locator('p[aria-live="polite"]').boundingBox();
      expect(weekRange?.width).toBeGreaterThan(240);
      expect(weekRange?.height).toBeLessThanOrEqual(48);
      const days = calendar.getByRole("group", { name: "Choose day", exact: true });
      const friday = days.getByRole("button", { name: "Fri, Oct 23", exact: true });
      await expect(friday).toHaveAttribute("aria-pressed", "true");
      await selectedDayWithinSelector(page);
      const parentsBefore = await calendarParentScrolls(page);
      expect(parentsBefore.every(({ x, y }) => x === 0 && y === 0)).toBe(true);
      await screenshot(page, info, `interview-initial-${width}`);
      await friday.focus();
      await page.keyboard.press("Home");
      await selectedDayWithinSelector(page);
      expect(await calendarParentScrolls(page)).toEqual(parentsBefore);
      await page.keyboard.press("End");
      await selectedDayWithinSelector(page);
      expect(await calendarParentScrolls(page)).toEqual(parentsBefore);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(days.getByRole("button", { name: "Thu, Oct 22", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(friday).toHaveAttribute("aria-pressed", "true");
      await selectedDayWithinSelector(page);
      expect(await calendarParentScrolls(page)).toEqual(parentsBefore);
      await expect(event).toBeVisible();
    }
    await noOverflow(page);
    await screenshot(page, info, `interview-populated-${width}`);
    await event.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", { name: "Event details", exact: true });
    await expect(details).toContainText("avery@example.test");
    await expect(details).toContainText("Example video room");
    await details.locator("summary").click();
    await expect(details).toContainText("America/New_York");
    await details.scrollIntoViewIfNeeded();
    await screenshot(page, info, `interview-details-${width}`);
    await details.getByRole("button", { name: "Close event details", exact: true }).click();
    await expect(event).toBeFocused();
    await calendar
      .getByRole("combobox", { name: "Display timezone", exact: true })
      .selectOption("America/New_York");
    await expect(event).toContainText("10:00–11:00");
    await calendar
      .getByRole("combobox", { name: "Event status", exact: true })
      .selectOption("missing");
    await expect(event).toHaveCount(0);
    await expect(page.locator('[data-event-id="availability"]')).toBeVisible();
    await calendar.getByRole("button", { name: "Next week", exact: true }).click();
    await expect(page.getByText("No timed events in this week.", { exact: true })).toBeVisible();
    await calendar.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator('[data-event-id="availability"]')).toBeVisible();
    await page.goto(`${fixture}?surface=interview&state=empty`);
    await expect(page.getByText("No timed events in this week.", { exact: true })).toBeVisible();
    if (width === 390) {
      await selectedDayWithinSelector(page);
      expect((await calendarParentScrolls(page)).every(({ x, y }) => x === 0 && y === 0)).toBe(
        true,
      );
    }
    await noOverflow(page);
    await screenshot(page, info, `interview-empty-${width}`);
  });
}
