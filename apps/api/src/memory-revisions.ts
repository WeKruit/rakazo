import { ORPCError } from "@orpc/server";
import type { MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { Actor, MemoryDocument } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

export type MemoryDocumentDeps = {
  prisma: PrismaClient;
  memory: Pick<MemoryStore, "commit">;
};

/** User documents span this owner's bots; bot documents require the bot's ownership too. */
export function memoryDocumentWhere(actor: Actor): Prisma.MemoryDocumentWhereInput {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    OR: [
      { scope: "user", botId: null },
      { scope: "bot", bot: { is: { spaceId: actor.spaceId, userId: actor.userId } } },
    ],
  };
}

export async function requireMemoryBot(prisma: PrismaClient, actor: Actor, botId?: string) {
  if (!botId) return;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
}

export async function memoryHistory(prisma: PrismaClient, actor: Actor, documentId: string) {
  const document = await prisma.memoryDocument.findFirst({
    where: { id: documentId, ...memoryDocumentWhere(actor) },
    include: { revisions: { orderBy: { revision: "desc" } } },
  });
  if (!document) throw new ORPCError("NOT_FOUND");
  return document.revisions.map((revision) => ({
    id: revision.id,
    documentId: revision.documentId,
    revision: revision.revision,
    content: revision.content,
    sourceRunId: revision.sourceRunId,
    sourceThreadId: revision.sourceThreadId,
    createdAt: revision.createdAt.toISOString(),
  }));
}

export async function updateMemoryDocument(
  deps: MemoryDocumentDeps,
  actor: Actor,
  input: { documentId: string; content: string; expectedRevision: number },
): Promise<MemoryDocument> {
  const where = { id: input.documentId, ...memoryDocumentWhere(actor) };
  const document = await deps.prisma.memoryDocument.findFirst({ where });
  if (!document) throw new ORPCError("NOT_FOUND");
  try {
    const updated = await deps.memory.commit(
      {
        scope: document.scope as "bot" | "user",
        botId: document.botId ?? undefined,
        path: document.path,
        content: input.content,
        expectedRevision: input.expectedRevision,
      },
      {
        operationId: "mem",
        traceId: "mem",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      },
    );
    return {
      ...updated,
      scope: document.scope as "bot" | "user",
      botId: document.botId,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== MEMORY_REVISION_CONFLICT_ERROR) throw error;
    const current = await deps.prisma.memoryDocument.findFirst({
      where,
      select: { revision: true },
    });
    if (!current) throw new ORPCError("NOT_FOUND");
    throw new ORPCError("CONFLICT", {
      message: MEMORY_REVISION_CONFLICT_ERROR,
      data: { currentRevision: current.revision },
    });
  }
}
