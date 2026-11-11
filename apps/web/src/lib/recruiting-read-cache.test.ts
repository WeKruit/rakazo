import { expect, it, vi } from "vitest";
import type { SavedReadsRow } from "./recruiting-read-cache";
import {
  clearRecruitingReads,
  createRecruitingReadCache,
  fetchRecruitingRead,
  keepRecruitingReads,
  rememberRecruitingRead,
  restoreSavedRecruitingReads,
  revalidateRecruitingReads,
  savedRecruitingRead,
} from "./recruiting-read-cache";
import type { SavedStore } from "./saved-threads";
import { SAVED_THREAD_IDLE_MS } from "./saved-threads";

function memoryStore() {
  const rows = new Map<string, SavedReadsRow>();
  const store: SavedStore<SavedReadsRow> = {
    get: async (key) => rows.get(key),
    put: async (row) => void rows.set(row.key, row),
    delete: async (key) => void rows.delete(key),
    all: async () => [...rows.values()],
    clear: async () => rows.clear(),
  };
  return { rows, store };
}

it("paints a reloaded page from the last display reads, then lets fresh reads win", async () => {
  const { rows, store } = memoryStore();
  const first = createRecruitingReadCache();
  const stop = keepRecruitingReads(first, "user:space", store, { delayMs: 0 });
  rememberRecruitingRead(first, "user:space:thread:tab:candidates", ["Ada", "Lin"]);
  await vi.waitFor(() => expect(rows.size).toBe(1));
  stop();

  // A reload: a new cache in the same account and Space.
  const reloaded = createRecruitingReadCache();
  rememberRecruitingRead(reloaded, "user:space:thread:tab:home", { fresh: true });
  keepRecruitingReads(reloaded, "user:space", store, { delayMs: 0 });
  await vi.waitFor(() =>
    expect(savedRecruitingRead(reloaded, "user:space:thread:tab:candidates")).toEqual([
      "Ada",
      "Lin",
    ]),
  );
  expect(savedRecruitingRead(reloaded, "user:space:thread:tab:home")).toEqual({ fresh: true });

  // Another account or Space never reads them, and a cleared cache ignores a late answer.
  const other = createRecruitingReadCache();
  keepRecruitingReads(other, "other:space", store, { delayMs: 0 });
  const cleared = createRecruitingReadCache();
  keepRecruitingReads(cleared, "user:space", store, { delayMs: 0 });
  clearRecruitingReads(cleared);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(savedRecruitingRead(other, "user:space:thread:tab:candidates")).toBeUndefined();
  expect(savedRecruitingRead(cleared, "user:space:thread:tab:candidates")).toBeUndefined();
});

it("does not paint reads saved longer ago than a saved conversation is kept", async () => {
  const { rows, store } = memoryStore();
  let now = 1_000;
  const first = createRecruitingReadCache();
  keepRecruitingReads(first, "user:space", store, { delayMs: 0, now: () => now });
  rememberRecruitingRead(first, "user:space:thread:tab:candidates", ["Ada"]);
  await vi.waitFor(() => expect(rows.size).toBe(1));
  now += SAVED_THREAD_IDLE_MS + 1;
  const reloaded = createRecruitingReadCache();
  keepRecruitingReads(reloaded, "user:space", store, { delayMs: 0, now: () => now });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(savedRecruitingRead(reloaded, "user:space:thread:tab:candidates")).toBeUndefined();
});

it("removes only the denied scope and rejects late legacy display writes", () => {
  const cache = createRecruitingReadCache();
  rememberRecruitingRead(cache, "actor:space:other:rows", ["other"]);
  rememberRecruitingRead(cache, "actor:space:role:rows", ["saved"]);
  const before = cache.epoch;
  clearRecruitingReads(cache, "actor:space:role");
  rememberRecruitingRead(cache, "actor:space:role:rows", ["late"], before);
  expect(savedRecruitingRead(cache, "actor:space:role:rows")).toBeUndefined();
  expect(savedRecruitingRead(cache, "actor:space:other:rows")).toEqual(["other"]);
  clearRecruitingReads(cache);
  expect(cache.client.getQueryCache().getAll()).toHaveLength(0);
});

