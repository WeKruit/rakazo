import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requestConnection } from "./request-connection.js";

const scope = { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" };
const args = { serverId: "server-1", reason: "To read candidate replies." };

function fixture({
  secretId = null as string | null,
  endpoint = null as string | null,
  assigned = true,
  name = "Instantly",
  pendingRun = undefined as string | undefined,
  /** A waiting run in another of the user's conversations, holding a card for this server. */
  elsewhere = false,
  rows = [] as Array<{ id: string; slug: string; name: string; endpoint: string | null }>,
} = {}) {
  const prisma: Record<string, any> = {
    mcpServer: {
      findFirst: vi.fn(async () => ({
        id: "server-1",
        name,
        slug: name.toLowerCase(),
        secretId,
        transport: "streamable_http",
        endpoint,
      })),
      findMany: vi.fn(async () => rows),
      create: vi.fn(async () => ({ id: "server-new" })),
    },
    botMcpServer: {
      findFirst: vi.fn(async () => (assigned ? { id: "assignment" } : null)),
      create: vi.fn(async () => ({ id: "assignment" })),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: { threadId: unknown } }) =>
        typeof where.threadId === "object"
          ? elsewhere
            ? [
                {
                  id: "ask-main",
                  threadId: "thread-main",
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
            : []
          : pendingRun
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
    run: {
      findMany: vi.fn(async ({ where }: { where: { status: string; threadId?: string } }) =>
        where.threadId
          ? pendingRun
            ? [{ id: pendingRun }]
            : []
          : elsewhere
            ? [{ id: "run-main", threadId: "thread-main" }]
            : [],
      ),
    },
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

  it("treats the product's own outreach mail as connected without a card", async () => {
    vi.stubEnv("INSTANTLY_API_KEY", "platform-mail-key");
    try {
      const f = fixture({ endpoint: "https://mcp.instantly.ai/mcp" });
      expect(await requestConnection(f.db, scope, args, f.pause)).toMatchObject({
        status: "connected",
      });
      expect(f.pause).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never shows a recruiter a card for a service the product runs", async () => {
    const f = fixture({ endpoint: "https://mcp.instantly.ai/mcp" });
    expect(await requestConnection(f.db, scope, args, f.pause, "", true)).toMatchObject({
      error: expect.stringContaining("provider gmail"),
    });
    expect(f.pause).not.toHaveBeenCalled();
    const gmail = fixture({ name: "Gmail" });
    expect(await requestConnection(gmail.db, scope, args, gmail.pause, "", true)).toBeUndefined();
    expect(gmail.pause).toHaveBeenCalled();
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

  it("builds a mail card's reason for a send the recruiter asked for, naming the typed address", async () => {
    const f = fixture({ name: "Gmail" });
    const shown = async (reason: string, typed: string) => {
      await requestConnection(f.db, scope, { serverId: "server-1", reason }, f.pause, typed);
      return (f.pause.mock.calls.at(-1) as unknown as [{ connection: { reason: string } }])[0]
        .connection.reason;
    };
    const send = "邮箱在上面 Wei.Zhang.Test@example.com，直接发吧";
    const zh = await shown(
      "连接 Gmail 后，这封已写好的邮件会保留在这里，并出现单独的发送卡片。",
      send,
    );
    expect(zh).toContain("wei.zhang.test@example.com");
    expect(zh).not.toContain("这封已写好的邮件");
    expect(await shown("To send the email above.", send)).toMatch(
      /^The draft is kept\..*to wei\.zhang\.test@example\.com/,
    );
    expect(await shown("用来读取候选人的回复。", "帮我看看有没有人回复")).toBe(
      "用来读取候选人的回复。",
    );
  });

  it("returns the pending ask instead of opening a second card for the same server", async () => {
    const f = fixture({ pendingRun: "run-0" });
    expect(await requestConnection(f.db, scope, args, f.pause)).toMatchObject({
      status: "pending",
      askId: "ask-1",
      message: expect.stringContaining("Do not show another"),
    });
    expect(f.pause).not.toHaveBeenCalled();
  });

  // Team-stuck 11-16: Kruit's calendar card, then the role team's own card for the same calendar.
  it("shows no second card when another conversation already holds one for the server", async () => {
    const f = fixture({ elsewhere: true });
    expect(await requestConnection(f.db, scope, args, f.pause)).toMatchObject({
      status: "pending",
      askId: "ask-main",
      message: expect.stringContaining("open in another conversation"),
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
