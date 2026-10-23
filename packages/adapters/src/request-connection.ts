import { INSTANTLY_MCP_ENDPOINT } from "@rakazo/core";
import {
  connectAskBlock,
  findPendingConnectAsk,
  loadConnectServer,
  type PrismaClient,
} from "@rakazo/db";

type ConnectBlock = ReturnType<typeof connectAskBlock>;
type Scope = { spaceId: string; userId: string; botId: string; threadId: string };

// ponytail: the official remote MCP endpoints the product already targets; add a row when a provider ships one.
const CONNECTOR_CATALOG = [
  {
    slug: "gmail",
    name: "Gmail",
    endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    aliases: ["google mail"],
  },
  {
    slug: "google-calendar",
    name: "Google Calendar",
    endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
    aliases: ["gcal"],
  },
  { slug: "cal-com", name: "Cal.com", endpoint: "https://mcp.cal.com/mcp", aliases: ["cal"] },
  { slug: "instantly", name: "Instantly", endpoint: INSTANTLY_MCP_ENDPOINT, aliases: [] },
  { slug: "hubspot", name: "HubSpot", endpoint: "https://mcp.hubspot.com", aliases: [] },
  {
    slug: "fullenrich",
    name: "FullEnrich",
    endpoint: "https://mcp.fullenrich.com/mcp",
    aliases: [],
  },
  { slug: "autumn", name: "Autumn", endpoint: "https://api.autumn.ai/mcp", aliases: [] },
];

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const address = (value: string | null) => {
  try {
    const url = new URL(value ?? "");
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
};

/** A provider name → the user's server row, creating it (unconnected, assigned to this bot) from the catalog. */
async function resolveProvider(prisma: PrismaClient, scope: Scope, provider: string) {
  const wanted = key(provider);
  const entry = CONNECTOR_CATALOG.find((item) =>
    [item.slug, item.name, ...item.aliases].some((name) => key(name) === wanted),
  );
  const rows = await prisma.mcpServer.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId, enabled: true },
    select: { id: true, slug: true, name: true, endpoint: true },
  });
  const row = rows.find(
    (server) =>
      key(server.slug) === wanted ||
      key(server.name) === wanted ||
      (entry !== undefined && address(server.endpoint) === address(entry.endpoint)),
  );
  if (row) return { serverId: row.id };
  if (!entry)
    return {
      error: `No connector named "${provider}". Available: ${CONNECTOR_CATALOG.map((item) => item.name).join(", ")}.`,
    };
  try {
    // Same row add_mcp_server/Integrations create: no credential yet; the card's Connect supplies it.
    return await prisma.$transaction(async (tx) => {
      const server = await tx.mcpServer.create({
        data: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          slug: entry.slug,
          name: entry.name,
          transport: "streamable_http",
          endpoint: entry.endpoint,
          enabled: true,
        },
        select: { id: true },
      });
      await tx.botMcpServer.create({
        data: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
          serverId: server.id,
        },
      });
      return { serverId: server.id };
    });
  } catch (error) {
    // P2002: a disabled row already owns this slug.
    if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
    return {
      error: `${entry.name} exists but is disabled; ask the user to re-enable it in Integrations.`,
    };
  }
}

/** request_connection: connected → result; otherwise one pending connect card per server and thread. */
export async function requestConnection(
  prisma: PrismaClient,
  scope: Scope,
  args: Record<string, unknown>,
  pause: (block: ConnectBlock) => Promise<void>,
) {
  let serverId = typeof args.serverId === "string" ? args.serverId.trim() : "";
  const provider = typeof args.provider === "string" ? args.provider.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if ((!serverId && !provider) || !reason || reason.length > 240)
    return { error: "request_connection needs serverId or provider, and a one-sentence reason." };
  if (!serverId) {
    const resolved = await resolveProvider(prisma, scope, provider);
    if ("error" in resolved) return resolved;
    serverId = resolved.serverId;
  }
  const server = await loadConnectServer(prisma, scope, serverId);
  if (!server) return { error: "No enabled MCP server with that serverId exists." };
  if (server.connected) return { status: "connected" as const };
  if (!server.assigned)
    return {
      error: `${server.name} is not assigned to you; ask the user to add it to this agent's MCP servers.`,
    };
  const pending = await findPendingConnectAsk(prisma, { threadId: scope.threadId, serverId });
  if (pending) return { status: "pending" as const, askId: pending.askId };
  await pause(connectAskBlock({ serverId, name: server.name.slice(0, 80), reason }));
  return undefined;
}
