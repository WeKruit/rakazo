import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb, type Prisma } from "./client.js";
import {
  createRecruitingRole,
  listRecruitingProfileActivity,
  recordRecruitingProfileView,
} from "./recruiting.js";
import { IsolationError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const local =
  databaseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname);
const database = process.env.VERIFY_DATABASE && local ? describe.sequential : describe.skip;

database("profile activity (local PostgreSQL)", () => {
  const suffix = randomUUID();
  const actor: Actor = {
    userId: `view-owner-${suffix}`,
    spaceId: `view-space-${suffix}`,
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const otherUser = `view-other-${suffix}`;
  const organizationId = `view-org-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let roleId: string;
  let otherRoleId: string;
  let threadId: string;
  let botId: string;
  const target = () => ({ roleId, candidateKey: "autumn:person" });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.createMany({
      data: [
        {
          id: actor.userId,
          name: "Recorded Recruiter",
          email: `view-owner-${suffix}@example.test`,
        },
        { id: otherUser, name: "Other Recruiter", email: `view-other-${suffix}@example.test` },
      ],
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Synthetic", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: actor.spaceId, organizationId, name: "Synthetic space" },
    });
    botId = (
      await prisma.bot.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, name: "Assistant", color: "blue" },
      })
    ).id;
    async function role() {
      const thread = await prisma.thread.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, botId },
      });
      const message = await prisma.message.create({
        data: {
          threadId: thread.id,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Hire a synthetic engineer" }],
        },
      });
      const result = await createRecruitingRole(prisma, actor, {
        sourceThreadId: thread.id,
        expectedRevision: 0,
        title: "Synthetic role",
        sourceRefs: [
          {
            id: "source-jd",
            kind: "original_material",
            anchor: { kind: "message", messageId: message.id, locator: "text:0" },
            readState: "read",
            readAt: new Date().toISOString(),
          },
        ],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
      });
      return { roleId: result.role.id, threadId: thread.id };
    }
    ({ roleId, threadId } = await role());
    const firstBotId = botId;
    botId = (
      await prisma.bot.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Second assistant",
          color: "blue",
        },
      })
    ).id;
    otherRoleId = (await role()).roleId;
    botId = firstBotId;
    await prisma.recruitingCandidate.create({ data: { roleId, candidateKey: "person" } });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.recruitingRole.updateMany({
      where: { spaceId: actor.spaceId },
      data: { crmBindingEffectId: null },
    });
    await prisma.space.deleteMany({ where: { id: actor.spaceId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [actor.userId, otherUser] } } });
    await close();
  });

  it("starts empty and records one real server-timed event across concurrent retries", async () => {
    expect(await listRecruitingProfileActivity(prisma, actor, target())).toEqual({
      items: [],
      hasMore: false,
    });
    const started = Date.now();
    const input = { ...target(), viewId: randomUUID() };
    const views = await Promise.all(
      Array.from({ length: 6 }, () => recordRecruitingProfileView(prisma, actor, input)),
    );
    expect(new Set(views.map((view) => view.id)).size).toBe(1);
    expect(views[0]!.actorName).toBe("Recorded Recruiter");
    expect(Date.parse(views[0]!.at)).toBeGreaterThanOrEqual(started);
    const rows = await prisma.event.findMany({
      where: { threadId, type: "recruiting.profile.viewed" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      ...input,
      actorUserId: actor.userId,
      actorName: "Recorded Recruiter",
    });
    expect(await listRecruitingProfileActivity(prisma, actor, target())).toEqual({
      items: [views[0]],
      hasMore: false,
    });
  });
  it("records a new open separately but not a retry", async () => {
    const input = { ...target(), viewId: randomUUID() };
    const view = await recordRecruitingProfileView(prisma, actor, input);
    expect(await recordRecruitingProfileView(prisma, actor, input)).toEqual(view);
    const result = await listRecruitingProfileActivity(prisma, actor, target());
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(view);
  });
  it("rejects foreign owners, spaces, roles and missing people before reading or appending", async () => {
    const count = await prisma.event.count({
      where: { threadId, type: "recruiting.profile.viewed" },
    });
    for (const [identity, input] of [
      [{ ...actor, userId: otherUser }, target()],
      [{ ...actor, spaceId: "another-space" }, target()],
      [actor, { ...target(), roleId: otherRoleId }],
      [actor, { ...target(), candidateKey: "autumn:missing" }],
      [actor, { ...target(), candidateKey: "crm:00000000-0000-4000-8000-000000000001" }],
    ] as const) {
      await expect(listRecruitingProfileActivity(prisma, identity, input)).rejects.toBeInstanceOf(
        IsolationError,
      );
      await expect(
        recordRecruitingProfileView(prisma, identity, { ...input, viewId: randomUUID() }),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    expect(
      await prisma.event.count({ where: { threadId, type: "recruiting.profile.viewed" } }),
    ).toBe(count);
  });
  it("checks current source-thread ownership again for reads and retries", async () => {
    const input = { ...target(), viewId: randomUUID() };
    await recordRecruitingProfileView(prisma, actor, input);
    await prisma.bot.update({ where: { id: botId }, data: { userId: otherUser } });
    try {
      await expect(listRecruitingProfileActivity(prisma, actor, target())).rejects.toBeInstanceOf(
        IsolationError,
      );
      await expect(recordRecruitingProfileView(prisma, actor, input)).rejects.toBeInstanceOf(
        IsolationError,
      );
    } finally {
      await prisma.bot.update({ where: { id: botId }, data: { userId: actor.userId } });
    }
  });

  it("keeps same-external-ID CRM views scoped to the current source binding", async () => {
    const crmCandidateId = "40000000-0000-4000-8000-000000000004";
    const task = await prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        prompt: "Synthetic binding",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    async function bind(source: string, organizationId: string) {
      const server = await prisma.mcpServer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          slug: `profile-${source}-${suffix}`,
          name: "Synthetic CRM",
          transport: "http",
        },
      });
      const target = {
        mcpServerId: server.id,
        serverRevision: server.revision,
        organizationId,
        crmRoleId: "20000000-0000-4000-8000-000000000002",
        crmClientId: "30000000-0000-4000-8000-000000000003",
        clientLabel: "Synthetic client",
        roleLabel: "Engineer",
      };
      const read = await prisma.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: run.id,
          kind: "mcp__crm__get_crm_role",
          idempotencyKey: `profile-read-${source}-${suffix}`,
          status: "completed",
          request: boundDirectApprovalRequest(
            {
              connectorId: "mcp",
              resourceId: server.id,
              resourceRevision: server.revision,
              toolName: "get_crm_role",
            },
            { p_org: organizationId, p_role: target.crmRoleId },
            "__rakazoCatalogTool",
          ) as Prisma.InputJsonValue,
          result: {
            structuredContent: {
              data: {
                role_spec_id: target.crmRoleId,
                client_id: target.crmClientId,
                client_label: target.clientLabel,
                role_label: target.roleLabel,
              },
            },
          },
        },
      });
      const binding = await prisma.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: run.id,
          kind: "recruiting_crm_target",
          idempotencyKey: `profile-bind-${source}-${suffix}`,
          status: "completed",
          request: {
            operation: "bind",
            roleId,
            expectedRoleRevision: 1,
            expectedBindingEffectId: null,
            crmRoleReadEffectId: read.id,
          },
        },
      });
      await prisma.externalEffect.update({
        where: { id: binding.id },
        data: { result: { status: "connected", roleId, bindingEffectId: binding.id, target } },
      });
      await prisma.recruitingRole.update({
        where: { id: roleId },
        data: { crmBindingEffectId: binding.id },
      });
      const scope = {
        spaceId: actor.spaceId,
        userId: actor.userId,
        mcpServerId: server.id,
        organizationId,
      };
      const crmRole = await prisma.recruitingCrmRole.create({
        data: {
          ...scope,
          crmRoleId: target.crmRoleId,
          clientId: target.crmClientId,
          clientLabel: target.clientLabel,
          roleLabel: target.roleLabel,
          syncedAt: new Date(),
        },
      });
      const contact = await prisma.recruitingCrmContact.create({
        data: {
          ...scope,
          crmCandidateId,
          name: "Synthetic person",
          contactStatus: "unknown",
          outreachStatus: "unknown",
          clientLabel: target.clientLabel,
          roleLabel: target.roleLabel,
          syncedAt: new Date(),
        },
      });
      const link = await prisma.recruitingCrmRoleContact.create({
        data: { roleId: crmRole.id, contactId: contact.id, syncedAt: new Date() },
      });
      return { binding, link };
    }
    const chosen = { roleId, candidateKey: `crm:${crmCandidateId}` };
    const viewId = randomUUID();
    await bind("first", "10000000-0000-4000-8000-000000000001");
    const first = await recordRecruitingProfileView(prisma, actor, { ...chosen, viewId });
    expect((await listRecruitingProfileActivity(prisma, actor, chosen)).items).toEqual([first]);
    const secondSource = await bind("second", "10000000-0000-4000-8000-000000000009");
    expect((await listRecruitingProfileActivity(prisma, actor, chosen)).items).toEqual([]);
    const second = await recordRecruitingProfileView(prisma, actor, { ...chosen, viewId });
    expect(second.id).not.toBe(first.id);
    expect((await listRecruitingProfileActivity(prisma, actor, chosen)).items).toEqual([second]);
    await prisma.recruitingCrmRoleContact.update({
      where: {
        roleId_contactId: {
          roleId: secondSource.link.roleId,
          contactId: secondSource.link.contactId,
        },
      },
      data: { archivedAt: new Date() },
    });
    await expect(listRecruitingProfileActivity(prisma, actor, chosen)).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(
      recordRecruitingProfileView(prisma, actor, { ...chosen, viewId }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
