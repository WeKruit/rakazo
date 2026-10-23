import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { CommandExitError } from "@e2b/desktop";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_WORK_LAUNCH,
  BACKGROUND_WORK_PROBE,
  CANCEL_COMPUTER_RUN_WORK,
  CANCEL_PRIMARY_BROWSER_WORK,
  computerIdleSleepEnabled,
  DEFAULT_SANDBOX_IDLE_MS,
  sandboxIdleMs,
  scheduleComputerSleep,
  sleepComputerIfIdle,
} from "./computer-idle.js";
import { acquireComputerExecutionLease, ComputerBusyError } from "./computer-lifecycle.js";
import { reconcileComputerUpdates } from "./computer-update.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider, e2bCreateOptions } from "./e2b-sandbox.js";

describe("sandbox idle", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("defaults to ten minutes when SANDBOX_IDLE_MS is unset", () => {
    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    expect(DEFAULT_SANDBOX_IDLE_MS).toBe(10 * 60 * 1000);
  });

  it.each(["0", " \t0\n"])("disables idle sleep for %j", async (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();

    expect(computerIdleSleepEnabled()).toBe(false);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.prisma.computer.findUnique).not.toHaveBeenCalled();
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it.each(["", "invalid", "NaN", "Infinity", "-1", "29999", "00", "0.0"])(
    "keeps idle sleep enabled with the default timeout for %j",
    (value) => {
      vi.stubEnv("SANDBOX_IDLE_MS", value);

      expect(computerIdleSleepEnabled()).toBe(true);
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    },
  );

  it.each(["30000", "900000"])("schedules idle sleep using %s ms", (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(Number(value));
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);

    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + Number(value)) }),
    );
  });

  it("does not suspend a computer while a run is active", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValueOnce({ id: "run" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it.each(["before sleep", "during the active run check", "during the background probe"])(
    "does not claim idle maintenance when shutdown starts %s",
    async (stage) => {
      const harness = idleHarness();
      const reason = new Error("worker shutting down");
      if (stage === "before sleep") harness.shutdown.abort(reason);
      else if (stage === "during the active run check") {
        harness.prisma.run.findFirst.mockImplementationOnce(async () => {
          harness.shutdown.abort(reason);
          return { id: "active-run" };
        });
      } else {
        harness.sandbox.execute.mockImplementationOnce(async function* () {
          harness.shutdown.abort(reason);
          yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
          yield { type: "exit", code: 1 } as const;
        });
      }

      await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toBe(reason);

      expect(harness.computerUpdate.create).not.toHaveBeenCalled();
      expect(harness.computer.maintenanceId).toBeNull();
      expect(harness.home.commit).not.toHaveBeenCalled();
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("releases failed idle maintenance only after an export settles following shutdown", async () => {
    const harness = idleHarness();
    const entered = deferred();
    const release = deferred();
    const reason = new Error("worker shutting down");
    harness.sandbox.exportWorkspace.mockImplementationOnce(async function* () {
      entered.resolve();
      await release.promise; // Deliberately ignore abort until the provider settles.
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    });
    let settled = false;
    const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    harness.shutdown.abort(reason);
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(harness.operation.status).toBe("running");
    expect(harness.computer.maintenanceId).toBe("checkpoint-1");
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();

    release.resolve();
    expect(await sleep).toBe(reason);
    expect(harness.operation.status).toBe("failed");
    expect(harness.computer.state).toBe("running");
    expect(harness.computer.maintenanceId).toBeNull();
    expect(harness.computer.homeRevision).toBe("rev-before");
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.events.append).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does not reschedule or keep alive when shutdown interrupts the final background probe", async () => {
    const harness = idleHarness();
    const reason = new Error("worker shutting down");
    harness.sandbox.execute
      .mockImplementationOnce(harness.sandbox.execute.getMockImplementation()!)
      .mockImplementationOnce(async function* () {
        harness.shutdown.abort(reason);
        yield { type: "exit", code: 0 } as const;
      });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toBe(reason);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    expect(harness.operation.status).toBe("failed");
    expect(harness.computer.state).toBe("running");
    expect(harness.computer.maintenanceId).toBeNull();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does not reschedule a failed idle claim after shutdown", async () => {
    const harness = idleHarness();
    const reason = new Error("worker shutting down");
    harness.prisma.computer.updateMany.mockImplementationOnce(async () => {
      harness.shutdown.abort(reason);
      return { count: 0 };
    });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toBe(reason);

    expect(harness.computer.state).toBe("running");
    expect(harness.computer.maintenanceId).toBeNull();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it("does not suspend a computer while bot-launched background work is active", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("suspends after the E2B SDK reports the idle probe's expected exit code one", async () => {
    const harness = idleHarness();
    const run = vi
      .fn()
      .mockRejectedValue(
        new CommandExitError({ exitCode: 1, stdout: "rakazo-background-idle\n", stderr: "" }),
      );
    const provider = new E2BSandboxProvider("test-key", {
      connect: vi.fn(async () => ({ sandboxId: "computer", commands: { run } })),
    } as unknown as E2BSandboxSdk);

    await sleepComputerIfIdle(
      {
        ...harness.deps,
        sandbox: {
          ...harness.sandbox,
          execute: provider.execute.bind(provider),
        } as unknown as SandboxProvider,
      },
      harness.computer.id,
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("suspended");
  });

  it("probes background work with the database computer id, not providerRef", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: harness.computer.providerRef }),
      expect.objectContaining({
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", harness.computer.id],
      }),
      expect.anything(),
    );
    expect(harness.computer.id).not.toBe(harness.computer.providerRef);
  });

  it("fails closed when the provider cannot inspect background work", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 2 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("fails closed when the provider reports a command failure as exit one", async () => {
    const harness = idleHarness({ backgroundWorkProbeFailed: true });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned waiting takeover prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("claims the lease boundary before any checkpoint export", async () => {
    const harness = idleHarness();
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("fails before claiming when no real bot can own checkpoint recovery", async () => {
    const harness = idleHarness();
    harness.computer.bots = [];
    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "Computer checkpoint requires a bot id",
    );
    expect(harness.computerUpdate.create).not.toHaveBeenCalled();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it("does not export or stop while the existing mode-switch claim is held", async () => {
    const harness = idleHarness();
    harness.computer.bots[0]!.computerSwitching = true;
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.computer.maintenanceId).toBeNull();
  });

  it("does not reserve a replacement through a stale provider reference", async () => {
    const harness = idleHarness();
    const update = harness.prisma.computer.updateMany.getMockImplementation()!;
    harness.prisma.computer.updateMany.mockImplementationOnce(async (args) => {
      harness.computer.providerRef = "replacement";
      return update(args);
    });
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.computer.maintenanceId).toBeNull();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it("rechecks background work after checkpointing before it suspends", async () => {
    const harness = idleHarness({ backgroundWorkProbeCodes: [1, 0] });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.execute).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("uses provider-native idle inspection instead of retaining emulator computers", async () => {
    const harness = idleHarness({ providerBackgroundWorkStatus: "idle" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.inspectBackgroundWork).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.execute).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sandbox.exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: harness.computer.id,
        state: "suspending",
        providerRef: harness.computer.providerRef,
        maintenanceId: "checkpoint-1",
      },
      data: {
        state: "suspended",
        maintenanceId: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
  });

  it.each(["export", "commit", "stop"])(
    "keeps competing runs out while an idle %s exceeds the lifecycle timeout",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const harness = idleHarness();
      const entered = deferred();
      const release = deferred();
      const wait = async () => {
        entered.resolve();
        await release.promise; // These provider operations deliberately ignore abort.
      };
      if (stage === "export") {
        harness.sandbox.exportWorkspace.mockImplementationOnce(async function* () {
          await wait();
          yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
        });
      } else if (stage === "commit") {
        harness.home.commit.mockImplementationOnce(async () => {
          await wait();
          return "rev-checkpoint";
        });
      } else {
        harness.sandbox.stop.mockImplementationOnce(wait);
      }

      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
      await entered.promise;
      let admission: unknown;
      try {
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        await reconcileComputerUpdates(harness.deps);
        expect(harness.operation.status).toBe("running");
        await sleepComputerIfIdle(harness.deps, harness.computer.id);
        expect(harness.computerUpdate.create).toHaveBeenCalledOnce();
        admission = await acquireComputerExecutionLease(harness.deps.prisma, {
          computerId: harness.computer.id,
          botId: "next-bot",
          runId: "next-run",
        }).catch((error: unknown) => error);
      } finally {
        release.resolve();
        await sleep;
      }

      expect(admission).toBeInstanceOf(ComputerBusyError);
      expect(harness.computer.state).toBe("suspended");
      expect(harness.operation.status).toBe("completed");
      expect(harness.computer.maintenanceId).toBeNull();
    },
  );

  it.each(["export", "commit", "stop"])(
    "retains the reservation after renewal fails until the ignored %s settles",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const harness = idleHarness();
      const entered = deferred();
      const release = deferred();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      if (stage === "export") {
        harness.sandbox.exportWorkspace.mockImplementationOnce(async function* () {
          await wait();
          yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
        });
      } else if (stage === "commit") {
        harness.home.commit.mockImplementationOnce(async () => {
          await wait();
          return "rev-checkpoint";
        });
      } else {
        harness.sandbox.stop.mockImplementationOnce(wait);
      }
      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id).catch(
        (error: unknown) => error,
      );
      await entered.promise;
      let admission: unknown;
      let interrupted: string | undefined;
      let reserved: string | null = null;
      try {
        harness.computerUpdate.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        await reconcileComputerUpdates(harness.deps);
        interrupted = harness.operation.status;
        reserved = harness.computer.maintenanceId;
        admission = await acquireComputerExecutionLease(harness.deps.prisma, {
          computerId: harness.computer.id,
          botId: "next-bot",
          runId: "next-run",
        }).catch((error: unknown) => error);
      } finally {
        release.resolve();
      }
      const error = await sleep;

      expect(error).toBeInstanceOf(Error);
      expect(interrupted).toBe("interrupted");
      expect(reserved).toBe("checkpoint-1");
      expect(admission).toBeInstanceOf(ComputerBusyError);
      expect(harness.operation.status).toBe("failed");
      expect(harness.computer.maintenanceId).toBeNull();
      expect(harness.computer.state).toBe(stage === "stop" ? "suspended" : "running");
      if (stage === "export") expect(harness.home.commit).not.toHaveBeenCalled();
      if (stage !== "stop") expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.events.append).not.toHaveBeenCalled();
    },
  );

  it("keeps a crashed checkpoint reserved for native attended recovery without replay", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const harness = idleHarness();
    harness.computer.state = "suspending";
    harness.computer.maintenanceId = harness.operation.id;
    // Persisted state after process death: no heartbeat, no live promise to settle it.
    harness.operation.updatedAt = new Date(Date.now() - 11 * 60_000);
    await reconcileComputerUpdates(harness.deps);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.operation.status).toBe("interrupted");
    expect(harness.computer.maintenanceId).toBe("checkpoint-1");
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    await expect(
      acquireComputerExecutionLease(harness.deps.prisma, {
        computerId: harness.computer.id,
        botId: "next-bot",
        runId: "next-run",
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("preserves a heartbeat that wins against the reconciler's stale snapshot", async () => {
    const harness = idleHarness();
    harness.computer.state = "suspending";
    harness.computer.maintenanceId = harness.operation.id;
    harness.operation.updatedAt = new Date(Date.now() - 11 * 60_000);
    const update = harness.computerUpdate.updateMany.getMockImplementation()!;
    harness.computerUpdate.updateMany.mockImplementationOnce(async (args) => {
      harness.operation.updatedAt = new Date();
      return update(args);
    });
    await reconcileComputerUpdates(harness.deps);
    expect(harness.operation.status).toBe("running");
    expect(harness.computer.maintenanceId).toBe("checkpoint-1");
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("serializes lease admission against a checkpoint's pre-insert database snapshot", async () => {
    const harness = idleHarness();
    const claimed = deferred();
    const claimCanCommit = deferred();
    const update = harness.prisma.computer.updateMany.getMockImplementation()!;
    harness.prisma.computer.updateMany.mockImplementationOnce(async (args) => {
      // The claim statement saw no execution lease before the concurrent insert.
      claimed.resolve();
      await claimCanCommit.promise;
      return update(args);
    });
    const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
    await claimed.promise;
    const admission = acquireComputerExecutionLease(harness.deps.prisma, {
      computerId: harness.computer.id,
      botId: "next-bot",
      runId: "next-run",
    }).catch((error: unknown) => error);
    // Let the competing acquisition observe running if it has no shared row lock.
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    claimCanCommit.resolve();
    await sleep;
    expect(await admission).toBeInstanceOf(ComputerBusyError);
  });

  it("waits for a pending heartbeat before releasing and never renews the next owner", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const harness = idleHarness();
    const stopping = deferred();
    const stopped = deferred();
    harness.sandbox.stop.mockImplementationOnce(async () => {
      stopping.resolve();
      await stopped.promise;
    });
    const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
    await stopping.promise;
    const renewing = deferred();
    const renewed = deferred();
    const update = harness.computerUpdate.updateMany.getMockImplementation()!;
    harness.computerUpdate.updateMany.mockImplementationOnce(async (args) => {
      renewing.resolve();
      await renewed.promise;
      return update(args);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await renewing.promise;
    stopped.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.computer.maintenanceId).toBe("checkpoint-1");
    renewed.resolve();
    await sleep;
    harness.computer.maintenanceId = "next-owner";
    const writes = harness.computerUpdate.updateMany.mock.calls.length;
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(harness.computerUpdate.updateMany).toHaveBeenCalledTimes(writes);
    expect(harness.computer.maintenanceId).toBe("next-owner");
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "checkpoint unavailable",
    );

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("retains the saved revision when the database transition after stopping fails", async () => {
    const harness = idleHarness();
    const updateMany = harness.prisma.computer.updateMany.getMockImplementation()!;
    harness.prisma.computer.updateMany.mockImplementation(async (args) => {
      if (args.data.state === "suspended") throw new Error("database unavailable");
      return updateMany(args);
    });
    harness.sandbox.stop.mockImplementationOnce(async () => {
      expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "database unavailable",
    );

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
  });

  it("keeps an uncertain pause interrupted and reserved until attended recovery", async () => {
    const harness = idleHarness();
    harness.sandbox.stop.mockRejectedValueOnce(new Error("pause request timed out"));
    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "pause request timed out",
    );
    expect(harness.operation.status).toBe("interrupted");
    expect(harness.computer.state).toBe("suspending");
    expect(harness.computer.maintenanceId).toBe("checkpoint-1");
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    expect(harness.events.append).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    await expect(
      acquireComputerExecutionLease(harness.deps.prisma, {
        computerId: harness.computer.id,
        botId: "next-bot",
        runId: "next-run",
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it.each(["failure", "lost claim"])(
    "does not stop when recording the revision encounters a %s",
    async (outcome) => {
      const harness = idleHarness();
      const updateMany = harness.prisma.computer.updateMany.getMockImplementation()!;
      harness.prisma.computer.updateMany.mockImplementation(async (args) => {
        if (args.data.homeRevision) {
          if (outcome === "failure") throw new Error("database unavailable");
          harness.computer.maintenanceId = "new-owner";
        }
        return updateMany(args);
      });

      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
      if (outcome === "failure") await expect(sleep).rejects.toThrow("database unavailable");
      else await expect(sleep).rejects.toThrow("Computer checkpoint interrupted");

      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.computer.homeRevision).toBe("rev-before");
      expect(harness.computer.state).toBe(outcome === "failure" ? "running" : "suspending");
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["checkpoint failure", "stop failure", "stop success"])(
    "preserves a newer lifecycle owner after %s",
    async (stage) => {
      const harness = idleHarness();
      const invalidate = () => {
        harness.computer.maintenanceId = "new-owner";
      };
      if (stage === "checkpoint failure") {
        harness.home.commit.mockImplementationOnce(async () => {
          invalidate();
          throw new Error("checkpoint interrupted");
        });
      } else {
        harness.sandbox.stop.mockImplementationOnce(async () => {
          invalidate();
          if (stage === "stop failure") throw new Error("stop interrupted");
        });
      }

      await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow();

      expect(harness.computer.state).toBe("suspending");
      expect(harness.events.append).not.toHaveBeenCalled();
    },
  );
});

describe("background work launch and probe", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const markers = new Set<string>();

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    for (const marker of markers) {
      rmSync(marker, { force: true, recursive: true });
    }
    markers.clear();
  });

  it.skipIf(process.platform === "win32")(
    "detects active work only when launch and probe share the same marker id",
    async () => {
      const databaseId = "computer-db-id";
      const providerRef = "provider-ref";
      const launchId = "active";
      markers.add(`/tmp/rakazo-background-${databaseId}-run-1-${launchId}`);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          databaseId,
          "run-1",
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(databaseId)).toBe(0);
      // ComputerRef.id is providerRef today; probing that path must not see the DB-id marker.
      expect(await probeBackgroundWork(providerRef)).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans a completed marker without blocking a later launch",
    async () => {
      const markerId = "computer-relaunch-id";
      const completedMarker = `/tmp/rakazo-background-${markerId}-run-1-completed`;
      const activeMarker = `/tmp/rakazo-background-${markerId}-run-1-active`;
      markers.add(completedMarker);
      markers.add(activeMarker);
      const completed = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "completed",
          "true",
        ],
        { stdio: "ignore" },
      );
      children.push(completed);

      expect(await processExit(completed)).toBe(0);
      expect(await probeBackgroundWork(markerId)).toBe(1);
      expect(existsSync(completedMarker)).toBe(false);

      const active = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "active",
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(active);
      await expect.poll(() => probeBackgroundWork(markerId)).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not run the command when its marker cannot be opened",
    async () => {
      const markerId = "computer-marker-error";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      mkdirSync(marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a pre-existing marker symlink",
    async () => {
      const markerId = "computer-marker-symlink";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      symlinkSync(commandRan, marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cancel tears down background shell work for that run",
    async () => {
      const computerId = "computer-cancel-id";
      const runId = "run-cancel-1";
      const launchId = "active";
      const marker = `/tmp/rakazo-background-${computerId}-${runId}-${launchId}`;
      markers.add(marker);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          runId,
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(computerId)).toBe(0);

      const launchedDone = processExit(launched);
      const cancel = spawn(
        "bash",
        ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId],
        { stdio: "ignore" },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      await launchedDone;
      expect(await probeBackgroundWork(computerId)).toBe(1);
    },
  );
});

describe("CANCEL_PRIMARY_BROWSER_WORK", () => {
  it("keeps shell parameter expansions literal", () => {
    expect(CANCEL_COMPUTER_RUN_WORK).toContain(`pid="\${fd#/proc/}"; pid="\${pid%%/*}"`);
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(`kill -TERM "\${pid#/proc/}"`);
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(`kill -KILL "\${pid#/proc/}"`);
  });

  it("targets the primary profile and matches browser argv0 only", () => {
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(".browser-profiles/chromium");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("chromium-screen-");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain('argv0=""; IFS= read -r -d "" argv0');
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/chromium|*/chromium-*|chromium|chromium-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/firefox|*/firefox-*|firefox|firefox-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[c]hromium*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[f]irefox*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[g]oogle-chrome*");
  });
});

describe("e2b create options", () => {
  it("pauses on timeout instead of killing the sandbox", () => {
    const opts = e2bCreateOptions("bot-1", "e2b_test");
    expect(opts.lifecycle).toEqual({ onTimeout: "pause", autoResume: false });
    expect(opts.timeoutMs).toBe(sandboxIdleMs());
    expect(opts.metadata.botId).toBe("bot-1");
  });
});

function idleHarness(
  options: {
    backgroundWorkProbeCode?: number;
    backgroundWorkProbeCodes?: number[];
    backgroundWorkProbeFailed?: boolean;
    exportError?: Error;
    providerBackgroundWorkStatus?: "active" | "idle" | "unknown";
  } = {},
) {
  const shutdown = new AbortController();
  const backgroundWorkProbeCodes = [...(options.backgroundWorkProbeCodes ?? [])];
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    homeRevision: "rev-before",
    providerRef: "computer",
    kind: "e2b",
    scope: "team",
    maintenanceId: null as string | null,
    bots: [{ id: "bot", computerSwitching: false }],
    state: "running",
    spaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionBotId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const prisma = {
    $transaction: vi.fn(),
    computer: {
      findUnique: vi.fn(async () => ({ ...computer })),
      findUniqueOrThrow: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async (args) => {
        if (!matchesComputer(args.where)) return { count: 0 };
        Object.assign(computer, args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args) => {
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          throw new Error("stale computer lifecycle");
        Object.assign(computer, args.data);
        return computer;
      }),
    },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ fence: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: {
      findMany: vi.fn().mockResolvedValue([{ id: "bot", thread: { id: "thread" } }]),
    },
  };
  const operation = {
    id: "checkpoint-1",
    status: "running",
    action: "checkpoint",
    computerId: computer.id,
    botId: "bot",
    updatedAt: new Date(),
  };
  const computerUpdate = {
    create: vi.fn(async ({ data }) => Object.assign(operation, data)),
    findMany: vi.fn(async ({ where }) =>
      where.OR.some(
        (condition: { status: string; updatedAt?: { lt: Date } }) =>
          condition.status === operation.status &&
          (!condition.updatedAt || operation.updatedAt < condition.updatedAt.lt),
      )
        ? [{ ...operation }]
        : [],
    ),
    updateMany: vi.fn(async ({ where, data }) => {
      if (where.id !== operation.id) return { count: 0 };
      if (
        where.status &&
        (typeof where.status === "string"
          ? where.status !== operation.status
          : !where.status.in.includes(operation.status))
      )
        return { count: 0 };
      if (where.updatedAt && where.updatedAt.getTime() !== operation.updatedAt.getTime())
        return { count: 0 };
      if (where.computer && !matchesComputer(where.computer)) return { count: 0 };
      Object.assign(operation, data);
      return { count: 1 };
    }),
  };
  const db = { ...prisma, computerUpdate };
  let rowLock = Promise.resolve();
  prisma.$transaction.mockImplementation(async (fn) => {
    let before = { ...computer };
    let previousOperation = { ...operation };
    let unlock: (() => void) | undefined;
    const tx = {
      ...db,
      $queryRaw: vi.fn(async () => {
        const previous = rowLock;
        const next = deferred();
        rowLock = next.promise;
        await previous;
        unlock = next.resolve;
        before = { ...computer };
        previousOperation = { ...operation };
        return [{ id: computer.id }];
      }),
    };
    try {
      return await fn(tx);
    } catch (error) {
      Object.assign(computer, before);
      Object.assign(operation, previousOperation);
      throw error;
    } finally {
      unlock?.();
    }
  });
  function matchesComputer(where: Record<string, unknown>) {
    return Object.entries(where).every(([key, value]) => {
      if (key === "AND") return (value as Record<string, unknown>[]).every(matchesComputer);
      if (key === "bots") {
        const none = (value as { none: { computerSwitching: boolean; id?: { not: string } } }).none;
        return !computer.bots.some(
          (bot) =>
            bot.computerSwitching === none.computerSwitching &&
            (!none.id || bot.id !== none.id.not),
        );
      }
      if (!(key in computer)) return true;
      const current = computer[key as keyof typeof computer];
      return value instanceof Date && current instanceof Date
        ? value.getTime() === current.getTime()
        : current === value;
    });
  }
  const sandbox = {
    execute: vi.fn(async function* () {
      const code = backgroundWorkProbeCodes.shift() ?? options.backgroundWorkProbeCode ?? 1;
      if (code === 1 && !options.backgroundWorkProbeFailed) {
        yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
      }
      yield { type: "exit", code } as const;
    }),
    keepAlive: vi.fn().mockResolvedValue(undefined),
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...(options.providerBackgroundWorkStatus
      ? {
          inspectBackgroundWork: vi.fn().mockResolvedValue(options.providerBackgroundWorkStatus),
        }
      : {}),
  };
  const home = {
    commit: vi.fn().mockResolvedValue("rev-checkpoint"),
  };
  const jobs = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const events = { append: vi.fn().mockResolvedValue({}) };
  return {
    shutdown,
    computer,
    computerUpdate,
    operation,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    deps: {
      shutdownSignal: shutdown.signal,
      prisma: db as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: home as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}

function probeBackgroundWork(markerId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", markerId],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function processExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
