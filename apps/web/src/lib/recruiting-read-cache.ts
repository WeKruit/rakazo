import type { RecruitingSequenceOutput } from "@rakazo/contracts";
import type { DehydratedState } from "@tanstack/react-query";
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query";
import type { SavedStore } from "./saved-threads";
import { indexedDbStore, SAVED_THREAD_IDLE_MS } from "./saved-threads";

/** Owned by one authenticated Shell. Display data never authorizes an action. */
export type RecruitingReadCache = { client: QueryClient; epoch: number };

export function createRecruitingReadCache(): RecruitingReadCache {
  return {
    client: new QueryClient({
      defaultOptions: {
        queries: { staleTime: 0, gcTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false },
      },
    }),
    epoch: 0,
  };
}

export function savedRecruitingRead(cache: RecruitingReadCache | undefined, key: string) {
  return cache?.client.getQueryData(["recruiting", key, "display"]);
}

export function rememberRecruitingRead(
  cache: RecruitingReadCache | undefined,
  key: string | undefined,
  value: unknown,
  epoch = cache?.epoch,
) {
  if (!cache || !key || epoch !== cache.epoch) return;
  cache.client.setQueryData(["recruiting", key, "display"], value);
}

const matchesScope = (key: readonly unknown[], scope?: string) =>
  key[0] === "recruiting" &&
  (!scope || (typeof key[1] === "string" && key[1].startsWith(`${scope}:`)));

export function clearRecruitingReads(cache: RecruitingReadCache | undefined, scope?: string) {
  if (!cache) return;
  cache.epoch++;
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => matchesScope(query.queryKey, scope),
  };
  void cache.client.cancelQueries(filters);
  cache.client.removeQueries(filters);
}

/** Keep display rows during a scoped refresh; old responses cannot repopulate them. */
export function revalidateRecruitingReads(cache: RecruitingReadCache | undefined, scope?: string) {
  if (!cache) return;
  cache.epoch++;
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => matchesScope(query.queryKey, scope),
  };
  void cache.client.cancelQueries(filters);
  void cache.client.invalidateQueries({ ...filters, refetchType: "none" });
}

/** Share display reads for 30 seconds or until realtime invalidation. Action-time validation must call the RPC directly. */
export function fetchRecruitingRead<T>(
  cache: RecruitingReadCache | undefined,
  scope: string | undefined,
  method: string,
  input: unknown,
  load: () => Promise<T>,
): Promise<T> {
  if (!cache || !scope) return load();
  return cache.client.fetchQuery({
    queryKey: ["recruiting", `${scope}:rpc`, method, input],
    queryFn: load,
    staleTime: 30_000,
  });
}

/** A slow earlier provider read must not replace a newer verified pause/save. Display only. */
export function rememberRecruitingSequenceRead(
  cache: RecruitingReadCache | undefined,
  key: string,
  value: RecruitingSequenceOutput,
  epoch = cache?.epoch,
) {
  if (value.sourceRevision === undefined || !value.observedAt) return;
  const previous = savedRecruitingRead(cache, key) as RecruitingSequenceOutput | undefined;
  if (
    previous?.sourceRevision !== undefined &&
    value.sourceRevision !== undefined &&
    (previous.sourceRevision > value.sourceRevision ||
      (previous.sourceRevision === value.sourceRevision &&
        previous.observedAt &&
        (!value.observedAt || Date.parse(previous.observedAt) > Date.parse(value.observedAt))))
  )
    return;
  rememberRecruitingRead(cache, key, value, epoch);
}

export type SavedReadsRow = { key: string; savedAt: number; state: DehydratedState };
/** A Space's saved display reads larger than this are not kept. */
export const SAVED_READS_MAX_BYTES = 2 * 1024 * 1024;
const isDisplayKey = (key: readonly unknown[]) => key[0] === "recruiting" && key[2] === "display";
const savedReadsStore = indexedDbStore<SavedReadsRow>("rakazo-saved-reads", "reads");

/** Read once as the app starts, so a reload can paint before the panels mount. */
let startupRows: SavedReadsRow[] | undefined;
void savedReadsStore
  ?.all()
  .then((rows) => {
    startupRows = rows;
  })
  .catch(() => undefined);

function restore(
  cache: RecruitingReadCache,
  scope: string,
  row: SavedReadsRow | undefined,
  now: number,
) {
  if (row?.key !== scope || now - row.savedAt > SAVED_THREAD_IDLE_MS) return;
  // A read this page already answered wins over the saved copy.
  hydrate(cache.client, {
    mutations: [],
    queries: row.state.queries.filter(
      (query) =>
        isDisplayKey(query.queryKey) && cache.client.getQueryData(query.queryKey) === undefined,
    ),
  });
}

/**
 * Paints the saved display reads of one account and Space into the cache now, before the panels
 * that read them once on mount render. Does nothing until the startup read has finished.
 */
export function restoreSavedRecruitingReads(
  cache: RecruitingReadCache,
  scope: string,
  rows = startupRows,
  now = Date.now(),
) {
  restore(
    cache,
    scope,
    rows?.find((row) => row.key === scope),
    now,
  );
}

/**
 * Keeps one account and Space's display reads in this browser, so a reload paints the last rows at
 * once while every read still refreshes from the server. Display only, like saved conversations.
 */
export function keepRecruitingReads(
  cache: RecruitingReadCache,
  scope: string,
  store: SavedStore<SavedReadsRow> | null = savedReadsStore,
  options: { now?: () => number; delayMs?: number } = {},
): () => void {
  const now = options.now ?? Date.now;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const epoch = cache.epoch;
  // A startup read that finished late still fills panels opened after it.
  void store
    ?.get(scope)
    .then((row) => {
      if (!stopped && cache.epoch === epoch) restore(cache, scope, row, now());
    })
    .catch(() => undefined);
  const save = () => {
    timer = undefined;
    if (stopped || !store) return;
    const row: SavedReadsRow = {
      key: scope,
      savedAt: now(),
      state: dehydrate(cache.client, {
        shouldDehydrateQuery: (query) =>
          isDisplayKey(query.queryKey) && query.state.data !== undefined,
      }),
    };
    const fits = new TextEncoder().encode(JSON.stringify(row)).length <= SAVED_READS_MAX_BYTES;
    void (fits ? store.put(row) : store.delete(scope)).catch(() => undefined);
  };
  const unsubscribe = cache.client.getQueryCache().subscribe((event) => {
    if (stopped || !isDisplayKey(event.query.queryKey)) return;
    if (event.type === "removed" || (event.type === "updated" && event.action.type === "success"))
      timer ??= setTimeout(save, options.delayMs ?? 1_000);
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

/** Sign-out forgets every account's saved display reads in this browser. */
export function forgetSavedRecruitingReads(): Promise<void> {
  startupRows = undefined;
  return savedReadsStore?.clear().catch(() => undefined) ?? Promise.resolve();
}
