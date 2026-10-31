import type { Actor, Routine } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export function mapRoutine(row: {
  id: string;
  botId: string;
  threadId?: string | null;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}): Routine {
  return {
    id: row.id,
    botId: row.botId,
    threadId: row.threadId ?? null,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    webhookEnabled: row.webhookEnabled,
    githubEnabled: row.githubEnabled,
    messageProvider: row.messageProvider,
    modelProvider: row.modelProvider ?? null,
    modelId: row.modelId ?? null,
    thinkingLevel: (row.thinkingLevel as Routine["thinkingLevel"]) ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The native routine list and recruiting page share one owned query and DTO. */
export async function listRoutinesDto(
  prisma: Pick<PrismaClient, "routine">,
  actor: Actor,
  input: {
    botId?: string;
    offset?: number;
    threadId?: string;
    allConversations?: boolean;
    cursor?: string;
    limit?: number;
  },
): Promise<Routine[]> {
  const rows = await prisma.routine.findMany({
    take: input.limit ?? 200,
    skip: input.offset ?? 0,
    orderBy: { id: "asc" },
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.allConversations
        ? {
            bot: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
            thread: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              group: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
            },
          }
        : { botId: input.botId }),
    },
  });
  return rows.map(mapRoutine);
}
