import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requestConnection } from "./request-connection.js";

const scope = { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" };
const args = { serverId: "server-1", reason: "To read candidate replies." };

function fixture({
  secretId = null as string | null,
  assigned = true,
  pendingRun = undefined as string | undefined,
  rows = [] as Array<{ id: string; slug: string; name: string; endpoint: string | null }>,
} = {}) {
  const prisma: Record<string, any> = {
    mcpServer: {
      findFirst: vi.fn(async () => ({
        id: "server-1",
        name: "Instantly",
        secretId,
        transport: "streamable_http",
      })),
      findMany: vi.fn(async () => rows),
      create: vi.fn(async () => ({ id: "server-new" })),
    },
    botMcpServer: {
      findFirst: vi.fn(async () => (assigned ? { id: "assignment" } : null)),
      create: vi.fn(async () => ({ id: "assignment" })),
    },
    message: {
      findMany: vi.fn(async () =>
        pendingRun
          ? [
              {
                id: "ask-1",
                runId: pendingRun,
                blocks: [
                  {
                    kind: "ask",
                    text: "Connect Instantly",
                    status: "pending",
                    connection: { serverId: "server-1", name: "Instantly", reason: "x" },
                  },
                ],
              },
            ]
          : [],
      ),
    },
    run: { findMany: vi.fn(async () => (pendingRun ? [{ id: pendingRun }] : [])) },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma, db: prisma as unknown as PrismaClient, pause: vi.fn(async () => {}) };
}

describe("request_connection", () => {
  it("returns connected without a card when credentialed and assigned to this bot", async () => {
    const f = fixture({ secretId: "secret-1" });
    expect(await requestConnection(f.db, scope, args, f.pause)).toMatchObject({
      status: "connected",
      message: expect.stringContaining("already connected"),
    });
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.prisma.mcpServer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "server-1", spaceId: "space-1", userId: "user-1", enabled: true },
      }),
    );
  });

  it("pauses on one native connect card when not connected", async () => {
    const f = fixture();
    expect(await requestConnection(f.db, scope, args, f.pause)).toBeUndefined();
    expect(f.pause).toHaveBeenCalledWith({
      kind: "ask",
      text: "Connect Instantly",
      status: "pending",
      connection: { serverId: "server-1", name: "Instantly", reason: "To read candidate replies." },
    });
  });

  it("returns the pending ask instead of opening a second card for the same server", async () => {
    const f = fixture({ pendingRun: "run-0" });
    expect(await requestConnection(f.db, scope, args, f.pause)).toEqual({
      status: "pending",
      askId: "ask-1",
    });
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("refuses an unassigned server and a missing reason without a card", async () => {
    const unassigned = fixture({ secretId: "secret-1", assigned: false });
    expect(await requestConnection(unassigned.db, scope, args, unassigned.pause)).toHaveProperty(
      "error",
    );
    const noReason = fixture();
    expect(
      await requestConnection(noReason.db, scope, { serverId: "server-1" }, noReason.pause),
    ).toHaveProperty("error");
    expect(unassigned.pause).not.toHaveBeenCalled();
    expect(noReason.pause).not.toHaveBeenCalled();
  });

  it("resolves a catalog provider with no server row into a new row and a connect card", async () => {
    const f = fixture();
    f.prisma.mcpServer.findFirst.mockResolvedValue({
      id: "server-new",
      name: "HubSpot",
      secretId: null,
      transport: "streamable_http",
    });
    const reason = "To read HubSpot company records.";
    expect(await requestConnection(f.db, scope, { provider: "HubSpot", reason }, f.pause)).toBe(
      undefined,
    );
    expect(f.prisma.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: "space-1",
        userId: "user-1",
        slug: "hubspot",
        name: "HubSpot",
        transport: "streamable_http",
        endpoint: "https://mcp.hubspot.com",
        enabled: true,
      }),
      select: { id: true },
    });
    expect(f.prisma.botMcpServer.create).toHaveBeenCalledWith({
      data: { spaceId: "space-1", userId: "user-1", botId: "bot-1", serverId: "server-new" },
    });
    expect(f.pause).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { serverId: "server-new", name: "HubSpot", reason },
      }),
    );
  });

  it("resolves a provider to the user's existing connected server", async () => {
    const f = fixture({
      secretId: "secret-1",
      rows: [
        {
          id: "server-1",
          slug: "integration-1",
          name: "Instantly",
          endpoint: "https://mcp.instantly.ai/mcp/",
        },
      ],
    });
    expect(
      await requestConnection(
        f.db,
        scope,
        { provider: "instantly", reason: "Read replies." },
        f.pause,
      ),
    ).toMatchObject({ status: "connected", message: expect.stringContaining("already connected") });
    expect(f.prisma.mcpServer.create).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider with the catalog names", async () => {
    const f = fixture();
    const result = await requestConnection(
      f.db,
      scope,
      { provider: "salesforce", reason: "Read accounts." },
      f.pause,
    );
    expect(result).toHaveProperty("error", expect.stringContaining("HubSpot"));
    expect((result as { error: string }).error).toContain("Gmail");
    expect(f.prisma.mcpServer.create).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
  });
});
