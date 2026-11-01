import { expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({ IsolationError: class IsolationError extends Error {} }));
vi.mock("./recruiting-research.js", () => ({
  bestLookedUpEmail: vi.fn(),
  lookedUpContactEmails: vi.fn(),
}));

import { runInstantlyWrite, sequenceConfigurationRevision } from "./instantly-native-writes.js";

it.each([1, 2, 3])("draft update never patches or activates status %s", async (status) => {
  const rest = vi.fn(async (_method: string) => ({
    id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
    status,
  }));
  const prisma = {
    recruitingRole: {
      findFirst: vi.fn(async (_method: string) => ({ id: "role", title: "Engineer" })),
    },
    externalEffect: draftEffects(
      new Map([
        [
          "instantly-role-campaign:server:role",
          {
            spaceId: "s",
            status: "completed",
            result: { campaignId: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69" },
          },
        ],
      ]),
    ),
  };
  await expect(
    runInstantlyWrite(
      prisma as never,
      rest,
      { spaceId: "s", userId: "u", runId: "run" } as never,
      "server",
      "native_instantly_update_role_draft",
      {
        role_id: "role",
        campaign_id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
        expected_revision: "0".repeat(64),
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
    externalEffect: draftEffects(
      new Map([
        [
          "instantly-role-campaign:server:role",
          { spaceId: "s", status: "completed", result: { campaignId: "other" } },
        ],
      ]),
    ),
  };
  await expect(
    runInstantlyWrite(
      prisma as never,
      rest,
      { spaceId: "s", userId: "u", runId: "run" } as never,
      "server",
      "native_instantly_update_role_draft",
      {
        role_id: "role",
        campaign_id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
        expected_revision: "0".repeat(64),
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
    externalEffect: draftEffects(
      new Map([
        [
          "instantly-role-campaign:server:role",
          { spaceId: "s", status: "completed", result: { campaignId: id } },
        ],
      ]),
    ),
  };
  const result = await runInstantlyWrite(
    prisma as never,
    rest,
    { spaceId: "s", userId: "u", runId: "run" } as never,
    "server",
    "native_instantly_update_role_draft",
    {
      role_id: "role",
      campaign_id: id,
      expected_revision: sequenceConfigurationRevision(campaign),
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
    externalEffect: draftEffects(
      new Map([
        [
          "instantly-role-campaign:server:role",
          { spaceId: "s", status: "completed", result: { campaignId: id } },
        ],
      ]),
    ),
  };
  const context = { spaceId: "s", userId: "u", runId: "run" } as never;
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
        expected_revision: sequenceConfigurationRevision(campaign),
        name: "Engineer",
        eaccount: "team@example.test",
        steps: [{ subject: "Hi", body: "Hello", delay_days: 0 }],
      },
    ),
  ).rejects.toThrow("existing mail workspace");
  expect(rest.mock.calls.every(([method]) => method === "GET")).toBe(true);
});

it.each([false, true])(
  "clones exact content with a durable secondary receipt, including revocation after creation: %s",
  async (revokeAfterCreate) => {
    const sourceId = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
    const cloneId = "8b1b9f7f-5d3b-4e6a-8e5f-3e2f4d5c6b70";
    const primaryKey = "instantly-role-campaign:server:role";
    const source = {
      id: sourceId,
      name: "Original",
      status: 1,
      email_list: ["team@example.test"],
      campaign_schedule: {
        schedules: [
          {
            name: "Morning",
            timezone: "Asia/Tokyo",
            timing: { from: "09:00", to: "17:00" },
            days: { "1": true },
          },
        ],
      },
      sequences: [
        {
          steps: [
            {
              type: "email",
              delay: 0,
              delay_unit: "days",
              variants: [
                {
                  subject: "Original",
                  body: '<p>Hello <strong>{{first_name}}</strong><img src="https://example.test/image.png" alt="Original image" /></p>',
                },
              ],
            },
          ],
        },
      ],
    };
    const effects = new Map<string, Record<string, unknown>>([
      [
        primaryKey,
        {
          spaceId: "s",
          status: "completed",
          result: {
            campaignId: sourceId,
            campaignName: "Original",
            eaccount: "team@example.test",
            leads: {},
          },
        },
      ],
    ]);
    let copied: Record<string, unknown> | undefined;
    const rest = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "GET" && path === `/campaigns/${sourceId}`) return source;
      if (method === "POST" && path === "/campaigns") {
        copied = { ...body, id: cloneId, status: 0 };
        return copied;
      }
      if (method === "GET" && path === `/campaigns/${cloneId}`) return copied;
      if (method === "POST" && path === "/leads/list") return { items: [] };
      if (path === "/accounts?limit=100") return { items: [{ email: "team@example.test" }] };
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const prisma = {
      recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
      externalEffect: draftEffects(effects),
      $transaction: async (
        fn: (tx: { externalEffect: ReturnType<typeof draftEffects> }) => Promise<unknown>,
      ) => fn({ externalEffect: draftEffects(effects) }),
    };
    const submit = () =>
      runInstantlyWrite(
        prisma as never,
        rest as never,
        {
          spaceId: "s",
          userId: "u",
          runId: "run",
          reauthorize: async () => {
            if (revokeAfterCreate && copied) throw new Error("Access revoked");
          },
        } as never,
        "server",
        "native_instantly_clone_role_draft",
        {
          role_id: "role",
          campaign_id: sourceId,
          name: "Copy for review",
          client_nonce: "copy-request",
        },
      );
    const request = submit();
    if (revokeAfterCreate) await expect(request).rejects.toThrow("Access revoked");
    else
      expect(await request).toMatchObject({
        campaign: { id: cloneId, name: "Copy for review", status: 0, editable: false },
      });
    revokeAfterCreate = false;
    await submit();
    expect(
      rest.mock.calls.filter(([method, path]) => method === "POST" && path === "/campaigns"),
    ).toHaveLength(1);
    expect(copied?.sequences).toEqual(source.sequences);
    expect(copied?.campaign_schedule).toEqual(source.campaign_schedule);
    expect(effects.get(primaryKey)?.result).toMatchObject({ campaignId: sourceId });
    expect(effects.get(`${primaryKey}:campaign:${cloneId}`)?.result).toMatchObject({
      campaignId: cloneId,
      campaignName: "Copy for review",
      leads: {},
    });
    expect(
      rest.mock.calls.some(([, path]) => path.includes("activate") || path.includes("leads/add")),
    ).toBe(false);
  },
);

function draftEffects(entries = new Map<string, Record<string, unknown>>()) {
  return {
    findUnique: vi.fn(
      async ({ where }: { where: { idempotencyKey: string } }) =>
        entries.get(where.idempotencyKey) ?? null,
    ),
    findMany: vi.fn(async () => [...entries.values()]),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const key = String(data.idempotencyKey);
      if (entries.has(key)) throw Object.assign(new Error("Unique key"), { code: "P2002" });
      entries.set(key, data);
      return data;
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const key = String(where.idempotencyKey);
        const value = entries.get(key);
        if (!value || Object.entries(where).some(([name, expected]) => value[name] !== expected))
          return { count: 0 };
        entries.set(key, { ...value, ...data });
        return { count: 1 };
      },
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { idempotencyKey: string };
        create: Record<string, unknown>;
      }) => {
        const previous = entries.get(where.idempotencyKey);
        if (previous) return previous;
        entries.set(where.idempotencyKey, create);
        return create;
      },
    ),
  };
}

