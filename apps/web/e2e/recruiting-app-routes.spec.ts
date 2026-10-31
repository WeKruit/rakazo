import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { appGroupId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";

async function openRoute(page: Page, view: string) {
  await page.goto(`/app/g/${appGroupId}?view=${view}`);
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  const collapse = page.getByRole("button", { name: "Collapse role chat", exact: true });
  if (["contacts", "shortlist"].includes(view)) await expect(collapse).toBeVisible();
  if (view !== "home" && (await collapse.isVisible())) await collapse.click();
  await expect(page.locator('[data-rakazo-app-state="failed"]')).toHaveCount(0);
}

async function capture(page: Page, testInfo: TestInfo, label: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${label}.png`),
    fullPage: true,
    animations: "disabled",
  });
  await testInfo.attach(label, {
    path: testInfo.outputPath(`${label}.png`),
    contentType: "image/png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
}

async function visibleSelectedDay(page: Page) {
  const days = page.getByRole("group", { name: "Choose day", exact: true });
  await expect
    .poll(() =>
      days.evaluate((element) => {
        const selected = element.querySelector('button[aria-pressed="true"]');
        if (!selected) return false;
        const row = element.getBoundingClientRect();
        const button = selected.getBoundingClientRect();
        // DOM scroll ranges round to integers while button bounds retain subpixels.
        return button.left >= row.left - 1 && button.right <= row.right + 1;
      }),
    )
    .toBe(true);
  return days.locator('button[aria-pressed="true"]');
}

async function expectNavigationLabelVisible(button: Locator) {
  await expect(button).toBeVisible();
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const viewport = element.parentElement!.parentElement!;
        const bounds = viewport.getBoundingClientRect();
        const label = element.getBoundingClientRect();
        return label.left >= bounds.left - 1 && label.right <= bounds.right + 1;
      }),
    )
    .toBe(true);
}

async function checkNarrowProfileNavigation(page: Page, panel: Locator) {
  const navigation = panel.getByRole("navigation", { name: "Profile navigation", exact: true });
  await navigation.scrollIntoViewIfNeeded();
  const rows = navigation.getByTestId("profile-navigation-row");
  await expect(rows).toHaveCount(2);
  const labels = [
    ["Profile", "Activity", "Emails", "Interview", "Tasks", "Notes"],
    ["Assessment", "Experience", "Education", "Skills", "Research findings"],
  ];
  for (const [index, names] of labels.entries()) {
    const row = rows.nth(index);
    const left = row.getByRole("button", { name: "Scroll navigation left", exact: true });
    const right = row.getByRole("button", { name: "Scroll navigation right", exact: true });
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await right.click();
    const last = row.getByRole("button", { name: names.at(-1)!, exact: true });
    await expectNavigationLabelVisible(last);
    const waitForScrollEnd = async () => {
      await row.evaluate(async (element) => {
        const viewport = element.querySelector<HTMLElement>(".overflow-x-auto")!;
        let previous = viewport.scrollLeft;
        let stableSince = performance.now();
        while (performance.now() - stableSince < 100) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = viewport.scrollLeft;
          if (Math.abs(current - previous) > 0.1) stableSince = performance.now();
          previous = current;
        }
      });
      await expect
        .poll(() =>
          left.evaluate((button) => {
            const viewport = button.parentElement!.querySelector<HTMLElement>(".overflow-x-auto")!;
            return (button as HTMLButtonElement).disabled === viewport.scrollLeft <= 1;
          }),
        )
        .toBe(true);
    };
    // Position must settle after right navigation too, before inspecting the left edge.
    await waitForScrollEnd();
    while (await left.isEnabled()) {
      await left.click();
      await waitForScrollEnd();
    }
    const first = row.getByRole("button", { name: names[0], exact: true });
    await first.focus();
    const ancestorScrolls = () =>
      row.evaluate((element) => {
        const positions = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement)
          positions.push([parent.scrollLeft, parent.scrollTop]);
        return positions;
      });
    const before = await ancestorScrolls();
    for (const name of names.slice(1)) {
      await page.keyboard.press("Tab");
      const label = row.getByRole("button", { name, exact: true });
      await expect(label).toBeFocused();
      await expectNavigationLabelVisible(label);
      expect(await ancestorScrolls()).toEqual(before);
    }
  }
}

for (const width of [1440, 390]) {
  test(`actual recruiting app pages and detail interactions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    const fixture = await mockRecruitingApp(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await openRoute(page, "contacts");
      const person = page.getByRole("button", { name: "Avery Example", exact: true }).first();
      await expect(person).toBeVisible();
      if (width === 1440) {
        const table = page.getByRole("region", { name: "Candidate table", exact: true });
        expect(await table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
          0,
        );
        const action = table
          .locator("tbody tr")
          .first()
          .locator("td")
          .last()
          .getByRole("button")
          .first();
        await expect(action).toBeInViewport();
        const tableBox = await table.boundingBox();
        const actionBox = await action.boundingBox();
        expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(tableBox!.x + tableBox!.width);
      }
      await expect(page.locator(".hire-contacts-view")).toHaveCSS("scrollbar-width", "none");
      await expect(page.locator(".candidate-viewport")).toHaveCSS("scrollbar-width", "none");
      await capture(page, testInfo, `app-contacts-${width}`);
      const layout = page.getByRole("group", { name: "Contact layout", exact: true });
      const cards = layout.getByRole("button", { name: "Cards", exact: true });
      await cards.click();
      await expect(cards).toHaveAttribute("aria-pressed", "true");
      await capture(page, testInfo, `app-contacts-cards-${width}`);
      await layout.getByRole("button", { name: "Table", exact: true }).click();
      await person.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByTestId("recruiting-detail-panel");
      await expect(
        panel.getByRole("heading", { name: "Avery Example", exact: true }),
      ).toBeVisible();
      await capture(page, testInfo, `app-profile-${width}`);
      if (width === 390) {
        await checkNarrowProfileNavigation(page, panel);
        await capture(page, testInfo, `app-profile-navigation-${width}`);
      }
      const assessment = panel.getByRole("region", { name: "Agent assessment", exact: true });
      await expect(assessment.getByText("C++ production systems", { exact: true })).toBeVisible();
      await expect(assessment.getByText("R4", { exact: true })).toBeVisible();
      await expect(
        assessment.getByText("Criterion name unavailable", { exact: true }),
      ).toBeVisible();
      await expect(assessment.getByText("R5", { exact: true })).toBeVisible();
      await expect(assessment).toContainText("deployment scale is not stated");
      await assessment.scrollIntoViewIfNeeded();
      await capture(page, testInfo, `app-criterion-evidence-${width}`);
      await panel.getByRole("button", { name: "Skills", exact: true }).click();
      const rust = panel.getByRole("button", { name: "Rust", exact: true });
      await rust.focus();
      await page.keyboard.press("Enter");
      await expect(rust).toHaveAttribute("aria-pressed", "true");
      await expect(
        panel.getByText("No evidence of production Rust use.", { exact: true }).first(),
      ).toBeVisible();
      await capture(page, testInfo, `app-skill-evidence-${width}`);
      await panel.getByRole("button", { name: "Activity", exact: true }).click();
      const activity = panel.getByRole("region", { name: "Activity", exact: true });
      const currentView = activity.getByRole("listitem").filter({ hasText: "Profile viewed" });
      await expect(currentView).toHaveCount(1);
      await expect(currentView).toContainText("Example Recruiter");
      await expect(currentView).toContainText("Staff Platform Engineer");
      await expect(currentView.locator("time")).toHaveAttribute("datetime", checkedAt);
      expect(fixture.views).toHaveLength(1);
      expect(fixture.views[0]!.viewId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
      );
      expect(
        fixture.calls.filter((call) => call.method === "recruiting/profileActivity/recordView"),
      ).toHaveLength(1);
      await currentView.scrollIntoViewIfNeeded();
      await capture(page, testInfo, `app-profile-activity-${width}`);
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(person).toBeFocused();

      if (width === 1440) {
        await page
          .getByRole("navigation", { name: "Recruiting workspace" })
          .getByRole("button", { name: "Sequence", exact: true })
          .click();
        await expect(page).toHaveURL(/view=sequence/);
      } else await openRoute(page, "sequence");
      const sequence = page.getByTestId("account-recruiting-view");
      await expect(sequence.getByText("Platform outreach", { exact: true })).toBeVisible();
      await expect(sequence.getByText("avery@example.test", { exact: true }).first()).toBeVisible();
      await expect(sequence.getByText("No candidate records for this role yet.")).toHaveCount(0);
      await capture(page, testInfo, `app-sequence-${width}`);
      await openRoute(page, "inbox");
      const inbox = page.getByTestId("account-recruiting-view");
      const conversation = inbox.getByTestId("email-conversation");
      if (width === 390)
        await inbox.getByRole("button", { name: "Avery Example", exact: true }).first().click();
      await expect(
        conversation.getByText("Tuesday afternoon works", { exact: false }).first(),
      ).toBeVisible();
      await capture(page, testInfo, `app-inbox-${width}`);

      await openRoute(page, "interview");
      const calendar = page.getByTestId("interview-calendar");
      await expect(calendar).toBeVisible();
      await capture(page, testInfo, `app-interview-entry-${width}`);
      await calendar.scrollIntoViewIfNeeded();
      if (width === 390) {
        const selectedDay = await visibleSelectedDay(page);
        await expect(selectedDay).toHaveText("Fri, Oct 23");
        const parentScrolls = () =>
          calendar.evaluate((element) => {
            const result = [];
            for (let parent = element.parentElement; parent; parent = parent.parentElement)
              result.push(parent.scrollTop);
            return result;
          });
        const before = await parentScrolls();
        await selectedDay.focus();
        await page.keyboard.press("End");
        await expect(await visibleSelectedDay(page)).toHaveText("Sun, Oct 25");
        expect(await parentScrolls()).toEqual(before);
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowLeft");
        await expect(await visibleSelectedDay(page)).toHaveText("Fri, Oct 23");
        expect(await parentScrolls()).toEqual(before);
      }
      const event = calendar.getByRole("button", { name: /Avery platform interview/ }).first();
      await expect(event).toBeVisible();
      await expect(
        calendar.getByRole("complementary", { name: "Saved calendar events", exact: true }),
      ).toBeVisible();
      await capture(page, testInfo, `app-interview-${width}`);
      await event.click();
      const eventDetails = calendar.getByRole("complementary", {
        name: "Event details",
        exact: true,
      });
      await expect(eventDetails.getByText("Video call", { exact: true })).toBeVisible();
      if (width === 390) {
        const eventLink = eventDetails.getByRole("link", {
          name: "Open calendar event",
          exact: true,
        });
        await eventLink.scrollIntoViewIfNeeded();
        await expect(eventLink).toBeInViewport();
        await expect(page.getByRole("button", { name: "Open role chat", exact: true })).toHaveCount(
          0,
        );
      }
      await capture(page, testInfo, `app-interview-details-${width}`);
      await calendar
        .getByRole("combobox", { name: "Display timezone" })
        .selectOption("America/New_York");
      await expect(calendar.getByRole("combobox", { name: "Display timezone" })).toHaveValue(
        "America/New_York",
      );
      await calendar.scrollIntoViewIfNeeded();
      if (width === 390) await visibleSelectedDay(page);
      await capture(page, testInfo, `app-interview-timezone-${width}`);

      await openRoute(page, "home");
      await expect(page.getByText("Hello, Example", { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Project", exact: true })).toBeVisible();
      await capture(page, testInfo, `app-overview-${width}`);
      expect(fixture.unknown).toEqual([]);
      expect(errors).toEqual([]);
      expect(
        fixture.calls.some((call) => call.method === "recruiting/profileActivity/recordView"),
      ).toBe(true);
      expect(fixture.calls.some((call) => /send|createEvent|followUp/.test(call.method))).toBe(
        false,
      );
    } finally {
      await testInfo.attach("fixture-diagnostics", {
        body: JSON.stringify({ unknown: fixture.unknown, calls: fixture.calls, errors }),
        contentType: "application/json",
      });
    }
  });

  test(`actual app empty inbox and calendar at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    const fixture = await mockRecruitingApp(page, { emptyCalendar: true, emptyMail: true });
    await openRoute(page, "inbox");
    const inbox = page.getByTestId("account-recruiting-view");
    await expect(inbox.getByText("No replies yet.", { exact: true })).toBeVisible();
    await capture(page, testInfo, `app-inbox-empty-${width}`);
    await openRoute(page, "interview");
    const calendar = page.getByTestId("interview-calendar");
    await expect(calendar).toBeVisible();
    await calendar.scrollIntoViewIfNeeded();
    const guidance = calendar.getByTestId("calendar-empty-guidance");
    await expect(guidance).toBeVisible();
    await expect(guidance).toContainText("Empty space does not confirm availability.");
    const guidanceBox = await guidance.boundingBox();
    const hoursBox = await calendar.getByTestId("calendar-hours").boundingBox();
    expect(guidanceBox!.y + guidanceBox!.height).toBeLessThanOrEqual(hoursBox!.y);
    await capture(page, testInfo, `app-interview-empty-${width}`);
    expect(fixture.unknown).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`actual Sequence shows all authorized campaigns at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const fixture = await mockRecruitingApp(page, { multipleCampaigns: true });
    await openRoute(page, "sequence");
    const sequence = page.getByTestId("account-recruiting-view");
    await expect(sequence.getByText("Platform outreach", { exact: true })).toBeVisible();
    await expect(sequence.getByText("Platform follow-up", { exact: true })).toBeVisible();
    await capture(page, testInfo, `app-sequence-campaigns-${width}`);
    expect(fixture.calls.filter((call) => call.method === "recruiting/accountView")).toHaveLength(
      1,
    );
    expect(fixture.unknown).toEqual([]);
  });
}

test("Overview drilldowns preserve the exact role and evidence tab", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRecruitingApp(page);
  for (const [label, destination] of [
    ["Shortlisted", "shortlist"],
    ["Contacted", "sequence"],
    ["Replied", "inbox"],
    ["Interested", "contacts"],
  ]) {
    await openRoute(page, "home");
    const funnel = page.getByRole("region", { name: "Outreach funnel", exact: true });
    await funnel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
    await funnel
      .getByRole("list", { name: "Projects", exact: true })
      .getByRole("button")
      .first()
      .click();
    await expect(page).toHaveURL(`/app/g/${appGroupId}?view=${destination}`);
  }
});

