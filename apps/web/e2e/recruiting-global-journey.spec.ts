import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc } from "./helpers";

type Overview = {
  roles: Array<{ id: string; title: string; groupId: string; threadId: string }>;
  items: Array<{
    roleId: string;
    campaign?: { stats?: { sent: number; opened: number; replied: number } };
    correspondence?: { emails: unknown[]; events: unknown[] };
    scheduling?: { plans: Array<{ bookingStatus: string | null }> };
  }>;
};
async function overview(page: Page, view = "roles") {
  return rpc<Overview>(page, "recruiting/accountView", { view, limit: 20 });
}
async function send(page: Page, text: string, mode: "enter" | "button" = "enter") {
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  if (mode === "button") await page.getByRole("button", { name: "Send", exact: true }).click();
  else await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("transcript").getByText(text, { exact: true })).toBeVisible();
}
async function assertPageFacts(page: Page, view: string) {
  const main = page.getByTestId("account-recruiting-view");
  if (["shortlist", "contacts", "sequence", "inbox"].includes(view)) {
    const role = main.getByRole("region", { name: "Fixture Engineer", exact: true });
    if (view === "sequence") {
      for (const [label, count] of [
        ["Sent", "4"],
        ["Opened", "3"],
        ["Replied", "1"],
      ])
        await expect(
          role
            .locator("dt")
            .filter({ hasText: new RegExp(`^${label}$`) })
            .locator("..")
            .locator("dd"),
        ).toHaveText(count);
      await expect(
        role.getByText("morgan.reed@example.test", { exact: true }).first(),
      ).toBeVisible();
    } else if (view === "inbox") {
      await expect(role.getByText("1 replies", { exact: true })).toBeVisible();
    } else {
      await expect(role.getByText("1 people", { exact: true })).toBeVisible();
    }
  }
}

async function newRole(page: Page, title: string) {
  await page
    .getByTestId("recruiting-navigation")
    .getByRole("button", { name: "New Role", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Job description", exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Job description", exact: true })
    .fill(
      `We are hiring a ${title} in Chicago. Five years of experience. English required. Client approved the interview shortlist.`,
    );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect
    .poll(async () => (await overview(page)).roles.some((role) => role.title === title), {
      timeout: 45000,
    })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const records = await page.request.get(`${process.env.API_URL}/__e2e/recruiting-records`);
        return (await records.json()).some(
          (row: { kind: string; operation: string }) =>
            row.kind === "role" && row.operation === title,
        );
      },
      { timeout: 45000 },
    )
    .toBe(true);
}

