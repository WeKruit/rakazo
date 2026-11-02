import { expect, test } from "@playwright/test";
import type { MailReply, ThreadMessage } from "@rakazo/contracts";
import { appGroupId, checkedAt, mockRecruitingApp } from "./fixtures/recruiting-app-data";
import { captureScreenshot } from "./helpers";

for (const width of [1440, 390]) {
  test(`one editable mail card survives sending, discard and Inbox reload at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date(checkedAt));
    await mockRecruitingApp(page, { nativeScheduling: true });
    const bootResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/rpc/bootstrap",
    );
    const inboxResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/rpc/recruiting/globalInbox",
    );
    await page.goto("/app?view=inbox&role=all");
    const bootstrap = (await (await bootResponse).json()).json;
    const indexPage = (await (await inboxResponse).json()).json;
    const original = indexPage.items[0];
    const email = original.email;
    const botId = bootstrap.bots[0].id;
    const source: MailReply = {
      from: email.eaccount ?? "recruiter@example.test",
      to: [email.sender],
      cc: [],
      bcc: [],
      subject: `Re: ${email.subject}`,
      body: "Thanks for your reply. Would Thursday afternoon work?",
      inReplyTo: {
        sourceId: email.sourceId,
        emailId: email.providerMessageId,
        threadId: email.providerThreadId,
        subject: email.subject,
        sender: email.sender,
        inboxKey: original.key,
        roleId: original.roleId,
      },
      status: "needs_approval",
      sentAt: null,
      canAnswer: true,
    };
    const mailReads: Array<{ thread?: { roleId: string; key: string; emailId?: string } }> = [];
    let anchorOutsideFirstPage = false;
    await page.route("**/rpc/recruiting/globalInbox", (route) => {
      const input = route.request().postDataJSON().json;
      mailReads.push(input);
      if (anchorOutsideFirstPage && !input.thread)
        return route.fulfill({
          json: {
            json: {
              ...indexPage,
              total: 100,
              items: Array.from({ length: 50 }, (_, index) => {
                const key = JSON.parse(original.key);
                key[3] = `other-thread-${index}`;
                return {
                  ...original,
                  key: JSON.stringify(key),
                  email: {
                    ...email,
                    id: `other-${index}`,
                    providerMessageId: `other-${index}`,
                    providerThreadId: `other-thread-${index}`,
                    subject: "Other conversation",
                    body: "Not the original email.",
                  },
                };
              }),
            },
          },
        });
      return route.fallback();
    });
    const saved: ThreadMessage[] = [];
    const answers: unknown[] = [];
    let eventCursor = 0;
    const wake = new Set<() => void>();
    let latest: ThreadMessage;
    const run = () => ({
      id: latest.runId!,
      botId,
      threadId: bootstrap.thread.threadId,
      taskId: "synthetic-mail-task",
      status: latest.blocks.some((block) => block.kind === "ask" && block.status === "pending")
        ? "waiting_input"
        : "completed",
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
    const addDraft = (id: string) => {
      latest = {
        id,
        threadId: bootstrap.thread.threadId,
        seq: saved.length + 1,
        runId: `run-${id}`,
        botId,
        role: "bot",
        createdAt: checkedAt,
        blocks: [
          {
            kind: "ask",
            text: "Confirm reply",
            status: "pending",
            approvalEffectId: `approval-${id}`,
            mailReply: { ...source },
          },
        ],
      };
      saved.push(latest);
    };
    addDraft("first-mail-card");
    const snapshot = () => ({
      ...bootstrap.thread,
      cursor: eventCursor,
      messages: saved,
      run: run(),
      activeRuns: run().status === "waiting_input" ? [run()] : [],
    });
    await page.route("**/rpc/bootstrap", (route) =>
      route.fulfill({ json: { json: { ...bootstrap, thread: snapshot() } } }),
    );
    await page.route("**/rpc/threads/get", (route) =>
      route.fulfill({ json: { json: snapshot() } }),
    );
    await page.route("**/rpc/threads/head", (route) =>
      route.fulfill({
        json: { json: { threadId: bootstrap.thread.threadId, cursor: eventCursor } },
      }),
    );
    await page.route("**/rpc/threads/messages", (route) => {
      const input = route.request().postDataJSON().json;
      const messages = saved.filter(
        (message) =>
          !input.mailReplyFor ||
          message.blocks.some(
            (block) =>
              block.kind === "ask" &&
              block.mailReply?.inReplyTo.sourceId === input.mailReplyFor.sourceId,
          ),
      );
      return route.fulfill({
        json: { json: { threadId: bootstrap.thread.threadId, messages, olderCursor: null } },
      });
    });
    await page.route("**/rpc/threads/subscribe", async (route) => {
      await new Promise<void>((resolve) => {
        wake.add(resolve);
        page.once("close", resolve);
      });
      if (page.isClosed()) return;
      const event = {
        id: `mail-event-${eventCursor}`,
        seq: eventCursor,
        spaceId: "fixture-space",
        threadId: bootstrap.thread.threadId,
        botId,
        runId: latest.runId,
        type: "thread.message.updated",
        createdAt: checkedAt,
        payload: { messageId: latest.id, role: "bot", blocks: latest.blocks },
      };
      await route
        .fulfill({
          contentType: "text/event-stream",
          body: `event: message\ndata: ${JSON.stringify({ json: event })}\n\nevent: done\ndata: {}\n\n`,
        })
        .catch(() => {});
    });
    await page.route("**/rpc/threads/answer", async (route) => {
      const input = route.request().postDataJSON().json;
      answers.push(input);
      const message = saved.find((message) => message.id === input.messageId)!;
      const block = message.blocks.find((block) => block.kind === "ask")!;
      if (block.kind !== "ask" || !block.mailReply)
        throw new Error("Expected the original mail card");
      block.status = "answered";
      block.answer = input.answer === "deny" ? "deny" : "allow";
      block.mailReply =
        input.answer === "deny"
          ? { ...block.mailReply, status: "discarded", canAnswer: false }
          : {
              ...block.mailReply,
              body: input.answer.body,
              cc: input.answer.cc,
              status: "sent",
              sentAt: checkedAt,
              canAnswer: false,
            };
      eventCursor += 1;
      for (const resolve of wake) resolve();
      wake.clear();
      await route.fulfill({ json: { json: { ok: true } } });
    });

    await page.goto(`/app/g/${appGroupId}?view=conversation`);
    const card = page.getByTestId("mail-reply-card").first();
    await expect(card).toHaveAttribute("data-status", "needs_approval");
    await expect(card.getByText(source.from!, { exact: true }).first()).toBeVisible();
    await captureScreenshot(page, info, `mail-pending-${width}`);
    await card
      .getByRole("textbox", { name: "Reply body", exact: true })
      .fill("Edited before sending. Thursday at 2 pm works for us.");
    await card.getByRole("button", { name: "Add Cc", exact: true }).click();
    await card.getByRole("textbox", { name: "Cc", exact: true }).fill("coordinator@example.test");
    expect(answers).toHaveLength(0);
    await captureScreenshot(page, info, `mail-editing-${width}`);
    await card.getByRole("button", { name: "Send", exact: true }).click();
    await expect(card).toHaveAttribute("data-status", "sent");
    expect((answers[0] as { answer: unknown }).answer).toEqual({
      action: "send",
      body: "Edited before sending. Thursday at 2 pm works for us.",
      cc: ["coordinator@example.test"],
    });
    await captureScreenshot(page, info, `mail-sent-${width}`);
    await page.reload();
    await expect(card).toHaveAttribute("data-status", "sent");
    await card.getByRole("button", { expanded: false }).click();
    await expect(
      card.getByText("Edited before sending. Thursday at 2 pm works for us.", { exact: true }),
    ).toBeVisible();
    await expect(card.getByText("coordinator@example.test", { exact: true })).toBeVisible();

    anchorOutsideFirstPage = true;
    await card.getByRole("link").click();
    await expect(page).toHaveURL(
      new RegExp(
        `role=${original.roleId}.*mailMessage=${encodeURIComponent(email.providerMessageId)}`,
      ),
    );
    await expect
      .poll(() =>
        mailReads.some(
          (input) =>
            input.thread?.roleId === original.roleId &&
            input.thread.key === original.key &&
            input.thread.emailId === email.providerMessageId,
        ),
      )
      .toBe(true);
    await expect(
      page.getByTestId("email-conversation").getByText(email.body, { exact: true }),
    ).toBeVisible();
    anchorOutsideFirstPage = false;
    addDraft("second-mail-card");
    await page.goto(`/app/g/${appGroupId}?view=conversation`);
    await page.reload();
    const second = page.getByTestId("mail-reply-card").nth(1);
    await expect(second).toHaveAttribute("data-status", "needs_approval");
    await second.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(second).toHaveAttribute("data-status", "discarded");
    expect((answers[1] as { answer: unknown }).answer).toBe("deny");
    await captureScreenshot(page, info, `mail-discarded-${width}`);
    await page.goto("/app?view=inbox&role=all");
    if (width < 768)
      await page
        .getByRole("list", { name: "Email threads", exact: true })
        .getByRole("button")
        .first()
        .click();
    const inbox = page.getByRole("region", { name: "Reply drafts", exact: true });
    await expect(inbox.getByTestId("mail-reply-card")).toHaveCount(2);
    await expect(inbox.getByTestId("mail-reply-card").first()).toHaveAttribute(
      "data-status",
      "sent",
    );
    await expect(inbox.getByTestId("mail-reply-card").nth(1)).toHaveAttribute(
      "data-status",
      "discarded",
    );
    await captureScreenshot(page, info, `mail-inbox-history-${width}`);
    expect(answers).toHaveLength(2);
  });
}
