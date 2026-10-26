import type { AgentRuntimeEvent, UsageOperationKind } from "@rakazo/adapter-kit";
import type { UsageAmounts, UsageCosts } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  RECRUITING_OPERATOR_EMAIL_DOMAIN,
  RECRUITING_SERVICE_UNIT_PRICES_USD,
} from "./recruiting-bootstrap.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export interface UsageAttribution {
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  parentRunId?: string;
  operationId?: string;
  operationKind?: UsageOperationKind;
}

/** Usage is financial history, independent from message clearing or bot deletion. */
export async function recordUsage(
  prisma: Pick<PrismaClient, "usageRecord">,
  event: UsageEvent,
  attribution: UsageAttribution,
) {
  const data = {
    ...attribution,
    parentRunId: attribution.parentRunId ?? attribution.runId,
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    cacheWrite1hTokens: event.cacheWrite1hTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
    totalTokens: event.totalTokens ?? null,
    costUsd: event.costUsd ?? null,
    costSource: event.costSource ?? null,
    pricingVersion: event.pricingVersion ?? null,
    usageSource: event.usageSource ?? null,
    callId: event.callId ?? null,
    operationKind: attribution.operationKind ?? event.operationKind ?? "answer",
    agentId: event.agentId ?? null,
  };
  const insert = (runId: string | null | undefined = data.runId) => {
    if (event.callId) {
      // A database uniqueness constraint makes duplicate delivery harmless even concurrently.
      return prisma.usageRecord.createMany({ data: [{ ...data, runId }], skipDuplicates: true });
    }
    return prisma.usageRecord.create({
      data: { ...data, ...(runId !== undefined ? { runId } : {}) },
    });
  };
  try {
    return await insert();
  } catch (error) {
    // A cancelled/deleted run can disappear while its last model call is settling.
    // Keep durable attribution while allowing the optional lifecycle FK to dangle as null.
    if (
      data.runId &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2003"
    )
      return insert(null);
    throw error;
  }
}

type UsageGroup = {
  unit: string;
  provider: string;
  roleId: string | null;
  day: Date;
  round: number | null;
  scale: boolean;
  quantity: number | null;
  tokens: bigint | number | null;
  costUsd: number | null;
};

const DAY_MS = 86_400_000;

function amounts(): UsageAmounts {
  return { credits: 0, calls: 0, tokens: 0, estimatedUsd: 0 };
}

function add(into: UsageAmounts, group: UsageGroup) {
  const quantity = Number(group.quantity ?? 0);
  if (group.unit === "credits") into.credits += quantity;
  else if (group.unit === "calls") into.calls += quantity;
  else into.tokens += Number(group.tokens ?? 0);
  const price =
    group.unit === "tokens"
      ? undefined
      : RECRUITING_SERVICE_UNIT_PRICES_USD[group.provider]?.[group.unit as "credits" | "calls"];
  into.estimatedUsd! +=
    group.unit === "tokens" ? Number(group.costUsd ?? 0) : quantity * (price ?? 0);
}

function finish(value: UsageAmounts, owner: boolean): UsageAmounts {
  const rounded = {
    credits: Math.round(value.credits * 100) / 100,
    calls: value.calls,
    tokens: value.tokens,
  };
  return owner
    ? {
        ...rounded,
        estimatedUsd: Math.round(((value.estimatedUsd ?? 0) + Number.EPSILON) * 100) / 100,
      }
    : rounded;
}

async function usageGroups(
  prisma: Pick<PrismaClient, "$queryRaw">,
  scope: { spaceId: string; userId: string } | null,
): Promise<UsageGroup[]> {
  const where = scope
    ? Prisma.sql`WHERE u."spaceId" = ${scope.spaceId} AND u."userId" = ${scope.userId}`
    : Prisma.empty;
  // A row belongs to the first calibration round recorded at or after it (the round its work
  // prepared); after the last round it belongs to the next one, or to scaling once approved.
  return prisma.$queryRaw<UsageGroup[]>`
    SELECT
      u."unit", u."provider", u."roleId",
      date_trunc('day', u."createdAt") AS "day",
      CASE
        WHEN u."roleId" IS NULL THEN NULL
        WHEN nxt."round" IS NOT NULL THEN nxt."round"
        WHEN last."approvedAt" IS NOT NULL AND u."createdAt" >= last."approvedAt" THEN NULL
        ELSE COALESCE(last."round", 0) + 1
      END AS "round",
      (u."roleId" IS NOT NULL AND nxt."round" IS NULL AND last."approvedAt" IS NOT NULL
        AND u."createdAt" >= last."approvedAt") AS "scale",
      SUM(u."quantity") AS "quantity",
      SUM(CASE WHEN u."unit" = 'tokens' THEN COALESCE(u."totalTokens",
        COALESCE(u."inputTokens", 0) + COALESCE(u."outputTokens", 0)
        + COALESCE(u."cacheReadTokens", 0) + COALESCE(u."cacheWriteTokens", 0)) END) AS "tokens",
      SUM(u."costUsd") AS "costUsd"
    FROM "usage_records" u
    LEFT JOIN LATERAL (
      SELECT MIN(c."round") AS "round" FROM "recruiting_calibration_rounds" c
      WHERE c."roleId" = u."roleId" AND c."createdAt" >= u."createdAt"
    ) nxt ON TRUE
    LEFT JOIN LATERAL (
      SELECT c."round", c."approvedAt" FROM "recruiting_calibration_rounds" c
      WHERE c."roleId" = u."roleId" ORDER BY c."round" DESC LIMIT 1
    ) last ON TRUE
    ${where}
    GROUP BY 1, 2, 3, 4, 5, 6`;
}

