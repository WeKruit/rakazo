import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { RecruitingPlaybookValidationError } from "@rakazo/core";
import type { PrismaClient, RecruitingRoleMaterialContext } from "@rakazo/db";
import * as recruiting from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";

async function authenticated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IsolationError)
      throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
    if (error instanceof RecruitingConflictError)
      throw new ORPCError("CONFLICT", { message: error.message });
    if (error instanceof RecruitingPlaybookValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof RecruitingSourceValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof Error && error.name === "ZodError")
      throw new ORPCError("BAD_REQUEST", { message: "Invalid recruiting input" });
    throw error;
  }
}

export const createRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.createRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.createRecruitingRole(prisma, actor, input, material));
export const bindRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.bindRecruitingRole>[2],
) => authenticated(() => recruiting.bindRecruitingRole(prisma, actor, input));
export const getRecruitingWorkspace = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingWorkspace>[2],
) => authenticated(() => recruiting.getRecruitingWorkspace(prisma, actor, input));
export const reviseRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.reviseRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.reviseRecruitingRole(prisma, actor, input, material));
export const listRecruitingAssessments = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingAssessments>[2],
) => authenticated(() => recruiting.listRecruitingAssessments(prisma, actor, input));
export const getRecruitingAssessment = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingAssessment>[2],
) => authenticated(() => recruiting.getRecruitingAssessment(prisma, actor, input));
export const listRecruitingResearch = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingResearch>[2],
) => authenticated(() => recruiting.listRecruitingResearch(prisma, actor, input));

export const listRecruitingQuestions = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingQuestions>[2],
) =>
  authenticated(async () => ({
    questions: await recruiting.listRecruitingQuestions(prisma, actor, input),
  }));

export const confirmRecruitingBrief = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.confirmRecruitingBrief>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.confirmRecruitingBrief(prisma, actor, input, material));
