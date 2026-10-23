import { describe, expect, it, vi } from "vitest";
import { createThreadPrefetch, threadPrefetchKey } from "./thread-prefetch";

describe("thread prefetch", () => {
  it("dedupes reads for one target and hands the read to a single open", async () => {
    let clock = 0;
    const prefetch = createThreadPrefetch<string>(10_000, () => clock);
    const load = vi.fn(async () => "snapshot");
    const key = threadPrefetchKey("user-1", "space-1", { groupId: "group-1" });
    prefetch.prefetch(key, load);
    clock = 500;
    prefetch.prefetch(key, load);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(prefetch.take(key)).resolves.toBe("snapshot");
    expect(prefetch.take(key)).toBeUndefined();
  });

  it("drops reads older than the TTL", () => {
    let clock = 0;
    const prefetch = createThreadPrefetch<string>(10_000, () => clock);
    const load = vi.fn(async () => "snapshot");
    prefetch.prefetch("key", load);
    clock = 10_001;
    expect(prefetch.take("key")).toBeUndefined();
    prefetch.prefetch("key", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed read so the next hover retries", async () => {
    const prefetch = createThreadPrefetch<string>();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("snapshot");
    prefetch.prefetch("key", load);
    await Promise.resolve();
    await Promise.resolve();
    prefetch.prefetch("key", load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(prefetch.take("key")).resolves.toBe("snapshot");
  });

  it("keys reads by user, Space and conversation", () => {
    const keys = new Set([
      threadPrefetchKey("user-1", "space-1", { botId: "x" }),
      threadPrefetchKey("user-2", "space-1", { botId: "x" }),
      threadPrefetchKey("user-1", "space-2", { botId: "x" }),
      threadPrefetchKey("user-1", "space-1", { groupId: "x" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("clears every pending read", () => {
    const prefetch = createThreadPrefetch<string>();
    prefetch.prefetch("key", async () => "snapshot");
    prefetch.clear();
    expect(prefetch.take("key")).toBeUndefined();
  });
});
