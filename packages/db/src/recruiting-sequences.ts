import type {
  Actor,
  RecruitingAccountViewInput,
  RecruitingAccountViewOutput,
  RecruitingRoleCampaign,
} from "@rakazo/contracts";
import { RecruitingAccountViewOutputSchema } from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** One saved-records page: no per-role workspace reads or provider requests. */
export async function readSavedRecruitingSequences(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Actor,
  input: RecruitingAccountViewInput,
): Promise<RecruitingAccountViewOutput> {
  const offset = input.cursor ? Number(input.cursor) : (input.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid sequence page");
  const pattern = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
  const columns = {
    name: "name",
    role: "title",
    total: "total",
    active: "active",
    opened: "opened",
    replied: "replied",
    interested: "interested",
    bounced: "bounced",
    created: "created",
  } as const;
  const sort = input.sequenceSort ?? "name";
  const order = Prisma.sql`${Prisma.raw(columns[sort])} ${Prisma.raw(sort === "name" || sort === "role" ? "ASC" : "DESC")} NULLS LAST,name,role_id,server_id,campaign_id`;
  const rows = await prisma.$queryRaw<{ data: unknown }[]>(Prisma.sql`
    WITH owned_roles AS MATERIALIZED (
      SELECT r.id,r.title,r."sourceThreadId",r."playbookStage",r."crmBindingEffectId",t."groupId",t."botId"
      FROM recruiting_roles r JOIN threads t ON t.id=r."sourceThreadId"
      LEFT JOIN chat_groups g ON g.id=t."groupId" LEFT JOIN bots b ON b.id=t."botId"
      LEFT JOIN recruiting_role_revisions rev ON rev.id=r."currentRevisionId"
      WHERE r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL
        AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId} AND t."activeRecruitingRoleId"=r.id
        AND ((g.id IS NOT NULL AND g."archivedAt" IS NULL AND g."userId"=${actor.userId} AND g."spaceId"=${actor.spaceId})
          OR (b.id IS NOT NULL AND b."archivedAt" IS NULL AND b."userId"=${actor.userId} AND b."spaceId"=${actor.spaceId}))
        ${input.briefedOnly ? Prisma.sql`AND rev.brief IS NOT NULL AND rev.brief<>'null'::jsonb` : Prisma.empty}
    ), bindings AS MATERIALIZED (
      SELECT DISTINCT ON(r.id,s.id,e.result->>'campaignId') r.id role_id,s.id server_id,s.revision,e.result,e."updatedAt"
      FROM owned_roles r JOIN runs run ON run."threadId"=r."sourceThreadId"
      JOIN bots bot ON bot.id=run."botId" AND bot."userId"=${actor.userId} AND bot."spaceId"=${actor.spaceId}
      JOIN external_effects e ON e."runId"=run.id AND e.request->>'roleId'=r.id
      JOIN mcp_servers s ON s.id=e.request->>'serverId' AND s."userId"=${actor.userId} AND s."spaceId"=${actor.spaceId} AND s.enabled
      WHERE run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId} AND e."spaceId"=${actor.spaceId}
        AND e.kind='instantly_role_campaign' AND e.status='completed'
        AND jsonb_typeof(e.result->'campaignId')='string' AND jsonb_typeof(e.result->'campaignName')='string'
      ORDER BY r.id,s.id,e.result->>'campaignId',e."updatedAt" DESC,e.id DESC
    ), raw_reads AS MATERIALIZED (
      SELECT r.id role_id,e.id,e."updatedAt",
        CASE WHEN e.request->>1='direct' THEN e.request->2->'route' ELSE e.request->3 END route,
        CASE WHEN e.request->>1='direct' THEN e.request->2->'args' ELSE e.request->2->'arguments' END args,
        COALESCE(e.result->'providerResult',e.result) result
      FROM owned_roles r JOIN runs run ON run."threadId"=r."sourceThreadId"
      JOIN bots bot ON bot.id=run."botId" AND bot."userId"=${actor.userId} AND bot."spaceId"=${actor.spaceId}
      JOIN external_effects e ON e."runId"=run.id
      WHERE run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId} AND e."spaceId"=${actor.spaceId}
        AND e.status='completed' AND e.request->>0='__rakazoCatalogTool'
        AND (e.request->2->'route'->>'toolName' IN ('native_instantly_get_campaign','get_campaign','native_instantly_get_campaign_analytics','get_campaign_analytics','native_instantly_get_role_draft','native_instantly_create_role_draft','native_instantly_clone_role_draft','native_instantly_update_role_draft')
          OR e.request->3->>'toolName' IN ('native_instantly_get_campaign','get_campaign','native_instantly_get_campaign_analytics','get_campaign_analytics','native_instantly_get_role_draft','native_instantly_create_role_draft','native_instantly_clone_role_draft','native_instantly_update_role_draft'))
    ), read_bodies AS (
      SELECT *,COALESCE(result->'structuredContent'->'result',result->'structuredContent',result->'data',result) body FROM raw_reads
    ), tool_reads AS MATERIALIZED (
      SELECT DISTINCT ON(x.role_id,b.server_id,b.result->>'campaignId',x.route->>'toolName')
        x.role_id,b.server_id,b.result->>'campaignId' campaign_id,x.route->>'toolName' tool,
        CASE WHEN x.route->>'toolName' IN ('native_instantly_get_role_draft','native_instantly_create_role_draft','native_instantly_clone_role_draft','native_instantly_update_role_draft') THEN x.body->'campaign' ELSE x.body END body,x."updatedAt",x.id
      FROM read_bodies x JOIN bindings b ON b.role_id=x.role_id
        AND x.route->>'connectorId'='mcp' AND x.route->>'resourceId'=b.server_id
        AND x.route->>'resourceRevision'=b.revision::text
        AND CASE WHEN x.route->>'toolName' IN ('native_instantly_get_role_draft','native_instantly_create_role_draft','native_instantly_clone_role_draft','native_instantly_update_role_draft')
          THEN x.body->'campaign'->>'id'=b.result->>'campaignId' AND x.args->>'role_id'=b.role_id AND x.body->>'roleId'=b.role_id
          ELSE COALESCE(x.args->>'campaign_id',x.args->>'id')=b.result->>'campaignId' END
      WHERE COALESCE(x.result->>'isError','false')<>'true' AND x.result->>'error' IS NULL
      ORDER BY x.role_id,b.server_id,b.result->>'campaignId',x.route->>'toolName',x."updatedAt" DESC,x.id DESC
    ), cached_observations AS (
      SELECT b.role_id,b.server_id,b.revision,b.result->>'campaignId' campaign_id,b.result->'__rakazoSequenceObservation' observation
      FROM bindings b
      UNION ALL
      SELECT b.role_id,b.server_id,b.revision,b.result->>'campaignId',e.result->'__rakazoSequenceObservation'
      FROM bindings b JOIN runs run ON run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId}
      JOIN owned_roles r ON r.id=b.role_id AND r."sourceThreadId"=run."threadId"
      JOIN external_effects e ON e."runId"=run.id AND e."spaceId"=${actor.spaceId} AND e.kind='instantly_sequence_draft' AND e.status='completed'
        AND e.request->'input'->>'role_id'=b.role_id AND e.result->>'campaignId'=b.result->>'campaignId'
        AND e.result->'__rakazoSequenceObservation'->>'serverId'=b.server_id
    ), saved_reads AS (
      SELECT * FROM tool_reads
      UNION ALL
      SELECT b.role_id,b.server_id,b.campaign_id,'native_instantly_get_campaign',
        b.observation->'campaign',(b.observation->>'observedAt')::timestamp,'derived-cache'
      FROM cached_observations b WHERE b.observation->>'sourceRevision'=b.revision::text
        AND b.observation->'campaign'->>'id'=b.campaign_id
        AND b.observation->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      UNION ALL
      SELECT b.role_id,b.server_id,b.campaign_id,'native_instantly_get_campaign_analytics',
        jsonb_build_object('emails_sent_count',b.observation->'stats'->'sent',
          'open_count_unique',b.observation->'stats'->'opened','reply_count_unique',b.observation->'stats'->'replied'),
        (b.observation->>'statsObservedAt')::timestamp,'derived-cache'
      FROM cached_observations b WHERE b.observation->>'sourceRevision'=b.revision::text
        AND b.observation->'campaign'->>'id'=b.campaign_id
        AND b.observation->>'statsObservedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        AND jsonb_typeof(b.observation->'stats')='object'
    ), native AS (
      SELECT b.role_id,b.server_id,b.result->>'campaignId' campaign_id,'native' source_kind,
        COALESCE(c.body->>'name',b.result->>'campaignName') name,
        CASE WHEN c.body->>'status' ~ '^[0-9]{1,2}$' THEN (c.body->>'status')::int END status,
        b.result->>'eaccount' mailbox,NULL::timestamptz created,
        CASE WHEN jsonb_typeof(a.body->'emails_sent_count')='number' THEN CASE WHEN (a.body->>'emails_sent_count')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((a.body->>'emails_sent_count')::numeric)=(a.body->>'emails_sent_count')::numeric THEN (a.body->>'emails_sent_count')::bigint END END sent,
        CASE WHEN jsonb_typeof(a.body->'open_count_unique')='number' THEN CASE WHEN (a.body->>'open_count_unique')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((a.body->>'open_count_unique')::numeric)=(a.body->>'open_count_unique')::numeric THEN (a.body->>'open_count_unique')::bigint END END opened,
        CASE WHEN jsonb_typeof(a.body->'reply_count_unique')='number' THEN CASE WHEN (a.body->>'reply_count_unique')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((a.body->>'reply_count_unique')::numeric)=(a.body->>'reply_count_unique')::numeric THEN (a.body->>'reply_count_unique')::bigint END END replied,
        CASE WHEN jsonb_typeof(b.result->'leads')='object' THEN
          (SELECT count(*)::int FROM jsonb_each(b.result->'leads') lead WHERE jsonb_typeof(lead.value->'email')='string' AND jsonb_typeof(lead.value->'leadId')='string') END total,NULL::int contacted,NULL::int active,NULL::int interested,NULL::int bounced,
        b.result membership,NULL::text organization_id,a."updatedAt" observed_at,b.revision source_revision,COALESCE(c."updatedAt",b."updatedAt") campaign_observed_at
      FROM bindings b
      LEFT JOIN LATERAL (SELECT * FROM saved_reads s WHERE s.role_id=b.role_id AND s.server_id=b.server_id AND s.campaign_id=b.result->>'campaignId'
        AND s.tool IN ('native_instantly_get_campaign','get_campaign','native_instantly_get_role_draft','native_instantly_create_role_draft','native_instantly_clone_role_draft','native_instantly_update_role_draft') AND s.body->>'id'=b.result->>'campaignId' ORDER BY s."updatedAt" DESC,s.id DESC LIMIT 1) c ON true
      LEFT JOIN LATERAL (SELECT * FROM saved_reads s WHERE s.role_id=b.role_id AND s.server_id=b.server_id AND s.campaign_id=b.result->>'campaignId'
        AND s.tool IN ('native_instantly_get_campaign_analytics','get_campaign_analytics') ORDER BY s."updatedAt" DESC,s.id DESC LIMIT 1) a ON true
    ), crm_bindings AS (
      SELECT r.id role_id,a."mcpServerId" server_id,a."serverRevision" revision,a."organizationId" organization_id,a."crmRoleId" crm_role_id
      FROM owned_roles r JOIN recruiting_crm_workspace_attachments a ON a."roleId"=r.id
      WHERE a."userId"=${actor.userId} AND a."spaceId"=${actor.spaceId}
      UNION
      SELECT r.id,e.result->'target'->>'mcpServerId',s.revision,e.result->'target'->>'organizationId',e.result->'target'->>'crmRoleId'
      FROM owned_roles r JOIN external_effects e ON e.id=r."crmBindingEffectId"
      JOIN runs run ON run.id=e."runId" AND run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId} AND run."threadId"=r."sourceThreadId"
      JOIN mcp_servers s ON s.id=e.result->'target'->>'mcpServerId' AND s.revision::text=e.result->'target'->>'serverRevision'
      WHERE e."spaceId"=${actor.spaceId} AND e.kind='recruiting_crm_target' AND e.status='completed' AND e.request->>'roleId'=r.id
        AND e.result->>'roleId'=r.id AND e.result->>'bindingEffectId'=e.id AND e.result->>'status'='connected'
    ), mirrored AS (
      SELECT b.role_id,b.server_id,c."crmCampaignId" campaign_id,'crm' source_kind,c.name,c.status,NULL::text mailbox,c."campaignCreatedAt" created,
        NULL::int sent,l.opened,l.replied,l.total,l.contacted,l.active,l.interested,l.bounced,NULL::jsonb membership,b.organization_id,COALESCE(l.observed_at,c."syncedAt") observed_at,b.revision source_revision,c."syncedAt" campaign_observed_at
      FROM crm_bindings b JOIN mcp_servers s ON s.id=b.server_id AND s.revision=b.revision AND s.enabled AND s."userId"=${actor.userId} AND s."spaceId"=${actor.spaceId}
      JOIN recruiting_crm_campaigns c ON c."mcpServerId"=b.server_id AND c."organizationId"=b.organization_id AND c."crmRoleId"=b.crm_role_id
        AND c."userId"=${actor.userId} AND c."spaceId"=${actor.spaceId} AND c."archivedAt" IS NULL
      LEFT JOIN LATERAL (SELECT max(l."syncedAt") observed_at,count(*)::int total,count(*) FILTER(WHERE "lastContactAt" IS NOT NULL)::int contacted,
        count(*) FILTER(WHERE status=1)::int active,count(*) FILTER(WHERE "interestStatus" IN (1,2,3,4))::int interested,
        count(*) FILTER(WHERE status=-1)::int bounced,
        CASE WHEN count("openCount")>0 THEN count(*) FILTER(WHERE "openCount">0)::int END opened,
        CASE WHEN count("replyCount")>0 THEN count(*) FILTER(WHERE "replyCount">0)::int END replied
        FROM recruiting_crm_leads l WHERE l."userId"=${actor.userId} AND l."spaceId"=${actor.spaceId}
          AND l."mcpServerId"=b.server_id AND l."organizationId"=b.organization_id AND l."crmCampaignId"=c."crmCampaignId" AND l."archivedAt" IS NULL) l ON true
    ), campaigns AS (
      SELECT DISTINCT ON(role_id,server_id,campaign_id) * FROM (SELECT * FROM mirrored UNION ALL SELECT * FROM native) all_campaigns
      ORDER BY role_id,server_id,campaign_id,source_kind
    ), filtered AS MATERIALIZED (
      SELECT c.*,r.title,r."sourceThreadId",r."groupId",r."botId",r."playbookStage"
      FROM campaigns c JOIN owned_roles r ON r.id=c.role_id WHERE true
        ${input.roleId ? Prisma.sql`AND c.role_id=${input.roleId}` : Prisma.empty}
        ${input.sequenceQuery ? Prisma.sql`AND (c.name ILIKE ${pattern(input.sequenceQuery)} OR r.title ILIKE ${pattern(input.sequenceQuery)})` : Prisma.empty}
        ${input.sequenceStatus !== undefined ? Prisma.sql`AND c.status=${input.sequenceStatus}` : Prisma.empty}
        ${
          input.sequenceContactQuery
            ? Prisma.sql`AND (
          EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(c.membership->'leads')='object' THEN c.membership->'leads' ELSE '{}'::jsonb END) lead
            LEFT JOIN recruiting_candidates person ON person."roleId"=c.role_id AND person."candidateKey"=lead.key
            WHERE lead.value->>'email' ILIKE ${pattern(input.sequenceContactQuery)} OR EXISTS(SELECT 1 FROM recruiting_candidate_occurrences occ WHERE occ."roleId"=person."roleId" AND occ."candidateKey"=person."candidateKey" AND occ.name ILIKE ${pattern(input.sequenceContactQuery)}))
          OR EXISTS(SELECT 1 FROM recruiting_crm_leads l JOIN recruiting_crm_contacts p ON p."userId"=l."userId" AND p."spaceId"=l."spaceId" AND p."mcpServerId"=l."mcpServerId" AND p."organizationId"=l."organizationId" AND p."crmCandidateId"=l."crmCandidateId"
            WHERE l."userId"=${actor.userId} AND l."spaceId"=${actor.spaceId} AND l."mcpServerId"=c.server_id AND l."organizationId"=c.organization_id AND l."crmCampaignId"=c.campaign_id AND l."archivedAt" IS NULL AND p."archivedAt" IS NULL
              AND (p.name ILIKE ${pattern(input.sequenceContactQuery)} OR p.email ILIKE ${pattern(input.sequenceContactQuery)}))
        )`
            : Prisma.empty
        }
    ), page AS (SELECT * FROM filtered ORDER BY ${order} LIMIT ${input.limit} OFFSET ${offset}),
    summary_campaigns AS (SELECT DISTINCT ON(server_id,organization_id,campaign_id) * FROM filtered ORDER BY server_id,organization_id,campaign_id,observed_at DESC NULLS LAST,role_id)
    SELECT jsonb_build_object(
      'roles',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',id,'title',title,'threadId',"sourceThreadId",'botId',"botId",'stage',"playbookStage")) || jsonb_build_object('groupId',"groupId") ORDER BY title,id) FROM owned_roles),'[]'::jsonb),
      'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('roleId',role_id,'campaigns',jsonb_build_array(jsonb_build_object(
        'status','ready','sourceKind',source_kind,'serverId',server_id,'sourceRevision',source_revision,'campaignObservedAt',campaign_observed_at AT TIME ZONE 'UTC',
        'campaign',jsonb_build_object('id',campaign_id,'name',name,'eaccount',mailbox,'status',status,'stopOnReply',NULL,'createdAt',created),
        'leads','[]'::jsonb,'leadsComplete',false,
        'stats',jsonb_build_object('sent',sent,'opened',opened,'replied',replied)
      ) || CASE WHEN total IS NOT NULL THEN jsonb_build_object('observations',jsonb_build_object('total',total,'contacted',contacted,'active',active,'opened',opened,'replied',replied,'interested',interested,'bounced',bounced)) ELSE '{}'::jsonb END)) ORDER BY ${order}) FROM page),'[]'::jsonb),
      'sequencePendingObservations',COALESCE((SELECT jsonb_agg(expected) FROM
        jsonb_to_recordset(${JSON.stringify(input.sequenceObservations ?? [])}::jsonb)
          AS expected("roleId" text,"serverId" text,"campaignId" text,"sourceRevision" int,"observedAt" text)
        WHERE EXISTS(SELECT 1 FROM campaigns c WHERE c.role_id=expected."roleId" AND c.server_id=expected."serverId"
          AND c.campaign_id=expected."campaignId" AND c.source_revision=expected."sourceRevision"
          AND c.campaign_observed_at<expected."observedAt"::timestamp)),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),
      'nextCursor',CASE WHEN ${offset + input.limit}<(SELECT count(*) FROM filtered) THEN ${String(offset + input.limit)} ELSE NULL END,
      'sequenceSummary',(SELECT jsonb_build_object('contacted',sum(contacted),'active',sum(active),'opened',sum(opened),'clicked',NULL,'replied',sum(replied),'interested',sum(interested),'sent',sum(sent),
        'partial',true) FROM summary_campaigns)
    ) data`);
  return RecruitingAccountViewOutputSchema.parse(rows[0]?.data);
}

