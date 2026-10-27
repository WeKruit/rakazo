import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import {
  appGroupId,
  appRoleId,
  checkedAt,
  mockRecruitingApp,
} from "./fixtures/recruiting-app-data";

test("measures real browser contact-page requests for 1000 synthetic contacts", async ({
  page,
}) => {
  const before = process.env.A3_BASELINE === "1";
  const fixture = await mockRecruitingApp(page);
  const contacts = Array.from({ length: 1000 }, (_, index) => ({
    candidateKey: `linkedin:/in/synthetic-${index}`,
    linkedinUrl: `https://linkedin.com/in/synthetic-${index}`,
    emails: [{ address: `synthetic-${index}@example.test`, status: "HIGH_PROBABILITY" }],
    phones: [],
    source: "FullEnrich",
    checkedAt,
  }));
  const lengths: number[] = [];
  const cursors: string[] = [];
  const js: Promise<{ raw: number; gzip: number }>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".js"))
      js.push(response.body().then((body) => ({ raw: body.length, gzip: gzipSync(body).length })));
  });
  await page.route("**/rpc/recruiting/correspondence", async (route) => {
    const input = route.request().postDataJSON().json;
    if (input.view !== "contacts") return route.fallback();
    const offset = Number(input.cursor ?? 0);
    const rows = before ? contacts : contacts.slice(offset, offset + 200);
    lengths.push(rows.length);
    cursors.push(String(offset));
    await route.fulfill({
      json: {
        json: {
          roleId: appRoleId,
          status: "ready",
          checkedAt,
          connectionChanged: false,
          connections: [{ name: "FullEnrich", status: "configured", checkIssue: null }],
          emails: [],
          events: [],
          contacts: rows,
          partial: !before && offset + 200 < contacts.length,
          nextCursor: !before && offset + 200 < contacts.length ? String(offset + 200) : null,
        },
      },
    });
  });
  await page.goto(`/app/g/${appGroupId}?view=contacts`);
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  if (!before)
    await expect(
      page.getByRole("button", { name: "Avery Example", exact: true }).first(),
    ).toBeVisible();
  await expect.poll(() => lengths.reduce((total, value) => total + value, 0)).toBe(1000);
  await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => undefined);
  const sizes = await Promise.all(js);
  expect(fixture.unknown).toEqual([]);
  console.log(
    JSON.stringify({
      benchmark: "A3-browser-contacts",
      before,
      contactRequests: lengths.length,
      rowsPerResponse: lengths,
      cursors,
      totalRpcRequests: fixture.calls.length + lengths.length,
      jsRequests: sizes.length,
      jsRawBytes: sizes.reduce((sum, item) => sum + item.raw, 0),
      jsGzipBytes: sizes.reduce((sum, item) => sum + item.gzip, 0),
    }),
  );
});
