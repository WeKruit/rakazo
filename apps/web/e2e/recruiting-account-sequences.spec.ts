import { expect, test } from "@playwright/test";
import { appGroupId, crmTarget, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390, 320])
  test(`actual global Sequence overview and native drilldown at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockRecruitingApp(page, { multipleCampaigns: true });
    await page.goto("/app?view=sequence&role=all");
    const main = page.getByTestId("account-sequences");
    await expect(main).toBeVisible();
    await expect(main.getByRole("heading", { name: "Sequence", exact: true })).toBeVisible();
    await expect(main.locator("dt")).toHaveText([
      "Contacted",
      "Active",
      "Opened",
      "Clicked",
      "Replied",
      "Interested",
    ]);
    await expect(main.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(main.getByRole("combobox", { name: "Sequence date range" })).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
    await expect(main.getByRole("columnheader")).toHaveText([
      "Name",
      "Privacy",
      "Total",
      "Active",
      "Opened",
      "Clicked",
      "Replied",
      "Interested",
      "Bounced",
      "Created",
      "Actions",
    ]);
    await expect(main.getByRole("link", { name: "Platform outreach", exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Platform follow-up", exact: true })).toBeVisible();
    await main.getByRole("textbox", { name: "Search sequences" }).fill("follow-up");
    await expect(main.getByRole("link", { name: "Platform outreach", exact: true })).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Platform follow-up", exact: true })).toBeVisible();
    await main.getByRole("textbox", { name: "Search sequences" }).clear();
    const contactRead = page.waitForRequest(
      (request) =>
        request.url().includes("recruiting/accountView") &&
        request.postDataJSON()?.json?.sequenceContactQuery === "Avery",
    );
    await main.getByRole("textbox", { name: "Filter by saved contact" }).fill("Avery");
    await contactRead;
    const clearContact = page.waitForRequest(
      (request) =>
        request.url().includes("recruiting/accountView") &&
        !request.postDataJSON()?.json?.sequenceContactQuery,
    );
    await main.getByRole("textbox", { name: "Filter by saved contact" }).clear();
    await clearContact;
    await expect(main.getByRole("link", { name: "Platform follow-up", exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`global-sequences-${width}.png`),
      fullPage: true,
    });
    await main.getByRole("table").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`global-sequences-table-${width}.png`),
      fullPage: true,
    });
    await main.getByRole("link", { name: "Platform follow-up", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/app/g/${appGroupId}.*campaign=fixture-second-campaign`),
    );
    await expect(
      page.getByRole("heading", { name: "Platform follow-up", exact: true }),
    ).toBeVisible();
    await page.goto("/app?view=sequence&role=all");
    await page
      .getByTestId("account-sequences")
      .getByRole("button", { name: "New sequence", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Role for new sequence" })
      .selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/compose=new/);
    await expect(page.getByRole("dialog", { name: "New sequence", exact: true })).toBeVisible();
    expect(fixture.unknown).toEqual([]);
  });

