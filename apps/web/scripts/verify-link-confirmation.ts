import assert from "node:assert/strict";
import type { Page } from "@playwright/test";

/** Only for the synthetic message fixture, after cold asset measurements finish. */
export async function verifyLinkConfirmationRecovery(page: Page) {
  // Exercise inline recovery while the existing automatic asset reload is in cooldown.
  await page.evaluate(() => sessionStorage.setItem("rk:preload-recovery", "1"));
  let aborted = false;
  await page.route("**/assets/external-link-alert.web-*.js", async (route) => {
    if (!aborted) {
      aborted = true;
      await route.abort();
    } else await route.continue();
  });
  await page.addInitScript(() => {
    window.open = (() => {
      throw new Error("Unexpected external navigation");
    }) as typeof window.open;
  });
  await page.evaluate(() => {
    window.open = (() => {
      throw new Error("Unexpected external navigation");
    }) as typeof window.open;
  });
  const message = page.locator('[data-message-id="synthetic-message"]');
  await message.locator("a").first().click();
  const refresh = message.getByRole("button", { name: "Refresh", exact: true });
  await refresh.waitFor();
  assert.equal(aborted, true);
  await refresh.click();
  await page.waitForLoadState("load");
  await message.locator("a").first().click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  console.error("Cold confirmation failure / explicit refresh / cancel passed");
}
