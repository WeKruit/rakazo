import { createRouterClient } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryDocumentDeps } from "./memory-revisions.js";
import { memoryHistory, updateMemoryDocument } from "./memory-revisions.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "memory-space",
  userId: "memory-owner",
  email: "memory@rakazo.test",
  isDeploymentOwner: false,
};

function fixture() {
  const document = {
    id: "memory-document",
    spaceId: actor.spaceId,
    userId: actor.userId,
    scope: "user",
    botId: null,
    path: "preferences.md",
    content: "new preference",
    revision: 2,
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    revisions: [
      {
        id: "revision-2",
        documentId: "memory-document",
        revision: 2,
        content: "new preference",
        sourceRunId: "run-2",
        sourceThreadId: "thread-2",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "revision-1",
        documentId: "memory-document",
        revision: 1,
        content: "old preference",
        sourceRunId: null,
        sourceThreadId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
  };
  const findFirst = vi.fn().mockResolvedValue(document);
  const commit = vi.fn().mockResolvedValue({
    id: document.id,
    path: document.path,
    content: "",
    revision: 3,
  });
  const deps: MemoryDocumentDeps = {
    prisma: { memoryDocument: { findFirst } } as unknown as PrismaClient,
    memory: { commit },
  };
  return { deps, document, findFirst, commit };
}

describe("native memory revisions", () => {
  it("carries the editor's loaded revision through a blank-body revocation", async () => {
    const { deps, commit } = fixture();
    const result = await updateMemoryDocument(deps, actor, {
      documentId: "memory-document",
      expectedRevision: 2,
      content: "",
    });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2, content: "", scope: "user" }),
      expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
    );
    expect(result).toMatchObject({ content: "", revision: 3 });
  });

  it("returns a conflict with the current revision instead of retrying stale text", async () => {
    const { deps, commit } = fixture();
    commit.mockRejectedValue(new Error(MEMORY_REVISION_CONFLICT_ERROR));
    await expect(
      updateMemoryDocument(deps, actor, {
        documentId: "memory-document",
        expectedRevision: 1,
        content: "stale replacement",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { currentRevision: 2 } });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("reads immutable native history with source references in revision order", async () => {
    const { deps, findFirst } = fixture();
    const history = await memoryHistory(deps.prisma, actor, "memory-document");
    expect(history.map((item) => item.revision)).toEqual([2, 1]);
    expect(history[0]).toMatchObject({
      sourceRunId: "run-2",
      sourceThreadId: "thread-2",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "memory-document",
        spaceId: actor.spaceId,
        userId: actor.userId,
        OR: [
          { scope: "user", botId: null },
          {
            scope: "bot",
            bot: { is: { spaceId: actor.spaceId, userId: actor.userId } },
          },
        ],
      }),
      include: { revisions: { orderBy: { revision: "desc" } } },
    });
  });

  it("rejects history and update outside the actor/bot boundary without leaking content", async () => {
    const { deps, findFirst, commit } = fixture();
    findFirst.mockResolvedValue(null);
    await expect(memoryHistory(deps.prisma, actor, "foreign-document")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      updateMemoryDocument(deps, actor, {
        documentId: "foreign-document",
        content: "replacement",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("wires authenticated history and CAS through the existing RPC router", async () => {
    const { deps, commit } = fixture();
    const client = createRouterClient(createRouter(deps as RouterDeps), { context: { actor } });
    const history = await client.memory.history({ documentId: "memory-document" });
    expect(history).toHaveLength(2);
    await client.memory.update({ documentId: "memory-document", content: "", expectedRevision: 2 });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2 }),
      expect.anything(),
    );
    const unauthenticated = createRouterClient(createRouter(deps as RouterDeps), { context: {} });
    await expect(
      unauthenticated.memory.history({ documentId: "memory-document" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a missing loaded revision at the RPC boundary", async () => {
    const { deps, commit } = fixture();
    const client = createRouterClient(createRouter(deps as RouterDeps), { context: { actor } });
    await expect(
      client.memory.update({
        documentId: "memory-document",
        content: "unsafe replacement",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(commit).not.toHaveBeenCalled();
  });
});

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("native memory API ownership and revocation (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const owner = { ...actor, spaceId: `memory-api-space-${suffix}`, userId: `owner-${suffix}` };
  const otherUser = { ...owner, userId: `other-${suffix}` };
  const otherSpace = { ...owner, spaceId: `foreign-space-${suffix}` };
  let db: ReturnType<typeof createDb>;
  let deps: MemoryDocumentDeps;
  let documentId: string;
  let botId: string;
  const context = (identity: Actor): AdapterContext => ({
    spaceId: identity.spaceId,
    userId: identity.userId,
    operationId: "memory-api-test",
    traceId: "memory-api-test",
    signal: new AbortController().signal,
  });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    for (const space of [owner, otherSpace]) {
      await db.prisma.organization.create({
        data: {
          id: space.spaceId,
          name: "Memory API Test",
          slug: space.spaceId,
          createdAt: new Date(),
          spaces: { create: { id: space.spaceId, name: "Test space" } },
        },
      });
    }
    botId = `memory-api-bot-${suffix}`;
    await db.prisma.bot.create({
      data: { id: botId, userId: owner.userId, spaceId: owner.spaceId, name: "Main", color: "ink" },
    });
    deps = { prisma: db.prisma, memory: new MarkdownMemoryStore(db.prisma) };
    const saved = await deps.memory.commit(
      {
        scope: "user",
        path: "preferences.md",
        content: "Prefer cited professional evidence.",
        expectedRevision: 0,
        sourceRunId: "source-run",
        sourceThreadId: "source-thread",
      },
      context(owner),
    );
    documentId = saved.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({
        where: { id: { in: [owner.spaceId, otherSpace.spaceId] } },
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("revokes without deleting history and rejects a stale replacement", async () => {
    await updateMemoryDocument(deps, owner, { documentId, content: "", expectedRevision: 1 });
    await expect(
      updateMemoryDocument(deps, owner, {
        documentId,
        content: "stale text",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { currentRevision: 2 } });
    expect(await memoryHistory(db.prisma, owner, documentId)).toMatchObject([
      { revision: 2, content: "" },
      {
        revision: 1,
        content: "Prefer cited professional evidence.",
        sourceRunId: "source-run",
        sourceThreadId: "source-thread",
      },
    ]);
    expect(
      (await db.prisma.memoryDocument.findUniqueOrThrow({ where: { id: documentId } })).content,
    ).toBe("");
  });

  it.each([otherUser, otherSpace])(
    "rejects another actor/space for history and writes ($userId / $spaceId)",
    async (identity) => {
      await expect(memoryHistory(db.prisma, identity, documentId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        updateMemoryDocument(deps, identity, {
          documentId,
          content: "foreign",
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
  );

  it("validates bot ownership even when the document's owner scalar claims the caller", async () => {
    const malformed = await db.prisma.memoryDocument.create({
      data: {
        spaceId: owner.spaceId,
        userId: otherUser.userId,
        botId,
        scope: "bot",
        path: "foreign-bot.md",
        content: "Must remain private to the bot owner.",
      },
    });
    await expect(memoryHistory(db.prisma, otherUser, malformed.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const client = createRouterClient(createRouter(deps as RouterDeps), {
      context: { actor: otherUser },
    });
    expect(await client.memory.list({})).toEqual([]);
    await expect(client.memory.list({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.memory.exportMarkdown({ botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lets one owner's user memory span their bots without sharing it with another user", async () => {
    const client = createRouterClient(createRouter(deps as RouterDeps), {
      context: { actor: owner },
    });
    expect(await client.memory.list({ scope: "user" })).toMatchObject([
      { id: documentId, revision: 2 },
    ]);
    expect(await client.memory.history({ documentId })).toHaveLength(2);
  });
});
