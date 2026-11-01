import { expect, test } from "@playwright/test";
import { accountRolesData, accountItem as item } from "./fixtures/recruiting-account-data";
import { appRoleId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";
import { captureScreenshot } from "./helpers";

const roles = accountRolesData();

for (const width of [1440, 390]) {
  test(`global pages and in-place role filter show product records at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date(checkedAt));
    const fixture = await mockRecruitingApp(page, { nativeScheduling: true });
    const reads: { view: string; roleId?: string }[] = [];
    await page.route("**/rpc/recruiting/accountView", async (route) => {
      const input = route.request().postDataJSON().json;
      reads.push(input);
      const selected = roles.filter((role) => !input.roleId || input.roleId === role.id);
      await route.fulfill({
        json: {
          json: {
            roles,
            items: selected.map((role) => item(role, roles.indexOf(role))),
            nextCursor: null,
          },
        },
      });
    });
    for (const [view, row] of [
      ["shortlist", "Avery Example"],
      ["sequence", "Platform outreach"],
      ["inbox", "Tuesday afternoon works"],
      ["interview", "Avery platform interview"],
      ["tasks", "Prepare platform interview"],
    ] as const) {
      await page.goto(`/app?view=${view}&role=all`);
      const main = page.getByTestId("account-recruiting-view");
      await expect(main).toBeVisible();
      await expect(main.getByText(row, { exact: false }).first()).toBeVisible();
      const picker = main.getByRole("combobox", { name: "Role", exact: true });
      await expect(picker).toHaveValue("all");
      if (view === "sequence") {
        const campaign = main.getByRole("region", { name: "Staff Platform Engineer", exact: true });
        for (const [label, count] of [
          ["Sent", "3"],
          ["Opened", "2"],
          ["Replied", "1"],
        ])
          await expect(
            campaign
              .locator("dt")
              .filter({ hasText: new RegExp(`^${label}$`) })
              .locator("..")
              .locator("dd"),
          ).toHaveText(count);
      }
      await captureScreenshot(page, testInfo, `global-${view}-${width}`);
      await picker.selectOption(appRoleId);
      await expect(page).toHaveURL(new RegExp(`view=${view}.*role=${appRoleId}`));
      await expect(
        main.getByText("Product Designer", { exact: true }).filter({ visible: true }),
      ).toHaveCount(0);
      await expect(main.getByText(row, { exact: false }).first()).toBeVisible();
      await captureScreenshot(page, testInfo, `role-${view}-${width}`);
      await picker.selectOption("fixture-role-two");
      await expect(page).toHaveURL(/role=fixture-role-two/);
      await expect(
        main.getByText("Staff Platform Engineer", { exact: true }).filter({ visible: true }),
      ).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/app");
    }
    expect(reads.some((read) => read.roleId === "fixture-role-two")).toBe(true);
    expect(fixture.calls.some((call) => call.method === "threads/answer")).toBe(false);
  });
}

for (const width of [1440, 390]) {
  test(`all contacts lists every role's people with filters and bulk actions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date(checkedAt));
    await mockRecruitingApp(page, { nativeScheduling: true });
    const reads: { filters: Record<string, unknown>; cursor?: string }[] = [];
    const tagged: unknown[] = [];
    const person = (key: string, name: string, role: (typeof roles)[number], tags: string[]) => ({
      personKey: key,
      name,
      title: "Staff Engineer",
      company: "Example Labs",
      location: "Los Angeles, California",
      school: "University of Example",
      linkedinUrl: `https://www.linkedin.com/in/${key}`,
      email: null,
      status: "shortlisted",
      noteKey: `autumn:linkedin:/in/${key}`,
      roles: [
        {
          id: role.id,
          title: role.title,
          groupId: role.groupId,
          candidateKey: `linkedin:/in/${key}`,
          shortlisted: true,
          threadId: role.threadId,
          revision: 1,
        },
      ],
      tags,
      addedAt: checkedAt,
      lastContactedAt: checkedAt,
      lastRepliedAt: null,
    });
    await page.route("**/rpc/recruiting/contacts/list", async (route) => {
      const input = route.request().postDataJSON().json;
      reads.push(input);
      const items = [
        person("avery", "Avery Example", roles[0]!, tagged.length ? ["Hot"] : []),
        person("blake", "Blake Example", roles[1]!, []),
      ].filter(
        (item) =>
          (!input.filters.roleIds || input.filters.roleIds.includes(item.roles[0]!.id)) &&
          (!input.filters.query ||
            item.name.toLowerCase().includes(input.filters.query.toLowerCase())),
      );
      await route.fulfill({ json: { json: { items, total: items.length, nextCursor: null } } });
    });
    await page.route("**/rpc/recruiting/contacts/facets", (route) =>
      route.fulfill({
        json: {
          json: {
            roles: roles.map((role) => ({ id: role.id, title: role.title })),
            statuses: ["shortlisted", "saved"],
            tags: [],
          },
        },
      }),
    );
    await page.route("**/rpc/recruiting/contacts/updateTags", async (route) => {
      tagged.push(route.request().postDataJSON().json);
      await route.fulfill({ json: { json: { ok: true } } });
    });
    await page.route("**/rpc/search/recruitingTargets", async (route) => {
      await route.fulfill({
        json: {
          json: {
            items: [
              {
                kind: "role",
                title: "Avery role",
                roleId: roles[0]!.id,
                roleTitle: roles[0]!.title,
                groupId: roles[0]!.groupId,
                botId: null,
                campaignId: null,
                serverId: null,
              },
            ],
          },
        },
      });
    });
    await page.goto("/app?view=contacts&role=all");
    const list = page.getByRole("region", { name: "All contacts", exact: true });
    await expect(list.getByText("Avery Example")).toBeVisible();
    await expect(list.getByText("Blake Example")).toBeVisible();
    const tableScroll = list.locator(".hire-contact-table-scroll");
    await page.mouse.move(0, 0);
    await expect(tableScroll).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
    await tableScroll.hover();
    await expect(tableScroll).not.toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
    const search = list.getByRole("textbox", { name: "Search contacts", exact: true });
    await search.fill("Blake");
    await expect(list.getByText("Avery Example")).toHaveCount(0);
    await expect(list.getByText("Blake Example")).toBeVisible();
    expect(reads.at(-1)?.filters.query).toBe("Blake");
    await search.fill("");
    await expect(list.getByText("Avery Example")).toBeVisible();
    await captureScreenshot(page, testInfo, `all-contacts-${width}`);

    await list.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitem", { name: "Role", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: roles[0]!.title, exact: true }).click();
    // One Escape closes the submenu, the next the menu.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // The menu's backdrop blocks the page until its close finishes.
    await expect(page.locator("[data-base-ui-inert]")).toHaveCount(0);
    await expect(list.getByText("Blake Example")).toHaveCount(0);
    expect(reads.at(-1)?.filters).toEqual({ roleIds: [roles[0]!.id] });
    await captureScreenshot(page, testInfo, `all-contacts-filtered-${width}`);

    await list.getByRole("checkbox", { name: "Select Avery Example", exact: true }).click();
    await list.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add tag", exact: true }).click();
    await page.getByRole("combobox", { name: "Tag", exact: true }).fill("Hot");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(list.getByText("Tagged 1 contacts.")).toBeVisible();
    expect(tagged).toEqual([{ personKeys: ["avery"], add: ["Hot"] }]);
    await expect(list.getByText("Hot", { exact: true })).toBeVisible();
    await page.keyboard.press("Control+k");
    const searchDialog = page.getByRole("dialog", { name: "Search", exact: true });
    await searchDialog.getByRole("combobox", { name: "Global search", exact: true }).fill("Blake");
    await expect(searchDialog.getByRole("option", { name: /Avery role/ })).toBeVisible();
    const contactResult = searchDialog.getByRole("option", { name: /^Blake Example/ });
    await expect(contactResult).toBeVisible();
    await captureScreenshot(page, testInfo, `global-search-${width}`);
    await contactResult.click();
    await expect(searchDialog).not.toBeVisible();
    await expect(page).toHaveURL(/view=contacts&role=all&query=Blake&detail=/);
    await expect(
      page
        .getByTestId("recruiting-detail-panel")
        .getByRole("heading", { name: "Blake Example", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await searchDialog.getByRole("combobox", { name: "Global search", exact: true }).fill("Avery");
    await searchDialog.getByRole("option", { name: /^Interview availability/ }).click();
    await expect(page).toHaveURL(/view=inbox&role=all&query=Avery&mailThread=/);
    await expect(page.getByTestId("email-conversation")).toBeVisible();
  });
}
