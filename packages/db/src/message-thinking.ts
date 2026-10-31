import type { AgentThinking } from "@rakazo/adapter-kit";
import type { PrismaClient } from "./client.js";

/** Replies whose reasoning is replayed; older turns rarely need it and it is large. */
export const REPLAYED_THINKING_MESSAGES = 3;

/** Keeps the reasoning behind a run's final reply; a later save for the same reply replaces it. */
export async function saveRunThinking(
  prisma: Pick<PrismaClient, "message" | "messageThinking">,
  runId: string,
  thinking: AgentThinking,
) {
  const reply = await prisma.message.findFirst({
    where: { runId, role: "bot" },
    orderBy: { seq: "desc" },
    select: { id: true },
  });
  if (!reply) return false;
  const data = {
    provider: thinking.provider,
    model: thinking.model,
    api: thinking.api,
    blocks: thinking.blocks,
  };
  await prisma.messageThinking.upsert({
    where: { messageId: reply.id },
    create: { messageId: reply.id, ...data },
    update: data,
  });
  return true;
}

/** Saved reasoning by message id, for the newest of the given replies. */
export async function loadMessageThinking(
  prisma: Pick<PrismaClient, "messageThinking">,
  messageIds: string[],
): Promise<Map<string, AgentThinking>> {
  const ids = messageIds.slice(-REPLAYED_THINKING_MESSAGES);
  if (!ids.length) return new Map();
  const rows = await prisma.messageThinking.findMany({ where: { messageId: { in: ids } } });
  return new Map(
    rows.map((row) => [
      row.messageId,
      {
        provider: row.provider,
        model: row.model,
        api: row.api,
        blocks: row.blocks as AgentThinking["blocks"],
      },
    ]),
  );
}
