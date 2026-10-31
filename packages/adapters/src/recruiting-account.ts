import { ORPCError } from "@orpc/server";
import type { ArtifactStore, ConnectorProvider } from "@rakazo/adapter-kit";
import type {
  Actor,
  RecruitingAccountViewInput,
  RecruitingAccountViewOutput,
} from "@rakazo/contracts";
import {
  RecruitingAccountViewInputSchema,
  RecruitingAccountViewOutputSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createGroupRepos,
  createRepos,
  getRecruitingWorkspace,
  listRecruitingFeedback,
  listRecruitingReminders,
  listRecruitingSchedulingPlans,
} from "@rakazo/db";
import type { McpOAuthBroker } from "./mcp-oauth.js";
import type { RecruitingThreadTarget } from "./recruiting-reads.js";
import {
  authenticated,
  getRecruitingCorrespondence,
  getRecruitingCrmData,
  getRecruitingRoleCampaign,
  getRecruitingRoleCandidates,
} from "./recruiting-reads.js";

export type RecruitingAccountReadDeps = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  connectors: Pick<ConnectorProvider, "execute">;
  firstPartyMcpUrl?: string;
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
  oauth?: Pick<McpOAuthBroker, "statusFor">;
  productIdentity?: { endpoint: string; connected: boolean };
};

