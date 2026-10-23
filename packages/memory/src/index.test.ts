import type { AdapterContext } from "@rakazo/adapter-kit";
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
