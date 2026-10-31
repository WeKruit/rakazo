import type { ThreadSnapshot } from "@rakazo/contracts";

/**
 * Conversations this browser opened recently, kept so a reopen paints at once and then only
 * replays the events it missed. Display data only: the opened thread still validates against
 * the server head and the live stream before it counts as current.
 */
export const SAVED_THREADS = 40;
export const SAVED_THREAD_MAX_BYTES = 1024 * 1024;
/** A conversation nobody opened for this long stops being kept. */
export const SAVED_THREAD_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** A reopen replays at most this many missed events; a larger gap reads the whole thread. */
export const SAVED_THREAD_REPLAY_EVENTS = 200;

type SavedRow = { key: string; savedAt: number; snapshot: ThreadSnapshot };

/** The small key-value surface the cache needs; IndexedDB in the browser, a Map in tests. */
export type SavedThreadStore = {
  get(key: string): Promise<SavedRow | undefined>;
  put(row: SavedRow): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<SavedRow[]>;
  clear(): Promise<void>;
};

export function savedThreadKey(
  userId: string,
  spaceId: string,
  target: { botId?: string; groupId?: string },
): string {
  return JSON.stringify([
    userId,
    spaceId,
    target.groupId ? "group" : "bot",
    target.groupId ?? target.botId,
  ]);
}

/** What is kept: the conversation as shown, without credentials or the computer screen. */
export function savedThreadSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  const { computer: _computer, ...rest } = snapshot;
  return {
    ...rest,
    messages: snapshot.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) => {
        if (block.kind !== "ask" || block.input !== "secret") return block;
        const { credential: _credential, answer: _answer, detail: _detail, ...saved } = block;
        return saved;
      }),
    })),
  };
}

export function createSavedThreads(store: SavedThreadStore | null, now = () => Date.now()) {
  const idle = (row: SavedRow) => now() - row.savedAt > SAVED_THREAD_IDLE_MS;
  return {
    async read(key: string): Promise<ThreadSnapshot | null> {
      if (!store) return null;
      try {
        const row = await store.get(key);
        if (!row || row.key !== key) return null;
        if (idle(row)) {
          await store.delete(key);
          return null;
        }
        return row.snapshot;
      } catch {
        return null;
      }
    },
    async write(key: string, snapshot: ThreadSnapshot): Promise<void> {
      if (!store) return;
      try {
        const row = { key, savedAt: now(), snapshot: savedThreadSnapshot(snapshot) };
        if (new TextEncoder().encode(JSON.stringify(row)).length > SAVED_THREAD_MAX_BYTES) {
          await store.delete(key);
          return;
        }
        await store.put(row);
        const others = (await store.all()).filter((entry) => entry.key !== key);
        const stale = others.filter(idle);
        const kept = others.filter((entry) => !idle(entry)).sort((a, b) => a.savedAt - b.savedAt);
        while (kept.length >= SAVED_THREADS) stale.push(kept.shift()!);
        await Promise.all(stale.map((entry) => store.delete(entry.key)));
      } catch {}
    },
    async clear(): Promise<void> {
      await store?.clear().catch(() => undefined);
    },
  };
}

const DB_NAME = "rakazo-saved-threads";
const STORE = "threads";

function indexedDbStore(): SavedThreadStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: (key) => run("readonly", (store) => store.get(key) as IDBRequest<SavedRow | undefined>),
    put: async (row) => {
      await run("readwrite", (store) => store.put(row));
    },
    delete: async (key) => {
      await run("readwrite", (store) => store.delete(key));
    },
    all: () => run("readonly", (store) => store.getAll() as IDBRequest<SavedRow[]>),
    clear: async () => {
      await run("readwrite", (store) => store.clear());
    },
  };
}

export const savedThreads = createSavedThreads(indexedDbStore());
