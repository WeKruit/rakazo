import assert from "node:assert/strict";
import type { Page } from "@playwright/test";

/** Synthetic no-sandbox fixture only; never contacts a real computer provider. */
export async function verifySandboxRecovery(page: Page, me: { sandboxProvider: string }) {
  page.setDefaultTimeout(10000);
  await page.getByTitle("Agent computer", { exact: true }).click();
  const hint = page.getByTestId("computers-unavailable-hint");
  await hint.waitFor();
  await hint.getByRole("button", { name: "Copy .env example", exact: true }).waitFor();
  let healthy = false;
  await page.route("**/rpc/health", (route) => route.fulfill({ json: { json: { ok: healthy } } }));
  await page.route("**/rpc/me", (route) =>
    route.fulfill({ json: { json: { ...me, sandboxProvider: healthy ? "docker" : "none" } } }),
  );
  await hint.getByRole("button", { name: "Check again", exact: true }).click();
  await hint.getByText(/Could not verify computer setup/).waitFor();
  assert.match(await hint.innerText(), /Server health check failed/);
  assert.equal(await hint.getAttribute("role"), "alert");
  healthy = true;
  await hint.getByRole("button", { name: "Check again", exact: true }).click();
  await page
    .getByText("Computers are available. Reload or open a bot to continue.", { exact: true })
    .waitFor();
  assert.equal(await hint.getByRole("button", { name: "Check again", exact: true }).count(), 0);
  console.error("No-sandbox recovery controls: initial / failed check / retry success passed");
}
