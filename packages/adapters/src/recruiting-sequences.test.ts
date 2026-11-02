import { expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  IsolationError: class IsolationError extends Error {},
  getRecruitingWorkspace: vi.fn(async () => ({
    role: { id: "role", title: "Engineer" },
    revision: { brief: null },
  })),
}));

vi.mock("./recruiting-reads.js", () => ({ getRecruitingRoleCampaign: vi.fn() }));

import { getRecruitingRoleCampaign } from "./recruiting-reads.js";
import { executeRecruitingSequence } from "./recruiting-sequences.js";

const actor = { userId: "user", spaceId: "space" } as never;
const target = { kind: "bot", botId: "bot", threadId: "thread" } as const;
function dependencies() {
  const assignment = {
    botId: "bot",
    allowAllTools: true,
    allowedTools: [],
    server: { id: "server", revision: 1 },
  };
  const execute = vi.fn(async function* () {
    yield {
      type: "result" as const,
      data: {
        structuredContent: {
          result: {
            roleId: "role",
            roleTitle: "Engineer",
            mailboxes: [],
            campaign: null,
          },
        },
      },
    };
  });
  return {
    prisma: { botMcpServer: { findFirst: vi.fn(async () => assignment) } } as never,
    connectors: { execute } as never,
    reauthorize: vi.fn(async () => target),
    stillAuthorized: vi.fn(async () => true),
    execute,
  };
}
it("rejects activation and arbitrary tool commands before connector dispatch", async () => {
  const deps = dependencies();
  await expect(
    executeRecruitingSequence(deps, actor, target, {
      operation: "activate",
      roleId: "role",
      serverId: "server",
    } as never),
  ).rejects.toThrow();
  expect(deps.execute).not.toHaveBeenCalled();
});
it("rejects results if authorization is revoked while the provider responds", async () => {
  const deps = dependencies();
  deps.stillAuthorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    executeRecruitingSequence(deps, actor, target, {
      operation: "read",
      roleId: "role",
      serverId: "server",
    }),
  ).rejects.toThrow();
  expect(deps.execute).toHaveBeenCalledOnce();
});

it("previews an exact imported sequence through its authorized role read without adopting or rewriting it", async () => {
  const deps = dependencies();
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  const findUnique = vi.fn(async () => null);
  const create = vi.fn();
  Object.assign(deps.prisma, { externalEffect: { findUnique, create } });
  const observedDetails = {
    schedules: null,
    sequences: [
      {
        steps: [
          {
            type: "email",
            delay: 2,
            delayUnit: "days",
            variants: [
              {
                subject: "Saved rich content",
                body: '<p>Hi <strong>there</strong><img src="https://example.test/asset.png" /></p>',
              },
            ],
          },
        ],
      },
    ],
  };
  vi.mocked(getRecruitingRoleCampaign).mockResolvedValue({
    status: "ready",
    serverId: "server",
    leads: [],
    campaign: {
      id,
      name: "Saved sequence",
      eaccount: "team@example.test",
      status: 1,
      stopOnReply: true,
      observedDetails,
    },
  });
  const output = await executeRecruitingSequence(deps, actor, target, {
    operation: "read",
    roleId: "role",
    serverId: "server",
    campaignId: id,
  });
  expect(getRecruitingRoleCampaign).toHaveBeenCalledWith(deps, actor, target, {
    campaignId: id,
    serverId: "server",
  });
  expect(output.campaign).toMatchObject({
    id,
    editable: false,
    steps: [],
    observedDetails,
    eaccount: "team@example.test",
  });
  expect(create).not.toHaveBeenCalled();
  expect(deps.execute).not.toHaveBeenCalled();
});

it("rejects an imported read from a different assigned source before returning content", async () => {
  const deps = dependencies();
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  Object.assign(deps.prisma, { externalEffect: { findUnique: vi.fn(async () => null) } });
  vi.mocked(getRecruitingRoleCampaign).mockResolvedValue({
    status: "ready",
    serverId: "another-source",
    leads: [],
    campaign: { id, name: "Other", eaccount: null, status: 0, stopOnReply: true },
  });
  await expect(
    executeRecruitingSequence(deps, actor, target, {
      operation: "read",
      roleId: "role",
      serverId: "server",
      campaignId: id,
    }),
  ).rejects.toThrow();
  expect(deps.execute).not.toHaveBeenCalled();
});

it("checks exact campaign membership before response changes and reports asynchronous updates honestly", async () => {
  const deps = dependencies();
  const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
  vi.mocked(getRecruitingRoleCampaign).mockResolvedValue({
    status: "ready",
    serverId: "server",
    leads: [],
    campaign: { id, name: "Saved", eaccount: null, status: 1, stopOnReply: true },
  });
  let member = false;
  const calls: string[] = [];
  deps.execute.mockImplementation(async function* (request: { tool: string }) {
    calls.push(request.tool);
    yield {
      type: "result" as const,
      data: {
        structuredContent: {
          result: request.tool.endsWith("list_leads")
            ? {
                items: [
                  {
                    email: "person@example.test",
                    campaign: member ? id : "another",
                    lt_interest_status: null,
                  },
                ],
              }
            : { accepted: true },
        },
      },
    };
  } as never);
  const input = {
    operation: "response",
    roleId: "role",
    serverId: "server",
    campaignId: id,
    email: "person@example.test",
    response: "interested",
  } as never;
  await expect(executeRecruitingSequence(deps, actor, target, input)).rejects.toThrow();
  expect(calls).toEqual(["native_instantly_list_leads"]);
  member = true;
  calls.length = 0;
  const output = await executeRecruitingSequence(deps, actor, target, input);
  expect(output).toMatchObject({
    response: { email: "person@example.test", state: "pending", interest: 1 },
  });
  expect(calls).toEqual([
    "native_instantly_list_leads",
    "native_instantly_update_lead_interest",
    "native_instantly_list_leads",
  ]);
});

