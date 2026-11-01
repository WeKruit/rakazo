import { expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({ IsolationError: class IsolationError extends Error {} }));
vi.mock("./recruiting-research.js", () => ({
  bestLookedUpEmail: vi.fn(),
  lookedUpContactEmails: vi.fn(),
}));

import { runInstantlyWrite } from "./instantly-native-writes.js";

it.each([1, 2, 3])("draft update never patches or activates status %s", async (status) => {
  const rest = vi.fn(async (_method: string) => ({
    id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
    status,
  }));
  const prisma = {
    recruitingRole: {
      findFirst: vi.fn(async (_method: string) => ({ id: "role", title: "Engineer" })),
    },
    externalEffect: {
      findUnique: vi.fn(async () => ({
        spaceId: "s",
        result: { campaignId: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69" },
      })),
    },
  };
  await expect(
    runInstantlyWrite(
      prisma as never,
      rest,
      { spaceId: "s", userId: "u" } as never,
      "server",
      "native_instantly_update_role_draft",
      {
        role_id: "role",
        campaign_id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
        name: "Engineer",
        eaccount: "team@example.test",
        steps: [{ subject: "Hi", body: "Hello", delay_days: 0 }],
      },
    ),
  ).rejects.toThrow("Only a draft");
  expect(rest.mock.calls.every(([method]) => method === "GET")).toBe(true);
});

it("refuses an unrelated campaign before any provider call", async () => {
  const rest = vi.fn();
  const prisma = {
    recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
    externalEffect: {
      findUnique: vi.fn(async () => ({ spaceId: "s", result: { campaignId: "other" } })),
    },
  };
  await expect(
    runInstantlyWrite(
      prisma as never,
      rest,
      { spaceId: "s", userId: "u" } as never,
      "server",
      "native_instantly_update_role_draft",
      {
        role_id: "role",
        campaign_id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
        name: "Engineer",
        eaccount: "team@example.test",
      },
    ),
  ).rejects.toThrow();
  expect(rest).not.toHaveBeenCalled();
});

it("saves and reopens all draft steps with zero recipients and never dispatches sends", async () => {
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  let campaign: Record<string, unknown> = {
    id,
    status: 0,
    sequences: [],
    email_list: ["team@example.test"],
    campaign_schedule: {
      schedules: [
        {
          name: "Weekdays",
          timezone: "America/Chicago",
          timing: { from: "09:00", to: "17:00" },
          days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
        },
      ],
    },
  };
  const rest = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (path.startsWith("/accounts/")) return { email: "team@example.test" };
    if (path === "/accounts?limit=100") return { items: [{ email: "team@example.test" }] };
    if (path === `/campaigns/${id}` && method === "GET") return campaign;
    if (path === `/campaigns/${id}` && method === "PATCH") {
      campaign = { ...campaign, ...(body as object) };
      return campaign;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const prisma = {
    recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
    externalEffect: {
      findUnique: vi.fn(async () => ({ spaceId: "s", result: { campaignId: id } })),
    },
  };
  const result = await runInstantlyWrite(
    prisma as never,
    rest,
    { spaceId: "s", userId: "u" } as never,
    "server",
    "native_instantly_update_role_draft",
    {
      role_id: "role",
      campaign_id: id,
      name: "Engineer",
      eaccount: "team@example.test",
      timezone: "America/Chicago",
      send_hours: "weekdays_9_to_5",
      steps: [
        { subject: "Hi {{first_name}}", body: "Hello", delay_days: 0 },
        { subject: "Following up", body: "Any thoughts?", delay_days: 3 },
      ],
    },
  );
  expect(result).toMatchObject({
    campaign: {
      id,
      editable: true,
      eaccount: "team@example.test",
      steps: [
        { subject: "Hi {{first_name}}", body: "Hello", delay_days: 0 },
        { subject: "Following up", body: "Any thoughts?", delay_days: 3 },
      ],
    },
  });
  expect(rest.mock.calls.every(([method]) => method === "GET" || method === "PATCH")).toBe(true);
});

it.each([
  '<p>Hello<img src="https://example.test/image.png" /></p>',
  "<p><strong>Hello</strong></p>",
  '<p><a href="https://example.test">Hello</a></p>',
])("refuses lossy editing of rich provider body %s", async (body) => {
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  const campaign = {
    id,
    status: 0,
    email_list: ["team@example.test"],
    campaign_schedule: {
      schedules: [
        {
          name: "Weekdays",
          timezone: "America/Chicago",
          timing: { from: "09:00", to: "17:00" },
          days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
        },
      ],
    },
    sequences: [
      {
        steps: [
          { type: "email", delay: 0, delay_unit: "days", variants: [{ subject: "Hi", body }] },
        ],
      },
    ],
  };
  const rest = vi.fn(async (_method: string, path: string) =>
    path === "/accounts?limit=100" ? { items: [{ email: "team@example.test" }] } : campaign,
  );
  const prisma = {
    recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
    externalEffect: {
      findUnique: vi.fn(async () => ({ spaceId: "s", result: { campaignId: id } })),
    },
  };
  const context = { spaceId: "s", userId: "u" } as never;
  const read = await runInstantlyWrite(
    prisma as never,
    rest,
    context,
    "server",
    "native_instantly_get_role_draft",
    { role_id: "role" },
  );
  expect(read).toMatchObject({ campaign: { editable: false, steps: [] } });
  await expect(
    runInstantlyWrite(
      prisma as never,
      rest,
      context,
      "server",
      "native_instantly_update_role_draft",
      {
        role_id: "role",
        campaign_id: id,
        name: "Engineer",
        eaccount: "team@example.test",
        steps: [{ subject: "Hi", body: "Hello", delay_days: 0 }],
      },
    ),
  ).rejects.toThrow("existing mail workspace");
  expect(rest.mock.calls.every(([method]) => method === "GET")).toBe(true);
});
