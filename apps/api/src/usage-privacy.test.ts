import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const { internalCosts, workMetrics, listResearch } = vi.hoisted(() => ({
  internalCosts: vi.fn(),
  workMetrics: vi.fn(),
  listResearch: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  summarizeInternalUsageCosts: internalCosts,
  summarizeWorkMetrics: workMetrics,
  listRecruitingResearch: listResearch,
}));

const amounts = {
  credits: 1.4,
  costUsd: 0.007,
  priced: true,
  calls: 1,
  tokens: 20,
  inputTokens: 11,
  outputTokens: 9,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
};
const actor: Actor = {
  spaceId: "space-fixture",
  userId: "user-fixture",
  email: "forged@wekruit.com",
  isDeploymentOwner: true,
};

function fixture(email: string, emailVerified: boolean, requestActor: Actor | null = actor) {
  const findMany = vi.fn(async () => []);
  const aggregate = vi.fn(async () => ({
    _sum: { inputTokens: 11, outputTokens: 9, totalTokens: 20 },
    _count: { _all: 1, inputTokens: 1, outputTokens: 1, totalTokens: 1 },
  }));
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ email, emailVerified })) },
    usageRecord: { findMany, aggregate, groupBy: vi.fn(async () => []) },
  };
  const client = createRouterClient(createRouter({ prisma, env: {} } as unknown as RouterDeps), {
    context: { actor: requestActor },
  });
  return { client, prisma, findMany, aggregate };
}

beforeEach(() => {
  internalCosts.mockReset();
  workMetrics.mockReset();
});

describe("usage diagnostic authorization", () => {
  it.each([
    ["external@example.test", true],
    ["staff@wekruit.com", false],
    ["staff@notwekruit.com", true],
    ["staff@wekruit.com.evil.test", true],
  ])("denies token and cost detail for %s (verified=%s)", async (email, verified) => {
    const { client, findMany, aggregate } = fixture(email as string, verified as boolean);
    for (const call of [
      () => client.usage.list(),
      () => client.usage.summary(),
      () => client.usage.internalCosts(),
      () => client.usage.workMetrics(),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(internalCosts).not.toHaveBeenCalled();
    expect(workMetrics).not.toHaveBeenCalled();
  });

  it("denies unauthenticated diagnostic calls", async () => {
    const { client, prisma } = fixture("staff@wekruit.com", true, null);
    for (const call of [
      () => client.usage.list(),
      () => client.usage.summary(),
      () => client.usage.internalCosts(),
      () => client.usage.workMetrics(),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(internalCosts).not.toHaveBeenCalled();
    expect(workMetrics).not.toHaveBeenCalled();
  });

  it("allows verified staff without requiring deployment ownership", async () => {
    const { client, prisma, findMany, aggregate } = fixture("staff@WeKruit.com", true, {
      ...actor,
      email: "staff@WeKruit.com",
      isDeploymentOwner: false,
    });
    const report = {
      total: amounts,
      month: amounts,
      pricing: { creditsPerUsd: 100, grossMargin: 0.5 },
      vendors: [],
      accounts: [
        {
          ...amounts,
          userId: "another-account",
          email: "another@example.test",
          name: "Another",
          vendors: [],
        },
      ],
    };
    internalCosts.mockResolvedValue(report);
    expect(await client.usage.internalCosts()).toEqual(report);
    const metrics = {
      windowDays: 28,
      since: "2026-02-01T00:00:00.000Z",
      unrescuedWeeks: [],
      completion: { completed: 0, failed: 0, cancelled: 0, stoppedByPerson: 0, reasons: [] },
      longTasks: {
        runDuration: { count: 0, p50Ms: null, p95Ms: null },
        taskDuration: { count: 0, p50Ms: null, p95Ms: null },
        compactions: 0,
        runsCompacted: 0,
        resumed: { count: 0, of: 0 },
      },
      experience: {
        firstReply: { count: 0, p50Ms: null, p95Ms: null },
        interject: { count: 0, p50Ms: null, p95Ms: null },
        unansweredInputs: 0,
        inputs: 0,
      },
      memory: { correctedAfterCompaction: { count: 0, of: 0 } },
      collaboration: { handoffs: 0, teammateTurns: 0, replied: 0, silent: 0 },
      automation: { fired: 0, skipped: 0, completed: 0, failed: 0 },
    };
    workMetrics.mockResolvedValue(metrics);
    expect(await client.usage.workMetrics()).toEqual(metrics);
    await client.usage.list();
    await client.usage.summary();
    expect(internalCosts).toHaveBeenCalledWith(prisma, {
      priceTokens: expect.any(Function),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: actor.spaceId, userId: actor.userId, unit: "tokens" },
      }),
    );
    expect(aggregate).toHaveBeenCalled();
  });
});

it.each([false, true])(
  "research history reveals vendor-native usage only to verified staff (%s)",
  async (staff) => {
    const { client } = fixture(staff ? "staff@wekruit.com" : "external@example.test", true);
    const usage = [{ scope: "task", unit: "credits", amount: 9 }];
    const artifact = { artifactId: "artifact", sha256: "a".repeat(64) };
    const action = {
      id: "action",
      taskId: "task",
      roleRevisionId: "revision",
      runId: "run",
      sourceMessageId: "message",
      clientNonce: "nonce",
      kind: "create",
      deliveryState: "unknown",
      observedProviderState: null,
      requestArtifact: artifact,
      contextArtifact: artifact,
      receiptArtifact: artifact,
      outputArtifacts: [],
      recallScope: null,
      cursor: null,
      effectId: "effect",
      usage,
    };
    const stored = { tasks: [], actions: [action], observations: [] };
    listResearch.mockResolvedValueOnce(stored);
    const output = await client.recruiting.listResearch({ roleId: "role" });
    expect(output.actions[0]?.usage).toEqual(staff ? usage : null);
    expect(stored.actions[0]?.usage).toBe(usage);
  },
);
