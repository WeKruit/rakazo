import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

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

const MEMBERSHIP_CACHE_TTL_MS = 60_000;
// ponytail: in-process only; a membership written by another process is seen within the TTL.
const membershipCache = new Map<string, { actor: Actor; expiresAt: number }>();

function membershipCacheKey(userId: string, requestedSpaceId?: string | null): string {
  return `${userId}\0${requestedSpaceId ?? ""}`;
}

/** Drop cached lookups after a membership write; no argument clears every user. */
export function invalidateMembershipCache(userId?: string): void {
  if (userId === undefined) {
    membershipCache.clear();
    return;
  }
  for (const key of membershipCache.keys()) {
    if (key.startsWith(`${userId}\0`)) membershipCache.delete(key);
  }
}

export async function requireMembership(
  prisma: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const started = performance.now();
  const cacheKey = membershipCacheKey(userId, requestedSpaceId);
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    getLogger().info("membership.lookup.timing", {
      cache: "hit",
      totalMs: Math.round(performance.now() - started),
      outcome: "ok",
    });
    return cached.actor;
  }
  let queryMs: number | undefined;
  let outcome = "error";
  try {
    const [actor] = await prisma
      .$queryRaw<Actor[]>(Prisma.sql`
        SELECT sm."userId", sm."spaceId", u.email,
          COALESCE(settings."ownerUserId" = sm."userId", false) AS "isDeploymentOwner"
        FROM space_members sm
        JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId"
        JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
        JOIN "user" u ON u.id = m."userId"
        LEFT JOIN deployment_settings settings ON settings.id = ${"default"}
        WHERE sm."userId" = ${userId}
          ${requestedSpaceId ? Prisma.sql`AND sm."spaceId" = ${requestedSpaceId}` : Prisma.empty}
        ORDER BY s."isDefault" DESC, sm."createdAt" ASC, sm.id ASC
        LIMIT 1
      `)
      .finally(() => {
        queryMs = Math.round(performance.now() - started);
      });
    if (!actor) {
      outcome = "missing";
      throw new IsolationError("No personal space");
    }
    outcome = "ok";
    membershipCache.set(cacheKey, { actor, expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS });
    return actor;
  } finally {
    getLogger().info("membership.lookup.timing", {
      cache: "miss",
      queryMs,
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
