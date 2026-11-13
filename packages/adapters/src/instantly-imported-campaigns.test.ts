import { describe, expect, it, vi } from "vitest";
import { bindImportedCampaigns } from "./instantly-native-writes.js";

const campaign = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const mail = (campaignId: string, eaccount: string) => ({
  campaignId,
  eaccount,
  direction: "sent",
});

function store(input: {
  emails: Record<string, unknown>[];
  assigned: string[];
  taken?: boolean;
  earlier?: Record<string, unknown>;
}) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const prisma = {
    externalEffect: {
      findMany: vi.fn(async ({ where }: { where: { kind: string } }) =>
        where.kind === "recruiting_history_import"
          ? [
              {
                id: "import-1",
                runId: "run-1",
                spaceId: "space-1",
                result: { roleId: "role-1", emails: input.emails },
              },
            ]
          : [],
      ),
      findFirst: vi.fn(async () => (input.taken ? { id: "someone-else" } : null)),
      findUnique: vi.fn(async () => input.earlier ?? null),
      update: vi.fn(async (args: Record<string, unknown>) => {
        updated.push(args);
        return args;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
    sendingMailboxAssignment: {
      findMany: vi.fn(async () => input.assigned.map((email) => ({ email }))),
    },
    recruitingRole: { findFirst: vi.fn(async () => ({ title: "Backend Engineer" })) },
    mcpServer: { findMany: vi.fn(async () => [{ id: "server-1" }]) },
  };
  return { prisma: prisma as never, created, updated };
}

describe("bindImportedCampaigns", () => {
  it("links a role to its imported campaign as history once every mailbox it used is the account's", async () => {
    const { prisma, created } = store({
      emails: [mail(campaign, "a@x.com"), mail(campaign, "B@x.com"), mail(campaign, "a@x.com")],
      assigned: ["a@x.com", "b@x.com"],
    });
    await expect(bindImportedCampaigns(prisma, "user-1")).resolves.toBe(1);
    expect(created).toEqual([
      expect.objectContaining({
        runId: "run-1",
        spaceId: "space-1",
        kind: "instantly_role_campaign",
        idempotencyKey: "instantly-role-campaign:server-1:role-1:history",
        request: { roleId: "role-1", serverId: "server-1", importedHistory: true },
        result: {
          campaignId: campaign,
          campaignName: "Backend Engineer",
          eaccount: "a@x.com",
          leads: {},
          created: false,
        },
      }),
    ]);
  });

  it("turns an earlier link nobody was added through into history, so new people get the role's own campaign", async () => {
    const earlier = {
      id: "binding-1",
      request: { roleId: "role-1", serverId: "server-1", importedHistory: true },
      result: { campaignId: campaign, leads: {} },
    };
    const { prisma, created, updated } = store({
      emails: [mail(campaign, "a@x.com")],
      assigned: ["a@x.com"],
      earlier,
    });
    await expect(bindImportedCampaigns(prisma, "user-1")).resolves.toBe(1);
    expect(created).toEqual([]);
    expect(updated).toEqual([
      {
        where: { id: "binding-1" },
        data: { idempotencyKey: "instantly-role-campaign:server-1:role-1:history" },
      },
    ]);
    // Someone was already added through it: it stays the role's own campaign.
    const used = store({
      emails: [mail(campaign, "a@x.com")],
      assigned: ["a@x.com"],
      earlier: { ...earlier, result: { campaignId: campaign, leads: { k: { email: "p@y.com" } } } },
      taken: true,
    });
    await expect(bindImportedCampaigns(used.prisma, "user-1")).resolves.toBe(0);
    expect(used.updated).toEqual([]);
  });

  it("leaves the role alone while a mailbox is not the account's, the history spans campaigns, or the campaign is taken", async () => {
    for (const input of [
      { emails: [mail(campaign, "a@x.com"), mail(campaign, "c@x.com")], assigned: ["a@x.com"] },
      { emails: [mail(campaign, "a@x.com"), mail(other, "a@x.com")], assigned: ["a@x.com"] },
      { emails: [mail(campaign, "a@x.com")], assigned: ["a@x.com"], taken: true },
    ]) {
      const { prisma, created } = store(input);
      await expect(bindImportedCampaigns(prisma, "user-1")).resolves.toBe(0);
      expect(created).toEqual([]);
    }
  });
});
