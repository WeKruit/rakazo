import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const started = performance.now();
  let membershipMs: number | undefined;
  let settingsMs: number | undefined;
  let outcome = "error";
  try {
    const membership = await prisma.spaceMember
      .findFirst({
        where: {
          userId,
          ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
        },
        orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
        include: { member: { include: { user: true } } },
      })
      .finally(() => {
        membershipMs = Math.round(performance.now() - started);
      });
    if (!membership) {
      outcome = "missing";
      throw new IsolationError("No personal space");
    }
    const settingsStarted = performance.now();
    const settings = await prisma.deploymentSettings
      .findUnique({ where: { id: "default" } })
      .finally(() => {
        settingsMs = Math.round(performance.now() - settingsStarted);
      });
    const actor = {
      userId: membership.userId,
      spaceId: membership.spaceId,
      email: membership.member.user.email,
      isDeploymentOwner: settings?.ownerUserId === membership.userId,
    };
    outcome = "ok";
    return actor;
  } finally {
    getLogger().info("membership.lookup.timing", {
      membershipMs,
      settingsMs,
      totalMs: Math.round(performance.now() - started),
      outcome,
    });
  }
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
