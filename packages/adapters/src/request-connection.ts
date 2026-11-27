import { INSTANTLY_MCP_ENDPOINT, isVendorService, sendRecipients } from "@rakazo/core";
import {
  connectAskBlock,
  findAccountConnectAsk,
  findPendingConnectAsk,
  loadConnectServer,
  type PrismaClient,
} from "@rakazo/db";

import { hasPlatformMcpCredential } from "./mcp-connector.js";

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
      error: `${entry.name} exists but is disabled in Integrations.`,
    };
  }
}

/**
 * A mail connect card keeps the agent's own reason and adds any address the recruiter typed that
 * the reason leaves out (gate 9fd9c2ff: the card never showed the address). A fixed line here
 * replaced the agent's "not sent yet" and claimed a kept draft even when none existed.
 */
function mailReason(reason: string, recruiterText: string) {
  const missing = sendRecipients({ text: recruiterText }).filter(
    (address) => !reason.toLowerCase().includes(address),
  );
  return missing.length ? `${reason} (${missing.join(", ")})` : reason;
}

/** request_connection: connected → result; otherwise one pending connect card per server and thread. */
export async function requestConnection(
  prisma: PrismaClient,
  scope: Scope,
  args: Record<string, unknown>,
  pause: (block: ConnectBlock) => Promise<void>,
  recruiterText = "",
  /** A recruiter connects only their own accounts (Gmail, calendar), never a product service. */
  recruiter = false,
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
  // A product-provided service is connected for everyone; it never needs a card.
  const platform = hasPlatformMcpCredential({ ...server, secretId: null });
  if (server.connected || (platform && server.assigned))
    return {
      status: "connected" as const,
      message: `${server.name} is already connected and assigned to you (connectors_search_tools group "${server.slug}").`,
    };
  // One-off-email on 7c5c1c30: a card for the product's email sending sat beside the Gmail card,
  // so the recruiter saw two Connect buttons and an English reason.
  if (recruiter && isVendorService(server))
    return {
      error: `Not shown: ${server.name} is run for the recruiter by the product, never theirs to connect. Recruiters connect only their own Gmail and calendar.`,
    };
  if (!server.assigned)
    return {
      error: `${server.name} is not assigned to you.`,
    };
  const pending = await findPendingConnectAsk(prisma, { threadId: scope.threadId, serverId });
  if (pending)
    return {
      status: "pending" as const,
      askId: pending.askId,
      message: `The ${server.name} card is still showing above, waiting for the recruiter; no second card was shown.`,
    };
  const elsewhere = await findAccountConnectAsk(prisma, {
    spaceId: scope.spaceId,
    userId: scope.userId,
    serverId,
  });
  if (elsewhere && elsewhere.threadId !== scope.threadId)
    return {
      status: "pending" as const,
      askId: elsewhere.askId,
      message: `The recruiter already has a ${server.name} Connect card open in another conversation, waiting for them; no second card was shown.`,
    };
  const mail = key(server.slug ?? "") === "gmail" || key(server.name) === "gmail";
  await pause(
    connectAskBlock({
      serverId,
      name: server.name.slice(0, 80),
      reason: mail ? mailReason(reason, recruiterText) : reason,
    }),
  );
  return undefined;
}
