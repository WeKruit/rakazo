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
const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa";

type Server = { id: string; endpoint: string; secretId: string | null; enabled: boolean };

function fixture(options: { server?: Server; missing?: string[] } = {}) {
  let server = options.server ?? null;
  let missing = options.missing ?? [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
    },
    mcpServer: {
      findFirst: vi.fn(async () => server),
      create: vi.fn(async ({ data }: { data: { endpoint: string } }) => {
        server = { id: "search", endpoint: data.endpoint, secretId: null, enabled: true };
        return server;
      }),
    },
    bot: { findMany: vi.fn(async () => missing.map((id) => ({ id }))) },
    botMcpServer: {
      createMany: vi.fn(async () => {
        missing = [];
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

describe("ensurePlatformPeopleSearch", () => {
  it("creates the search and links the lead and sourcer that predate it", async () => {
    const f = fixture({ missing: ["main-bot", "sourcer-bot"] });
    await ensurePlatformPeopleSearch(f.prisma, actor);
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: "people-search", endpoint: ENDPOINT }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: ["main-bot", "sourcer-bot"].map((botId) =>
        expect.objectContaining({
          botId,
          serverId: "search",
          allowAllTools: false,
          allowedTools: ["web_search_exa", "web_search_advanced_exa"],
        }),
      ),
      skipDuplicates: true,
    });
    f.tx.botMcpServer.createMany.mockClear();
    await ensurePlatformPeopleSearch(f.prisma, actor);
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });

  it("adds a missing sourcer link to an existing platform search", async () => {
    const f = fixture({
      server: { id: "search", endpoint: ENDPOINT, secretId: null, enabled: true },
      missing: ["sourcer-bot"],
    });
    await ensurePlatformPeopleSearch(f.prisma, actor);
    expect(f.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ botId: "sourcer-bot", serverId: "search" })],
      skipDuplicates: true,
    });
  });

  it("leaves customized or disabled connections and non-recruiting spaces alone", async () => {
    for (const server of [
      { id: "own", endpoint: "https://search.example.test/mcp", secretId: null, enabled: true },
      { id: "own", endpoint: ENDPOINT, secretId: "secret", enabled: true },
      { id: "own", endpoint: ENDPOINT, secretId: null, enabled: false },
    ]) {
      const f = fixture({ server, missing: ["main-bot"] });
      await ensurePlatformPeopleSearch(f.prisma, actor);
      expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
    }
    const none = fixture();
    await ensurePlatformPeopleSearch(none.prisma, actor);
    expect(none.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(none.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });
});
