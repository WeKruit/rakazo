import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { ensurePlatformServices } from "./recruiting-bootstrap.js";

const actor: Actor = {
  userId: "person-a",
  spaceId: "personal-a",
  email: "a@example.test",
  isDeploymentOwner: false,
};
const SEARCH = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa";
const ENRICH = "https://mcp.fullenrich.com/mcp";

type Server = { id: string; endpoint: string; secretId: string | null; enabled: boolean };

function fixture(
  options: {
    servers?: Record<string, Server>;
    missing?: Record<string, string[]>;
    lead?: boolean;
    linked?: number;
  } = {},
) {
  const servers = { ...options.servers };
  const missing = { ...options.missing };
  let current = "";
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
    },
    mcpServer: {
      findFirst: vi.fn(async ({ where }: { where: { slug: string } }) => {
        current = where.slug;
        return servers[current] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: { slug: string; endpoint: string } }) => {
        servers[data.slug] = {
          id: data.slug,
          endpoint: data.endpoint,
          secretId: null,
          enabled: true,
        };
        return servers[data.slug];
      }),
    },
    bot: {
      findFirst: vi.fn(async () => (options.lead === false ? null : { id: "main-bot" })),
      findMany: vi.fn(async () =>
        (missing[current] ?? []).map((id) => ({
          id,
          name: id.startsWith("outreach") ? "Outreach" : id,
          spawnKey: null,
        })),
      ),
    },
    botMcpServer: {
      count: vi.fn(async () => options.linked ?? 0),
      createMany: vi.fn(async () => {
        missing[current] = [];
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

describe("ensurePlatformServices", () => {
  it("creates the services and links the crew members that predate them", async () => {
    const f = fixture({
      missing: { "people-search": ["main-bot", "sourcer-bot"], fullenrich: ["outreach-bot"] },
    });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: "people-search", endpoint: SEARCH }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: ["main-bot", "sourcer-bot"].map((botId) =>
        expect.objectContaining({
          botId,
          serverId: "people-search",
          allowAllTools: false,
          allowedTools: ["web_search_exa", "web_search_advanced_exa"],
        }),
      ),
      skipDuplicates: true,
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          botId: "outreach-bot",
          serverId: "fullenrich",
          allowedTools: ["get_credits", "enrich_bulk", "get_enrichment_results"],
        }),
      ],
      skipDuplicates: true,
    });
    f.tx.botMcpServer.createMany.mockClear();
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });

  it("gives outreach the plain web search only, which never fills Results", async () => {
    const f = fixture({ missing: { "people-search": ["outreach-bot"] } });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ botId: "outreach-bot", allowedTools: ["web_search_exa"] })],
      skipDuplicates: true,
    });
  });

  it("links outreach to the enrichment connection the crew already uses, even with its own key", async () => {
    const f = fixture({
      servers: { fullenrich: { id: "own", endpoint: ENRICH, secretId: "secret", enabled: true } },
      missing: { fullenrich: ["outreach-bot"] },
      linked: 1,
    });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.mcpServer.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: "fullenrich" }),
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ botId: "outreach-bot", serverId: "own" })],
      skipDuplicates: true,
    });
  });

  it("leaves unused customized or disabled connections and non-recruiting spaces alone", async () => {
    for (const server of [
      { id: "own", endpoint: "https://search.example.test/mcp", secretId: null, enabled: true },
      { id: "own", endpoint: SEARCH, secretId: "secret", enabled: true },
      { id: "own", endpoint: SEARCH, secretId: null, enabled: false },
    ]) {
      const f = fixture({
        servers: { "people-search": server },
        missing: { "people-search": ["main-bot"] },
      });
      await ensurePlatformServices(f.prisma, actor);
      expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalled();
    }
    const none = fixture({ lead: false, missing: { fullenrich: ["outreach-bot"] } });
    await ensurePlatformServices(none.prisma, actor);
    expect(none.tx.mcpServer.create).not.toHaveBeenCalled();
    expect(none.tx.botMcpServer.createMany).not.toHaveBeenCalled();
  });
});
