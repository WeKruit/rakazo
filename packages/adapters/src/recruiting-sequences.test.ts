import { expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
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
