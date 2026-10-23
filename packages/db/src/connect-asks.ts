import { type AskConnection, MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

type Db = Pick<Prisma.TransactionClient, "mcpServer" | "botMcpServer" | "message">;

/** The user's MCP server for a connect card, and whether this bot can already use it. */
export async function loadConnectServer(
  db: Db,
  scope: { spaceId: string; userId: string; botId: string },
  serverId: string,
) {
  const server = await db.mcpServer.findFirst({
    where: { id: serverId, spaceId: scope.spaceId, userId: scope.userId, enabled: true },
    select: { id: true, name: true, secretId: true, transport: true },
  });
  if (!server) return null;
  const assignment = await db.botMcpServer.findFirst({
    where: {
      botId: scope.botId,
      serverId: server.id,
      spaceId: scope.spaceId,
      userId: scope.userId,
    },
    select: { id: true },
  });
  // ponytail: a stored credential counts as connected; an expired OAuth token surfaces on the next call.
  const credential = Boolean(server.secretId) || server.transport === "stdio";
  const assigned = Boolean(assignment);
  return {
    id: server.id,
    name: server.name,
    credential,
    assigned,
    connected: credential && assigned,
  };
}

/** An unanswered connect card for this server in the thread, so a retry reuses it. */
export async function findPendingConnectAsk(
  db: Pick<Prisma.TransactionClient, "message" | "run">,
  input: { threadId: string; serverId: string },
) {
  const messages = await db.message.findMany({
    where: {
      threadId: input.threadId,
      role: "bot",
      blocks: { array_contains: [{ kind: "ask", connection: { serverId: input.serverId } }] },
    },
    orderBy: { seq: "desc" },
    take: 5,
    select: { id: true, runId: true, blocks: true },
  });
  const waiting = new Set(
    (
      await db.run.findMany({
        where: {
          id: { in: messages.flatMap((message) => (message.runId ? [message.runId] : [])) },
          threadId: input.threadId,
          status: "waiting_input",
        },
        select: { id: true },
      })
    ).map((run) => run.id),
  );
  for (const message of messages) {
    if (!message.runId || !waiting.has(message.runId)) continue;
    const blocks = MessageBlockSchema.array().safeParse(message.blocks);
    if (
      blocks.success &&
      blocks.data.some(
        (block) =>
          block.kind === "ask" &&
          block.status !== "answered" &&
          block.connection?.serverId === input.serverId,
      )
    )
      return { askId: message.id, runId: message.runId };
  }
  return null;
}

export function connectAskBlock(connection: AskConnection) {
  return {
    kind: "ask" as const,
    text: `Connect ${connection.name}`,
    status: "pending" as const,
    connection,
  };
}