for (const width of [1440, 390]) {
  test(`actual replies, campaign and booked Overview at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    const fixture = await mockRecruitingApp(page, { calendarStatus: "accepted" });
    await openRoute(page, "inbox");
    const inbox = page.getByTestId("account-recruiting-view");
    if (width === 390)
      await inbox.getByRole("button", { name: "Avery Example", exact: true }).first().click();
    await expect(inbox.getByText("Interview availability", { exact: true }).first()).toBeVisible();
    await expect(
      inbox.getByText("Tuesday afternoon works", { exact: false }).first(),
    ).toBeVisible();
    await capture(page, testInfo, `app-inbox-observed-${width}`);
    await openRoute(page, "sequence");
    await expect(
      page.getByTestId("account-recruiting-view").getByText("Platform outreach", { exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, `app-sequence-observed-${width}`);
    await openRoute(page, "home");
    const bookings = page.getByRole("list", { name: "Upcoming recorded bookings", exact: true });
    await expect(bookings.getByRole("button")).toHaveCount(1);
    await expect(bookings).toContainText("Avery · Platform interview");
    await bookings.scrollIntoViewIfNeeded();
    await capture(page, testInfo, `app-overview-recorded-booking-${width}`);
    await bookings.getByRole("button").click();
    await expect(page).toHaveURL(`/app/g/${appGroupId}?view=interview`);
    expect(fixture.unknown).toEqual([]);
  });
}
