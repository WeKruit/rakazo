import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("memory commits (PostgreSQL)", () => {
  const context: AdapterContext = {
    operationId: "memory-commit-test",
    traceId: "memory-commit-test",
    spaceId: "memory-commit-space",
    userId: "memory-commit-user",
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    store = new MarkdownMemoryStore(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: context.spaceId,
        name: "Memory Test Organization",
        slug: context.spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: context.spaceId,
            name: "Memory Test Space",
            bots: {
              create: {
                id: "memory-commit-bot",
                userId: context.userId,
                name: "Memory Test Bot",
                color: "ink",
              },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: context.spaceId } });
    } finally {
      await close();
    }
  });

  function request(path: string, content: string, expectedRevision = 0): MemoryCommitRequest {
    return {
      scope: "user",
      path,
      content,
      expectedRevision,
      sourceRunId: `run-${content}`,
      sourceThreadId: `thread-${content}`,
    };
  }

  async function document(path: string) {
    return prisma.memoryDocument.findFirstOrThrow({
      where: { spaceId: context.spaceId, path },
      include: { revisions: { orderBy: { revision: "asc" } } },
    });
  }

  it.each([
    ["user", false],
    ["bot", false],
    ["user", true],
    ["bot", true],
  ] as const)(
    "accepts one overlapping %s replacement and preserves history (existing: %s)",
    async (scope, existing) => {
      const path = `concurrent-${scope}-${existing}.md`;
      const write = (content: string, expectedRevision = 0): MemoryCommitRequest => ({
        ...request(path, content, expectedRevision),
        scope,
        botId: scope === "bot" ? "memory-commit-bot" : undefined,
      });
      const initial = existing ? await store.commit(write("initial"), context) : undefined;
      const preparedRevision = initial?.revision ?? 0;
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrentStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryDocument: {
              async findFirst({ args, query }) {
                const result = await query(args);
                reads += 1;
                // Both first attempts see the same target before either can write.
                if (reads === 2) release();
                if (reads <= 2) await bothRead;
                return result;
              },
            },
          },
        }) as PrismaClient,
      );

      const results = await Promise.allSettled([
        concurrentStore.commit(write("first", preparedRevision), context),
        concurrentStore.commit(write("second", preparedRevision), context),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { message: MEMORY_REVISION_CONFLICT_ERROR },
      });
      expect(reads).toBe(3);
      const saved = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(saved.map((result) => result.revision)).toEqual([preparedRevision + 1]);
      const current = await document(path);
      expect(current.revision).toBe(preparedRevision + 1);
      expect(current.content).toBe(saved[0]!.content);
      expect(current.revisions).toHaveLength(preparedRevision + 1);
      for (const result of [...(initial ? [initial] : []), ...saved]) {
        expect(
          current.revisions.find((revision) => revision.revision === result.revision),
        ).toMatchObject({
          documentId: result.id,
          revision: result.revision,
          content: result.content,
          sourceRunId: `run-${result.content}`,
          sourceThreadId: `thread-${result.content}`,
        });
      }
    },
  );

  it.each([false, true])(
    "rolls back a rejected history insert and permits a caller retry (existing: %s)",
    async (existing) => {
      const path = `rejected-${existing}.md`;
      if (existing) await store.commit(request(path, "initial"), context);
      const before = await prisma.memoryDocument.findMany({
        where: { spaceId: context.spaceId, path },
        include: { revisions: true },
      });
      let inserts = 0;
      const rejectingStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryRevision: {
              async create({ args, query }) {
                inserts += 1;
                // Make PostgreSQL reject the history row after the document write.
                return query({
                  ...args,
                  data: {
                    ...args.data,
                    document: undefined,
                    documentId: "missing-memory-document",
                  },
                });
              },
            },
          },
        }) as PrismaClient,
      );

      await expect(
        rejectingStore.commit(request(path, "rejected", existing ? 1 : 0), context),
      ).rejects.toMatchObject({
        code: "P2003",
      });
      expect(inserts).toBe(1);
      expect(
        await prisma.memoryDocument.findMany({
          where: { spaceId: context.spaceId, path },
          include: { revisions: true },
        }),
      ).toEqual(before);

      const retried = await store.commit(request(path, "rejected", existing ? 1 : 0), context);
      expect(retried.revision).toBe(existing ? 2 : 1);
      const current = await document(path);
      expect(current.revisions).toHaveLength(retried.revision);
      expect(current.revisions.at(-1)).toMatchObject({
        revision: retried.revision,
        content: retried.content,
      });
    },
  );

  it("rechecks the prepared revision after a serialization retry without overwriting the winner", async () => {
    const path = "serialization-conflict.md";
    await store.commit(request(path, "initial"), context);
    let attempts = 0;
    const conflictingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryDocument: {
            async findFirst({ args, query }) {
              const result = await query(args);
              attempts += 1;
              if (attempts === 1) await store.commit(request(path, "winner", 1), context);
              return result;
            },
          },
        },
      }) as PrismaClient,
    );

    await expect(conflictingStore.commit(request(path, "rejected", 1), context)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    expect(attempts).toBe(2);
    const current = await document(path);
    expect(current).toMatchObject({ revision: 2, content: "winner" });
    expect(current.revisions.map(({ revision, content }) => ({ revision, content }))).toEqual([
      { revision: 1, content: "initial" },
      { revision: 2, content: "winner" },
    ]);
  });

  it("preserves current content and history when an import targets a stale revision", async () => {
    const path = "stale-import.md";
    await store.commit(request(path, "initial"), context);
    async function* preparedFiles() {
      yield { path, content: new TextEncoder().encode("stale import"), expectedRevision: 1 };
    }
    await store.commit(request(path, "new preference", 1), context);
    await expect(store.importMarkdown(preparedFiles(), context)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    const current = await document(path);
    expect(current).toMatchObject({ content: "new preference", revision: 2 });
    expect(current.revisions).toHaveLength(2);
  });

  it("appends empty-body revocation and retains prior history", async () => {
    const path = "revoked.md";
    await store.commit(request(path, "last preference"), context);
    await store.commit(request(path, "", 1), context);
    const current = await document(path);
    expect(current).toMatchObject({ revision: 2, content: "" });
    expect(current.revisions.map(({ revision, content }) => ({ revision, content }))).toEqual([
      { revision: 1, content: "last preference" },
      { revision: 2, content: "" },
    ]);
  });
});
