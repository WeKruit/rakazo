import type * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof adapters>()),
  provisionComputer: vi.fn(async () => ({
    id: "sb",
    botId: "home",
    kind: "fake",
    providerRef: "sb",
  })),
  acquireComputerExecutionLease: vi.fn(async () => null),
  scheduleComputerSleep: vi.fn(),
}));

const { acquireComputerExecutionLease, provisionComputer, scheduleComputerSleep } = await import(
  "@rakazo/adapters"
);
const { prewarmTeamComputer } = await import("./prewarm.js");

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

function fakeDeps(computer: { id: string; state: string } | null, activeRun = false) {
  const prisma = {
    computer: {
      findFirst: vi.fn(async () => (computer ? { ...computer, bots: [{ id: "bot-1" }] } : null)),
    },
    run: { findFirst: vi.fn(async () => (activeRun ? { id: "run-1" } : null)) },
  } as unknown as PrismaClient;
  return {
    prisma,
    sandbox: {},
    home: {},
    jobs: {},
    events: {},
    dataDir: "/tmp",
  } as unknown as RouterDeps;
}

describe("prewarmTeamComputer", () => {
  afterEach(() => {
    vi.clearAllMocks();
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("wakes a paused team computer through provisionComputer without taking a lease", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const deps = fakeDeps({ id: "computer-warm", state: "suspended" });
    await expect(prewarmTeamComputer(deps, actor)).resolves.toBe("warmed");
    expect(provisionComputer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provisionComputer).mock.calls[0]?.[1]).toBe("computer-warm");
    expect(vi.mocked(provisionComputer).mock.calls[0]?.[2]).toMatchObject({
      operationId: "computer.prewarm",
      botId: "bot-1",
      spaceId: "space-1",
    });
    expect(acquireComputerExecutionLease).not.toHaveBeenCalled();
    expect(scheduleComputerSleep).toHaveBeenCalledWith(deps.jobs, "computer-warm");
    const timing = sink.events.find((event) => event.message === "computer.prewarm.timing");
    expect(timing).toMatchObject({ outcome: "warmed", computerId: "computer-warm" });
    expect(timing).toHaveProperty("totalMs");
    expect(timing).toHaveProperty("wakeMs");
    expect(timing).toHaveProperty("prepareMs");
  });

  it("skips when the computer is not paused", async () => {
    await expect(
      prewarmTeamComputer(fakeDeps({ id: "computer-running", state: "running" }), actor),
    ).resolves.toBe("skipped:not_paused");
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it("skips when a run is active on the computer", async () => {
    await expect(
      prewarmTeamComputer(fakeDeps({ id: "computer-busy", state: "suspended" }, true), actor),
    ).resolves.toBe("skipped:run_active");
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it("skips a second pre-warm within ten minutes", async () => {
    const deps = fakeDeps({ id: "computer-twice", state: "suspended" });
    await expect(prewarmTeamComputer(deps, actor)).resolves.toBe("warmed");
    await expect(prewarmTeamComputer(deps, actor)).resolves.toBe("skipped:rate_limited");
    expect(provisionComputer).toHaveBeenCalledTimes(1);
  });

  it("reports a failure instead of throwing", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    vi.mocked(provisionComputer).mockRejectedValueOnce(new Error("provider down"));
    await expect(
      prewarmTeamComputer(fakeDeps({ id: "computer-fail", state: "suspended" }), actor),
    ).resolves.toBe("failed");
    expect(
      sink.events.some((event) => event.message === "computer.prewarm" && event.level === "warn"),
    ).toBe(true);
  });
});
