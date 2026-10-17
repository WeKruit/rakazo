import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.describe.configure({ mode: "serial" });

test("recruiting dashboard includes unassessed saved candidates and their source rounds", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/marketing-shots.html?view=recruiting");
  await page.getByRole("tab", { name: "Dashboard", exact: true }).click();
  const totals = page.getByLabel("Saved candidate totals", { exact: true });
  await expect(
    totals.getByText("Saved source rows", { exact: true }).locator("..").locator("dd"),
  ).toHaveText("4");
  await expect(
    totals.getByText("Candidates", { exact: true }).locator("..").locator("dd"),
  ).toHaveText("3");
  await expect(
    totals.getByText("Unassessed", { exact: true }).locator("..").locator("dd"),
  ).toHaveText("2");
  await captureScreenshot(page, testInfo, "recruiting-candidate-dashboard");
  await page.getByRole("tab", { name: "Evidence", exact: true }).click();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "CRM", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Synced", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Outcome unknown", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByRole("cell", { name: "No CRM receipt", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "recruiting-candidate-crm-status");
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Assessment state", exact: true })
    .selectOption("unassessed");
  await expect(page.getByRole("button", { name: /^Synthetic unassessed/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Synthetic candidate/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Synthetic unassessed/ }).click();
  await expect(page.getByLabel("Saved candidate sources", { exact: true })).toContainText(
    "provider_report",
  );
  await captureScreenshot(page, testInfo, "recruiting-unassessed-candidate-source");
});

test("recruiting evidence opens retained text at the exact saved selection", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/marketing-shots.html?view=recruiting");
  await page.getByRole("tab", { name: "Evidence", exact: true }).click();
  await page.getByRole("button", { name: /^Synthetic candidate/ }).click();
  await page.getByText("profile.summary", { exact: true }).first().click();
  const original = page.getByLabel("Source text", { exact: true }).first();
  await expect(original).toContainText("Candidate note");
  await expect(original.locator("mark")).toHaveText("Designed coordinate transforms 🧭 in Python.");
  await expect(original).toContainText("Employment type and dates are not provided.");
  await captureScreenshot(page, testInfo, "recruiting-original-source-selection");
});

test("agent-attached files appear as downloadable cards", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `artifact-card-${stamp}@rakazo.test`, "password12", "Artifact Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write notes/result.txt and attach it to the thread");
  await page.keyboard.press("Enter");

  // Scope to ArtifactFileCard text (name + mime); sidebar bot status can also
  // include the prompt path notes/result.txt once status syncs immediately.
  const fileCard = page.getByRole("button", { name: /result\.txt text\/plain/ });
  await expect(fileCard).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "current-file-card");

  const downloadPromise = page.waitForEvent("download");
  await fileCard.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("result.txt");
});

test("agent-attached Markdown opens a rendered preview and can be downloaded", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `markdown-preview-${stamp}@rakazo.test`, "password12", "Markdown Preview");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    "write path notes/preview.md and attach it to the thread says # Project preview",
  );
  await page.keyboard.press("Enter");

  const previewButton = page.getByRole("button", { name: "Preview preview.md" });
  await expect(previewButton).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "markdown-file-card");
  await previewButton.click();

  const dialog = page.getByRole("dialog", { name: "preview.md" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Project preview" })).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "Close preview" });
  const downloadButton = dialog.getByRole("button", { name: "Download preview.md" });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(downloadButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeButton).toBeFocused();
  await captureScreenshot(page, testInfo, "markdown-preview-open");

  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("preview.md");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(previewButton).toBeFocused();
});
