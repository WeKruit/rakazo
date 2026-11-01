import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createRepos: () => ({ getBot: async () => ({ id: "main", thread: { id: "thread" } }) }),
  getRecruitingWorkspace: async () => ({
    role: { id: "role" },
    crmTarget: {
      target: {
        mcpServerId: "crm",
        serverRevision: 7,
        organizationId: "org",
        crmRoleId: "crm-role",
      },
    },
  }),
}));

import { readRecruitingAccountView } from "./recruiting-account.js";

it("global sequence summaries use exact owned mirrors and native associations without provider or candidate reads", async () => {
  const actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: false,
  } satisfies Actor;
  const role = {
    id: "role",
    title: "Engineer",
    sourceThreadId: "thread",
    playbookStage: "outreach",
    sourceThread: {
      id: "thread",
      groupId: null,
      botId: "main",
      userId: actor.userId,
      spaceId: actor.spaceId,
    },
  };
  const findCampaigns = vi.fn(async (_query: unknown) => [
    {
      mcpServerId: "crm",
      crmCampaignId: "saved-campaign",
      name: "Saved outreach",
      status: 1,
      campaignCreatedAt: new Date("2026-10-20T00:00:00Z"),
    },
  ]);
  const effects = vi.fn(async (_query: unknown) => [
    {
      request: { roleId: "role", serverId: "mail" },
      result: { campaignId: "native-draft", campaignName: "Native draft" },
    },
    {
      request: { roleId: "role", serverId: "foreign" },
      result: { campaignId: "foreign-draft", campaignName: "Foreign" },
    },
  ]);
  const prisma = {
    recruitingRole: {
      findMany: vi.fn(
        async (query: {
          where: { activeThreads?: { some: { userId: string; spaceId: string } } };
        }) => {
          const all = [role, { ...role, id: "stale-role" }];
          const activeThreads = [
            { activeRecruitingRoleId: "role", userId: actor.userId, spaceId: actor.spaceId },
          ];
          return query.where.activeThreads
            ? all.filter((role) =>
                activeThreads.some(
                  (thread) =>
                    thread.activeRecruitingRoleId === role.id &&
                    thread.userId === query.where.activeThreads!.some.userId &&
                    thread.spaceId === query.where.activeThreads!.some.spaceId,
                ),
              )
            : all;
        },
      ),
    },
    recruitingCrmCampaign: { findMany: findCampaigns },
    recruitingCrmLead: {
      findMany: vi.fn(async (_query: unknown) => [
        {
          crmCampaignId: "saved-campaign",
          crmCandidateId: "crm-person",
          status: 1,
          interestStatus: 1,
          openCount: 0,
          replyCount: null,
          lastContactAt: new Date(),
        },
      ]),
    },
    externalEffect: { findMany: effects },
    recruitingCrmContact: {
      findMany: vi.fn(async (_query: unknown) => [
        { crmCandidateId: "crm-person", email: "avery@example.test" },
      ]),
    },
    recruitingCandidate: {
      findMany: vi.fn(async (_query: unknown) => [{ candidateKey: "native-person" }]),
    },
    mcpServer: { findMany: vi.fn(async (_query: unknown) => [{ id: "mail" }]) },
  };
  const execute = vi.fn(() => {
    throw new Error("No provider calls permitted");
  });
  const result = await readRecruitingAccountView(
    { prisma: prisma as never, artifacts: {} as never, connectors: { execute } as never },
    actor,
    { view: "sequence", sequenceSummary: true, limit: 5 },
  );
  expect(execute).not.toHaveBeenCalled();
  expect(result.roles.map((role) => role.id)).toEqual(["role"]);
  expect(
    prisma.recruitingRole.findMany.mock.calls.every(
      ([query]) =>
        query.where.activeThreads?.some.userId === actor.userId &&
        query.where.activeThreads?.some.spaceId === actor.spaceId,
    ),
  ).toBe(true);
  expect(findCampaigns.mock.calls[0]![0]).toMatchObject({
    where: {
      userId: "owner",
      spaceId: "space",
      mcpServerId: "crm",
      organizationId: "org",
      crmRoleId: "crm-role",
      mcpServer: { userId: "owner", spaceId: "space" },
    },
  });
  expect(effects.mock.calls[0]![0]).toMatchObject({
    where: { run: { userId: "owner", spaceId: "space", threadId: "thread" } },
  });
  expect(result.items[0]?.campaigns).toHaveLength(2);
  expect(result.items[0]?.campaigns?.[0]).toMatchObject({
    observations: { total: 1, active: 1, opened: 0, replied: null, interested: 1 },
    campaign: { createdAt: "2026-10-20T00:00:00.000Z" },
  });
  expect(JSON.stringify(result)).not.toContain("Foreign");
  expect(result.items[0]?.candidates).toBeUndefined();
  expect(result.items[0]?.correspondence).toBeUndefined();
  effects.mockResolvedValue([
    {
      request: { roleId: "role", serverId: "mail" },
      result: {
        campaignId: "removed-membership",
        campaignName: "Latest",
        leads: {},
        staged: { person: { email: "avery@example.test", first_name: "Avery" } },
      },
    },
    {
      request: { roleId: "role", serverId: "mail" },
      result: {
        campaignId: "removed-membership",
        campaignName: "Older",
        leads: { person: { leadId: "old", email: "avery@example.test" } },
      },
    },
    {
      request: { roleId: "role", serverId: "mail" },
      result: {
        campaignId: "actual-native",
        campaignName: "Matched native",
        leads: { "native-person": { leadId: "saved", email: "other-address@example.test" } },
      },
    },
  ] as never);
  prisma.recruitingCrmLead.findMany.mockResolvedValue([
    {
      crmCampaignId: "saved-campaign",
      crmCandidateId: "crm-person",
      status: 1,
      interestStatus: 1,
      openCount: 0,
      replyCount: null,
      lastContactAt: new Date(),
    },
    {
      crmCampaignId: "saved-campaign",
      crmCandidateId: "not-matched",
      status: 2,
      interestStatus: null,
      openCount: 1,
      replyCount: 0,
      lastContactAt: new Date(),
    },
  ] as never);
  const fullSource = await readRecruitingAccountView(
    { prisma: prisma as never, artifacts: {} as never, connectors: { execute } as never },
    actor,
    { view: "sequence", sequenceSummary: true, limit: 5 },
  );
  const filtered = await readRecruitingAccountView(
    { prisma: prisma as never, artifacts: {} as never, connectors: { execute } as never },
    actor,
    { view: "sequence", sequenceSummary: true, sequenceContactQuery: "Avery", limit: 5 },
  );
  expect(prisma.recruitingCrmContact.findMany.mock.calls[0]![0]).toMatchObject({
    where: {
      userId: "owner",
      spaceId: "space",
      mcpServerId: "crm",
      organizationId: "org",
      OR: [
        { name: { contains: "avery", mode: "insensitive" } },
        { email: { contains: "avery", mode: "insensitive" } },
      ],
    },
  });
  expect(prisma.recruitingCandidate.findMany.mock.calls[0]![0]).toMatchObject({
    where: { roleId: "role", role: { userId: "owner", spaceId: "space" } },
  });
  expect(filtered.items[0]?.sequenceContactPartial).toBe(true);
  expect(filtered.items[0]?.campaigns?.map((campaign) => campaign.campaign!.id)).toEqual([
    "saved-campaign",
    "actual-native",
  ]);
  expect(filtered.items[0]?.campaigns?.[0]?.observations).toEqual(
    fullSource.items[0]?.campaigns?.[0]?.observations,
  );
  expect(filtered.items[0]?.campaigns?.[0]?.observations?.total).toBe(2);
  expect(execute).not.toHaveBeenCalled();
});
