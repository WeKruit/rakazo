import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { ensurePlatformPeopleSearch } from "./recruiting-bootstrap.js";

const actor: Actor = {
  userId: "person-a",
  spaceId: "personal-a",
  email: "a@example.test",
  isDeploymentOwner: false,
};

function fixture(options: { existing?: boolean; leads?: string[] } = {}) {
  const servers: Array<{ id: string; slug: string }> = options.existing
    ? [{ id: "own", slug: "people-search" }]
    : [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
    },
    mcpServer: {
      count: vi.fn(async () => servers.length),
      create: vi.fn(async ({ data }: { data: { slug: string } }) => {
        const row = { id: "search", ...data };
        servers.push(row);
        return row;
      }),
    },
    bot: { findMany: vi.fn(async () => (options.leads ?? []).map((id) => ({ id }))) },
    botMcpServer: { createMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

describe("ensurePlatformPeopleSearch", () => {
  it("adds the search once to a crew lead that predates it", async () => {
    const f = fixture({ leads: ["main-bot"] });
    await ensurePlatformPeopleSearch(f.prisma, actor);
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slug: "people-search",
        endpoint: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa",
        spaceId: actor.spaceId,
        userId: actor.userId,
      }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          botId: "main-bot",
          serverId: "search",
          allowAllTools: false,
          allowedTools: ["web_search_exa", "web_search_advanced_exa"],
        }),
      ],
      skipDuplicates: true,
    });
    f.tx.mcpServer.create.mockClear();
    await ensurePlatformPeopleSearch(f.prisma, actor);
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
  });

  it("leaves an existing connection and non-recruiting spaces alone", async () => {
    const existing = fixture({ existing: true, leads: ["main-bot"] });
    await ensurePlatformPeopleSearch(existing.prisma, actor);
    expect(existing.tx.mcpServer.create).not.toHaveBeenCalled();
    const none = fixture({ leads: [] });
    await ensurePlatformPeopleSearch(none.prisma, actor);
    expect(none.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(none.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });
});
