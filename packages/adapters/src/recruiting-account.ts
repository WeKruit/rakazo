import { isDeepStrictEqual } from "node:util";
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
import { pendingInputAttention } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  createGroupRepos,
  createRepos,
  getRecruitingWorkspace,
  listRecruitingFeedback,
  listRecruitingReminders,
  listRecruitingSchedulingPlans,
  listRoutinesDto,
  Prisma,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { McpOAuthBroker } from "./mcp-oauth.js";
import type { CrmMembershipReads, PhaseTimer, RecruitingThreadTarget } from "./recruiting-reads.js";
import {
  authenticated,
  getRecruitingCorrespondence,
  getRecruitingCrmData,
  getRecruitingRoleCampaign,
  getRecruitingRoleCandidates,
  phaseTimer,
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

const ROLE_READ_CONCURRENCY = 2;
// Interview reads share the account calendar, so they take Home's limit for the same reads.
const INTERVIEW_READ_CONCURRENCY = 8;

type RoleStatus = NonNullable<RecruitingAccountViewOutput["items"][number]["status"]>;

/** Saved counts, latest activity and any open card per role, in five bounded reads. */
async function readRoleStatuses(
  prisma: PrismaClient,
  actor: Actor,
  roles: readonly { id: string; sourceThreadId: string }[],
): Promise<Map<string, RoleStatus>> {
  const roleIds = roles.map((role) => role.id);
  const threadIds = roles.map((role) => role.sourceThreadId);
  if (!roleIds.length) return new Map();
  const owned = { spaceId: actor.spaceId, userId: actor.userId };
  const waiting = await prisma.run.findMany({
    where: { threadId: { in: threadIds }, status: "waiting_input", thread: owned },
    select: { id: true },
  });
  const [saved, shortlisted, latest, cards] = await Promise.all([
    prisma.recruitingCandidate.groupBy({
      by: ["roleId"],
      where: { roleId: { in: roleIds }, role: owned },
      _count: { _all: true },
    }),
    prisma.recruitingCandidate.groupBy({
      by: ["roleId"],
      where: { roleId: { in: roleIds }, role: owned, shortlisted: true },
      _count: { _all: true },
    }),
    prisma.message.groupBy({
      by: ["threadId"],
      where: { threadId: { in: threadIds }, thread: owned },
      _max: { createdAt: true },
    }),
    prisma.message.findMany({
      where: {
        threadId: { in: threadIds },
        runId: { in: waiting.map((run) => run.id) },
        role: "bot",
        thread: owned,
        blocks: { array_contains: [{ kind: "ask", status: "pending" }] },
      },
      orderBy: { seq: "desc" },
      select: { threadId: true, blocks: true },
    }),
  ]);
  const count = (rows: { roleId: string; _count: { _all: number } }[], id: string) =>
    rows.find((row) => row.roleId === id)?._count._all ?? 0;
  return new Map(
    roles.map((role) => {
      const card = cards.find((row) => row.threadId === role.sourceThreadId);
      const kind = card ? pendingInputAttention(card.blocks) : null;
      const ask = Array.isArray(card?.blocks)
        ? (card.blocks as { kind?: unknown; status?: unknown; text?: unknown }[]).find(
            (block) => block?.kind === "ask" && block.status === "pending",
          )
        : undefined;
      const at = latest.find((row) => row.threadId === role.sourceThreadId)?._max.createdAt;
      return [
        role.id,
        {
          savedPeople: count(saved, role.id),
          shortlisted: count(shortlisted, role.id),
          lastActivityAt: at ? at.toISOString() : null,
          waitingOnYou:
            kind && typeof ask?.text === "string" ? { kind, text: ask.text.slice(0, 500) } : null,
        },
      ];
    }),
  );
}

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
      activeThreads: { some: { userId: actor.userId, spaceId: actor.spaceId } },
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
            some: {
              id: group.thread.id,
              userId: actor.userId,
              spaceId: actor.spaceId,
            },
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
    if (
      (input.itemCursor && !input.roleId) ||
      (input.cursor && input.roleId && input.view !== "routines") ||
      (input.offset && (input.cursor || input.roleId || input.view === "routines"))
    )
      throw new ORPCError("BAD_REQUEST");
    if (
      input.campaignLeadCursor &&
      (!input.roleId || !input.campaignId || !input.campaignServerId || input.view !== "sequence")
    )
      throw new ORPCError("BAD_REQUEST");
    const listed = {
      ...scope,
      ...(input.briefedOnly ? { currentRevision: { brief: { not: Prisma.AnyNull } } } : {}),
    };
    const rows = await deps.prisma.recruitingRole.findMany({
      where: {
        ...listed,
        ...(input.roleId ? { id: input.roleId } : {}),
        ...(input.cursor && input.view !== "routines" ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      ...(input.offset ? { skip: input.offset } : {}),
      take: input.limit + 1,
      select: {
        id: true,
        title: true,
        sourceThreadId: true,
        playbookStage: true,
        sourceThread: {
          select: {
            id: true,
            groupId: true,
            botId: true,
            userId: true,
            spaceId: true,
          },
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
        sourceThread: { select: { groupId: true, botId: true } },
      },
    });
    const roles = catalog.map((row) => ({
      id: row.id,
      title: row.title,
      threadId: row.sourceThreadId,
      groupId: row.sourceThread.groupId,
      ...(row.sourceThread.botId ? { botId: row.sourceThread.botId } : {}),
      stage: row.playbookStage,
    }));
    if (input.view === "routines") {
      const threadId = input.roleId
        ? page.find((role) => role.id === input.roleId)?.sourceThreadId
        : undefined;
      if (input.roleId && !threadId) throw new ORPCError("NOT_FOUND");
      const rows = await listRoutinesDto(deps.prisma, actor, {
        allConversations: true,
        ...(threadId ? { threadId } : {}),
        cursor: input.cursor,
        limit: input.limit + 1,
      });
      const routines = rows.slice(0, input.limit);
      await guard();
      return RecruitingAccountViewOutputSchema.parse({
        roles,
        items: [],
        routines,
        nextCursor: rows.length > input.limit ? (routines.at(-1)?.id ?? null) : null,
      });
    }
    const statuses =
      input.view === "roles"
        ? await readRoleStatuses(deps.prisma, actor, page)
        : new Map<string, RoleStatus>();
    const crmMemberships: CrmMembershipReads = new Map();
    const readItem = async (
      row: (typeof page)[number],
    ): Promise<RecruitingAccountViewOutput["items"][number]> => {
      if (input.view === "roles") return readRole(row, phaseTimer());
      const timer = phaseTimer();
      try {
        return await readRole(row, timer);
      } finally {
        // Per-role phase times show which read to speed up on a slow page.
        getLogger().info("recruiting.role_read.timing", {
          view: input.view,
          "recruiting.role_id": row.id,
          ...timer.phases,
        });
      }
    };
    const readRole = async (
      row: (typeof page)[number],
      timer: PhaseTimer,
    ): Promise<RecruitingAccountViewOutput["items"][number]> => {
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
      if (input.view === "roles") return { roleId: row.id, status: statuses.get(row.id) };
      const target = await authorize();
      timer.mark("authorizeMs");
      const workspace = await getRecruitingWorkspace(deps.prisma, actor, {
        threadId: thread.id,
      });
      timer.mark("workspaceMs");
      if (workspace?.role.id !== row.id) throw new ORPCError("NOT_FOUND");
      if (input.view === "sequence" && input.sequenceSummary) {
        // Stored overview only: opening all roles must not fan out into candidate or provider reads.
        const bound = workspace.crmTarget?.target;
        const contactQuery = input.sequenceContactQuery?.toLowerCase();
        const contacts =
          bound && contactQuery
            ? await deps.prisma.recruitingCrmContact.findMany({
                where: {
                  userId: actor.userId,
                  spaceId: actor.spaceId,
                  mcpServerId: bound.mcpServerId,
                  organizationId: bound.organizationId,
                  archivedAt: null,
                  OR: [
                    { name: { contains: contactQuery, mode: "insensitive" } },
                    { email: { contains: contactQuery, mode: "insensitive" } },
                  ],
                },
                select: { crmCandidateId: true, email: true },
              })
            : [];
        const nativeContacts = contactQuery
          ? await deps.prisma.recruitingCandidate.findMany({
              where: {
                roleId: row.id,
                role: { userId: actor.userId, spaceId: actor.spaceId },
                occurrences: { some: { name: { contains: contactQuery, mode: "insensitive" } } },
              },
              select: { candidateKey: true },
            })
          : [];
        const matchingNativeKeys = new Set(nativeContacts.map((contact) => contact.candidateKey));
        const matchingCandidates = new Set(contacts.map((contact) => contact.crmCandidateId));
        const matchingEmails = new Set(
          contacts.flatMap((contact) => (contact.email ? [contact.email.toLowerCase()] : [])),
        );
        const mirrors = bound
          ? await deps.prisma.recruitingCrmCampaign.findMany({
              where: {
                userId: actor.userId,
                spaceId: actor.spaceId,
                mcpServerId: bound.mcpServerId,
                organizationId: bound.organizationId,
                crmRoleId: bound.crmRoleId,
                archivedAt: null,
                mcpServer: {
                  userId: actor.userId,
                  spaceId: actor.spaceId,
                  enabled: true,
                  revision: bound.serverRevision,
                },
              },
              orderBy: { crmCampaignId: "asc" },
            })
          : [];
        const leads =
          bound && mirrors.length
            ? await deps.prisma.recruitingCrmLead.findMany({
                where: {
                  userId: actor.userId,
                  spaceId: actor.spaceId,
                  mcpServerId: bound.mcpServerId,
                  organizationId: bound.organizationId,
                  crmCampaignId: { in: mirrors.map((campaign) => campaign.crmCampaignId) },
                  archivedAt: null,
                },
                select: {
                  crmCampaignId: true,
                  crmCandidateId: true,
                  status: true,
                  interestStatus: true,
                  openCount: true,
                  replyCount: true,
                  lastContactAt: true,
                },
              })
            : [];
        const leadsByCampaign = new Map<string, typeof leads>();
        for (const lead of leads)
          if (lead.crmCampaignId) {
            const group = leadsByCampaign.get(lead.crmCampaignId) ?? [];
            group.push(lead);
            leadsByCampaign.set(lead.crmCampaignId, group);
          }
        const campaigns: NonNullable<RecruitingAccountViewOutput["items"][number]["campaigns"]> =
          mirrors
            .filter(
              (campaign) =>
                !contactQuery ||
                (leadsByCampaign.get(campaign.crmCampaignId) ?? []).some(
                  (lead) => lead.crmCandidateId && matchingCandidates.has(lead.crmCandidateId),
                ),
            )
            .map((campaign) => {
              const rows = leadsByCampaign.get(campaign.crmCampaignId) ?? [];
              return {
                status: "ready",
                sourceKind: "crm",
                serverId: campaign.mcpServerId,
                campaign: {
                  id: campaign.crmCampaignId,
                  name: campaign.name,
                  eaccount: null,
                  status: campaign.status,
                  stopOnReply: null,
                  createdAt: campaign.campaignCreatedAt?.toISOString() ?? null,
                },
                leads: [],
                leadsComplete: false,
                observations: {
                  total: rows.length,
                  contacted: rows.filter((lead) => lead.lastContactAt !== null).length,
                  active: rows.filter((lead) => lead.status === 1).length,
                  opened: rows.some((lead) => lead.openCount !== null)
                    ? rows.filter((lead) => (lead.openCount ?? 0) > 0).length
                    : null,
                  replied: rows.some((lead) => lead.replyCount !== null)
                    ? rows.filter((lead) => (lead.replyCount ?? 0) > 0).length
                    : null,
                  interested: rows.filter(
                    (lead) =>
                      lead.interestStatus !== null && [1, 2, 3, 4].includes(lead.interestStatus),
                  ).length,
                  bounced: rows.filter((lead) => lead.status === -1).length,
                },
              };
            });
        const bindings = await deps.prisma.externalEffect.findMany({
          where: {
            spaceId: actor.spaceId,
            kind: "instantly_role_campaign",
            status: "completed",
            run: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              threadId: thread.id,
              bot: { userId: actor.userId, spaceId: actor.spaceId },
            },
            request: { path: ["roleId"], equals: row.id },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: { request: true, result: true },
        });
        const ownedServers = await deps.prisma.mcpServer.findMany({
          where: { userId: actor.userId, spaceId: actor.spaceId, enabled: true },
          select: { id: true },
        });
        const seenBindings = new Set<string>();
        for (const binding of bindings) {
          const request = binding.request as { roleId?: unknown; serverId?: unknown } | null;
          const result = binding.result as {
            campaignId?: unknown;
            campaignName?: unknown;
            leads?: unknown;
          } | null;
          if (
            request?.roleId !== row.id ||
            typeof request.serverId !== "string" ||
            !ownedServers.some((server) => server.id === request.serverId) ||
            typeof result?.campaignId !== "string" ||
            typeof result.campaignName !== "string"
          )
            continue;
          const key = JSON.stringify([request.serverId, result.campaignId]);
          if (seenBindings.has(key)) continue;
          seenBindings.add(key);
          if (contactQuery) {
            const leads =
              result.leads && typeof result.leads === "object" && !Array.isArray(result.leads)
                ? Object.entries(result.leads)
                : [];
            if (
              !leads.some(
                ([candidateKey, lead]) =>
                  lead &&
                  typeof lead === "object" &&
                  "email" in lead &&
                  "leadId" in lead &&
                  typeof lead.leadId === "string" &&
                  typeof lead.email === "string" &&
                  (matchingNativeKeys.has(candidateKey) ||
                    lead.email.toLowerCase().includes(contactQuery) ||
                    matchingEmails.has(lead.email.toLowerCase())),
              )
            )
              continue;
          }
          if (
            !campaigns.some(
              (campaign) =>
                campaign.serverId === request.serverId &&
                campaign.campaign?.id === result.campaignId,
            )
          )
            campaigns.push({
              status: "ready",
              sourceKind: "native",
              serverId: request.serverId,
              campaign: {
                id: result.campaignId,
                name: result.campaignName,
                eaccount: null,
                status: null,
                stopOnReply: null,
              },
              leads: [],
              leadsComplete: false,
            });
        }
        await authorize();
        const currentWorkspace = await getRecruitingWorkspace(deps.prisma, actor, {
          threadId: thread.id,
        });
        if (
          currentWorkspace?.role.id !== row.id ||
          !isDeepStrictEqual(currentWorkspace.crmTarget, workspace.crmTarget)
        )
          throw new ORPCError("NOT_FOUND");
        await guard();
        return {
          roleId: row.id,
          campaigns,
          ...(contactQuery ? { sequenceContactPartial: true } : {}),
        };
      }
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
        crmMemberships,
        firstPartyMcpUrl: deps.firstPartyMcpUrl ?? crmServer?.endpoint ?? undefined,
        reauthorize: authorize,
      };
      const item: RecruitingAccountViewOutput["items"][number] = {
        roleId: row.id,
      };
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
          ...(input.itemCursor ? { before: input.itemCursor } : {}),
        });
      if (
        !input.campaignLeadCursor &&
        (input.view === "shortlist" ||
          input.view === "contacts" ||
          input.view === "sequence" ||
          input.view === "inbox")
      )
        item.candidates = await getRecruitingRoleCandidates(
          reads,
          actor,
          target,
          {
            threadId: thread.id,
            limit: 50,
            ...(input.itemCursor && input.view !== "inbox" ? { cursor: input.itemCursor } : {}),
            ...(input.view === "shortlist"
              ? {
                  shortlistedOnly: true,
                  ...(input.since ? { shortlistedSince: input.since } : {}),
                }
              : {}),
          },
          // These pages list names only, so a role's first CRM page is enough until "Load more".
          { summary: !input.itemCursor || input.view === "inbox", timer },
        );
      timer.mark("candidatesMs");
      if (input.view === "sequence" && input.campaignLeadCursor) {
        const campaign = await getRecruitingRoleCampaign(reads, actor, target, {
          serverId: input.campaignServerId,
          campaignId: input.campaignId,
          leadCursor: input.campaignLeadCursor,
        });
        item.campaign = campaign;
        item.campaigns = [campaign];
        return item;
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
        } else if (item.campaign.campaign) item.campaigns.push(item.campaign);
        const bindings = await deps.prisma.externalEffect.findMany({
          where: {
            spaceId: actor.spaceId,
            kind: "instantly_role_campaign",
            status: "completed",
            run: { userId: actor.userId },
            request: { path: ["roleId"], equals: row.id },
          },
          select: { request: true, result: true },
        });
        for (const binding of bindings) {
          const request = binding.request;
          const result = binding.result;
          if (
            !request ||
            typeof request !== "object" ||
            Array.isArray(request) ||
            request.roleId !== row.id ||
            typeof request.serverId !== "string" ||
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            typeof result.campaignId !== "string"
          )
            continue;
          const serverId = request.serverId;
          if (
            item.campaigns.some(
              (campaign) =>
                campaign.serverId === serverId && campaign.campaign?.id === result.campaignId,
            )
          )
            continue;
          const campaign =
            serverId === item.campaign.serverId && result.campaignId === item.campaign.campaign?.id
              ? item.campaign
              : await getRecruitingRoleCampaign(reads, actor, target, {
                  serverId,
                  campaignId: result.campaignId,
                });
          if (campaign.campaign) item.campaigns.push(campaign);
        }
      }
      timer.mark("campaignsMs");
      // Interview plans are local and independent of the calendar read, so they load meanwhile.
      const scheduling =
        input.view === "interview"
          ? listRecruitingSchedulingPlans(deps.prisma, actor, { threadId: thread.id })
          : undefined;
      // A failed calendar read must not leave the plans read unobserved.
      scheduling?.catch(() => undefined);
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
            // The inbox shows its newest mail first and pages the rest.
            limit: input.view === "inbox" ? 50 : 200,
            ...(input.itemCursor && (input.view === "inbox" || input.view === "interview")
              ? { cursor: input.itemCursor }
              : {}),
          },
          reads,
          timer,
        );
        timer.mark("correspondenceMs");
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
      if (scheduling) item.scheduling = await scheduling;
      timer.mark("schedulingMs");
      if (input.view === "tasks")
        item.reminders = await listRecruitingReminders(deps.prisma, actor, {
          roleId: row.id,
        });
      return item;
    };
    // Roles are independent reads (CRM, mail, calendar). Two at a time keeps a page quick without
    // taking the shared database pool from the rest of the app; a closed page stops reading.
    const items: RecruitingAccountViewOutput["items"] = new Array(page.length);
    let next = 0;
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            input.view === "interview" ? INTERVIEW_READ_CONCURRENCY : ROLE_READ_CONCURRENCY,
            page.length,
          ),
        },
        async () => {
          while (next < page.length) {
            deps.signal?.throwIfAborted();
            const index = next++;
            items[index] = await readItem(page[index]!);
          }
        },
      ),
    );
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
      ...(input.roleId || input.cursor
        ? {}
        : { total: await deps.prisma.recruitingRole.count({ where: listed }) }),
    });
  });
}
