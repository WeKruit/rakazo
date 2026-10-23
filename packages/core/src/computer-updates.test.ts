import type { ComputerUpdate } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputerUpdates } from "./computer-updates.js";

const update: ComputerUpdate = {
  id: "update-1",
  botId: "bot-1",
  name: "Writer",
  mode: "team",
  action: "update",
  status: "running",
  stage: "saving",
};
afterEach(() => vi.useRealTimers());
describe("computer update presentation", () => {
  it.each(["failed", "interrupted"] as const)(
    "keeps a %s card visible without polling it as running work",
    async (status) => {
      vi.useFakeTimers();
      const terminal = { ...update, status };
      const list = vi.fn(async () => [terminal]);
      const store = createComputerUpdates({
        list,
        start: async () => update,
        dismiss: async () => {},
        releaseInterrupted: async () => {},
      });
      const stop = store.watch();
      await vi.advanceTimersByTimeAsync(0);
      store.open(terminal.id);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(list).toHaveBeenCalledOnce();
      expect(store.getSnapshot()).toEqual({ updates: [terminal], openId: terminal.id });
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledTimes(2);
      stop();
    },
  );

  it("pauses hidden polling without losing the open card or duplicating an issued read", async () => {
    vi.useFakeTimers();
    let setActive!: (active: boolean) => void;
    let finish!: (rows: ComputerUpdate[]) => void;
    const unsubscribe = vi.fn();
    const list = vi.fn(async () => [update]);
    const store = createComputerUpdates(
      {
        list,
        start: async () => update,
        dismiss: async () => {},
        releaseInterrupted: async () => {},
      },
      (listener) => {
        setActive = listener;
        listener(false);
        return unsubscribe;
      },
    );
    const stop = store.watch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).not.toHaveBeenCalled();
    setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledOnce();
    store.open(update.id);
    setActive(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    setActive(false);
    setActive(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(list).toHaveBeenCalledTimes(2);
    setActive(false);
    finish([{ ...update, stage: "restoring" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: update.id,
    });
    setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    setActive(true);
    finish([update]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot()).toEqual({ updates: [], openId: null });
  });

  it("keeps routine checkpointing quiet and exposes its existing interrupted recovery", async () => {
    const checkpoint = { ...update, action: "checkpoint" as const };
    let rows: ComputerUpdate[] = [checkpoint];
    const store = createComputerUpdates({
      list: async () => rows,
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    vi.useFakeTimers();
    const stop = store.watch();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([]);
    rows = [{ ...checkpoint, status: "interrupted", canReleaseReservation: true }];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getSnapshot().updates).toEqual(rows);
    stop();
  });
  it("keeps a newly started update when an older poll returns, and closing does not stop polling", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: ComputerUpdate[]) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          resolve = done;
        }),
    );
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    const stop = store.watch();
    await store.start("bot-1");
    resolve([]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    store.open(null);
    await vi.advanceTimersByTimeAsync(1500);
    resolve([{ ...update, stage: "restoring" }]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: null,
    });
    stop();
  });
  it("restores background progress on a new mount and ignores responses after disposal", async () => {
    vi.useFakeTimers();
    const store = createComputerUpdates({
      list: async () => [update],
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    let stop = store.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().updates).toEqual([update]);
    stop();
    stop = store.watch();
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().updates).toEqual([]);
  });
});
