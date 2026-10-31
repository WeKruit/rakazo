import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  setDeploymentOwner,
  signup,
} from "./helpers";

test("usage shows spend per role and calibration round", async ({ page }, testInfo) => {
  const amounts = { credits: 228, pending: false };
  await page.route("**/rpc/usage/costs", (route) =>
    route.fulfill({
      json: {
        json: {
          canViewInternalCosts: false,
          total: amounts,
          month: amounts,
          days: [{ day: "2026-10-25", ...amounts }],
          roles: [
            {
              roleId: "role-1",
              title: "Quality manager",
              ...amounts,
              rounds: [
                { round: 1, scale: false, credits: 177, pending: false },
                { round: 2, scale: false, credits: 51, pending: false },
              ],
            },
          ],
        },
      },
    }),
  );
  await setDeploymentOwner(page, false);
  const stamp = Date.now();
  await signup(page, `usage-total-${stamp}@rakazo.test`, "password12", "Usage totals");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  // Customers do not manage models, voice or app updates.
  for (const section of ["models", "voice", "updates"])
    await expect(settings.getByTestId(`settings-nav-${section}`)).toHaveCount(0);
  await settings.getByTestId("settings-nav-usage").click();
  const usage = page.getByTestId("usage-settings");
  await expect(usage).toContainText("Credits");
  await expect(usage).not.toContainText(/tokens|cost|\$/i);
  await expect(page.getByTestId("settings-nav-internal-costs")).toHaveCount(0);
  await usage.getByTestId("usage-role").locator("summary").click();
  await expect(usage.getByTestId("usage-role")).toContainText("Round 2");
  await captureScreenshot(page, testInfo, "usage-role-rounds");
});

test("settings shell is two-pane and deep-links Models Memory Voice Usage", async ({
  page,
}, testInfo) => {
  await setDeploymentOwner(page, true);
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Replies", exact: true })).toHaveCount(0);
  await settings.getByTestId("advanced-settings").locator(":scope > summary").click();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).toBeVisible();
  await expect(streamReplies).not.toBeChecked();
  await expect(settings.getByText("Stream replies", { exact: true })).toBeVisible();
  await streamReplies.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-shell-general");
  await streamReplies.click();
  await expect(streamReplies).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo.responseStreaming")))
    .toBe("on");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Provider")).toBeVisible();
  await memory.getByLabel("Provider").selectOption("serenity");
  await expect(memory.getByLabel("MCP endpoint")).toBeVisible();
  await expect(memory.getByLabel("Bearer token")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Recall only" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity");

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice");

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});

test("operator costs expand all accounts by vendor and model", async ({ page }, testInfo) => {
  const credits = { credits: 1.4, pending: false };
  const amount = {
    ...credits,
    costUsd: 0.007,
    priced: true,
    calls: 1,
    tokens: 170,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    cacheWrite1hTokens: 0,
    reasoningTokens: 5,
  };
  const vendor = {
    ...amount,
    vendor: "model-provider",
    models: [
      {
        ...amount,
        model: "research-model",
        unit: "tokens",
        quantity: 170,
        costSources: ["provider-reported"],
        averageUnitCostUsd: (0.007 / 170) * 1000000,
      },
    ],
  };
  let internalRequests = 0;
  await page.route("**/rpc/usage/costs", (route) =>
    route.fulfill({
      json: {
        json: { canViewInternalCosts: true, total: credits, month: credits, days: [], roles: [] },
      },
    }),
  );
  await page.route("**/rpc/usage/internalCosts", (route) => {
    internalRequests++;
    return route.fulfill({
      json: {
        json: {
          total: amount,
          month: amount,
          pricing: { creditsPerUsd: 100, grossMargin: 0.5 },
          vendors: [vendor],
          accounts: [
            {
              ...amount,
              userId: "fixture-account",
              email: "recruiter@example.test",
              name: "Recruiter",
              vendors: [vendor],
            },
          ],
        },
      },
    });
  });
  await signup(page, `internal-costs-${Date.now()}@rakazo.test`, "password12", "Operator costs");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "usage");
  await expect(settings.getByTestId("settings-nav-internal-costs")).toBeVisible();
  expect(internalRequests).toBe(0);
  await expect(settings.getByTestId("usage-settings")).not.toContainText(/tokens|cost|\$/i);
  await settings.getByTestId("settings-nav-internal-costs").click();
  const costs = settings.getByTestId("internal-costs-settings");
  await expect(costs).toBeVisible();
  const account = costs.getByTestId("cost-account");
  await account.locator(":scope > summary").click();
  const provider = account.getByTestId("cost-vendor");
  await provider.locator(":scope > summary").click();
  const model = provider.getByTestId("cost-model");
  await model.locator(":scope > summary").click();
  await expect(model).toContainText("Cache read");
  await expect(model).toContainText("Reasoning");
  await expect(model).toContainText("$0.007");
  await captureScreenshot(page, testInfo, "internal-costs-account-model");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(model).toBeVisible();
  await expect
    .poll(() => costs.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await captureScreenshot(page, testInfo, "internal-costs-mobile-width");
});
