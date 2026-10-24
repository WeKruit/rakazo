import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/candidate-profile.html";
const panel = (page: Page) => page.getByTestId("recruiting-detail-panel");
const assets = new Set(["profile-photo.svg", "company-logo.svg", "school-logo.svg"]);
const pageErrors = new Map<Page, string[]>();
test.use({ colorScheme: "light" });

test.beforeEach(async ({ page }) => {
  // Isolated fixtures use no realtime services; ignore Vite HMR while other tracks edit.
  await page.routeWebSocket("**/*", () => {});
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    // Existing global font CSS stays offline; screenshots use the installed fallback font.
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ body: "", contentType: "text/css" });
    if (url.hostname !== "assets.example.test") {
      errors.push(`Unexpected external request: ${url.hostname}`);
      return route.abort();
    }
    const name = url.pathname.slice(1);
    if (!assets.has(name)) throw new Error(`Unexpected fixture asset ${name}`);
    await route.fulfill({
      contentType: "image/svg+xml",
      path: fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
  pageErrors.delete(page);
});

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => {
      const detail = document.querySelector<HTMLElement>(
        '[data-testid="recruiting-detail-panel"]',
      )!;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panel: detail.scrollWidth - detail.clientWidth,
      };
    }),
  ).toEqual({ page: 0, panel: 0 });
}

async function fixtureState(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          candidateProfileFixture: {
            requests: { path: string; input: Record<string, unknown> }[];
            profileViews: { candidateKey: string }[];
          };
        }
      ).candidateProfileFixture,
  );
}

async function sectionBelowNavigation(page: Page, name: string) {
  let lastScrollTop = -1;
  let stableReads = 0;
  await expect
    .poll(async () => {
      const detail = panel(page);
      const [heading, navigation, scrollTop] = await Promise.all([
        detail.getByRole("heading", { name, exact: true }).boundingBox(),
        detail.getByRole("navigation", { name: "Profile navigation" }).boundingBox(),
        detail.locator(".rk-scroll").evaluate((scroller) => scroller.scrollTop),
      ]);
      stableReads = scrollTop === lastScrollTop ? stableReads + 1 : 0;
      lastScrollTop = scrollTop;
      return Boolean(
        heading &&
          navigation &&
          stableReads >= 2 &&
          heading.y >= navigation.y + navigation.height &&
          heading.y + heading.height <= (page.viewportSize()?.height ?? 0),
      );
    })
    .toBe(true);
}

