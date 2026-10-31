import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { assertCardDeadlines } from "./card-deadlines.mjs";
import { assertTestCopy } from "./workloop-task-controls.mjs";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));

/** Uses the installed web test browser and the harness's actual sign-in session. */
export async function routeTestToken(context, origin, token) {
  const trustedOrigin = new URL(origin).origin;
  await context.route(
    (url) => url.origin === trustedOrigin && /^\/(?:rpc\/|api\/auth\/)/.test(url.pathname),
    async (route) => {
      // Fetch without following redirects: request-header overrides otherwise propagate to them.
      const response = await route.fetch({
        maxRedirects: 0,
        headers: { ...route.request().headers(), authorization: `Bearer ${token}` },
      });
      await route.fulfill({ response });
    },
  );
}

export async function withConversationPage({ rpc, origin, cookie, token, groupId }, check) {
  await assertTestCopy(rpc, groupId);
  const { chromium } = requireWeb("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookie) {
      await context.addCookies(
        cookie.split("; ").map((part) => {
          const split = part.indexOf("=");
          return {
            name: part.slice(0, split),
            value: part.slice(split + 1),
            url: origin,
            httpOnly: true,
            secure: origin.startsWith("https:"),
          };
        }),
      );
    } else if (token) {
      await routeTestToken(context, origin, token);
    }
    const page = await context.newPage();
    await page.goto(`${origin}/app/g/${encodeURIComponent(groupId)}?view=conversation`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("combobox", { name: /^Message/ })
      .waitFor({ state: "visible", timeout: 30_000 });
    return await check(page);
  } finally {
    await browser.close();
  }
}

/** A real composer send must echo and acknowledge within the one-second UX deadline. */
export async function sendWithImmediateFeedback(page, text, { queueMode = "steer" } = {}) {
  const { expect } = requireWeb("@playwright/test");
  const before = await page.getByText(text, { exact: true }).count();
  await page.getByRole("combobox", { name: /^Message/ }).fill(text);
  if (queueMode === "follow_up") {
    await page.getByRole("combobox", { name: /^Message/ }).press("Tab");
    await expect(page.getByRole("button", { name: "Follow up", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  const sent = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).origin === new URL(page.url()).origin &&
      new URL(response.url()).pathname === "/rpc/threads/send" &&
      request.method() === "POST" &&
      request.postDataJSON()?.json?.text === text
    );
  });
  const startedAt = Date.now();
  await page.getByRole("combobox", { name: /^Message/ }).press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: /Thinking…|Queued/ })
    .first()
    .waitFor({ state: "visible", timeout: 1_000 });
  await expect(page.getByText(text, { exact: true })).toHaveCount(before + 1, { timeout: 1_000 });
  const feedbackMs = Date.now() - startedAt;
  assert.ok(feedbackMs < 1_000, "sent message feedback exceeded one second");
  const response = await sent;
  assert.ok(response.ok(), "composer send was not accepted");
  const receipt = (await response.json()).json;
  assert.ok(Number.isSafeInteger(receipt?.seq), "composer send returned no message sequence");
  return { startedAt, feedbackMs, receipt };
}

export async function checkRenderedCardDeadlines(rpc, page, groupId) {
  await page.getByTestId("ask-deadline").first().waitFor({ state: "visible", timeout: 10_000 });
  const snapshot = await rpc("threads/get", { groupId });
  const deadlines = await page
    .getByTestId("ask-deadline")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
  assertCardDeadlines(snapshot, deadlines);
}

