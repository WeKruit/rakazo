import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listRecruitingSchedulingPlans: service.list,
  createRecruitingSchedulingPlan: service.create,
}));

import type { Actor, RecruitingSchedulingPlanInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import {
  getRecruitingSchedulingPlans,
  saveRecruitingSchedulingPlan,
} from "./recruiting-scheduling.js";

const prisma = {} as PrismaClient;
const actor = { spaceId: "space", userId: "user", email: "user@example.test" } as Actor;
beforeEach(() => vi.resetAllMocks());
describe("scheduling plan API session fences", () => {
  it("does not read or save after session revocation", async () => {
    const guard = vi.fn().mockResolvedValue(false);
    await expect(
      getRecruitingSchedulingPlans(prisma, actor, { threadId: "thread" }, guard),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      saveRecruitingSchedulingPlan(prisma, actor, {} as RecruitingSchedulingPlanInput, guard),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(service.list).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });
  it("does not disclose a plan when the session is revoked during the read", async () => {
    service.list.mockResolvedValue({ plans: [{ id: "private-plan" }] });
    const guard = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      getRecruitingSchedulingPlans(prisma, actor, { threadId: "thread" }, guard),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("preserves isolation errors and real service failures distinctly", async () => {
    service.list
      .mockRejectedValueOnce(new IsolationError())
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      getRecruitingSchedulingPlans(prisma, actor, { threadId: "thread" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getRecruitingSchedulingPlans(prisma, actor, { threadId: "thread" }),
    ).rejects.toThrow("database unavailable");
  });
});
