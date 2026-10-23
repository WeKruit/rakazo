import { RecruitingRoleToolInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { listRecruitingRoles, setRecruitingRoleArchived } from "./recruiting.js";
import { IsolationError } from "./scope.js";

const actor = {
  spaceId: "space",
  userId: "human",
  email: "h@example.test",
  isDeploymentOwner: false,
};
const intent = { basis: "direct" as const, quote: "Archive the duplicate role" };

function fake(counts = { candidates: 0, tasks: 0 }) {
  const role = {
    id: "role",
    spaceId: "space",
    userId: "human",
    sourceThreadId: "thread",
    title: "Backend Engineer",
    revision: 2,
    currentRevisionId: "rev-2",
    crmBindingEffectId: null,
    archivedAt: null as Date | null,
  };
  const revision = {
    id: "rev-2",
    roleId: "role",
    revision: 2,
    brief: null,
    sourceRefs: [
      {
        id: "jd",
        kind: "original_material",
        anchor: { kind: "message", messageId: "m1", locator: "blocks[0].text" },
        readState: "read",
        readAt: "2026-10-22T00:00:00.000Z",
        quote: "Backend Engineer",
      },
    ],
    criteria: [],
    preferences: [],
    definitionQuestions: [],
    createdAt: new Date("2026-10-22T00:00:00Z"),
  };
  const tx = {
    $queryRaw: async () => [],
    thread: {
      findFirst: async () => ({
        id: "thread",
        spaceId: "space",
        userId: "human",
        botId: "bot",
        groupId: null,
        externalConversationId: null,
        activeRecruitingRoleId: "role",
      }),
    },
    message: { findMany: async () => [{ id: "m1", threadId: "thread" }] },
    bot: { findFirst: async () => ({ spaceId: "space", userId: "human" }) },
    recruitingRole: {
      // by-id read ignores archivedAt; list filters on it
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === role.id && where.userId === role.userId ? { ...role } : null,
      findMany: async ({ where }: { where: { archivedAt?: null } }) =>
        where.archivedAt === null && role.archivedAt ? [] : [{ ...role }],
      updateMany: async ({
        where,
        data,
      }: {
        where: { revision: number };
        data: { archivedAt: Date | null };
      }) => {
        if (where.revision !== role.revision) return { count: 0 };
        role.archivedAt = data.archivedAt;
        return { count: 1 };
      },
    },
    recruitingRoleRevision: { findFirst: async () => ({ ...revision }) },
    recruitingCandidate: { count: async () => counts.candidates },
    recruitingResearchTask: { count: async () => counts.tasks },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    recruitingRole: tx.recruitingRole,
  } as unknown as PrismaClient;
  return { role, prisma };
}

describe("recruiting role archive", () => {
  it("contract accepts archive and unarchive", () => {
    for (const input of [
      { operation: "archive", roleId: "role", expectedRevision: 2, intent },
      { operation: "archive", roleId: "role", expectedRevision: 2, intent, force: true },
      { operation: "unarchive", roleId: "role", expectedRevision: 2, intent },
    ])
      expect(RecruitingRoleToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      RecruitingRoleToolInputSchema.safeParse({
        operation: "unarchive",
        roleId: "r",
        expectedRevision: 2,
        intent,
        force: true,
      }).success,
    ).toBe(false);
  });

  it("archives, hides from list, stays readable by id, and unarchives", async () => {
    const { role, prisma } = fake();
    const input = { operation: "archive" as const, roleId: "role", expectedRevision: 2 };
    const saved = await setRecruitingRoleArchived(prisma, actor, input);
    expect(role.archivedAt).toBeInstanceOf(Date);
    expect(saved.role.id).toBe("role");
    expect(await listRecruitingRoles(prisma, actor)).toEqual([]);
    expect(
      await prisma.recruitingRole.findFirst({ where: { id: "role", userId: "human" } } as never),
    ).toMatchObject({ id: "role" });
    await setRecruitingRoleArchived(prisma, actor, { ...input, operation: "unarchive" });
    expect(role.archivedAt).toBeNull();
    expect(await listRecruitingRoles(prisma, actor)).toHaveLength(1);
  });

  it("refuses foreign users, stale revisions and non-empty roles without force", async () => {
    const { role, prisma } = fake();
    const input = { operation: "archive" as const, roleId: "role", expectedRevision: 2 };
    await expect(
      setRecruitingRoleArchived(prisma, { ...actor, userId: "other" }, input),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      setRecruitingRoleArchived(prisma, actor, { ...input, expectedRevision: 1 }),
    ).rejects.toThrow("Recruiting revision changed");
    expect(role.archivedAt).toBeNull();

    const busy = fake({ candidates: 3, tasks: 0 });
    await expect(setRecruitingRoleArchived(busy.prisma, actor, input)).rejects.toThrow(/force/);
    expect(busy.role.archivedAt).toBeNull();
    await setRecruitingRoleArchived(busy.prisma, actor, { ...input, force: true });
    expect(busy.role.archivedAt).toBeInstanceOf(Date);
  });
});
