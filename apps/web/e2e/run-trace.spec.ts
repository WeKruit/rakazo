import { expect, test } from "@playwright/test";
import { recruitingChatFixture } from "./fixtures/recruiting-chat";
import { captureScreenshot } from "./helpers";

test("developer diagnostics opens an on-demand per-run trace with measured and unknown timing", async ({
  page,
}, testInfo) => {
  let requests = 0;
  await page.route("**/rpc/runs/trace", async (route) => {
    requests++;
    expect(route.request().postDataJSON().json).toEqual({
      runId: "test-run",
      includeDiagnostics: true,
    });
    await route.fulfill({
      json: {
        json: {
          runId: "test-run",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:10.000Z",
          rows: [
            {
              id: "model",
              kind: "model",
              label: "test / test-model",
              startedAt: "2026-01-01T00:00:01.000Z",
              durationMs: null,
              status: "completed",
              tokens: 120,
              costUsd: 0.002,
            },
            {
              id: "tool",
              kind: "tool",
              label: "web_search",
              startedAt: "2026-01-01T00:00:02.000Z",
              durationMs: 3000,
              status: "failed",
              tokens: null,
              costUsd: null,
            },
            {
              id: "handoff",
              kind: "handoff",
              label: "coordinator → sourcing",
              startedAt: "2026-01-01T00:00:06.000Z",
              durationMs: null,
              status: "completed",
              tokens: null,
              costUsd: null,
            },
            {
              id: "retry",
              kind: "retry",
              label: "Retry",
              startedAt: "2026-01-01T00:00:07.000Z",
              durationMs: null,
              status: "unknown",
              tokens: null,
              costUsd: null,
            },
          ],
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/run-trace.html");
  await expect(page.getByTestId("run-trace")).toHaveCount(0);
  expect(requests).toBe(0);
  await page.goto("/e2e/fixtures/run-trace.html?developer=on");
  await expect(page.getByTestId("run-trace-timeline")).toHaveCount(0);
  expect(requests).toBe(0);
  await page.getByText("Run trace", { exact: true }).click();
  await expect(page.getByTestId("run-trace-timeline")).toBeVisible();
  await expect(page.getByLabel(/test \/ test-model · model/)).toHaveAttribute(
    "title",
    /120 tokens · \$0.0020/,
  );
  await expect(page.getByLabel(/web_search · tool/)).toHaveAttribute("title", /failed · 3s/);
  await captureScreenshot(page, testInfo, "developer-run-trace");
});

test("owner role route exposes one trace per run and recruiter route exposes none", async ({
  page,
}, testInfo) => {
  await recruitingChatFixture(page, { developer: true });
  await page.route("**/rpc/runs/trace", (route) =>
    route.fulfill({
      json: {
        json: {
          runId: "run-fixture",
          status: "completed",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:02Z",
          rows: [
            {
              id: "tool",
              kind: "tool",
              label: "read_file",
              startedAt: "2026-01-01T00:00:01Z",
              durationMs: 1000,
              status: "completed",
              tokens: null,
              costUsd: null,
            },
          ],
        },
      },
    }),
  );
  await page.goto("/app/g/group-fixture");
  await expect(page.getByTestId("run-trace")).toHaveCount(1);
  await page.getByTestId("run-trace").locator("summary").click();
  await expect(page.getByTestId("run-trace-timeline")).toContainText("read_file");
  await captureScreenshot(page, testInfo, "developer-trace-role-route");
  await page.evaluate(() => localStorage.setItem("rakazo.showToolActivity", "off"));
  await page.reload();
  await expect(page.getByTestId("run-trace")).toHaveCount(0);
});
