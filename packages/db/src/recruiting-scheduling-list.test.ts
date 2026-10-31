import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import type * as Scope from "./scope.js";

vi.mock("./recruiting.js", () => ({
  getRecruitingWorkspace: async () => ({
    role: { id: "role", revision: 1, currentRevisionId: "revision" },
  }),
}));
vi.mock("./scope.js", async (original) => ({
  ...(await original<typeof Scope>()),
  requireMembership: async () => ({}),
}));
const { listRecruitingSchedulingPlans } = await import("./recruiting-scheduling.js");

describe("listRecruitingSchedulingPlans", () => {
  it("checks no grant for a role's effects that are not availability reads", async () => {
    const effect = (id: string, toolName: string) => ({
      id,
      kind: "tool",
      status: "completed",
      updatedAt: new Date(0),
      request: {
        route: { connectorId: "mcp", resourceId: "server", resourceRevision: 1, toolName },
        args: {},
      },
      result: { structuredContent: { data: [] } },
      run: { botId: "bot", initialRecruitingRoleRevisionId: "revision" },
    });
    const transaction = vi.fn();
    const prisma = {
      externalEffect: {
        findMany: async () => [effect("a", "agent_run"), effect("b", "list_crm_candidates")],
      },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const result = await listRecruitingSchedulingPlans(
      prisma,
      { userId: "user", spaceId: "space" } as never,
      { threadId: "thread" },
    );
    expect(result).toEqual({ plans: [], slots: [], partial: false });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("is not partial when a role has many other effects but few plans", async () => {
    const other = Array.from({ length: 150 }, (_, index) => ({
      id: `other-${index}`,
      kind: "tool",
      status: "completed",
      updatedAt: new Date(0),
      request: {},
      result: null,
      run: { botId: "bot", initialRecruitingRoleRevisionId: "revision" },
    }));
    const findMany = vi.fn(async ({ where, take }: { where: { kind: unknown }; take: number }) =>
      where.kind === "recruiting_scheduling_plan" ? [] : other.slice(0, take),
    );
    const prisma = {
      externalEffect: { findMany },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const result = await listRecruitingSchedulingPlans(
      prisma,
      { userId: "user", spaceId: "space" } as never,
      { threadId: "thread" },
    );
    expect(result.partial).toBe(false);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: "recruiting_scheduling_plan" }),
      }),
    );
  });
});
