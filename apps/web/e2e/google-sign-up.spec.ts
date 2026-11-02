import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("sign-up offers Google next to email", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        sso: null,
        passwordAuth: true,
        google: true,
        passwordReset: true,
        resetUrl: "http://127.0.0.1/reset-password",
        billing: false,
      },
    }),
  );
  let social: unknown;
  await page.route("**/api/auth/sign-in/social", async (route) => {
    social = route.request().postDataJSON();
    await route.fulfill({ json: { url: "/sign-up?google=started", redirect: false } });
  });
  await page.goto("/sign-up");
  const google = page.getByRole("button", { name: "Continue with Google" });
  await expect(google).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "google-sign-up");
  await google.click();
  await expect.poll(() => social).toMatchObject({ provider: "google" });
  expect((social as { newUserCallbackURL: string }).newUserCallbackURL).toContain("/onboarding");
});
