import { QueryClient } from "@tanstack/react-query";

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
