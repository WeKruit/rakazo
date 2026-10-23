import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });
});

describe("memory actor isolation", () => {
  const table = [
    { id: "a", spaceId: "space-1", userId: "user-a", scope: "user", botId: null, path: "a.md" },
    { id: "b", spaceId: "space-2", userId: "user-b", scope: "user", botId: null, path: "b.md" },
    { id: "c", spaceId: "space-1", userId: "user-c", scope: "user", botId: null, path: "c.md" },
    { id: "ab", spaceId: "space-1", userId: "user-a", scope: "bot", botId: "bot-1", path: "m.md" },
    { id: "cb", spaceId: "space-1", userId: "user-c", scope: "bot", botId: "bot-1", path: "m.md" },
  ].map((row) => ({ ...row, content: `private ${row.id}`, revision: 1, updatedAt: new Date(0) }));
  // Applies the where clause like Postgres would so a missing scope column shows up as a leak.
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    table.filter((row) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
    ),
  );
  const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);
  const actor = (spaceId: string, userId: string): AdapterContext => ({
    ...context,
    spaceId,
    userId,
  });

  it.each([
    ["different spaces", actor("space-1", "user-a"), actor("space-2", "user-b"), "a", "b"],
    ["the same space", actor("space-1", "user-a"), actor("space-1", "user-c"), "a", "c"],
  ])("keeps user documents apart across %s", async (_label, first, second, ownA, ownB) => {
    const seenByA = (await store.read({ scope: "user" }, first)).documents.map((doc) => doc.id);
    const seenByB = (await store.read({ scope: "user" }, second)).documents.map((doc) => doc.id);
    expect(seenByA).toEqual([ownA]);
    expect(seenByB).toEqual([ownB]);
  });

  it("keeps a shared bot's memory per user and never searches without the actor scope", async () => {
    const byA = await store.read({ scope: "bot", botId: "bot-1" }, actor("space-1", "user-a"));
    const byC = await store.read({ scope: "bot", botId: "bot-1" }, actor("space-1", "user-c"));
    expect(byA.documents.map((doc) => doc.id)).toEqual(["ab"]);
    expect(byC.documents.map((doc) => doc.id)).toEqual(["cb"]);
    const hits = await store.search({ scope: "all", query: "private" }, actor("space-1", "user-a"));
    expect(hits.map((hit) => hit.snippet)).toEqual(["private a", "private ab"]);
    for (const call of findMany.mock.calls) {
      expect(call[0].where).toMatchObject({
        spaceId: expect.any(String),
        userId: expect.any(String),
      });
    }
  });
});

describe("memory import CAS", () => {
  it("carries the prepared target revision into the native commit", async () => {
    const store = new MarkdownMemoryStore({} as PrismaClient);
    const commit = vi
      .spyOn(store, "commit")
      .mockResolvedValue({ id: "doc", path: "MEMORY.md", content: "Prepared text", revision: 3 });
    async function* files() {
      yield {
        path: "MEMORY.md",
        content: new TextEncoder().encode("Prepared text"),
        expectedRevision: 2,
      };
    }
    await store.importMarkdown(files(), context);
    expect(commit).toHaveBeenCalledWith(
      { scope: "user", path: "MEMORY.md", content: "Prepared text", expectedRevision: 2 },
      context,
    );
  });

  it("rejects a native commit without its prepared revision before accessing storage", async () => {
    const store = new MarkdownMemoryStore({} as PrismaClient);
    await expect(
      store.commit({ scope: "user", path: "MEMORY.md", content: "Unsafe" } as never, context),
    ).rejects.toThrow("expectedRevision must be a nonnegative integer");
  });
});

describe("memory commit revision check", () => {
  it("rejects a stale expectedRevision before writing", async () => {
    const update = vi.fn();
    const tx = {
      memoryDocument: {
        findFirst: vi.fn().mockResolvedValue({ id: "doc", revision: 3, content: "Current" }),
        update,
      },
    };
    const store = new MarkdownMemoryStore({
      $transaction: (run: (tx: unknown) => Promise<unknown>) => run(tx),
    } as never);
    await expect(
      store.commit(
        { scope: "bot", botId: "bot-1", path: "MEMORY.md", content: "Edited", expectedRevision: 2 },
        context,
      ),
    ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    expect(update).not.toHaveBeenCalled();
  });
});
