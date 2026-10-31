import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { summarizeInternalUsageCosts, summarizeUsageCosts } from "./usage.js";

const actor = { spaceId: "space-a", userId: "user-a" };
function fixture(staff = false) {
  const group = {
    unit: "tokens",
    provider: "vendor-a",
    model: "model-a",
    roleId: null,
    userId: actor.userId,
    day: new Date("2026-10-30"),
    round: null,
    scale: false,
    quantity: null,
    tokens: 130,
    inputTokens: 60,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: null,
    reasoningTokens: 10,
    costUsd: 0.007,
    creditCost: 1.4,
    unpricedCount: 0,
    tokenRows: 1,
    calls: 1,
    costSources: ["provider-reported"],
    unpricedInput: 0,
    unpricedOutput: 0,
    unpricedCacheRead: 0,
    unpricedCacheWrite: 0,
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([group]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    usageRecord: { findMany: vi.fn().mockResolvedValue([]) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    recruitingRole: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        email: staff ? "staff@wekruit.com" : "client@example.test",
        emailVerified: true,
      }),
      findMany: vi.fn().mockResolvedValue([
        { id: "user-a", email: "client@example.test", name: "Client" },
        { id: "user-b", email: "unused@example.test", name: "No usage" },
      ]),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, raw: prisma, group };
}

describe("product credits and internal cost privacy", () => {
  it("returns only cost-derived product credits, including fractional LLM spend", async () => {
    const { prisma } = fixture();
    const result = await summarizeUsageCosts(prisma, actor);
    expect(result.total).toEqual({ credits: 1.4, pending: false });
    expect(result.canViewInternalCosts).toBe(false);
    expect(result).not.toHaveProperty("accounts");
    expect(result).not.toHaveProperty("services");
    expect(JSON.stringify(result)).not.toMatch(/tokens|costUsd|estimatedUsd|vendor-a|model-a/);
  });
  it("keeps the ordinary Usage payload credit-only for staff too", async () => {
    const { prisma } = fixture(true);
    const result = await summarizeUsageCosts(prisma, actor);
    expect(result.total).toEqual({ credits: 1.4, pending: false });
    expect(result.canViewInternalCosts).toBe(true);
    expect(result).not.toHaveProperty("accounts");
  });
  it("preserves buckets without double counting reasoning and includes zero-usage accounts", async () => {
    const { prisma } = fixture(true);
    const result = await summarizeInternalUsageCosts(prisma);
    expect(result.total).toMatchObject({
      credits: 1.4,
      tokens: 130,
      inputTokens: 60,
      outputTokens: 30,
      reasoningTokens: 10,
      costUsd: 0.007,
    });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]?.vendors[0]?.models[0]).toMatchObject({
      model: "model-a",
      costSources: ["provider-reported"],
      tokens: 130,
    });
    expect(result.accounts[1]).toMatchObject({
      userId: "user-b",
      credits: 0,
      costUsd: 0,
      vendors: [],
    });
    expect(result.pricing).toEqual({ creditsPerUsd: 100, grossMargin: 0.5 });
  });
  it("marks unknown cost and token buckets instead of presenting them as zero", async () => {
    const { prisma, raw, group } = fixture(true);
    raw.$queryRaw.mockResolvedValue([
      { ...group, costUsd: null, creditCost: 0, unpricedCount: 1, tokens: null, inputTokens: null },
    ]);
    const result = await summarizeInternalUsageCosts(prisma);
    expect(result.total).toMatchObject({
      costUsd: null,
      priced: false,
      tokens: null,
      inputTokens: null,
    });
  });
});
