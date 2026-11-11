import type { AppBootstrap } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { createSavedShell } from "./saved-shell";
import type { SavedStore } from "./saved-threads";
import { SAVED_THREAD_IDLE_MS } from "./saved-threads";

type Row = Parameters<NonNullable<Parameters<typeof createSavedShell>[0]>["put"]>[0];
function memoryStore(): SavedStore<Row> & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  return {
    rows,
    get: async (key) => rows.get(key),
    put: async (row) => void rows.set(row.key, row),
    delete: async (key) => void rows.delete(key),
    all: async () => [...rows.values()],
    clear: async () => rows.clear(),
  };
}
const bootstrap = (userId: string, spaceId: string) =>
  ({
    me: { userId, spaceId },
    bots: [{ id: "bot" }],
    botSections: [],
    groups: [{ id: "role" }],
    spaces: [{ id: spaceId }],
    archivedBots: [{ id: "old" }],
    thread: { threadId: "t" },
  }) as unknown as AppBootstrap;

it("paints the last sidebar of the same account and Space, without the conversation", async () => {
  const store = memoryStore();
  let now = 1_000;
  const saved = createSavedShell(store, () => now);
  await saved.save(bootstrap("u1", "s1"));
  const shell = await saved.read("u1", null);
  expect(shell?.groups).toEqual([{ id: "role" }]);
  expect(shell).not.toHaveProperty("thread");
  expect(shell).not.toHaveProperty("archivedBots");
  expect(await saved.read("u1", "s1")).toBeDefined();
  expect(await saved.read("u1", "s2")).toBeUndefined();
  expect(await saved.read("u2", null)).toBeUndefined();
  now += SAVED_THREAD_IDLE_MS + 1;
  expect(await saved.read("u1", null)).toBeUndefined();
});

it("forgets every account at sign-out", async () => {
  const store = memoryStore();
  const saved = createSavedShell(store);
  await saved.save(bootstrap("u1", "s1"));
  await saved.clear();
  expect(await saved.read("u1", null)).toBeUndefined();
});