for (const width of [1440, 390])
  test(`saved campaigns render the first bounded page without waiting for later pages at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockRecruitingApp(page);
    const reads: Record<string, unknown>[] = [];
    let release!: () => void;
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/rpc/recruiting/accountView", async (route) => {
      const input = route.request().postDataJSON().json as Record<string, unknown>;
      if (!input.sequenceSummary) return route.fallback();
      reads.push(input);
      const offset = Number(input.cursor ?? 0);
      if (offset) await later;
      const count = Math.min(25, 61 - offset);
      return route.fulfill({
        json: {
          json: {
            roles: [
              {
                id: "fixture-recruiting-role",
                title: "Platform Engineer",
                threadId: "fixture-thread",
                groupId: appGroupId,
                stage: "outreach",
              },
            ],
            items: Array.from({ length: count }, (_, index) => ({
              roleId: "fixture-recruiting-role",
              campaigns: [
                {
                  status: "ready",
                  sourceKind: "native",
                  serverId: "fixture-source",
                  leads: [],
                  leadsComplete: false,
                  stats: { sent: 4, opened: 3, replied: 1 },
                  campaign: {
                    id: `saved-${offset + index}`,
                    name: `Saved campaign ${offset + index + 1}`,
                    eaccount: null,
                    status: 1,
                    stopOnReply: null,
                  },
                },
              ],
            })),
            total: 61,
            nextCursor: offset + count < 61 ? String(offset + count) : null,
            sequenceSummary: {
              contacted: null,
              active: null,
              opened: 3,
              clicked: null,
              replied: 1,
              interested: null,
              sent: 4,
              partial: true,
            },
          },
        },
      });
    });
    await page.goto("/app?view=sequence&role=all");
    const main = page.getByTestId("account-sequences");
    await expect(main.getByRole("link", { name: "Saved campaign 1", exact: true })).toBeVisible();
    await expect(main.locator("tbody tr")).toHaveCount(25);
    await expect(main).toContainText("61 sequences");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ sequenceSummary: true, limit: 25 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`saved-sequences-page-${width}.png`),
      fullPage: true,
    });
    await main.getByRole("button", { name: "Next", exact: true }).click();
    await expect.poll(() => reads.length).toBe(2);
    expect(reads[1]).toMatchObject({ cursor: "25", limit: 25 });
    await expect(main).toContainText("Loading sequences…");
    release();
    await expect(main.getByRole("link", { name: "Saved campaign 26", exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Saved campaign 1", exact: true })).toHaveCount(0);
    expect(fixture.unknown).toEqual([]);
  });

test("a role keeps saved CRM sequences when live campaign access is unavailable", async ({
  page,
}) => {
  const fixture = await mockRecruitingApp(page, { multipleCampaigns: true });
  await page.route("**/rpc/recruiting/roleCampaign", (route) =>
    route.fulfill({
      json: { json: { status: "unavailable", serverId: null, campaign: null, leads: [] } },
    }),
  );
  await page.goto(`/app/g/${appGroupId}?view=sequence`);
  const sequence = page.getByRole("region", { name: "Sequence", exact: true });
  await expect(sequence.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(
    sequence.getByRole("button", { name: "Platform outreach", exact: true }),
  ).toBeVisible();
  await sequence.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(
    sequence.getByRole("button", { name: "Platform follow-up", exact: true }),
  ).toBeVisible();
  await expect(
    sequence.getByText("Could not read this sequence. Try refreshing.", { exact: true }),
  ).toHaveCount(0);
  await expect(sequence.getByRole("button", { name: "New sequence", exact: true })).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("saved-sequence-without-live-access.png"),
    fullPage: true,
  });
  expect(fixture.unknown).toEqual([]);
});

for (const selected of ["fixture-campaign", "fixture-second-campaign"]) {
  test(`saved CRM deep link renders selected contacts and switches safely: ${selected}`, async ({
    page,
  }) => {
    await mockRecruitingApp(page, { multipleCampaigns: true });
    const ids = ["fixture-campaign", "fixture-second-campaign"];
    const names = ["Platform outreach", "Platform follow-up"];
    const requests: Record<string, unknown>[] = [];
    const at = "2026-10-25T00:00:00Z";
    await page.route("**/rpc/recruiting/accountView", (route) =>
      route.fulfill({
        json: {
          json: {
            roles: [
              {
                id: "fixture-role",
                title: "Staff Platform Engineer",
                threadId: "fixture-thread",
                groupId: appGroupId,
                stage: "outreach",
              },
            ],
            items: ids.map((id, index) => ({
              roleId: "fixture-role",
              campaigns: [
                {
                  status: "ready",
                  sourceKind: "crm",
                  serverId: crmTarget.mcpServerId,
                  campaign: {
                    id,
                    name: names[index],
                    status: 2,
                    eaccount: null,
                    stopOnReply: null,
                  },
                  leads: [],
                  leadsComplete: false,
                },
              ],
            })),
            total: 2,
            nextCursor: null,
          },
        },
      }),
    );
    await page.route("**/rpc/recruiting/roleCampaign", (route) =>
      route.fulfill({
        json: { json: { status: "unavailable", serverId: null, campaign: null, leads: [] } },
      }),
    );
    await page.route("**/rpc/recruiting/crmData", async (route) => {
      const input = route.request().postDataJSON().json;
      if (!["roleCampaigns", "campaignLeads"].includes(input.operation)) return route.fallback();
      requests.push(input);
      expect(input).toMatchObject({
        serverId: crmTarget.mcpServerId,
        serverRevision: crmTarget.serverRevision,
        organizationId: crmTarget.organizationId,
      });
      const base = {
        operation: input.operation,
        source: {
          serverId: crmTarget.mcpServerId,
          serverRevision: crmTarget.serverRevision,
          organizationId: crmTarget.organizationId,
          name: "CRM",
        },
        checkedAt: at,
        offset: Number(input.offset ?? input.cursor ?? 0),
        nextOffset: null,
      };
      if (input.operation === "roleCampaigns") {
        const index = input.campaignId ? ids.indexOf(input.campaignId) : base.offset ? 1 : 0;
        return route.fulfill({
          json: {
            json: {
              ...base,
              scope: "stored_role_campaigns",
              crmRoleId: crmTarget.crmRoleId,
              nextOffset: input.campaignId || base.offset ? null : 25,
              items:
                index < 0 ? [] : [{ id: ids[index], name: names[index], status: 2, syncedAt: at }],
            },
          },
        });
      }
      const second = input.campaignId === ids[1];
      const next = base.offset > 0;
      return route.fulfill({
        json: {
          json: {
            ...base,
            campaignId: input.campaignId,
            nextOffset: !second && !next ? 25 : null,
            items: [
              {
                id: next ? "private-lead-2" : "private-lead-1",
                candidateId: null,
                person: {
                  name: second ? "Saved Zoe" : next ? "Saved Blake" : "Saved Avery",
                  email: second ? "zoe@example.test" : "avery@example.test",
                  profileImageUrl: null,
                },
                status: next ? -1 : 1,
                interestStatus: second ? null : 1,
                openCount: 2,
                replyCount: 1,
                lastContactAt: at,
                lastReplyAt: at,
                syncedAt: at,
              },
              ...(!second && !next
                ? [
                    {
                      id: "private-lead-unreported",
                      candidateId: null,
                      person: null,
                      status: 2,
                      interestStatus: null,
                      openCount: null,
                      replyCount: null,
                      lastContactAt: null,
                      lastReplyAt: null,
                      syncedAt: at,
                    },
                  ]
                : []),
            ],
          },
        },
      });
    });
    await page.goto("/app?view=sequence&role=all");
    const main = page.getByTestId("account-sequences");
    await main.getByRole("link", { name: names[ids.indexOf(selected)], exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`campaign=${selected}`));
    expect(new URL(page.url()).searchParams.has("campaignServer")).toBe(false);
    const sequence = page.getByRole("region", { name: "Sequence", exact: true });
    await expect(
      sequence.getByRole("heading", { name: names[ids.indexOf(selected)], exact: true }),
    ).toBeVisible();
    const contacts = sequence.getByRole("region", { name: "Contacts", exact: true });
    await expect(
      contacts.getByText(selected === ids[1] ? "Saved Zoe" : "Saved Avery", { exact: true }),
    ).toBeVisible();
    await expect(
      sequence.getByText("Select a saved sequence to view its contacts.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      sequence.getByRole("button", { name: "View sequence", exact: true }),
    ).toBeDisabled();
    await expect(contacts).not.toContainText("private-lead");
    if (selected === ids[0]) {
      await expect(contacts.getByText("Not reported", { exact: true })).toBeVisible();
      await contacts.getByRole("button", { name: "Load more", exact: true }).click();
      await expect(contacts.getByText("Saved Blake", { exact: true })).toBeVisible();
      await expect(
        sequence
          .getByRole("button", { name: "Bounced", exact: true })
          .locator("../..")
          .locator("dd"),
      ).toContainText("1");
    } else {
      await expect(
        sequence
          .getByRole("button", { name: "Interested", exact: true })
          .locator("../..")
          .locator("dd"),
      ).toContainText("Not reported");
      await sequence.getByRole("combobox", { name: "Campaign", exact: true }).selectOption(ids[0]);
      await expect(sequence.getByRole("heading", { name: names[0], exact: true })).toBeVisible();
      await expect(contacts.getByText("Saved Avery", { exact: true })).toBeVisible();
      await expect(contacts.getByText("Saved Zoe", { exact: true })).toHaveCount(0);
    }
    await page.screenshot({
      path: test.info().outputPath(`saved-sequence-detail-${selected}.png`),
      fullPage: true,
    });
    const before = requests.filter((request) => request.operation === "campaignLeads").length;
    await page.goto(`/app/g/${appGroupId}?view=sequence&campaign=not-authorized`);
    await expect(
      page.getByText("This sequence is not saved for this role.", { exact: true }),
    ).toBeVisible();
    expect(requests.filter((request) => request.operation === "campaignLeads").length).toBe(before);
    await expect(page.getByText("Saved Zoe", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Saved Avery", { exact: true })).toHaveCount(0);
  });
}
