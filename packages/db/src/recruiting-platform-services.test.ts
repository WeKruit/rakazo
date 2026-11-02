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
    grants?: { id: string; allowAllTools: boolean; allowedTools: string[] }[];
    reviewerGrants?: { id: string; allowAllTools: boolean; allowedTools: string[] }[];
    /** Recruiting conversations of this crew that lack its Reviewer. */
    withoutReviewer?: { id: string; members: number }[];
    /** Connected Google Calendars and the Scheduling bots of the crew. */
    calendars?: { id: string }[];
    scheduling?: { id: string }[];
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
      findMany: vi.fn(async () => options.calendars ?? []),
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
      count: vi.fn(async () => (options.withoutReviewer ? 1 : 0)),
      findFirst: vi.fn(async () => (options.lead === false ? null : { id: "main-bot" })),
      findMany: vi.fn(async ({ where }: { where: unknown }) =>
        JSON.stringify(where).includes(":scheduling")
          ? (options.scheduling ?? [])
          : (missing[current] ?? []).map((id) => ({
              id,
              name: id.startsWith("outreach") ? "Outreach" : id,
              spawnKey: null,
            })),
      ),
    },
    chatGroup: {
      findMany: vi.fn(async () =>
        (options.withoutReviewer ?? []).map((group) => ({
          id: group.id,
          _count: { members: group.members },
        })),
      ),
    },
    chatGroupMember: { createMany: vi.fn(async () => ({ count: 1 })) },
    botMcpServer: {
      count: vi.fn(async () => options.linked ?? 0),
      // The Reviewer's grants answer only the query for its role.
      findMany: vi.fn(async ({ where }: { where: unknown }) =>
        JSON.stringify(where).includes(":reviewer")
          ? (options.reviewerGrants ?? [])
          : (options.grants ?? []),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
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
  it("adds the Reviewer to every recruiting conversation of the crew that lacks it", async () => {
    const f = fixture({
      withoutReviewer: [
        { id: "copy-1", members: 3 },
        { id: "full", members: 6 },
      ],
    });
    await ensurePlatformServices(f.prisma, actor);
    // bot.findFirst answers "main-bot" for the Reviewer lookup too.
    expect(f.tx.chatGroupMember.createMany).toHaveBeenCalledWith({
      data: [{ groupId: "copy-1", botId: "main-bot" }],
      skipDuplicates: true,
    });
  });

  it("gives the Reviewer the agent run it grades with", async () => {
    const f = fixture({ reviewerGrants: [{ id: "g", allowAllTools: false, allowedTools: [] }] });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { allowedTools: ["agent_run"] } }),
    );
  });

  it("leaves every grant to the retired research service with no tools", async () => {
    const f = fixture();
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        server: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          endpoint: "https://api.autumn.ai/mcp",
        },
        NOT: { allowAllTools: false, allowedTools: { equals: [] } },
      },
      data: { allowAllTools: false, allowedTools: [] },
    });
  });

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
          allowedTools: ["web_search_exa", "web_search_advanced_exa", "agent_run"],
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

  it("gives the people search's agent run to crews that already search", async () => {
    const f = fixture({
      grants: [
        {
          id: "searches",
          allowAllTools: false,
          allowedTools: ["web_search_exa", "web_search_advanced_exa"],
        },
        { id: "web", allowAllTools: false, allowedTools: ["web_search_exa"] },
      ],
    });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        server: expect.objectContaining({ endpoint: SEARCH, enabled: true }),
      }),
    });
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledTimes(2); // and the retired research grants
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "searches" }),
      data: { allowedTools: ["web_search_exa", "web_search_advanced_exa", "agent_run"] },
    });
  });

  it("lets Scheduling move and cancel bookings where it can already book", async () => {
    const reads = ["get_bookings", "get_availability"];
    const f = fixture({
      grants: [
        { id: "books", allowAllTools: false, allowedTools: [...reads, "create_booking"] },
        { id: "reads", allowAllTools: false, allowedTools: reads },
        {
          id: "done",
          allowAllTools: false,
          allowedTools: ["create_booking", "reschedule_booking", "cancel_booking"],
        },
      ],
    });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        allowAllTools: false,
        server: expect.objectContaining({ endpoint: "https://mcp.cal.com/mcp", enabled: true }),
      }),
    });
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledTimes(2); // and the retired research grants
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "books",
        allowedTools: { equals: [...reads, "create_booking"] },
      }),
      data: {
        allowedTools: [...reads, "create_booking", "reschedule_booking", "cancel_booking"],
      },
    });
  });

  it("gives Scheduling a connected Google Calendar it was never granted", async () => {
    const f = fixture({ calendars: [{ id: "calendar" }], scheduling: [{ id: "scheduling-bot" }] });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.mcpServer.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
        enabled: true,
        secretId: { not: null },
      }),
      select: { id: true },
    });
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          botId: "scheduling-bot",
          serverId: "calendar",
          allowAllTools: false,
          allowedTools: expect.arrayContaining(["suggest_time", "create_event"]),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("adds no calendar grant when no Google Calendar is connected", async () => {
    const f = fixture({ scheduling: [{ id: "scheduling-bot" }] });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.botMcpServer.createMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ botId: "scheduling-bot", serverId: "calendar" })],
      }),
    );
  });

  it("connects every crew to the product's outreach mail, with no key from the user", async () => {
    // The crew lookup for this service includes Scheduling, so the fixture answers with it.
    const f = fixture({ scheduling: [{ id: "scheduling-bot" }] });
    await ensurePlatformServices(f.prisma, actor);
    expect(f.tx.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slug: "instantly",
        endpoint: "https://mcp.instantly.ai/mcp",
      }),
    });
    expect(
      f.tx.mcpServer.create.mock.calls.find(([c]) => c.data.slug === "instantly")?.[0].data,
    ).not.toHaveProperty("secretId");
    expect(f.tx.botMcpServer.createMany).toHaveBeenCalledWith({
      data: ["scheduling-bot"].map((botId) =>
        expect.objectContaining({
          botId,
          serverId: "instantly",
          allowAllTools: false,
          allowedTools: ["get_email", "list_emails", "reply_to_email"],
        }),
      ),
      skipDuplicates: true,
    });
  });
});
