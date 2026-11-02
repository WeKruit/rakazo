import { expect, test } from "@playwright/test";
import type { RecruitingContact } from "@rakazo/contracts";
import { mockRecruitingApp } from "./fixtures/recruiting-app-data";
import { captureScreenshot } from "./helpers";

const person: RecruitingContact = {
  personKey: "crm:synthetic-search",
  name: "Synthetic-Person Example",
  title: "Engineer",
  company: "Example",
  location: null,
  school: null,
  savedProfile: null,
  profileImageUrl: null,
  companyLogoUrl: null,
  companyWebsiteUrl: null,
  schoolLogoUrl: null,
  schoolWebsiteUrl: null,
  linkedinUrl: null,
  email: "candidate@example.test",
  status: "saved",
  noteKey: "crm:synthetic-search",
  roles: [],
  tags: [],
  addedAt: null,
  lastContactedAt: null,
  lastRepliedAt: null,
};

for (const width of [1440, 390]) {
  test(`global search accepts immediate typing every time it opens from Sequence at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockRecruitingApp(page);
    await page.route("**/rpc/search/recruitingTargets", (route) =>
      route.fulfill({ json: { json: { items: [] } } }),
    );
    await page.route("**/rpc/recruiting/contacts/list", (route) => {
      expect(route.request().postDataJSON().json).toMatchObject({
        filters: { query: "Synthetic-Person" },
        limit: 8,
      });
      return route.fulfill({ json: { json: { items: [person], total: 1, nextCursor: null } } });
    });
    await page.goto("/app?view=sequence&role=all");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    for (let opening = 0; opening < 2; opening++) {
      if (opening === 0) {
        await page.getByRole("textbox", { name: "Search sequences", exact: true }).focus();
        await page.keyboard.press("Control+k");
      } else {
        if (width < 768)
          await page.getByRole("button", { name: "Show navigation", exact: true }).first().click();
        await page
          .getByTestId("recruiting-navigation")
          .getByRole("button", { name: "Search", exact: true })
          .click();
      }
      const dialog = page.getByRole("dialog", { name: "Search", exact: true });
      const input = dialog.getByRole("combobox", { name: "Global search", exact: true });
      await expect(input).toBeFocused();
      // No click/fill: the keyboard must already belong to this field on each open.
      await page.keyboard.type("Synthetic-Person");
      await expect(input).toHaveValue("Synthetic-Person");
      await expect(dialog.getByText("Synthetic-Person Example", { exact: true })).toBeVisible({
        timeout: 3000,
      });
      await expect(dialog.getByText("Searching…", { exact: true })).toHaveCount(0);
      await captureScreenshot(page, info, `search-sequence-${width}-${opening}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  });
}

test("search uses the selected Space and shows contacts while bootstrap and other scopes are pending", async ({
  page,
}, info) => {
  await mockRecruitingApp(page);
  let releaseBootstrap!: () => void;
  let releaseScopes!: () => void;
  const bootstrap = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  const scopes = new Promise<void>((resolve) => {
    releaseScopes = resolve;
  });
  let bootstrapRequested = false;
  await page.route("**/rpc/bootstrap", async (route) => {
    bootstrapRequested = true;
    await bootstrap;
    await route.fallback();
  });
  await page.route("**/rpc/search/recruitingTargets", async (route) => {
    expect(route.request().headers()["x-rakazo-space-id"]).toBe("fixture-space");
    await scopes;
    await route.fulfill({ json: { json: { items: [] } } });
  });
  await page.route("**/rpc/recruiting/globalInbox", async (route) => {
    expect(route.request().headers()["x-rakazo-space-id"]).toBe("fixture-space");
    expect(route.request().postDataJSON().json.spaceId).toBe("fixture-space");
    await scopes;
    await route.fulfill({ json: { json: { items: [], nextCursor: null } } });
  });
  await page.route("**/rpc/recruiting/contacts/list", async (route) => {
    expect(route.request().headers()["x-rakazo-space-id"]).toBe("fixture-space");
    expect(route.request().postDataJSON().json.filters.query).toBe("Synthetic-Person");
    await route.fulfill({ json: { json: { items: [person], total: 1, nextCursor: null } } });
  });
  try {
    await page.goto("/app?view=sequence&role=all");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    expect(bootstrapRequested).toBe(true);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search", exact: true });
    await dialog
      .getByRole("combobox", { name: "Global search", exact: true })
      .fill("Synthetic-Person");
    await expect(dialog.getByText("Synthetic-Person Example", { exact: true })).toBeVisible({
      timeout: 3000,
    });
    await expect(dialog.getByText("Searching…", { exact: true })).toBeVisible();
    await expect(dialog.getByText("No results", { exact: true })).toHaveCount(0);
    await captureScreenshot(page, info, "search-before-bootstrap");
    releaseScopes();
    await expect(dialog.getByText("Searching…", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Synthetic-Person Example", { exact: true })).toBeVisible();
  } finally {
    releaseBootstrap();
    releaseScopes();
  }
});
