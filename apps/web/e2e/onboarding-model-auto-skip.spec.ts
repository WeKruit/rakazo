import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc, signup } from "./helpers";

test("onboarding skips model connect when a default model is already available", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false } },
    });
  });

  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );

  const createRequest = page.waitForRequest("**/rpc/onboarding/ensureRecruiting");
  const stamp = Date.now();
  await signup(
    page,
    `model-auto-skip-${stamp}@rakazo.test`,
    "password12",
    `Model auto skip ${stamp}`,
  );

  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  for (const name of ["Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }

  expect((await createRequest).postDataJSON()).toMatchObject({ json: {} });
  await expect(page).toHaveURL(/\/app\/g\//);
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const bots = await rpc<Array<{ name: string; modelProvider: string | null }>>(
    page,
    "bots/list",
    {},
  );
  expect(bots.map((bot) => bot.name).sort()).toEqual(["Main", "Outreach", "Scheduling", "Sourcer"]);
  expect(bots.every((bot) => bot.modelProvider === null)).toBe(true);
  const first = await rpc<{ botId: string; groupId: string }>(
    page,
    "onboarding/ensureRecruiting",
    {},
  );
  const second = await rpc<{ botId: string; groupId: string }>(
    page,
    "onboarding/ensureRecruiting",
    {},
  );
  expect(second).toEqual(first);
  expect((await rpc<unknown[]>(page, "bots/list", {})).length).toBe(4);
  await captureScreenshot(page, testInfo, "onboarding-model-auto-skip");
});
