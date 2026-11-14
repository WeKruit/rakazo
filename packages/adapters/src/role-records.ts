import type { PrismaClient } from "@rakazo/db";

/**
 * What a role holds on record, for the working-state card: the requirements saved on its current
 * revision (each written from the recruiter's words with its source) and the email saved for it.
 * Staging 11-14: a card answer could not see the three emails Kruit had just written and asked the
 * recruiter to paste them five times; a new role asked for the JD after the recruiter had named the
 * job. Both were on record; nothing put them in front of the agent.
 */

const REQUIREMENTS_CHARS = 500;
const EMAIL_CHARS = 400;
/** Recent runs whose saves are read; a role's email is saved from its own or Kruit's runs. */
const RUNS_READ = 60;

export type RoleRecord = {
  requirements?: string;
  savedEmail?: { steps: number; first: string; at: Date };
  /** The role's campaign as this product recorded it; delivery itself is the provider's to say. */
  campaign?: { people: number; waiting: number; adopted: boolean; confirmedAt?: Date };
};

type Binding = {
  campaignId?: unknown;
  leads?: Record<string, unknown>;
  staged?: Record<string, unknown>;
  created?: unknown;
};

/** The saved criterion expression, read loosely: atoms, "not" and any list of items. */
type Expression = { kind?: string; statement?: string; item?: Expression; items?: Expression[] };

function statements(expression: Expression | undefined): string[] {
  if (!expression) return [];
  if (typeof expression.statement === "string") return [expression.statement];
  if (expression.kind === "not") return statements(expression.item).map((s) => `not ${s}`);
  return (expression.items ?? []).flatMap(statements);
}

function capped(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function requirementsText(criteria: unknown, preferences: unknown): string | undefined {
  const rows = Array.isArray(criteria) ? criteria : [];
  const parts = rows.flatMap((row) => {
    const criterion = row as { priority?: string; expression?: Expression };
    return statements(criterion.expression).map(
      (statement) => `${criterion.priority === "hard" ? "must" : "nice"}: ${statement}`,
    );
  });
  const liked = (Array.isArray(preferences) ? preferences : []).filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  const all = [...parts, ...liked.map((item) => `preference: ${item}`)];
  return all.length ? capped(all.join("; "), REQUIREMENTS_CHARS) : undefined;
}

export async function loadRoleRecords(
  prisma: Pick<PrismaClient, "recruitingRole" | "run" | "externalEffect">,
  scope: { spaceId: string; userId: string },
  roleIds: readonly string[],
  threadIds: readonly string[],
): Promise<Map<string, RoleRecord>> {
  const records = new Map<string, RoleRecord>();
  if (!roleIds.length) return records;
  const [roles, runs] = await Promise.all([
    prisma.recruitingRole.findMany({
      where: { id: { in: [...roleIds] }, spaceId: scope.spaceId, userId: scope.userId },
      select: { id: true, currentRevision: { select: { criteria: true, preferences: true } } },
    }),
    prisma.run.findMany({
      where: { threadId: { in: [...threadIds] }, spaceId: scope.spaceId },
      orderBy: { createdAt: "desc" },
      take: RUNS_READ,
      select: { id: true },
    }),
  ]);
  for (const role of roles) {
    const requirements = requirementsText(
      role.currentRevision?.criteria,
      role.currentRevision?.preferences,
    );
    if (requirements) records.set(role.id, { requirements });
  }
  const effects = runs.length
    ? await prisma.externalEffect.findMany({
        where: {
          runId: { in: runs.map((run) => run.id) },
          spaceId: scope.spaceId,
          kind: "instantly_role_email",
        },
        orderBy: { updatedAt: "desc" },
        select: { request: true, result: true, updatedAt: true },
      })
    : [];
  for (const effect of effects) {
    const roleId = (effect.request as { roleId?: unknown } | null)?.roleId;
    if (typeof roleId !== "string" || !roleIds.includes(roleId)) continue;
    const record = records.get(roleId) ?? {};
    if (record.savedEmail) continue;
    const steps = (effect.result as { steps?: Array<{ subject?: string; body?: string }> } | null)
      ?.steps;
    if (!steps?.length) continue;
    const [first] = steps;
    record.savedEmail = {
      steps: steps.length,
      first: capped(`${first?.subject ?? ""} — ${first?.body ?? ""}`, EMAIL_CHARS),
      at: effect.updatedAt,
    };
    records.set(roleId, record);
  }
  await addCampaigns(prisma, scope, roleIds, records);
  return records;
}

/**
 * Each role's campaign and the recruiter's latest confirmed send to it. Staging 11-14
 * (send-at-night): Kruit twice said "sent at 07:47" while the campaign was paused and nobody was
 * contacted; the card now says a confirmation is not a delivery.
 */
async function addCampaigns(
  prisma: Pick<PrismaClient, "externalEffect">,
  scope: { spaceId: string; userId: string },
  roleIds: readonly string[],
  records: Map<string, RoleRecord>,
) {
  const bindings = await prisma.externalEffect.findMany({
    where: {
      spaceId: scope.spaceId,
      kind: "instantly_role_campaign",
      status: "completed",
      run: { userId: scope.userId, spaceId: scope.spaceId },
      OR: roleIds.map((roleId) => ({ request: { path: ["roleId"], equals: roleId } })),
    },
    orderBy: { updatedAt: "desc" },
    select: { request: true, result: true },
  });
  const campaignRole = new Map<string, string>();
  for (const effect of bindings) {
    const roleId = (effect.request as { roleId?: unknown } | null)?.roleId;
    const binding = effect.result as Binding | null;
    if (typeof roleId !== "string" || typeof binding?.campaignId !== "string") continue;
    const record = records.get(roleId) ?? {};
    if (record.campaign) continue;
    record.campaign = {
      people: Object.keys(binding.leads ?? {}).length,
      waiting: Object.keys(binding.staged ?? {}).length,
      adopted: binding.created !== true,
    };
    records.set(roleId, record);
    campaignRole.set(binding.campaignId, roleId);
  }
  if (!campaignRole.size) return;
  // The same receipts campaign-send-record reads: a completed, error-free activate_campaign.
  const sends = await prisma.externalEffect.findMany({
    where: {
      spaceId: scope.spaceId,
      status: "completed",
      kind: { endsWith: "activate_campaign" },
    },
    orderBy: { updatedAt: "desc" },
    take: RUNS_READ,
    select: { result: true, updatedAt: true },
  });
  for (const send of sends) {
    const text = JSON.stringify(send.result ?? null);
    if (text.includes('"error"') || text.includes("already_waiting")) continue;
    // The result may be the tool's wrapped text, so match the campaign id anywhere in it.
    for (const [campaignId, roleId] of campaignRole) {
      const campaign = records.get(roleId)?.campaign;
      if (campaign && !campaign.confirmedAt && text.includes(campaignId))
        campaign.confirmedAt = send.updatedAt;
    }
  }
}
