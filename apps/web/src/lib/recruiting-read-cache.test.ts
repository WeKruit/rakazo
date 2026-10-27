import { expect, it, vi } from "vitest";
import {
  clearRecruitingReads,
  createRecruitingReadCache,
  fetchRecruitingRead,
  rememberRecruitingRead,
  revalidateRecruitingReads,
  savedRecruitingRead,
} from "./recruiting-read-cache";

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
