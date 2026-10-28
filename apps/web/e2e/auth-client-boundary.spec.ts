import { expect, test } from "@playwright/test";
import { appGroupId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";

test("base auth session, sign-out, sign-in and selected-space headers survive without unused organization hooks", async ({
  page,
}) => {
  const fixture = await mockRecruitingApp(page, { locale: "en" });
  let signedIn = true;
  const user = {
    id: "fixture-user",
    name: "Example Recruiter",
    email: "recruiter@example.test",
    emailVerified: true,
    image: null,
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  const session = {
    id: "fixture-session",
    userId: user.id,
    token: "synthetic-only",
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  const organizations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/auth/organization/"))
      organizations.push(request.url());
  });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: signedIn ? { user, session } : null }),
  );
  await page.route("**/api/auth/sign-out", (route) => {
    signedIn = false;
    return route.fulfill({ json: { success: true } });
  });
  await page.route("**/api/auth/sign-in/email", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      email: user.email,
      password: "synthetic-password-only",
    });
    signedIn = true;
    return route.fulfill({ json: { user, token: session.token, redirect: false } });
  });
  await page.goto(`/app/g/${appGroupId}?view=contacts`);
  await expect(page.getByText("Avery Example", { exact: true }).first()).toBeVisible();
  // The synthetic server is deliberately fixed; this checks client transport, not
  // server authorization. Existing App/Shell unit tests cover state replacement.
  const changedSpace = page.waitForRequest(
    (request) =>
      request.url().includes("/rpc/bootstrap") &&
      request.headers()["x-rakazo-space-id"] === "fixture-space-other",
  );
  await page.evaluate(() => {
    localStorage.setItem("rakazo:space-id", "fixture-space-other");
    window.dispatchEvent(new StorageEvent("storage", { key: "rakazo:space-id" }));
  });
  await changedSpace;
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.locator('input[name="email"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBeNull();
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill("synthetic-password-only");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
  expect(organizations).toEqual([]);
  expect(fixture.unknown).toEqual([]);
});