test("fresh ordinary chat creates two product roles and all global pages share their records with Main", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.RECRUITING_JOURNEY_FIXTURE !== "1",
    "Run through the dedicated deterministic offline fixture harness",
  );
  test.setTimeout(240000);
  const answeredCards: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/rpc/threads/answer")
      answeredCards.push(request.url());
  });
  await page.goto("/sign-up");
  await expect(
    page.getByRole("heading", { name: "Create your WeKruit Headhunter account" }),
  ).toBeVisible();
  await page.getByPlaceholder("Your name").fill("Recruiting journey");
  await page
    .getByPlaceholder("Your email address")
    .fill(`recruiting-journey-${Date.now()}@example.test`);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL(/\/(app|onboarding)/);
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.waitForURL(/\/app\/g\//, { timeout: 30000 });
  await expect(page.getByTestId("recruiting-navigation")).toBeVisible();
  await newRole(page, "Fixture Engineer");
  await newRole(page, "Fixture Designer");
  const data = await overview(page);
  expect(data.roles).toHaveLength(2);
  const engineer = data.roles.find((role) => role.title === "Fixture Engineer")!;
  const pages = [
    ["brief", "Job Brief", "Fixture Engineer"],
    ["feedback", "Client feedback", "Client approved the interview shortlist."],
    ["shortlist", "Shortlist", "Morgan Reed"],
    ["contacts", "Contacts", "Morgan Reed"],
    ["sequence", "Sequence", "Fixture Engineer sequence"],
    ["inbox", "Inbox", "Interested in the interview"],
    ["interview", "Interview", "Morgan Reed interview"],
    ["tasks", "Tasks", "Follow up with Morgan Reed"],
    ["routines", "Routines", "Fixture Engineer follow up"],
  ] as const;
  for (const [view, label, row] of pages) {
    const navigation = page.getByTestId("recruiting-navigation");
    if (!(await navigation.isVisible()))
      await page.getByRole("button", { name: "Show navigation", exact: true }).click();
    await navigation.getByRole("button", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}.*role=all`));
    const picker = page.getByRole("combobox", {
      name: view === "routines" ? "Routine conversation" : "Role",
      exact: true,
    });
    await expect(picker).toBeVisible();
    await expect(
      page.getByText(row, { exact: false }).filter({ visible: true }).first(),
    ).toBeVisible();
    await assertPageFacts(page, view);
    await captureScreenshot(page, testInfo, `journey-${view}-global-desktop`);
    await picker.selectOption(engineer.id);
    await expect(page).toHaveURL(new RegExp(`role=${engineer.id}`));
    await expect(
      page.getByText(row, { exact: false }).filter({ visible: true }).first(),
    ).toBeVisible();
    await assertPageFacts(page, view);
    await captureScreenshot(page, testInfo, `journey-${view}-role-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByText(row, { exact: false }).filter({ visible: true }).first(),
    ).toBeVisible();
    await assertPageFacts(page, view);
    await captureScreenshot(page, testInfo, `journey-${view}-role-mobile`);
    if (view === "interview") {
      const event = page
        .getByRole("complementary", { name: "Saved calendar events", exact: true })
        .getByRole("button", { name: /Morgan Reed interview/ })
        .first();
      await event.scrollIntoViewIfNeeded();
      await expect(event).toBeInViewport();
      await captureScreenshot(page, testInfo, "journey-interview-role-mobile-saved-events");
    }
    await picker.selectOption("all");
    await expect(
      page.getByText(row, { exact: false }).filter({ visible: true }).first(),
    ).toBeVisible();
    await assertPageFacts(page, view);
    await captureScreenshot(page, testInfo, `journey-${view}-global-mobile`);
    if (view === "interview") {
      const event = page
        .getByRole("complementary", { name: "Saved calendar events", exact: true })
        .getByRole("button", { name: /Morgan Reed interview/ })
        .first();
      await event.scrollIntoViewIfNeeded();
      await expect(event).toBeInViewport();
      await captureScreenshot(page, testInfo, "journey-interview-global-mobile-saved-events");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.goto("/app?view=shortlist&role=all");
  const designer = data.roles.find((role) => role.title === "Fixture Designer")!;
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOption(designer.id);
  await expect(page.getByText("Morgan Lane", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Morgan Reed", { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/app");
  const sequence = await overview(page, "sequence");
  expect(sequence.items.every((item) => item.campaign?.stats?.sent === 4)).toBe(true);
  expect(sequence.items.every((item) => item.campaign?.stats?.opened === 3)).toBe(true);
  expect(sequence.items.every((item) => item.campaign?.stats?.replied === 1)).toBe(true);
  const interviews = await overview(page, "interview");
  expect(interviews.items.every((item) => (item.correspondence?.events.length ?? 0) > 0)).toBe(
    true,
  );
  expect(interviews.items.every((item) => (item.scheduling?.plans.length ?? 0) > 0)).toBe(true);
  expect(
    interviews.items.every((item) =>
      item.scheduling?.plans.every((plan) => plan.bookingStatus === "completed"),
    ),
  ).toBe(true);
  await page.goto(`/app/g/${engineer.groupId}`);
  await send(page, "what interviews are coming up", "button");
  await expect(
    page
      .getByTestId("transcript")
      .getByText(/Fixture Engineer: Morgan Reed interview/)
      .last(),
  ).toBeVisible();
  await expect(
    page.getByTestId("transcript").getByText(/Fixture Designer: Morgan Lane interview/),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "journey-role-chat-Send-button-actual-answer");
  await page
    .getByTestId("recruiting-navigation")
    .getByRole("button", { name: "Kruit", exact: true })
    .click();
  await send(page, "what interviews are coming up");
  await expect(
    page
      .getByTestId("transcript")
      .getByText(/Fixture Engineer: Morgan Reed interview/)
      .last(),
  ).toBeVisible();
  await send(page, "who is shortlisted", "button");
  await expect(
    page
      .getByTestId("transcript")
      .getByText(/Fixture Designer: Morgan Lane(?:\n|$)/)
      .last(),
  ).toBeVisible();
  await send(page, "how many replied");
  await expect(
    page
      .getByTestId("transcript")
      .getByText(/2 replies from 2 people/)
      .last(),
  ).toBeVisible();
  const records = await (
    await page.request.get(`${process.env.API_URL}/__e2e/recruiting-records`)
  ).json();
  expect(
    new Set(
      records
        .filter((row: { kind: string }) => row.kind === "tool")
        .map((row: { operation: string }) => row.operation),
    ),
  ).toEqual(new Set(["interviews", "shortlist", "replies"]));
  await expect(
    page
      .getByTestId("recruiting-navigation")
      .getByText("Could not read candidate records.", { exact: true }),
  ).toHaveCount(0);
  expect(records.some((row: { kind: string }) => row.kind === "calendar")).toBe(true);
  expect(records.some((row: { kind: string }) => row.kind === "mail")).toBe(true);
  expect(answeredCards).toEqual([]);
  await captureScreenshot(page, testInfo, "journey-global-Main-actual-tool-answers");
});
