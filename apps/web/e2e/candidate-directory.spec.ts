import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const assets = new Set(["profile-photo.svg", "company-logo.svg", "school-logo.svg"]);
const errors = new Map<Page, string[]>();
test.use({ colorScheme: "light" });
test.beforeEach(async ({ page }) => {
  const found: string[] = [];
  errors.set(page, found);
  page.on("pageerror", (error) => found.push(error.message));
  // This fixture has no live data. Keep shared dev-server HMR from resetting keyboard assertions.
  await page.routeWebSocket(/ws:\/\/(?:127\.0\.0\.1|localhost):\d+\//, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/rpc/")) {
      found.push(`Unexpected application request: ${url.pathname}`);
      return route.abort();
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ body: "", contentType: "text/css" });
    const name = url.pathname.slice(1);
    if (url.hostname !== "assets.example.test" || !assets.has(name)) {
      found.push(`Unexpected external request: ${url.hostname}`);
      return route.abort();
    }
    return route.fulfill({
      contentType: "image/svg+xml",
      path: fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    });
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  errors.delete(page);
});

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`contacts table and cards preserve keyboard actions and supplied sources at ${size.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    await page.goto("/e2e/fixtures/candidate-directory.html");
    const table = page.getByRole("region", { name: "Candidate table", exact: true });
    await expect(table).toBeVisible();
    for (const name of assets) {
      const image = table.locator(`img[src="https://assets.example.test/${name}"]`);
      await expect(image).toHaveCount(1);
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    }
    await expect(
      table.getByRole("link", { name: "Example University", exact: true }),
    ).toHaveAttribute("href", "https://example.test/school");
    const missingSources = table
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Morgan Sample", exact: true }) });
    await expect(missingSources.locator("img")).toHaveCount(0);
    await expect(
      missingSources.getByRole("link", { name: "Example University", exact: true }),
    ).toHaveCount(0);
    await expect(
      missingSources.getByRole("link", { name: "Example Labs", exact: true }),
    ).toHaveCount(0);
    await expect(table).toContainText("Production Rust · Unknown");
    await expect(table).toContainText("Criterion name unavailable");
    await expect(table).toContainText("R1 · Partial match");
    await noOverflow(page);
    await captureScreenshot(page, testInfo, `contacts-table-${size.width}`);

    const person = table.getByRole("button", { name: "Avery Example", exact: true });
    await person.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Opened candidate")).toHaveText("avery");
    await expect(person).toHaveAttribute("aria-current", "true");
    const shortlist = table.getByRole("button", { name: "Shortlist Rowan Sample", exact: true });
    await shortlist.focus();
    await page.keyboard.press("Space");
    await expect(shortlist).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Opened candidate")).toHaveText("avery");
    if (size.width < 600) {
      await table.evaluate((node) => {
        node.scrollLeft = 0;
      });
      await table.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    }

    const cardsToggle = page.getByRole("button", { name: "Cards", exact: true });
    await cardsToggle.focus();
    await page.keyboard.press("Space");
    await expect(cardsToggle).toHaveAttribute("aria-pressed", "true");
    const cards = page.getByRole("list", { name: "Candidate cards", exact: true });
    await expect(cards).toBeVisible();
    await expect(table).toHaveCount(0);
    await expect(cards.locator("img")).toHaveCount(3);
    await noOverflow(page);
    await captureScreenshot(page, testInfo, `contacts-cards-${size.width}`);

    const unnamed = cards.getByRole("button", { name: "Unnamed candidate", exact: true });
    await unnamed.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Opened candidate")).toHaveText("missing");
    await expect(unnamed).toHaveAttribute("aria-current", "true");
    await noOverflow(page);
    const tableToggle = page.getByRole("button", { name: "Table", exact: true });
    await tableToggle.focus();
    await page.keyboard.press("Enter");
    await expect(tableToggle).toHaveAttribute("aria-pressed", "true");
    await expect(
      table.getByRole("button", { name: "Unnamed candidate", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await noOverflow(page);
  });
}
