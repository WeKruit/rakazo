import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("download a read-only conversation without granting access to the account", async ({
  page,
}, testInfo) => {
  await signup(page, `export-${Date.now()}@rakazo.test`, "password12", "Recruiter");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/send", {
    botId,
    text: "Keep the role requirements in this conversation.",
  });
  await page.reload();
  const button = page.getByRole("button", { name: "Export conversation", exact: true });
  await expect(button).toBeEnabled();
  await captureScreenshot(page, testInfo, "conversation-export-control");
  const downloading = page.waitForEvent("download");
  await button.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  const path = testInfo.outputPath("conversation.html");
  await download.saveAs(path);
  const html = await readFile(path, "utf8");
  expect(html).toContain("Keep the role requirements in this conversation.");
  expect(html).toContain("default-src &#x27;none&#x27;");
  expect(html).not.toContain(botId);
  expect(html).not.toContain("<script");
  await expect(button).toBeEnabled();
});
