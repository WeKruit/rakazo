/** A read started on hover or focus stays usable this long; the stream replays from its cursor. */
export const THREAD_PREFETCH_TTL_MS = 10_000;
const THREAD_PREFETCH_LIMIT = 20;

/**
 * Deduped, short-lived conversation reads owned by one authenticated Shell.
 * Display data only: the opened thread still validates, subscribes and reconciles as usual.
 */
export type ThreadPrefetch<T> = {
  prefetch: (key: string, load: () => Promise<T>) => void;
  /** Hands a fresh read to the opening conversation once; later opens read again. */
  take: (key: string) => Promise<T> | undefined;
  clear: () => void;
};

export function threadPrefetchKey(
  userId: string,
  spaceId: string,
  target: { botId?: string; groupId?: string },
) {
  return JSON.stringify([
    userId,
    spaceId,
    target.groupId ? "group" : "bot",
    target.groupId ?? target.botId,
  ]);
}

export function createThreadPrefetch<T>(
  ttlMs = THREAD_PREFETCH_TTL_MS,
  now: () => number = Date.now,
): ThreadPrefetch<T> {
  const entries = new Map<string, { startedAt: number; read: Promise<T> }>();
  const fresh = (key: string) => {
    const entry = entries.get(key);
    if (entry && now() - entry.startedAt > ttlMs) entries.delete(key);
    return entries.get(key);
  };
  return {
    prefetch(key, load) {
      if (fresh(key)) return;
      const entry = { startedAt: now(), read: load() };
      entries.set(key, entry);
      entry.read.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      if (entries.size > THREAD_PREFETCH_LIMIT) entries.delete(entries.keys().next().value!);
    },
    take(key) {
      const entry = fresh(key);
      entries.delete(key);
      return entry?.read;
    },
    clear() {
      entries.clear();
    },
  };
}
