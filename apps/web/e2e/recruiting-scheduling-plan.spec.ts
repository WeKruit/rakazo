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
    await form.getByLabel("Candidate IANA timezone", { exact: true }).fill("America/New_York");
    await form.getByLabel("Interviewer IANA timezone", { exact: true }).fill("Europe/London");
    await form.getByLabel("Requested interviewer name", { exact: true }).fill("Recruiter Example");
    await form
      .getByLabel("Requested interviewer email", { exact: true })
      .fill("recruiter@example.test");
    await form.getByRole("radio").check();
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
    expect(fixture.unknown).toEqual([]);
  });
}

test("native Inbox uses an exact role candidate record for the same plan flow", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
  const fixture = await mockRecruitingApp(page, { scheduling: true, nativeScheduling: true });
  await page.goto(`/app/g/${appGroupId}?view=inbox`);
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  await page.getByRole("button", { name: "Plan interview", exact: true }).click();
  const form = page.getByRole("region", { name: "Interview plan", exact: true });
  await form
    .getByLabel("Candidate record", { exact: true })
    .selectOption("fixture-native-candidate");
  await form.getByLabel("Candidate IANA timezone", { exact: true }).fill("America/New_York");
  await form.getByLabel("Interviewer IANA timezone", { exact: true }).fill("Europe/London");
  await form.getByLabel("Requested interviewer name", { exact: true }).fill("Recruiter Example");
  await form
    .getByLabel("Requested interviewer email", { exact: true })
    .fill("recruiter@example.test");
  await form.getByRole("radio").check();
  await form.getByRole("button", { name: "Review plan", exact: true }).click();
  await form.getByRole("button", { name: "Save plan", exact: true }).click();
  await expect(form).toContainText("Plan saved");
  const saved = fixture.calls.find((call) => call.method === "recruiting/saveSchedulingPlan")!;
  expect(saved.input.candidate).toMatchObject({ candidateKey: "fixture-native-candidate" });
  expect(saved.input.originalEmail).not.toHaveProperty("crm");
  expect(fixture.unknown).toEqual([]);
});
