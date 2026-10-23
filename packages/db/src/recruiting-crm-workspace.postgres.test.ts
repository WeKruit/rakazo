import { randomUUID } from "node:crypto";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  getRecruitingWorkspace,
  getRecruitingWorkspaceCrmTarget,
  openVerifiedRecruitingCrmWorkspace,
} from "./recruiting.js";

const suite = process.env.VERIFY_DATABASE ? describe.sequential : describe.skip;
suite("verified legacy CRM workspace", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const prisma = db.prisma;
  const id = randomUUID();
  const userId = `user-${id}`;
  const spaceId = `space-${id}`;
  const organizationId = `org-${id}`;
  const actor = { userId, spaceId, email: `${id}@example.test`, isDeploymentOwner: false };
  const bots = [`a-${id}`, `b-${id}`];
  const serverId = `server-${id}`;
  const target = {
    mcpServerId: serverId,
    serverRevision: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    crmRoleId: "00000000-0000-4000-8000-000000000002",
    crmClientId: "00000000-0000-4000-8000-000000000003",
    clientLabel: "Client",
    roleLabel: "Engineer",
  };
  const open = (crmRoleId = target.crmRoleId) =>
    openVerifiedRecruitingCrmWorkspace(prisma, actor, {
      target: { ...target, crmRoleId },
      verifiedBotId: bots[0]!,
      botIds: bots,
      roleText: "Actual source job description",
    });
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: actor.email, name: "Synthetic" } });
    await prisma.organization.create({
      data: { id: organizationId, name: "Synthetic", slug: organizationId, createdAt: new Date() },
    });
    await prisma.member.create({
      data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Synthetic" } });
    await prisma.spaceMember.create({
      data: { id: randomUUID(), organizationId, spaceId, userId, createdAt: new Date() },
    });
    await prisma.bot.createMany({
      data: bots.map((id) => ({ id, userId, spaceId, name: id, color: "blue" })),
    });
    await prisma.mcpServer.create({
      data: {
        id: serverId,
        userId,
        spaceId,
        name: "CRM",
        slug: "crm",
        transport: "http",
        endpoint: "https://example.test/mcp",
      },
    });
    await prisma.botMcpServer.create({
      data: {
        botId: bots[0]!,
        serverId,
        userId,
        spaceId,
        allowAllTools: false,
        allowedTools: ["get_crm_role"],
      },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await db.pool.end();
  });
  it("concurrent opens share one role and preserve an empty transcript and unapproved intake", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    expect(a).toEqual(b);
    expect(await prisma.recruitingRole.count({ where: { userId, spaceId } })).toBe(1);
    expect(await prisma.message.count({ where: { threadId: a.threadId } })).toBe(0);
    expect(await prisma.externalEffect.count({ where: { spaceId } })).toBe(0);
    const workspace = await getRecruitingWorkspace(prisma, actor, { threadId: a.threadId });
    expect(workspace?.role.playbookStage).toBe("intake");
    expect(workspace?.crmTarget?.bindingEffectId).toBeNull();
    expect(await getRecruitingWorkspaceCrmTarget(prisma, actor, { threadId: a.threadId })).toEqual(
      target,
    );
    expect(
      (
        await prisma.recruitingCrmWorkspaceAttachment.findUniqueOrThrow({
          where: { roleId: a.roleId },
        })
      ).sourceMaterial,
    ).toBe("Actual source job description");
  });
  it("does not guess roles from matching titles", async () => {
    const a = await open();
    const b = await open("00000000-0000-4000-8000-000000000004");
    expect(a.roleId).not.toBe(b.roleId);
  });
  it("rejects stale epochs and revoked permissions", async () => {
    const a = await open();
    await prisma.mcpServer.update({ where: { id: serverId }, data: { revision: 2 } });
    await expect(open()).rejects.toThrow();
    await expect(
      getRecruitingWorkspaceCrmTarget(prisma, actor, { threadId: a.threadId }),
    ).rejects.toThrow();
    await prisma.mcpServer.update({ where: { id: serverId }, data: { revision: 1 } });
    await prisma.botMcpServer.updateMany({ where: { serverId }, data: { allowedTools: [] } });
    await expect(open()).rejects.toThrow();
    await prisma.botMcpServer.updateMany({
      where: { serverId },
      data: { allowedTools: ["get_crm_role"] },
    });
  });
  async function fixtureBinding(
    workspace: { roleId: string; threadId: string },
    selected: typeof target,
  ) {
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bots[0]!,
        threadId: workspace.threadId,
        prompt: "Synthetic",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bots[0]!,
        threadId: workspace.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const read = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "mcp__crm__get_crm_role",
        idempotencyKey: randomUUID(),
        status: "completed",
        request: boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: serverId,
            resourceRevision: 1,
            toolName: "get_crm_role",
          },
          { p_org: selected.organizationId, p_role: selected.crmRoleId },
          "__rakazoCatalogTool",
        ) as never,
        result: {
          structuredContent: {
            data: {
              role_spec_id: selected.crmRoleId,
              client_id: selected.crmClientId,
              client_label: selected.clientLabel,
              role_label: selected.roleLabel,
            },
          },
        },
      },
    });
    const effectId = randomUUID();
    await prisma.externalEffect.create({
      data: {
        id: effectId,
        spaceId,
        runId: run.id,
        kind: "recruiting_crm_target",
        idempotencyKey: randomUUID(),
        status: "completed",
        request: {
          operation: "bind",
          roleId: workspace.roleId,
          expectedRoleRevision: 1,
          expectedBindingEffectId: null,
          crmRoleReadEffectId: read.id,
        },
        result: {
          status: "connected",
          roleId: workspace.roleId,
          bindingEffectId: effectId,
          target: selected,
        },
      },
    });
    await prisma.recruitingRole.update({
      where: { id: workspace.roleId },
      data: { crmBindingEffectId: effectId },
    });
  }
  it("rejects a conflicting native binding without reassigning the existing attachment", async () => {
    const a = await open();
    const different = { ...target, crmRoleId: "00000000-0000-4000-8000-000000000009" };
    await fixtureBinding(a, different);
    await expect(open(different.crmRoleId)).rejects.toThrow();
    await expect(
      getRecruitingWorkspaceCrmTarget(prisma, actor, { threadId: a.threadId }),
    ).rejects.toThrow();
    expect(
      (
        await prisma.recruitingCrmWorkspaceAttachment.findUniqueOrThrow({
          where: { roleId: a.roleId },
        })
      ).crmRoleId,
    ).toBe(target.crmRoleId);
    await prisma.recruitingRole.update({
      where: { id: a.roleId },
      data: { crmBindingEffectId: null },
    });
  });
  it("rejects an archived legacy binding even without an attachment", async () => {
    const crmRoleId = "00000000-0000-4000-8000-000000000008";
    const a = await open(crmRoleId);
    await fixtureBinding(a, { ...target, crmRoleId });
    await prisma.recruitingCrmWorkspaceAttachment.delete({ where: { roleId: a.roleId } });
    await prisma.recruitingRole.update({
      where: { id: a.roleId },
      data: { archivedAt: new Date() },
    });
    const count = await prisma.recruitingRole.count({ where: { userId, spaceId } });
    await expect(open(crmRoleId)).rejects.toThrow();
    expect(await prisma.recruitingRole.count({ where: { userId, spaceId } })).toBe(count);
  });
  it("does not restore archived canonical roles", async () => {
    const a = await open();
    await prisma.recruitingRole.update({
      where: { id: a.roleId },
      data: { archivedAt: new Date() },
    });
    await expect(open()).rejects.toThrow();
    expect(await prisma.recruitingRole.count({ where: { userId, spaceId } })).toBe(3);
  });
});
