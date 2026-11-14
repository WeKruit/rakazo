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
  return records;
}
