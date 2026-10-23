import { describe, expect, it, vi } from "vitest";
import { installPreloadRecovery } from "./preload-recovery";

describe("preload recovery", () => {
  function createTarget(store = new Map<string, string>(), onLine = true, isWorking = () => false) {
    const timers: (() => void)[] = [];
    let listener: EventListener | undefined;
    const reload = vi.fn();
    const target = {
      addEventListener: (_type: string, next: EventListener) => {
        listener = next;
      },
      clearTimeout: vi.fn(),
      removeEventListener: vi.fn(),
      location: { reload },
      navigator: { onLine },
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
      setTimeout: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length;
      }),
    };
    const dispose = installPreloadRecovery(target as unknown as Window, isWorking);
    return { listener: () => listener, reload, timers, dispose, target };
  }

  it("reloads once without suppressing another failure during navigation", () => {
    const { listener, reload } = createTarget();
    const first = new Event("vite:preloadError", { cancelable: true });
    const second = new Event("vite:preloadError", { cancelable: true });
    listener()?.(first);
    listener()?.(second);

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for native work to finish before reloading missing assets", () => {
    let working = true;
    const { listener, reload, timers } = createTarget(new Map(), true, () => working);
    const failure = new Event("vite:preloadError", { cancelable: true });
    listener()?.(failure);
    expect(failure.defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    timers[1]!();
    expect(reload).not.toHaveBeenCalled();
    working = false;
    timers[2]!();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("cancels deferred recovery when disposed", () => {
    const { listener, dispose, target } = createTarget(new Map(), true, () => true);
    listener()?.(new Event("vite:preloadError", { cancelable: true }));
    dispose();
    expect(target.clearTimeout).toHaveBeenCalledWith(2);
  });

  it("does not suppress a new failure after the recovery reload", () => {
    const store = new Map([["rk:preload-recovery", "1"]]);
    const { listener, reload } = createTarget(store);
    const nextPageFailure = new Event("vite:preloadError", { cancelable: true });

    listener()?.(nextPageFailure);

    expect(nextPageFailure.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves an offline failure to the error boundary instead of reloading", () => {
    const { listener, reload } = createTarget(new Map(), false);
    const offlineFailure = new Event("vite:preloadError", { cancelable: true });

    listener()?.(offlineFailure);

    expect(offlineFailure.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
