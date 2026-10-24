import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`actual Sequence shows all observed campaign details at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockRecruitingApp(page);
    await page.route("**/rpc/recruiting/roleCampaign", (route) =>
      route.fulfill({
        json: {
          json: {
            status: "ready",
            serverId: "fixture-campaign-source",
            leads: [],
            campaign: {
              id: "fixture-campaign",
              name: "Platform outreach",
              eaccount: "recruiter@example.test",
              status: 1,
              stopOnReply: true,
              observedDetails: {
                schedules: [
                  {
                    name: "Morning window",
                    from: "09:00",
                    to: "11:00",
                    timezone: "America/Chicago",
                    days: { "1": true },
                  },
                  {
                    name: "Evening window",
                    from: "17:00",
                    to: "19:00",
                    timezone: "Europe/London",
                    days: null,
                  },
                ],
                sequences: [
                  {
                    steps: [
                      {
                        type: "email",
                        delay: 2,
                        delayUnit: "days",
                        variants: [
                          {
                            subject: "Explore the platform role",
                            body: "Synthetic initial email.",
                          },
                          {
                            subject: "Alternative introduction",
                            body: "Synthetic alternate variant.",
                          },
                        ],
                      },
                    ],
                  },
                  {
                    steps: [
                      {
                        type: "email",
                        delay: 4,
                        delayUnit: "days",
                        variants: [{ subject: "Following up", body: "Synthetic follow-up email." }],
                      },
                      null,
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
    );
    await page.goto(`/app/g/${appGroupId}?view=sequence`);
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    await page.getByRole("button", { name: "Collapse role chat", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sending schedule", exact: true }),
    ).toBeVisible();
    for (const text of [
      "Morning window",
      "Evening window",
      "Explore the platform role",
      "Alternative introduction",
      "Following up",
      "Email step unavailable.",
    ])
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    await page
      .getByRole("heading", { name: "Sending schedule", exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    const path = info.outputPath(`sequence-observed-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(`sequence-observed-${width}`, { path, contentType: "image/png" });
  });
}
