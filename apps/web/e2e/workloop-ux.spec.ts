import { expect, test } from "@playwright/test";
import type { Group, ThreadSnapshot } from "@rakazo/contracts";
import {
  checkFailureRecoveryUi,
  sendWithImmediateFeedback,
} from "../../../infra/acceptance/workloop-browser.mjs";
import { captureScreenshot, rpc, signup } from "./helpers";

test("native recruiting copy sends immediately and recovers through the actual composer", async ({
  page,
}, testInfo) => {
  // This case must stay on the existing local scripted harness, never a paid deployment.
  expect(new URL(testInfo.project.use.baseURL!).hostname).toBe("127.0.0.1");
  expect(process.env.AGENT_RUNTIME).toBe("scripted");
  expect(process.env.SANDBOX_PROVIDER).toBe("fake");
  await signup(page, `workloop-${Date.now()}@rakazo.test`, "password12", "Workloop Test");
  await page.waitForURL(/\/(onboarding|app)/);
  const client = <T = unknown>(procedure: string, input: unknown) => rpc<T>(page, procedure, input);
  await client("bootstrap", {});
  const home = await client<{ groupId: string }>("onboarding/ensureRecruiting", {});
  const assertCrew = (group: Group) => {
    expect(group.members.map((member) => member.name)).toEqual(
      expect.arrayContaining(["Main", "Sourcer", "Outreach", "Reviewer"]),
    );
  };
  assertCrew(await client<Group>("groups/get", { groupId: home.groupId }));
  const copy = await client<Group>("groups/duplicate", { groupId: home.groupId });
  try {
    expect(copy.id).not.toBe(home.groupId);
    await client("groups/update", { groupId: copy.id, name: "测试副本 · Workloop UX" });
    const group = await client<Group>("groups/get", { groupId: copy.id });
    assertCrew(group);
    expect(group.name).toMatch(/^测试副本 · /);
    const initial = await client<ThreadSnapshot>("threads/get", { groupId: copy.id });
    expect(initial.backgroundTasks).toEqual([]);
    await page.goto(`/app/g/${copy.id}?view=conversation`);
    const composer = page.getByRole("combobox", { name: /^Message/ });
    await expect(composer).toBeVisible();
    const text = "keep working on the Send button check";
    await composer.fill(text);
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/rpc/threads/send" &&
        response.request().postDataJSON()?.json?.text === text,
    );
    const startedAt = Date.now();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("transcript").getByText(text, { exact: true })).toBeVisible({
      timeout: 1_000,
    });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Thinking…|Queued/ })
        .first(),
    ).toBeVisible({ timeout: 1_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((await accepted).ok()).toBe(true);
    await captureScreenshot(page, testInfo, "native-send-immediate-feedback");
    await client("threads/stop", { groupId: copy.id, scope: "all" });
    await expect
      .poll(async () => {
        const thread = await client<ThreadSnapshot>("threads/get", { groupId: copy.id });
        return (thread.activeRuns ?? []).length;
      })
      .toBe(0);
    await sendWithImmediateFeedback(page, "keep working on the Enter key check");
    await captureScreenshot(page, testInfo, "native-enter-immediate-feedback");
    await client("threads/stop", { groupId: copy.id, scope: "all" });
    await expect
      .poll(async () => {
        const thread = await client<ThreadSnapshot>("threads/get", { groupId: copy.id });
        return (thread.activeRuns ?? []).length;
      })
      .toBe(0);
    const recovery = await checkFailureRecoveryUi(page, {
      rpc: client,
      groupId: copy.id,
      onCheckpoint: (name: string) => captureScreenshot(page, testInfo, name),
    });
    expect(recovery).toEqual({
      controlledFaultInjection: true,
      retryIntentCount: 1,
      reconnectOpenedModels: true,
    });
  } finally {
    await client("groups/archive", { groupId: copy.id });
  }
});
