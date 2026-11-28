import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "recruiting_checkin.start": vi.fn(async () => undefined),
    "recruiting_agent_run.wait": vi.fn(async () => undefined),
    "recruiting_profile.project": vi.fn(async () => undefined),
    "recruiting_inbox.project": vi.fn(async () => undefined),
    "thread.reply_check": vi.fn(async () => undefined),
    "notification.retry": vi.fn(async () => undefined),
    "poll.close": vi.fn(async () => undefined),
    "discovery.warm": vi.fn(async () => undefined),
    "session.drive": vi.fn(async () => undefined),
    "session.cutover": vi.fn(async () => undefined),
  };
}

describe("InMemoryJobQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("replaces and cancels keyed jobs", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "old" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:1",
    });
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "new" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    expect(target["computer.sleep"]).toHaveBeenCalledWith({ computerId: "new" });

    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "cancelled" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:2",
    });
    await queue.cancel("computer.sleep:2");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it("rejects a keyed enqueue that resumes after close", async () => {
    const queue = new InMemoryJobQueue();
    let releaseCancel: () => void = () => undefined;
    let markCancelling: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      markCancelling = resolve;
    });
    vi.spyOn(queue, "cancel").mockImplementationOnce(async () => {
      markCancelling();
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    });

    const enqueue = queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "computer-1" },
      replaceKey: "computer:computer-1",
    });
    await cancelling;
    await queue.close();
    releaseCancel();

    await expect(enqueue).rejects.toThrow("Background job publisher is closed");
  });

  it("rejects a keyed enqueue that resumes after stop", async () => {
    const queue = new InMemoryJobQueue();
    await queue.start(handlers());
    let releaseCancel: () => void = () => undefined;
    let markCancelling: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      markCancelling = resolve;
    });
    vi.spyOn(queue, "cancel").mockImplementationOnce(async () => {
      markCancelling();
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    });

    const enqueue = queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "computer-1" },
      replaceKey: "computer:computer-1",
    });
    await cancelling;
    await queue.stop();
    releaseCancel();

    await expect(enqueue).rejects.toThrow("Background job publisher is stopped");
  });

  it("drains an accepted immediate timer during close", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);

    await queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } });
    await queue.close();

    expect(target["computer.sleep"]).toHaveBeenCalledOnce();
  });

  it("rejects jobs after stop until the worker restarts", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.stop();

    await expect(
      queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } }),
    ).rejects.toThrow("Background job publisher is stopped");

    await queue.start(target);
    await queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } });
    await queue.close();
    expect(target["computer.sleep"]).toHaveBeenCalledOnce();
  });
});