it("shares same-scope RPC inputs but neither different parameters nor accounts", async () => {
  const cache = createRecruitingReadCache();
  let finish!: (value: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const first = fetchRecruitingRead(
    cache,
    "actor:space:role",
    "getWorkspace",
    { threadId: "thread" },
    load,
  );
  const second = fetchRecruitingRead(
    cache,
    "actor:space:role",
    "getWorkspace",
    { threadId: "thread" },
    load,
  );
  expect(load).toHaveBeenCalledTimes(1);
  finish("rows");
  expect(await Promise.all([first, second])).toEqual(["rows", "rows"]);
  const other = vi.fn(async () => "different");
  await fetchRecruitingRead(
    cache,
    "actor:space:other",
    "getWorkspace",
    { threadId: "other" },
    other,
  );
  await fetchRecruitingRead(
    cache,
    "other:space:role",
    "getWorkspace",
    { threadId: "thread" },
    other,
  );
  expect(other).toHaveBeenCalledTimes(2);
  clearRecruitingReads(cache);
});

it("scopes realtime invalidation and keeps existing display data", () => {
  const cache = createRecruitingReadCache();
  rememberRecruitingRead(cache, "actor:space:role:rows", ["saved"]);
  rememberRecruitingRead(cache, "actor:space:other:rows", ["other"]);
  revalidateRecruitingReads(cache, "actor:space:role");
  expect(savedRecruitingRead(cache, "actor:space:role:rows")).toEqual(["saved"]);
  expect(
    cache.client.getQueryState(["recruiting", "actor:space:role:rows", "display"])?.isInvalidated,
  ).toBe(true);
  expect(
    cache.client.getQueryState(["recruiting", "actor:space:other:rows", "display"])?.isInvalidated,
  ).toBe(false);
  clearRecruitingReads(cache);
});

it("clears a previous account's in-flight read without accepting its late data", async () => {
  const cache = createRecruitingReadCache();
  let finish!: (value: string) => void;
  const pending = fetchRecruitingRead(
    cache,
    "old:space:role",
    "getWorkspace",
    { threadId: "thread" },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const settled = pending.catch(() => "cancelled");
  clearRecruitingReads(cache);
  finish("old private rows");
  expect(await settled).toBe("cancelled");
  expect(cache.client.getQueryCache().getAll()).toHaveLength(0);
  expect(
    await fetchRecruitingRead(
      cache,
      "new:space:role",
      "getWorkspace",
      { threadId: "thread" },
      async () => "new rows",
    ),
  ).toBe("new rows");
  expect(
    cache.client.getQueryData([
      "recruiting",
      "old:space:role:rpc",
      "getWorkspace",
      { threadId: "thread" },
    ]),
  ).toBeUndefined();
  clearRecruitingReads(cache);
});

it("garbage collects inactive display data after five minutes", async () => {
  vi.useFakeTimers();
  try {
    const cache = createRecruitingReadCache();
    rememberRecruitingRead(cache, "actor:space:role:rows", ["saved"]);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(savedRecruitingRead(cache, "actor:space:role:rows")).toEqual(["saved"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.client.getQueryCache().getAll()).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not let a slow earlier provider response overwrite a verified pause in the same epoch", async () => {
  const { rememberRecruitingSequenceRead } = await import("./recruiting-read-cache");
  const cache = createRecruitingReadCache();
  const key = '["owner","space","thread"]:sequence-observation:["role","server","campaign"]';
  const earlier = {
    roleId: "role",
    roleTitle: "Engineer",
    mailboxes: [],
    sourceRevision: 1,
    observedAt: "2030-01-01T00:00:00.000Z",
    campaign: {
      id: "campaign",
      name: "Original",
      status: 1,
      editable: false,
      eaccount: null,
      steps: [],
      timezone: null,
      send_hours: null,
    },
  } as const;
  let release!: (value: typeof earlier) => void;
  const pending = new Promise<typeof earlier>((resolve) => {
    release = resolve;
  });
  const write = pending.then((value) =>
    rememberRecruitingSequenceRead(cache, key, {
      ...value,
      mailboxes: [],
      campaign: { ...value.campaign, steps: [] },
    }),
  );
  rememberRecruitingSequenceRead(cache, key, {
    ...earlier,
    mailboxes: [],
    observedAt: "2031-01-01T00:00:00.000Z",
    campaign: { ...earlier.campaign, name: "Verified pause", status: 2, steps: [] },
  });
  release(earlier);
  await write;
  expect(savedRecruitingRead(cache, key)).toMatchObject({
    observedAt: "2031-01-01T00:00:00.000Z",
    campaign: { name: "Verified pause", status: 2 },
  });
  rememberRecruitingSequenceRead(cache, key, {
    ...earlier,
    mailboxes: [],
    sourceRevision: 0,
    observedAt: "2032-01-01T00:00:00.000Z",
    campaign: { ...earlier.campaign, steps: [] },
  });
  expect(savedRecruitingRead(cache, key)).toMatchObject({
    sourceRevision: 1,
    campaign: { status: 2 },
  });
  cache.client.clear();
});

it("restores saved rows synchronously, so a panel that reads once on mount sees them", async () => {
  const { rows, store } = memoryStore();
  const first = createRecruitingReadCache();
  keepRecruitingReads(first, "user:space", store, { delayMs: 0 });
  rememberRecruitingRead(first, "user:space:thread:workspace", { role: "Engineer" });
  await vi.waitFor(() => expect(rows.size).toBe(1));
  const reloaded = createRecruitingReadCache();
  restoreSavedRecruitingReads(reloaded, "user:space", [...rows.values()]);
  expect(savedRecruitingRead(reloaded, "user:space:thread:workspace")).toEqual({
    role: "Engineer",
  });
  const other = createRecruitingReadCache();
  restoreSavedRecruitingReads(other, "other:space", [...rows.values()]);
  expect(savedRecruitingRead(other, "user:space:thread:workspace")).toBeUndefined();
});
