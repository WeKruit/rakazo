import { expect, test } from "@playwright/test";
import { mockRecruitingApp } from "./fixtures/recruiting-app-data";
import { captureScreenshot } from "./helpers";

test("the phone drawer opens the complete role directory", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRecruitingApp(page, { nativeScheduling: true });
  const response = page.waitForResponse(
    (result) => new URL(result.url()).pathname === "/rpc/bootstrap",
  );
  await page.goto("/app?view=inbox&role=all");
  const bootstrap = (await (await response).json()).json;
  const groups = Array.from({ length: 6 }, (_, index) => ({
    ...bootstrap.groups[0],
    id: index ? `directory-group-${index + 1}` : bootstrap.groups[0].id,
    threadId: index ? `directory-thread-${index + 1}` : bootstrap.groups[0].threadId,
    name: `Directory role ${index + 1}`,
  }));
  const roles = groups.map((group, index) => ({
    id: `directory-role-${index + 1}`,
    title: group.name,
    groupId: group.id,
    threadId: group.threadId,
    stage: "searching",
  }));
  await page.route("**/rpc/bootstrap", (route) =>
    route.fulfill({
      json: {
        json: {
          ...bootstrap,
          groups,
          spaces: bootstrap.spaces.map((space: object) => ({ ...space, groups })),
        },
      },
    }),
  );
  await page.route("**/rpc/groups/page", (route) =>
    route.fulfill({
      json: {
        json: {
          items: route.request().postDataJSON().json.archived ? [] : groups,
          nextOffset: null,
        },
      },
    }),
  );
  await page.route("**/rpc/spaces/list", (route) =>
    route.fulfill({
      json: {
        json: {
          spaces: bootstrap.spaces.map((space: object) => ({ ...space, groups })),
          current: {
            id: bootstrap.me.spaceId,
            bots: bootstrap.bots,
            groups,
            botSections: [],
          },
        },
      },
    }),
  );
  await page.route("**/rpc/recruiting/accountView", (route) =>
    route.request().postDataJSON().json.view === "roles"
      ? route.fulfill({ json: { json: { roles, items: [], nextCursor: null, total: 6 } } })
      : route.fallback(),
  );
  await page.reload();
  await page.getByRole("button", { name: "Show navigation", exact: true }).first().click();
  const directory = page.getByRole("button", { name: "View all roles", exact: true });
  await expect(directory).toBeVisible();
  await captureScreenshot(page, info, "phone-role-drawer-390");
  await directory.click();
  await expect(page).toHaveURL(/view=roles/);
  await expect(page.getByRole("heading", { name: "All roles", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Directory role 6", exact: true })).toBeVisible();
  await expect(page.getByText("1–6 of 6", { exact: true })).toBeVisible();
  await captureScreenshot(page, info, "phone-role-directory-390");
});
