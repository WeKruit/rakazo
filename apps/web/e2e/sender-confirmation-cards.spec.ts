import { expect, test } from "@playwright/test";
import type { ThreadMessage } from "@rakazo/contracts";
import { appGroupId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";
import { captureScreenshot } from "./helpers";

for (const width of [1440, 390]) {
  test(`sender identity uses exactly two native cards at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date(checkedAt));
    await mockRecruitingApp(page, { nativeScheduling: true });
    const boot = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/rpc/bootstrap",
    );
    await page.goto(`/app/g/${appGroupId}?view=conversation`);
    const bootstrap = (await (await boot).json()).json;
    const botId = bootstrap.bots[0].id;
    const messages: ThreadMessage[] = [
      {
        id: "sender-company-question",
        threadId: bootstrap.thread.threadId,
        seq: 1,
        runId: "sender-run",
        botId,
        role: "bot",
        createdAt: checkedAt,
        blocks: [
          { kind: "ask", text: "What company name should recipients see?", status: "pending" },
        ],
      },
    ];
    const run = () => ({
      id: "sender-run",
      botId,
      threadId: bootstrap.thread.threadId,
      taskId: "sender-task",
      status:
        messages.length === 2 &&
        messages[1]!.blocks[0]!.kind === "ask" &&
        messages[1]!.blocks[0]!.status === "answered"
          ? "completed"
          : "waiting_input",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: checkedAt,
      completedAt: null,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    });
    const snapshot = () => ({
      ...bootstrap.thread,
      messages,
      cursor: messages.length,
      run: run(),
      activeRuns: run().status === "waiting_input" ? [run()] : [],
    });
    await page.route("**/rpc/bootstrap", (route) =>
      route.fulfill({ json: { json: { ...bootstrap, thread: snapshot() } } }),
    );
    await page.route("**/rpc/threads/get", (route) =>
      route.fulfill({ json: { json: snapshot() } }),
    );
    await page.route("**/rpc/threads/messages", (route) =>
      route.fulfill({
        json: { json: { threadId: bootstrap.thread.threadId, messages, olderCursor: null } },
      }),
    );
    await page.route("**/rpc/threads/head", (route) =>
      route.fulfill({
        json: { json: { threadId: bootstrap.thread.threadId, cursor: messages.length } },
      }),
    );
    const answers: Array<{ messageId: string; answer: string }> = [];
    await page.route("**/rpc/threads/answer", async (route) => {
      const input = route.request().postDataJSON().json;
      answers.push(input);
      const message = messages.find((item) => item.id === input.messageId)!;
      const ask = message.blocks[0]!;
      if (ask.kind !== "ask") throw new Error("Expected native ask");
      ask.status = "answered";
      ask.answer = input.answer;
      if (input.messageId === "sender-company-question") {
        messages.push({
          id: "sender-address-confirmation",
          threadId: bootstrap.thread.threadId,
          seq: 2,
          runId: "sender-run",
          botId,
          role: "bot",
          createdAt: checkedAt,
          blocks: [
            {
              kind: "ask",
              text: "Use this sending address?",
              detail: "Example Company <team@example.test>",
              status: "pending",
              approvalEffectId: "exact-sender-approval",
              actions: [
                { id: "allow", label: "Use this address", outcome: "created" },
                { id: "deny", label: "Change the address", outcome: "cancelled" },
              ],
            },
          ],
        });
      }
      await route.fulfill({ json: { json: { ok: true } } });
    });
    await page.reload();
    await expect(
      page.getByText("What company name should recipients see?", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Use this address", exact: true })).toHaveCount(
      0,
    );
    await page.getByPlaceholder("Type your answer", { exact: true }).fill("Example Company");
    await captureScreenshot(page, info, `sender-company-${width}`);
    const firstAnswer = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/rpc/threads/answer",
    );
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await firstAnswer;
    await page.reload();
    await expect(page.getByText("Use this sending address?", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Example Company <team@example.test>", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Use this address", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Change the address", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Always allow|Create address/ })).toHaveCount(0);
    expect(answers.map((answer) => answer.answer)).toEqual(["Example Company"]);
    await captureScreenshot(page, info, `sender-address-${width}`);
    const secondAnswer = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/rpc/threads/answer",
    );
    await page.getByRole("button", { name: "Use this address", exact: true }).click();
    await secondAnswer;
    await page.reload();
    await expect(page.getByText("Address confirmed", { exact: true })).toBeVisible();
    await expect(page.getByText("Created", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use this address", exact: true })).toHaveCount(
      0,
    );
    expect(messages).toHaveLength(2);
    expect(answers.map((answer) => answer.answer)).toEqual(["Example Company", "allow"]);
    await captureScreenshot(page, info, `sender-confirmed-${width}`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