/** Only a verified mailbox at the operator's domain sees money and other accounts' spend. */
export async function seesOperatorSpend(prisma: Pick<PrismaClient, "user">, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return (
    user?.emailVerified === true &&
    user.email.trim().toLowerCase().endsWith(`@${RECRUITING_OPERATOR_EMAIL_DOMAIN}`)
  );
}

/**
 * Spend of one account (space + user) in credits, searches and tokens. Operator staff also get
 * estimated dollars, service names and every account's spend.
 */
export async function summarizeUsageCosts(
  prisma: Pick<PrismaClient, "$queryRaw" | "recruitingRole" | "user">,
  actor: { spaceId: string; userId: string },
  now = new Date(),
): Promise<UsageCosts> {
  const owner = await seesOperatorSpend(prisma, actor.userId);
  const groups = await usageGroups(prisma, actor);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const daysStart =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS;
  const total = amounts();
  const month = amounts();
  const days = new Map<string, UsageAmounts>();
  const roles = new Map<string, { sum: UsageAmounts; rounds: Map<string, UsageAmounts> }>();
  const services = new Map<string, { service: string; unit: string; quantity: number }>();
  for (const group of groups) {
    const at = group.day.getTime();
    add(total, group);
    if (at >= monthStart) add(month, group);
    if (at >= daysStart) {
      const day = group.day.toISOString().slice(0, 10);
      const value = days.get(day) ?? amounts();
      add(value, group);
      days.set(day, value);
    }
    if (group.roleId) {
      const role = roles.get(group.roleId) ?? { sum: amounts(), rounds: new Map() };
      add(role.sum, group);
      const key = group.scale ? "scale" : String(group.round);
      const round = role.rounds.get(key) ?? amounts();
      add(round, group);
      role.rounds.set(key, round);
      roles.set(group.roleId, role);
    }
    const serviceKey = `${group.unit}:${group.provider}`;
    const service = services.get(serviceKey) ?? {
      service: group.provider,
      unit: group.unit,
      quantity: 0,
    };
    service.quantity +=
      group.unit === "tokens" ? Number(group.tokens ?? 0) : Number(group.quantity ?? 0);
    services.set(serviceKey, service);
  }
  const titles = new Map(
    (
      await prisma.recruitingRole.findMany({
        where: { id: { in: [...roles.keys()] }, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true, title: true },
      })
    ).map((role) => [role.id, role.title]),
  );
  const result: UsageCosts = {
    total: finish(total, owner),
    month: finish(month, owner),
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, value]) => ({ day, ...finish(value, owner) })),
    roles: [...roles.entries()]
      .map(([roleId, role]) => ({
        roleId,
        title: titles.get(roleId) ?? null,
        ...finish(role.sum, owner),
        rounds: [...role.rounds.entries()]
          .map(([key, value]) => ({
            round: key === "scale" ? null : Number(key),
            scale: key === "scale",
            ...finish(value, owner),
          }))
          .sort(
            (a, b) => (a.round ?? Number.MAX_SAFE_INTEGER) - (b.round ?? Number.MAX_SAFE_INTEGER),
          ),
      }))
      .sort((a, b) => b.credits - a.credits || b.tokens - a.tokens),
  };
  if (!owner) return result;
  result.services = [...services.values()].sort(
    (a, b) => a.unit.localeCompare(b.unit) || b.quantity - a.quantity,
  );
  result.accounts = await summarizeAccounts(prisma);
  return result;
}

async function summarizeAccounts(prisma: Pick<PrismaClient, "$queryRaw" | "user">) {
  const rows = await prisma.$queryRaw<
    Array<{
      userId: string;
      unit: string;
      provider: string;
      quantity: number | null;
      tokens: bigint | null;
      costUsd: number | null;
    }>
  >`
    SELECT u."userId", u."unit", u."provider", SUM(u."quantity") AS "quantity",
      SUM(CASE WHEN u."unit" = 'tokens' THEN COALESCE(u."totalTokens",
        COALESCE(u."inputTokens", 0) + COALESCE(u."outputTokens", 0)
        + COALESCE(u."cacheReadTokens", 0) + COALESCE(u."cacheWriteTokens", 0)) END) AS "tokens",
      SUM(u."costUsd") AS "costUsd"
    FROM "usage_records" u
    GROUP BY 1, 2, 3`;
  const byUser = new Map<string, UsageAmounts>();
  for (const row of rows) {
    const value = byUser.get(row.userId) ?? amounts();
    add(value, { ...row, roleId: null, day: new Date(0), round: null, scale: false });
    byUser.set(row.userId, value);
  }
  const emails = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: [...byUser.keys()] } },
        select: { id: true, email: true },
      })
    ).map((user) => [user.id, user.email]),
  );
  return [...byUser.entries()]
    .map(([userId, value]) => ({
      userId,
      email: emails.get(userId) ?? null,
      ...finish(value, true),
    }))
    .sort((a, b) => (b.estimatedUsd ?? 0) - (a.estimatedUsd ?? 0) || b.tokens - a.tokens);
}
