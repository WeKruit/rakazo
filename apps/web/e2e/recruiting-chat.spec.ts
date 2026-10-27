import { expect, test } from "@playwright/test";
import { recruitingChatFixture } from "./fixtures/recruiting-chat";
import { captureScreenshot } from "./helpers";

test("feedback uses the real role route at desktop and phone widths", async ({
  page,
}, testInfo) => {
  const fixture = await recruitingChatFixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.goto("/app/g/group-fixture?view=feedback");
    await expect(page.getByRole("heading", { name: "Client feedback", exact: true })).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message Senior Perception Engineer" });
    await expect(composer).toHaveAttribute("placeholder", "Message…");
    await expect(page.getByText("No saved feedback yet.")).toBeAttached();
    await expect(
      page.getByRole("button", { name: "Approve calibration", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await captureScreenshot(page, testInfo, `feedback-${width}`);
    const transcript = page.getByTestId("transcript");
    await transcript.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await captureScreenshot(page, testInfo, `feedback-conversation-${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    const height = await composer.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(48);
    await composer.fill(
      Array.from({ length: 20 }, (_, i) => `Refinement ${i}: keep production ownership.`).join(
        "\n",
      ),
    );
    expect(await composer.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(
      height,
    );
    expect(await composer.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(
      192,
    );
    await composer.fill("");
    expect(await composer.evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
    await composer.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Attach file" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(composer).toBeFocused();
    await page.getByText("Search Criteria", { exact: true }).click();
    await expect(
      page.getByText("Shipped perception systems on robots", { exact: true }),
    ).toBeVisible();
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.calls.some((call) => call.procedure === "threads/answer")).toBe(false);
});

test("failed feedback offers a working retry", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await recruitingChatFixture(page, { feedback: "error" });
  await page.goto("/app/g/group-fixture?view=feedback");
  await expect(page.getByText("Could not load feedback", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "feedback-error");
  fixture.recoverFeedback();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No saved feedback yet.")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("feedback loading resolves to a real empty state", async ({ page }, testInfo) => {
  const fixture = await recruitingChatFixture(page, { feedback: "loading" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/g/group-fixture?view=feedback");
  const history = page.locator(".hire-candidate-feedback-history");
  await expect(history.getByRole("status")).toContainText("Loading…");
  await expect(history).not.toContainText("No saved feedback yet.");
  await captureScreenshot(page, testInfo, "feedback-loading");
  fixture.recoverFeedback();
  await expect(history).toContainText("No saved feedback yet.");
  expect(fixture.unexpected).toEqual([]);
});

test("run errors stay visible with a dark appearance preference", async ({ page }, testInfo) => {
  const fixture = await recruitingChatFixture(page, { failed: true, appearance: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/g/group-fixture?view=feedback");
  // Recruiting has its own light token palette, independent of this preference.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("composer-error")).toContainText("Something went wrong.");
  await expect(page.getByTestId("composer-error-retry")).toHaveText("Try again");
  await expect(page.getByTestId("composer-error")).toBeInViewport();
  await captureScreenshot(page, testInfo, "feedback-run-error");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toBeFocused();
  expect(fixture.unexpected).toEqual([]);
});

test("saved feedback and a short phone viewport remain usable", async ({ page }, testInfo) => {
  const fixture = await recruitingChatFixture(page, { feedback: "saved" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/g/group-fixture?view=feedback");
  const composer = page.getByRole("combobox");
  await composer.fill("Production experience\nand flexible location");
  await page.setViewportSize({ width: 390, height: 430 });
  await composer.focus();
  await expect(composer).toBeFocused();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await captureScreenshot(page, testInfo, "feedback-phone-keyboard-height");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByText("Prioritize people who shipped perception systems. Keep location flexible.", {
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "feedback-phone-saved-context");
  expect(fixture.unexpected).toEqual([]);
});

test("pending sends preserve typing and resist repeated submit", async ({ page }, testInfo) => {
  const fixture = await recruitingChatFixture(page, { running: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/g/group-fixture?view=feedback");
  const composer = page.getByRole("combobox", { name: "Message Senior Perception Engineer" });
  await composer.fill("Keep production ownership as a requirement.");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => fixture.calls.filter((call) => call.procedure === "threads/send").length)
    .toBe(1);
  await composer.fill("Next draft while the response is pending");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(fixture.calls.filter((call) => call.procedure === "threads/send")).toHaveLength(1);
  fixture.releaseSend();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(composer).toHaveValue("Next draft while the response is pending");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("Next draft while the response is pending\n");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "feedback-typing-while-running");
  expect(fixture.unexpected).toEqual([]);
});

test.describe("touch viewport", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  test("keeps approval controls and composer reachable on a phone", async ({ page }, testInfo) => {
    const fixture = await recruitingChatFixture(page);
    await page.goto("/app/g/group-fixture?view=feedback");
    await expect(
      page.getByRole("button", { name: "Approve calibration", exact: true }),
    ).toBeInViewport();
    const composer = page.getByRole("combobox");
    await composer.fill("Refine the production requirement");
    await expect(composer).toBeFocused();
    for (const name of ["Attach file", "Send", "Stop"]) {
      const button = page.getByRole("button", { name, exact: true });
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
      await expect(button).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await captureScreenshot(page, testInfo, "feedback-touch-phone");
    expect(fixture.unexpected).toEqual([]);
  });
});

test("narrow role chat resizes without losing drafts or scroll position", async ({
  page,
}, testInfo) => {
  const fixture = await recruitingChatFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/g/group-fixture?view=results");
  const chat = page.getByRole("region", { name: "Role conversation", exact: true });
  await expect(chat).toBeVisible();
  const resize = page.getByRole("separator", { name: "Resize chat", exact: true });
  await resize.focus();
  await page.keyboard.press("Home");
  await expect(resize).toHaveAttribute("aria-valuenow", "320");
  const transcript = chat.getByTestId("transcript");
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const composer = chat.getByRole("combobox");
  await composer.fill("A draft to preserve while resizing");
  expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
  await captureScreenshot(page, testInfo, "role-chat-320");
  await resize.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(composer).toHaveValue("A draft to preserve while resizing");
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  fixture.appendReply();
  await expect(
    page.getByText("The saved criteria are ready for your review.", { exact: true }),
  ).toBeAttached();
  expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Collapse role chat" }).click();
  await expect(page.getByRole("button", { name: "Open role chat" })).toBeFocused();
  await page.getByRole("button", { name: "Open role chat" }).click();
  await expect(composer).toHaveValue("A draft to preserve while resizing");
  expect(fixture.unexpected).toEqual([]);
});
