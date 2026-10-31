import { expect, test } from "@playwright/test";
import type { InternalUsageCosts, Me, UsageCosts } from "@rakazo/contracts";
import { createDb } from "../../../packages/db/src/client";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("customer credits and verified operator model details reconcile to the same ledger", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    !process.env.VERIFY_DATABASE || !process.env.DATABASE_URL,
    "Requires the disposable acceptance database",
  );
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const stamp = `${Date.now()}-${testInfo.workerIndex}`;
  const customerEmail = `usage-customer-${stamp}@example.test`;
  const operatorEmail = `usage-operator-${stamp}@wekruit.com`;
  const operatorContext = await browser.newContext();
  try {
    await signup(page, customerEmail, "password12", "Customer costs");
    await completeOnboarding(page);
    const customer = await rpc<Me>(page, "me", {});
    await prisma.usageRecord.createMany({
      data: [
        {
          spaceId: customer.spaceId,
          userId: customer.userId,
          provider: "fixture-model-vendor",
          model: "fixture-model",
          unit: "tokens",
          inputTokens: 600,
          outputTokens: 100,
          cacheReadTokens: 200,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          reasoningTokens: 25,
          totalTokens: 900,
          costUsd: 0.25,
          costSource: "provider-reported",
          callId: `browser-model-${stamp}`,
        },
        {
          spaceId: customer.spaceId,
          userId: customer.userId,
          provider: "autumn",
          model: "research",
          unit: "credits",
          quantity: 10,
          callId: `browser-research-${stamp}`,
        },
      ],
    });
    const usage = await rpc<UsageCosts>(page, "usage/costs", {});
    expect(usage.total).toEqual({ credits: 67, pending: false });
    expect(usage.canViewInternalCosts).toBe(false);
    expect(JSON.stringify(usage)).not.toMatch(/costUsd|inputTokens|fixture-model|autumn/);
    for (const procedure of ["usage/list", "usage/summary", "usage/internalCosts"]) {
      const response = await page.request.post(`/rpc/${procedure}`, { data: { json: {} } });
      expect(response.status()).toBe(403);
    }
    const customerSettings = await openUserSettings(page, "usage");
    await expect(customerSettings.getByTestId("usage-settings")).toContainText("67");
    await expect(customerSettings.getByTestId("usage-settings")).not.toContainText(
      /tokens|cost|\$/i,
    );
    await expect(customerSettings.getByTestId("settings-nav-internal-costs")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "real-customer-credit-only");

    const operator = await operatorContext.newPage();
    await signup(operator, operatorEmail, "password12", "Operator costs");
    await completeOnboarding(operator);
    const staff = await rpc<Me>(operator, "me", {});
    const beforeVerification = await rpc<UsageCosts>(operator, "usage/costs", {});
    expect(beforeVerification.canViewInternalCosts).toBe(false);
    expect(
      (await operator.request.post("/rpc/usage/internalCosts", { data: { json: {} } })).status(),
    ).toBe(403);
    await prisma.user.update({ where: { id: staff.userId }, data: { emailVerified: true } });
    const breakdown = await rpc<InternalUsageCosts>(operator, "usage/internalCosts", {});
    const account = breakdown.accounts.find((entry) => entry.userId === customer.userId);
    expect(account).toMatchObject({ credits: 67, costUsd: 0.335, priced: true, tokens: 900 });
    expect(
      account?.vendors.find((entry) => entry.vendor === "fixture-model-vendor")?.models[0],
    ).toMatchObject({
      model: "fixture-model",
      credits: 50,
      costUsd: 0.25,
      inputTokens: 600,
      outputTokens: 100,
      cacheReadTokens: 200,
      reasoningTokens: 25,
      tokens: 900,
    });
    const settings = await openUserSettings(operator);
    await expect(settings.getByTestId("settings-nav-internal-costs")).toBeVisible();
    await settings.getByTestId("settings-nav-internal-costs").click();
    const costs = settings.getByTestId("internal-costs-settings");
    await costs.getByRole("textbox", { name: "Search accounts" }).fill(customerEmail);
    const accountRow = costs.getByTestId("cost-account");
    await expect(accountRow).toHaveCount(1);
    await accountRow.locator(":scope > summary").click();
    const vendor = accountRow
      .getByTestId("cost-vendor")
      .filter({ hasText: "fixture-model-vendor" });
    await vendor.locator(":scope > summary").click();
    const model = vendor.getByTestId("cost-model");
    await model.locator(":scope > summary").click();
    await expect(model).toContainText("600");
    await expect(model).toContainText("$0.25");
    await expect(model).toContainText("Average / 1M tokens");
    await captureScreenshot(operator, testInfo, "real-operator-customer-model");
  } finally {
    await operatorContext.close();
    await prisma.$disconnect();
    await pool.end();
  }
});
