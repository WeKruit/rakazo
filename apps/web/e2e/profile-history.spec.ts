import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { projectRecruitingCandidateReport } from "@rakazo/core";
import {
  profileLogoUrl,
  rawEducationDescription,
  rawEmployerDescription,
  richProfileRow,
} from "../src/pages/recruiting/__fixtures__/profile-history";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

for (const width of [1440, 390]) {
  test(`retained history and supplied logo in the actual profile at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
    await page.routeWebSocket("**/*", () => {});
    const logo = profileLogoUrl;
    const report = projectRecruitingCandidateReport(richProfileRow);
    const fixture = await mockRecruitingApp(page, { candidateReport: report });
    const assetRequests: string[] = [];
    await page.route(logo, async (route) => {
      assetRequests.push(route.request().url());
      await route.fulfill({
        path: fileURLToPath(new URL("./fixtures/company-logo.svg", import.meta.url)),
        contentType: "image/svg+xml",
      });
    });
    let failedRequests = 0;
    await page.route("https://assets.example.test/broken-logo.svg", async (route) => {
      failedRequests++;
      await route.fulfill({ status: 403, body: "Synthetic denied image response" });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/app/g/${appGroupId}?view=contacts`);
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    await page.getByRole("button", { name: "Collapse role chat", exact: true }).click();
    const candidate = page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Avery Example", exact: true }) });
    if (width === 1440) {
      await expect(candidate).toContainText("Example University");
      await expect(candidate).toContainText("PhD");
      await expect(candidate).not.toContainText(rawEducationDescription);
    }
    await page.getByRole("button", { name: "Avery Example", exact: true }).first().click();
    const panel = page.getByTestId("recruiting-detail-panel");
    const experience = panel
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Experience", exact: true }) });
    await panel.getByRole("button", { name: "Experience", exact: true }).click();
    await expect(experience.locator("li")).toHaveCount(5);
    const rawWork = experience
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "Employer Descriptions" }) });
    await expect(rawWork).not.toHaveAttribute("open", "");
    await expect(rawWork).toContainText(rawEmployerDescription);
    await expect(experience.locator("li").nth(4)).toContainText("Research and Teaching Assistant");
    const image = experience.locator("img").first();
    await expect(image).toHaveAttribute("src", logo);
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    expect(assetRequests.length).toBeGreaterThan(0);
    await expect.poll(() => failedRequests).toBe(1);
    await expect(experience.locator("li").nth(1).locator("img")).toHaveCount(0);
    await expect(experience.locator("li").nth(1)).toContainText("SR");
    await expect(
      experience.locator("li").first().getByRole("link", { name: "Example Labs", exact: true }),
    ).toHaveAttribute("href", "https://company.example.test/");
    await page.screenshot({ path: testInfo.outputPath(`profile-experience-${width}.png`) });
    const description = experience.locator("li").first().locator("summary");
    await description.focus();
    await page.keyboard.press("Enter");
    await expect(description.locator("..")).toHaveAttribute("open", "");
    await expect(description.locator("..")).toContainText(
      richProfileRow.experience.value[0]!.description!.trim(),
    );
    await page.screenshot({ path: testInfo.outputPath(`profile-description-${width}.png`) });
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Education", exact: true }).click();
    const education = panel
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Education", exact: true }) });
    await expect(education.locator("li")).toHaveCount(3);
    await expect(education.locator("li").nth(0)).toContainText("PhD");
    await expect(education.locator("li").nth(1)).toContainText("MS");
    await expect(education.locator("li").nth(2)).not.toContainText("Present");
    await expect(education).not.toContainText("Research and Teaching Assistant");
    await expect(education).toContainText(rawEducationDescription);
    await expect(
      education
        .locator("li")
        .first()
        .getByRole("link", { name: "Example University", exact: true }),
    ).toHaveAttribute("href", "https://school.example.test/");
    await expect(education.locator("li").first().locator("img")).toHaveAttribute(
      "src",
      "https://assets.example.test/school-logo.svg",
    );
    await expect(education.locator("li").nth(1).locator("img")).toHaveAttribute(
      "src",
      "https://assets.example.test/school-logo.svg",
    );
    await expect(education.getByRole("heading", { name: "Education", exact: true })).toBeInViewport();
    await expect.poll(async () => (await education.boundingBox())?.y ?? Infinity).toBeLessThan(250);
    await page.screenshot({ path: testInfo.outputPath(`profile-education-${width}.png`) });
    expect(fixture.unknown).toEqual([]);
    expect(errors).toEqual([]);
  });
}