for (const width of [1440, 390]) {
  test(`profile shows supported assets and selectable evidence at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(fixture);
    await page.getByRole("button", { name: "Avery Example", exact: true }).click();
    const detail = panel(page);
    await expect(detail.getByRole("heading", { name: "Avery Example", exact: true })).toBeVisible();
    for (const name of assets) {
      const asset = detail.locator(`img[src="https://assets.example.test/${name}"]`).first();
      await expect(asset).toHaveCount(1);
      await asset.scrollIntoViewIfNeeded();
      await expect
        .poll(() => asset.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    }
    await detail.getByRole("button", { name: "Experience", exact: true }).click();
    await sectionBelowNavigation(page, "Experience");
    await captureScreenshot(page, testInfo, `profile-timeline-${width}`);
    await detail
      .getByRole("heading", { name: "Avery Example", exact: true })
      .scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `profile-header-${width}`);
    await noOverflow(page);

    await detail.getByRole("button", { name: "Skills", exact: true }).click();
    await sectionBelowNavigation(page, "Skills");
    const go = detail.getByRole("button", { name: "Go", exact: true });
    await go.focus();
    await page.keyboard.press("Enter");
    await expect(go).toHaveAttribute("aria-pressed", "true");
    const evidence = detail.getByRole("region", { name: "Skill evidence", exact: true });
    await expect(evidence).toContainText("Built services in Go at Example Labs");
    await expect(evidence.locator("mark").first()).toHaveText("Go");
    await expect(evidence.getByRole("link").first()).toHaveAttribute(
      "href",
      "https://evidence.example.test/avery-profile",
    );

    const rust = detail.getByRole("button", { name: "Rust", exact: true });
    await rust.focus();
    await page.keyboard.press("Space");
    await expect(rust).toHaveAttribute("aria-pressed", "true");
    await expect(go).toHaveAttribute("aria-pressed", "false");
    await expect(evidence).toContainText("No evidence of production Rust use");
    await captureScreenshot(page, testInfo, `profile-skill-evidence-${width}`);
    await noOverflow(page);

    await detail.getByRole("button", { name: "Kotlin", exact: true }).click();
    await expect(evidence).toContainText("No supporting detail in the saved profile.");
    await detail.getByRole("button", { name: "Assessment", exact: true }).click();
    await sectionBelowNavigation(page, "Agent assessment");
    await expect(detail.getByText("Go distributed systems", { exact: true })).toBeVisible();
    await expect(detail.getByText("Unknown", { exact: true }).first()).toBeVisible();
    await captureScreenshot(page, testInfo, `profile-assessment-${width}`);
    await detail.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(detail.getByText("Avery availability", { exact: true })).toBeVisible();
    await expect(detail.getByText("Jordan Recruiter", { exact: false }).first()).toBeVisible();
    await captureScreenshot(page, testInfo, `profile-activity-${width}`);
    await noOverflow(page);
  });
}

test("long and absent profile fields stay readable without fabricated assets", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture);
  await page
    .getByRole("button", {
      name: "Blake Sample with a deliberately long synthetic display name",
      exact: true,
    })
    .click();
  await expect(
    panel(page).getByRole("heading", {
      name: "Blake Sample with a deliberately long synthetic display name",
      exact: true,
    }),
  ).toBeVisible();
  await noOverflow(page);
  await captureScreenshot(page, testInfo, "profile-long-mobile");
  await panel(page).getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    panel(page).getByRole("heading", { name: "Casey Placeholder", exact: true }),
  ).toBeVisible();
  await expect(panel(page).locator("img")).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Experience", exact: true })).toHaveCount(0);
  await noOverflow(page);
  await captureScreenshot(page, testInfo, "profile-missing-mobile");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("tab changes and data refresh retain one view while reopening records a new view", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixture);
  const opener = page.getByRole("button", { name: "Avery Example", exact: true });
  await opener.click();
  await expect.poll(async () => (await fixtureState(page)).profileViews.length).toBe(1);
  await panel(page).getByRole("button", { name: "Activity", exact: true }).click();
  await expect(panel(page).getByText("Avery availability", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Jordan Recruiter", { exact: false }).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "profile-activity-desktop");
  await panel(page).getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "Refresh profile", exact: true }).click();
  expect((await fixtureState(page)).profileViews).toHaveLength(1);
  await panel(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await opener.click();
  await expect.poll(async () => (await fixtureState(page)).profileViews.length).toBe(2);
  await page.reload();
  await expect(
    panel(page).getByRole("heading", { name: "Avery Example", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await fixtureState(page)).profileViews.length).toBe(1);
});

test("late activity responses cannot appear under a different candidate", async ({ page }) => {
  await page.goto(`${fixture}?delayed`);
  await page.getByRole("button", { name: "Avery Example", exact: true }).click();
  await panel(page).getByRole("button", { name: "Activity", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await fixtureState(page)).requests.filter(
          (request) => request.path === "recruiting/crmData",
        ).length,
    )
    .toBeGreaterThan(0);
  await panel(page).getByRole("button", { name: "Next", exact: true }).click();
  await panel(page).getByRole("button", { name: "Activity", exact: true }).click();
  await expect(panel(page).getByText("Blake availability", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { candidateProfileFixture: { releaseActivity: () => void } }
    ).candidateProfileFixture.releaseActivity(),
  );
  await expect(panel(page).getByText("Avery availability", { exact: true })).toHaveCount(0);
  await expect(panel(page).getByText("Blake availability", { exact: true })).toBeVisible();
});

test("a view finishing after switching to Activity refreshes the timeline once", async ({
  page,
}) => {
  await page.goto(`${fixture}?delayed-view`);
  await page.getByRole("button", { name: "Avery Example", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await fixtureState(page)).requests.filter(
          (request) => request.path === "recruiting/profileActivity/recordView",
        ).length,
    )
    .toBe(1);
  await panel(page).getByRole("button", { name: "Activity", exact: true }).click();
  await expect(panel(page).getByText("Avery availability", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Profile viewed", { exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { candidateProfileFixture: { releaseViews: () => void } }
    ).candidateProfileFixture.releaseViews(),
  );
  await expect(panel(page).getByText("Profile viewed", { exact: true })).toHaveCount(1);
  await expect(panel(page).getByText("Jordan Recruiter", { exact: false }).first()).toBeVisible();
  expect((await fixtureState(page)).profileViews).toHaveLength(1);
});
