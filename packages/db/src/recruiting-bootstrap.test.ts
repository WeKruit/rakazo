import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import * as recruiting from "./recruiting-bootstrap.js";

const native = vi.hoisted(() => ({ bot: vi.fn(), group: vi.fn() }));
vi.mock("./repos.js", () => ({ createBotInTransaction: native.bot }));
vi.mock("./groups.js", () => ({ createGroupInTransaction: native.group }));
const actor: Actor = {
  userId: "person-a",
  spaceId: "personal-a",
  email: "a@example.test",
  isDeploymentOwner: false,
};

function fixture() {
  const bots: Array<{
    id: string;
    spawnKey: string;
    name: string;
    instructions: string;
    archivedAt: Date | null;
  }> = [];
  let group: {
    id: string;
    userId: string;
    spaceId: string;
    archivedAt: Date | null;
    thread: { id: string };
  } | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org-a", space: { deletingAt: null } })),
    },
    space: { findFirst: vi.fn(async () => ({ id: actor.spaceId })) },
    bot: { findMany: vi.fn(async () => bots), count: vi.fn(async () => bots.length) },
    chatGroup: { findFirst: vi.fn(async () => group), count: vi.fn(async () => (group ? 1 : 0)) },
    deploymentSettings: { findUnique: vi.fn(async () => ({ computerHost: "docker" })) },
    mcpServer: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({ id: "autumn-a", ...data })),
    },
    botMcpServer: { createMany: vi.fn(async () => ({ count: 2 })) },
  };
  native.bot.mockImplementation(async (_tx, _actor, input) => {
    const bot = { id: `bot-${bots.length}`, ...input, archivedAt: null };
    bots.push(bot);
    return bot;
  });
  native.group.mockImplementation(async (_tx, _actor, input) => {
    group = {
      id: input.id,
      userId: actor.userId,
      spaceId: actor.spaceId,
      archivedAt: null,
      thread: { id: "crew-thread" },
    };
    return group;
  });
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, bots, getGroup: () => group };
}

beforeEach(() => vi.clearAllMocks());

describe("ensureRecruitingWorkspace", () => {
  it("creates one private four-specialist crew atomically with platform defaults and no credentials or schedules", async () => {
    const f = fixture();
    const result = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      hasAutumnService: true,
      sandboxKind: "fake",
    });
    expect(native.bot.mock.calls.map(([, , input]) => input.name)).toEqual([
      "Main",
      "Sourcer",
      "Outreach",
      "Scheduling",
    ]);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(
      native.bot.mock.calls.every(
        ([tx, who, input]) =>
          tx === f.tx && who === actor && !input.modelProvider && !input.modelId,
      ),
    ).toBe(true);
    expect(native.group).toHaveBeenCalledWith(
      f.tx,
      actor,
      expect.objectContaining({ botIds: f.bots.map((bot) => bot.id) }),
    );
    expect(result).toEqual({ botId: f.bots[0]!.id, groupId: f.getGroup()!.id });
    expect(f.tx.space.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: actor.spaceId, createdByUserId: actor.userId }),
      }),
    );
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        endpoint: "https://api.autumn.ai/mcp",
        secretId: undefined,
      }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [0, 1].map((index) =>
        expect.objectContaining({
          botId: f.bots[index]!.id,
          allowAllTools: false,
          allowedTools: ["credits", "research", "get_task", "get_rows", "reply", "stop_task"],
        }),
      ),
      skipDuplicates: true,
    });
  });

  it("reuses an existing product crew without overwriting private instructions, membership or names", async () => {
    const f = fixture();
    const first = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      hasAutumnService: false,
      sandboxKind: "fake",
    });
    f.bots[0]!.instructions = "My private instructions";
    const again = await recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
      hasAutumnService: false,
      sandboxKind: "fake",
    });
    expect(again).toEqual(first);
    expect(native.bot).toHaveBeenCalledTimes(4);
    expect(native.group).toHaveBeenCalledTimes(1);
    expect(f.bots[0]!.instructions).toBe("My private instructions");
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
  });

  it("rejects shared or foreign Spaces before creating any agents", async () => {
    const f = fixture();
    f.tx.space.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        hasAutumnService: false,
        sandboxKind: "fake",
      }),
    ).rejects.toThrow();
    expect(native.bot).not.toHaveBeenCalled();
    expect(native.group).not.toHaveBeenCalled();
  });

  it("does not add defaults to an existing non-product workspace or revive archived defaults", async () => {
    const f = fixture();
    f.bots.push({
      id: "custom",
      name: "Custom",
      spawnKey: "private",
      instructions: "Keep",
      archivedAt: null,
    });
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        hasAutumnService: false,
        sandboxKind: "fake",
      }),
    ).rejects.toThrow();
    expect(native.bot).not.toHaveBeenCalled();
  });

  it("does not revive an archived product workspace", async () => {
    const f = fixture();
    const options = { hasAutumnService: false, sandboxKind: "fake" };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.getGroup()!.archivedAt = new Date();
    await expect(recruiting.ensureRecruitingWorkspace(f.prisma, actor, options)).rejects.toThrow();
    expect(native.bot).toHaveBeenCalledTimes(4);
  });

  it("does not replace a customized Autumn endpoint during fresh setup", async () => {
    const f = fixture();
    f.tx.mcpServer.findFirst.mockResolvedValueOnce({
      id: "private-autumn",
      endpoint: "https://example.test/mcp",
      transport: "streamable_http",
    } as never);
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        sandboxKind: "fake",
        hasAutumnService: true,
      }),
    ).rejects.toThrow("customized");
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });

  it("does not restore a deliberately removed Autumn assignment on repeat setup", async () => {
    const f = fixture();
    const options = { sandboxKind: "fake", hasAutumnService: true };
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    f.tx.botMcpServer.createMany.mockClear();
    f.tx.mcpServer.create.mockClear();
    await recruiting.ensureRecruitingWorkspace(f.prisma, actor, options);
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" }),
    );
  });

  it("propagates native group creation failure from the same transaction before assigning services", async () => {
    const f = fixture();
    native.group.mockRejectedValueOnce(new Error("group write failed"));
    await expect(
      recruiting.ensureRecruitingWorkspace(f.prisma, actor, {
        hasAutumnService: true,
        sandboxKind: "fake",
      }),
    ).rejects.toThrow("group write failed");
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(native.bot.mock.calls.every(([tx]) => tx === f.tx)).toBe(true);
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
  });
});
