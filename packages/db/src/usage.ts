import type { AgentRuntimeEvent, UsageOperationKind } from "@rakazo/adapter-kit";
import type {
  InternalUsageAmounts,
  InternalUsageCosts,
  UsageAccount,
  UsageCosts,
  UsageModel,
  UsageVendor,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { RECRUITING_OPERATOR_EMAIL_DOMAIN } from "./recruiting-bootstrap.js";

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
  priceTokens?: TokenPricer,
) {
  const estimate =
    event.costUsd == null && event.inputTokens != null && event.outputTokens != null
      ? priceTokens?.(event.provider, event.model, {
          input: event.inputTokens,
          output: event.outputTokens,
          cacheRead: event.cacheReadTokens ?? null,
          cacheWrite: event.cacheWriteTokens ?? null,
          cacheWrite1h: event.cacheWrite1hTokens ?? null,
        })
      : null;
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
    costUsd: event.costUsd ?? estimate ?? null,
    costSource: event.costSource ?? (estimate != null ? "catalog-estimate" : null),
    pricingVersion:
      event.pricingVersion ?? (estimate != null ? new Date().toISOString().slice(0, 10) : null),
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

/** List-price USD for measured model token buckets, null for an unknown price. */
export type TokenPricer = (
  provider: string,
  model: string,
  tokens: {
    input: number;
    output: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    cacheWrite1h?: number | null;
  },
) => number | null;

type UsageDb = Pick<
  PrismaClient,
  "$queryRaw" | "$executeRaw" | "usageRecord" | "recruitingRole" | "user" | "deploymentSettings"
>;
type Scope = { spaceId: string; userId: string };
const TOKEN_FIELDS = [
  "tokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];
type UsageGroup = Record<TokenField, bigint | number | null> & {
  unit: string;
  provider: string;
  model: string;
  userId: string;
  roleId: string | null;
  day: Date;
  round: number | null;
  scale: boolean;
  quantity: number | null;
  costUsd: number | null;
  creditCost: number | null;
  unpricedCount: bigint | number;
  calls: bigint | number;
  tokenRows: bigint | number;
  costSources: string[] | null;
};
const DAY_MS = 86_400_000;
const SPEND_UNITS = Prisma.sql`u."unit" IN ('tokens', 'credits', 'calls')`;
const scoped = (scope?: Scope) =>
  scope
    ? Prisma.sql`AND u."spaceId" = ${scope.spaceId} AND u."userId" = ${scope.userId}`
    : Prisma.empty;
const rounded = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/** Finalize legacy unpriced model rows once, rather than repricing history on every read. */
async function snapshotPendingModelCosts(
  prisma: UsageDb,
  priceTokens?: TokenPricer,
  scope?: Scope,
) {
  if (!priceTokens) return;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.usageRecord.findMany({
      where: {
        ...(scope ? { spaceId: scope.spaceId, userId: scope.userId } : {}),
        unit: "tokens",
        costUsd: null,
        inputTokens: { not: null },
        outputTokens: { not: null },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 200,
      select: {
        id: true,
        provider: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        cacheWrite1hTokens: true,
      },
    });
    if (!rows.length) break;
    const updates: Prisma.Sql[] = [];
    for (const row of rows) {
      const costUsd = priceTokens(row.provider, row.model, {
        input: row.inputTokens!,
        output: row.outputTokens!,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
        cacheWrite1h: row.cacheWrite1hTokens,
      });
      if (costUsd == null || !Number.isFinite(costUsd) || costUsd < 0) continue;
      updates.push(Prisma.sql`(${row.id}::text, ${costUsd}::float8)`);
    }
    if (updates.length)
      await prisma.$executeRaw`
      UPDATE "usage_records" u SET "costUsd" = priced."costUsd",
        "costSource" = 'catalog-estimate', "pricingVersion" = ${new Date().toISOString().slice(0, 10)}
      FROM (VALUES ${Prisma.join(updates)}) AS priced("id", "costUsd")
      WHERE u."id" = priced."id" AND u."costUsd" IS NULL`;
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < 200) break;
  }
}

// NULL is an unmeasured bucket, never a measured zero. Reasoning is already included in output.
const tokenSum = (
  column: string,
  expression = Prisma.sql`u.${Prisma.raw(`"${column}"`)}`,
) => Prisma.sql`
  CASE WHEN COUNT(*) FILTER (WHERE u."unit" = 'tokens') = COUNT(${expression}) FILTER (WHERE u."unit" = 'tokens')
  THEN SUM(${expression}) FILTER (WHERE u."unit" = 'tokens') END`;
const TOKEN_SUMS = Prisma.sql`
  SUM(u."quantity") AS "quantity", SUM(u."costUsd") AS "costUsd",
  SUM(u."costUsd"::numeric * u."creditRate"::numeric)::float8 AS "creditCost",
  COUNT(*) FILTER (WHERE u."costUsd" IS NULL) AS "unpricedCount",
  COUNT(*) FILTER (WHERE u."unit" = 'tokens') AS "tokenRows",
  SUM(CASE WHEN u."unit" = 'calls' THEN COALESCE(u."quantity", 0) WHEN u."unit" = 'tokens' THEN 1 ELSE 0 END) AS "calls",
  ARRAY_AGG(DISTINCT u."costSource") FILTER (WHERE u."costSource" IS NOT NULL) AS "costSources",
  ${tokenSum("totalTokens", Prisma.sql`COALESCE(u."totalTokens", u."inputTokens" + u."outputTokens" + u."cacheReadTokens" + u."cacheWriteTokens")`)} AS "tokens",
  ${Prisma.join(TOKEN_FIELDS.filter((field) => field !== "tokens").map((field) => Prisma.sql`${tokenSum(field)} AS ${Prisma.raw(`"${field}"`)}`))}`;

async function usageGroups(prisma: UsageDb, scope?: Scope): Promise<UsageGroup[]> {
  return prisma.$queryRaw<UsageGroup[]>`
    SELECT u."unit", u."provider", u."model", u."userId", u."roleId",
      date_trunc('day', u."createdAt") AS "day",
      CASE WHEN u."roleId" IS NULL THEN NULL WHEN nxt."round" IS NOT NULL THEN nxt."round"
        WHEN last."approvedAt" IS NOT NULL AND u."createdAt" >= last."approvedAt" THEN NULL
        ELSE COALESCE(last."round", 0) + 1 END AS "round",
      (u."roleId" IS NOT NULL AND nxt."round" IS NULL AND last."approvedAt" IS NOT NULL AND u."createdAt" >= last."approvedAt") AS "scale",
      ${TOKEN_SUMS}
    FROM "usage_records" u
    LEFT JOIN LATERAL (
      SELECT MIN(c."round") AS "round" FROM "recruiting_calibration_rounds" c
      WHERE c."roleId" = u."roleId" AND c."createdAt" >= u."createdAt"
    ) nxt ON TRUE
    LEFT JOIN LATERAL (
      SELECT c."round", c."approvedAt" FROM "recruiting_calibration_rounds" c
      WHERE c."roleId" = u."roleId" ORDER BY c."round" DESC LIMIT 1
    ) last ON TRUE
    WHERE ${SPEND_UNITS} ${scoped(scope)} GROUP BY 1,2,3,4,5,6,7,8`;
}

/** Only a verified operator-domain mailbox can access provider accounting. */
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

export async function summarizeUsageCosts(
  prisma: UsageDb,
  actor: Scope,
  options: { now?: Date; priceTokens?: TokenPricer } = {},
): Promise<UsageCosts> {
  await snapshotPendingModelCosts(prisma, options.priceTokens, actor);
  const now = options.now ?? new Date();
  const groups = await usageGroups(prisma, actor);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const daysStart =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS;
  let total = 0;
  let month = 0;
  const pending = new Set<string>();
  const days = new Map<string, number>();
  const roles = new Map<string, { credits: number; rounds: Map<string, number> }>();
  for (const group of groups) {
    const credits = Number(group.creditCost ?? 0);
    if (Number(group.unpricedCount) > 0) {
      pending.add("total");
      if (group.day.getTime() >= monthStart) pending.add("month");
      pending.add(`day:${group.day.toISOString().slice(0, 10)}`);
      if (group.roleId) {
        pending.add(`role:${group.roleId}`);
        pending.add(`round:${group.roleId}:${group.scale ? "scale" : String(group.round)}`);
      }
    }
    total += credits;
    if (group.day.getTime() >= monthStart) month += credits;
    if (group.day.getTime() >= daysStart) {
      const day = group.day.toISOString().slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + credits);
    }
    if (!group.roleId) continue;
    const role = roles.get(group.roleId) ?? { credits: 0, rounds: new Map<string, number>() };
    role.credits += credits;
    const key = group.scale ? "scale" : String(group.round);
    role.rounds.set(key, (role.rounds.get(key) ?? 0) + credits);
    roles.set(group.roleId, role);
  }
  const titles = new Map(
    (
      await prisma.recruitingRole.findMany({
        where: { id: { in: [...roles.keys()] }, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true, title: true },
      })
    ).map((role) => [role.id, role.title]),
  );
  return {
    canViewInternalCosts: await seesOperatorSpend(prisma, actor.userId),
    total: { credits: rounded(total), pending: pending.has("total") },
    month: { credits: rounded(month), pending: pending.has("month") },
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, credits]) => ({
        day,
        credits: rounded(credits),
        pending: pending.has(`day:${day}`),
      })),
    roles: [...roles]
      .map(([roleId, role]) => ({
        roleId,
        title: titles.get(roleId) ?? null,
        credits: rounded(role.credits),
        pending: pending.has(`role:${roleId}`),
        rounds: [...role.rounds]
          .map(([key, credits]) => ({
            round: key === "scale" ? null : Number(key),
            scale: key === "scale",
            credits: rounded(credits),
            pending: pending.has(`round:${roleId}:${key}`),
          }))
          .sort((a, b) => (a.round ?? Infinity) - (b.round ?? Infinity)),
      }))
      .sort((a, b) => b.credits - a.credits),
  };
}

