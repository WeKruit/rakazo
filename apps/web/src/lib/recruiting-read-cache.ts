/** Ephemeral display data owned by one authenticated Shell; never an authority for actions. */
export type RecruitingReadCache = { entries: Map<string, unknown>; epoch: number };

export function rememberRecruitingRead(
  cache: RecruitingReadCache | undefined,
  key: string | undefined,
  value: unknown,
  epoch = cache?.epoch,
) {
  if (!cache || !key || epoch !== cache.epoch) return;
  cache.entries.delete(key);
  cache.entries.set(key, value);
  // ponytail: the native Shell uses the same 20-entry ceiling; revisit only after measured eviction.
  if (cache.entries.size > 20) cache.entries.delete(cache.entries.keys().next().value!);
}

export function clearRecruitingReads(cache: RecruitingReadCache | undefined, scope?: string) {
  if (!cache) return;
  cache.epoch++;
  if (!scope) cache.entries.clear();
  else
    for (const key of cache.entries.keys())
      if (key.startsWith(`${scope}:`)) cache.entries.delete(key);
}