/** A reload exercises persisted deadlines, rather than a timer computed from page-open time. */
export async function checkCardsAfterReconnect(rpc, page, groupId) {
  await checkRenderedCardDeadlines(rpc, page, groupId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await checkRenderedCardDeadlines(rpc, page, groupId);
}

export function assertRecoveryRetryIntent(intent, groupId) {
  assert.ok(intent?.groupId === groupId, "retry left the native test-copy conversation");
  assert.equal(intent.text, "Try again", "retry must carry only the retry instruction");
  assert.equal(intent.queueMode, "steer", "retry must immediately start the failed turn again");
  for (const key of [
    "artifactIds",
    "replyToMessageId",
    "replyQuote",
    "correspondenceReference",
    "recruitingContext",
  ])
    assert.ok(intent[key] === undefined, "retry included the recruiter's unrelated draft context");
}

/** Controlled response fault injection: verifies production UI intent, not a provider outage.
 * The real test-copy snapshot is read, failed state exists only in this browser response,
 * and every retry send/upload is intercepted before it can reach the backend. */
export async function checkFailureRecoveryUi(page, { rpc, groupId, onCheckpoint }) {
  await assertTestCopy(rpc, groupId);
  const { expect } = requireWeb("@playwright/test");
  const snapshot = await rpc("threads/get", { groupId });
  assert.equal(snapshot.groupId, groupId, "failure recovery must use the selected test copy");
  const main = snapshot.members?.find((member) => member.name === "Main");
  assert.ok(main, "the native test-copy crew needs its coordinator");
  const bootstrap = await rpc("bootstrap", { groupId });
  const origin = new URL(page.url()).origin;
  const retryRequests = [];
  const unexpectedWrites = [];
  let reason = "Controlled transient failure";
  const seed = randomUUID();
  let injection = 0;
  let originalDraft;
  const matcher = (url) =>
    url.origin === origin &&
    /^\/rpc\/(?:bootstrap|threads\/(?:get|send|followUp)|artifacts\/create)$/.test(url.pathname);
  const handler = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const input = route.request().postDataJSON()?.json ?? {};
    if (path === "/rpc/threads/get" || path === "/rpc/bootstrap") {
      if (input.groupId !== groupId) return route.fallback();
      const at = new Date().toISOString();
      const failed = {
        ...snapshot,
        activeRuns: [],
        run: {
          id: `controlled-recovery-${seed}-${injection}`,
          botId: main.botId,
          threadId: snapshot.threadId,
          taskId: `controlled-task-${seed}-${injection}`,
          trigger: "user",
          status: "failed",
          routineId: null,
          modelProvider: null,
          modelId: null,
          error: reason,
          createdAt: at,
          updatedAt: at,
          startedAt: at,
          completedAt: at,
        },
      };
      return route.fulfill({
        status: 200,
        json: {
          json: path === "/rpc/bootstrap" ? { ...bootstrap, thread: failed } : failed,
        },
      });
    }
    if (path === "/rpc/threads/send") {
      retryRequests.push(input);
      return route.fulfill({
        status: 200,
        json: {
          json: {
            taskId: `controlled-retry-task-${seed}`,
            runId: `controlled-retry-run-${seed}`,
            seq: snapshot.cursor + 1,
          },
        },
      });
    }
    unexpectedWrites.push(path);
    return route.fulfill({
      status: 409,
      json: { json: { message: "Controlled recovery check blocked a write" } },
    });
  };
  await page.route(matcher, handler);
  try {
    injection += 1;
    await page.reload({ waitUntil: "domcontentloaded" });
    const error = page.getByTestId("composer-error");
    await expect(error).toContainText("The reply stopped. Try again.");
    await onCheckpoint?.("controlled-retry-error");
    const composer = page.getByRole("combobox", { name: /^Message/ });
    originalDraft = await composer.inputValue();
    const draft = "Unsent recovery-check draft";
    await composer.fill(draft);
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "recovery-draft.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Unsent fixture attachment"),
      });
    await expect(page.getByText("recovery-draft.txt", { exact: true })).toBeVisible();
    const retry = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/rpc/threads/send",
    );
    await error.getByRole("button", { name: "Try again", exact: true }).click();
    await retry;
    await expect.poll(() => retryRequests.length).toBe(1);
    assertRecoveryRetryIntent(retryRequests[0], groupId);
    await expect(composer).toHaveValue(draft);
    await expect(page.getByText("recovery-draft.txt", { exact: true })).toBeVisible();
    assert.equal(
      unexpectedWrites.length,
      0,
      "retry uploaded a draft attachment or used another send path",
    );

    reason = "Model connection is no longer available. Connect it again.";
    injection += 1;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(error).toContainText("Reconnect your model to continue.");
    await error.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
    await expect(page.getByTestId("model-settings")).toBeVisible();
    await onCheckpoint?.("controlled-reconnect-model-settings");
    assert.equal(
      retryRequests.length,
      1,
      "Reconnect resent work instead of opening model settings",
    );
    assert.equal(unexpectedWrites.length, 0, "recovery changed backend data");
    return { controlledFaultInjection: true, retryIntentCount: 1, reconnectOpenedModels: true };
  } finally {
    try {
      const close = page.getByRole("button", { name: "Close model settings", exact: true });
      if (await close.isVisible()) await close.click();
      const remove = page.getByRole("button", { name: "Remove recovery-draft.txt", exact: true });
      if (await remove.isVisible()) await remove.click();
      const composer = page.getByRole("combobox", { name: /^Message/ });
      if (originalDraft !== undefined && (await composer.isVisible()))
        await composer.fill(originalDraft);
    } finally {
      await page.unroute(matcher, handler);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
}

/** Opens the actual handed-off stage; the same renderer must expose its persisted history. */
export async function checkStageTranscript(page) {
  const { expect } = requireWeb("@playwright/test");
  const stages = page.getByTestId("work-stage");
  if ((await stages.count()) === 0) {
    const summary = page
      .locator("summary")
      .filter({ hasText: /Worked for/ })
      .first();
    await summary.click();
  }
  const stage = stages
    .filter({ has: page.getByRole("button", { name: "View", exact: true }) })
    .first();
  await expect(stage).toBeVisible();
  await stage.getByRole("button", { name: "View", exact: true }).click();
  const transcript = page.getByTestId("stage-transcript");
  await expect(transcript).toBeVisible();
  await expect(transcript.getByRole("status")).toHaveCount(0, { timeout: 30_000 });
  await expect(transcript).not.toContainText("Could not load this task.");
  await expect(transcript).not.toContainText("No messages yet.");
  await expect(transcript.getByTestId("message-bot-bubble").first()).toBeVisible();
  assert.ok(
    (await transcript.getByTestId("message-bot-bubble").allTextContents()).some((text) =>
      text.trim(),
    ),
    "task transcript contained no persisted teammate reply",
  );
  await transcript.getByRole("button", { name: "Close", exact: true }).click();
}
