import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor, RecruitingSequenceInput, RecruitingSequenceOutput } from "@rakazo/contracts";
import { RecruitingSequenceInputSchema, RecruitingSequenceOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getRecruitingWorkspace, IsolationError } from "@rakazo/db";
import type { RecruitingThreadTarget } from "./recruiting-reads.js";
import { getRecruitingRoleCampaign } from "./recruiting-reads.js";

/** Web drafts share native REST authorization. This closed operation set cannot activate or send. */
export async function executeRecruitingSequence(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorProvider, "execute">;
    signal?: AbortSignal;
    reauthorize: () => Promise<RecruitingThreadTarget>;
    stillAuthorized: () => Promise<boolean>;
  },
  actor: Actor,
  target: RecruitingThreadTarget,
  value: RecruitingSequenceInput,
): Promise<RecruitingSequenceOutput> {
  const input = RecruitingSequenceInputSchema.parse(value);
  const workspace = await getRecruitingWorkspace(deps.prisma, actor, { threadId: target.threadId });
  if (workspace?.role.id !== input.roleId) throw new IsolationError();
  const botIds = target.kind === "group" ? target.memberBotIds : [target.botId];
  const assignmentWhere = {
    userId: actor.userId,
    spaceId: actor.spaceId,
    serverId: input.serverId,
    botId: { in: botIds },
    server: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      enabled: true,
      endpoint: "https://mcp.instantly.ai/mcp",
      transport: "streamable_http" as const,
    },
  };
  const assignment = await deps.prisma.botMcpServer.findFirst({
    where: assignmentWhere,
    orderBy: { botId: "asc" },
    include: { server: true },
  });
  if (!assignment) throw new IsolationError();
  const guard = async () => {
    if (!(await deps.stillAuthorized()) || !isDeepStrictEqual(await deps.reauthorize(), target))
      throw new IsolationError();
    const current = await deps.prisma.botMcpServer.findFirst({
      where: { ...assignmentWhere, botId: assignment.botId },
      include: { server: true },
    });
    const role = await getRecruitingWorkspace(deps.prisma, actor, { threadId: target.threadId });
    if (
      !current ||
      !isDeepStrictEqual(current, assignment) ||
      role?.role.id !== input.roleId ||
      !isDeepStrictEqual(role.crmTarget, workspace.crmTarget)
    )
      throw new IsolationError();
  };
  const run =
    input.operation === "create" || input.operation === "clone" || input.operation === "save"
      ? await deps.prisma.run.findFirst({
          where: {
            threadId: target.threadId,
            botId: assignment.botId,
            userId: actor.userId,
            spaceId: actor.spaceId,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;
  const context: AdapterContext = {
    reauthorize: guard,
    operationId: randomUUID(),
    traceId: randomUUID(),
    userId: actor.userId,
    spaceId: actor.spaceId,
    botId: assignment.botId,
    ...(run ? { runId: run.id } : {}),
    signal: deps.signal ?? AbortSignal.timeout(30_000),
  };
  const call = async (
    tool:
      | "get_role_draft"
      | "create_role_draft"
      | "update_role_draft"
      | "clone_role_draft"
      | "pause_campaign"
      | "list_leads"
      | "update_lead_interest",
    args: Record<string, unknown>,
  ) => {
    await guard();
    let result: unknown;
    for await (const event of deps.connectors.execute(
      {
        tool: `native_instantly_${tool}`,
        route: {
          connectorId: "mcp",
          resourceId: assignment.server.id,
          resourceRevision: assignment.server.revision,
          toolName: `native_instantly_${tool}`,
        },
        executionId: randomUUID(),
        args,
      },
      context,
    )) {
      if (event.type === "error") throw new Error("Could not save this sequence");
      if (event.type === "result")
        result = (event.data as { structuredContent?: { result?: unknown } })?.structuredContent
          ?.result;
    }
    await guard();
    return result;
  };
  if (input.operation === "response") {
    const source = await getRecruitingRoleCampaign(deps, actor, target, {
      campaignId: input.campaignId,
      serverId: input.serverId,
    });
    await guard();
    if (
      source.status !== "ready" ||
      source.serverId !== input.serverId ||
      source.campaign?.id !== input.campaignId
    )
      throw new IsolationError();
    const readMember = async () => {
      const result = (await call("list_leads", {
        campaign_id: input.campaignId,
        email: input.email,
        limit: 2,
      })) as {
        items?: Array<{ email?: string; campaign?: string; lt_interest_status?: number | null }>;
      };
      const matches =
        result?.items?.filter(
          (lead) =>
            lead.email?.toLowerCase() === input.email.toLowerCase() &&
            lead.campaign === input.campaignId,
        ) ?? [];
      if (matches.length !== 1) throw new IsolationError();
      return matches[0]!;
    };
    await readMember();
    const interest = input.response === "none" ? null : input.response === "interested" ? 1 : -1;
    await call("update_lead_interest", {
      lead_email: input.email,
      campaign_id: input.campaignId,
      interest_value: interest,
    });
    const observed = await readMember();
    return RecruitingSequenceOutputSchema.parse({
      roleId: input.roleId,
      roleTitle: workspace.role.title,
      mailboxes: [],
      campaign: null,
      response: {
        email: input.email,
        interest,
        state: observed.lt_interest_status === interest ? "saved" : "pending",
      },
    });
  }
  if (input.operation === "read" && input.campaignId) {
    const key = `instantly-role-campaign:${input.serverId}:${input.roleId}`;
    const primary = await deps.prisma.externalEffect.findUnique({ where: { idempotencyKey: key } });
    const secondary =
      (primary?.result as { campaignId?: string } | null)?.campaignId === input.campaignId
        ? primary
        : await deps.prisma.externalEffect.findUnique({
            where: { idempotencyKey: `${key}:campaign:${input.campaignId}` },
          });
    if (!secondary) {
      const source = await getRecruitingRoleCampaign(deps, actor, target, {
        campaignId: input.campaignId,
        serverId: input.serverId,
      });
      await guard();
      if (
        source.status !== "ready" ||
        source.serverId !== input.serverId ||
        source.campaign?.id !== input.campaignId
      )
        throw new IsolationError();
      const observed = source.campaign.observedDetails;
      return RecruitingSequenceOutputSchema.parse({
        roleId: input.roleId,
        roleTitle: workspace.role.title,
        roleBrief: workspace.revision?.brief ?? null,
        mailboxes: source.campaign.eaccount ? [source.campaign.eaccount] : [],
        campaign: {
          id: input.campaignId,
          name: source.campaign.name,
          status: source.campaign.status,
          editable: false,
          eaccount: source.campaign.eaccount,
          steps: [],
          timezone:
            observed?.schedules?.length === 1 ? (observed.schedules[0]?.timezone ?? null) : null,
          send_hours: null,
          observedDetails: observed,
          stopOnReply: source.campaign.stopOnReply,
        },
      });
    }
  }
  if (input.operation === "pause") {
    const current = RecruitingSequenceOutputSchema.parse(
      await call("get_role_draft", { role_id: input.roleId, campaign_id: input.campaignId }),
    );
    if (current.campaign?.id !== input.campaignId) throw new IsolationError();
    await call("pause_campaign", { campaign_id: input.campaignId });
  }
  if (input.operation === "clone") {
    // Existing imported campaigns must first prove the exact role association through the
    // same authorized read used by Sequence. Persist that proof, never infer it from a name.
    const baseKey = `instantly-role-campaign:${input.serverId}:${input.roleId}`;
    const primary = await deps.prisma.externalEffect.findUnique({
      where: { idempotencyKey: baseKey },
    });
    const primaryResult = primary?.result as { campaignId?: string } | null;
    const selectedKey = `${baseKey}:campaign:${input.campaignId}`;
    const secondary =
      primaryResult?.campaignId === input.campaignId
        ? null
        : await deps.prisma.externalEffect.findUnique({ where: { idempotencyKey: selectedKey } });
    if (primaryResult?.campaignId !== input.campaignId && !secondary) {
      const source = await getRecruitingRoleCampaign(deps, actor, target, {
        serverId: input.serverId,
        campaignId: input.campaignId,
      });
      await guard();
      if (
        !run ||
        source.status !== "ready" ||
        source.serverId !== input.serverId ||
        source.campaign?.id !== input.campaignId
      )
        throw new IsolationError();
      await deps.prisma.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: run.id,
          kind: "instantly_role_campaign",
          status: "completed",
          idempotencyKey: selectedKey,
          request: { roleId: input.roleId, serverId: input.serverId },
          result: {
            campaignId: input.campaignId,
            campaignName: source.campaign.name,
            eaccount: source.campaign.eaccount ?? "",
            leads: {},
          },
        },
      });
    }

    return RecruitingSequenceOutputSchema.parse(
      await call("clone_role_draft", {
        role_id: input.roleId,
        campaign_id: input.campaignId,
        name: input.name,
        client_nonce: input.clientNonce,
      }),
    );
  }
  const result =
    input.operation === "create" || input.operation === "save"
      ? await call(input.operation === "create" ? "create_role_draft" : "update_role_draft", {
          role_id: input.roleId,
          ...(input.operation === "save"
            ? { campaign_id: input.campaignId, expected_revision: input.expectedRevision }
            : { client_nonce: input.clientNonce }),
          ...input.draft,
        })
      : await call("get_role_draft", {
          role_id: input.roleId,
          ...("campaignId" in input && input.campaignId ? { campaign_id: input.campaignId } : {}),
        });
  return RecruitingSequenceOutputSchema.parse({
    ...(result as object),
    roleBrief: workspace.revision?.brief ?? null,
  });
}
