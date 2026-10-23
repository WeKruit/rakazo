import {
  connectAskBlock,
  findPendingConnectAsk,
  loadConnectServer,
  type PrismaClient,
} from "@rakazo/db";

type ConnectBlock = ReturnType<typeof connectAskBlock>;

/** request_connection: connected → result; otherwise one pending connect card per server and thread. */
export async function requestConnection(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string; botId: string; threadId: string },
  args: Record<string, unknown>,
  pause: (block: ConnectBlock) => Promise<void>,
) {
  const serverId = typeof args.serverId === "string" ? args.serverId.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!serverId || !reason || reason.length > 240)
    return { error: "request_connection needs serverId and a one-sentence reason." };
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
