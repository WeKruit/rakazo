import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { appGroupId, mockRecruitingApp } from "./fixtures/recruiting-app-data";

test("measures role RPC duplication while retaining live binding validation", async ({
  page,
}, testInfo) => {
  const fixture = await mockRecruitingApp(page);
  const scripts: Promise<{ raw: number; gzip: number }>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".js"))
      scripts.push(
        response.body().then((body) => ({ raw: body.length, gzip: gzipSync(body).length })),
      );
  });
  await page.goto(`/app/g/${appGroupId}?view=contacts`);
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  await expect(page.getByText("Avery Example", { exact: true }).first()).toBeVisible();
  // Allow the concurrently mounted Shell, navigation and role tabs to finish their initial reads.
  await page.waitForTimeout(500);
  const reads = fixture.calls.filter((call) => call.method.startsWith("recruiting/"));
  const counts = new Map<string, number>();
  for (const call of reads) {
    const key = JSON.stringify(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates = [...counts].filter(([, count]) => count > 1);
  const assets = await Promise.all(scripts);
  const duplicateRequests = duplicates.reduce((sum, [, count]) => sum + count - 1, 0);
  const result = {
    duplicateRequests,
    rpcRequests: fixture.calls.length,
    recruitingRequests: reads.length,
    duplicates,
    jsBytes: assets.reduce((sum, n) => sum + n.raw, 0),
    jsGzipBytes: assets.reduce((sum, n) => sum + n.gzip, 0),
    jsRequests: scripts.length,
    reads,
  };
  console.log(JSON.stringify(result));
  await testInfo.attach("role-read-measurement", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(fixture.unknown).toEqual([]);
  if (process.env.RECRUITING_QUERY_REQUIRE_ZERO) expect(duplicateRequests).toBe(0);
  else if (!process.env.RECRUITING_QUERY_BASELINE) {
    // These remaining requests independently validate workspace and candidate snapshots before
    // rendering actions. An atomic server snapshot is needed to remove them safely.
    expect(duplicates).toEqual([
      [
        JSON.stringify({
          method: "recruiting/getWorkspace",
          input: { threadId: "fixture-thread" },
        }),
        4,
      ],
    ]);
    expect(reads).toHaveLength(11);
  }
});