it.each(["read", "pause", "save"] as const)(
  "returns verified %s without awaiting the derived-cache write",
  async (operation) => {
    const { runInstantlyWrite, sequenceConfigurationRevision } = await import(
      "./instantly-native-writes.js"
    );
    const deps = dependencies();
    const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
    let campaign: Record<string, unknown> = {
      id,
      name: "Original",
      status: operation === "save" ? 0 : 1,
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
    const entries = new Map<string, Record<string, unknown>>([
      [
        "instantly-role-campaign:server:role",
        {
          spaceId: "space",
          status: "completed",
          kind: "instantly_role_campaign",
          result: { campaignId: id, campaignName: "Original" },
        },
      ],
    ]);
    let release!: (value: number) => void;
    const blocked = new Promise<number>((resolve) => {
      release = resolve;
    });
    const write = vi.fn(async () => blocked);
    const effects = {
      findUnique: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          entries.get(where.idempotencyKey) ?? null,
      ),
      findMany: vi.fn(async () => [...entries.values()]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        entries.set(String(data.idempotencyKey), data);
        return data;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { idempotencyKey: string };
          data: Record<string, unknown>;
        }) => {
          Object.assign(entries.get(where.idempotencyKey)!, data);
          return { count: 1 };
        },
      ),
    };
    Object.assign(deps.prisma, {
      $executeRaw: write,
      externalEffect: effects,
      recruitingRole: { findFirst: vi.fn(async () => ({ id: "role", title: "Engineer" })) },
      run: { findFirst: vi.fn(async () => ({ id: "existing-run" })) },
    });
    const sequence: string[] = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const rest = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === "/accounts?limit=100") return { items: [{ email: "team@example.test" }] };
      if (path.startsWith("/accounts/")) return { email: "team@example.test" };
      if (method === "POST" && path.endsWith("/pause")) {
        campaign = { ...campaign, status: 2 };
        sequence.push("mutation-completed");
        vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
        return { success: true };
      }
      if (method === "PATCH") {
        campaign = { ...campaign, ...(body as object) };
        sequence.push("mutation-completed");
        vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
        return campaign;
      }
      sequence.push("verification-read");
      return campaign;
    });
    deps.execute.mockImplementation(async function* (
      request: { tool: string; args: object },
      context: import("@rakazo/adapter-kit").AdapterContext,
    ) {
      const result = await runInstantlyWrite(
        deps.prisma,
        rest,
        context,
        "server",
        request.tool,
        request.args,
      );
      yield { type: "result", data: { structuredContent: { result } } };
    } as never);
    const work: Array<() => Promise<void>> = [];
    try {
      const expectedRevision = sequenceConfigurationRevision(campaign);
      const result = await executeRecruitingSequence(
        {
          ...deps,
          deferSequenceObservation: (job) => {
            work.push(job);
          },
        },
        actor,
        target,
        operation === "save"
          ? {
              operation,
              roleId: "role",
              serverId: "server",
              campaignId: id,
              expectedRevision,
              draft: {
                name: "Verified renamed",
                eaccount: "team@example.test",
                steps: [{ subject: "Hi", body: "Saved copy", delay_days: 0 }],
                timezone: "America/Chicago",
                send_hours: "weekdays_9_to_5",
              },
            }
          : { operation, roleId: "role", serverId: "server", campaignId: id },
      );
      expect(result.campaign).toMatchObject({
        id,
        name: operation === "save" ? "Verified renamed" : "Original",
        status: operation === "pause" ? 2 : operation === "save" ? 0 : 1,
      });
      expect(result.observedAt).toBe(
        operation === "read" ? "2030-01-01T00:00:00.000Z" : "2031-01-01T00:00:00.000Z",
      );
      if (operation !== "read")
        expect(sequence.lastIndexOf("verification-read")).toBeGreaterThan(
          sequence.indexOf("mutation-completed"),
        );
      expect(write).not.toHaveBeenCalled();
      if (operation === "save") {
        expect(work).toHaveLength(1);
        expect(
          [...entries.values()].find((effect) => effect.kind === "instantly_sequence_draft")
            ?.result,
        ).toMatchObject({
          __rakazoSequenceObservation: {
            sourceRevision: 1,
            observedAt: "2031-01-01T00:00:00.000Z",
            campaign: { name: "Verified renamed", status: 0 },
          },
        });
      } else {
        expect(work).toHaveLength(1);
        let finished = false;
        const pending = work[0]!().then(() => {
          finished = true;
        });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        expect(write).toHaveBeenCalledOnce();
        expect(finished).toBe(false);
        release(1);
        await pending;
        expect(finished).toBe(true);
        deps.stillAuthorized.mockResolvedValue(false);
        await expect(work[0]!()).rejects.toThrow();
        expect(write).toHaveBeenCalledOnce();
      }
    } finally {
      release?.(1);
      vi.useRealTimers();
    }
  },
);
