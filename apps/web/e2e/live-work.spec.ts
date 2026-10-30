import { expect, test } from "@playwright/test";
import { recruitingChatFixture } from "./fixtures/recruiting-chat";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/live-work.html";
const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

test("a running turn shows its steps in plain words with a clock, then folds", async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?phase=live`);
    const live = page.getByTestId("live-work");
    await expect(live.getByRole("status")).toContainText("Searching candidates…");
    await expect(live).toContainText("Reviewing the role");
    await expect(live).toContainText("Reviewing candidates");
    await expect(live).toContainText(/0:4\d/);
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
    await captureScreenshot(page, testInfo, `live-work-running-${viewport.name}`);

    await page.goto(`${fixture}?phase=done`);
    const summary = page.getByTestId("work-summary");
    await expect(summary.locator("summary")).toHaveText("Worked for 1m 12s");
    await expect(summary.getByText("Reviewing candidates")).toBeHidden();
    await captureScreenshot(page, testInfo, `live-work-done-${viewport.name}`);
    await summary.locator("summary").click();
    await expect(summary.getByText("Reviewing candidates")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
    await captureScreenshot(page, testInfo, `live-work-expanded-${viewport.name}`);
  }
});

test("work handed to a teammate shows as one entry named for its purpose", async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?phase=live&stage=1`);
    const live = page.getByTestId("live-work");
    const stage = live.getByTestId("work-stage");
    await expect(stage.locator("summary")).toContainText("Finding candidates");
    await expect(stage).toHaveAttribute("data-running", "true");
    await expect(stage).toContainText("Searching candidates");
    await expect(stage).toContainText("Reviewing candidates");
    await expect(live).toContainText("Reviewing the role");
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_|sourcer|bot-2/i);
    await captureScreenshot(page, testInfo, `work-stage-running-${viewport.name}`);

    await page.goto(`${fixture}?phase=done&stage=1`);
    const summary = page.getByTestId("work-summary");
    await summary.locator("summary").first().click();
    const done = summary.getByTestId("work-stage");
    await expect(done).not.toHaveAttribute("data-running");
    await expect(done.getByText("Reviewing candidates")).toBeHidden();
    await done.locator("summary").click();
    await expect(done.getByText("Reviewing candidates")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_|sourcer|bot-2/i);
    await captureScreenshot(page, testInfo, `work-stage-done-${viewport.name}`);
  }
});

test("specialist work stays compact and folds to a safe result", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?phase=live&specialist=1`);
    await expect(page.getByTestId("specialist-work")).toHaveText(/A specialist is working…/);
    await expect(page.getByTestId("specialist-work")).not.toHaveRole("button");
    await captureScreenshot(page, testInfo, `specialist-working-${viewport.name}`);
    await page.goto(`${fixture}?phase=done&specialist=1`);
    await expect(page.getByTestId("specialist-work")).toContainText("Specialist finished");
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
    await captureScreenshot(page, testInfo, `specialist-finished-${viewport.name}`);
  }
});

test("safe thinking and recovery states keep the clock visible", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const [phase, label] of [
      ["thinking", "Reviewing the search"],
      ["retrying", "Trying again…"],
      ["compacting", "Reviewing context…"],
    ]) {
      await page.goto(`${fixture}?state=${phase}`);
      await expect(page.getByTestId("live-work").getByRole("status")).toContainText(label!);
      await expect(page.getByTestId("live-work")).toContainText(/0:4\d/);
      await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
      await captureScreenshot(page, testInfo, `work-${phase}-${viewport.name}`);
    }
  }
});

test("recruiter role route shows one assistant with safe specialist and thinking state", async ({
  page,
}, testInfo) => {
  await recruitingChatFixture(page, { running: true, workState: "thinking" });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/app/g/group-fixture");
    const transcript = page.getByTestId("transcript");
    await expect(transcript.getByTestId("specialist-work")).toContainText(
      "A specialist is working…",
    );
    await expect(transcript.getByTestId("live-work")).toContainText("Reviewing the search");
    await expect(transcript).not.toContainText(
      /Internal worker|private task|internal-specialist|Recruiting role/,
    );
    await expect(transcript.getByTestId("run-trace")).toHaveCount(0);
    await captureScreenshot(page, testInfo, `recruiter-work-route-${viewport.name}`);
  }
});

test("step outcomes show audited business counts and failures", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?outcomes=1`);
    await expect(page.getByTestId("live-work")).toContainText("3 people with email");
    await expect(page.getByText("Step failed:", { exact: true })).toBeAttached();
    await expect(page.getByTestId("tool-rows").locator(".text-warning").first()).toHaveText("!");
    await expect(page.locator("body")).not.toContainText(/autumn|mcp|recruiting_/i);
    await captureScreenshot(page, testInfo, `work-outcomes-${viewport.name}`);
  }
});
