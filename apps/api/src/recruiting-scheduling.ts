import { ORPCError } from "@orpc/server";
import type { Actor, RecruitingSchedulingPlanInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createRecruitingSchedulingPlan,
  IsolationError,
  listRecruitingSchedulingPlans,
} from "@rakazo/db";

type Guard = () => boolean | Promise<boolean>;
async function authorized<T>(guard: Guard | undefined, read: () => Promise<T>) {
  try {
    if (guard && !(await guard())) throw new IsolationError();
    const value = await read();
    if (guard && !(await guard())) throw new IsolationError();
    return value;
  } catch (error) {
    if (error instanceof IsolationError)
      throw new ORPCError("NOT_FOUND", { message: error.message });
    throw error;
  }
}
export function getRecruitingSchedulingPlans(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
  guard?: Guard,
) {
  return authorized(guard, () => listRecruitingSchedulingPlans(prisma, actor, input));
}
export function saveRecruitingSchedulingPlan(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingSchedulingPlanInput,
  guard?: Guard,
) {
  return authorized(guard, () => createRecruitingSchedulingPlan(prisma, actor, input));
}