type Accumulator = InternalUsageAmounts & { tokenRows: number };
function amounts(): Accumulator {
  return {
    credits: 0,
    costUsd: 0,
    priced: true,
    calls: 0,
    tokens: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    tokenRows: 0,
  };
}
function add(into: Accumulator, group: UsageGroup) {
  into.credits += Number(group.creditCost ?? 0);
  into.priced &&= Number(group.unpricedCount) === 0;
  into.costUsd = into.priced ? (into.costUsd ?? 0) + Number(group.costUsd ?? 0) : null;
  into.calls += Number(group.calls ?? 0);
  const count = Number(group.tokenRows ?? 0);
  if (!count) return;
  for (const field of TOKEN_FIELDS) {
    const value = group[field] == null ? null : Number(group[field]);
    into[field] =
      into.tokenRows === 0
        ? value
        : into[field] != null && value != null
          ? into[field]! + value
          : null;
  }
  into.tokenRows += count;
}
function finish({ tokenRows: _, ...value }: Accumulator): InternalUsageAmounts {
  return { ...value, credits: rounded(value.credits) };
}
function vendors(groups: UsageGroup[]): UsageVendor[] {
  const byVendor = new Map<
    string,
    {
      sum: Accumulator;
      models: Map<
        string,
        {
          sum: Accumulator;
          model: string;
          unit: string;
          quantity: number | null;
          sources: Set<string>;
        }
      >;
    }
  >();
  for (const group of groups) {
    const vendor = byVendor.get(group.provider) ?? { sum: amounts(), models: new Map() };
    add(vendor.sum, group);
    const key = `${group.unit}:${group.model}`;
    const model = vendor.models.get(key) ?? {
      sum: amounts(),
      model: group.model,
      unit: group.unit,
      quantity: group.unit === "tokens" ? null : 0,
      sources: new Set<string>(),
    };
    add(model.sum, group);
    if (model.quantity != null) model.quantity += Number(group.quantity ?? 0);
    for (const source of group.costSources ?? []) model.sources.add(source);
    vendor.models.set(key, model);
    byVendor.set(group.provider, vendor);
  }
  return [...byVendor]
    .map(([vendor, value]) => ({
      vendor,
      ...finish(value.sum),
      models: [...value.models.values()]
        .map(
          (model): UsageModel => ({
            ...finish(model.sum),
            model: model.model,
            unit: model.unit,
            quantity: model.unit === "tokens" ? model.sum.tokens : model.quantity,
            costSources: [...model.sources].sort(),
            averageUnitCostUsd:
              model.sum.costUsd != null &&
              (model.unit === "tokens" ? model.sum.tokens : model.quantity)
                ? model.sum.costUsd /
                  (model.unit === "tokens" ? model.sum.tokens! / 1_000_000 : model.quantity!)
                : null,
          }),
        )
        .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}

/** Authorization is enforced by the internalCosts RPC before entering this all-account query. */
export async function summarizeInternalUsageCosts(
  prisma: UsageDb,
  options: { now?: Date; priceTokens?: TokenPricer } = {},
): Promise<InternalUsageCosts> {
  await snapshotPendingModelCosts(prisma, options.priceTokens);
  const [groups, users, pricing] = await Promise.all([
    usageGroups(prisma),
    prisma.user.findMany({ select: { id: true, email: true, name: true } }),
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { usageCreditsPerUsd: true, usageGrossMargin: true },
    }),
  ]);
  const now = options.now ?? new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const total = amounts();
  const month = amounts();
  const byUser = new Map<string, UsageGroup[]>();
  for (const group of groups) {
    add(total, group);
    if (group.day.getTime() >= monthStart) add(month, group);
    const rows = byUser.get(group.userId) ?? [];
    rows.push(group);
    byUser.set(group.userId, rows);
  }
  // Include unspent accounts and historical spend whose user was removed.
  const identities = new Map<string, { email: string | null; name: string | null }>(
    users.map((user) => [user.id, { email: user.email, name: user.name }]),
  );
  for (const id of byUser.keys())
    if (!identities.has(id)) identities.set(id, { email: null, name: null });
  const accounts = [...identities]
    .map(([userId, identity]): UsageAccount => {
      const rows = byUser.get(userId) ?? [];
      const sum = amounts();
      for (const group of rows) add(sum, group);
      return { userId, ...identity, ...finish(sum), vendors: vendors(rows) };
    })
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.credits - a.credits);
  return {
    total: finish(total),
    month: finish(month),
    vendors: vendors(groups),
    accounts,
    pricing: {
      creditsPerUsd: pricing?.usageCreditsPerUsd ?? 100,
      grossMargin: pricing?.usageGrossMargin ?? 0.5,
    },
  };
}
