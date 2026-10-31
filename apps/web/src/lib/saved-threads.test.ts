import type { ThreadSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { SavedThreadStore } from "./saved-threads";
import {
  createSavedThreads,
  SAVED_THREAD_IDLE_MS,
  SAVED_THREADS,
  savedThreadKey,
} from "./saved-threads";

function memoryStore(): SavedThreadStore & { rows: Map<string, unknown> } {
  const rows = new Map<string, { key: string; savedAt: number; snapshot: ThreadSnapshot }>();
  return {
    rows,
    get: async (key) => rows.get(key),
    put: async (row) => {
      rows.set(row.key, structuredClone(row));
    },
    delete: async (key) => {
      rows.delete(key);
    },
    all: async () => [...rows.values()],
    clear: async () => rows.clear(),
  };
}

function thread(botId: string): ThreadSnapshot {
  return {
    threadId: `thread-${botId}`,
    botId,
    cursor: 12,
    olderCursor: null,
    run: null,
    messages: [
      {
        id: "m-1",
        threadId: `thread-${botId}`,
        role: "bot",
        createdAt: "2026-10-31T00:00:00.000Z",
        blocks: [
          {
            kind: "ask",
            text: "API credential",
            input: "secret",
            status: "answered",
            answer: "placeholder-secret",
          },
        ],
      },
    ] as unknown as ThreadSnapshot["messages"],
    computer: { status: "ready" } as unknown as ThreadSnapshot["computer"],
  };
}

describe("saved threads", () => {
  it("keeps each person's conversations apart and drops credentials", async () => {
    let now = 1_000;
    const store = memoryStore();
    const saved = createSavedThreads(store, () => now);
    const mine = savedThreadKey("user-a", "space-a", { botId: "bot-a" });
    await saved.write(mine, thread("bot-a"));

    now += 1;
    const copy = await saved.read(mine);
    expect(copy?.cursor).toBe(12);
    expect(copy).not.toHaveProperty("computer");
    expect(JSON.stringify(copy)).not.toContain("placeholder-secret");
    expect(await saved.read(savedThreadKey("user-b", "space-a", { botId: "bot-a" }))).toBeNull();
    expect(await saved.read(savedThreadKey("user-a", "space-b", { botId: "bot-a" }))).toBeNull();
  });

  it("forgets conversations nobody opened for 30 days and keeps only the newest", async () => {
    let now = 1_000;
    const store = memoryStore();
    const saved = createSavedThreads(store, () => now);
    const old = savedThreadKey("user-a", "space-a", { botId: "old" });
    await saved.write(old, thread("old"));
    now += SAVED_THREAD_IDLE_MS + 1;
    expect(await saved.read(old)).toBeNull();
    expect(store.rows.has(old)).toBe(false);

    for (let index = 0; index <= SAVED_THREADS; index += 1) {
      now += 1;
      await saved.write(
        savedThreadKey("user-a", "space-a", { botId: `bot-${index}` }),
        thread(`bot-${index}`),
      );
    }
    expect(store.rows.size).toBe(SAVED_THREADS);
    expect(await saved.read(savedThreadKey("user-a", "space-a", { botId: "bot-0" }))).toBeNull();

    await saved.clear();
    expect(store.rows.size).toBe(0);
  });

  it("does nothing where the browser has no storage", async () => {
    const saved = createSavedThreads(null);
    await saved.write("key", thread("bot-a"));
    expect(await saved.read("key")).toBeNull();
  });
});