it("returns a configuration revision and rejects a second client's stale save without overwriting newer copy", async () => {
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  let campaign: Record<string, unknown> = {
    id,
    name: "Original",
    status: 0,
    email_list: ["team@example.test"],
    sequences: [],
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
  const effects = draftEffects(
    new Map([
      [
        "instantly-role-campaign:server:role",
        { spaceId: "s", status: "completed", result: { campaignId: id, campaignName: "Original" } },
      ],
    ]),
  );
  const prisma = {
    recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
    externalEffect: effects,
  };
  const rest = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (path === "/accounts?limit=100") return { items: [{ email: "team@example.test" }] };
    if (path.startsWith("/accounts/")) return { email: "team@example.test" };
    if (method === "PATCH") {
      campaign = { ...campaign, ...(body as object) };
      return campaign;
    }
    return campaign;
  });
  const context = { spaceId: "s", userId: "u", runId: "run" } as never;
  const read = (await runInstantlyWrite(
    prisma as never,
    rest,
    context,
    "server",
    "native_instantly_get_role_draft",
    { role_id: "role" },
  )) as { campaign: { revision: string } };
  expect(read.campaign.revision).toMatch(/^[a-f0-9]{64}$/);
  const edit = {
    role_id: "role",
    campaign_id: id,
    expected_revision: read.campaign.revision,
    name: "First client",
    eaccount: "team@example.test",
    steps: [{ subject: "Hi", body: "First client's saved text", delay_days: 0 }],
  };
  const saved = await runInstantlyWrite(
    prisma as never,
    rest,
    context,
    "server",
    "native_instantly_update_role_draft",
    edit,
  );
  expect(saved).toMatchObject({ unconfirmedDrafts: 0 });
  await effects.create({
    data: {
      idempotencyKey:
        "instantly-sequence-draft:server:role:save:another-campaign:unconfirmed-revision",
      kind: "instantly_sequence_draft",
      status: "unknown",
    },
  });
  await expect(
    runInstantlyWrite(
      prisma as never,
      rest,
      context,
      "server",
      "native_instantly_update_role_draft",
      { ...edit, name: "Stale second client" },
    ),
  ).rejects.toThrow();
  expect(campaign.name).toBe("First client");
  expect(rest.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
  // Retrying the successful original request reads the same sequence; it does not PATCH again.
  const retried = await runInstantlyWrite(
    prisma as never,
    rest,
    context,
    "server",
    "native_instantly_update_role_draft",
    edit,
  );
  expect(retried).toMatchObject({ unconfirmedDrafts: 1 });
  expect(rest.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
});

it.each(["create", "clone"] as const)(
  "does not repeat an uncertain %s POST with the same operation nonce",
  async (operation) => {
    const sourceId = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
    const entries = new Map<string, Record<string, unknown>>([
      [
        "instantly-role-campaign:server:role",
        { spaceId: "s", status: "completed", result: { campaignId: sourceId } },
      ],
    ]);
    const prisma = {
      recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
      externalEffect: draftEffects(entries),
    };
    const rest = vi.fn(async (method: string, path: string) => {
      if (method === "POST" && path === "/campaigns")
        throw new TypeError("Connection lost after dispatch");
      if (path.startsWith("/accounts/")) return { email: "team@example.test" };
      return {
        id: sourceId,
        name: "Original",
        status: 0,
        sequences: [],
        campaign_schedule: { schedules: [] },
        email_list: ["team@example.test"],
      };
    });
    const input =
      operation === "clone"
        ? { role_id: "role", campaign_id: sourceId, name: "Copy", client_nonce: "uncertain-intent" }
        : {
            role_id: "role",
            name: "New",
            eaccount: "team@example.test",
            client_nonce: "uncertain-intent",
          };
    const call = () =>
      runInstantlyWrite(
        prisma as never,
        rest,
        { spaceId: "s", userId: "u", runId: "run" } as never,
        "server",
        `native_instantly_${operation}_role_draft`,
        input,
      );
    await expect(call()).rejects.toThrow("Connection lost");
    await expect(call()).rejects.toThrow("unconfirmed");
    expect(
      rest.mock.calls.filter(([method, path]) => method === "POST" && path === "/campaigns"),
    ).toHaveLength(1);
    expect(
      entries.get(`instantly-sequence-draft:server:role:${operation}:uncertain-intent`),
    ).toMatchObject({
      status: "unknown",
      kind: "instantly_sequence_draft",
      request: { input: { client_nonce: "uncertain-intent" } },
    });
  },
);

it("refuses success when PATCH is ignored despite the old email remaining nonempty", async () => {
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  const campaign = {
    id,
    name: "Old",
    status: 0,
    email_list: ["team@example.test"],
    sequences: [
      {
        steps: [
          {
            type: "email",
            delay: 0,
            delay_unit: "days",
            variants: [{ subject: "Old", body: "<p>Existing nonempty body</p>" }],
          },
        ],
      },
    ],
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
  const effects = draftEffects(
    new Map([
      [
        "instantly-role-campaign:server:role",
        { spaceId: "s", status: "completed", result: { campaignId: id } },
      ],
    ]),
  );
  const prisma = {
    recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
    externalEffect: effects,
  };
  const rest = vi.fn(async (_method: string, path: string) =>
    path.startsWith("/accounts/")
      ? { email: "team@example.test" }
      : path === "/accounts?limit=100"
        ? { items: [] }
        : campaign,
  );
  const input = {
    role_id: "role",
    campaign_id: id,
    expected_revision: sequenceConfigurationRevision(campaign),
    name: "New",
    eaccount: "team@example.test",
    steps: [{ subject: "New", body: "Requested replacement", delay_days: 0 }],
  };
  const submit = () =>
    runInstantlyWrite(
      prisma as never,
      rest,
      { spaceId: "s", userId: "u", runId: "run" } as never,
      "server",
      "native_instantly_update_role_draft",
      input,
    );
  await expect(submit()).rejects.toThrow(/saved configuration/i);
  await expect(submit()).rejects.toThrow();
  expect(rest.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
  expect(effects.updateMany.mock.calls.some(([value]) => value.data.status === "completed")).toBe(
    false,
  );
});
