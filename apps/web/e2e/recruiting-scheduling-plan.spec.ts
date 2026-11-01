import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`actual Inbox reviewable scheduling plan at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    const fixture = await mockRecruitingApp(page, { scheduling: true });
    await page.goto(`/app/g/${appGroupId}?view=inbox`);
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    await page.getByRole("button", { name: "Collapse role chat", exact: true }).click();
    await page.getByRole("button", { name: "Avery Example", exact: true }).click();
    await page.getByRole("button", { name: "Plan interview", exact: true }).click();
    const form = page.getByRole("region", { name: "Interview plan", exact: true });
    await form.getByLabel("Candidate time zone", { exact: true }).fill("America/New_York");
    await form.getByLabel("Interviewer time zone", { exact: true }).fill("Europe/London");
    await form.getByLabel("Requested interviewer name", { exact: true }).fill("Recruiter Example");
    await form
      .getByLabel("Requested interviewer email", { exact: true })
      .fill("recruiter@example.test");
    await form.locator('input[name$="scheduling-slot"]').check();
    await page.screenshot({
      path: info.outputPath(`scheduling-select-times-${width}.png`),
      fullPage: true,
    });
    await form.getByRole("button", { name: "Next", exact: true }).click();
    await expect(form).toContainText("Step 2 · Customize invite");
    await page.screenshot({
      path: info.outputPath(`scheduling-customize-${width}.png`),
      fullPage: true,
    });
    await expect(form).toContainText("GMT-04:00");
    await form.getByRole("button", { name: "Review plan", exact: true }).click();
    expect(fixture.calls.some((call) => call.method === "recruiting/saveSchedulingPlan")).toBe(
      false,
    );
    await page.screenshot({
      path: info.outputPath(`scheduling-review-${width}.png`),
      fullPage: true,
    });
    await form.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(form).toContainText("Booking and sending still require approval");
    const saved = fixture.calls.find((call) => call.method === "recruiting/saveSchedulingPlan")!;
    expect(saved.input.candidate).toMatchObject({
      name: "Avery Example",
      timeZone: "America/New_York",
    });
    expect(saved.input.originalEmail).toMatchObject({ eaccount: "recruiter@example.test" });
    await form.getByRole("button", { name: "Review in role chat", exact: true }).click();
    const composer = page.locator('textarea[name="chat-message"]');
    await expect(composer).toHaveValue(/Review the saved interview plan/);
    await expect(composer).not.toHaveValue(/fixture-saved-plan/);
    expect(fixture.calls.some((call) => call.method === "threads/send")).toBe(false);
    await page.screenshot({
      path: info.outputPath(`scheduling-chat-review-${width}.png`),
      fullPage: true,
    });
    await page.goto(`/app/g/${appGroupId}?view=interview`);
    await expect
      .poll(
        () => fixture.calls.filter((call) => call.method === "recruiting/schedulingPlans").length,
      )
      .toBeGreaterThan(1);
    await expect(
      page.getByRole("region", { name: "Saved interview plans", exact: true }),
    ).toContainText("not an approval");
    await page
      .getByRole("region", { name: "Saved interview plans", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`scheduling-interview-history-${width}.png`),
      fullPage: true,
    });
    expect(fixture.unknown).toEqual([]);
  });
}

test("native Inbox uses an exact role candidate record for the same plan flow", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
  const fixture = await mockRecruitingApp(page, { scheduling: true, nativeScheduling: true });
  await page.goto(`/app/g/${appGroupId}?view=inbox`);
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  await page.getByRole("button", { name: "Plan interview", exact: true }).click();
  const form = page.getByRole("region", { name: "Interview plan", exact: true });
  await form
    .getByLabel("Candidate record", { exact: true })
    .selectOption("fixture-native-candidate");
  await form.getByLabel("Candidate time zone", { exact: true }).fill("America/New_York");
  await form.getByLabel("Interviewer time zone", { exact: true }).fill("Europe/London");
  await form.getByLabel("Requested interviewer name", { exact: true }).fill("Recruiter Example");
  await form
    .getByLabel("Requested interviewer email", { exact: true })
    .fill("recruiter@example.test");
  await form.locator('input[name$="scheduling-slot"]').check();
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await form.getByRole("button", { name: "Review plan", exact: true }).click();
  await form.getByRole("button", { name: "Save plan", exact: true }).click();
  await expect(form).toContainText("Plan saved");
  const saved = fixture.calls.find((call) => call.method === "recruiting/saveSchedulingPlan")!;
  expect(saved.input.candidate).toMatchObject({ candidateKey: "fixture-native-candidate" });
  expect(saved.input.originalEmail).not.toHaveProperty("crm");
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("scheduling-native-saved-1440.png"),
    fullPage: true,
  });
  expect(fixture.unknown).toEqual([]);
});

test("multiple recorded times customize a draft and keep every external action unapproved", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
  const fixture = await mockRecruitingApp(page, { scheduling: true });
  await page.route("**/rpc/recruiting/schedulingPlans", (route) =>
    route.fulfill({
      json: {
        json: {
          plans: [],
          partial: false,
          slots: ["05", "06"].map((hour) => ({
            sourceId: "fixture-calendar",
            sourceRevision: 1,
            eventTypeId: 42,
            availabilityEffectId: "fixture-availability",
            start: `2026-11-01T${hour}:30:00Z`,
            end: `2026-11-01T${Number(hour) + 1 < 10 ? "0" : ""}${Number(hour) + 1}:00:00Z`,
            lengthInMinutes: 30,
            observedAt: "2026-10-23T12:00:00Z",
          })),
        },
      },
    }),
  );
  await page.goto(`/app/g/${appGroupId}?view=inbox`);
  await page.getByRole("button", { name: "Plan interview", exact: true }).click();
  const form = page.getByRole("region", { name: "Interview plan", exact: true });
  await form.getByLabel("Multiple options", { exact: true }).check();
  await form.getByLabel("Candidate time zone", { exact: true }).fill("America/New_York");
  await form.getByLabel("Interviewer time zone", { exact: true }).fill("Europe/London");
  await form.getByLabel("Requested interviewer name", { exact: true }).fill("Recruiter Example");
  await form
    .getByLabel("Requested interviewer email", { exact: true })
    .fill("recruiter@example.test");
  const choices = form.locator('input[name$="scheduling-slot"]');
  await choices.nth(0).check();
  await choices.nth(1).check();
  await form.getByRole("button", { name: "Next", exact: true }).click();
  await expect(form).toContainText("Step 2 · Customize invite");
  await form.getByLabel("Requested guests", { exact: true }).fill("panel@example.test");
  await form.getByRole("button", { name: "In person", exact: true }).click();
  await form.getByLabel("Requested location", { exact: true }).fill("Interview room 3");
  await form.getByLabel("Notes for the email", { exact: true }).fill("Bring the design doc.");
  await form.getByRole("button", { name: "Review proposed times", exact: true }).click();
  await expect(form).toContainText("GMT-04:00");
  await expect(form).toContainText("GMT-05:00");
  await page.screenshot({
    path: info.outputPath("scheduling-multiple-preview-1440.png"),
    fullPage: true,
  });
  await form.getByRole("button", { name: "Draft in role chat", exact: true }).click();
  await expect(page.locator('textarea[name="chat-message"]')).toHaveValue(/Bring the design doc/);
  await expect(page.locator('textarea[name="chat-message"]')).toHaveValue(/panel@example.test/);
  expect(
    fixture.calls.some((call) =>
      /saveSchedulingPlan|threads\/send|create_booking/.test(call.method),
    ),
  ).toBe(false);
  expect(fixture.unknown).toEqual([]);
});
