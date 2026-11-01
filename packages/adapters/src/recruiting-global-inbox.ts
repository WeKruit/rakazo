import type { Actor, GlobalRecruitingInboxInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  readGlobalRecruitingInbox,
  readGlobalRecruitingInboxSummary,
} from "@rakazo/db";
import { authenticated } from "./recruiting-reads.js";

export async function getGlobalRecruitingInbox(
  deps: {
    prisma: PrismaClient;
    reauthorize?: () => Promise<void>;
    stillAuthorized?: () => Promise<boolean>;
  },
  actor: Actor,
  input: GlobalRecruitingInboxInput,
) {
  const authorize = async () => {
    await deps.reauthorize?.();
    if (deps.stillAuthorized && !(await deps.stillAuthorized())) throw new IsolationError();
  };
  return authenticated(() => readGlobalRecruitingInbox(deps.prisma, actor, input, authorize));
}

export async function getGlobalRecruitingInboxSummary(
  deps: {
    prisma: PrismaClient;
    stillAuthorized?: () => Promise<boolean>;
    reauthorize?: () => Promise<void>;
  },
  actor: Actor,
) {
  const authorize = async () => {
    await deps.reauthorize?.();
    if (deps.stillAuthorized && !(await deps.stillAuthorized())) throw new IsolationError();
  };
  return authenticated(() => readGlobalRecruitingInboxSummary(deps.prisma, actor, authorize));
}