/** Derived display cache only. The provider action and its existing receipt remain canonical. */
export async function rememberRecruitingSequenceObservation(
  prisma: Pick<PrismaClient, "$executeRaw">,
  actor: Actor,
  input: {
    botId: string;
    roleId: string;
    threadId: string;
    serverId: string;
    sourceRevision: number;
    observedAt: string;
    campaign: NonNullable<RecruitingRoleCampaign["campaign"]>;
    stats?: RecruitingRoleCampaign["stats"];
  },
) {
  const observation = {
    version: 1,
    sourceRevision: input.sourceRevision,
    observedAt: input.observedAt,
    campaign: {
      id: input.campaign.id,
      name: input.campaign.name,
      status: input.campaign.status,
      eaccount: input.campaign.eaccount,
      stopOnReply: input.campaign.stopOnReply,
    },
    ...(input.stats && Object.values(input.stats).some((value) => value !== null)
      ? { stats: input.stats, statsObservedAt: input.observedAt }
      : {}),
  };
  return withTransactionRetry(() =>
    prisma.$executeRaw(Prisma.sql`
    WITH owned AS (
      SELECT e.id FROM external_effects e JOIN runs run ON run.id=e."runId"
      JOIN recruiting_roles r ON r.id=${input.roleId} JOIN threads t ON t.id=r."sourceThreadId"
      JOIN mcp_servers s ON s.id=${input.serverId}
      WHERE e."spaceId"=${actor.spaceId} AND e.kind='instantly_role_campaign' AND e.status='completed'
        AND e.request->>'roleId'=r.id AND e.request->>'serverId'=s.id AND e.result->>'campaignId'=${input.campaign.id}
        AND run."userId"=${actor.userId} AND run."spaceId"=${actor.spaceId} AND run."threadId"=t.id
        AND r."userId"=${actor.userId} AND r."spaceId"=${actor.spaceId} AND r."archivedAt" IS NULL
        AND t.id=${input.threadId} AND t."activeRecruitingRoleId"=r.id AND t."userId"=${actor.userId} AND t."spaceId"=${actor.spaceId}
        AND s."userId"=${actor.userId} AND s."spaceId"=${actor.spaceId} AND s.enabled AND s.revision=${input.sourceRevision}
        AND EXISTS(SELECT 1 FROM bot_mcp_servers assignment WHERE assignment."botId"=${input.botId}
          AND assignment."serverId"=s.id AND assignment."userId"=${actor.userId} AND assignment."spaceId"=${actor.spaceId})
        AND EXISTS(SELECT 1 FROM bots bot WHERE bot.id=run."botId" AND bot."userId"=${actor.userId} AND bot."spaceId"=${actor.spaceId})
        AND ((t."groupId" IS NOT NULL AND EXISTS(SELECT 1 FROM chat_groups g WHERE g.id=t."groupId" AND g."userId"=${actor.userId} AND g."spaceId"=${actor.spaceId} AND g."archivedAt" IS NULL))
          OR (t."botId" IS NOT NULL AND EXISTS(SELECT 1 FROM bots bot WHERE bot.id=t."botId" AND bot."userId"=${actor.userId} AND bot."spaceId"=${actor.spaceId} AND bot."archivedAt" IS NULL)))
        AND EXISTS(SELECT 1 FROM space_members sm JOIN spaces sp ON sp.id=sm."spaceId" AND sp."organizationId"=sm."organizationId"
          JOIN member m ON m."organizationId"=sm."organizationId" AND m."userId"=sm."userId"
          WHERE sm."spaceId"=${actor.spaceId} AND sm."userId"=${actor.userId})
      ORDER BY e."updatedAt" DESC,e.id DESC LIMIT 1
    ) UPDATE external_effects e SET result=jsonb_set(jsonb_set(e.result,'{campaignName}',to_jsonb(${input.campaign.name}::text)),'{__rakazoSequenceObservation}',${JSON.stringify(observation)}::jsonb ||
        CASE WHEN e.result->'__rakazoSequenceObservation'->>'sourceRevision'=${String(input.sourceRevision)}
          AND jsonb_typeof(e.result->'__rakazoSequenceObservation'->'stats')='object'
          AND NOT ${Boolean(observation.stats)}
          THEN jsonb_build_object('stats',e.result->'__rakazoSequenceObservation'->'stats','statsObservedAt',e.result->'__rakazoSequenceObservation'->'statsObservedAt')
          ELSE '{}'::jsonb END)
      FROM owned,runs target_run,recruiting_roles target_role,threads target_thread
        WHERE e."runId"=target_run.id AND target_run."userId"=${actor.userId} AND target_run."spaceId"=${actor.spaceId}
          AND e."spaceId"=${actor.spaceId} AND e.kind='instantly_role_campaign' AND e.status='completed'
          AND e.request->>'serverId'=${input.serverId} AND e.result->>'campaignId'=${input.campaign.id}
          AND target_role.id=e.request->>'roleId' AND target_role."userId"=${actor.userId} AND target_role."spaceId"=${actor.spaceId} AND target_role."archivedAt" IS NULL
          AND target_thread.id=target_role."sourceThreadId" AND target_run."threadId"=target_thread.id AND target_thread."activeRecruitingRoleId"=target_role.id
          AND target_thread."userId"=${actor.userId} AND target_thread."spaceId"=${actor.spaceId}
        AND (e.result->'__rakazoSequenceObservation'->>'sourceRevision' IS NULL
          OR (e.result->'__rakazoSequenceObservation'->>'sourceRevision')::int<=${input.sourceRevision})
        AND (
        e.result->'__rakazoSequenceObservation'->>'sourceRevision' IS DISTINCT FROM ${String(input.sourceRevision)}
        OR e.result->'__rakazoSequenceObservation'->>'observedAt' IS NULL
        OR e.result->'__rakazoSequenceObservation'->>'observedAt'<=${input.observedAt})
  `),
  );
}