/** One account-scoped read used by the recruiting pages and the native recruiting tool. */
export async function readRecruitingAccountView(
  deps: RecruitingAccountReadDeps,
  actor: Actor,
  raw: RecruitingAccountViewInput,
): Promise<RecruitingAccountViewOutput> {
  return authenticated(async () => {
    const input = RecruitingAccountViewInputSchema.parse(raw);
    const guard = async () => {
      if (deps.stillAuthorized && !(await deps.stillAuthorized()))
        throw new ORPCError("UNAUTHORIZED");
    };
    await guard();
    const scope = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      archivedAt: null,
      sourceThread: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        OR: [{ group: { archivedAt: null } }, { bot: { archivedAt: null } }],
      },
    };
    if (input.roleId && input.groupId) throw new ORPCError("BAD_REQUEST");
    if (input.groupId) {
      const group = await createGroupRepos(deps.prisma).getGroupTarget(actor, input.groupId);
      if (!group.thread) throw new ORPCError("NOT_FOUND");
      const role = await deps.prisma.recruitingRole.findFirst({
        where: {
          ...scope,
          activeThreads: {
            some: { id: group.thread.id, userId: actor.userId, spaceId: actor.spaceId },
          },
        },
        select: { id: true },
      });
      if (!role) throw new ORPCError("NOT_FOUND");
      input.roleId = role.id;
    }
    if (
      input.roleId &&
      !(await deps.prisma.recruitingRole.findFirst({
        where: { ...scope, id: input.roleId },
        select: { id: true },
      }))
    )
      throw new ORPCError("NOT_FOUND");
    if (input.itemCursor && !input.roleId) throw new ORPCError("BAD_REQUEST");
    if (
      input.campaignLeadCursor &&
      (!input.roleId || !input.campaignId || !input.campaignServerId || input.view !== "sequence")
    )
      throw new ORPCError("BAD_REQUEST");
    const rows = await deps.prisma.recruitingRole.findMany({
      where: {
        ...scope,
        ...(input.roleId ? { id: input.roleId } : {}),
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: input.limit + 1,
      select: {
        id: true,
        title: true,
        sourceThreadId: true,
        playbookStage: true,
        sourceThread: {
          select: { id: true, groupId: true, botId: true, userId: true, spaceId: true },
        },
      },
    });
    const page = rows.slice(0, input.limit);
    const catalog = await deps.prisma.recruitingRole.findMany({
      where: scope,
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        sourceThreadId: true,
        playbookStage: true,
        sourceThread: { select: { groupId: true } },
      },
    });
    const roles = catalog.map((row) => ({
      id: row.id,
      title: row.title,
      threadId: row.sourceThreadId,
      groupId: row.sourceThread.groupId,
      stage: row.playbookStage,
    }));
    const items: RecruitingAccountViewOutput["items"] = [];
    for (const row of page) {
      const thread = row.sourceThread;
      if (thread.userId !== actor.userId || thread.spaceId !== actor.spaceId)
        throw new ORPCError("NOT_FOUND");
      const authorize = async (): Promise<RecruitingThreadTarget> => {
        if (thread.groupId) {
          const group = await createGroupRepos(deps.prisma).getGroupTarget(actor, thread.groupId);
          if (group.thread?.id !== thread.id) throw new ORPCError("NOT_FOUND");
          return {
            kind: "group",
            groupId: group.id,
            threadId: thread.id,
            memberBotIds: group.members.map((member) => member.bot.id),
          };
        }
        if (!thread.botId) throw new ORPCError("NOT_FOUND");
        const bot = await createRepos(deps.prisma).getBot(actor, thread.botId);
        if (bot.thread?.id !== thread.id) throw new ORPCError("NOT_FOUND");
        return { kind: "bot", botId: bot.id, threadId: thread.id };
      };
      if (input.view === "roles") {
        items.push({ roleId: row.id });
        continue;
      }
      const target = await authorize();
      const workspace = await getRecruitingWorkspace(deps.prisma, actor, { threadId: thread.id });
      if (workspace?.role.id !== row.id) throw new ORPCError("NOT_FOUND");
      const bound = workspace.crmTarget?.target;
      const crmServer =
        !deps.firstPartyMcpUrl && bound
          ? await deps.prisma.mcpServer.findFirst({
              where: {
                id: bound.mcpServerId,
                userId: actor.userId,
                spaceId: actor.spaceId,
                enabled: true,
                revision: bound.serverRevision,
              },
              select: { endpoint: true },
            })
          : null;
      const reads = {
        ...deps,
        firstPartyMcpUrl: deps.firstPartyMcpUrl ?? crmServer?.endpoint ?? undefined,
        reauthorize: authorize,
      };
      const item: RecruitingAccountViewOutput["items"][number] = { roleId: row.id };
      if (["brief", "sequence", "inbox", "interview", "contacts"].includes(input.view))
        item.workspace = {
          role: workspace.role,
          revision: workspace.revision,
          crmTarget: workspace.crmTarget,
        };
      if (input.view === "feedback")
        item.feedback = await listRecruitingFeedback(deps.prisma, actor, {
          roleId: row.id,
          limit: 50,
        });
      if (
        !input.campaignLeadCursor &&
        (input.view === "shortlist" ||
          input.view === "contacts" ||
          input.view === "sequence" ||
          input.view === "inbox")
      )
        item.candidates = await getRecruitingRoleCandidates(reads, actor, target, {
          threadId: thread.id,
          limit: 50,
          ...(input.itemCursor && input.view !== "inbox" ? { cursor: input.itemCursor } : {}),
          ...(input.view === "shortlist"
            ? { shortlistedOnly: true, ...(input.since ? { shortlistedSince: input.since } : {}) }
            : {}),
        });
      if (input.view === "sequence" && input.campaignLeadCursor) {
        const campaign = await getRecruitingRoleCampaign(reads, actor, target, {
          serverId: input.campaignServerId,
          campaignId: input.campaignId,
          leadCursor: input.campaignLeadCursor,
        });
        item.campaign = campaign;
        item.campaigns = [campaign];
        items.push(item);
        continue;
      }
      if (input.view === "sequence") {
        item.campaign = await getRecruitingRoleCampaign(reads, actor, target);
        item.campaigns = [];
        if (workspace.crmTarget && item.campaign.selectionRequired) {
          const binding = workspace.crmTarget.target;
          let offset = 0;
          for (;;) {
            const campaigns = await getRecruitingCrmData(reads, actor, target, {
              operation: "roleCampaigns",
              serverId: binding.mcpServerId,
              serverRevision: binding.serverRevision,
              organizationId: binding.organizationId,
              crmRoleId: binding.crmRoleId,
              limit: 50,
              offset,
            });
            if (campaigns.operation !== "roleCampaigns") throw new ORPCError("SERVICE_UNAVAILABLE");
            for (const campaign of campaigns.items)
              item.campaigns.push(
                await getRecruitingRoleCampaign(reads, actor, target, {
                  campaignId: campaign.id,
                  campaignOffset: offset,
                }),
              );
            if (campaigns.nextOffset === null) break;
            if (campaigns.nextOffset <= offset) throw new ORPCError("SERVICE_UNAVAILABLE");
            offset = campaigns.nextOffset;
          }
        } else if (workspace?.crmTarget) {
          if (item.campaign.campaign) item.campaigns.push(item.campaign);
        } else {
          const bindings = await deps.prisma.externalEffect.findMany({
            where: {
              spaceId: actor.spaceId,
              status: "completed",
              idempotencyKey: { startsWith: "instantly-role-campaign:", endsWith: `:${row.id}` },
            },
            select: { idempotencyKey: true },
          });
          const sourceIds = [
            ...new Set(
              bindings.flatMap((binding) => {
                const key = binding.idempotencyKey;
                return key
                  ? [key.slice("instantly-role-campaign:".length, -`:${row.id}`.length)]
                  : [];
              }),
            ),
          ];
          for (const serverId of sourceIds) {
            const campaign =
              serverId === item.campaign.serverId
                ? item.campaign
                : await getRecruitingRoleCampaign(reads, actor, target, { serverId });
            if (campaign.campaign) item.campaigns.push(campaign);
          }
          if (!item.campaigns.length && item.campaign.campaign) item.campaigns.push(item.campaign);
        }
      }
      if (["inbox", "interview", "contacts", "sequence"].includes(input.view)) {
        const view =
          input.view === "sequence"
            ? "contacts"
            : (input.view as "inbox" | "interview" | "contacts");
        item.correspondence = await getRecruitingCorrespondence(
          deps.prisma,
          actor,
          target,
          view,
          deps.productIdentity ??
            (reads.firstPartyMcpUrl
              ? { endpoint: reads.firstPartyMcpUrl, connected: false }
              : undefined),
          deps.oauth,
          {
            limit: 200,
            ...(input.itemCursor && input.view === "inbox" ? { cursor: input.itemCursor } : {}),
          },
          reads,
        );
        if (input.since) {
          const since = Date.parse(input.since);
          item.correspondence.emails = item.correspondence.emails.filter(
            (email) => email.date !== null && Date.parse(email.date) >= since,
          );
          item.correspondence.events = item.correspondence.events.filter(
            (event) => Date.parse(event.start) >= since,
          );
        }
      }
      if (input.view === "interview")
        item.scheduling = await listRecruitingSchedulingPlans(deps.prisma, actor, {
          threadId: thread.id,
        });
      if (input.view === "tasks")
        item.reminders = await listRecruitingReminders(deps.prisma, actor, { roleId: row.id });
      items.push(item);
    }
    const unassigned =
      input.view === "tasks" && !input.roleId
        ? await listRecruitingReminders(deps.prisma, actor, {})
        : undefined;
    const unassignedItems = unassigned?.items.filter((item) => item.roleId === null);
    const unassignedReminders = unassignedItems
      ? {
          items: unassignedItems,
          overdueCount: unassignedItems.filter(
            (item) => item.status === "open" && Date.parse(item.dueAt) < Date.now(),
          ).length,
        }
      : undefined;
    await guard();
    return RecruitingAccountViewOutputSchema.parse({
      unassignedReminders,
      roles,
      items,
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    });
  });
}
